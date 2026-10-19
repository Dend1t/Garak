//! 데스크톱 부가 기능: 영상 창, 미니 플레이어 창, 곡이 바뀔 때 알림, 전역 단축키.
//!
//! - 영상 창: 숨은 엔진 창을 영상만 보이게(engine.js videoView) 띄운다. 엔진 페이지는 창이 화면에 보일 때만
//!   스타일을 다시 계산해서(2026-10-14 시험) 창을 먼저 보이고 나서 영상 모드를 켠다.
//! - 미니 플레이어: 같은 화면 코드를 `index.html#mini`로 띄운 작은 창(늘 위).
//! - 알림·전역 단축키는 화면이 `set_prefs`로 켜고 끈다(설정은 화면 저장소에 있다).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, LogicalSize, Manager, Size, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;

use crate::{emit_ui, engine, l, lock, send_command, warn, Command, TrackState, ENGINE, MAIN};

pub(crate) const MINI: &str = "mini";

/// 엔진 창이 로그인·웹 화면일 때의 크기 제한(lib.rs build_engine_window와 같다)
const ENGINE_MIN: (f64, f64) = (820.0, 560.0);
const VIDEO_MIN: (f64, f64) = (320.0, 180.0);
const VIDEO_SIZE: (f64, f64) = (720.0, 405.0);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Prefs {
    /// 앱 창을 보고 있지 않을 때 곡이 바뀌면 알림
    pub notifications: bool,
    pub global_shortcuts: bool,
    /// 전역 음량 단축키(⌃⌥↑↓). 창 정리 앱과 겹치기 쉬워 사용자가 켤 때만 등록한다.
    pub volume_shortcuts: bool,
    /// 영상 창을 늘 위에
    pub video_on_top: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Self { notifications: true, global_shortcuts: true, volume_shortcuts: false, video_on_top: false }
    }
}

#[derive(Default)]
pub struct Extras {
    video: AtomicBool,
    prefs: Mutex<Prefs>,
}

pub fn video_open(app: &AppHandle) -> bool {
    app.state::<Extras>().video.load(Ordering::SeqCst)
}

// ── 영상 창 ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn video_window(app: AppHandle, open: bool) -> Result<(), String> {
    set_video(&app, open).await
}

pub async fn set_video(app: &AppHandle, open: bool) -> Result<(), String> {
    let window = app.get_webview_window(ENGINE).ok_or("engine_missing")?;
    let extras = app.state::<Extras>();
    if open {
        if !extras.video.swap(true, Ordering::SeqCst) {
            warn("영상 창 최소 크기", window.set_min_size(Some(Size::Logical(LogicalSize::new(VIDEO_MIN.0, VIDEO_MIN.1)))));
            warn("영상 창 크기", window.set_size(LogicalSize::new(VIDEO_SIZE.0, VIDEO_SIZE.1)));
            warn("영상 창 늘 위", window.set_always_on_top(lock(&extras.prefs).video_on_top));
        }
        warn("영상 창 제목", window.set_title(&video_title(app)));
        // 창이 뜨기 전에 영상 모드를 먼저 켜서 첫 화면부터 영상 배치로 보이게 하고(웹 화면이 한 번 비치지 않게),
        // 뜬 뒤에 한 번 더 불러 새 창 크기에 맞춘다(엔진 페이지는 보일 때만 배치를 다시 계산한다).
        let view = json!({ "on": true, "layout": "window" });
        if let Err(err) = engine::call(app, "videoView", view.clone()).await {
            eprintln!("[ytm-desktop] 영상 모드 미리 켜기 실패: {err}");
        }
        warn("영상 창 어두운 테마", window.set_theme(Some(tauri::Theme::Dark)));
        warn("영상 창 보이기", window.show());
        warn("영상 창 앞으로", window.set_focus());
        crate::sync_page_visibility(&window);
        engine::call(app, "videoView", view).await?;
    } else if extras.video.swap(false, Ordering::SeqCst) {
        if let Err(err) = engine::call(app, "videoView", json!({ "on": false })).await {
            eprintln!("[ytm-desktop] 영상 모드 끄기 실패: {err}");
        }
        restore_engine_window(&window);
        warn("영상 창 숨기기", window.hide());
        crate::sync_page_visibility(&window);
    }
    emit_ui(app, "video-window", open);
    Ok(())
}

/// 로그인·웹 화면으로 쓰기 전에 영상 모드를 푼다(창은 그대로 둔다).
pub fn leave_video(app: &AppHandle) {
    if !app.state::<Extras>().video.swap(false, Ordering::SeqCst) {
        return;
    }
    if let Some(window) = app.get_webview_window(ENGINE) {
        restore_engine_window(&window);
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = engine::call(&handle, "videoView", json!({ "on": false })).await {
            eprintln!("[ytm-desktop] 영상 모드 끄기 실패: {err}");
        }
    });
    emit_ui(app, "video-window", false);
}

/// 영상 창을 닫으면(빨간 단추) 영상 모드를 끈다.
pub fn on_engine_close(app: &AppHandle) {
    if video_open(app) {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(err) = set_video(&handle, false).await {
                eprintln!("[ytm-desktop] 영상 창 닫기 실패: {err}");
            }
        });
    }
}

fn restore_engine_window(window: &tauri::WebviewWindow) {
    warn("엔진 창 테마 되돌리기", window.set_theme(None));
    warn("엔진 창 늘 위 풀기", window.set_always_on_top(false));
    warn("엔진 창 최소 크기", window.set_min_size(Some(Size::Logical(LogicalSize::new(ENGINE_MIN.0, ENGINE_MIN.1)))));
    warn("엔진 창 제목", window.set_title(&l(window.app_handle(), "YouTube Music — 로그인·웹 화면")));
}

fn video_title(app: &AppHandle) -> String {
    let track = lock(&app.state::<crate::AppState>().track).clone();
    if track.title.is_empty() {
        l(app, "Garak 영상")
    } else if track.artist.is_empty() {
        track.title
    } else {
        format!("{} – {}", track.title, track.artist)
    }
}

/// 언어가 바뀌면 열려 있는 창 제목을 다시 단다.
pub fn on_language_changed(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(ENGINE) {
        let title = if video_open(app) { video_title(app) } else { l(app, "YouTube Music — 로그인·웹 화면") };
        warn("엔진 창 제목", window.set_title(&title));
    }
    if let Some(window) = app.get_webview_window(MINI) {
        warn("미니 플레이어 제목", window.set_title(&l(app, "Garak 미니 플레이어")));
    }
}

/// 곡이 바뀌면 영상 창 제목도 바꾼다.
pub fn on_track_changed(app: &AppHandle, prev: &TrackState, next: &TrackState) {
    if video_open(app) {
        if let Some(window) = app.get_webview_window(ENGINE) {
            warn("영상 창 제목", window.set_title(&video_title(app)));
        }
    }
    notify(app, prev, next);
}

// ── 미니 플레이어 ───────────────────────────────────────────────────────────

/// 미니 플레이어 열기·닫기. 윈도우는 동기 명령·이벤트 처리기 안에서 창을 만들면 교착 상태에 빠져
/// (Tauri WebviewWindowBuilder 문서의 알려진 문제, 화면은 멈추고 노래만 나왔다) 비동기 명령으로 받는다.
#[tauri::command]
pub async fn mini_window(app: AppHandle, open: bool) -> Result<(), String> {
    open_mini(&app, open)
}

pub(crate) fn open_mini(app: &AppHandle, open: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(MINI) {
        if open {
            warn("미니 플레이어 보이기", window.show());
            warn("미니 플레이어 앞으로", window.set_focus());
            crate::sync_page_visibility(&window);
        } else {
            warn("미니 플레이어 닫기", window.close());
        }
        return Ok(());
    }
    if !open {
        return Ok(());
    }
    let builder = WebviewWindowBuilder::new(app, MINI, WebviewUrl::App("index.html#mini".into()))
        .title(l(app, "Garak 미니 플레이어"))
        .inner_size(380.0, 152.0)
        .resizable(false)
        .maximizable(false)
        .always_on_top(true)
        // 다른 앱을 쓰다가 바로 누르는 창이라, 첫 클릭이 창 활성화에만 쓰이지 않고 단추까지 가게 한다
        // (맥 기본값이면 활성화되지 않은 미니 플레이어의 단추를 한 번 눌러서는 아무 반응이 없었다).
        .accept_first_mouse(true)
        .background_color(crate::MAIN_BACKGROUND)
        .disable_drag_drop_handler()
        .on_navigation(crate::is_app_url);
    // 맥: 제목 막대를 없애고 신호등 단추만 내용 위에 얹는다(그림자·둥근 모서리는 그대로).
    #[cfg(target_os = "macos")]
    let builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

/// 미니 플레이어의 "큰 창 열기"
#[tauri::command]
pub fn show_main_window(app: AppHandle) {
    crate::show_main(&app);
}

#[tauri::command]
pub fn mini_pin(app: AppHandle, on: bool) -> Result<(), String> {
    let window = app.get_webview_window(MINI).ok_or("mini_missing")?;
    window.set_always_on_top(on).map_err(|e| e.to_string())
}

/// 전체 화면 모드(모니터에 틀어 두기) 동안 화면이 꺼지지 않게 한다.
/// 맥은 시스템의 caffeinate -d를 띄워 두고(-w: 이 앱이 끝나면 함께 끝난다), 끄면 그 프로세스를 끝낸다.
#[tauri::command]
pub fn keep_awake(on: bool) -> Result<(), String> {
    static AWAKE: Mutex<Option<std::process::Child>> = Mutex::new(None);
    let mut slot = lock(&AWAKE);
    if let Some(mut child) = slot.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    #[cfg(target_os = "macos")]
    if on {
        let child = std::process::Command::new("/usr/bin/caffeinate")
            .args(["-d", "-w", &std::process::id().to_string()])
            .spawn()
            .map_err(|e| format!("caffeinate {e}"))?;
        *slot = Some(child);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = on;
    Ok(())
}

// ── 설정: 알림·전역 단축키 ──────────────────────────────────────────────────

/// 전역 단축키(⌃⌥ = Ctrl+Alt). 화살표·스페이스는 창 관리 앱과 겹치기 쉬워 글자 키를 쓴다.
const SHORTCUTS: &[(Code, &str, &str)] = &[
    (Code::KeyP, "toggle", "재생/일시정지"),
    (Code::KeyN, "next", "다음 곡"),
    (Code::KeyB, "previous", "이전 곡"),
    (Code::KeyL, "like", "좋아요"),
    (Code::KeyM, "mini", "미니 플레이어"),
];

/// 전역 음량 단축키(⌃⌥↑↓). 맥 창 정리 앱(Rectangle·Magnet 기본값)과 윈도우 그래픽 드라이버의 화면 회전 키와 겹칠 수 있어
/// 설정에서 켤 때만 등록한다(Prefs.volume_shortcuts).
const VOLUME_SHORTCUTS: &[(Code, &str, &str)] = &[
    (Code::ArrowUp, "volume-up", "음량 크게"),
    (Code::ArrowDown, "volume-down", "음량 작게"),
];
/// 음량 단축키 한 번에 바뀌는 음량(%). 화면 단축키(⌘/Ctrl+↑↓)와 같다.
const VOLUME_STEP: f64 = 5.0;

fn shortcut(code: Code) -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), code)
}

#[tauri::command]
pub fn set_prefs(app: AppHandle, prefs: Prefs) -> Result<Value, String> {
    *lock(&app.state::<Extras>().prefs) = prefs.clone();
    if video_open(&app) {
        if let Some(window) = app.get_webview_window(ENGINE) {
            warn("영상 창 늘 위", window.set_always_on_top(prefs.video_on_top));
        }
    }
    let manager = app.global_shortcut();
    warn("전역 단축키 해제", manager.unregister_all());
    let mut failed = Vec::new();
    // 나란히 시험 모드(개발 빌드)에서는 배포판의 전역 단축키를 빼앗지 않는다.
    if prefs.global_shortcuts && !crate::parallel() {
        let volume: &[(Code, &str, &str)] = if prefs.volume_shortcuts { VOLUME_SHORTCUTS } else { &[] };
        for (code, _, label) in SHORTCUTS.iter().chain(volume) {
            if let Err(err) = manager.register(shortcut(*code)) {
                eprintln!("[ytm-desktop] 전역 단축키 등록 실패({label}): {err}");
                failed.push(*label);
            }
        }
    }
    Ok(json!({ "failed": failed }))
}

/// 전역 단축키 처리(플러그인 처리기에서 부른다).
pub fn on_shortcut(app: &AppHandle, pressed: &Shortcut, state: ShortcutState) {
    if state != ShortcutState::Pressed {
        return;
    }
    let Some((_, action, _)) = SHORTCUTS.iter().chain(VOLUME_SHORTCUTS).find(|(code, _, _)| *pressed == shortcut(*code)) else {
        return;
    };
    match *action {
        "toggle" => send_command(app, Command::Toggle),
        "next" => send_command(app, Command::Next),
        "previous" => send_command(app, Command::Previous),
        "volume-up" => send_command(app, Command::VolumeBy(VOLUME_STEP)),
        "volume-down" => send_command(app, Command::VolumeBy(-VOLUME_STEP)),
        // 좋아요는 화면의 보관함 상태와 같이 바뀌어야 해서 화면에 맡긴다.
        "like" => crate::emit_to_main(app, "menu-action", "like-current"),
        "mini" => {
            // 단축키 처리기 안에서 바로 창을 만들면 윈도우에서 멈추므로 비동기 작업으로 넘긴다.
            let open = app.get_webview_window(MINI).is_none();
            let app = app.clone();
            tauri::async_runtime::spawn(async move { warn("미니 플레이어", open_mini(&app, open)) });
        }
        _ => {}
    }
}

/// 앱 창을 보고 있지 않을 때 곡이 바뀌면 알린다.
fn notify(app: &AppHandle, prev: &TrackState, next: &TrackState) {
    if prev.video_id.is_empty() || prev.video_id == next.video_id || next.title.is_empty() {
        return;
    }
    if !lock(&app.state::<Extras>().prefs).notifications {
        return;
    }
    let focused = [MAIN, MINI, ENGINE]
        .iter()
        .filter_map(|label| app.get_webview_window(label))
        .any(|w| w.is_focused().unwrap_or(false));
    if focused {
        return;
    }
    let result = app
        .notification()
        .builder()
        .title(next.title.clone())
        .body(if next.artist.is_empty() { "YouTube Music".to_owned() } else { next.artist.clone() })
        .show();
    if let Err(err) = result {
        eprintln!("[ytm-desktop] 곡 알림 실패: {err}");
    }
}
