//! 엔진 창의 로그인 쿠키: 크롬에서 가져오기(맥 전용)와 로그아웃.
//!
//! 크롬(맥)은 쿠키를 프로필 폴더의 `Cookies`(SQLite)에 두고, 값은 키체인 "Chrome Safe Storage" 비밀번호로 만든
//! 열쇠(PBKDF2-HMAC-SHA1, 소금 "saltysalt", 1003번, 16바이트)로 AES-128-CBC 암호화해 앞에 "v10"을 붙인다.
//! 쿠키 저장소 판 24(크롬 130)부터는 푼 값 앞 32바이트가 도메인의 SHA-256이다(2026-10-23 판 24 확인).
//! YouTube·Google 쿠키만 골라 엔진 웹뷰의 쿠키 저장소(WKHTTPCookieStore)를 바꾼 뒤 YouTube Music을 다시 연다.
//! 윈도우 크롬은 127부터 쿠키를 크롬 자신만 풀 수 있게 묶어(App-Bound Encryption) 지원하지 않는다.
//!
//! 로그아웃은 엔진 웹뷰의 YouTube·Google 쿠키만 지운다. Google 로그아웃 주소로 보내면 서버에서 그 로그인이 끝나,
//! 크롬에서 가져온 로그인이면 크롬까지 로그아웃된다. 앱 화면의 설정(localStorage)은 같은 저장소에 있어 그대로 둔다.
//!
//! Tauri의 `set_cookie`·`delete_cookie`는 쓰지 않는다: cookie 크레이트가 도메인 앞 '.'을 떼어 넘겨서(wry 0.57)
//! `.youtube.com` 쿠키를 넣으면 `youtube.com`에만 가는 쿠키가 되고, 지울 때는 `.youtube.com` 쿠키와 맞지 않는다.

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, Url};

use crate::{ENGINE, HOME_URL};

/// 쿠키 저장소를 바꾸는 데 이보다 오래 걸리면 실패로 본다(보통 수십 ms).
const STORE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeImport {
    /// 가져온 크롬 프로필 이름
    pub profile: String,
    pub cookies: usize,
}

/// 크롬 쿠키 저장소가 있는지(키체인은 묻지 않는다). 로그인 화면이 가져오기 단추를 보일지 정한다.
#[tauri::command]
pub fn chrome_login_available() -> bool {
    #[cfg(target_os = "macos")]
    return !mac::profiles().is_empty();
    #[cfg(not(target_os = "macos"))]
    false
}

/// 크롬의 YouTube 로그인을 엔진 창에 넣고 YouTube Music을 다시 연다.
/// 처음에는 맥이 키체인 접근을 물으므로, 답할 때까지 기다리는 일을 별도 스레드에서 한다.
#[tauri::command]
pub async fn import_chrome_login(app: AppHandle) -> Result<ChromeImport, String> {
    #[cfg(target_os = "macos")]
    return tauri::async_runtime::spawn_blocking(move || mac::import(&app))
        .await
        .map_err(|e| format!("login_task {e}"))?;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("chrome_unsupported".into())
    }
}

/// 이 앱에서만 로그아웃: 엔진 웹뷰의 YouTube·Google 쿠키를 지우고 YouTube Music을 다시 연다.
/// 쿠키 저장소의 답을 기다리는 동안 메인 스레드를 막지 않게 별도 스레드에서 한다.
#[tauri::command]
pub async fn logout(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let deleted = clear_account_cookies(&app)?;
        eprintln!("[ytm-desktop] 로그아웃: 엔진 쿠키 {deleted}개 지움");
        reload_engine(&app)
    })
    .await
    .map_err(|e| format!("login_task {e}"))?
}

/// 지운 쿠키 수
fn clear_account_cookies(app: &AppHandle) -> Result<usize, String> {
    #[cfg(target_os = "macos")]
    return mac::replace_engine_cookies(app, Vec::new()).map(|(deleted, _)| deleted);
    #[cfg(windows)]
    return win::clear_account_cookies(app);
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = app;
        Err("logout_unsupported".into())
    }
}

fn reload_engine(app: &AppHandle) -> Result<(), String> {
    let window = app.get_webview_window(ENGINE).ok_or("engine_missing")?;
    window
        .navigate(Url::parse(HOME_URL).expect("HOME_URL은 고정된 올바른 주소"))
        .map_err(|e| format!("engine_navigate {e}"))
}

/// 로그인 쿠키 도메인: YouTube와 Google 계정(로그인 창·계정 전환이 같은 계정을 보게).
fn is_account_host(host: &str) -> bool {
    let host = host.strip_prefix('.').unwrap_or(host);
    ["youtube.com", "google.com"]
        .iter()
        .any(|base| host == *base || host.strip_suffix(base).is_some_and(|sub| sub.ends_with('.')))
}

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::Cell;
    use std::ffi::{c_char, c_int, c_void, CStr, CString};
    use std::path::{Path, PathBuf};
    use std::ptr::{self, NonNull};
    use std::sync::mpsc::{self, Sender};
    use std::time::{SystemTime, UNIX_EPOCH};

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2_foundation::{
        NSArray, NSDate, NSHTTPCookie, NSHTTPCookieDomain, NSHTTPCookieExpires, NSHTTPCookieName,
        NSHTTPCookiePath, NSHTTPCookiePropertyKey, NSHTTPCookieSameSiteLax, NSHTTPCookieSameSitePolicy,
        NSHTTPCookieSameSiteStrict, NSHTTPCookieSecure, NSHTTPCookieValue, NSMutableDictionary, NSString,
    };
    use objc2::runtime::AnyObject;
    use objc2_web_kit::{WKHTTPCookieStore, WKWebView};
    use serde_json::Value;
    use tauri::{AppHandle, Manager, Url};

    use super::{is_account_host, ChromeImport, STORE_TIMEOUT};
    use crate::ENGINE;

    const KEYCHAIN_SERVICE: &str = "Chrome Safe Storage";
    const KEYCHAIN_ACCOUNT: &str = "Chrome";
    /// 이 이름 중 하나가 `.youtube.com`에 있으면 크롬이 YouTube에 로그인된 것으로 본다.
    const LOGIN_COOKIES: [&str; 3] = ["SID", "__Secure-1PSID", "__Secure-3PSID"];
    /// 크롬 쿠키 시각은 1601-01-01부터의 마이크로초다.
    const CHROME_EPOCH_OFFSET_SECS: f64 = 11_644_473_600.0;
    /// 분할 쿠키(top_frame_site_key가 있는 것)는 다른 사이트 안에서만 쓰여 옮기지 않는다.
    const QUERY: &str = "SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, \
                         samesite, has_expires FROM cookies WHERE top_frame_site_key = '' \
                         AND (host_key LIKE '%youtube.com' OR host_key LIKE '%google.com')";

    pub(super) struct Profile {
        name: String,
        cookies: PathBuf,
    }

    fn chrome_root() -> Option<PathBuf> {
        Some(PathBuf::from(std::env::var_os("HOME")?).join("Library/Application Support/Google/Chrome"))
    }

    /// 쿠키 저장소가 있는 크롬 프로필. 마지막에 쓴 프로필이 먼저 온다.
    pub(super) fn profiles() -> Vec<Profile> {
        let Some(root) = chrome_root() else { return Vec::new() };
        let state: Value = std::fs::read(root.join("Local State"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        let info = state["profile"]["info_cache"].as_object();
        let mut dirs: Vec<String> = info.map(|m| m.keys().cloned().collect()).unwrap_or_default();
        if dirs.is_empty() {
            dirs.push("Default".into());
        }
        if let Some(last) = state["profile"]["last_used"].as_str() {
            if let Some(i) = dirs.iter().position(|d| d == last) {
                let last = dirs.remove(i);
                dirs.insert(0, last);
            }
        }
        dirs.into_iter()
            // 폴더 이름은 크롬 파일에서 읽은 값이라 프로필 폴더 밖을 가리키지 못하게 한다.
            .filter(|dir| !dir.is_empty() && !dir.contains('/') && dir != "." && dir != "..")
            .map(|dir| Profile {
                name: info
                    .and_then(|m| m[&dir]["name"].as_str())
                    .filter(|name| !name.is_empty())
                    .unwrap_or(&dir)
                    .to_owned(),
                cookies: root.join(&dir).join("Cookies"),
            })
            .filter(|p| p.cookies.is_file())
            .collect()
    }

    pub(super) fn import(app: &AppHandle) -> Result<ChromeImport, String> {
        let profiles = profiles();
        if profiles.is_empty() {
            return Err("chrome_missing".into());
        }
        // 키체인을 묻기 전에 로그인된 프로필이 있는지 먼저 본다(이름만 보면 되고 값은 풀지 않아도 된다).
        let mut found = None;
        let mut read_error = None;
        for profile in profiles {
            match read_rows(&profile.cookies) {
                Ok((version, rows)) if rows.iter().any(Row::is_login) => {
                    found = Some((profile, version, rows));
                    break;
                }
                Ok(_) => {}
                Err(err) => read_error = Some(err),
            }
        }
        let Some((profile, version, rows)) = found else {
            return Err(read_error.unwrap_or_else(|| "chrome_signed_out".into()));
        };
        let key = derive_key(&keychain_password()?)?;
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64());
        let mut cookies = Vec::with_capacity(rows.len());
        let mut login_ok = false;
        let mut undecrypted = 0;
        for row in &rows {
            let Some(value) = row.decrypt(&key, version) else {
                undecrypted += 1;
                continue;
            };
            let expires = row.expires_unix();
            if expires.is_some_and(|at| at <= now) {
                continue;
            }
            login_ok |= row.is_login();
            cookies.push(Cookie {
                name: row.name.clone(),
                value,
                domain: row.host.clone(),
                path: row.path.clone(),
                expires,
                secure: row.secure,
                http_only: row.http_only,
                same_site: row.same_site,
            });
        }
        if undecrypted > 0 {
            eprintln!("[ytm-desktop] 크롬 쿠키 {undecrypted}개를 풀지 못해 건너뜁니다");
        }
        if !login_ok {
            return Err("chrome_decrypt_failed".into());
        }
        let wanted = cookies.len();
        let (deleted, count) = replace_engine_cookies(app, cookies)?;
        eprintln!("[ytm-desktop] 크롬 로그인 가져오기: 엔진 쿠키 {deleted}개 지우고 {count}/{wanted}개 넣음");
        if count == 0 {
            return Err("cookie_store_rejected".into());
        }
        super::reload_engine(app)?;
        Ok(ChromeImport { profile: profile.name, cookies: count })
    }

    // ── 크롬 쿠키 저장소 읽기 ────────────────────────────────────────────────

    struct Row {
        host: String,
        name: String,
        value: Vec<u8>,
        encrypted: Vec<u8>,
        path: String,
        expires_utc: i64,
        secure: bool,
        http_only: bool,
        /// 크롬 값: -1 정하지 않음, 0 None, 1 Lax, 2 Strict
        same_site: i64,
        has_expires: bool,
    }

    impl Row {
        fn is_login(&self) -> bool {
            self.host == ".youtube.com" && LOGIN_COOKIES.contains(&self.name.as_str())
        }

        fn decrypt(&self, key: &[u8; 16], version: i64) -> Option<String> {
            if self.encrypted.is_empty() {
                return String::from_utf8(self.value.clone()).ok();
            }
            let mut plain = aes_cbc_decrypt(key, self.encrypted.strip_prefix(b"v10")?)?;
            if version >= 24 {
                if plain.len() < 32 || plain[..32] != sha256(self.host.as_bytes()) {
                    return None;
                }
                plain.drain(..32);
            }
            String::from_utf8(plain).ok()
        }

        fn expires_unix(&self) -> Option<f64> {
            (self.has_expires && self.expires_utc > 0)
                .then(|| self.expires_utc as f64 / 1_000_000.0 - CHROME_EPOCH_OFFSET_SECS)
        }
    }

    /// (쿠키 저장소 판, YouTube·Google 쿠키)
    fn read_rows(path: &Path) -> Result<(i64, Vec<Row>), String> {
        // 크롬이 켜져 있으면 파일을 잠가 두므로 immutable(잠금·저널 확인 없이 읽기)로 연다.
        let mut uri = Url::from_file_path(path).map_err(|_| "chrome_db_path".to_string())?;
        uri.set_query(Some("immutable=1"));
        let db = sqlite::Db::open_readonly(uri.as_str())?;
        let version = db
            .query("SELECT value FROM meta WHERE key = 'version'", |s| s.text(0))?
            .first()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        let rows = db.query(QUERY, |s| Row {
            host: s.text(0),
            name: s.text(1),
            value: s.bytes(2),
            encrypted: s.bytes(3),
            path: s.text(4),
            expires_utc: s.int(5),
            secure: s.int(6) != 0,
            http_only: s.int(7) != 0,
            same_site: s.int(8),
            has_expires: s.int(9) != 0,
        })?;
        Ok((version, rows.into_iter().filter(|r| is_account_host(&r.host)).collect()))
    }

    /// macOS에 들어 있는 libsqlite3를 직접 부른다(읽기 전용 한 가지 쓰임이라 크레이트를 더하지 않는다).
    mod sqlite {
        use super::*;

        const SQLITE_OK: c_int = 0;
        const SQLITE_ROW: c_int = 100;
        const SQLITE_DONE: c_int = 101;
        const SQLITE_OPEN_READONLY: c_int = 0x1;
        const SQLITE_OPEN_URI: c_int = 0x40;

        #[link(name = "sqlite3")]
        extern "C" {
            fn sqlite3_open_v2(filename: *const c_char, db: *mut *mut c_void, flags: c_int, vfs: *const c_char) -> c_int;
            fn sqlite3_close(db: *mut c_void) -> c_int;
            fn sqlite3_errmsg(db: *mut c_void) -> *const c_char;
            fn sqlite3_prepare_v2(db: *mut c_void, sql: *const c_char, len: c_int, stmt: *mut *mut c_void, tail: *mut *const c_char) -> c_int;
            fn sqlite3_step(stmt: *mut c_void) -> c_int;
            fn sqlite3_finalize(stmt: *mut c_void) -> c_int;
            fn sqlite3_column_blob(stmt: *mut c_void, col: c_int) -> *const c_void;
            fn sqlite3_column_bytes(stmt: *mut c_void, col: c_int) -> c_int;
            fn sqlite3_column_int64(stmt: *mut c_void, col: c_int) -> i64;
        }

        pub struct Db(*mut c_void);

        impl Drop for Db {
            fn drop(&mut self) {
                // SAFETY: open_readonly가 연 핸들(실패해도 닫아야 한다)을 한 번만 닫는다.
                unsafe { sqlite3_close(self.0) };
            }
        }

        pub struct Stmt(*mut c_void);

        impl Stmt {
            /// 글자·바이트 열 모두 그대로의 바이트로 읽는다.
            pub fn bytes(&self, col: c_int) -> Vec<u8> {
                // SAFETY: SQLITE_ROW를 받은 문장에서 읽고, 길이는 blob을 읽은 뒤에 묻는다(SQLite 안내 순서).
                unsafe {
                    let data = sqlite3_column_blob(self.0, col);
                    let len = sqlite3_column_bytes(self.0, col);
                    if data.is_null() || len <= 0 {
                        return Vec::new();
                    }
                    std::slice::from_raw_parts(data.cast::<u8>(), len as usize).to_vec()
                }
            }

            pub fn text(&self, col: c_int) -> String {
                String::from_utf8_lossy(&self.bytes(col)).into_owned()
            }

            pub fn int(&self, col: c_int) -> i64 {
                // SAFETY: SQLITE_ROW를 받은 문장에서 읽는다.
                unsafe { sqlite3_column_int64(self.0, col) }
            }
        }

        impl Db {
            pub fn open_readonly(uri: &str) -> Result<Self, String> {
                let uri = CString::new(uri).map_err(|_| "chrome_db_path".to_string())?;
                let mut handle = ptr::null_mut();
                // SAFETY: 이름은 NUL로 끝나는 문자열이고, 받은 핸들은 성공·실패와 관계없이 Db가 닫는다.
                let rc = unsafe { sqlite3_open_v2(uri.as_ptr(), &mut handle, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI, ptr::null()) };
                let db = Db(handle);
                if rc != SQLITE_OK {
                    return Err(format!("chrome_db {}", db.error()));
                }
                Ok(db)
            }

            fn error(&self) -> String {
                if self.0.is_null() {
                    return "out_of_memory".into();
                }
                // SAFETY: 열린 핸들의 오류 문장은 다음 호출 전까지 유효하다.
                unsafe { CStr::from_ptr(sqlite3_errmsg(self.0)) }.to_string_lossy().into_owned()
            }

            pub fn query<T>(&self, sql: &str, mut read: impl FnMut(&Stmt) -> T) -> Result<Vec<T>, String> {
                let sql = CString::new(sql).expect("고정된 SQL");
                let mut stmt = ptr::null_mut();
                // SAFETY: 열린 핸들과 NUL로 끝나는 SQL. 만든 문장은 아래에서 꼭 정리한다.
                if unsafe { sqlite3_prepare_v2(self.0, sql.as_ptr(), -1, &mut stmt, ptr::null_mut()) } != SQLITE_OK {
                    return Err(format!("chrome_db {}", self.error()));
                }
                let stmt = Stmt(stmt);
                let mut out = Vec::new();
                let result = loop {
                    // SAFETY: 준비된 문장을 한 줄씩 넘긴다.
                    match unsafe { sqlite3_step(stmt.0) } {
                        SQLITE_ROW => out.push(read(&stmt)),
                        SQLITE_DONE => break Ok(out),
                        _ => break Err(format!("chrome_db {}", self.error())),
                    }
                };
                // SAFETY: 준비된 문장을 한 번만 정리한다.
                unsafe { sqlite3_finalize(stmt.0) };
                result
            }
        }
    }

    // ── 키체인·복호화(Security·CommonCrypto) ─────────────────────────────────

    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
    const ERR_SEC_USER_CANCELED: i32 = -128;
    const ERR_SEC_AUTH_FAILED: i32 = -25293;

    #[link(name = "Security", kind = "framework")]
    extern "C" {
        fn SecKeychainFindGenericPassword(
            keychain_or_array: *const c_void,
            service_len: u32,
            service: *const c_char,
            account_len: u32,
            account: *const c_char,
            password_len: *mut u32,
            password: *mut *mut c_void,
            item: *mut *mut c_void,
        ) -> i32;
        fn SecKeychainItemFreeContent(attr_list: *mut c_void, data: *mut c_void) -> i32;
    }

    // CommonCrypto는 libSystem에 들어 있다.
    extern "C" {
        fn CCKeyDerivationPBKDF(
            algorithm: u32,
            password: *const c_char,
            password_len: usize,
            salt: *const u8,
            salt_len: usize,
            prf: u32,
            rounds: u32,
            derived_key: *mut u8,
            derived_key_len: usize,
        ) -> c_int;
        fn CCCrypt(
            op: u32,
            alg: u32,
            options: u32,
            key: *const c_void,
            key_len: usize,
            iv: *const c_void,
            data_in: *const c_void,
            data_in_len: usize,
            data_out: *mut c_void,
            data_out_avail: usize,
            data_out_moved: *mut usize,
        ) -> i32;
        fn CC_SHA256(data: *const c_void, len: u32, md: *mut u8) -> *mut u8;
    }

    const K_CC_PBKDF2: u32 = 2;
    const K_CC_PRF_HMAC_SHA1: u32 = 1;
    const K_CC_DECRYPT: u32 = 1;
    const K_CC_ALGORITHM_AES: u32 = 0;
    const K_CC_OPTION_PKCS7_PADDING: u32 = 1;

    /// 키체인 "Chrome Safe Storage" 비밀번호. 처음에는 맥이 허용할지 묻고, 답할 때까지 돌아오지 않는다.
    fn keychain_password() -> Result<Vec<u8>, String> {
        let mut len = 0u32;
        let mut data = ptr::null_mut();
        // SAFETY: 서비스·계정 이름은 길이를 함께 넘기고, 받은 비밀번호는 복사한 뒤 바로 돌려준다.
        let status = unsafe {
            SecKeychainFindGenericPassword(
                ptr::null(),
                KEYCHAIN_SERVICE.len() as u32,
                KEYCHAIN_SERVICE.as_ptr().cast(),
                KEYCHAIN_ACCOUNT.len() as u32,
                KEYCHAIN_ACCOUNT.as_ptr().cast(),
                &mut len,
                &mut data,
                ptr::null_mut(),
            )
        };
        match status {
            0 => {}
            ERR_SEC_USER_CANCELED | ERR_SEC_AUTH_FAILED => return Err("keychain_denied".into()),
            ERR_SEC_ITEM_NOT_FOUND => return Err("keychain_missing".into()),
            other => return Err(format!("keychain {other}")),
        }
        // SAFETY: 성공하면 data가 len바이트를 가리킨다.
        let password = unsafe { std::slice::from_raw_parts(data.cast::<u8>(), len as usize) }.to_vec();
        // SAFETY: SecKeychainFindGenericPassword가 준 버퍼를 한 번만 돌려준다.
        unsafe { SecKeychainItemFreeContent(ptr::null_mut(), data) };
        Ok(password)
    }

    fn derive_key(password: &[u8]) -> Result<[u8; 16], String> {
        let salt = b"saltysalt";
        let mut key = [0u8; 16];
        // SAFETY: 모든 버퍼는 넘긴 길이만큼 유효하다.
        let rc = unsafe {
            CCKeyDerivationPBKDF(
                K_CC_PBKDF2,
                password.as_ptr().cast(),
                password.len(),
                salt.as_ptr(),
                salt.len(),
                K_CC_PRF_HMAC_SHA1,
                1003,
                key.as_mut_ptr(),
                key.len(),
            )
        };
        if rc != 0 {
            return Err(format!("chrome_key {rc}"));
        }
        Ok(key)
    }

    fn aes_cbc_decrypt(key: &[u8; 16], data: &[u8]) -> Option<Vec<u8>> {
        let iv = [b' '; 16];
        let mut out = vec![0u8; data.len() + 16];
        let mut moved = 0usize;
        // SAFETY: 출력 버퍼는 입력보다 한 블록 크고, 모든 버퍼는 넘긴 길이만큼 유효하다.
        let status = unsafe {
            CCCrypt(
                K_CC_DECRYPT,
                K_CC_ALGORITHM_AES,
                K_CC_OPTION_PKCS7_PADDING,
                key.as_ptr().cast(),
                key.len(),
                iv.as_ptr().cast(),
                data.as_ptr().cast(),
                data.len(),
                out.as_mut_ptr().cast(),
                out.len(),
                &mut moved,
            )
        };
        (status == 0).then(|| {
            out.truncate(moved);
            out
        })
    }

    fn sha256(data: &[u8]) -> [u8; 32] {
        let mut digest = [0u8; 32];
        // SAFETY: 입력은 넘긴 길이만큼, 출력은 32바이트 유효하다.
        unsafe { CC_SHA256(data.as_ptr().cast(), data.len() as u32, digest.as_mut_ptr()) };
        digest
    }

    // ── 엔진 웹뷰 쿠키 바꾸기 ────────────────────────────────────────────────

    pub(super) struct Cookie {
        name: String,
        value: String,
        /// 크롬 host_key 그대로: '.'으로 시작하면 하위 도메인에도 가는 쿠키
        domain: String,
        path: String,
        expires: Option<f64>,
        secure: bool,
        http_only: bool,
        same_site: i64,
    }

    impl Cookie {
        fn to_ns(&self) -> Option<Retained<NSHTTPCookie>> {
            let props = NSMutableDictionary::<NSHTTPCookiePropertyKey, AnyObject>::new();
            let truth = NSString::from_str("TRUE");
            // SAFETY: Foundation이 내보내는 상수 열쇠이고, 값은 NSHTTPCookie가 받는 형식(글자·날짜)이다.
            unsafe {
                props.insert(NSHTTPCookieName, &*NSString::from_str(&self.name));
                props.insert(NSHTTPCookieValue, &*NSString::from_str(&self.value));
                props.insert(NSHTTPCookieDomain, &*NSString::from_str(&self.domain));
                props.insert(NSHTTPCookiePath, &*NSString::from_str(&self.path));
                if let Some(at) = self.expires {
                    props.insert(NSHTTPCookieExpires, &*NSDate::dateWithTimeIntervalSince1970(at));
                }
                if self.secure {
                    props.insert(NSHTTPCookieSecure, &*truth);
                }
                if self.http_only {
                    // NSHTTPCookie가 알아듣는 열쇠지만 상수로 내보내지 않는다.
                    props.insert(&*NSString::from_str("HttpOnly"), &*truth);
                }
                match self.same_site {
                    1 => props.insert(NSHTTPCookieSameSitePolicy, NSHTTPCookieSameSiteLax),
                    2 => props.insert(NSHTTPCookieSameSitePolicy, NSHTTPCookieSameSiteStrict),
                    _ => {}
                }
                NSHTTPCookie::cookieWithProperties(&props)
            }
        }
    }

    /// 엔진 웹뷰의 YouTube·Google 쿠키를 모두 지우고 `cookies`로 채운다(비우면 로그아웃). 끝날 때까지 기다린다.
    /// (지운 수, 넣은 수)
    pub(super) fn replace_engine_cookies(app: &AppHandle, cookies: Vec<Cookie>) -> Result<(usize, usize), String> {
        let window = app.get_webview_window(ENGINE).ok_or("engine_missing")?;
        let (done, finished) = mpsc::channel();
        window
            .with_webview(move |webview| {
                // SAFETY: with_webview는 엔진 WKWebView를 메인 스레드에서 넘겨준다.
                let store = unsafe {
                    let webview = &*webview.inner().cast::<WKWebView>();
                    webview.configuration().websiteDataStore().httpCookieStore()
                };
                replace_in_store(store, cookies, done);
            })
            .map_err(|e| format!("engine_webview {e}"))?;
        finished
            .recv_timeout(STORE_TIMEOUT)
            .map_err(|_| "cookie_store_timeout".to_string())
    }

    /// 메인 스레드: 지우기가 다 끝난 뒤 넣고, 넣기가 다 끝나면 `done`에 (지운 수, 넣은 수)를 알린다.
    fn replace_in_store(store: Retained<WKHTTPCookieStore>, cookies: Vec<Cookie>, done: Sender<(usize, usize)>) {
        let pending = Cell::new(Some((store.clone(), cookies, done)));
        let fetched = RcBlock::new(move |all: NonNull<NSArray<NSHTTPCookie>>| {
            let Some((store, cookies, done)) = pending.take() else { return };
            // SAFETY: getAllCookies가 넘긴 배열은 이 블록 안에서 유효하다.
            let stale: Vec<_> = unsafe { all.as_ref() }
                .iter()
                .filter(|c| is_account_host(&c.domain().to_string()))
                .collect();
            let deleted_count = stale.len();
            let set_all = {
                let store = store.clone();
                move || {
                    let fresh: Vec<_> = cookies.iter().filter_map(Cookie::to_ns).collect();
                    let set_count = fresh.len();
                    let finished = after_all(set_count, move || {
                        let _ = done.send((deleted_count, set_count));
                    });
                    for cookie in &fresh {
                        // SAFETY: 메인 스레드에서 같은 쿠키 저장소에 넣는다.
                        unsafe { store.setCookie_completionHandler(cookie, finished.as_deref()) };
                    }
                }
            };
            let deleted = after_all(stale.len(), set_all);
            for cookie in &stale {
                // SAFETY: 메인 스레드에서 같은 쿠키 저장소의 쿠키를 지운다.
                unsafe { store.deleteCookie_completionHandler(cookie, deleted.as_deref()) };
            }
        });
        // SAFETY: 메인 스레드에서 부르고, 블록은 저장소가 필요한 만큼 붙잡아 둔다.
        unsafe { store.getAllCookies(&fetched) };
    }

    /// `count`번 불리면 `then`을 한 번 부르는 완료 블록. `count`가 0이면 바로 부르고 블록은 없다.
    fn after_all(count: usize, then: impl FnOnce() + 'static) -> Option<RcBlock<dyn Fn()>> {
        if count == 0 {
            then();
            return None;
        }
        let left = Cell::new(count);
        let then = Cell::new(Some(then));
        Some(RcBlock::new(move || {
            left.set(left.get().saturating_sub(1));
            if left.get() == 0 {
                if let Some(then) = then.take() {
                    then();
                }
            }
        }))
    }
}

#[cfg(windows)]
mod win {
    use std::sync::mpsc::{self, Sender};

    use tauri::{AppHandle, Manager};
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Controller, ICoreWebView2_2};
    use webview2_com::{take_pwstr, GetCookiesCompletedHandler};
    use windows_core::{Interface, PCWSTR, PWSTR};

    use super::{is_account_host, STORE_TIMEOUT};
    use crate::ENGINE;

    /// 엔진 웹뷰(WebView2)의 YouTube·Google 쿠키를 지운다. 끝날 때까지 기다린다. 지운 수를 돌려준다.
    pub(super) fn clear_account_cookies(app: &AppHandle) -> Result<usize, String> {
        let window = app.get_webview_window(ENGINE).ok_or("engine_missing")?;
        let (done, finished) = mpsc::channel();
        window
            .with_webview(move |webview| {
                // SAFETY: with_webview는 엔진 WebView2 컨트롤러를 UI 스레드에서 넘겨준다.
                if let Err(err) = unsafe { delete_in_store(webview.controller(), done.clone()) } {
                    let _ = done.send(Err(format!("cookie_store {err}")));
                }
            })
            .map_err(|e| format!("engine_webview {e}"))?;
        finished
            .recv_timeout(STORE_TIMEOUT)
            .map_err(|_| "cookie_store_timeout".to_string())?
    }

    /// UI 스레드: 쿠키 목록을 받으면 YouTube·Google 쿠키를 지우고 `done`에 알린다.
    unsafe fn delete_in_store(
        controller: ICoreWebView2Controller,
        done: Sender<Result<usize, String>>,
    ) -> windows_core::Result<()> {
        let manager = controller.CoreWebView2()?.cast::<ICoreWebView2_2>()?.CookieManager()?;
        let deleter = manager.clone();
        let handler = GetCookiesCompletedHandler::create(Box::new(move |status, list| {
            let result = (|| -> windows_core::Result<usize> {
                status?;
                let Some(list) = list else { return Ok(0) };
                let mut count = 0u32;
                list.Count(&mut count)?;
                let mut deleted = 0;
                for i in 0..count {
                    let cookie = list.GetValueAtIndex(i)?;
                    let mut domain = PWSTR::null();
                    cookie.Domain(&mut domain)?;
                    if is_account_host(&take_pwstr(domain)) {
                        deleter.DeleteCookie(&cookie)?;
                        deleted += 1;
                    }
                }
                Ok(deleted)
            })();
            let _ = done.send(result.map_err(|e| format!("cookie_store {e}")));
            Ok(())
        }));
        manager.GetCookies(PCWSTR::null(), &handler)
    }
}

#[cfg(test)]
mod tests {
    use super::is_account_host;

    #[test]
    fn account_hosts() {
        for host in [".youtube.com", "music.youtube.com", "youtube.com", ".google.com", "accounts.google.com"] {
            assert!(is_account_host(host), "{host}");
        }
        for host in ["notyoutube.com", ".google.co.kr", "youtube.com.evil.example", "ggoogle.com"] {
            assert!(!is_account_host(host), "{host}");
        }
    }
}
