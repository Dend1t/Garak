// 전체 화면 모드: 모니터에 틀어 두는 화면(YouTube 플레이리스트 채널 essential; 영상처럼 차분하게).
// 흐린 표지 배경 위에 큰 앨범 표지, 앨범·제목·가수, 위로 굴러 올라가는 가사(지난 줄·지금 줄·다음 줄이 보인다), 스펙트럼, 맨 아래 얇은 진행 막대.
// 마우스를 3초 움직이지 않으면 커서와 조작 단추를 숨긴다. 이 모드 동안은 화면이 꺼지지 않는다. Esc로 나간다.
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../i18n';
import { activeLine, type LyricLine, type Lyrics } from '../lib/lyrics';
import { useSoftArt } from '../lib/softArt';
import * as ytm from '../lib/ytm/client';
import { formatTime, patchPlayer, playerStore, usePlayer, usePosition, usePositionSelect } from '../state/player';
import { toastError } from '../state/ui';
import { Cover, largeArt } from './Cover';
import { CoverSpectrum } from './CoverSpectrum';
import { Icon } from './Icon';

/** 이만큼 움직임이 없으면 커서·조작 단추를 숨긴다 */
const IDLE_MS = 3000;
/** 지금 줄의 위쪽 끝을 가사 창 높이의 이 비율에 둔다(위에 지난 줄 하나, 아래에 다음 줄이 보인다. 지금 줄이 두 줄이어도). */
const LYRIC_ANCHOR = 0.3;
/** 줄이 바뀔 때 아래 줄일수록 이만큼(ms)씩 늦게 출발한다(최대 4줄). 탄력 있게 말려 올라가는 느낌. */
const LYRIC_STAGGER_MS = 55;

const run = (p: Promise<unknown>) => p.catch((err) => toastError(err));

export function FullStage({ lyrics, offset, onExit }: { lyrics?: Lyrics | null; offset: number; onExit: () => void }) {
  const title = usePlayer((s) => s.title);
  const artist = usePlayer((s) => s.artist);
  const album = usePlayer((s) => s.album);
  const artwork = usePlayer((s) => s.artwork);
  const playing = usePlayer((s) => s.playing);
  const duration = usePlayer((s) => s.duration);
  const ad = usePlayer((s) => s.ad);
  const [idle, setIdle] = useState(false);
  const exit = useRef(onExit);
  exit.current = onExit;

  // 창을 전체 화면으로, 화면 꺼짐 막기. 초록 단추·⌃⌘F로 전체 화면을 끝내도 이 모드를 닫는다.
  useEffect(() => {
    const win = getCurrentWindow();
    let alive = true;
    let wasFull = false;
    void win.setFullscreen(true).catch((err) => console.warn('[stage] 전체 화면 실패', err));
    void invoke('keep_awake', { on: true }).catch((err) => console.warn('[stage] 화면 꺼짐 막기 실패', err));
    const unlisten = win.onResized(() => {
      void win.isFullscreen().then((full) => {
        if (!alive) return;
        if (wasFull && !full) exit.current();
        wasFull = full;
      });
    });
    return () => {
      alive = false;
      void unlisten.then((f) => f());
      void win.setFullscreen(false).catch(() => undefined);
      void invoke('keep_awake', { on: false }).catch(() => undefined);
    };
  }, []);

  // 가만히 두면 커서·단추를 숨긴다. 스페이스(재생/일시정지)는 앱 전체 단축키가 받는다.
  useEffect(() => {
    let last = Date.now();
    const wake = () => {
      last = Date.now();
      setIdle(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        exit.current();
        return;
      }
      wake();
    };
    const timer = window.setInterval(() => Date.now() - last > IDLE_MS && setIdle(true), 500);
    window.addEventListener('mousemove', wake);
    window.addEventListener('mousedown', wake);
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('mousemove', wake);
      window.removeEventListener('mousedown', wake);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const toggle = () => {
    patchPlayer({ playing: !playerStore.get().playing });
    void run(ytm.control('toggle'));
  };

  // 시간 맞춤 가사가 있을 때만(첫 줄 전에는 ♪가 지금 줄)
  const lines = useMemo(() => lyrics?.synced?.filter((l) => l.text.trim()) ?? [], [lyrics]);
  // 화면 전체는 줄이 바뀔 때만 다시 그린다(진행 막대는 StageProgress가 따로 그린다).
  const at = usePositionSelect(8, (pos) => (lines.length ? activeLine(lines, pos + offset) : -1));
  const art = artwork && !ad ? largeArt(artwork) : '';
  // 전체 화면(약 2600px)에 깔면 반경 3이 원래 CSS blur(90px)와 비슷하다. 흐릴 그림은 큰 표지가 아니어도 된다.
  const soft = useSoftArt(artwork && !ad ? artwork : '', 3);

  return createPortal(
    <div
      className={`stage${idle ? ' is-idle' : ''}`}
      style={{ '--art': art ? `url("${art}")` : 'none', '--art-soft': soft ? `url("${soft}")` : 'none' } as CSSProperties}
      role="dialog"
      aria-modal="true"
      aria-label={t('전체 화면')}
    >
      <div className={`stage__bg${soft ? ' is-soft' : ''}`} aria-hidden="true" />
      <div className="stage__shade" aria-hidden="true" />
      <button type="button" className="icon-btn stage__exit" aria-label={t('전체 화면 끝내기')} title={t('전체 화면 끝내기 (Esc)')} onClick={onExit}>
        <Icon name="close" size={22} />
      </button>

      <div className="stage__main">
        <Cover src={art || undefined} size="var(--stage-art)" className={`stage__art${playing ? '' : ' is-paused'}`} />
        <div className="stage__info">
          {album && !ad && <div className="stage__album">{album}</div>}
          <h1 className="stage__title">{ad ? t('광고') : title || t('재생 중인 곡이 없습니다')}</h1>
          {artist && <div className="stage__artist">{ad ? 'YouTube Music' : artist}</div>}
          {lines.length > 0 && !ad && <StageLyrics lines={lines} at={at} />}
          <CoverSpectrum playing={playing} width="min(100%, 560px)" className="stage__aura" />
        </div>
      </div>

      <footer className="stage__foot">
        <div className="stage__controls">
          <button type="button" className="icon-btn" aria-label={t('이전 곡')} onClick={() => void run(ytm.control('previous'))}>
            <Icon name="previous" size={24} />
          </button>
          <button type="button" className="play-btn stage__play" aria-label={playing ? t('일시정지') : t('재생')} onClick={toggle}>
            <Icon name={playing ? 'pause' : 'play'} size={24} />
          </button>
          <button type="button" className="icon-btn" aria-label={t('다음 곡')} onClick={() => void run(ytm.control('next'))}>
            <Icon name="next" size={24} />
          </button>
        </div>
        <StageProgress duration={duration} />
      </footer>
    </div>,
    document.body,
  );
}

function StageProgress({ duration }: { duration: number }) {
  const position = usePosition(8);
  const pct = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;
  return (
    <div className="stage__progress" aria-hidden="true">
      <span>{formatTime(position)}</span>
      <div className="stage__bar">
        <span style={{ width: `${pct}%` }} />
      </div>
      <span>{formatTime(duration)}</span>
    </div>
  );
}

/**
 * 전체 화면 가사: 모든 줄을 세로로 늘어놓고, 지금 줄이 늘 같은 높이에 오도록 목록을 위로 굴린다.
 * 아래 줄일수록 조금씩 늦게 출발하고 살짝 지나쳤다 돌아오는 곡선(CSS)이라, 줄이 바뀔 때 탄력 있게 말려 올라간다.
 * 맨 앞에는 첫 줄 전에 보이는 ♪를 둔다. 새 곡이거나 창 크기가 바뀌었을 때는 굴리지 않고 바로 그 자리에 둔다.
 */
const StageLyrics = memo(function StageLyrics({ lines, at }: { lines: LyricLine[]; at: number }) {
  const box = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  /** 지금 줄의 순번(맨 앞 ♪ 때문에 한 칸 밀린다) */
  const now = at + 1;
  const nowRef = useRef(now);
  nowRef.current = now;
  const placedLines = useRef<LyricLine[] | null>(null);

  /** 지금 줄이 기준 높이에 오도록 목록 전체를 옮긴다(--shift). instant면 애니메이션 없이. */
  const place = (instant: boolean) => {
    const el = box.current;
    const list = track.current;
    const row = list?.children[nowRef.current] as HTMLElement | undefined;
    if (!el || !list || !row) return;
    if (instant) list.classList.add('is-instant');
    list.style.setProperty('--shift', `${Math.round(el.clientHeight * LYRIC_ANCHOR - row.offsetTop)}px`);
    if (instant) {
      // 옮긴 자리를 먼저 반영한 다음 애니메이션을 다시 켠다(안 그러면 켜는 순간 굴러간다).
      void list.offsetHeight;
      list.classList.remove('is-instant');
    }
  };

  useLayoutEffect(() => {
    place(placedLines.current !== lines);
    placedLines.current = lines;
  }, [lines, now]);

  // 창 크기가 바뀌면 줄 바꿈·글자 크기가 달라지므로 다시 잰다.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(() => place(true));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={box} className="stage__lyrics">
      <div ref={track} className="stage__track">
        {['♪', ...lines.map((l) => l.text)].map((text, i) => (
          <p
            key={i}
            className={`stage__line${i === now ? ' is-now' : ''}`}
            style={{ '--d': `${Math.min(4, Math.max(0, i - now + 1)) * LYRIC_STAGGER_MS}ms` } as CSSProperties}
          >
            {text}
          </p>
        ))}
      </div>
    </div>
  );
});
