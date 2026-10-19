import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { locale, t } from '../i18n';
import { activeLine, LYRIC_OFFSET_MAX, LYRIC_OFFSET_STEP, type Lyrics } from '../lib/lyrics';
import * as ytm from '../lib/ytm/client';
import { useTrackLyrics } from '../state/lyrics';
import { patchPlayer, usePlayer, usePositionSelect } from '../state/player';
import { LYRIC_SCALES, setLyricsView, stepLyricScale, toastError, toggleLyrics, useLyricScale, useLyricsView } from '../state/ui';
import { useSoftArt } from '../lib/softArt';
import { Cover, largeArt } from './Cover';
import { CoverSpectrum } from './CoverSpectrum';
import { FullStage } from './FullStage';
import { Icon } from './Icon';


/** 사용자가 직접 굴린 뒤 이 시간 동안은 자동 따라가기를 멈춘다. */
const MANUAL_SCROLL_PAUSE_MS = 4000;

function SyncedLines({ lyrics, scale, offset }: { lyrics: Lyrics; scale: number; offset: number }) {
  const lines = lyrics.synced!;
  // 지금 줄이 바뀔 때만 다시 그린다(줄 전체를 초당 20번 그리지 않게).
  const active = usePositionSelect(20, (pos) => activeLine(lines, pos + offset));
  const box = useRef<HTMLDivElement>(null);
  const manualUntil = useRef(0);

  useEffect(() => {
    const el = box.current;
    if (!el || Date.now() < manualUntil.current) return;
    const line = el.querySelector<HTMLElement>(`[data-line="${Math.max(0, active)}"]`);
    if (!line) return;
    const target = line.offsetTop - el.clientHeight * 0.36 + line.offsetHeight / 2;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ top: Math.max(0, target), behavior: reduce ? 'auto' : 'smooth' });
    // 글자 크기를 바꾸면 줄 위치가 달라지므로 현재 줄을 다시 맞춘다.
  }, [active, scale]);

  const seek = (time: number) => {
    manualUntil.current = 0;
    const to = Math.max(0, time - offset);
    patchPlayer({ position: to });
    ytm.control('seek', to).catch((err) => toastError(err, t('이동하지 못했습니다')));
  };

  return (
    <div
      className="lyrics__scroll"
      ref={box}
      onWheel={() => (manualUntil.current = Date.now() + MANUAL_SCROLL_PAUSE_MS)}
      onPointerDown={() => (manualUntil.current = Date.now() + MANUAL_SCROLL_PAUSE_MS)}
    >
      <div className="lyrics__pad" />
      {lines.map((line, i) => (
        <button
          key={`${line.time}-${i}`}
          type="button"
          data-line={i}
          className={`lyric${i === active ? ' is-active' : i < active ? ' is-past' : ''}${line.text ? '' : ' lyric--gap'}`}
          onClick={() => seek(line.time)}
        >
          {line.text || '♪'}
        </button>
      ))}
      <div className="lyrics__pad" />
    </div>
  );
}

/** 앨범 표지 크기(styles.css .lyrics__cover-inner가 쓸 수 있는 높이로 정한다). 표지 아래 스펙트럼도 같은 너비. */
const ART_SIZE = 'var(--cover-size)';

/** 앨범 표지 크게 + 제목·가수 + 지금 부르는 가사 두 줄(누르면 가사 보기) */
function CoverStage({ lyrics, offset, artwork, title, artist }: { lyrics?: Lyrics | null; offset: number; artwork: string; title: string; artist: string }) {
  const playing = usePlayer((s) => s.playing);
  const lines = useMemo(() => lyrics?.synced?.filter((l) => l.text.trim()) ?? [], [lyrics]);
  const at = usePositionSelect(4, (pos) => (lines.length ? Math.max(0, activeLine(lines, pos + offset)) : -1));
  const plain = !lines.length ? (lyrics?.plain ?? '').split('\n').map((l) => l.trim()).filter(Boolean) : [];
  const now = at >= 0 ? lines[at].text : plain[0];
  const next = at >= 0 ? lines[at + 1]?.text : plain[1];
  return (
    <div className="lyrics__cover">
      <div className="lyrics__cover-inner">
        <Cover src={artwork ? largeArt(artwork) : undefined} size={ART_SIZE} className={`lyrics__art${playing ? '' : ' is-paused'}`} />
        <CoverSpectrum playing={playing} width={ART_SIZE} />
        <div className="lyrics__cover-text">
          <div className="lyrics__cover-title">{title || t('재생 중인 곡이 없습니다')}</div>
          {artist && <div className="lyrics__cover-artist">{artist}</div>}
        </div>
        {now && (
          <button type="button" className="lyrics__preview" title={t('가사 보기')} onClick={() => setLyricsView('lyrics')}>
            <span className="lyrics__preview-now">{now}</span>
            {next && <span className="lyrics__preview-next">{next}</span>}
          </button>
        )}
      </div>
    </div>
  );
}

export function LyricsView() {
  const videoId = usePlayer((s) => s.videoId);
  const title = usePlayer((s) => s.title);
  const artist = usePlayer((s) => s.artist);
  const artwork = usePlayer((s) => s.artwork);
  const ad = usePlayer((s) => s.ad);
  const state = useTrackLyrics();
  const { loading, borrowed, offset, shift, nudge } = state;

  const scale = useLyricScale();
  // 가사 화면 너비(약 1300px)에 깔면 반경 5가 원래 CSS blur(70px)와 비슷하다.
  const soft = useSoftArt(artwork, 5);
  const bg = {
    '--art': artwork ? `url("${artwork}")` : 'none',
    '--art-soft': soft ? `url("${soft}")` : 'none',
    '--lyric-scale': scale,
  } as CSSProperties;
  const view = useLyricsView();
  /** 전체 화면 모드(모니터에 틀어 두기) */
  const [stage, setStage] = useState(false);

  return (
    <section className="lyrics" style={bg} aria-label={view === 'cover' ? t('지금 재생') : t('가사')}>
      <div className={`lyrics__backdrop${soft ? ' is-soft' : ''}`} aria-hidden="true" />
      <header className="lyrics__head">
        {view === 'lyrics' ? (
          <div className="lyrics__track">
            {videoId && <Cover src={artwork || undefined} size={48} className="lyrics__thumb" />}
            <div className="lyrics__track-text">
              <div className="lyrics__title">{title || t('재생 중인 곡이 없습니다')}</div>
              {artist && <div className="lyrics__artist">{artist}</div>}
            </div>
          </div>
        ) : (
          <div />
        )}
        <div className="lyrics__tools">
          <div className="seg" role="radiogroup" aria-label={t('크게 볼 것')}>
            <button type="button" role="radio" aria-checked={view === 'lyrics'} className={`seg__btn${view === 'lyrics' ? ' is-on' : ''}`} onClick={() => setLyricsView('lyrics')}>
              {t('가사')}
            </button>
            <button type="button" role="radio" aria-checked={view === 'cover'} className={`seg__btn${view === 'cover' ? ' is-on' : ''}`} onClick={() => setLyricsView('cover')}>
              {t('앨범 표지')}
            </button>
          </div>
          {view === 'lyrics' && (
            <div className="textsize" role="group" aria-label={t('가사 글자 크기')}>
              <button
                type="button"
                className="textsize__btn"
                aria-label={t('가사 글자 작게')}
                title={t('작게 (⌘-)')}
                disabled={scale <= LYRIC_SCALES[0]}
                onClick={() => stepLyricScale(-1)}
              >
                <span className="textsize__glyph textsize__glyph--sm" aria-hidden="true">{t('가')}</span>
              </button>
              <button type="button" className="textsize__value" title={t('기본 크기로 (⌘0)')} onClick={() => stepLyricScale(0)}>
                {Math.round(scale * 100)}%
              </button>
              <button
                type="button"
                className="textsize__btn"
                aria-label={t('가사 글자 크게')}
                title={t('크게 (⌘=)')}
                disabled={scale >= LYRIC_SCALES[LYRIC_SCALES.length - 1]}
                onClick={() => stepLyricScale(1)}
              >
                <span className="textsize__glyph textsize__glyph--lg" aria-hidden="true">{t('가')}</span>
              </button>
            </div>
          )}
          {view === 'lyrics' && state.lyrics?.synced && (
            <div className="textsize lyric-sync" role="group" aria-label={t('가사 싱크')}>
              <button type="button" className="textsize__btn" aria-label={t('가사를 0.5초 늦게')} title={t('가사가 빠를 때')} disabled={offset <= -LYRIC_OFFSET_MAX} onClick={() => nudge(-LYRIC_OFFSET_STEP)}>
                <Icon name="back" size={14} />
              </button>
              <button type="button" className="textsize__value" title={t('싱크 원래대로')} onClick={() => nudge(0)}>
                {offset === 0
                  ? t('싱크')
                  : t('{n}초', { n: `${offset > 0 ? '+' : ''}${offset.toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })}` })}
              </button>
              <button type="button" className="textsize__btn" aria-label={t('가사를 0.5초 빠르게')} title={t('가사가 늦을 때')} disabled={offset >= LYRIC_OFFSET_MAX} onClick={() => nudge(LYRIC_OFFSET_STEP)}>
                <Icon name="forward" size={14} />
              </button>
            </div>
          )}
          <button type="button" className="icon-btn" aria-label={t('전체 화면')} title={t('전체 화면')} onClick={() => setStage(true)}>
            <Icon name="expand" size={18} />
          </button>
          <button type="button" className="icon-btn" aria-label={t('가사 닫기')} onClick={() => toggleLyrics(false)}>
            <Icon name="close" size={20} />
          </button>
        </div>
      </header>

      {view === 'cover' ? (
        <CoverStage lyrics={!loading && !ad ? state.lyrics : null} offset={offset + shift} artwork={ad ? '' : artwork} title={ad ? t('광고') : title} artist={ad ? 'YouTube Music' : artist} />
      ) : !videoId ? (
        <p className="lyrics__empty">{t('곡을 재생하면 가사가 여기에 나옵니다.')}</p>
      ) : ad ? (
        <p className="lyrics__empty">{t('광고가 끝나면 가사를 보여 드립니다.')}</p>
      ) : loading ? (
        <p className="lyrics__empty">{t('가사를 찾는 중…')}</p>
      ) : state.error ? (
        <p className="lyrics__empty">{t('가사를 불러오지 못했습니다. 인터넷 연결을 확인하세요.')}</p>
      ) : !state.lyrics ? (
        <p className="lyrics__empty">{t('이 곡의 가사를 찾지 못했습니다.')}</p>
      ) : state.lyrics.synced ? (
        <SyncedLines lyrics={state.lyrics} scale={scale} offset={offset + shift} />
      ) : (
        <div className="lyrics__scroll">
          <div className="lyrics__plain">{state.lyrics.plain}</div>
        </div>
      )}

      {view === 'lyrics' && state.lyrics && (state.id === videoId || borrowed) && (
        <footer className="lyrics__source">
          {state.lyrics.synced
            ? t('가사 제공: {source}', { source: state.lyrics.source })
            : t('가사 제공: {source} (시간 정보 없음)', { source: state.lyrics.source })}
        </footer>
      )}
      {stage && <FullStage lyrics={!loading && !ad ? state.lyrics : null} offset={offset + shift} onExit={() => setStage(false)} />}
    </section>
  );
}
