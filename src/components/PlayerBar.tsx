import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { t, tk } from '../i18n';
import * as ytm from '../lib/ytm/client';
import { toggleLike, useLiked } from '../state/library';
import { go } from '../state/nav';
import { nowPlayingTrack, useNowTrack } from '../state/nowTrack';
import { formatTime, patchPlayer, playerStore, usePlayer, usePosition } from '../state/player';
import { openMenu, toastError, togglePanel, toggleLyrics, useLayout, type MenuEntry } from '../state/ui';
import { cancelSleep, SLEEP_MINUTES, sleepLabel, startSleep, startSleepAfterTrack, useSleep } from '../state/sleep';
import { setVolume, shownVolume, toggleMute, usePendingVolume, VOLUME_STEP } from '../state/volume';
import { miniWindow, videoWindow } from '../lib/tauri';
import { useEq } from '../lib/eq';
import { globalKey, IS_MAC, modKey } from '../lib/keys';
import { usePrefs } from '../state/prefs';
import { Cover } from './Cover';
import { Icon } from './Icon';
import { trackMenu } from './menus';
import { ArtistLinks } from './TrackList';

const run = (p: Promise<unknown>, what: string) => p.catch((err) => toastError(err, what));

function Seek() {
  const duration = usePlayer((s) => s.duration);
  const ad = usePlayer((s) => s.ad);
  const hasTrack = usePlayer((s) => !!s.videoId);
  const position = usePosition(10);
  const [drag, setDrag] = useState<number | null>(null);
  const value = drag ?? position;
  const max = duration > 0 ? duration : 1;
  const style = { '--fill': `${Math.min(100, (value / max) * 100)}%` } as CSSProperties;
  const commit = (v: number) => {
    setDrag(null);
    patchPlayer({ position: v });
    void run(ytm.control('seek', v), t('이동하지 못했습니다'));
  };
  return (
    <div className="seek">
      <span className="seek__time">{hasTrack ? formatTime(value) : ''}</span>
      <input
        type="range"
        className="range seek__range"
        min={0}
        max={max}
        step={0.5}
        value={Math.min(value, max)}
        style={style}
        disabled={!hasTrack || ad || duration <= 0}
        aria-label={t('재생 위치')}
        aria-valuetext={`${formatTime(value)} / ${formatTime(duration)}`}
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') && commit(Number((e.target as HTMLInputElement).value))}
      />
      <span className="seek__time">{hasTrack ? formatTime(duration) : ''}</span>
    </div>
  );
}

/** 휠 한 동작(멈췄다 다시 굴리기)마다 한 칸, 이어 굴리면 이만큼 움직일 때마다 한 칸(트랙패드는 잘게 나뉘어 온다) */
const WHEEL_PX_PER_STEP = 60;
const WHEEL_GESTURE_GAP_MS = 140;

function Volume() {
  const volume = usePlayer((s) => s.volume);
  const muted = usePlayer((s) => s.muted);
  const pending = usePendingVolume();
  const shown = pending ?? (muted ? 0 : volume);
  const box = useRef<HTMLDivElement>(null);
  const range = useRef<HTMLInputElement>(null);

  // 음량 위에서 휠: 위로 굴리면 크게. 막대가 숨은 좁은 창에서는 알림으로 값을 보여 준다.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let acc = 0;
    let lastAt = 0;
    const onWheel = (e: WheelEvent) => {
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      if (!dy) return;
      // 페이지 스크롤로 넘어가지 않게(React onWheel은 수동 수신이라 막지 못해 직접 붙인다)
      e.preventDefault();
      const now = performance.now();
      let steps: number;
      if (now - lastAt > WHEEL_GESTURE_GAP_MS) {
        acc = 0;
        steps = Math.sign(dy);
      } else {
        acc += dy;
        steps = Math.trunc(acc / WHEEL_PX_PER_STEP);
        acc -= steps * WHEEL_PX_PER_STEP;
      }
      lastAt = now;
      if (!steps) return;
      const hidden = !range.current || range.current.offsetParent === null;
      setVolume(shownVolume() - steps * VOLUME_STEP, { announce: hidden });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const style = { '--fill': `${shown}%` } as CSSProperties;
  return (
    <div className="volume" ref={box}>
      <button
        type="button"
        className="icon-btn"
        aria-label={muted || shown === 0 ? t('소리 켜기') : t('음소거')}
        data-tip-key="M"
        onClick={() => toggleMute()}
      >
        <Icon name={muted || shown === 0 ? 'mute' : 'volume'} size={19} />
      </button>
      <input
        ref={range}
        type="range"
        className="range volume__range"
        min={0}
        max={100}
        step={1}
        value={shown}
        style={style}
        aria-label={t('음량')}
        data-tip={t('음량 {n}%', { n: shown })}
        onChange={(e) => setVolume(Number(e.target.value))}
      />
    </div>
  );
}

// 이름은 표시만 해 두고 그릴 때 번역한다.
const REPEAT_LABEL: Record<string, string> = { NONE: tk('반복 안 함'), ALL: tk('전체 반복'), ONE: tk('한 곡 반복') };

/** 노래(음원) ↔ 영상(뮤직비디오) 전환. 영상으로 바꾸면 영상 창을 띄우고, 노래로 바꾸면 닫는다. */
export async function switchAv(video: boolean) {
  try {
    await ytm.avSwitch(video);
    await videoWindow(video);
  } catch (err) {
    toastError(err, video ? t('영상으로 바꾸지 못했습니다') : t('노래로 바꾸지 못했습니다'));
  }
}

export function AvToggle({ compact = false }: { compact?: boolean }) {
  const available = usePlayer((s) => !!s.avAvailable && !s.ad);
  const video = usePlayer((s) => !!s.avVideo);
  if (!available) return null;
  return (
    <div className={`avtoggle${compact ? ' avtoggle--compact' : ''}`} role="radiogroup" aria-label={t('노래·영상')}>
      <button type="button" role="radio" aria-checked={!video} className={!video ? 'is-on' : ''} onClick={() => video && void switchAv(false)}>{t('노래')}</button>
      <button type="button" role="radio" aria-checked={video} className={video ? 'is-on' : ''} onClick={() => !video && void switchAv(true)}>{t('영상')}</button>
    </div>
  );
}

function SleepButton() {
  const sleep = useSleep((s) => s);
  const has = usePlayer((s) => !!s.videoId);
  const [, tick] = useState(0);
  useEffect(() => {
    if (sleep.mode !== 'time') return;
    const timer = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [sleep.mode]);
  const on = sleep.mode !== 'off';
  const menu = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const minutesLabel = (m: number) => {
      if (m < 60) return t('{m}분', { m });
      const h = Math.floor(m / 60);
      return m % 60 ? t('{h}시간 {m}분', { h, m: m % 60 }) : t('{h}시간', { h });
    };
    const entries: MenuEntry[] = SLEEP_MINUTES.map((m) => ({ label: minutesLabel(m), action: () => startSleep(m) }));
    entries.push({ label: t('지금 곡이 끝나면'), action: startSleepAfterTrack, disabled: !has });
    if (on) entries.push({ label: '', separator: true }, { label: t('수면 타이머 끄기'), action: () => cancelSleep() });
    openMenu(r.left - 120, r.top - 10, entries, { above: true });
  };
  return (
    <button type="button" className={`icon-btn sleep-btn${on ? ' is-on' : ''}`} aria-label={on ? t('수면 타이머 {left}', { left: sleepLabel(sleep) }) : t('수면 타이머')} data-tip={t('수면 타이머')} onClick={menu}>
      <Icon name="moon" size={18} />
      {on && <span className="sleep-btn__left">{sleepLabel(sleep)}</span>}
    </button>
  );
}

export function PlayerBar() {
  const videoId = usePlayer((s) => s.videoId);
  const title = usePlayer((s) => s.title);
  const artist = usePlayer((s) => s.artist);
  const artwork = usePlayer((s) => s.artwork);
  const playing = usePlayer((s) => s.playing);
  const buffering = usePlayer((s) => s.buffering);
  const ad = usePlayer((s) => s.ad);
  const repeat = usePlayer((s) => s.repeat);
  const liked = useLiked(videoId);
  const lyricsOn = useLayout((s) => s.lyrics);
  const queueOn = useLayout((s) => s.panel === 'queue');
  const eqOpen = useLayout((s) => s.panel === 'eq');
  const eqOn = useEq((s) => s.enabled);
  const videoOpen = useLayout((s) => s.video);
  const globalShortcuts = usePrefs((s) => s.globalShortcuts);
  const avAvailable = usePlayer((s) => !!s.avAvailable);
  const avVideo = usePlayer((s) => !!s.avVideo);
  const picture = usePlayer((s) => !!s.avVideo || !!s.hasPicture || !!s.avAvailable);
  const has = !!videoId;
  const repeatLabel = REPEAT_LABEL[repeat] ? t(REPEAT_LABEL[repeat]) : repeat;
  const found = useNowTrack();
  const nowTrack = has && !ad && found.id === videoId ? found.track : undefined;
  const albumId = nowTrack?.album?.id;
  const artistRefs = nowTrack?.artists.length ? nowTrack.artists : [];

  /** 지금 곡 메뉴(우클릭·⋯): 다른 목록의 곡 메뉴와 같고, 이미 재생 중이라 "재생"만 뺀다. */
  const nowMenu = (x: number, y: number) => {
    const track = nowPlayingTrack(playerStore.get(), found);
    if (!track) return;
    openMenu(x, y, trackMenu(track, { current: true }));
  };
  const onNowContext = (e: MouseEvent) => {
    if (!has || ad) return;
    e.preventDefault();
    nowMenu(e.clientX, e.clientY);
  };
  const onMore = (e: MouseEvent<HTMLButtonElement>) => {
    const track = nowPlayingTrack(playerStore.get(), found);
    if (!track) return;
    const r = e.currentTarget.getBoundingClientRect();
    openMenu(r.left, r.top - 6, trackMenu(track, { current: true }), { above: true });
  };

  const toggle = () => {
    patchPlayer({ playing: !playing });
    void run(ytm.control('toggle'), t('재생을 바꾸지 못했습니다'));
  };

  return (
    <footer className="player" aria-label={t('재생 바')}>
      <div className="player__now" onContextMenu={onNowContext}>
        {has ? (
          <>
            <button
              type="button"
              className="player__art"
              aria-label={lyricsOn ? t('가사 닫기') : t('가사 보기')}
              data-tip={lyricsOn ? t('가사 닫기') : t('가사 보기')}
              data-tip-key={modKey('L')}
              onClick={() => toggleLyrics()}
            >
              <Cover src={artwork} size={56} />
              <span className="player__art-hint" aria-hidden="true">
                <Icon name={lyricsOn ? 'shrink' : 'enlarge'} size={24} />
              </span>
            </button>
            <div className="player__meta">
              {albumId ? (
                <button type="button" className="player__title link" data-tip={t('{title} — 앨범으로 이동', { title })} onClick={() => go({ name: 'album', id: albumId })}>
                  {title}
                </button>
              ) : (
                <div className="player__title" data-tip={title} data-tip-show="overflow">{ad ? t('광고') : title}</div>
              )}
              <div className="player__artist" data-tip={artist} data-tip-show="overflow">
                {ad ? 'YouTube Music' : artistRefs.some((a) => a.id) ? <ArtistLinks artists={artistRefs} /> : artist}
              </div>
              <AvToggle compact />
            </div>
            {/* 좋아요와 ⋯는 위아래로 쌓아 곡 이름 칸을 좁히지 않는다(좁은 창에서 노래·영상 단추가 눌리지 않게). */}
            <div className="player__acts">
              <button
                type="button"
                className={`icon-btn player__like${liked ? ' is-on' : ''}`}
                aria-label={liked ? t('좋아요 취소') : t('좋아요')}
                aria-pressed={liked}
                disabled={ad}
                onClick={() => toggleLike({ videoId, title })}
              >
                <Icon name="heart" size={19} filled={liked} />
              </button>
              <button type="button" className="icon-btn player__more" aria-label={t('지금 곡 메뉴')} disabled={ad} onClick={onMore}>
                <Icon name="more" size={18} />
              </button>
            </div>
          </>
        ) : (
          <div className="player__idle">{t('곡을 고르면 여기에서 재생됩니다')}</div>
        )}
      </div>

      <div className="player__center">
        <div className="player__buttons">
          <button type="button" className="icon-btn" aria-label={t('대기열 섞기')} disabled={!has} onClick={() => run(ytm.control('shuffle'), t('섞지 못했습니다'))}>
            <Icon name="shuffle" size={18} />
          </button>
          <button type="button" className="icon-btn" aria-label={t('이전 곡')} data-tip-key={modKey('←')} disabled={!has} onClick={() => run(ytm.control('previous'), t('이전 곡으로 가지 못했습니다'))}>
            <Icon name="previous" size={22} />
          </button>
          <button type="button" className={`play-btn${buffering ? ' is-busy' : ''}`} aria-label={playing ? t('일시정지') : t('재생')} data-tip-key="Space" disabled={!has} onClick={toggle}>
            <Icon name={playing ? 'pause' : 'play'} size={22} />
          </button>
          <button type="button" className="icon-btn" aria-label={t('다음 곡')} data-tip-key={modKey('→')} disabled={!has} onClick={() => run(ytm.control('next'), t('다음 곡으로 가지 못했습니다'))}>
            <Icon name="next" size={22} />
          </button>
          <button
            type="button"
            className={`icon-btn repeat${repeat !== 'NONE' ? ' is-on' : ''}`}
            aria-label={t('반복: {mode}', { mode: repeatLabel })}
            data-tip={t('반복: {mode}', { mode: repeatLabel })}
            disabled={!has}
            onClick={() => run(ytm.control('repeat'), t('반복을 바꾸지 못했습니다'))}
          >
            <Icon name="repeat" size={18} />
            {repeat === 'ONE' && <span className="repeat__one">1</span>}
          </button>
        </div>
        <Seek />
      </div>

      <div className="player__side">
        <button
          type="button"
          className={`icon-btn${videoOpen ? ' is-on' : ''}`}
          aria-label={videoOpen ? t('영상 창 닫기') : t('영상 보기')}
          aria-pressed={videoOpen}
          disabled={!has || !picture || ad}
          onClick={() => {
            if (videoOpen) void videoWindow(false).catch((err) => toastError(err));
            // 노래 쪽이면 영상으로 바꾸고, 원래 영상(짝 없음)이면 창만 띄운다.
            else if (avAvailable && !avVideo) void switchAv(true);
            else void videoWindow(true).catch((err) => toastError(err, t('영상 창을 열지 못했습니다')));
          }}
        >
          <Icon name="video" size={19} />
        </button>
        <button type="button" className={`icon-btn${lyricsOn ? ' is-on' : ''}`} aria-label={t('가사')} data-tip-key={modKey('L')} aria-pressed={lyricsOn} onClick={() => toggleLyrics()}>
          <Icon name="lyrics" size={19} />
        </button>
        <button type="button" className={`icon-btn${queueOn ? ' is-on' : ''}`} aria-label={t('대기열')} data-tip-key={IS_MAC ? modKey('U') : undefined} aria-pressed={queueOn} onClick={() => togglePanel('queue')}>
          <Icon name="queue" size={19} />
        </button>
        <button
          type="button"
          className={`icon-btn${eqOpen ? ' is-on' : ''}`}
          aria-label={eqOn ? t('이퀄라이저 (켜짐)') : t('이퀄라이저')}
          data-tip-key={modKey('E')}
          aria-pressed={eqOpen}
          onClick={() => togglePanel('eq')}
        >
          <Icon name="eq" size={19} />
          {eqOn && <span className="dot" aria-hidden="true" />}
        </button>
        <SleepButton />
        <button type="button" className="icon-btn" aria-label={t('미니 플레이어')} data-tip-key={globalShortcuts ? globalKey('M') : undefined} onClick={() => void miniWindow(true).catch((err) => toastError(err))}>
          <Icon name="mini" size={19} />
        </button>
        <Volume />
      </div>
    </footer>
  );
}
