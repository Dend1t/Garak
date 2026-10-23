//! 이퀄라이저·스펙트럼.
//!
//! 소리는 숨은 엔진 창의 YouTube Music 플레이어가 낸다. 그 소리를 가공하는 방법이 운영체제마다 다르다.
//! - 윈도우(WebView2·크로미움): 엔진 페이지 안에서 Web Audio로 <video> 소리를 받아 처리한다(engine.js 7.5절).
//! - 맥(WKWebView): 2026-10-14 시험에서 YouTube 플레이어(MSE) 소리를 Web Audio로 받으면 신호가 0(무음)이었다.
//!   그래서 macOS 14.2+ Core Audio 프로세스 탭으로 이 앱 웹뷰 프로세스의 출력을 받아 Rust에서 처리한다(mac_tap.rs).
//!
//! 화면은 운영체제와 상관없이 `eq_set`(설정)·`eq_visualizer`(스펙트럼 켜기, 몇 초마다 다시 부름)만 부르고
//! "spectrum"(0~255 막대 48개)·"eq-event" 이벤트를 듣는다.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

/// 밴드 중심 주파수(Hz). engine.js EQ_BANDS, 화면 eq.ts와 같아야 한다.
pub const BANDS: [f32; 10] = [32.0, 64.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0];
/// 피킹 필터 Q(한 옥타브 폭). Web Audio 쪽과 같은 값.
pub const PEAK_Q: f32 = 1.05;
pub const MAX_DB: f32 = 12.0;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EqSettings {
    pub enabled: bool,
    pub gains: [f32; 10],
    pub preamp: f32,
}

impl EqSettings {
    pub fn clamped(mut self) -> Self {
        for g in &mut self.gains {
            *g = if g.is_finite() { g.clamp(-MAX_DB, MAX_DB) } else { 0.0 };
        }
        self.preamp = if self.preamp.is_finite() { self.preamp.clamp(-MAX_DB, MAX_DB) } else { 0.0 };
        self
    }
}

// ── 필터 계수(RBJ Audio EQ Cookbook) ────────────────────────────────────────

#[derive(Debug, Clone, Copy, Default)]
pub struct Biquad {
    pub b0: f32,
    pub b1: f32,
    pub b2: f32,
    pub a1: f32,
    pub a2: f32,
}

impl Biquad {
    pub const IDENTITY: Biquad = Biquad { b0: 1.0, b1: 0.0, b2: 0.0, a1: 0.0, a2: 0.0 };

    /// index 0은 저역 쉘프, 마지막은 고역 쉘프, 나머지는 피킹(Web Audio BiquadFilterNode와 같은 정의).
    pub fn band(index: usize, gain_db: f32, sample_rate: f32) -> Biquad {
        let freq = BANDS[index].min(sample_rate * 0.45);
        if gain_db.abs() < 0.01 {
            return Biquad::IDENTITY;
        }
        let a = 10f32.powf(gain_db / 40.0);
        let w0 = 2.0 * std::f32::consts::PI * freq / sample_rate;
        let (sin, cos) = w0.sin_cos();
        let (b0, b1, b2, a0, a1, a2);
        if index == 0 || index == BANDS.len() - 1 {
            // 쉘프 기울기 S = 1
            let alpha = sin / 2.0 * 2f32.sqrt();
            let two_sqrt_a_alpha = 2.0 * a.sqrt() * alpha;
            if index == 0 {
                b0 = a * ((a + 1.0) - (a - 1.0) * cos + two_sqrt_a_alpha);
                b1 = 2.0 * a * ((a - 1.0) - (a + 1.0) * cos);
                b2 = a * ((a + 1.0) - (a - 1.0) * cos - two_sqrt_a_alpha);
                a0 = (a + 1.0) + (a - 1.0) * cos + two_sqrt_a_alpha;
                a1 = -2.0 * ((a - 1.0) + (a + 1.0) * cos);
                a2 = (a + 1.0) + (a - 1.0) * cos - two_sqrt_a_alpha;
            } else {
                b0 = a * ((a + 1.0) + (a - 1.0) * cos + two_sqrt_a_alpha);
                b1 = -2.0 * a * ((a - 1.0) + (a + 1.0) * cos);
                b2 = a * ((a + 1.0) + (a - 1.0) * cos - two_sqrt_a_alpha);
                a0 = (a + 1.0) - (a - 1.0) * cos + two_sqrt_a_alpha;
                a1 = 2.0 * ((a - 1.0) - (a + 1.0) * cos);
                a2 = (a + 1.0) - (a - 1.0) * cos - two_sqrt_a_alpha;
            }
        } else {
            let alpha = sin / (2.0 * PEAK_Q);
            b0 = 1.0 + alpha * a;
            b1 = -2.0 * cos;
            b2 = 1.0 - alpha * a;
            a0 = 1.0 + alpha / a;
            a1 = -2.0 * cos;
            a2 = 1.0 - alpha / a;
        }
        Biquad { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
    }
}

/// 설정 → (프리앰프 배율, 밴드 계수). 꺼져 있으면 그대로 통과.
pub fn coefficients(settings: &EqSettings, sample_rate: f32) -> (f32, [Biquad; 10]) {
    let mut out = [Biquad::IDENTITY; 10];
    if !settings.enabled {
        return (1.0, out);
    }
    for (i, c) in out.iter_mut().enumerate() {
        *c = Biquad::band(i, settings.gains[i], sample_rate);
    }
    (10f32.powf(settings.preamp / 20.0), out)
}

/// 채널 하나의 필터 상태(직접형 II 전치).
#[derive(Debug, Clone, Copy, Default)]
pub struct BiquadState {
    z1: f32,
    z2: f32,
}

impl BiquadState {
    #[inline]
    pub fn run(&mut self, c: &Biquad, x: f32) -> f32 {
        let y = c.b0 * x + self.z1;
        self.z1 = c.b1 * x - c.a1 * y + self.z2;
        self.z2 = c.b2 * x - c.a2 * y;
        y
    }
}

/// 올린 소리가 0dB를 넘을 때 딱딱하게 잘리지 않게 0.9 위만 부드럽게 누른다.
#[inline]
pub fn soft_clip(x: f32) -> f32 {
    let a = x.abs();
    if a <= 0.9 {
        x
    } else {
        x.signum() * (0.9 + 0.1 * ((a - 0.9) / 0.1).tanh())
    }
}

// ── 명령 ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn eq_set(app: AppHandle, settings: EqSettings) -> Result<serde_json::Value, String> {
    let settings = settings.clamped();
    #[cfg(target_os = "macos")]
    {
        let _ = &app;
        crate::mac_tap::set_settings(settings);
        Ok(crate::mac_tap::status_json())
    }
    #[cfg(not(target_os = "macos"))]
    {
        crate::engine::call(&app, "eq", serde_json::to_value(settings).map_err(|e| e.to_string())?).await
    }
}

/// 화면이 스펙트럼을 보는 동안 몇 초마다 부른다(안 부르면 알아서 멈춘다).
/// report: 맥에서 오디오 캡처 권한 거부·실패를 화면에 알려도 되는지(없으면 예). 앨범 표지 화면은 false로 부른다.
/// 권한을 아직 정하지 않았으면 어느 쪽이든 묻는다.
#[tauri::command]
pub async fn eq_visualizer(app: AppHandle, on: bool, report: Option<bool>) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "macos")]
    {
        let _ = &app;
        crate::mac_tap::set_visualizer(on, report.unwrap_or(true));
        Ok(crate::mac_tap::status_json())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = report;
        crate::engine::call(&app, "eqStream", serde_json::json!({ "on": on })).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 피킹 필터의 중심 주파수 이득이 설정 dB와 같은지(복소 응답으로 확인).
    #[test]
    fn peaking_gain_at_center() {
        let fs = 48000.0;
        for (i, db) in [(5usize, 6.0f32), (3, -9.0)] {
            let c = Biquad::band(i, db, fs);
            let w = 2.0 * std::f32::consts::PI * BANDS[i] / fs;
            let (re1, im1) = (w.cos(), -w.sin());
            let (re2, im2) = ((2.0 * w).cos(), -(2.0 * w).sin());
            let num = ((c.b0 + c.b1 * re1 + c.b2 * re2).powi(2) + (c.b1 * im1 + c.b2 * im2).powi(2)).sqrt();
            let den = ((1.0 + c.a1 * re1 + c.a2 * re2).powi(2) + (c.a1 * im1 + c.a2 * im2).powi(2)).sqrt();
            let got = 20.0 * (num / den).log10();
            assert!((got - db).abs() < 0.05, "band {i}: {got} vs {db}");
        }
    }

    #[test]
    fn flat_is_identity_and_clip_is_bounded() {
        let s = EqSettings { enabled: true, gains: [0.0; 10], preamp: 0.0 };
        let (pre, c) = coefficients(&s, 44100.0);
        assert_eq!(pre, 1.0);
        let mut st = BiquadState::default();
        assert_eq!(st.run(&c[4], 0.5), 0.5);
        assert!(soft_clip(5.0) <= 1.0 && soft_clip(-5.0) >= -1.0);
        assert_eq!(soft_clip(0.3), 0.3);
    }
}
