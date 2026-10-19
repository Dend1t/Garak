//! 앱 화면(main) ↔ 숨은 YouTube Music 창(engine) 중계.
//!
//! - 화면이 `engine_call`을 부르면 번호를 붙여 엔진 창에 `window.__ytmEngine.handle(...)`을 실행하고,
//!   엔진 스크립트가 `engine_reply`로 같은 번호의 답을 돌려줄 때까지 기다린다.
//! - 엔진 스크립트는 `engine_event`로 상태(status)와 재생 정보(state)를 알린다.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Webview};
use tokio::sync::{oneshot, watch};

use crate::{lock, warn, ENGINE, MAIN};

/// 엔진 창이 준비될 때까지 기다리는 최대 시간.
const READY_TIMEOUT: Duration = Duration::from_secs(25);
/// 요청 하나의 최대 시간(검색·목록 이어받기 포함).
const CALL_TIMEOUT: Duration = Duration::from_secs(30);
/// 엔진 스크립트가 제공하는 요청 이름. 그 밖의 이름은 엔진까지 보내지 않는다.
const METHODS: &[&str] = &["api", "status", "state", "play", "queueAdd", "queue", "queueJump", "control", "eq", "eqStream", "avSwitch", "videoView"];
/// 개발 빌드 전용: 엔진 창에서 임의 코드를 실행하는 조사 통로(배포판에는 없다).
#[cfg(debug_assertions)]
const DEBUG_METHODS: &[&str] = &["debugEval"];
#[cfg(not(debug_assertions))]
const DEBUG_METHODS: &[&str] = &[];

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct EngineStatus {
    /// music.youtube.com에서 엔진 스크립트와 ytcfg가 준비됨
    pub ready: bool,
    pub host: String,
    pub path: String,
    pub logged_in: bool,
    pub subscriber: bool,
}

/// 엔진의 답: 성공이면 JSON 글 그대로. YouTube Music 원본 응답은 수백 KB~수 MB라 화면에 넘길 때 다시 해석·직렬화하지 않는다
/// (윈도우는 창 사이 통신을 메인 스레드에서 처리해서, 큰 값을 다루는 동안 창 입력·그리기가 함께 멈췄다).
type Reply = Result<String, String>;

pub struct Engine {
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Reply>>>,
    status: watch::Sender<EngineStatus>,
    /// 마지막 재생 상태(화면이 새로 열렸을 때 바로 보여 주기 위함)
    last_state: Mutex<Value>,
    /// 로그인 창을 띄운 뒤 로그인이 끝나면 엔진 창을 다시 숨긴다.
    login_in_progress: std::sync::atomic::AtomicBool,
}

impl Default for Engine {
    fn default() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            status: watch::channel(EngineStatus::default()).0,
            last_state: Mutex::new(Value::Null),
            login_in_progress: Default::default(),
        }
    }
}

impl Engine {
    pub fn set_login_in_progress(&self, value: bool) {
        self.login_in_progress.store(value, Ordering::SeqCst);
    }

    /// 엔진 창이 다른 주소로 이동하면 기다리던 요청은 답을 받을 수 없으므로 모두 실패로 끝낸다.
    pub fn fail_pending(&self, reason: &str) {
        for (_, tx) in lock(&self.pending).drain() {
            // 받는 쪽이 이미 시간 초과로 사라졌으면 보낼 곳이 없을 뿐이다.
            let _ = tx.send(Err(reason.to_owned()));
        }
    }

    pub fn mark_navigating(&self) {
        self.status.send_modify(|s| s.ready = false);
    }

    /// 엔진 스크립트가 준비됐는지(페이지를 새로 불러오는 중이 아닌지).
    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn ready(&self) -> bool {
        self.status.borrow().ready
    }
}

/// 화면의 엔진 요청. 답은 엔진이 보낸 JSON 글을 그대로 넘긴다(화면이 받는 값은 전과 같다).
#[tauri::command]
pub async fn engine_call(app: AppHandle, method: String, args: Option<Value>) -> Result<tauri::ipc::Response, String> {
    call_raw(&app, &method, args.unwrap_or(Value::Null)).await.map(tauri::ipc::Response::new)
}

/// 엔진 창에 요청 하나를 보내고 답(값)을 기다린다.
pub async fn call(app: &AppHandle, method: &str, args: Value) -> Result<Value, String> {
    let text = call_raw(app, method, args).await?;
    serde_json::from_str(&text).map_err(|e| format!("engine_bad_reply {e}"))
}

/// 엔진 창에 요청 하나를 보내고 답을 JSON 글 그대로 기다린다.
async fn call_raw(app: &AppHandle, method: &str, args: Value) -> Reply {
    if !METHODS.contains(&method) && !DEBUG_METHODS.contains(&method) {
        return Err(format!("unknown_method {method}"));
    }
    let engine = app.state::<Engine>();

    let mut status = engine.status.subscribe();
    // 감시 채널의 참조(Ref)는 await 너머로 들고 있을 수 없어 바로 참/거짓으로 바꾼다.
    // 조사용 요청(개발 빌드)은 어느 페이지에서든 바로 실행한다.
    let ready = DEBUG_METHODS.contains(&method)
        || matches!(
            tokio::time::timeout(READY_TIMEOUT, status.wait_for(|s| s.ready)).await,
            Ok(Ok(_))
        );
    if !ready {
        return Err("engine_not_ready".into());
    }

    let Some(window) = app.get_webview_window(ENGINE) else {
        return Err("engine_missing".into());
    };
    let id = engine.next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = oneshot::channel();
    lock(&engine.pending).insert(id, tx);

    let script = if DEBUG_METHODS.contains(&method) {
        // 페이지의 Trusted Types 정책은 eval을 막지만 웹뷰가 직접 실행하는 스크립트는 막지 않는다.
        let code = args["code"].as_str().unwrap_or("undefined");
        format!(
            "(async () => {{ const reply = (r) => window.__TAURI_INTERNALS__.invoke('engine_reply', {{ reply: r }}); \
             try {{ const v = await (async () => ({code}))(); reply({{ id: {id}, ok: true, data: v === undefined ? null : JSON.parse(JSON.stringify(v)) }}); }} \
             catch (e) {{ reply({{ id: {id}, ok: false, error: String(e && e.stack || e) }}); }} }})();"
        )
    } else {
        format!(
            "window.__ytmEngine ? window.__ytmEngine.handle({id}, {}, {}) : void 0;",
            serde_json::to_string(method).map_err(|e| e.to_string())?,
            serde_json::to_string(&args).map_err(|e| e.to_string())?,
        )
    };
    if let Err(err) = window.eval(script) {
        lock(&engine.pending).remove(&id);
        return Err(format!("engine_eval_failed {err}"));
    }

    match tokio::time::timeout(CALL_TIMEOUT, rx).await {
        Ok(Ok(reply)) => reply,
        Ok(Err(_)) => Err("engine_dropped".into()),
        Err(_) => {
            lock(&engine.pending).remove(&id);
            Err("engine_timeout".into())
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct EngineReply {
    id: u64,
    ok: bool,
    #[serde(default)]
    data: Value,
    /// 엔진이 답을 미리 JSON 글로 바꿔 보낸 것(데스크톱 engine.js). 있으면 data 대신 쓴다.
    /// 큰 답을 값 나무로 풀지 않고 글 하나로 받아 그대로 화면에 넘기기 위함이다.
    #[serde(default)]
    json: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

/// 엔진의 답. 큰 글을 검사하는 동안 메인 스레드를 잡지 않게 작업 스레드에서 받는다(답은 번호로 짝을 찾으므로 순서는 상관없다).
#[tauri::command(async)]
pub fn engine_reply(app: AppHandle, webview: Webview, reply: EngineReply) {
    if webview.label() != ENGINE {
        return;
    }
    let tx = lock(&app.state::<Engine>().pending).remove(&reply.id);
    if let Some(tx) = tx {
        let result = match (reply.ok, reply.json) {
            // 웹 페이지가 보낸 글이라 올바른 JSON인지 확인한 뒤 넘긴다(화면에서 스크립트로 실행될 수 있다).
            // 값을 만들지 않고 훑기만 해서 해석보다 훨씬 가볍다.
            (true, Some(text)) => serde_json::from_str::<serde::de::IgnoredAny>(&text)
                .map(|_| text)
                .map_err(|e| format!("engine_bad_reply {e}")),
            (true, None) => Ok(reply.data.to_string()),
            (false, _) => Err(reply.error.unwrap_or_else(|| "engine_error".into())),
        };
        // 기다리던 쪽이 시간 초과로 이미 끝났으면 버린다.
        let _ = tx.send(result);
    }
}

#[tauri::command]
pub fn engine_event(app: AppHandle, webview: Webview, kind: String, data: Value) {
    if webview.label() != ENGINE {
        return;
    }
    match kind.as_str() {
        "status" => on_status(&app, data),
        "state" => on_state(&app, data),
        // 스펙트럼(초당 25번)과 EQ 알림은 화면에 그대로 넘긴다.
        "spectrum" => warn("화면에 스펙트럼 보내기", app.emit_to(MAIN, "spectrum", &data)),
        "eq" => warn("화면에 EQ 상태 알리기", app.emit_to(MAIN, "eq-event", &data)),
        other => eprintln!("[ytm-desktop] 알 수 없는 엔진 이벤트: {other}"),
    }
}

fn on_status(app: &AppHandle, data: Value) {
    let status: EngineStatus = match serde_json::from_value(data) {
        Ok(status) => status,
        Err(err) => {
            eprintln!("[ytm-desktop] 엔진 상태 해석 실패: {err}");
            return;
        }
    };
    let engine = app.state::<Engine>();
    engine.status.send_replace(status.clone());
    #[cfg(debug_assertions)]
    eprintln!("[ytm-desktop] 엔진 상태: {status:?}");

    // 로그인 창을 띄웠다면, YouTube Music으로 돌아와 로그인된 것을 확인한 뒤 다시 숨긴다.
    if status.ready && status.logged_in && engine.login_in_progress.swap(false, Ordering::SeqCst) {
        if let Some(window) = app.get_webview_window(ENGINE) {
            warn("엔진 창 숨기기", window.hide());
        }
        crate::show_main(app);
    }
    // 준비 여부에 따라 숨은 엔진 페이지를 숨길 수 있는지가 달라진다(sync_page_visibility).
    if let Some(window) = app.get_webview_window(ENGINE) {
        crate::sync_page_visibility(&window);
    }
    crate::emit_ui(app, "engine-status", &status);
}

fn on_state(app: &AppHandle, data: Value) {
    *lock(&app.state::<Engine>().last_state) = data.clone();
    match serde_json::from_value::<crate::TrackState>(data.clone()) {
        Ok(track) => crate::on_track_state(app, track),
        Err(err) => eprintln!("[ytm-desktop] 재생 상태 해석 실패: {err}"),
    }
    crate::emit_ui(app, "player-state", &data);
}

#[tauri::command]
pub fn get_engine_status(app: AppHandle) -> EngineStatus {
    app.state::<Engine>().status.borrow().clone()
}

#[tauri::command]
pub fn get_player_state(app: AppHandle) -> Value {
    lock(&app.state::<Engine>().last_state).clone()
}

/// 화면(main 창)의 오류·경고를 터미널 기록으로 넘긴다(화면 개발자 도구 없이도 문제를 볼 수 있게).
#[tauri::command]
pub fn ui_log(webview: Webview, level: String, message: String) {
    let label = webview.label();
    if label != MAIN && label != crate::desktop::MINI {
        return;
    }
    let message: String = message.chars().take(2000).collect();
    let place = if label == MAIN { "화면" } else { "미니" };
    eprintln!("[ytm-desktop:{place}:{level}] {message}");
}

/// 개발 빌드 전용 시험: `YTM_SELFTEST=<요청목록.json>`이면 엔진이 준비된 뒤 목록의 요청을 차례로 보내고
/// 답을 같은 폴더의 out/<이름>.json에 남긴다. 목록 형식: [{"name": "...", "method": "api", "args": {...}, "waitMs": 0}]
#[cfg(debug_assertions)]
pub fn spawn_selftest(app: &AppHandle) {
    let Ok(path) = std::env::var("YTM_SELFTEST") else { return };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let list: Vec<Value> = match std::fs::read_to_string(&path).map_err(|e| e.to_string()).and_then(|t| serde_json::from_str(&t).map_err(|e| e.to_string())) {
            Ok(list) => list,
            Err(err) => {
                eprintln!("[selftest] 목록을 읽지 못함 {path}: {err}");
                return;
            }
        };
        let out = std::path::Path::new(&path).parent().unwrap_or(std::path::Path::new(".")).join("out");
        if let Err(err) = std::fs::create_dir_all(&out) {
            eprintln!("[selftest] 출력 폴더를 만들지 못함: {err}");
            return;
        }
        for item in list {
            let name = item["name"].as_str().unwrap_or("unnamed").to_owned();
            let method = item["method"].as_str().unwrap_or_default().to_owned();
            if let Some(ms) = item["waitMs"].as_u64() {
                tokio::time::sleep(Duration::from_millis(ms)).await;
            }
            let started = std::time::Instant::now();
            let result = call(&app, &method, item["args"].clone()).await;
            let elapsed = started.elapsed().as_millis();
            match result {
                Ok(value) => {
                    let text = serde_json::to_string(&value).unwrap_or_default();
                    let file = out.join(format!("{name}.json"));
                    if let Err(err) = std::fs::write(&file, &text) {
                        eprintln!("[selftest] {name}: 저장 실패 {err}");
                    }
                    eprintln!("[selftest] {name}: 성공 {}바이트 {elapsed}ms", text.len());
                }
                Err(err) => eprintln!("[selftest] {name}: 실패 {err} ({elapsed}ms)"),
            }
        }
        eprintln!("[selftest] 끝");
    });
}

/// 개발 빌드 전용: `YTM_DEBUG_DIR=<폴더>`이면 <폴더>/in/*.json(형식은 selftest 항목 하나)을 0.5초마다 집어
/// 실행하고 <폴더>/out/<이름>.json에 답을 쓴 뒤 입력 파일을 지운다. 앱을 다시 빌드하지 않고 내부를 조사하는 용도.
#[cfg(debug_assertions)]
pub fn spawn_debug_inbox(app: &AppHandle) {
    let Ok(dir) = std::env::var("YTM_DEBUG_DIR") else { return };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let inbox = std::path::Path::new(&dir).join("in");
        let out = std::path::Path::new(&dir).join("out");
        let _ = std::fs::create_dir_all(&inbox);
        let _ = std::fs::create_dir_all(&out);
        eprintln!("[debug] 요청 폴더 감시: {}", inbox.display());
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let Ok(entries) = std::fs::read_dir(&inbox) else { continue };
            let mut files: Vec<_> = entries.filter_map(Result::ok).map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")).collect();
            files.sort();
            for file in files {
                let text = std::fs::read_to_string(&file).unwrap_or_default();
                let _ = std::fs::remove_file(&file);
                let item: Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(err) => {
                        eprintln!("[debug] {} 해석 실패: {err}", file.display());
                        continue;
                    }
                };
                let name = item["name"].as_str().unwrap_or("unnamed").to_owned();
                // "window": 엔진 창 보이기·숨기기·크기(영상 화면 시험용)
                let result = if item["method"] == "window" {
                    debug_window(&app, &item["args"])
                } else if item["method"] == "desktop" {
                    debug_desktop(&app, &item["args"]).await
                } else if item["method"] == "menu" {
                    debug_menu(&app, &item["args"])
                } else {
                    call(&app, item["method"].as_str().unwrap_or_default(), item["args"].clone()).await
                };
                let body = match result {
                    Ok(v) => serde_json::json!({ "ok": true, "data": v }),
                    Err(e) => serde_json::json!({ "ok": false, "error": e }),
                };
                let _ = std::fs::write(out.join(format!("{name}.json")), body.to_string());
                eprintln!("[debug] {name} 완료");
            }
        }
    });
}

/// 개발 빌드 전용: 메뉴 문구 시험. strings가 있으면 화면처럼 언어 문구를 넘기고, 맥 메뉴·트레이 글자를 돌려준다.
#[cfg(debug_assertions)]
fn debug_menu(app: &AppHandle, args: &Value) -> Result<Value, String> {
    if let Some(map) = args.get("strings").and_then(|v| v.as_object()) {
        let strings = map.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_owned()))).collect();
        crate::apply_ui_strings(app, strings)?;
    }
    let mut menus = Vec::new();
    if let Some(menu) = app.menu() {
        for item in menu.items().map_err(|e| e.to_string())? {
            let Some(sub) = item.as_submenu() else { continue };
            let mut names = vec![sub.text().map_err(|e| e.to_string())?];
            for child in sub.items().map_err(|e| e.to_string())? {
                if let Some(m) = child.as_menuitem() {
                    names.push(m.text().map_err(|e| e.to_string())?);
                } else if let Some(p) = child.as_predefined_menuitem() {
                    names.push(p.text().map_err(|e| e.to_string())?);
                } else if let Some(s) = child.as_submenu() {
                    names.push(format!("▸ {}", s.text().map_err(|e| e.to_string())?));
                }
            }
            menus.push(names);
        }
    }
    Ok(serde_json::json!({ "menus": menus, "tray": crate::tray_texts(app) }))
}

#[cfg(debug_assertions)]
fn debug_window(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let window = app.get_webview_window(ENGINE).ok_or("engine_missing")?;
    if let (Some(w), Some(h)) = (args["w"].as_f64(), args["h"].as_f64()) {
        window.set_size(tauri::LogicalSize::new(w, h)).map_err(|e| e.to_string())?;
    }
    if args["show"].as_bool() == Some(true) {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    } else if args["show"].as_bool() == Some(false) {
        window.hide().map_err(|e| e.to_string())?;
    }
    crate::sync_page_visibility(&window);
    Ok(Value::Bool(true))
}

/// 개발 빌드 전용: 데스크톱 부가 기능(영상 창·미니 플레이어·설정)을 화면 없이 시험한다.
#[cfg(debug_assertions)]
async fn debug_desktop(app: &AppHandle, args: &Value) -> Result<Value, String> {
    match args["action"].as_str().unwrap_or_default() {
        "video" => crate::desktop::set_video(app, args["open"].as_bool().unwrap_or(true)).await.map(|_| Value::Bool(true)),
        "mini" => crate::desktop::open_mini(app, args["open"].as_bool().unwrap_or(true)).map(|_| Value::Bool(true)),
        // 화면 창(main·mini) 안에서 스크립트 실행(미니 플레이어 시험용). 결과는 스크립트가 ui_log로 남긴다.
        "eval" => {
            let label = args["window"].as_str().unwrap_or(MAIN);
            let window = app.get_webview_window(label).ok_or_else(|| format!("no_window {label}"))?;
            window.eval(args["code"].as_str().unwrap_or_default()).map_err(|e| e.to_string())?;
            Ok(Value::Bool(true))
        }
        "prefs" => {
            let prefs: crate::desktop::Prefs = serde_json::from_value(args["prefs"].clone()).map_err(|e| e.to_string())?;
            crate::desktop::set_prefs(app.clone(), prefs)
        }
        "notify" => {
            // 알림 경로 시험: 곡이 바뀐 것처럼 부른다.
            let prev = crate::TrackState { video_id: "a".into(), title: "이전 곡".into(), ..Default::default() };
            let next = crate::TrackState { video_id: "b".into(), title: args["title"].as_str().unwrap_or("시험 알림").into(), artist: "YTM".into(), ..Default::default() };
            crate::desktop::on_track_changed(app, &prev, &next);
            Ok(Value::Bool(true))
        }
        "spectrum" => {
            // 스펙트럼 그리기 시험: 소리·권한 없이 가짜 막대 48개를 초당 25번, seconds초 동안 보낸다(박자 2Hz).
            let seconds = args["seconds"].as_f64().unwrap_or(6.0);
            let app = app.clone();
            std::thread::spawn(move || {
                let started = std::time::Instant::now();
                while started.elapsed().as_secs_f64() < seconds {
                    let t = started.elapsed().as_secs_f32();
                    let beat = (t * std::f32::consts::TAU * 2.0).sin().max(0.0);
                    let bars: Vec<u8> = (0..48)
                        .map(|i| {
                            let x = i as f32 / 47.0;
                            let v = 0.82 - 0.45 * x + 0.1 * (t * 3.0 + i as f32 * 0.5).sin() + 0.15 * beat * (1.0 - x);
                            (v.clamp(0.0, 1.0) * 255.0) as u8
                        })
                        .collect();
                    let _ = app.emit_to(MAIN, "spectrum", bars);
                    std::thread::sleep(Duration::from_millis(40));
                }
            });
            Ok(Value::Bool(true))
        }
        "shortcut" => {
            use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};
            let code = match args["key"].as_str().unwrap_or("P") {
                "N" => Code::KeyN,
                "B" => Code::KeyB,
                "L" => Code::KeyL,
                "M" => Code::KeyM,
                "Up" => Code::ArrowUp,
                "Down" => Code::ArrowDown,
                _ => Code::KeyP,
            };
            crate::desktop::on_shortcut(app, &Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), code), ShortcutState::Pressed);
            Ok(Value::Bool(true))
        }
        other => Err(format!("unknown_action {other}")),
    }
}
