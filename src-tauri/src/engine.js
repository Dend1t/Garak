// YTM 엔진 스크립트 — 숨은 "engine" 창(music.youtube.com)에 페이지 스크립트보다 먼저 들어간다(데스크톱·iOS 공용).
// 앱 화면(main 창)은 이 스크립트를 통해서만 YouTube Music과 이야기한다.
//
// 분석 근거 (2026-10-14, 플레이어 player_es6 22cb88bc / 클라이언트 WEB_REMIX 1.20261011.16.00):
// - 플레이어는 `navigator.mediaSession && window.MediaMetadata`일 때만 mediaSession 모듈을 만들고
//   곡 정보·재생 상태·위치·동작(play/pause/seekto/nexttrack/previoustrack)을 등록한다.
// - 컴포넌트는 `yt-navigate` CustomEvent({endpoint})로 화면 이동·재생을 요청한다.
// - 대기열은 <ytmusic-player-queue>의 Redux 저장소(getState/dispatch)가 관리한다(아래 4절).
// - 내부 API 인증: `SAPISIDHASH <초>_<sha1("<초> <SAPISID> <출처>")>`, 1P·3P 쿠키로 만든 값도 함께 보낸다.
// - 플레이어 바 버튼: `.next-button`, `.previous-button`, `#play-pause-button`.
(() => {
  'use strict';
  if (window.top !== window || window.__ytmEngine) return;
  if (!/(^|\.)youtube\.com$/.test(location.hostname)) return;

  const ON_MUSIC = location.hostname === 'music.youtube.com';
  const SIGNIN_URL =
    'https://accounts.google.com/ServiceLogin?ltmpl=music&service=youtube&uilel=3&passive=true' +
    '&continue=https%3A%2F%2Fwww.youtube.com%2Fsignin%3Faction_handle_signin%3Dtrue%26app%3Ddesktop' +
    '%26hl%3Dko%26next%3Dhttps%253A%252F%252Fmusic.youtube.com%252F&hl=ko';

  // 앱과의 통로: 데스크톱은 Tauri, iOS 앱은 ios/YTM/Engine.swift가 먼저 넣는 window.__ytmIpc.
  const bridge = () => window.__ytmIpc || window.__TAURI_INTERNALS__;
  const invoke = (cmd, args) => {
    const ipc = bridge();
    if (!ipc || typeof ipc.invoke !== 'function') return Promise.reject(new Error('ipc_unavailable'));
    return ipc.invoke(cmd, args);
  };
  const emit = (kind, data) =>
    invoke('engine_event', { kind, data }).catch((err) => console.warn('[ytm-engine] 이벤트 전달 실패', kind, err));

  // ── 1. mediaSession 바꿔 끼우기 ─────────────────────────────────────────
  // 곡 정보·재생 상태는 가로채 앱에 넘긴다. 데스크톱은 앱(media.rs)이 맥 '지금 재생'을 직접 채우므로 여기서 멈춘다.
  // iOS 앱은 소리를 내는 WebKit이 잠금 화면·제어 센터 정보를 내보내서, 실제 mediaSession에도 그대로 넘겨야
  // 잠금 화면에 표지·제목과 이전/다음 단추가 나온다(2026-10-14 아이폰: 넘기지 않으면 표지가 비었다).
  let realSession = null;
  if (window.__ytmIpc) {
    try {
      const desc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'mediaSession');
      realSession = (desc && desc.get && desc.get.call(navigator)) || null;
    } catch {
      realSession = null;
    }
  }
  const forward = (what, fn) => {
    if (!realSession) return;
    try {
      fn(realSession);
    } catch (err) {
      console.warn('[ytm-engine] 잠금 화면 정보 넘기기 실패', what, err);
    }
  };
  const session = { metadata: null, playbackState: 'none', handlers: Object.create(null) };
  const fakeSession = {
    get metadata() { return session.metadata; },
    set metadata(value) {
      session.metadata = value || null;
      forward('metadata', (s) => { s.metadata = value || null; });
      schedule();
    },
    get playbackState() { return session.playbackState; },
    set playbackState(value) {
      session.playbackState = String(value);
      forward('playbackState', (s) => { s.playbackState = value; });
      schedule();
    },
    setActionHandler(action, handler) {
      session.handlers[action] = typeof handler === 'function' ? handler : null;
      forward(action, (s) => s.setActionHandler(action, typeof handler === 'function' ? handler : null));
    },
    setPositionState(state) {
      forward('positionState', (s) => s.setPositionState(state));
      schedule();
    },
    setCameraActive() {},
    setMicrophoneActive() {},
  };
  try {
    Object.defineProperty(navigator, 'mediaSession', { configurable: true, enumerable: true, get: () => fakeSession });
  } catch (err) {
    console.warn('[ytm-engine] mediaSession을 바꾸지 못했습니다', err);
  }
  if (typeof window.MediaMetadata !== 'function') {
    window.MediaMetadata = class MediaMetadata {
      constructor(init = {}) {
        this.title = init.title || '';
        this.artist = init.artist || '';
        this.album = init.album || '';
        this.artwork = Array.isArray(init.artwork) ? init.artwork : [];
      }
    };
  }

  // ── 2. 공통 도구 ────────────────────────────────────────────────────────
  const cfg = (key) => {
    try {
      return window.ytcfg && typeof window.ytcfg.get === 'function' ? window.ytcfg.get(key) : undefined;
    } catch {
      return undefined;
    }
  };
  const player = () => document.getElementById('movie_player');
  const app = () => document.querySelector('ytmusic-app');
  const bar = () => document.querySelector('ytmusic-player-bar');
  const call = (target, method, ...args) => {
    try {
      return target && typeof target[method] === 'function' ? target[method](...args) : undefined;
    } catch {
      return undefined;
    }
  };
  const finite = (value, fallback) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;

  // ── 3. 내부 API (InnerTube) 호출 ────────────────────────────────────────
  const cookie = (name) => {
    for (const part of document.cookie.split('; ')) {
      const at = part.indexOf('=');
      if (at > 0 && part.slice(0, at) === name) return decodeURIComponent(part.slice(at + 1));
    }
    return '';
  };
  async function sha1Hex(text) {
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  async function authorization() {
    const origin = location.origin;
    const now = Math.floor(Date.now() / 1000);
    const hash = async (label, value) => `${label} ${now}_${await sha1Hex(`${now} ${value} ${origin}`)}`;
    const parts = [];
    const sapisid = cookie('SAPISID') || cookie('__Secure-3PAPISID');
    if (sapisid) parts.push(await hash('SAPISIDHASH', sapisid));
    const first = cookie('__Secure-1PAPISID');
    if (first) parts.push(await hash('SAPISID1PHASH', first));
    const third = cookie('__Secure-3PAPISID');
    if (third) parts.push(await hash('SAPISID3PHASH', third));
    return parts.join(' ');
  }

  async function api({ endpoint, body = {}, query = {} }) {
    if (!ON_MUSIC) throw new Error('not_on_music');
    if (typeof endpoint !== 'string' || !/^[a-z_]+(\/[a-z_]+)*$/.test(endpoint)) throw new Error('bad_endpoint');
    // 페이지 맥락에는 시간이 지나면 만료되는 값(request.consistencyTokenJars)과 클릭 추적값이 들어 있어
    // 가끔 400 "invalid argument"가 났다(2026-10-14 관찰). 그 값들은 빼고 보낸다.
    const full = JSON.parse(JSON.stringify(cfg('INNERTUBE_CONTEXT') || {
      client: { clientName: 'WEB_REMIX', clientVersion: cfg('INNERTUBE_CLIENT_VERSION') || '1.20261011.16.00' },
    }));
    delete full.clickTracking;
    delete full.adSignalsInfo;
    if (full.request) delete full.request.consistencyTokenJars;
    // 그래도 400이 나면 꼭 필요한 값만 담아 한 번 더 보낸다.
    const minimal = {
      client: Object.fromEntries(['clientName', 'clientVersion', 'hl', 'gl', 'visitorData', 'platform', 'userAgent', 'timeZone']
        .filter((k) => full.client && full.client[k] !== undefined).map((k) => [k, full.client[k]])),
      user: full.user || {},
    };
    const headers = {
      'Content-Type': 'application/json',
      'X-Goog-AuthUser': String(cfg('SESSION_INDEX') ?? '0'),
      'X-Origin': location.origin,
      'X-Youtube-Client-Name': String(cfg('INNERTUBE_CONTEXT_CLIENT_NAME') ?? '67'),
      'X-Youtube-Client-Version': String(cfg("INNERTUBE_CLIENT_VERSION") ?? (full.client && full.client.clientVersion) ?? ""),
    };
    const visitor = cfg('VISITOR_DATA');
    if (visitor) headers['X-Goog-Visitor-Id'] = visitor;
    const pageId = cfg('DELEGATED_SESSION_ID');
    if (pageId) headers['X-Goog-PageId'] = pageId;

    const url = new URL(`/youtubei/v1/${endpoint}`, location.origin);
    url.searchParams.set('prettyPrint', 'false');
    for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, String(value));
    const send = async (context) => {
      const auth = await authorization();
      return fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: auth ? { ...headers, Authorization: auth } : headers,
        body: JSON.stringify({ ...body, context }),
      });
    };
    // 앱을 켠 직후 첫 요청이 400으로 실패하고 몇 초 뒤 같은 요청은 성공했다(2026-10-14 관찰,
    // 페이지가 로그인 쿠키를 새로 고치는 중으로 보임). 400이면 잠깐 기다렸다 다시 보낸다.
    let res = await send(full);
    if (res.status === 400) res = await send(minimal);
    for (const wait of [1200, 2500]) {
      if (res.status !== 400) break;
      await new Promise((resolve) => setTimeout(resolve, wait));
      res = await send(full);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`http_${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text);
  }

  function status() {
    return {
      ready: ON_MUSIC && !!cfg('INNERTUBE_CONTEXT'),
      host: location.hostname,
      path: location.pathname,
      loggedIn: ON_MUSIC ? cfg('LOGGED_IN') === true : false,
      subscriber: cfg('IS_SUBSCRIBER') === true,
    };
  }

  // ── 4. 재생 시작·대기열 ─────────────────────────────────────────────────
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function navigate({ endpoint }) {
    const root = app();
    if (!root) throw new Error('app_missing');
    if (!endpoint || typeof endpoint !== 'object') throw new Error('bad_endpoint');
    const before = readState().videoId;
    const beforeQueue = queueState();
    const beforeLen = beforeQueue && beforeQueue.items ? beforeQueue.items.length : 0;
    const target = endpoint.watchEndpoint && endpoint.watchEndpoint.videoId;
    root.dispatchEvent(new CustomEvent('yt-navigate', { bubbles: true, composed: true, detail: { endpoint } }));
    // 곡은 바로 바뀌지만 새 대기열(믹스·목록)은 조금 뒤에 채워진다. 그 사이 대기열은 비어 있다
    // (2026-10-14 재현: 이때 "바로 뒤에 넣기"가 끼어들어 2위 곡이 1위를 덮어씀). 그래서 대기열이 채워지고
    // 그 곡이 현재 곡으로 잡힐 때까지 기다린다. 또 YouTube Music이 곡을 멈춘 채 두는 경우가 있어
    // (직전 세션 대기열이 멈춘 채 복원돼 있을 때) 재생 중이 아니면 재생을 건다.
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      await sleep(250);
      const s = readState();
      const q = queueState();
      const queueReady = !!(q && q.items && q.items.length > 0 && q.selectedItemIndex >= 0);
      const arrived = target
        ? s.videoId === target && queueReady && selectedVideoIds().includes(target)
        : s.videoId && queueReady && (s.videoId !== before || q.items.length !== beforeLen);
      if (!arrived || s.duration <= 0) continue;
      if (!s.playing) {
        await sleep(500);
        if (!readState().playing) runHandler('play') || callPlayer('playVideo');
      }
      schedule();
      return true;
    }
    return false;
  }

  // ── 4.5 노래↔영상 ──────────────────────────────────────────────────────
  // YouTube Music 웹 플레이어의 [노래 | 동영상] 전환(<ytmusic-av-toggle>)을 그대로 누른다. 짝 버전 사이의 시간 대응
  // (예: 밤편지 뮤직비디오는 음원보다 24초 늦게 시작)은 YouTube Music이 맞춰 준다(2026-10-14 시험: 55초 → 83초).
  // 고른 쪽은 YouTube Music이 기억해 다음 곡에도 쓴다(playback-mode ATV_PREFERRED / OMV_PREFERRED).
  const avToggle = () => document.querySelector('ytmusic-av-toggle');

  async function avSwitch({ video }) {
    const t = avToggle();
    if (!t || !t.hasAttribute('selected-queue-item-has-counterpart')) throw new Error('no_counterpart');
    const want = !!video;
    const now = () => t.getAttribute('is-video-playback-mode-selected') === 'true';
    if (now() !== want) {
      const button = t.querySelector(want ? 'button.video-button' : 'button.song-button');
      if (!button) throw new Error('no_av_button');
      button.click();
      for (let i = 0; i < 40 && now() !== want; i++) await sleep(100);
    }
    schedule();
    return readState();
  }

  // 영상만 보이는 화면: 앱이 엔진 화면을 영상 창(데스크톱)이나 지금 재생 화면(iOS)에 띄울 때 쓴다.
  // 페이지의 나머지는 숨기고 플레이어만 --ytm-x/y/w/h 자리에 둔다. pip이면 화면 속 화면 버튼을 페이지 안에 둔다.
  // 배치(layout):
  // - fill: 화면 가득(예전 방식)
  // - window: 데스크톱 영상 창. 어두운 바탕 위에 영상을 조금 안쪽에 띄우고 둘레에 앰비언트 빛
  // - card: iOS 지금 재생. 바탕을 비워(앱 배경이 보이게) 표지와 같은 너비의 둥근 영상 + 앰비언트 빛
  // 앰비언트 빛은 YouTube '앰비언트 모드'처럼 영상 프레임을 작은 캔버스에 조금씩 겹쳐 그리고(장면이 바뀌어도
  // 번쩍이지 않게) 크게 흐려 영상 뒤에 깐다.
  const VIDEO_CSS = `
    html.ytm-app-video, html.ytm-app-video body { overflow: hidden !important; background: var(--ytm-bg, #000) !important; }
    /* 페이지 전부를 숨기고(YouTube Music이 visibility: visible을 직접 준 요소까지 — 2026-10-14 관찰: 상단 메뉴 막대,
       #player-bar-background, 목록 화면) 영상에 필요한 상자만 되살린다. 플레이어 안의 다른 덮개도 그대로 숨는다. */
    html.ytm-app-video body * { visibility: hidden !important; }
    html.ytm-app-video ytmusic-player#player,
    html.ytm-app-video ytmusic-player#player #song-video,
    html.ytm-app-video ytmusic-player#player .player-wrapper,
    html.ytm-app-video ytmusic-player#player #movie_player,
    html.ytm-app-video ytmusic-player#player .html5-video-container,
    html.ytm-app-video ytmusic-player#player video.html5-main-video { visibility: visible !important; }
    /* 접힌 재생 화면(ytmusic-player-page)은 transform으로 화면 아래에 밀려 있어(2026-10-14 관찰: translateY 748px)
       안의 fixed 요소가 그 상자를 기준으로 잡힌다. 영상 모드일 때만 변환을 풀고 맨 위로 올린다. */
    html.ytm-app-video ytmusic-player-page#player-page {
      transform: none !important; will-change: auto !important; z-index: 2147483646 !important; background: transparent !important;
    }
    html.ytm-app-video ytmusic-player#player {
      position: fixed !important; inset: auto !important;
      left: var(--ytm-x, 0px) !important; top: var(--ytm-y, 0px) !important;
      width: var(--ytm-w, 100vw) !important; height: var(--ytm-h, 100vh) !important;
      max-width: none !important; max-height: none !important; margin: 0 !important; padding: 0 !important;
      z-index: 2147483646 !important; background: #000 !important; display: block !important;
      visibility: visible !important; transform: none !important;
      border-radius: var(--ytm-r, 0px) !important; overflow: hidden !important;
      box-shadow: var(--ytm-shadow, none) !important;
      transition: top 0.45s ease, height 0.45s ease, left 0.45s ease, width 0.45s ease !important;
    }
    html.ytm-app-video ytmusic-player#player #song-image { display: none !important; }
    html.ytm-app-video ytmusic-player#player #song-video,
    html.ytm-app-video ytmusic-player#player .player-wrapper,
    html.ytm-app-video ytmusic-player#player #movie_player,
    html.ytm-app-video ytmusic-player#player .html5-video-container {
      display: block !important; position: absolute !important; inset: 0 !important;
      width: 100% !important; height: 100% !important; max-width: none !important; max-height: none !important;
      /* #song-video는 16:9 비율을 위쪽 여백(padding-top)으로 잡아 상자가 영상 아래로 늘어난다 */
      padding: 0 !important; margin: 0 !important; min-width: 0 !important; min-height: 0 !important;
    }
    html.ytm-app-video ytmusic-player#player video.html5-main-video {
      position: absolute !important; inset: 0 !important; width: 100% !important; height: 100% !important;
      left: 0 !important; top: 0 !important; object-fit: cover !important;
    }
    html.ytm-app-video ytmusic-player#player .ytp-chrome-top, html.ytm-app-video ytmusic-player#player .ytp-gradient-top,
    html.ytm-app-video ytmusic-player#player .ytp-overlays-container, html.ytm-app-video ytmusic-player#player .ytp-player-content,
    html.ytm-app-video ytmusic-player#player .ytp-iv-video-content, html.ytm-app-video ytmusic-player#player .ytp-cued-thumbnail-overlay,
    html.ytm-app-video ytmusic-player#player .ytp-bezel, html.ytm-app-video ytmusic-player#player .ytp-unmute,
    html.ytm-app-video ytmusic-player#player .ytp-spinner, html.ytm-app-video ytmusic-player#player .ytp-paid-content-overlay,
    html.ytm-app-video ytmusic-player#player .ytp-chrome-bottom, html.ytm-app-video ytmusic-player#player .ytp-gradient-bottom { display: none !important; }
    #ytm-app-ambient { display: none; }
    /* 빛은 영상 테두리를 따라 조금 넓게 깔고 흐린다(영상 모양 그대로, 과하지 않게). */
    html.ytm-app-video.ytm-app-glow #ytm-app-ambient {
      display: block; visibility: visible !important; position: fixed;
      left: calc(var(--ytm-x, 0px) - var(--ytm-spread, 16px)); top: calc(var(--ytm-y, 0px) - var(--ytm-spread, 16px));
      width: calc(var(--ytm-w, 100vw) + 2 * var(--ytm-spread, 16px)); height: calc(var(--ytm-h, 100vh) + 2 * var(--ytm-spread, 16px));
      border-radius: var(--ytm-r, 0px);
      z-index: 2147483645; pointer-events: none; opacity: var(--ytm-glow, 0.55);
      filter: blur(var(--ytm-blur, 20px)) saturate(1.3);
      transition: opacity 0.6s ease, top 0.45s ease, height 0.45s ease, left 0.45s ease, width 0.45s ease;
    }
    #ytm-app-pip { display: none; }
    html.ytm-app-video.ytm-app-pip #ytm-app-pip {
      display: grid; place-items: center; position: fixed; right: 14px; top: 14px; z-index: 2147483647;
      width: 52px; height: 52px; border-radius: 26px; border: 0; padding: 0; cursor: pointer; visibility: visible !important;
      background: rgba(0, 0, 0, 0.55); color: #fff; font: 600 13px/1 -apple-system, system-ui, sans-serif;
    }`;

  function ensureVideoStyle() {
    if (document.getElementById('ytm-app-video-style')) return;
    const style = document.createElement('style');
    style.id = 'ytm-app-video-style';
    style.textContent = VIDEO_CSS;
    (document.head || document.documentElement).appendChild(style);
    const pip = document.createElement('button');
    pip.id = 'ytm-app-pip';
    pip.type = 'button';
    pip.setAttribute('aria-label', '화면 속 화면');
    pip.textContent = 'PiP';
    pip.addEventListener('click', () => togglePip());
    (document.body || document.documentElement).appendChild(pip);
  }

  /** 화면 속 화면 켜고 끄기. 사용자 동작 안에서만 된다(페이지 단추, 또는 앱이 사용자 탭으로 부를 때). */
  function togglePip() {
    const v = document.querySelector('video');
    if (!v) throw new Error('no_video');
    if (typeof v.webkitSetPresentationMode === 'function') {
      const on = v.webkitPresentationMode !== 'picture-in-picture';
      v.webkitSetPresentationMode(on ? 'picture-in-picture' : 'inline');
      return { pip: on };
    }
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture();
      return { pip: false };
    }
    if (typeof v.requestPictureInPicture === 'function') {
      v.requestPictureInPicture().catch((err) => console.warn('[ytm-engine] 화면 속 화면 실패', err));
      return { pip: true };
    }
    throw new Error('pip_unsupported');
  }

  // 배치별 모양: 안쪽 여백(너비 비율), 모서리, 그림자, 바탕, 앰비언트 빛 세기·흐림
  const VIDEO_LAYOUTS = {
    fill: { inset: 0, radius: 0, shadow: null, bg: '#000', glow: 0 },
    window: { inset: 0.06, radius: 12, shadow: [0, 18, 50, 0.55], bg: '#060608', glow: 0.6, blur: 26, spread: 18 },
    card: { inset: 0.06, radius: 12, shadow: [0, 14, 34, 0.45], bg: 'transparent', glow: 0.55, blur: 20, spread: 14 },
  };
  const videoMode = {
    on: false, layout: VIDEO_LAYOUTS.fill, colors: false, timer: 0, canvas: null, ctx: null, primed: false, colorsAt: 0, blocked: false,
    // 검은 띠 감지: 위·아래 띠 비율(0~0.3)과 최근 표본, 어느 영상의 값인지
    bars: 0, barSamples: [], barSrc: '', probe: null, probeAt: 0,
  };

  /**
   * 영상 안에 박힌 위·아래 검은 띠 비율. 어두운 장면을 띠로 잘못 보지 않게 최근 약 4초(12번) 표본 중 가장 작은 값을 쓴다.
   * 다른 출처라 픽셀을 읽을 수 없으면 0.
   */
  function detectBars(v) {
    const now = Date.now();
    if (now - videoMode.probeAt < 300) return;
    videoMode.probeAt = now;
    const src = v.currentSrc || v.src || '';
    if (src !== videoMode.barSrc) {
      videoMode.barSrc = src;
      videoMode.barSamples = [];
      if (videoMode.bars) {
        videoMode.bars = 0;
        layoutVideo();
      }
    }
    if (!videoMode.probe) {
      const c = document.createElement('canvas');
      c.width = 64;
      c.height = 64;
      videoMode.probe = c.getContext('2d', { willReadFrequently: true });
    }
    const ctx = videoMode.probe;
    // 같은 프레임(멈춤)을 여러 번 세지 않는다 — 어두운 장면 하나를 띠로 잘못 보지 않게.
    if (!ctx || v.currentTime === videoMode.probeTime) return;
    videoMode.probeTime = v.currentTime;
    let data;
    try {
      ctx.drawImage(v, 0, 0, 64, 64);
      data = ctx.getImageData(0, 0, 64, 64).data;
    } catch {
      return;
    }
    const dark = (y) => {
      let sum = 0, max = 0;
      for (let x = 0; x < 64; x++) {
        const i = (y * 64 + x) * 4;
        const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        sum += l;
        if (l > max) max = l;
      }
      return sum / 64 < 14 && max < 40;
    };
    let top = 0;
    while (top < 20 && dark(top)) top++;
    let bottom = 0;
    while (bottom < 20 && dark(63 - bottom)) bottom++;
    // 전체가 어두운 장면(페이드 등)은 표본에서 뺀다.
    if (top >= 20 && bottom >= 20) return;
    videoMode.barSamples.push(Math.min(top, bottom) / 64);
    if (videoMode.barSamples.length > 12) videoMode.barSamples.shift();
    if (videoMode.barSamples.length < 3) return;
    let bars = Math.min(...videoMode.barSamples);
    bars = bars >= 0.04 ? Math.min(0.3, bars + 1 / 128) : 0;
    if (Math.abs(bars - videoMode.bars) > 0.012) {
      videoMode.bars = bars;
      layoutVideo();
    }
  }

  /** 플레이어 자리 계산: 영상 비율을 지키며 여백 안에 가운데로 */
  function layoutVideo() {
    if (!videoMode.on) return;
    const L = videoMode.layout;
    const root = document.documentElement;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const v = document.querySelector('video');
    // 영상 안에 검은 띠가 박혀 있으면(시네마 비율 뮤직비디오) 띠를 뺀 실제 화면 비율로 자리를 잡는다.
    const crop = videoMode.bars || 0;
    const aspect = v && v.videoWidth > 0 && v.videoHeight > 0 ? v.videoWidth / (v.videoHeight * (1 - 2 * crop)) : 16 / 9;
    let w = W * (1 - 2 * L.inset);
    let h = w / aspect;
    const maxH = H - (L.inset ? W * L.inset * 2 : 0);
    if (h > maxH) {
      h = maxH;
      w = h * aspect;
    }
    const px = (n) => `${Math.round(n)}px`;
    // iOS는 데스크톱 화면 모드라 페이지가 줄여 보인다(visualViewport.scale < 1). 모서리·그림자·흐림은 화면 크기 기준으로 맞춘다.
    const scale = (window.visualViewport && window.visualViewport.scale) || 1;
    const pt = (n) => px(n / scale);
    root.style.setProperty('--ytm-x', px((W - w) / 2));
    root.style.setProperty('--ytm-y', px((H - h) / 2));
    root.style.setProperty('--ytm-w', px(w));
    root.style.setProperty('--ytm-h', px(h));
    root.style.setProperty('--ytm-r', pt(L.radius));
    root.style.setProperty('--ytm-shadow', L.shadow ? `0 ${pt(L.shadow[1])} ${pt(L.shadow[2])} rgba(0,0,0,${L.shadow[3]})` : 'none');
    root.style.setProperty('--ytm-bg', L.bg);
    root.style.setProperty('--ytm-glow', String(L.glow));
    root.style.setProperty('--ytm-blur', pt(L.blur || 20));
    root.style.setProperty('--ytm-spread', pt(L.spread || 16));
  }

  /** 앰비언트 빛: 영상 프레임을 작은 캔버스에 18%씩 겹쳐 그린다(약 0.4초에 걸쳐 새 장면으로 바뀐다). */
  function ambientTick() {
    const v = document.querySelector('video');
    if (!videoMode.on || !v || !v.videoWidth || v.readyState < 2) return;
    detectBars(v);
    // 영상 비율이 바뀌면(4:3 뮤직비디오 등) 자리를 다시 잡는다.
    const aspect = v.videoWidth / v.videoHeight;
    if (Math.abs(aspect - (videoMode.aspect || 0)) > 0.01) {
      videoMode.aspect = aspect;
      layoutVideo();
    }
    if (!(videoMode.layout.glow > 0)) return;
    if (!videoMode.canvas) {
      const c = document.createElement('canvas');
      c.id = 'ytm-app-ambient';
      c.width = 48;
      c.height = 27;
      (document.body || document.documentElement).appendChild(c);
      videoMode.canvas = c;
      videoMode.ctx = c.getContext('2d', { willReadFrequently: true });
    }
    const ctx = videoMode.ctx;
    if (!ctx) return;
    ctx.globalAlpha = videoMode.primed ? 0.18 : 1;
    try {
      // 박힌 검은 띠는 빼고 그린다(빛이 띠 때문에 어두워지지 않게).
      const sy = Math.round(v.videoHeight * (videoMode.bars || 0));
      ctx.drawImage(v, 0, sy, v.videoWidth, v.videoHeight - 2 * sy, 0, 0, videoMode.canvas.width, videoMode.canvas.height);
      videoMode.primed = true;
    } catch {
      return;
    }
    // iOS 앱: 영상의 위·아래 평균색을 1.5초마다 알려 배경 그라데이션이 영상을 따라가게 한다.
    const now = Date.now();
    if (videoMode.colors && !videoMode.blocked && now - videoMode.colorsAt > 1500) {
      videoMode.colorsAt = now;
      try {
        const { width, height } = videoMode.canvas;
        const data = ctx.getImageData(0, 0, width, height).data;
        const avg = (y0, y1) => {
          let r = 0, g = 0, b = 0, n = 0;
          for (let y = y0; y < y1; y++) {
            for (let x = 0; x < width; x++) {
              const i = (y * width + x) * 4;
              r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
            }
          }
          return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
        };
        emit('ambient', { top: avg(0, height >> 1), bottom: avg(height >> 1, height) });
      } catch {
        // 다른 출처 영상이라 픽셀을 읽을 수 없으면 빛만 보이고 색은 알리지 않는다.
        videoMode.blocked = true;
      }
    }
  }

  /**
   * iOS: 화면을 가로로 돌렸다 오면 WebKit이 페이지 배율을 줄인 채 두는 일이 있어(영상이 아주 작아짐),
   * 배율을 1로 묶는다. 데스크톱(맥 WebKit)은 viewport를 쓰지 않는다.
   */
  function pinViewport() {
    if (!window.__ytmIpc || !document.head) return;
    let meta = document.querySelector('meta[name="viewport"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'viewport';
      document.head.appendChild(meta);
    }
    const content = 'width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no';
    if (meta.content !== content) meta.content = content;
  }

  function videoView({ on, pip, layout, inset, colors }) {
    ensureVideoStyle();
    pinViewport();
    const root = document.documentElement;
    videoMode.on = !!on;
    const base = VIDEO_LAYOUTS[layout] || VIDEO_LAYOUTS.fill;
    // 앱이 여백을 정해 주면(iOS: 표지와 같은 너비) 그대로 쓴다.
    videoMode.layout = typeof inset === 'number' && inset >= 0 && inset < 0.4 ? { ...base, inset } : base;
    videoMode.colors = !!colors;
    root.classList.toggle('ytm-app-video', !!on);
    root.classList.toggle('ytm-app-pip', !!on && !!pip);
    root.classList.toggle('ytm-app-glow', !!on && videoMode.layout.glow > 0);
    window.clearInterval(videoMode.timer);
    videoMode.timer = 0;
    if (on) {
      videoMode.aspect = 0;
      videoMode.primed = false;
      layoutVideo();
      // 빛이 없는 배치(fill)도 검은 띠 감지·비율 맞추기는 한다.
      videoMode.timer = window.setInterval(ambientTick, 66);
    }
    // 플레이어가 새 크기에 맞춰 화질·배치를 다시 잡게 한다.
    window.dispatchEvent(new Event('resize'));
    return { on: !!on };
  }
  window.addEventListener('resize', () => layoutVideo());

  // 대기열은 <ytmusic-player-queue>에 붙은 Redux 저장소가 관리한다(getState().queue: items, automixItems,
  // selectedItemIndex, nextQueueItemId, repeatMode). YouTube Music 자체의 "끼워 넣기"는
  // music/get_queue로 곡 데이터를 받아 ADD_ITEMS {nextQueueItemId, index, items, shouldAssignIds}를 보낸다(2026-10-14 분석).
  const queueEl = () => document.querySelector('ytmusic-player-queue');
  const queueState = () => {
    const el = queueEl();
    try {
      return el && typeof el.getState === 'function' ? el.getState().queue : null;
    } catch {
      return null;
    }
  };

  async function queueAdd({ videoId, videoIds, playlistId, position }) {
    const ids = Array.isArray(videoIds) ? videoIds.filter((v) => typeof v === 'string' && v).slice(0, 200) : [];
    if (videoId) ids.unshift(videoId);
    if (!ids.length && !playlistId) throw new Error('bad_target');
    const el = queueEl();
    let state = queueState();
    const empty = (q) => !q || !q.items || q.items.length === 0;
    // 곡은 올라와 있는데 대기열이 비었으면 새 대기열을 받는 중이다 — 채워질 때까지 잠깐(최대 5초) 기다린다.
    if (empty(state) && readState().videoId) {
      for (let i = 0; i < 25 && empty(state); i++) {
        await sleep(200);
        state = queueState();
      }
    }
    // 정말 빈 대기열(아무것도 재생한 적 없음)이면 넣을 곡을 바로 재생하고 나머지를 뒤에 붙인다.
    if (!el || empty(state)) {
      if (!ids.length) return navigate({ endpoint: { watchPlaylistEndpoint: { playlistId } } });
      await navigate({ endpoint: { watchEndpoint: { videoId: ids[0] } } });
      return ids.length > 1 ? queueAdd({ videoIds: ids.slice(1), position }) : true;
    }
    // 여러 곡도 한 번에 받는다(순서 유지).
    const res = await api({ endpoint: 'music/get_queue', body: ids.length ? { videoIds: ids } : { playlistId } });
    const items = (res.queueDatas || []).map((d) => d && d.content).filter(Boolean);
    if (!items.length) throw new Error('queue_empty_response');
    const fresh = queueState() || state;
    const index = position === 'end'
      ? fresh.items.length
      : Math.min(fresh.items.length, Math.max(0, fresh.selectedItemIndex) + 1);
    el.dispatch({ type: 'ADD_ITEMS', payload: { nextQueueItemId: fresh.nextQueueItemId, index, items, shouldAssignIds: true } });
    schedule();
    return { added: items.length, index };
  }

  /** 대기열에서 현재 선택된 항목의 videoId들(음원/영상 짝이면 둘 다) */
  function selectedVideoIds() {
    const q = queueState();
    const item = q && q.items && q.items[q.selectedItemIndex];
    if (!item) return [];
    const w = item.playlistPanelVideoWrapperRenderer;
    const ids = [];
    const add = (r) => r && r.playlistPanelVideoRenderer && ids.push(r.playlistPanelVideoRenderer.videoId);
    if (w) {
      add(w.primaryRenderer);
      for (const c of w.counterpart || []) add(c && c.counterpartRenderer);
    } else {
      add(item);
    }
    return ids;
  }

  // 대기열 항목의 renderer(음원/영상 짝이면 지금 보이는 쪽)에서 화면에 필요한 값만 꺼낸다.
  const QUEUE_FIELDS = ['videoId', 'title', 'longBylineText', 'shortBylineText', 'lengthText', 'thumbnail', 'navigationEndpoint', 'playlistSetVideoId'];
  function slimItem(item) {
    const wrapper = item && item.playlistPanelVideoWrapperRenderer;
    const r = wrapper
      ? (wrapper.primaryRenderer && wrapper.primaryRenderer.playlistPanelVideoRenderer)
      : item && (item.playlistPanelVideoRenderer || item.automixPreviewVideoRenderer && item.automixPreviewVideoRenderer.content && item.automixPreviewVideoRenderer.content.automixPlaylistVideoRenderer);
    if (!r || !r.videoId) return null;
    const data = {};
    for (const key of QUEUE_FIELDS) if (r[key] !== undefined) data[key] = r[key];
    return data;
  }

  function readQueue() {
    const state = queueState();
    if (!state) return { items: [], automix: [], selected: -1 };
    const items = (state.items || []).map(slimItem);
    return {
      // 자리 번호가 queueJump와 맞아야 하므로 못 읽은 항목도 null로 남긴다.
      items,
      automix: (state.automixItems || []).map(slimItem).filter(Boolean),
      selected: typeof state.selectedItemIndex === 'number' ? state.selectedItemIndex : -1,
    };
  }

  // 대기열의 곡으로 건너뛰기: 저장소 위치(SET_INDEX)를 바꾸면 플레이어가 그 곡을 처음부터 재생한다(2026-10-14 시험).
  function queueJump({ index }) {
    const el = queueEl();
    const state = queueState();
    const i = Number(index);
    if (!el || !state || !state.items || !state.items[i]) throw new Error('no_queue_item');
    el.dispatch({ type: 'SET_INDEX', payload: i });
    schedule();
    return true;
  }

  // ── 5. 현재 곡 상태 ────────────────────────────────────────────────────
  const largestArtwork = (list) => {
    let best = '';
    let bestArea = -1;
    for (const item of Array.isArray(list) ? list : []) {
      if (!item || !/^https:\/\//.test(item.src || '')) continue;
      const [w, h] = String(item.sizes || '').split('x').map(Number);
      const area = (w || 0) * (h || 0);
      if (area > bestArea) {
        best = item.src;
        bestArea = area;
      }
    }
    return best;
  };

  function readState() {
    const p = player();
    const meta = session.metadata;
    const data = call(p, 'getVideoData') || {};
    const video = document.querySelector('video');
    // 플레이어 상태: -1 시작 전, 0 끝남, 1 재생, 2 일시정지, 3 버퍼링, 5 대기
    const code = call(p, 'getPlayerState');
    let playing;
    if (code === 1 || code === 3) playing = true;
    else if (code === 0 || code === 2 || code === 5) playing = false;
    else playing = session.playbackState === 'playing' || (!!video && !video.paused && !video.ended);

    let artwork = largestArtwork(meta && meta.artwork);
    if (!artwork) {
      const img = document.querySelector('ytmusic-player-bar img.image');
      if (img && /^https:\/\//.test(img.src)) artwork = img.src;
    }
    if (!artwork && data.video_id) artwork = `https://i.ytimg.com/vi/${data.video_id}/hqdefault.jpg`;

    const b = bar();
    const likeEl = b && b.querySelector('ytmusic-like-button-renderer');
    const qs = queueState();
    let store = null;
    try {
      store = queueEl() && queueEl().getState();
    } catch {
      store = null;
    }
    const repeatAttr = (qs && qs.repeatMode) || (b && b.getAttribute('repeat-mode'));
    const av = avToggle();
    const pair = av && av.hasAttribute('selected-queue-item-has-counterpart') ? avPair(String(data.video_id || '')) : null;
    return {
      videoId: String(data.video_id || ''),
      title: String((meta && meta.title) || data.title || ''),
      artist: String((meta && meta.artist) || data.author || ''),
      album: String((meta && meta.album) || ''),
      artwork,
      duration: finite(call(p, 'getDuration'), finite(video && video.duration, 0)),
      position: finite(call(p, 'getCurrentTime'), finite(video && video.currentTime, 0)),
      playing,
      buffering: code === 3,
      ad: !!(store && store.player && store.player.adPlaying) || !!(p && p.classList && p.classList.contains('ad-showing')),
      likeStatus: (likeEl && likeEl.getAttribute('like-status')) || 'INDIFFERENT',
      repeat: repeatAttr || 'NONE',
      volume: finite(call(p, 'getVolume'), 100),
      muted: call(p, 'isMuted') === true,
      // 노래(음원)↔영상(뮤직비디오) 짝이 있는지, 지금 영상 쪽인지, 실제 화면(영상 프레임)이 나오는지
      avAvailable: !!(av && av.hasAttribute('selected-queue-item-has-counterpart')),
      avVideo: !!(av && av.getAttribute('is-video-playback-mode-selected') === 'true'),
      hasPicture: !!(video && video.videoWidth > 0),
      // 짝 버전 videoId와 시간 차이(짝 버전 위치 = 지금 위치 + avShift초). 가사를 바꿔 부르지 않고 옮겨 쓴다.
      avOther: pair ? pair.other : '',
      avShift: pair ? pair.shift : 0,
      at: Date.now(),
    };
  }

  /**
   * 대기열 항목 playlistPanelVideoWrapperRenderer: primaryRenderer(지금 항목) + counterpart[0](짝 버전과 segmentMap).
   * 2026-10-14 밤편지: 음원 6744glqD6lk ↔ 뮤직비디오 BzYnNdJhZQw, counterpartVideoStartTimeMilliseconds 24015.
   */
  function avPair(videoId) {
    const q = queueState();
    if (!videoId || !q || !Array.isArray(q.items)) return null;
    for (const item of q.items) {
      const w = item && item.playlistPanelVideoWrapperRenderer;
      const primary = w && w.primaryRenderer && w.primaryRenderer.playlistPanelVideoRenderer;
      const c = w && Array.isArray(w.counterpart) ? w.counterpart[0] : null;
      const counter = c && c.counterpartRenderer && c.counterpartRenderer.playlistPanelVideoRenderer;
      if (!primary || !counter) continue;
      const seg = c.segmentMap && Array.isArray(c.segmentMap.segment) ? c.segmentMap.segment[0] : null;
      let diff = seg ? (Number(seg.counterpartVideoStartTimeMilliseconds) - Number(seg.primaryVideoStartTimeMilliseconds)) / 1000 : 0;
      if (!Number.isFinite(diff)) diff = 0;
      if (primary.videoId === videoId) return { other: String(counter.videoId || ''), shift: diff };
      if (counter.videoId === videoId) return { other: String(primary.videoId || ''), shift: -diff };
    }
    return null;
  }

  // ── 6. 상태 보고 (바뀐 것이 있을 때만) ─────────────────────────────────
  let last = null;
  let lastKey = '';
  let lastSentAt = 0;
  let pending = 0;

  function report() {
    if (!ON_MUSIC) return;
    const state = readState();
    const now = state.at;
    const key = [state.videoId, state.title, state.artist, state.album, state.artwork, state.playing,
      state.buffering, state.ad, Math.round(state.duration), state.likeStatus, state.repeat,
      Math.round(state.volume), state.muted, state.avAvailable, state.avVideo, state.hasPicture, state.avOther].join('\u0001');
    if (last && key === lastKey) {
      // 위치가 예상과 1초 넘게 어긋나면(탐색·버퍼링) 바로, 아니면 5초마다 보정값을 보낸다.
      const expected = last.position + (last.playing ? (now - lastSentAt) / 1000 : 0);
      if (Math.abs(state.position - expected) < 1 && now - lastSentAt < 5000) return;
    }
    last = state;
    lastKey = key;
    lastSentAt = now;
    emit('state', state);
  }

  function schedule() {
    clearTimeout(pending);
    pending = setTimeout(report, 100);
  }

  // ── 7. 재생 제어 ───────────────────────────────────────────────────────
  const clickBar = (selector) => {
    const b = bar();
    const el = b && b.querySelector(selector);
    if (!el || el.hidden || el.hasAttribute('disabled')) return false;
    el.click();
    return true;
  };
  const runHandler = (action, details) => {
    const handler = session.handlers[action];
    if (!handler) return false;
    try {
      handler({ action, ...details });
      return true;
    } catch (err) {
      console.warn('[ytm-engine] 동작 실패', action, err);
      return false;
    }
  };
  const callPlayer = (method, ...args) => {
    const p = player();
    if (!p || typeof p[method] !== 'function') return false;
    p[method](...args);
    return true;
  };

  function control(command, value) {
    const playing = readState().playing;
    let done = true;
    switch (command) {
      case 'play':
        if (!playing) done = runHandler('play') || clickBar('#play-pause-button') || callPlayer('playVideo');
        break;
      case 'pause':
        if (playing) done = runHandler('pause') || clickBar('#play-pause-button') || callPlayer('pauseVideo');
        break;
      case 'toggle':
        return control(playing ? 'pause' : 'play');
      case 'next':
        // 대기열은 YouTube Music 화면이 관리하므로 사용자가 누르는 버튼을 먼저 쓴다.
        done = clickBar('.next-button') || runHandler('nexttrack') || callPlayer('nextVideo');
        break;
      case 'previous':
        done = clickBar('.previous-button') || runHandler('previoustrack') || callPlayer('previousVideo');
        break;
      case 'seek': {
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds < 0) throw new Error('bad_value');
        done = runHandler('seekto', { seekTime: seconds }) || callPlayer('seekTo', seconds, true);
        break;
      }
      case 'seekBy': {
        const delta = Number(value);
        if (!Number.isFinite(delta)) throw new Error('bad_value');
        return control('seek', Math.max(0, readState().position + delta));
      }
      case 'volume': {
        const volume = Math.round(Math.min(100, Math.max(0, Number(value))));
        if (!Number.isFinite(volume)) throw new Error('bad_value');
        done = callPlayer('setVolume', volume);
        if (volume > 0) callPlayer('unMute');
        break;
      }
      case 'volumeBy': {
        // 전역 음량 단축키: 지금 들리는 음량(음소거면 0)에서 더하거나 뺀다.
        const delta = Number(value);
        if (!Number.isFinite(delta)) throw new Error('bad_value');
        const s = readState();
        return control('volume', (s.muted ? 0 : s.volume) + delta);
      }
      case 'mute':
        done = callPlayer('mute');
        break;
      case 'unmute':
        done = callPlayer('unMute');
        break;
      case 'repeat':
        done = clickBar('.repeat');
        break;
      case 'shuffle':
        done = clickBar('.shuffle');
        break;
      case 'like':
        done = clickBar('ytmusic-like-button-renderer #button-shape-like button') ||
          clickBar('ytmusic-like-button-renderer .like');
        break;
      case 'dislike':
        done = clickBar('ytmusic-like-button-renderer #button-shape-dislike button') ||
          clickBar('ytmusic-like-button-renderer .dislike');
        break;
      default:
        throw new Error(`unknown_command ${command}`);
    }
    schedule();
    return done;
  }

  // ── 7.5 이퀄라이저·스펙트럼 ─────────────────────────────────────────────
  // 플레이어 <video>의 소리를 Web Audio로 받아 프리앰프 → 10밴드 필터 → 분석기 → 출력으로 보낸다.
  // createMediaElementSource는 한 번 연결하면 되돌릴 수 없어서, EQ나 시각화를 켤 때만 연결하고
  // 연결 직후 소리가 실제로 흐르는지 확인한다(안 흐르면 화면에 알려 페이지를 다시 불러온다).
  const EQ_BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const SPECTRUM_BARS = 48;
  const eq = {
    ctx: null, video: null, source: null, preamp: null, filters: [], analyser: null, bins: null,
    settings: { enabled: false, gains: EQ_BANDS.map(() => 0), preamp: 0 },
    streamUntil: 0, timer: 0, hookedAt: 0, heardSound: false, failed: false,
  };
  const mediaElement = () => (player() && player().querySelector('video')) || document.querySelector('video');
  const dbToGain = (db) => Math.pow(10, db / 20);
  const clampDb = (v) => Math.max(-12, Math.min(12, Number(v) || 0));

  async function ensureGraph() {
    if (eq.failed) throw new Error('eq_unsupported');
    const video = mediaElement();
    if (!video) throw new Error('no_media');
    if (eq.ctx && eq.video === video) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('no_webaudio');
    const ctx = eq.ctx || new Ctx({ latencyHint: 'playback' });
    if (ctx.state !== 'running') {
      // 사용자 동작 없이 부른 resume이 끝나지 않는 웹뷰도 있어 2초만 기다린다.
      try { await Promise.race([ctx.resume(), sleep(2000)]); } catch { /* 아래에서 상태로 판단 */ }
    }
    eq.ctx = ctx;
    // 멈춘 오디오 장치에 연결하면 소리가 끊기므로, 돌아가는 것을 확인한 뒤에만 연결한다.
    if (ctx.state !== 'running') throw new Error('audio_context_suspended');
    const preamp = ctx.createGain();
    const filters = EQ_BANDS.map((freq, i) => {
      const f = ctx.createBiquadFilter();
      f.type = i === 0 ? 'lowshelf' : i === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking';
      f.frequency.value = freq;
      f.Q.value = 1.05;
      f.gain.value = 0;
      return f;
    });
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.72;
    // 맥 탭(mac_tap.rs spectrum)과 같은 눈금: 0~255 = −100~−10dB(기본 −30dB 위는 잘려 저음이 늘 끝까지 찼다)
    analyser.minDecibels = -100;
    analyser.maxDecibels = -10;
    const source = ctx.createMediaElementSource(video);
    source.connect(preamp);
    let node = preamp;
    for (const f of filters) { node.connect(f); node = f; }
    node.connect(analyser);
    analyser.connect(ctx.destination);
    Object.assign(eq, { ctx, video, source, preamp, filters, analyser, bins: new Uint8Array(analyser.frequencyBinCount), hookedAt: Date.now(), heardSound: false });
    applyEqSettings();
    startEqTimer();
  }

  function applyEqSettings() {
    if (!eq.ctx) return;
    const { enabled, gains, preamp } = eq.settings;
    const t = eq.ctx.currentTime;
    eq.filters.forEach((f, i) => f.gain.setTargetAtTime(enabled ? clampDb(gains[i]) : 0, t, 0.03));
    eq.preamp.gain.setTargetAtTime(enabled ? dbToGain(clampDb(preamp)) : 1, t, 0.03);
  }

  async function setEq({ enabled, gains, preamp }) {
    eq.settings = {
      enabled: !!enabled,
      gains: EQ_BANDS.map((_, i) => clampDb(Array.isArray(gains) ? gains[i] : 0)),
      preamp: clampDb(preamp),
    };
    // 꺼져 있고 아직 연결 전이면 연결하지 않는다(원래 소리 경로 그대로).
    if (eq.settings.enabled) await ensureGraph();
    else applyEqSettings();
    return { bands: EQ_BANDS, hooked: !!eq.ctx, sampleRate: eq.ctx ? eq.ctx.sampleRate : null };
  }

  /** 화면이 스펙트럼을 보는 동안 주기적으로 불러 준다(안 부르면 몇 초 뒤 보내기를 멈춘다). */
  async function eqStream({ on }) {
    if (!on) {
      eq.streamUntil = 0;
      return { hooked: !!eq.ctx };
    }
    await ensureGraph();
    eq.streamUntil = Date.now() + 8000;
    return { hooked: true, bands: EQ_BANDS };
  }

  function spectrumBars() {
    const { analyser, bins, ctx } = eq;
    analyser.getByteFrequencyData(bins);
    const nyquist = ctx.sampleRate / 2;
    const lo = Math.log10(30);
    const hi = Math.log10(16000);
    const out = new Array(SPECTRUM_BARS);
    let energy = 0;
    for (let b = 0; b < SPECTRUM_BARS; b++) {
      const f0 = Math.pow(10, lo + ((hi - lo) * b) / SPECTRUM_BARS);
      const f1 = Math.pow(10, lo + ((hi - lo) * (b + 1)) / SPECTRUM_BARS);
      const i0 = Math.max(0, Math.floor((f0 / nyquist) * bins.length));
      const i1 = Math.min(bins.length - 1, Math.max(i0, Math.ceil((f1 / nyquist) * bins.length)));
      let m = 0;
      for (let i = i0; i <= i1; i++) if (bins[i] > m) m = bins[i];
      out[b] = m;
      energy += m;
    }
    return { out, energy };
  }

  function startEqTimer() {
    if (eq.timer) return;
    // 숨은 창에서는 requestAnimationFrame이 돌지 않아 타이머를 쓴다(창 절전은 꺼 둠).
    eq.timer = setInterval(() => {
      if (!eq.analyser) return;
      const video = eq.video;
      const now = Date.now();
      const playing = video && !video.paused && !video.ended && !video.muted && video.volume > 0;
      const streaming = now < eq.streamUntil && playing;
      // 소리가 흐르는 것을 확인한 뒤에는 화면이 스펙트럼을 보고 있을 때만 계산한다.
      if (eq.heardSound && !streaming) return;
      const { out, energy } = spectrumBars();
      if (energy > 0) eq.heardSound = true;
      // 연결 후 3~8초 동안 재생 중인데 신호가 전혀 없으면 이 웹뷰에서는 연결이 소리를 끊은 것으로 본다.
      if (!eq.heardSound && playing && now - eq.hookedAt > 3000 && video.currentTime > 2) {
        eq.failed = true;
        clearInterval(eq.timer);
        eq.timer = 0;
        emit('eq', { failed: 'webaudio' });
        return;
      }
      if (streaming) emit('spectrum', out);
    }, 40);
  }

  // ── 7.6 자리 비움 확인("계속 들으시겠습니까?") ─────────────────────────────
  // YouTube Music은 마지막 사용자 입력 시각(window._lact, 키·마우스·터치·스크롤 때 갱신)으로 자리를 비웠는지 본다
  // (2026-10-16 분석, WEB_REMIX 1.20261013.15.00):
  // - 플레이어는 /player 요청에 lactMilliseconds = Date.now() - _lact를 보낸다.
  // - 응답의 youThereRenderer(configData.youThereData)가 오면 곡의 promptDelaySec 지점에서
  //   Date.now() - _lact ≥ lactThresholdMs인지 보고, 넘었으면 알림을 띄운 뒤 playbackPauseDelayMs 뒤에
  //   <ytmusic-you-there-renderer> 확인창을 열어 재생을 멈춘다. 확인창이 닫히면 다시 재생한다.
  // 앱은 이 숨은 창을 직접 만지지 않아서(화면은 main 창) 앱을 계속 쓰는 중에도 _lact가 페이지를 연 시각에 머문다.
  // 그래서 앱이 살아 있는 동안 활동 시각을 이어서 갱신하고, 그래도 확인창이 뜨면 대신 확인을 눌러 재생을 잇는다.
  const ACTIVE_EVERY_MS = 30000;
  const idle = { lastMark: 0, confirmed: 0, confirmedAt: 0, resumeTimer: 0 };

  /**
   * 사용자가 움직인 것처럼 활동 시각을 갱신한다(YouTube Music의 입력 처리와 같은 일: _lact + 활동 알림).
   * 앱 요청(handle)마다 앞에서 부르므로 어떤 경우에도 예외를 밖으로 내보내지 않는다(요청이 멈추지 않게).
   */
  function markActive(force) {
    try {
      const now = Date.now();
      if (!force && now - idle.lastMark < ACTIVE_EVERY_MS) return;
      // 아직 YouTube Music이 활동 추적을 시작하지 않았으면(_lact 없음) 건드리지 않는다.
      // 먼저 값을 넣으면 YouTube Music이 입력 감시를 붙이지 않는다(웹 화면을 열었을 때 직접 쓰는 입력이 안 잡힌다).
      if (typeof window._lact !== 'number') return;
      idle.lastMark = now;
      window._lact = now;
      // 알림이 떠 있는 동안 이 신호가 오면 YouTube Music이 확인창 예약을 취소한다.
      const notify = window.ytglobal && window.ytglobal.ytUtilActivityCallback_;
      if (typeof notify === 'function') notify();
    } catch (err) {
      console.warn('[ytm-engine] 활동 시각 갱신 실패', err);
    }
  }

  /** 열려 있는 자리 비움 확인창이 있으면 "예"를 누른다. 누르면 true. */
  function confirmYouThere() {
    const renderer = document.querySelector('ytmusic-you-there-renderer');
    if (!renderer) return false;
    const dialog = renderer.closest('tp-yt-paper-dialog');
    const open = dialog
      ? dialog.opened === true || (dialog.style.display !== 'none' && dialog.getAttribute('aria-hidden') !== 'true')
      : renderer.getClientRects().length > 0;
    // 방금 누른 창이 닫히는 중이면 다시 누르지 않는다.
    if (!open || Date.now() - idle.confirmedAt < 3000) return false;
    idle.confirmedAt = Date.now();
    markActive(true);
    const confirm = renderer.querySelector('[dialog-confirm]');
    const button = (confirm && confirm.querySelector('button')) || confirm || renderer.querySelector('button');
    if (button) button.click();
    // 확인 단추를 찾지 못했거나 눌러도 닫히지 않으면 창을 직접 닫는다(닫히면 YouTube Music이 재생을 다시 건다).
    setTimeout(() => {
      if (dialog && dialog.opened === true && typeof dialog.close === 'function') dialog.close();
    }, 400);
    idle.confirmed += 1;
    console.warn('[ytm-engine] 자리 비움 확인창을 대신 확인했습니다');
    // 확인창은 재생 중일 때만 뜨므로, 닫은 뒤에도 멈춰 있으면 이어서 재생한다.
    clearTimeout(idle.resumeTimer);
    idle.resumeTimer = setTimeout(() => {
      if (!readState().playing) runHandler('play') || callPlayer('playVideo');
      schedule();
    }, 1500);
    return true;
  }

  function watchIdle() {
    markActive(false);
    try {
      confirmYouThere();
    } catch (err) {
      console.warn('[ytm-engine] 자리 비움 확인창 처리 실패', err);
    }
  }

  // ── 8. 앱 화면 요청 처리 ───────────────────────────────────────────────
  const methods = {
    api,
    status,
    state: () => readState(),
    play: navigate,
    queueAdd,
    queue: () => readQueue(),
    queueJump,
    control: ({ command, value }) => control(command, value),
    eq: setEq,
    eqStream,
    avSwitch,
    videoView,
    pip: () => togglePip(),
  };

  async function handle(id, method, args) {
    // 앱에서 온 요청은 사용자가 앱을 쓰고 있다는 뜻이다(재생·검색 등). 활동 시각을 이어 준다(30초에 한 번).
    markActive(false);
    try {
      const fn = methods[method];
      if (!fn) throw new Error(`unknown_method ${method}`);
      const data = await fn(args || {});
      const value = data === undefined ? null : data;
      // 데스크톱은 답을 JSON 글 하나로 보낸다. 앱(engine.rs)이 큰 응답을 값으로 풀었다 다시 묶지 않고 그대로 화면에 넘긴다.
      // iOS 앱(Engine.swift)은 지금처럼 값을 받는다.
      const reply = window.__ytmIpc ? { id, ok: true, data: value } : { id, ok: true, json: JSON.stringify(value) };
      await invoke('engine_reply', { reply });
    } catch (err) {
      const error = err && err.message ? err.message : String(err);
      invoke('engine_reply', { reply: { id, ok: false, error } }).catch((e) =>
        console.warn('[ytm-engine] 응답 전달 실패', e));
    }
  }

  Object.defineProperty(window, '__ytmEngine', {
    value: Object.freeze({ handle, control }),
    configurable: false,
    writable: false,
  });

  // ── 9. 시작 ────────────────────────────────────────────────────────────
  for (const type of ['play', 'playing', 'pause', 'ended', 'seeked', 'durationchange', 'loadedmetadata', 'emptied', 'volumechange', 'waiting']) {
    document.addEventListener(type, schedule, true);
  }
  setInterval(report, 1000);
  if (ON_MUSIC) setInterval(watchIdle, 1000);

  function announce() {
    emit('status', status());
    schedule();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', announce);
  else announce();
  window.addEventListener('load', announce);

  // 플레이어 바 속성(좋아요·반복)이 바뀌면 바로 보고한다.
  const watchBar = () => {
    const b = bar();
    if (!b) return false;
    new MutationObserver(schedule).observe(b, { attributes: true, subtree: true, attributeFilter: ['like-status', 'repeat-mode'] });
    return true;
  };
  if (ON_MUSIC) {
    const timer = setInterval(() => { if (watchBar()) clearInterval(timer); }, 1000);
  }

  // ── 10. youtube.com(로그인 전 안내 페이지 등)에서 돌아가는 길 ───────────
  if (ON_MUSIC) return;

  function addReturnBar() {
    if (!document.body || document.getElementById('ytm-desktop-return')) return;
    const host = document.createElement('div');
    host.id = 'ytm-desktop-return';
    host.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    const signedOut = cfg('LOGGED_IN') === false;
    // youtube.com은 Trusted Types 정책이라 innerHTML에 문자열을 넣으면 막힌다 → 요소를 직접 만든다.
    const style = document.createElement('style');
    style.textContent = `
      .bar { display:flex; gap:8px; font:600 13px/1 system-ui, -apple-system, "Segoe UI", sans-serif; }
      a { display:inline-flex; align-items:center; height:36px; padding:0 14px; border-radius:18px;
          text-decoration:none; color:#fff; background:#212121; box-shadow:0 2px 10px rgba(0,0,0,.35); }
      a.primary { background:#c13584; }
      a:hover { filter:brightness(1.15); }`;
    const wrap = document.createElement('div');
    wrap.className = 'bar';
    const link = (text, href, primary) => {
      const a = document.createElement('a');
      a.textContent = text;
      a.href = href;
      if (primary) a.className = 'primary';
      wrap.appendChild(a);
    };
    if (signedOut) link('로그인', SIGNIN_URL, true);
    link('YouTube Music으로 돌아가기', 'https://music.youtube.com/', false);
    root.append(style, wrap);
    document.body.appendChild(host);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addReturnBar);
  else addReturnBar();
  setInterval(addReturnBar, 3000);
})();
