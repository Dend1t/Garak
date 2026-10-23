// Tauri 명령·이벤트 얇은 포장. 화면 나머지 코드는 이 파일만 통해 Rust와 이야기한다.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { t } from '../i18n';

export interface EngineStatus {
  ready: boolean;
  host: string;
  path: string;
  loggedIn: boolean;
  subscriber: boolean;
}

/** engine.js readState()가 보내는 재생 상태 */
export interface PlayerState {
  videoId: string;
  title: string;
  artist: string;
  album: string;
  artwork: string;
  duration: number;
  position: number;
  playing: boolean;
  buffering: boolean;
  ad: boolean;
  likeStatus: 'LIKE' | 'DISLIKE' | 'INDIFFERENT' | string;
  repeat: 'NONE' | 'ALL' | 'ONE' | string;
  volume: number;
  muted: boolean;
  /** 노래(음원)↔영상(뮤직비디오) 짝이 있는지 */
  avAvailable?: boolean;
  /** 지금 영상 쪽인지 */
  avVideo?: boolean;
  /** 실제 영상 화면이 나오는지(노래 쪽은 소리만 받는다) */
  hasPicture?: boolean;
  /** 짝 버전 videoId와 시간 차이(짝 버전 위치 = 지금 위치 + avShift초) */
  avOther?: string;
  avShift?: number;
  /** 엔진이 상태를 읽은 시각(ms) — 재생 위치를 이어서 계산할 때 쓴다 */
  at: number;
}

export type EngineMethod = 'api' | 'status' | 'state' | 'play' | 'queueAdd' | 'queue' | 'queueJump' | 'control' | 'avSwitch' | 'videoView';

/** 엔진 오류를 사람이 읽을 문장으로. */
export function describeError(err: unknown): string {
  const message = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
  if (message.startsWith('engine_not_ready')) return t('YouTube Music 연결을 기다리는 중입니다. 잠시 뒤 다시 시도하세요.');
  if (message.startsWith('engine_timeout')) return t('YouTube Music이 응답하지 않습니다. 인터넷 연결을 확인하세요.');
  if (message.startsWith('engine_navigating')) return t('YouTube Music 페이지를 다시 불러오는 중이었습니다. 다시 시도하세요.');
  if (message.startsWith('not_on_music')) return t('YouTube Music에 로그인해야 합니다.');
  if (message === 'chrome_missing') return t('크롬을 찾지 못했습니다.');
  if (message === 'chrome_signed_out') return t('크롬에 로그인된 YouTube 계정이 없습니다. 크롬에서 YouTube에 로그인한 뒤 다시 시도하세요.');
  if (message === 'keychain_denied') return t('키체인 접근을 허용해야 가져올 수 있습니다.');
  if (message === 'keychain_missing' || message === 'chrome_decrypt_failed') return t('크롬 로그인 정보를 읽지 못했습니다.');
  if (/^http_401|^http_403/.test(message)) return t('로그인이 만료됐습니다. 다시 로그인하세요.');
  if (/^http_4\d\d/.test(message)) return t('YouTube Music이 요청을 거절했습니다 ({code}).', { code: message.slice(5, 8) });
  if (/^http_5\d\d/.test(message)) return t('YouTube Music 서버 오류입니다. 잠시 뒤 다시 시도하세요.');
  return message;
}

export function engineCall<T = unknown>(method: EngineMethod, args?: unknown): Promise<T> {
  return invoke<T>('engine_call', { method, args: args ?? null });
}

export const getEngineStatus = () => invoke<EngineStatus>('get_engine_status');
export const getPlayerState = () => invoke<PlayerState | null>('get_player_state');
export const showEngine = (mode: 'login' | 'web' | 'reload') => invoke<void>('show_engine', { mode });
export const hideEngine = () => invoke<void>('hide_engine');
/** 크롬 쿠키 저장소가 있는지(맥만 true). 키체인은 묻지 않는다. */
export const chromeLoginAvailable = () => invoke<boolean>('chrome_login_available');
/** 크롬의 YouTube 로그인을 엔진 창에 넣고 YouTube Music을 다시 연다(처음에는 맥이 키체인 접근을 묻는다). */
export const importChromeLogin = () => invoke<{ profile: string; cookies: number }>('import_chrome_login');
/** 이 앱에서만 로그아웃(엔진의 YouTube·Google 쿠키를 지운다). 다른 브라우저의 로그인은 그대로다. */
export const logout = () => invoke<void>('logout');

export const onEngineStatus = (fn: (s: EngineStatus) => void): Promise<UnlistenFn> =>
  listen<EngineStatus>('engine-status', (e) => fn(e.payload));
export const onPlayerState = (fn: (s: PlayerState) => void): Promise<UnlistenFn> =>
  listen<PlayerState>('player-state', (e) => fn(e.payload));
export const onMenuAction = (fn: (action: string) => void): Promise<UnlistenFn> =>
  listen<string>('menu-action', (e) => fn(e.payload));

// ── 데스크톱 부가 기능(src-tauri/src/desktop.rs) ──────────────────────────────
export interface Prefs {
  notifications: boolean;
  globalShortcuts: boolean;
  /** 전역 음량 단축키(⌃⌥↑↓). 다른 앱과 겹치기 쉬워 기본은 꺼짐 */
  volumeShortcuts: boolean;
  videoOnTop: boolean;
}
export const videoWindow = (open: boolean) => invoke<void>('video_window', { open });
export const miniWindow = (open: boolean) => invoke<void>('mini_window', { open });
export const miniPin = (on: boolean) => invoke<void>('mini_pin', { on });
export const sendPrefs = (prefs: Prefs) => invoke<{ failed: string[] }>('set_prefs', { prefs });
export const onVideoWindow = (fn: (open: boolean) => void): Promise<UnlistenFn> =>
  listen<boolean>('video-window', (e) => fn(e.payload));
