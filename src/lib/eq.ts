// 이퀄라이저 설정·프리셋·응답 곡선, 그리고 Rust(eq_set·eq_visualizer)·이벤트(spectrum·eq-event) 연결.
// 소리 처리는 맥은 Core Audio 탭(Rust), 윈도우는 엔진 페이지의 Web Audio가 맡는다(src-tauri/src/eq.rs 참고).
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { t, tk } from '../i18n';
import { createStore, useStore } from './store';
import { onEngineStatus, showEngine } from './tauri';

/** 밴드 중심 주파수 — src-tauri/src/eq.rs BANDS, engine.js EQ_BANDS와 같아야 한다. */
export const BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;
export const BAND_LABELS = ['32', '64', '125', '250', '500', '1K', '2K', '4K', '8K', '16K'];
export const MAX_DB = 12;
const PEAK_Q = 1.05;

export interface EqSettings {
  enabled: boolean;
  gains: number[];
  preamp: number;
  preset: string;
}

export interface Preset {
  id: string;
  /** 번역 열쇠(한국어 원문). 화면에서 t(label)로 그린다. */
  label: string;
  gains: number[];
}

export const PRESETS: Preset[] = [
  { id: 'flat', label: tk('기본'), gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: 'bass', label: tk('저음 강조'), gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
  { id: 'treble', label: tk('고음 강조'), gains: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6] },
  { id: 'vocal', label: tk('보컬'), gains: [-2, -2, -1, 1, 3, 4, 3, 1, 0, -1] },
  { id: 'acoustic', label: tk('어쿠스틱'), gains: [3, 3, 2, 1, 1, 1, 2, 3, 3, 2] },
  { id: 'dance', label: tk('댄스'), gains: [5, 4, 2, 0, -1, 0, 1, 2, 3, 3] },
  { id: 'rock', label: tk('록'), gains: [4, 3, 2, 0, -1, -1, 1, 2, 3, 4] },
  { id: 'classical', label: tk('클래식'), gains: [3, 2, 1, 0, 0, 0, 0, 1, 2, 3] },
  { id: 'jazz', label: tk('재즈'), gains: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3] },
  { id: 'quiet', label: tk('작은 음량'), gains: [5, 4, 2, 0, 0, 0, 0, 1, 3, 4] },
];

/** 올린 만큼 프리앰프를 내려 소리가 깨지지 않게 하는 권장값 */
export const headroom = (gains: number[]) => -Math.round(Math.max(0, ...gains) / 2);

const STORAGE_KEY = 'ytm-desktop:eq:v1';
const DEFAULT: EqSettings = { enabled: false, gains: [...PRESETS[0].gains], preamp: 0, preset: 'flat' };

function load(): EqSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<EqSettings> | null;
    if (!raw || !Array.isArray(raw.gains) || raw.gains.length !== BANDS.length) return DEFAULT;
    return { ...DEFAULT, ...raw, gains: raw.gains.map((g) => clampDb(Number(g))) };
  } catch {
    return DEFAULT;
  }
}

export const clampDb = (v: number) => (Number.isFinite(v) ? Math.max(-MAX_DB, Math.min(MAX_DB, v)) : 0);

export const eqStore = createStore<EqSettings>(load());
export const useEq = <S>(select: (s: EqSettings) => S) => useStore(eqStore, select);

/** 엔진·탭 상태 메시지(실패 사유 등) */
export interface EqStatus {
  failed?: string;
  running?: boolean;
}
export const eqStatusStore = createStore<EqStatus>({});
export const useEqStatus = <S>(select: (s: EqStatus) => S) => useStore(eqStatusStore, select);

let pushTimer = 0;
function push(settings: EqSettings) {
  window.clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => {
    invoke<{ running?: boolean; failed?: string | null }>('eq_set', {
      settings: { enabled: settings.enabled, gains: settings.gains, preamp: settings.preamp },
    }).then(
      (r) => eqStatusStore.set({ running: !!r?.running, failed: r?.failed ?? undefined }),
      (err) => {
        const message = String(err);
        console.warn('[eq] 설정 적용 실패', message);
        eqStatusStore.set({ failed: message.includes('no_webaudio') || message.includes('eq_unsupported') ? 'unsupported' : 'error' });
      },
    );
  }, 60);
}

export function updateEq(patch: Partial<EqSettings>) {
  eqStore.set((s) => {
    const next = { ...s, ...patch };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // 저장 못 해도 이번 실행에는 적용된다.
    }
    return next;
  });
  if ('enabled' in patch) eqStatusStore.set({});
  push(eqStore.get());
}

export function applyPreset(id: string) {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) return;
  updateEq({ gains: [...preset.gains], preamp: headroom(preset.gains), preset: id });
}

export function setBand(index: number, db: number) {
  const gains = [...eqStore.get().gains];
  gains[index] = clampDb(Math.round(db * 2) / 2);
  updateEq({ gains, preset: 'custom' });
}

/**
 * 스펙트럼 시각화를 켜 둔다. 끄는 함수를 돌려준다(몇 초마다 다시 알려야 계속 보낸다).
 * report=false(앨범 표지 화면): 맥에서 오디오 캡처 권한을 아직 정하지 않았으면 묻되, 거부·실패는 알리지 않는다(허용됐을 때만 움직인다).
 * 끌 때도 따로 알리지 않고 몇 초 뒤 알아서 멈추게 둔다(이퀄라이저 패널이 같이 보고 있을 수 있다).
 */
export function keepVisualizer(report = true): () => void {
  const ping = () =>
    invoke('eq_visualizer', { on: true, report }).catch((err) => {
      console.warn('[eq] 시각화 실패', err);
      if (report) eqStatusStore.set({ ...eqStatusStore.get(), failed: 'visualizer' });
    });
  void ping();
  const timer = window.setInterval(ping, 4000);
  return () => {
    window.clearInterval(timer);
    if (report) invoke('eq_visualizer', { on: false }).catch(() => undefined);
  };
}

export const onSpectrum = (fn: (bars: number[]) => void): Promise<UnlistenFn> =>
  listen<number[]>('spectrum', (e) => fn(e.payload));

/** 앱 시작 때: 저장된 설정을 적용하고, 실패 알림·엔진 재시작을 처리한다. */
export async function startEqSync(onFailed: (reason: string) => void) {
  if (eqStore.get().enabled) push(eqStore.get());
  const stopEvent = await listen<{ failed?: string }>('eq-event', (e) => {
    if (!e.payload?.failed) return;
    eqStatusStore.set({ failed: e.payload.failed, running: false });
    // 소리가 끊기는 상황이면 EQ를 끈다(맥은 탭이 이미 원래 소리로 돌려놓았다).
    updateEq({ enabled: false });
    // 윈도우 Web Audio 연결은 되돌릴 수 없어 엔진 페이지를 다시 불러와야 소리가 돌아온다.
    if (e.payload.failed === 'webaudio') void showEngine('reload').catch(() => undefined);
    onFailed(e.payload.failed);
  });
  // 윈도우: 엔진 페이지가 새로 뜨면 Web Audio 연결도 새로 해야 한다.
  let wasReady = false;
  const stopStatus = await onEngineStatus((s) => {
    if (s.ready && !wasReady && eqStore.get().enabled) push(eqStore.get());
    wasReady = s.ready;
  });
  return () => {
    stopEvent();
    stopStatus();
  };
}

// ── 응답 곡선(RBJ Audio EQ Cookbook, Rust eq.rs·Web Audio와 같은 식) ──────────

interface Coef { b0: number; b1: number; b2: number; a1: number; a2: number }

function bandCoef(index: number, gainDb: number, fs: number): Coef | null {
  if (Math.abs(gainDb) < 0.01) return null;
  const A = 10 ** (gainDb / 40);
  const w0 = (2 * Math.PI * Math.min(BANDS[index], fs * 0.45)) / fs;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  let b0, b1, b2, a0, a1, a2;
  if (index === 0 || index === BANDS.length - 1) {
    const alpha = (sin / 2) * Math.SQRT2;
    const k = 2 * Math.sqrt(A) * alpha;
    if (index === 0) {
      b0 = A * (A + 1 - (A - 1) * cos + k); b1 = 2 * A * (A - 1 - (A + 1) * cos); b2 = A * (A + 1 - (A - 1) * cos - k);
      a0 = A + 1 + (A - 1) * cos + k; a1 = -2 * (A - 1 + (A + 1) * cos); a2 = A + 1 + (A - 1) * cos - k;
    } else {
      b0 = A * (A + 1 + (A - 1) * cos + k); b1 = -2 * A * (A - 1 + (A + 1) * cos); b2 = A * (A + 1 + (A - 1) * cos - k);
      a0 = A + 1 - (A - 1) * cos + k; a1 = 2 * (A - 1 - (A + 1) * cos); a2 = A + 1 - (A - 1) * cos - k;
    }
  } else {
    const alpha = sin / (2 * PEAK_Q);
    b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function magnitudeDb(c: Coef, f: number, fs: number) {
  const w = (2 * Math.PI * f) / fs;
  const re1 = Math.cos(w), im1 = -Math.sin(w), re2 = Math.cos(2 * w), im2 = -Math.sin(2 * w);
  const nr = c.b0 + c.b1 * re1 + c.b2 * re2, ni = c.b1 * im1 + c.b2 * im2;
  const dr = 1 + c.a1 * re1 + c.a2 * re2, di = c.a1 * im1 + c.a2 * im2;
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

/** 20Hz~20kHz 사이 points개 지점의 전체 응답(dB, 프리앰프 포함) */
export function responseCurve(gains: number[], preamp: number, points = 120, fs = 48000): { f: number; db: number }[] {
  const coefs = gains.map((g, i) => bandCoef(i, g, fs)).filter((c): c is Coef => !!c);
  const lo = Math.log10(20);
  const hi = Math.log10(20000);
  return Array.from({ length: points }, (_, i) => {
    const f = 10 ** (lo + ((hi - lo) * i) / (points - 1));
    const db = preamp + coefs.reduce((sum, c) => sum + magnitudeDb(c, f, fs), 0);
    return { f, db };
  });
}

export function describeEqFailure(reason: string): string {
  switch (reason) {
    case 'permission':
      return t('소리를 받을 권한이 없습니다. 시스템 설정 → 개인정보 보호 및 보안 → 화면 및 시스템 오디오 녹음에서 Garak을 허용한 뒤 다시 켜세요.');
    case 'device':
      return t('출력 장치에서 오디오 처리를 시작하지 못해 원래 소리로 되돌렸습니다. 다시 켜 보세요.');
    case 'unsupported':
      return t('이 환경에서는 이퀄라이저를 쓸 수 없습니다(macOS 14.2 이상 필요).');
    case 'webaudio':
      return t('이 PC에서는 이퀄라이저가 소리를 끊어 원래대로 되돌렸습니다. YouTube Music을 다시 불러옵니다.');
    case 'visualizer':
      return t('스펙트럼을 켜지 못했습니다. 곡을 재생한 뒤 다시 열어 보세요.');
    default:
      return t('이퀄라이저를 켜지 못했습니다 ({reason}).', { reason });
  }
}
