// 미니 플레이어 창(index.html#mini): 늘 위에 떠 있는 작은 재생기. 큰 창과 같은 엔진 상태를 받아 그린다.
// 표지 오른쪽에 지금 부르는 가사 두 줄(지금 줄·다음 줄)이 작게 나오고(가사 단추로 끄고 켬), 다음 트랙 단추를 누르면 창이 아래로 늘어나
// 다음 곡 목록이 나온다(펼친 동안은 세로 길이를 마우스로 늘이고 줄인다). 진행 막대는 눌러서·끌어서 옮긴다.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { currentMonitor, getCurrentWindow, LogicalSize, PhysicalPosition } from '@tauri-apps/api/window';
import { t } from '../i18n';
import { useLang } from '../i18n/react';
import * as ytm from '../lib/ytm/client';
import { miniPin } from '../lib/tauri';
import { useSoftArt } from '../lib/softArt';
import { startAlbumTheme } from '../lib/theme';
import { startLibrarySync, toggleLike, useLiked } from '../state/library';
import { useTrackLyrics } from '../state/lyrics';
import { activeLine } from '../lib/lyrics';
import { patchPlayer, playerStore, startPlayerSync, usePlayer, usePositionSelect } from '../state/player';
import { toastError } from '../state/ui';
import { Toasts } from './ContextMenu';
import { Cover } from './Cover';
import { Icon } from './Icon';
import { TrackItem, useQueue } from './QueuePanel';
import { TooltipHost } from './Tooltip';
import { useSeekBar } from './useSeekBar';
import { playTrack } from '../state/library';

const run = (p: Promise<unknown>, what: string) => p.catch((err) => toastError(err, what));

/** 창 크기(논리 픽셀). 아래 칸을 펼치면 아래로 늘어난다. src-tauri/src/desktop.rs의 처음 크기와 같게. */
const MINI_WIDTH = 380;
const MINI_HEIGHT = 152;
const MINI_OPEN_HEIGHT = 372;
/** 다음 트랙을 펼쳤을 때 가장 낮은 높이(목록 두세 곡) */
const MINI_OPEN_MIN = 250;
const QUEUE_KEY = 'ytm-desktop:mini-queue';
const HEIGHT_KEY = 'ytm-desktop:mini-queue-height';
const LYRICS_KEY = 'ytm-desktop:mini-lyrics';

function loadFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

function saveFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch {
    // 저장하지 못해도 이번에는 바뀐다.
  }
}

/** 펼쳤을 때 사용자가 마지막으로 맞춘 높이 */
function loadOpenHeight(): number {
  try {
    const v = Number(localStorage.getItem(HEIGHT_KEY));
    return v >= MINI_OPEN_MIN ? v : MINI_OPEN_HEIGHT;
  } catch {
    return MINI_OPEN_HEIGHT;
  }
}

/**
 * 창 높이를 맞춘다. 접으면 높이를 고정하고, 펼치면 세로로만 늘이고 줄일 수 있게 하며(너비는 그대로)
 * 마지막으로 맞춘 높이로 연다. 늘린 창이 화면(작업 영역) 아래로 넘치면 위로 올린다.
 */
async function fitWindow(open: boolean) {
  const win = getCurrentWindow();
  if (!open) {
    await win.setResizable(false);
    await win.setMinSize(null);
    await win.setMaxSize(null);
    await win.setSize(new LogicalSize(MINI_WIDTH, MINI_HEIGHT));
    return;
  }
  const monitor = await currentMonitor();
  // 작업 영역 높이에서 창 테두리·제목 막대 몫을 조금 남긴다.
  const maxHeight = monitor ? Math.max(MINI_OPEN_MIN, Math.floor(monitor.workArea.size.height / monitor.scaleFactor) - 40) : 1200;
  await win.setMinSize(new LogicalSize(MINI_WIDTH, MINI_OPEN_MIN));
  await win.setMaxSize(new LogicalSize(MINI_WIDTH, maxHeight));
  await win.setSize(new LogicalSize(MINI_WIDTH, Math.min(loadOpenHeight(), maxHeight)));
  await win.setResizable(true);
  const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
  if (!monitor) return;
  const top = monitor.workArea.position.y;
  const bottom = top + monitor.workArea.size.height;
  if (pos.y + size.height > bottom) await win.setPosition(new PhysicalPosition(pos.x, Math.max(top, bottom - size.height)));
}

/** 진행 막대: 누르거나 끌어서 옮긴다(가리키면 굵어지고 손잡이가 나온다). 동작은 useSeekBar. */
function MiniSeek() {
  const seek = useSeekBar();
  return (
    <div
      {...seek.props}
      className={`mini-seek${seek.dragging ? ' is-dragging' : ''}${seek.disabled ? ' is-disabled' : ''}`}
      style={{ '--fill': `${seek.fill * 100}%` } as CSSProperties}
    >
      <span className="mini-seek__track">
        <span className="mini-seek__fill" />
      </span>
      <span className="mini-seek__knob" />
    </div>
  );
}

/**
 * 목록 아래 손잡이: 끌어서 창 세로 길이를 바꾼다(창 아래 가장자리를 끌어도 된다).
 * 맥은 창 크기 끌기 시작(startResizeDragging)을 지원하지 않아 움직인 만큼 직접 창 크기를 바꾼다.
 */
function ResizeGrip() {
  const start = useRef<{ y: number; height: number; max: number } | null>(null);
  const frame = useRef(0);
  const end = () => {
    start.current = null;
    cancelAnimationFrame(frame.current);
  };
  return (
    <div
      className="mini-queue__grip"
      aria-hidden="true"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // 포인터를 잡지 못하면 창 밖으로 나갔을 때 멈출 뿐이다.
        }
        start.current = { y: e.screenY, height: window.innerHeight, max: Math.max(MINI_OPEN_MIN, (window.screen.availHeight || 1200) - 40) };
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s) return;
        const height = Math.round(Math.max(MINI_OPEN_MIN, Math.min(s.max, s.height + e.screenY - s.y)));
        cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(() => {
          void getCurrentWindow()
            .setSize(new LogicalSize(MINI_WIDTH, height))
            .catch((err) => console.warn('[mini] 창 크기를 바꾸지 못했습니다', err));
        });
      }}
      onPointerUp={end}
      onPointerCancel={end}
    />
  );
}

/** 펼친 다음 트랙: 다음에 나올 곡과 이어서 자동 재생될 곡. 누르면 그 곡으로 간다. */
function MiniQueue() {
  const { data, error, items, upcoming, automix, jump } = useQueue();
  const message =
    error && !data ? t('대기열을 읽지 못했습니다.') : !data ? t('불러오는 중…') : items.length === 0 || (!upcoming.length && !automix.length) ? t('곡을 재생하면 다음에 나올 곡이 여기에 쌓입니다.') : '';
  return (
    <section className="mini-panel mini-queue" aria-label={t('다음 트랙')}>
      {message ? (
        <p className="mini-panel__empty">{message}</p>
      ) : (
        <div className="mini-queue__list">
          {upcoming.length > 0 && <h3 className="mini-queue__head">{t('다음 트랙')}</h3>}
          {upcoming.map(({ item, index }) => (
            <TrackItem key={`q-${index}-${item.track.videoId}`} track={item.track} withMenu={false} onClick={() => jump(index)} />
          ))}
          {automix.length > 0 && <h3 className="mini-queue__head">{t('이어서 자동 재생')}</h3>}
          {automix.map((track, i) => (
            <TrackItem key={`a-${i}-${track.videoId}`} track={track} withMenu={false} onClick={() => void playTrack(track)} />
          ))}
        </div>
      )}
      <ResizeGrip />
    </section>
  );
}

/** 표지 오른쪽 가사 두 줄: 지금 부르는 줄과 다음 줄. 시간 맞춤 가사가 있을 때만(없으면 아무것도 그리지 않는다). */
function MiniLyricLines() {
  const ad = usePlayer((s) => s.ad);
  const { lyrics, loading, offset, shift } = useTrackLyrics();
  const lines = useMemo(() => (!loading && !ad ? (lyrics?.synced?.filter((l) => l.text.trim()) ?? []) : []), [lyrics, loading, ad]);
  // 줄이 바뀔 때만 다시 그린다.
  const at = usePositionSelect(4, (pos) => activeLine(lines, pos + offset + shift));
  if (!lines.length) return null;
  const now = at >= 0 ? lines[at].text : '';
  const next = lines[at + 1]?.text ?? '';
  return (
    <div className="mini-app__lyrics" aria-live="off">
      {/* 줄이 바뀌면 key가 바뀌어 살짝 올라오며 나타난다 */}
      <div key={`n${at}`} className="mini-app__lyric is-now" data-tip={now} data-tip-show="overflow">
        {now || '♪'}
      </div>
      <div key={`x${at}`} className="mini-app__lyric" data-tip={next} data-tip-show="overflow">
        {next}
      </div>
    </div>
  );
}

export function MiniApp() {
  // 미니 창은 이 컴포넌트가 맨 위라, 언어가 바뀌면 여기서 다시 그린다.
  useLang();
  const videoId = usePlayer((s) => s.videoId);
  const title = usePlayer((s) => s.title);
  const artist = usePlayer((s) => s.artist);
  const artwork = usePlayer((s) => s.artwork);
  const playing = usePlayer((s) => s.playing);
  const ad = usePlayer((s) => s.ad);
  const liked = useLiked(videoId);
  // 미니 창 너비(약 460px)에 깔면 반경 8이 원래 CSS blur(40px)와 비슷하다.
  const soft = useSoftArt(artwork, 8);
  const [pinned, setPinned] = useState(true);
  const [queueOpen, setQueueOpen] = useState(() => loadFlag(QUEUE_KEY, false));
  const [showLyrics, setShowLyrics] = useState(() => loadFlag(LYRICS_KEY, true));
  const mac = /Mac/i.test(navigator.platform);

  useEffect(() => {
    // 청취 기록은 큰 창이 남긴다(같은 곡을 두 번 세지 않게).
    const stops = [startPlayerSync(false), startLibrarySync(), Promise.resolve(startAlbumTheme(() => playerStore.get().artwork, (fn) => playerStore.subscribe(fn)))];
    return () => {
      for (const p of stops) void p.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    void fitWindow(queueOpen).catch((err) => console.warn('[mini] 창 크기를 바꾸지 못했습니다', err));
  }, [queueOpen]);
  // 펼친 동안 사용자가 맞춘 높이를 기억한다(다음에 펼칠 때·다음 실행에 그 높이로).
  useEffect(() => {
    if (!queueOpen) return;
    let timer = 0;
    let unlisten: Promise<() => void> | undefined;
    try {
      const win = getCurrentWindow();
      unlisten = win.onResized(({ payload }) => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          void win.scaleFactor().then((scale) => {
            const height = Math.round(payload.height / scale);
            if (height < MINI_OPEN_MIN) return;
            try {
              localStorage.setItem(HEIGHT_KEY, String(height));
            } catch {
              // 저장하지 못해도 이번에는 그 크기로 쓴다.
            }
          });
        }, 300);
      });
    } catch (err) {
      console.warn('[mini] 창 크기를 지켜보지 못했습니다', err);
    }
    return () => {
      window.clearTimeout(timer);
      void unlisten?.then((stop) => stop());
    };
  }, [queueOpen]);
  const toggleQueue = () => {
    setQueueOpen(!queueOpen);
    saveFlag(QUEUE_KEY, !queueOpen);
  };
  const toggleShowLyrics = () => {
    setShowLyrics(!showLyrics);
    saveFlag(LYRICS_KEY, !showLyrics);
  };

  const has = !!videoId;
  const toggle = () => {
    patchPlayer({ playing: !playing });
    void run(ytm.control('toggle'), t('재생을 바꾸지 못했습니다'));
  };

  return (
    <div
      className={`mini-app${mac ? ' mini-app--mac' : ''}${queueOpen ? ' is-open' : ''}`}
      style={{ '--art': artwork ? `url("${artwork}")` : 'none', '--art-soft': soft ? `url("${soft}")` : 'none' } as CSSProperties}
    >
      <div className={`mini-app__backdrop${soft ? ' is-soft' : ''}`} aria-hidden="true" />
      <div className="mini-app__drag" data-tauri-drag-region>
        <span data-tauri-drag-region>Garak</span>
        <div className="mini-app__top-tools">
          <button
            type="button"
            className={`icon-btn mini-app__tool${pinned ? ' is-on' : ''}`}
            aria-label={pinned ? t('늘 위에 두지 않기') : t('늘 위에 두기')}
            data-tip-side="bottom"
            aria-pressed={pinned}
            onClick={() => miniPin(!pinned).then(() => setPinned(!pinned), (err) => toastError(err))}
          >
            <Icon name="pin" size={14} />
          </button>
          <button type="button" className="icon-btn mini-app__tool" aria-label={t('큰 창 열기')} data-tip-side="bottom" onClick={() => void invoke('show_main_window').catch((err) => toastError(err))}>
            <Icon name="external" size={14} />
          </button>
        </div>
      </div>
      <div className="mini-app__body">
        <Cover src={artwork} size={84} className="mini-app__art" />
        <div className="mini-app__side">
          <div className="mini-app__title" data-tip={title} data-tip-show="overflow">{has ? (ad ? t('광고') : title) : t('재생 중인 곡 없음')}</div>
          <div className="mini-app__artist" data-tip={artist} data-tip-show="overflow">{has ? (ad ? 'YouTube Music' : artist) : t('큰 창에서 곡을 고르세요')}</div>
          {has && showLyrics && <MiniLyricLines />}
          <div className="mini-app__controls">
            <button type="button" className={`icon-btn${liked ? ' is-on' : ''}`} aria-label={liked ? t('좋아요 취소') : t('좋아요')} disabled={!has || ad} onClick={() => toggleLike({ videoId, title })}>
              <Icon name="heart" size={17} filled={liked} />
            </button>
            <button type="button" className="icon-btn" aria-label={t('이전 곡')} disabled={!has} onClick={() => run(ytm.control('previous'), t('이전 곡으로 가지 못했습니다'))}>
              <Icon name="previous" size={20} />
            </button>
            <button type="button" className="play-btn mini-app__play" aria-label={playing ? t('일시정지') : t('재생')} disabled={!has} onClick={toggle}>
              <Icon name={playing ? 'pause' : 'play'} size={20} />
            </button>
            <button type="button" className="icon-btn" aria-label={t('다음 곡')} disabled={!has} onClick={() => run(ytm.control('next'), t('다음 곡으로 가지 못했습니다'))}>
              <Icon name="next" size={20} />
            </button>
            <span className="mini-app__gap" />
            <button type="button" className={`icon-btn${showLyrics ? ' is-on' : ''}`} aria-label={t('가사')} aria-pressed={showLyrics} onClick={toggleShowLyrics}>
              <Icon name="lyrics" size={18} />
            </button>
            <button type="button" className={`icon-btn${queueOpen ? ' is-on' : ''}`} aria-label={t('다음 트랙')} aria-pressed={queueOpen} onClick={toggleQueue}>
              <Icon name="queue" size={18} />
            </button>
          </div>
        </div>
      </div>
      <MiniSeek />
      {queueOpen && <MiniQueue />}
      <Toasts />
      <TooltipHost />
    </div>
  );
}
