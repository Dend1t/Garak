fn main() {
    // 앱 명령을 권한 목록에 올려, capabilities/에서 허용한 페이지만 부를 수 있게 한다.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&[
                "engine_call",
                "engine_reply",
                "engine_event",
                "get_engine_status",
                "get_player_state",
                "show_engine",
                "hide_engine",
                "chrome_login_available",
                "import_chrome_login",
                "logout",
                "spotify_playlist",
                "chart_fetch",
                "video_window",
                "mini_window",
                "mini_pin",
                "keep_awake",
                "show_main_window",
                "set_prefs",
                "set_ui_strings",
                "ui_log",
                "eq_set",
                "eq_visualizer",
            ])),
    )
    .expect("tauri-build 실패");
}
