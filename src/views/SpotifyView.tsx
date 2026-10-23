// Spotify 플레이리스트(기본: 한국 Top 50)를 YouTube Music 곡으로 듣기.
import { useEffect, useMemo, useState, type FormEvent, type MouseEvent } from 'react';
import { t } from '../i18n';
import {
  chartFor,
  chartTitle,
  describeSpotifyError,
  fetchPlaylist,
  isSynced,
  matchAll,
  matchTrack,
  playInChartOrder,
  playlistIdFrom,
  rememberChart,
  savedPlaylistId,
  CHARTS,
  CHART_GROUP_ORDER,
  chartKind,
  chartShortLabel,
  syncToYouTubeMusic,
  todayLabel,
  type Match,
  chartChipLabel,
  chartGroupName,
} from '../lib/spotify';
import { useAsync } from '../lib/useAsync';
import type { Track } from '../lib/ytm/types';
import { loadPlaylists, toggleLike, useLiked } from '../state/library';
import { go, replace } from '../state/nav';
import { formatTime, usePlayer } from '../state/player';
import { openMenu, toast, toastError } from '../state/ui';
import { Cover } from '../components/Cover';
import { Icon } from '../components/Icon';
import { trackMenu } from '../components/menus';
import { ErrorState, Loading } from './common';

/** 나라별 차트 고르기: 평소엔 지금 나라만 보이고, 누르면 목록이 펼쳐진다(고르면 다시 접힘). */
function ChartPicker({ current }: { current: string }) {
  const [open, setOpen] = useState(false);
  const chart = chartFor(current);
  return (
    <div className={`chart-picker${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="chart-picker__toggle"
        aria-expanded={open}
        aria-controls="chart-picker-list"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="chart" size={16} />
        <span className="chart-picker__current">{chart ? chartShortLabel(chart) : t('차트')}</span>
        <span className="chart-picker__hint">{open ? t('접기') : t('차트 바꾸기')}</span>
        <Icon name={open ? 'up' : 'down'} size={16} />
      </button>
      {open && (
        <div id="chart-picker-list" className="chart-picker__groups" role="group" aria-label={t('차트 고르기')}>
          {CHART_GROUP_ORDER.map((group) => (
            <div key={group} className="chart-picker__group">
              <span className="chart-picker__group-title">{chartGroupName(group)}</span>
              <div className="chart-picker__list">
                {CHARTS.filter((c) => c.group === group).map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={`chip${c.id === current ? ' is-on' : ''}`}
                    aria-current={c.id === current ? 'page' : undefined}
                    onClick={() => {
                      setOpen(false);
                      if (c.id !== current) replace({ name: 'spotify', id: c.id });
                    }}
                  >
                    {chartChipLabel(c)}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ rank, title, artists, durationMs, match, onPlay, onRetry }: {
  rank: number;
  title: string;
  artists: string;
  durationMs: number;
  match?: Match;
  onPlay: () => void;
  onRetry: () => void;
}) {
  const track = match?.track;
  const current = usePlayer((s) => !!track && s.videoId === track.videoId);
  const liked = useLiked(track?.videoId);
  const menu = (e: MouseEvent) => {
    if (!track) return;
    e.preventDefault();
    openMenu(e.clientX, e.clientY, trackMenu(track));
  };
  return (
    <div className={`track chart-row${current ? ' is-current' : ''}${match && !track ? ' is-unavailable' : ''}`} role="row" onDoubleClick={() => track && onPlay()} onContextMenu={menu}>
      <div className="chart-row__rank" role="cell">{rank}</div>
      <div className="track__lead" role="cell">
        <Cover src={track?.thumbnail} size={40} />
        <button type="button" className="track__play" aria-label={t('{title} 재생', { title })} disabled={!track} onClick={onPlay}>
          <Icon name="play" size={16} />
        </button>
      </div>
      <div className="track__main" role="cell">
        <span className="track__title" data-tip={title} data-tip-show="overflow">{title}</span>
        <span className="track__artists">{artists}</span>
      </div>
      <div className="chart-row__match" role="cell">
        {!match ? (
          <span className="match match--wait">{t('찾는 중')}</span>
        ) : !track ? (
          <span className="match match--none">
            {t('YouTube Music에서 못 찾음')}
            <button type="button" className="link" onClick={onRetry}>{t('직접 검색')}</button>
          </span>
        ) : match.quality === 'unsure' ? (
          <span className="match match--unsure" data-tip={`${track.title} — ${track.artists.map((a) => a.name).join(', ')}`}>
            {t('비슷한 곡: {title}', { title: track.title })}
          </span>
        ) : track.isVideo ? (
          <span className="match match--video">{t('뮤직비디오 음원')}</span>
        ) : null}
      </div>
      <div className="track__tail" role="cell">
        <button
          type="button"
          className={`icon-btn track__like${liked ? ' is-on' : ''}`}
          aria-label={liked ? t('좋아요 취소') : t('좋아요')}
          disabled={!track}
          onClick={() => track && toggleLike(track)}
        >
          <Icon name="heart" size={17} filled={liked} />
        </button>
        <span className="track__time">{durationMs > 0 ? formatTime(durationMs / 1000) : ''}</span>
        <button type="button" className="icon-btn track__more" aria-label={t('더 보기')} disabled={!track} onClick={menu}>
          <Icon name="more" size={18} />
        </button>
      </div>
    </div>
  );
}

export function SpotifyView({ id }: { id: string }) {
  const res = useAsync(`spotify:${id}`, () => fetchPlaylist(id));
  const isChart = !!chartFor(id);
  useEffect(() => rememberChart(id), [id]);
  const [matches, setMatches] = useState<(Match | undefined)[]>([]);
  const [busy, setBusy] = useState<'' | 'save' | 'play'>('');
  const [link, setLink] = useState('');
  const playlist = res.data;

  useEffect(() => {
    if (!playlist) return;
    const signal = { cancelled: false };
    setMatches(new Array(playlist.tracks.length).fill(undefined));
    void matchAll(playlist.tracks, (i, m) => {
      if (!signal.cancelled) setMatches((prev) => {
        const next = [...prev];
        next[i] = m;
        return next;
      });
    }, signal);
    return () => {
      signal.cancelled = true;
    };
  }, [playlist]);

  const found = useMemo(() => matches.filter((m): m is Match & { track: Track } => !!m?.track).map((m) => m.track), [matches]);
  const done = matches.filter(Boolean).length;
  const total = playlist?.tracks.length ?? 0;
  const finished = total > 0 && done === total;

  if (res.loading && !playlist) {
    return <div className="page">{isChart && <ChartPicker current={id} />}<Loading label={t('차트 곡 목록을 가져오는 중…')} /></div>;
  }
  if (res.error || !playlist) {
    return <div className="page">{isChart && <ChartPicker current={id} />}<ErrorState message={describeSpotifyError(res.error)} onRetry={res.reload} /></div>;
  }

  /** index번째 곡부터 차트 순서대로 재생 */
  const playFrom = async (index: number) => {
    const ordered = matches.slice(index).map((m) => m?.track).filter((t): t is Track => !!t && t.available);
    if (!ordered.length) return;
    setBusy('play');
    try {
      const queued = await playInChartOrder(playlist.id, ordered, found);
      if (queued > 1) toast(t('차트 {n}곡을 차례로 재생합니다', { n: queued }));
    } catch (err) {
      toastError(err, t('대기열을 만들지 못했습니다'));
    } finally {
      setBusy('');
    }
  };

  const save = async () => {
    if (!finished || !found.length) return;
    setBusy('save');
    try {
      const pid = await syncToYouTubeMusic(playlist, found);
      toast(t("내 YouTube Music에 '{title} (Spotify)' 재생목록을 맞췄습니다", { title: chartTitle(playlist) }));
      await loadPlaylists();
      go({ name: 'playlist', id: `VL${pid}` });
    } catch (err) {
      toastError(err, t('재생목록으로 저장하지 못했습니다'));
    } finally {
      setBusy('');
    }
  };

  const retry = (i: number) => {
    const tr = playlist.tracks[i];
    go({ name: 'search', query: `${tr.title} ${tr.artists.split(',')[0]}` });
  };

  const reMatch = async () => {
    setMatches(new Array(playlist.tracks.length).fill(undefined));
    for (const [i, t] of playlist.tracks.entries()) {
      matchTrack(t, false).then(
        (m) => setMatches((prev) => Object.assign([...prev], { [i]: m })),
        () => setMatches((prev) => Object.assign([...prev], { [i]: { quality: 'none' } })),
      );
    }
  };

  const openLink = (e: FormEvent) => {
    e.preventDefault();
    const pid = playlistIdFrom(link);
    if (!pid) {
      toast(t('Spotify 플레이리스트 링크를 붙여 넣으세요 (open.spotify.com/playlist/…)'), 'error');
      return;
    }
    setLink('');
    go({ name: 'spotify', id: pid });
  };

  const saved = savedPlaylistId(playlist.id);
  const synced = saved && isSynced(playlist.id, found);
  return (
    <div className="page">
      {isChart && <ChartPicker current={id} />}
      <header className="hero hero--chart">
        <Cover src={playlist.cover} size={232} className="hero__art" />
        <div className="hero__text">
          <span className="hero__type">{chartKind(id)} · {t('YouTube Music으로 듣기')}</span>
          <h1 className="hero__title">{chartTitle(playlist)}</h1>
          <div className="hero__meta">
            <span>{playlist.subtitle || 'Spotify'}</span>
            <span>{t('{n}곡', { n: total })}</span>
            {(!chartFor(id) || chartFor(id)?.source === 'spotify') && <span>{t('{date} 기준', { date: todayLabel() })}</span>}
          </div>
          <p className="hero__desc">
            {finished
              ? total - found.length
                ? t('YouTube Music에서 {n}곡을 찾았습니다, {missing}곡은 찾지 못했습니다.', { n: found.length, missing: total - found.length })
                : t('YouTube Music에서 {n}곡을 찾았습니다.', { n: found.length })
              : t('YouTube Music에서 같은 곡을 찾는 중… {done}/{total}', { done, total })}
          </p>
          <div className="progress" aria-hidden={finished}>
            <span style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
          </div>
          <div className="hero__actions">
            <button type="button" className="btn btn--primary btn--play" disabled={!found.length || busy !== ''} onClick={() => playFrom(0)}>
              <Icon name="play" size={18} /> {busy === 'play' ? t('대기열 만드는 중…') : t('1위부터 재생')}
            </button>
            <button type="button" className="btn btn--quiet" disabled={!finished || !found.length || busy !== ''} onClick={save}>
              <Icon name="bookmark" size={17} filled={!!synced} />
              {busy === 'save' ? t('저장하는 중…') : saved ? (synced ? t('내 재생목록과 같음') : t('내 재생목록 업데이트')) : t('내 YouTube Music에 저장')}
            </button>
            <button type="button" className="icon-btn icon-btn--round" aria-label={t('다시 찾기')} data-tip={t('YouTube Music에서 다시 찾기')} onClick={reMatch} disabled={!finished}>
              <Icon name="search" size={18} />
            </button>
          </div>
        </div>
      </header>

      <div className="tracks tracks--chart" role="table">
        {playlist.tracks.map((t, i) => (
          <Row
            key={t.id}
            rank={i + 1}
            title={t.title}
            artists={t.artists}
            durationMs={t.durationMs}
            match={matches[i]}
            onPlay={() => playFrom(i)}
            onRetry={() => retry(i)}
          />
        ))}
      </div>

      <form className="spotify-link" onSubmit={openLink}>
        <label htmlFor="spotify-link" className="spotify-link__label">{t('다른 Spotify 플레이리스트도 들을 수 있습니다')}</label>
        <div className="spotify-link__row">
          <input
            id="spotify-link"
            className="field__input"
            placeholder="https://open.spotify.com/playlist/…"
            value={link}
            onChange={(e) => setLink(e.target.value)}
          />
          <button type="submit" className="btn btn--quiet">{t('열기')}</button>
        </div>
        <p className="field__hint">{t('공개 플레이리스트만 됩니다. 곡 목록은 Spotify 공개 임베드 페이지에서 읽습니다.')}</p>
      </form>
    </div>
  );
}
