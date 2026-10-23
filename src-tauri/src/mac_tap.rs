//! macOS: Core Audio 프로세스 탭(macOS 14.2+)으로 이 앱 웹뷰가 내는 소리를 받아 EQ를 걸고 기본 출력 장치로 다시 낸다.
//!
//! 흐름: 이 앱이 "책임자"인 오디오 프로세스(WebKit GPU·WebContent) 찾기 → CATapDescription(스테레오 믹스다운,
//! 탭하는 동안 원래 소리 끄기) → 탭 + 기본 출력 장치를 묶은 비공개 집합 장치 → IOProc에서
//! 입력(탭) → 프리앰프·10밴드 필터·소프트 클리핑 → 출력. 스펙트럼은 별도 스레드에서 FFT로 계산해 화면에 보낸다.
//!
//! 안전장치: 처리 루프가 안 돌거나(장치 문제) 재생 중인데 신호가 없으면(권한 거부 등) 탭을 바로 없애
//! 원래 소리로 돌아가고 화면에 알린다. 탭은 EQ를 켰거나 시각화를 보는 동안에만 만든다.
#![allow(non_upper_case_globals, non_snake_case)]

use std::ffi::{c_char, c_void};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use objc2::rc::{Allocated, Retained};
use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2::msg_send;
use objc2_foundation::{NSArray, NSNumber, NSString, NSUUID};
use rustfft::num_complex::Complex32;
use rustfft::FftPlanner;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager as _};

use crate::eq::{coefficients, soft_clip, Biquad, BiquadState, EqSettings};

type AudioObjectID = u32;
type OSStatus = i32;
type IOProcID = *mut c_void;
type IOProc = extern "C" fn(
    AudioObjectID,
    *const c_void,
    *const AudioBufferList,
    *const c_void,
    *mut AudioBufferList,
    *const c_void,
    *mut c_void,
) -> OSStatus;

#[repr(C)]
struct AudioObjectPropertyAddress {
    mSelector: u32,
    mScope: u32,
    mElement: u32,
}

#[repr(C)]
struct AudioBuffer {
    mNumberChannels: u32,
    mDataByteSize: u32,
    mData: *mut c_void,
}

#[repr(C)]
struct AudioBufferList {
    mNumberBuffers: u32,
    mBuffers: [AudioBuffer; 1],
}

const fn fourcc(s: &[u8; 4]) -> u32 {
    ((s[0] as u32) << 24) | ((s[1] as u32) << 16) | ((s[2] as u32) << 8) | s[3] as u32
}
const SYSTEM_OBJECT: AudioObjectID = 1;
const SCOPE_GLOBAL: u32 = fourcc(b"glob");
const PROCESS_LIST: u32 = fourcc(b"prs#");
const PROCESS_PID: u32 = fourcc(b"ppid");
const DEFAULT_OUTPUT: u32 = fourcc(b"dOut");
const DEVICE_UID: u32 = fourcc(b"uid ");
const NOMINAL_RATE: u32 = fourcc(b"nsrt");
/// CATapMuteBehavior.CATapMutedWhenTapped: 탭을 읽는 동안 원래 소리는 하드웨어로 가지 않는다.
const MUTED_WHEN_TAPPED: isize = 2;

#[link(name = "CoreAudio", kind = "framework")]
extern "C" {
    fn AudioObjectGetPropertyDataSize(id: AudioObjectID, addr: *const AudioObjectPropertyAddress, qsize: u32, q: *const c_void, out: *mut u32) -> OSStatus;
    fn AudioObjectGetPropertyData(id: AudioObjectID, addr: *const AudioObjectPropertyAddress, qsize: u32, q: *const c_void, io: *mut u32, out: *mut c_void) -> OSStatus;
    fn AudioHardwareCreateProcessTap(desc: *const AnyObject, out: *mut AudioObjectID) -> OSStatus;
    fn AudioHardwareDestroyProcessTap(id: AudioObjectID) -> OSStatus;
    fn AudioHardwareCreateAggregateDevice(desc: *const c_void, out: *mut AudioObjectID) -> OSStatus;
    fn AudioHardwareDestroyAggregateDevice(id: AudioObjectID) -> OSStatus;
    fn AudioDeviceCreateIOProcID(dev: AudioObjectID, proc_: IOProc, client: *mut c_void, out: *mut IOProcID) -> OSStatus;
    fn AudioDeviceDestroyIOProcID(dev: AudioObjectID, id: IOProcID) -> OSStatus;
    fn AudioDeviceStart(dev: AudioObjectID, id: IOProcID) -> OSStatus;
    fn AudioDeviceStop(dev: AudioObjectID, id: IOProcID) -> OSStatus;
}

extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    fn dlopen(path: *const c_char, mode: i32) -> *mut c_void;
}
const RTLD_NOW: i32 = 2;
/// dlfcn.h RTLD_DEFAULT
const RTLD_DEFAULT: *mut c_void = -2isize as *mut c_void;

fn addr(selector: u32) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress { mSelector: selector, mScope: SCOPE_GLOBAL, mElement: 0 }
}

fn get_u32(id: AudioObjectID, selector: u32) -> Option<u32> {
    let a = addr(selector);
    let mut v: u32 = 0;
    let mut size = 4u32;
    let st = unsafe { AudioObjectGetPropertyData(id, &a, 0, std::ptr::null(), &mut size, &mut v as *mut u32 as *mut c_void) };
    (st == 0).then_some(v)
}

fn get_f64(id: AudioObjectID, selector: u32) -> Option<f64> {
    let a = addr(selector);
    let mut v: f64 = 0.0;
    let mut size = 8u32;
    let st = unsafe { AudioObjectGetPropertyData(id, &a, 0, std::ptr::null(), &mut size, &mut v as *mut f64 as *mut c_void) };
    (st == 0).then_some(v)
}

fn get_ids(id: AudioObjectID, selector: u32) -> Vec<AudioObjectID> {
    let a = addr(selector);
    let mut size = 0u32;
    if unsafe { AudioObjectGetPropertyDataSize(id, &a, 0, std::ptr::null(), &mut size) } != 0 || size == 0 {
        return Vec::new();
    }
    let mut out = vec![0u32; size as usize / 4];
    let st = unsafe { AudioObjectGetPropertyData(id, &a, 0, std::ptr::null(), &mut size, out.as_mut_ptr() as *mut c_void) };
    if st != 0 {
        return Vec::new();
    }
    out.truncate(size as usize / 4);
    out
}

fn get_string(id: AudioObjectID, selector: u32) -> Option<String> {
    let a = addr(selector);
    let mut ptr: *mut NSString = std::ptr::null_mut();
    let mut size = std::mem::size_of::<*mut NSString>() as u32;
    let st = unsafe { AudioObjectGetPropertyData(id, &a, 0, std::ptr::null(), &mut size, &mut ptr as *mut _ as *mut c_void) };
    if st != 0 || ptr.is_null() {
        return None;
    }
    // CFStringRef는 NSString과 같은 객체(toll-free bridge)이고, 받은 쪽이 해제한다.
    let s = unsafe { Retained::from_raw(ptr) }?;
    Some(s.to_string())
}

/// 이 프로세스를 "책임자"로 둔 하위 프로세스(웹뷰의 WebKit GPU·WebContent)를 찾는 비공개 libsystem 함수.
fn responsible_pid(pid: i32) -> Option<i32> {
    type F = extern "C" fn(i32) -> i32;
    static FUNC: OnceLock<Option<F>> = OnceLock::new();
    let f = FUNC.get_or_init(|| {
        let p = unsafe { dlsym(RTLD_DEFAULT, c"responsibility_get_pid_responsible_for_pid".as_ptr()) };
        (!p.is_null()).then(|| unsafe { std::mem::transmute::<*mut c_void, F>(p) })
    });
    f.map(|f| f(pid))
}

/// 이 앱 웹뷰의 오디오 프로세스 객체들. 이 앱 자체(pid)는 뺀다 — 처리한 소리를 내는 곳이라 넣으면 되먹임된다.
fn our_audio_processes() -> Vec<AudioObjectID> {
    let me = std::process::id() as i32;
    let mut out: Vec<AudioObjectID> = get_ids(SYSTEM_OBJECT, PROCESS_LIST)
        .into_iter()
        .filter(|&obj| {
            let Some(pid) = get_u32(obj, PROCESS_PID).map(|v| v as i32) else { return false };
            pid != me && responsible_pid(pid) == Some(me)
        })
        .collect();
    out.sort_unstable();
    out
}

// ── 시스템 오디오 녹음 권한(TCC) ───────────────────────────────────────────
// 공개 API가 없어 오픈소스 AudioCap처럼 비공개 TCC 함수를 쓴다. 없으면(향후 macOS) 확인 없이 진행한다.
// 권한 창이 떠 있는 동안 탭 처리 루프는 시작되지 않는다(2026-10-14 관찰) → 먼저 묻고 답을 기다린다.

#[derive(Debug, Clone, Copy, PartialEq)]
enum Permission {
    Granted,
    Denied,
    Unknown,
}

struct Tcc {
    preflight: extern "C" fn(*const c_void, *const c_void) -> i32,
    request: extern "C" fn(*const c_void, *const c_void, *const c_void),
}

fn tcc() -> Option<&'static Tcc> {
    static TCC: OnceLock<Option<Tcc>> = OnceLock::new();
    TCC.get_or_init(|| unsafe {
        let h = dlopen(c"/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC".as_ptr(), RTLD_NOW);
        if h.is_null() {
            return None;
        }
        let p = dlsym(h, c"TCCAccessPreflight".as_ptr());
        let r = dlsym(h, c"TCCAccessRequest".as_ptr());
        (!p.is_null() && !r.is_null()).then(|| Tcc {
            preflight: std::mem::transmute::<*mut c_void, extern "C" fn(*const c_void, *const c_void) -> i32>(p),
            request: std::mem::transmute::<*mut c_void, extern "C" fn(*const c_void, *const c_void, *const c_void)>(r),
        })
    })
    .as_ref()
}

const TCC_SERVICE: &str = "kTCCServiceAudioCapture";

fn permission() -> Permission {
    let Some(t) = tcc() else { return Permission::Unknown };
    let service = ns(TCC_SERVICE);
    match (t.preflight)(Retained::as_ptr(&service) as *const c_void, std::ptr::null()) {
        0 => Permission::Granted,
        1 => Permission::Denied,
        _ => Permission::Unknown,
    }
}

/// 권한 창을 띄우고 답을 기다린다(최대 3분). TCC를 쓸 수 없으면 None.
fn request_permission() -> Option<bool> {
    let t = tcc()?;
    let (tx, rx) = std::sync::mpsc::channel::<bool>();
    let block = block2::RcBlock::new(move |granted: Bool| {
        let _ = tx.send(granted.as_bool());
    });
    let service = ns(TCC_SERVICE);
    (t.request)(
        Retained::as_ptr(&service) as *const c_void,
        std::ptr::null(),
        &*block as *const block2::Block<dyn Fn(Bool)> as *const c_void,
    );
    rx.recv_timeout(Duration::from_secs(180)).ok()
}

fn default_output_uid() -> Option<String> {
    let dev = get_u32(SYSTEM_OBJECT, DEFAULT_OUTPUT)?;
    get_string(dev, DEVICE_UID)
}

// ── 오디오 콜백과 공유 상태 ────────────────────────────────────────────────

const RING: usize = 4096;
const FFT_SIZE: usize = 2048;

struct Shared {
    coefs: Mutex<(f32, [Biquad; 10])>,
    callbacks: AtomicU64,
    signal_frames: AtomicU64,
    ring: Mutex<(Vec<f32>, usize)>,
}

struct CallbackState {
    shared: Arc<Shared>,
    pre: f32,
    coefs: [Biquad; 10],
    filters: [[BiquadState; 10]; 2],
}

unsafe fn buffers<'a>(list: *const AudioBufferList) -> &'a [AudioBuffer] {
    if list.is_null() {
        return &[];
    }
    std::slice::from_raw_parts((*list).mBuffers.as_ptr(), (*list).mNumberBuffers as usize)
}

/// 버퍼 묶음에서 (프레임 수, 채널 수, 표본 읽기·쓰기 위치)를 계산하는 작은 도우미.
struct Layout<'a> {
    bufs: &'a [AudioBuffer],
    interleaved: bool,
    channels: usize,
    frames: usize,
}

impl<'a> Layout<'a> {
    fn new(bufs: &'a [AudioBuffer]) -> Self {
        if bufs.is_empty() {
            return Layout { bufs, interleaved: true, channels: 0, frames: 0 };
        }
        if bufs.len() == 1 {
            let ch = bufs[0].mNumberChannels.max(1) as usize;
            Layout { bufs, interleaved: true, channels: ch, frames: bufs[0].mDataByteSize as usize / 4 / ch }
        } else {
            let frames = bufs.iter().map(|b| b.mDataByteSize as usize / 4 / b.mNumberChannels.max(1) as usize).min().unwrap_or(0);
            Layout { bufs, interleaved: false, channels: bufs.len(), frames }
        }
    }

    #[inline]
    unsafe fn ptr(&self, frame: usize, ch: usize) -> *mut f32 {
        if self.interleaved {
            (self.bufs[0].mData as *mut f32).add(frame * self.channels + ch)
        } else {
            (self.bufs[ch].mData as *mut f32).add(frame)
        }
    }
}

extern "C" fn io_proc(
    _dev: AudioObjectID,
    _now: *const c_void,
    input: *const AudioBufferList,
    _in_time: *const c_void,
    output: *mut AudioBufferList,
    _out_time: *const c_void,
    client: *mut c_void,
) -> OSStatus {
    // 여기서는 메모리를 새로 잡거나 오래 기다리지 않는다(실시간 오디오 스레드).
    let st = unsafe { &mut *(client as *mut CallbackState) };
    st.shared.callbacks.fetch_add(1, Ordering::Relaxed);
    if let Ok(c) = st.shared.coefs.try_lock() {
        st.pre = c.0;
        st.coefs = c.1;
    }
    let inp = Layout::new(unsafe { buffers(input) });
    let out = Layout::new(unsafe { buffers(output) });
    // 출력은 먼저 비운다.
    for b in out.bufs {
        if !b.mData.is_null() {
            unsafe { std::ptr::write_bytes(b.mData as *mut u8, 0, b.mDataByteSize as usize) };
        }
    }
    if inp.channels == 0 || out.channels == 0 {
        return 0;
    }
    let frames = inp.frames.min(out.frames);
    let mut ring = st.shared.ring.try_lock().ok();
    let mut heard = false;
    for f in 0..frames {
        let (l, r) = unsafe {
            let l = *inp.ptr(f, 0);
            let r = if inp.channels > 1 { *inp.ptr(f, 1) } else { l };
            (l, r)
        };
        if l != 0.0 || r != 0.0 {
            heard = true;
        }
        let mut yl = l * st.pre;
        let mut yr = r * st.pre;
        for (b, c) in st.coefs.iter().enumerate() {
            yl = st.filters[0][b].run(c, yl);
            yr = st.filters[1][b].run(c, yr);
        }
        let (yl, yr) = (soft_clip(yl), soft_clip(yr));
        unsafe {
            *out.ptr(f, 0) = yl;
            if out.channels > 1 {
                *out.ptr(f, 1) = yr;
            }
        }
        if let Some(ring) = ring.as_mut() {
            let (buf, pos) = &mut **ring;
            buf[*pos] = (yl + yr) * 0.5;
            *pos = (*pos + 1) % RING;
        }
    }
    if heard {
        st.shared.signal_frames.fetch_add(frames as u64, Ordering::Relaxed);
    }
    0
}

// ── 탭 만들기·없애기 ───────────────────────────────────────────────────────

struct Running {
    tap: AudioObjectID,
    aggregate: AudioObjectID,
    proc_id: IOProcID,
    state: *mut CallbackState,
    processes: Vec<AudioObjectID>,
    output_uid: String,
    sample_rate: f32,
    started: Instant,
}

// 담긴 포인터는 이 모듈만 다루고, 처리 루프를 멈춘 뒤에만 해제한다.
unsafe impl Send for Running {}

fn ns(s: &str) -> Retained<NSString> {
    NSString::from_str(s)
}

fn dict() -> Retained<AnyObject> {
    let cls = AnyClass::get(c"NSMutableDictionary").expect("Foundation");
    unsafe { msg_send![cls, new] }
}

fn put(d: &AnyObject, key: &str, value: &AnyObject) {
    let k = ns(key);
    unsafe {
        let _: () = msg_send![d, setObject: value, forKey: &*k];
    }
}

fn start(processes: &[AudioObjectID], shared: &Arc<Shared>, settings: &EqSettings) -> Result<Running, String> {
    let output_uid = default_output_uid().ok_or("기본 출력 장치를 찾지 못했습니다")?;

    // 1) 탭 설명
    let cls = AnyClass::get(c"CATapDescription").ok_or("이 macOS는 오디오 탭을 지원하지 않습니다(14.2 이상 필요)")?;
    let numbers: Vec<Retained<NSNumber>> = processes.iter().map(|&id| NSNumber::new_u32(id)).collect();
    let list = NSArray::from_retained_slice(&numbers);
    let desc: Retained<AnyObject> = unsafe {
        let alloc: Allocated<AnyObject> = msg_send![cls, alloc];
        msg_send![alloc, initStereoMixdownOfProcesses: &*list]
    };
    let tap_uuid: Retained<NSUUID> = unsafe {
        let _: () = msg_send![&*desc, setMuteBehavior: MUTED_WHEN_TAPPED];
        let _: () = msg_send![&*desc, setPrivate: Bool::YES];
        let _: () = msg_send![&*desc, setName: &*ns("Garak EQ")];
        msg_send![&*desc, UUID]
    };

    // 2) 탭
    let mut tap: AudioObjectID = 0;
    let st = unsafe { AudioHardwareCreateProcessTap(&*desc, &mut tap) };
    if st != 0 {
        return Err(format!("오디오 탭을 만들지 못했습니다 ({st})"));
    }

    // 3) 탭 + 기본 출력 장치를 묶은 비공개 집합 장치
    let agg = dict();
    put(&agg, "name", &ns("Garak EQ"));
    put(&agg, "uid", &ns(&NSUUID::new().UUIDString().to_string()));
    put(&agg, "master", &ns(&output_uid));
    put(&agg, "private", &NSNumber::new_bool(true));
    put(&agg, "stacked", &NSNumber::new_bool(false));
    put(&agg, "tapautostart", &NSNumber::new_bool(true));
    let sub = dict();
    put(&sub, "uid", &ns(&output_uid));
    let subs = NSArray::from_retained_slice(&[sub]);
    put(&agg, "subdevices", &subs);
    let tap_entry = dict();
    put(&tap_entry, "uid", &tap_uuid.UUIDString());
    put(&tap_entry, "drift", &NSNumber::new_bool(true));
    let taps = NSArray::from_retained_slice(&[tap_entry]);
    put(&agg, "taps", &taps);

    let mut aggregate: AudioObjectID = 0;
    let st = unsafe { AudioHardwareCreateAggregateDevice(Retained::as_ptr(&agg) as *const c_void, &mut aggregate) };
    if st != 0 {
        unsafe { AudioHardwareDestroyProcessTap(tap) };
        return Err(format!("출력 장치를 묶지 못했습니다 ({st})"));
    }

    let sample_rate = get_f64(aggregate, NOMINAL_RATE).unwrap_or(48000.0) as f32;
    *lock(&shared.coefs) = coefficients(settings, sample_rate);
    shared.callbacks.store(0, Ordering::Relaxed);
    shared.signal_frames.store(0, Ordering::Relaxed);

    // 4) 처리 루프
    let (pre, coefs) = *lock(&shared.coefs);
    let state = Box::into_raw(Box::new(CallbackState {
        shared: shared.clone(),
        pre,
        coefs,
        filters: [[BiquadState::default(); 10]; 2],
    }));
    let mut proc_id: IOProcID = std::ptr::null_mut();
    let st = unsafe { AudioDeviceCreateIOProcID(aggregate, io_proc, state as *mut c_void, &mut proc_id) };
    if st != 0 {
        unsafe {
            AudioHardwareDestroyAggregateDevice(aggregate);
            AudioHardwareDestroyProcessTap(tap);
            drop(Box::from_raw(state));
        }
        return Err(format!("오디오 처리 루프를 만들지 못했습니다 ({st})"));
    }
    let st = unsafe { AudioDeviceStart(aggregate, proc_id) };
    if st != 0 {
        unsafe {
            AudioDeviceDestroyIOProcID(aggregate, proc_id);
            AudioHardwareDestroyAggregateDevice(aggregate);
            AudioHardwareDestroyProcessTap(tap);
            drop(Box::from_raw(state));
        }
        return Err(format!("오디오 처리를 시작하지 못했습니다 ({st})"));
    }
    Ok(Running { tap, aggregate, proc_id, state, processes: processes.to_vec(), output_uid, sample_rate, started: Instant::now() })
}

fn stop(r: Running) {
    unsafe {
        AudioDeviceStop(r.aggregate, r.proc_id);
        AudioDeviceDestroyIOProcID(r.aggregate, r.proc_id);
        AudioHardwareDestroyAggregateDevice(r.aggregate);
        // 탭을 없애면 원래 소리가 다시 하드웨어로 간다.
        AudioHardwareDestroyProcessTap(r.tap);
        drop(Box::from_raw(r.state));
    }
}

// ── 관리자 ─────────────────────────────────────────────────────────────────

struct Manager {
    app: Option<AppHandle>,
    settings: EqSettings,
    visualizer_until: Option<Instant>,
    /// 권한 거부·실패를 화면에 알려도 되는 시각화(이퀄라이저 패널)가 켜 둔 기한.
    /// 앨범 표지 화면은 권한을 아직 정하지 않았으면 묻기만 하고, 거부·실패는 알리지 않는다.
    report_until: Option<Instant>,
    running: Option<Running>,
    /// 실패하면 사용자가 설정을 다시 바꿀 때까지 다시 시도하지 않는다.
    failed: Option<&'static str>,
    shared: Arc<Shared>,
}

fn manager() -> &'static Mutex<Manager> {
    static M: OnceLock<Mutex<Manager>> = OnceLock::new();
    M.get_or_init(|| {
        Mutex::new(Manager {
            app: None,
            settings: EqSettings::default(),
            visualizer_until: None,
            report_until: None,
            running: None,
            failed: None,
            shared: Arc::new(Shared {
                coefs: Mutex::new((1.0, [Biquad::IDENTITY; 10])),
                callbacks: AtomicU64::new(0),
                signal_frames: AtomicU64::new(0),
                ring: Mutex::new((vec![0.0; RING], 0)),
            }),
        })
    })
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

pub fn set_settings(settings: EqSettings) {
    let mut m = lock(manager());
    if settings.enabled != m.settings.enabled {
        m.failed = None;
    }
    m.settings = settings;
    let rate = m.running.as_ref().map(|r| r.sample_rate).unwrap_or(48000.0);
    *lock(&m.shared.coefs) = coefficients(&settings, rate);
}

/// report: 권한 거부·실패를 화면에 알려도 되는지(이퀄라이저 패널은 예, 앨범 표지 화면은 아니오).
/// 오디오 캡처 권한을 아직 정하지 않았으면 어느 쪽이든 묻는다.
pub fn set_visualizer(on: bool, report: bool) {
    let mut m = lock(manager());
    if !on {
        // 탭은 바로 끄지 않고 기한(8초)이 지나면 멈춘다. 앨범 표지 화면이 함께 보고 있으면
        // 끄고 다시 켜느라 소리가 잠깐 끊기지 않게.
        m.report_until = None;
        return;
    }
    let now = Instant::now();
    let until = Some(now + Duration::from_secs(8));
    if report {
        // 패널을 새로 열면 지난 실패를 지우고 다시 시도한다.
        if !m.report_until.is_some_and(|t| t > now) {
            m.failed = None;
        }
        m.report_until = until;
    }
    m.visualizer_until = until;
}

pub fn status_json() -> serde_json::Value {
    let m = lock(manager());
    json!({
        "platform": "macos",
        "running": m.running.is_some(),
        "failed": m.failed,
        "processes": m.running.as_ref().map(|r| r.processes.len()).unwrap_or(0),
        "sampleRate": m.running.as_ref().map(|r| r.sample_rate),
    })
}

/// 실패로 표시하고 화면에 알린다. 멈출 탭은 돌려주어 잠금 밖에서 정리하게 한다.
fn fail(m: &mut Manager, reason: &'static str) -> Option<Running> {
    m.failed = Some(reason);
    eprintln!("[eq] 탭 중단: {reason}");
    if let Some(app) = &m.app {
        let _ = app.emit_to(crate::MAIN, "eq-event", json!({ "failed": reason }));
    }
    m.running.take()
}

enum Action {
    None,
    Stop(Running),
    Start { processes: Vec<AudioObjectID>, settings: EqSettings, shared: Arc<Shared>, report: bool },
}

/// 0.5초마다: 켜야 하면 탭을 만들고, 꺼야 하거나 문제가 생기면 없앤다.
/// 탭 만들기는 macOS 권한 창이 떠 있는 동안 멈춰 기다릴 수 있어(2026-10-14 시험에서 약 2분)
/// 관리자 잠금 밖에서 한다 — 그동안에도 화면의 설정 변경은 바로 처리된다.
fn tick(app: &AppHandle) {
    let action = {
        let mut m = lock(manager());
        let now = Instant::now();
        let wanted = m.settings.enabled || m.visualizer_until.is_some_and(|t| t > now);
        if !wanted || m.failed.is_some() {
            m.running.take().map_or(Action::None, Action::Stop)
        } else {
            let processes = our_audio_processes();
            match &m.running {
                Some(r) => {
                    let elapsed = now - r.started;
                    let callbacks = m.shared.callbacks.load(Ordering::Relaxed);
                    let signal = m.shared.signal_frames.load(Ordering::Relaxed);
                    let output_changed = default_output_uid().is_some_and(|uid| uid != r.output_uid);
                    let processes_changed = !processes.is_empty() && processes != r.processes;
                    if elapsed > Duration::from_secs(6) && callbacks == 0 {
                        fail(&mut m, "device").map_or(Action::None, Action::Stop)
                    } else if elapsed > Duration::from_secs(4) && signal == 0 && crate::is_playing(app) {
                        // 재생 중인데 4초 동안 신호가 없으면 탭이 무음을 주는 것(권한 거부 등)으로 본다.
                        fail(&mut m, "permission").map_or(Action::None, Action::Stop)
                    } else if output_changed || processes_changed {
                        m.running.take().map_or(Action::None, Action::Stop)
                    } else {
                        Action::None
                    }
                }
                // 아직 소리를 낸 적이 없으면 오디오 프로세스가 없다. 재생이 시작되면 다음 확인 때 만든다.
                None if processes.is_empty() => Action::None,
                None => Action::Start {
                    processes,
                    settings: m.settings,
                    shared: m.shared.clone(),
                    report: m.settings.enabled || m.report_until.is_some_and(|t| t > now),
                },
            }
        }
    };
    match action {
        Action::None => {}
        Action::Stop(r) => stop(r),
        Action::Start { processes, settings, shared, report } => {
            // 권한부터: 거부돼 있으면 소리를 건드리지 않고 알린다. 아직이면 묻고 답을 기다린다.
            // 앨범 표지 화면만 스펙트럼을 보고 있을 때도 아직이면 묻는다(전에는 묻지 않아 이퀄라이저를 켜야만
            // 움직였다, 2026-10-23). 다만 거부는 알리지 않고, 허용한다는 답을 받았을 때만 탭을 만든다:
            // TCC를 못 쓰는 macOS라 답을 모르는데 만들면, 거부된 경우 4초 동안 소리가 끊긴 뒤에야 실패로 안다.
            let allowed = match permission() {
                Permission::Granted => true,
                Permission::Denied if report => false,
                Permission::Denied => return,
                Permission::Unknown if report => request_permission().unwrap_or(true),
                Permission::Unknown => {
                    if request_permission() != Some(true) {
                        return;
                    }
                    true
                }
            };
            if !allowed {
                let mut m = lock(manager());
                if let Some(r) = fail(&mut m, "permission") {
                    drop(m);
                    stop(r);
                }
                return;
            }
            let result = start(&processes, &shared, &settings);
            let mut m = lock(manager());
            match result {
                Ok(r) => {
                    eprintln!("[eq] 탭 시작: 프로세스 {}개, {}Hz", r.processes.len(), r.sample_rate);
                    let now = Instant::now();
                    let still_wanted = m.failed.is_none()
                        && (m.settings.enabled || m.visualizer_until.is_some_and(|t| t > now));
                    // 기다리는 동안 설정이 바뀌었을 수 있으니 계수를 다시 맞춘다.
                    *lock(&m.shared.coefs) = coefficients(&m.settings, r.sample_rate);
                    if still_wanted && m.running.is_none() {
                        m.running = Some(r);
                    } else {
                        drop(m);
                        stop(r);
                    }
                }
                Err(err) => {
                    eprintln!("[eq] {err}");
                    m.failed = Some("unsupported");
                    let _ = app.emit_to(crate::MAIN, "eq-event", json!({ "failed": "unsupported", "message": err }));
                }
            }
        }
    }
}

/// 링 버퍼의 최근 FFT_SIZE 표본 → 30Hz~16kHz 로그 간격 막대 48개(0~255 = −100~−10dB, 윈도우 Web Audio 분석기와 같은 눈금).
/// 윗한계가 −30dB이던 때는 요즘 음악의 저음이 늘 255에 붙어 움직이지 않았다(2026-10-14 합성 팝으로 확인: 값의 30%가 255).
fn spectrum(planner: &mut FftPlanner<f32>, smooth: &mut [f32], shared: &Shared, rate: f32) -> Vec<u8> {
    let mut frame = vec![Complex32::new(0.0, 0.0); FFT_SIZE];
    {
        let ring = lock(&shared.ring);
        let (buf, pos) = (&ring.0, ring.1);
        for (i, slot) in frame.iter_mut().enumerate() {
            let s = buf[(pos + RING - FFT_SIZE + i) % RING];
            let w = 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (FFT_SIZE - 1) as f32).cos();
            *slot = Complex32::new(s * w, 0.0);
        }
    }
    planner.plan_fft_forward(FFT_SIZE).process(&mut frame);
    let half = FFT_SIZE / 2;
    for (i, s) in smooth.iter_mut().enumerate().take(half) {
        let mag = frame[i].norm() / half as f32;
        *s = 0.7 * *s + 0.3 * mag;
    }
    const BARS: usize = 48;
    let (lo, hi) = (30f32.log10(), 16000f32.log10());
    let nyquist = rate / 2.0;
    (0..BARS)
        .map(|b| {
            let f0 = 10f32.powf(lo + (hi - lo) * b as f32 / BARS as f32);
            let f1 = 10f32.powf(lo + (hi - lo) * (b + 1) as f32 / BARS as f32);
            let i0 = ((f0 / nyquist) * half as f32).floor() as usize;
            let i1 = (((f1 / nyquist) * half as f32).ceil() as usize).clamp(i0, half - 1);
            let m = smooth[i0.min(half - 1)..=i1].iter().cloned().fold(0.0f32, f32::max);
            let db = 20.0 * m.max(1e-9).log10();
            (((db + 100.0) / 90.0) * 255.0).clamp(0.0, 255.0) as u8
        })
        .collect()
}

/// 서명이 바뀐 판을 처음 켤 때 한 번 지우는 기록의 표시 파일(앱 데이터 폴더).
const PERMISSION_RESET_MARKER: &str = "audio-capture-reset-v1";

/// 서명이 바뀐 판을 처음 켤 때 한 번: 예전 서명(0.2.13까지 임시 서명)으로 받은 "시스템 오디오 녹음" 허용이 남아 있으면
/// macOS는 미리 묻기에는 허용이라 답하면서 탭에는 무음만 준다. 설정 화면에도 허용으로 보여 사용자가 풀 수 없다
/// (2026-10-23 확인, tccutil reset 뒤 다시 허용하니 됐다). 이 앱의 그 기록만 지워, 다음에 이퀄라이저·스펙트럼을 쓸 때
/// 권한 창이 다시 뜨게 한다. 0.2.14부터는 Developer ID로 서명해 판이 바뀌어도 허용이 이어지므로 한 번만 한다.
fn reset_stale_permission_once(app: &AppHandle) {
    // 개발 빌드는 번들이 아니어서 권한 기록이 따로다.
    if cfg!(debug_assertions) {
        return;
    }
    let Ok(dir) = app.path().app_data_dir() else { return };
    let marker = dir.join(PERMISSION_RESET_MARKER);
    if marker.exists() {
        return;
    }
    // 아직 묻지 않았으면(새로 설치) 지울 것이 없다.
    if permission() != Permission::Unknown {
        let id = &app.config().identifier;
        match std::process::Command::new("/usr/bin/tccutil").args(["reset", "AudioCapture", id]).output() {
            Ok(out) if out.status.success() => eprintln!("[eq] 서명이 바뀌어 오디오 녹음 허용 기록을 지웠습니다(다음에 켤 때 다시 묻습니다)"),
            Ok(out) => eprintln!("[eq] 오디오 녹음 허용 기록 지우기 실패: {}", String::from_utf8_lossy(&out.stderr).trim()),
            Err(err) => eprintln!("[eq] tccutil을 실행하지 못했습니다: {err}"),
        }
    }
    if let Err(err) = std::fs::create_dir_all(&dir).and_then(|()| std::fs::write(&marker, b"")) {
        eprintln!("[eq] 표시 파일을 남기지 못했습니다(다음 실행 때 다시 지웁니다): {err}");
    }
}

pub fn init(app: &AppHandle) {
    reset_stale_permission_once(app);
    lock(manager()).app = Some(app.clone());
    let a = app.clone();
    std::thread::Builder::new()
        .name("eq-supervisor".into())
        .spawn(move || loop {
            tick(&a);
            std::thread::sleep(Duration::from_millis(500));
        })
        .expect("EQ 감독 스레드");
    let a = app.clone();
    std::thread::Builder::new()
        .name("eq-spectrum".into())
        .spawn(move || {
            let mut planner = FftPlanner::new();
            let mut smooth = vec![0.0f32; FFT_SIZE / 2];
            loop {
                std::thread::sleep(Duration::from_millis(40));
                let (show, rate, shared) = {
                    let m = lock(manager());
                    let show = m.running.is_some() && m.visualizer_until.is_some_and(|t| t > Instant::now());
                    (show, m.running.as_ref().map(|r| r.sample_rate).unwrap_or(48000.0), m.shared.clone())
                };
                if show && crate::is_playing(&a) {
                    let bars = spectrum(&mut planner, &mut smooth, &shared, rate);
                    let _ = a.emit_to(crate::MAIN, "spectrum", bars);
                }
            }
        })
        .expect("스펙트럼 스레드");
}

/// 앱을 끝낼 때 탭을 정리한다(원래 소리 복원).
pub fn shutdown() {
    if let Some(r) = lock(manager()).running.take() {
        stop(r);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 권한 상태 조회(창을 띄우지 않는다): `cargo test -- --ignored tcc`
    #[test]
    #[ignore]
    fn tcc_preflight_available() {
        assert!(tcc().is_some(), "TCC 함수를 불러오지 못함");
        println!("오디오 녹음 권한(이 시험 프로세스 기준): {:?}", permission());
    }

    /// 탭·집합 장치를 만들었다가 바로 없앤다(소리를 받지 않으므로 권한 창이 뜨지 않는다): `cargo test -- --ignored`
    #[test]
    #[ignore]
    fn create_and_destroy_tap() {
        println!("기본 출력: {:?}", default_output_uid());
        println!("이 프로세스의 오디오 하위 프로세스: {:?}", our_audio_processes());
        assert!(responsible_pid(std::process::id() as i32).is_some(), "responsibility 함수 없음");
        let shared = Arc::new(Shared {
            coefs: Mutex::new((1.0, [Biquad::IDENTITY; 10])),
            callbacks: AtomicU64::new(0),
            signal_frames: AtomicU64::new(0),
            ring: Mutex::new((vec![0.0; RING], 0)),
        });
        // 빈 목록 탭은 만들 수 있지만 IO를 시작하지 않도록 start 대신 단계별로 확인한다.
        let cls = AnyClass::get(c"CATapDescription").expect("CATapDescription");
        let list = NSArray::<NSNumber>::from_retained_slice(&[]);
        let desc: Retained<AnyObject> = unsafe {
            let alloc: Allocated<AnyObject> = msg_send![cls, alloc];
            msg_send![alloc, initStereoMixdownOfProcesses: &*list]
        };
        unsafe {
            let _: () = msg_send![&*desc, setMuteBehavior: MUTED_WHEN_TAPPED];
            let _: () = msg_send![&*desc, setPrivate: Bool::YES];
        }
        let mut tap = 0;
        let st = unsafe { AudioHardwareCreateProcessTap(&*desc, &mut tap) };
        println!("탭 만들기: 상태 {st}, id {tap}");
        assert_eq!(st, 0);
        let uuid: Retained<NSUUID> = unsafe { msg_send![&*desc, UUID] };
        let output_uid = default_output_uid().expect("출력 장치");
        let agg = dict();
        put(&agg, "name", &ns("Garak test"));
        put(&agg, "uid", &ns(&NSUUID::new().UUIDString().to_string()));
        put(&agg, "master", &ns(&output_uid));
        put(&agg, "private", &NSNumber::new_bool(true));
        put(&agg, "stacked", &NSNumber::new_bool(false));
        put(&agg, "tapautostart", &NSNumber::new_bool(true));
        let sub = dict();
        put(&sub, "uid", &ns(&output_uid));
        put(&agg, "subdevices", &NSArray::from_retained_slice(&[sub]));
        let t = dict();
        put(&t, "uid", &uuid.UUIDString());
        put(&t, "drift", &NSNumber::new_bool(true));
        put(&agg, "taps", &NSArray::from_retained_slice(&[t]));
        let mut aggregate = 0;
        let st2 = unsafe { AudioHardwareCreateAggregateDevice(Retained::as_ptr(&agg) as *const c_void, &mut aggregate) };
        println!("집합 장치: 상태 {st2}, id {aggregate}, 표본율 {:?}", get_f64(aggregate, NOMINAL_RATE));
        let mut proc_id: IOProcID = std::ptr::null_mut();
        let state = Box::into_raw(Box::new(CallbackState { shared, pre: 1.0, coefs: [Biquad::IDENTITY; 10], filters: [[BiquadState::default(); 10]; 2] }));
        let st3 = unsafe { AudioDeviceCreateIOProcID(aggregate, io_proc, state as *mut c_void, &mut proc_id) };
        println!("처리 루프 등록: 상태 {st3}");
        unsafe {
            AudioDeviceDestroyIOProcID(aggregate, proc_id);
            AudioHardwareDestroyAggregateDevice(aggregate);
            AudioHardwareDestroyProcessTap(tap);
            drop(Box::from_raw(state));
        }
        assert_eq!(st2, 0);
        assert_eq!(st3, 0);
    }
}
