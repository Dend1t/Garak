import { createElement, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { locale, t, tk } from '../i18n';
import { matchesTerms, searchTerms } from '../lib/textMatch';
import { sortTracks, TRACK_SORTS, type TrackSort } from '../lib/trackSort';
import { useAsync } from '../lib/useAsync';
import * as ytm from '../lib/ytm/client';
import type { Collection, Track } from '../lib/ytm/types';
import { addTracksToPlaylist, deletePlaylist, enqueue, playEndpoint, playInOrder, playTrack, setSaved, useLibrary } from '../state/library';
import { toast, toastError } from '../state/ui';
import { formatTime, usePlayer } from '../state/player';
import { go, replace } from '../state/nav';
import { openDialog, openMenu, type MenuEntry } from '../state/ui';
import { ShelfView } from '../components/Cards';
import { Cover } from '../components/Cover';
import { ConfirmDialog, RenamePlaylistDialog } from '../components/Dialogs';
import { Icon } from '../components/Icon';
import { ArtistLinks, TrackList } from '../components/TrackList';
import { addToPlaylistEntry } from '../components/menus';
import { Empty, ErrorState, LoadMore, Loading } from './common';

type Kind = 'album' | 'playlist' | 'liked';

/** 내 재생목록 아래 "추천 곡"(YouTube Music이 고른 곡). 누르면 재생, +로 넣기. */
function Suggestions({ playlistId, title, continuation, revision }: { playlistId: string; title: string; continuation: NonNullable<Collection['sectionsContinuation']>; revision: number }) {
  const res = useAsync(`sugg:${playlistId}:${revision}`, () => ytm.playlistSections(continuation));
  const [added, setAdded] = useState<Set<string>>(new Set());
  const tracks = (res.data ?? []).flatMap((s) => s.tracks).filter((t) => !added.has(t.videoId));
  if (res.error || (!res.loading && !tracks.length)) return null;
  return (
    <section className="shelf suggest-shelf">
      <header className="shelf__head">
        <h2 className="shelf__title">{t('추천 곡')}</h2>
        <button type="button" className="link shelf__more" onClick={res.reload}>{t('다른 곡 보기')}</button>
      </header>
      {res.loading && !res.data ? (
        <Loading />
      ) : (
        <div className="tracks tracks--no-album" role="table">
          {tracks.map((tr) => (
            <div key={tr.videoId} className="track" role="row" onDoubleClick={() => playTrack(tr)}>
              <div className="track__lead" role="cell"><Cover src={tr.thumbnail} size={40} /></div>
              <div className="track__main" role="cell">
                <span className="track__title">{tr.title}</span>
                <span className="track__artists">{tr.artists.map((a) => a.name).join(', ')}</span>
              </div>
              <div className="track__tail" role="cell">
                <span className="track__time">{tr.duration !== undefined ? formatTime(tr.duration) : ''}</span>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={t('{title} 이 재생목록에 넣기', { title: tr.title })}
                  data-tip={t('이 재생목록에 넣기')}
                  onClick={async () => {
                    setAdded((s) => new Set(s).add(tr.videoId));
                    await addTracksToPlaylist({ playlistId, title }, [tr]);
                  }}
                >
                  <Icon name="plus" size={18} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** 목록 찾기에 쓰는 글: 제목·아티스트·앨범 */
const haystack = (track: Track) => [track.title, ...track.artists.map((a) => a.name), track.album?.name ?? ''].join(' ');

// 이름은 표시만 해 두고 그릴 때 번역한다.
const SORT_LABEL: Record<TrackSort, string> = {
  default: tk('기본 순서'),
  title: tk('제목순'),
  artist: tk('아티스트순'),
  album: tk('앨범순'),
  duration: tk('길이순'),
};

/**
 * 곡 목록 위 도구: 목록 안에서 찾기·정렬(곡이 많으면 나머지를 마저 불러온다), 지금 재생 중인 곡으로 가기.
 */
function ListTools({ filter, onFilter, sort, onSort, found, loadingRest, canLocate, onLocate }: {
  filter: string;
  onFilter: (value: string) => void;
  sort: TrackSort;
  onSort: (value: TrackSort) => void;
  found: number;
  loadingRest: boolean;
  canLocate: boolean;
  onLocate: () => void;
}) {
  const filtering = filter.trim() !== '';
  return (
    <div className="list-tools">
      <div className="list-filter">
        <Icon name="search" size={16} className="list-filter__icon" />
        <input
          className="list-filter__input"
          type="search"
          value={filter}
          placeholder={t('목록에서 찾기')}
          aria-label={t('목록에서 찾기')}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => onFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && filter) {
              e.preventDefault();
              onFilter('');
            }
          }}
        />
      </div>
      <label className="list-sort">
        <select className="list-sort__select" value={sort} aria-label={t('정렬')} onChange={(e) => onSort(e.target.value as TrackSort)}>
          {TRACK_SORTS.map((id) => (
            <option key={id} value={id}>{t(SORT_LABEL[id])}</option>
          ))}
        </select>
        <Icon name="down" size={14} className="list-sort__icon" />
      </label>
      {(filtering || loadingRest) && (
        <span className="list-tools__status" role="status">
          {filtering && t('{n}곡 찾음', { n: found })}
          {loadingRest && `${filtering ? ' · ' : ''}${t('나머지 곡을 불러오는 중…')}`}
        </span>
      )}
      <span className="list-tools__gap" />
      {canLocate && (
        <button type="button" className="btn btn--quiet btn--sm" onClick={onLocate}>
          <Icon name="locate" size={15} /> {t('지금 재생 중인 곡')}
        </button>
      )}
    </div>
  );
}

function load(kind: Kind, id: string): Promise<Collection> {
  if (kind === 'album') return ytm.album(id);
  if (kind === 'liked') return ytm.likedSongs();
  return ytm.playlist(id);
}

export function CollectionView({ kind, id = '' }: { kind: Kind; id?: string }) {
  // 플레이리스트는 곡을 넣고 빼면 다시 불러온다(보관함 변경 번호를 열쇠에 넣는다).
  const revision = useLibrary((s) => s.revision);
  const key = kind === 'album' ? `album:${id}` : `${kind}:${id}:${revision}`;
  const res = useAsync(key, () => load(kind, id));
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<TrackSort>('default');
  // 찾는 글을 칠 때마다 수천 줄을 거르고 다시 그리느라 입력이 끊기지 않게, 목록은 한 박자 늦게(입력이 멈춘 틈에) 따라간다.
  const deferredFilter = useDeferredValue(filter);
  const terms = useMemo(() => searchTerms(deferredFilter), [deferredFilter]);
  const filtering = terms.length > 0;
  const sorting = sort !== 'default';
  /** 찾거나 정렬하는 동안은 목록 전체가 필요하다(나머지 쪽을 마저 받는다) */
  const needAll = filtering || sorting;
  const playingId = usePlayer((s) => s.videoId);
  const listBox = useRef<HTMLDivElement>(null);
  const continuation = res.data?.continuation;

  /** 곡 목록 이어받기(끝까지 내렸을 때, 또는 찾는 동안 나머지를 마저) */
  const more = async () => {
    const c = res.data?.continuation;
    if (!c || busy) return;
    setBusy(true);
    try {
      const page = await ytm.playlistMore(c);
      // 빈 쪽에 같은 이어받기 값만 다시 오면 더 받지 않는다(끝없이 묻지 않게).
      const stuck = page.tracks.length === 0 && page.continuation?.token === c.token;
      // 기다리는 동안 목록이 새로 불러와졌으면(좋아요·곡 넣기 등으로) 이전 목록의 다음 쪽은 버린다(곡이 겹치지 않게).
      res.setData((prev) =>
        prev.continuation?.token !== c.token
          ? prev
          : { ...prev, tracks: [...prev.tracks, ...page.tracks], continuation: stuck ? undefined : page.continuation },
      );
    } catch (err) {
      console.warn('[collection] 더 불러오기 실패', err);
      res.setData((prev) => (prev.continuation?.token !== c.token ? prev : { ...prev, continuation: undefined }));
    } finally {
      setBusy(false);
    }
  };

  // 찾거나 정렬하는 동안에는 아직 안 불러온 곡도 들어가도록 나머지 쪽을 차례로 받는다(둘 다 그만두면 멈춘다).
  useEffect(() => {
    if (needAll && continuation && !busy) void more();
    // more는 그릴 때마다 새로 만들어지지만, 필요한 값(이어받기·busy)이 바뀔 때만 다시 부른다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needAll, continuation, busy]);

  // 앨범 재생목록(OLAK5uy_…, YouTube Music의 앨범 공유 링크)은 머리말 없이 곡만 온다(2026-10-16 확인).
  // 곡들이 모두 한 앨범이면 그 앨범 화면으로 바꿔 연다(YouTube Music 웹도 앨범 화면으로 연다).
  const albumRedirect = useMemo(() => {
    const d = res.data;
    if (kind !== 'playlist' || !/^(VL)?OLAK5uy_/.test(id) || !d || d.header.title) return undefined;
    const ids = new Set(d.tracks.map((track) => track.album?.id).filter((x): x is string => !!x));
    return ids.size === 1 ? [...ids][0] : undefined;
  }, [kind, id, res.data]);
  useEffect(() => {
    if (albumRedirect) replace({ name: 'album', id: albumRedirect });
  }, [albumRedirect]);

  const allTracks = res.data?.tracks;
  const shown = useMemo(() => {
    const list = filtering ? (allTracks ?? []).filter((track) => matchesTerms(haystack(track), terms)) : (allTracks ?? []);
    return sortTracks(list, sort, locale());
  }, [allTracks, terms, filtering, sort]);
  // 정렬한 화면에서는 보이는 순서대로 재생한다(누른 곡부터). 재생할 수 없는 곡은 원래처럼 알림만 띄운다.
  // 목록이 바뀌어도 같은 함수를 넘겨 줄 전체가 다시 그려지지 않게 지금 목록은 ref로 읽는다.
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const playShown = useCallback(
    (track: Track, index: number) => void (track.available ? playInOrder(shownRef.current.slice(index)) : playTrack(track)),
    [],
  );
  const setData = res.setData;
  const onRemoved = useCallback(
    (track: Track) => setData((prev) => ({ ...prev, tracks: prev.tracks.filter((t) => t.setVideoId !== track.setVideoId) })),
    [setData],
  );

  if ((res.loading && !res.data) || albumRedirect) return <div className="page"><Loading /></div>;
  if (res.error) return <div className="page"><ErrorState message={res.error} onRetry={res.reload} /></div>;
  const data = res.data;
  if (!data) return null;
  const h = data.header;
  const title = kind === 'liked' ? t('좋아요 표시한 곡') : h.title;
  const playlistId = h.playlistId ?? (kind === 'playlist' && id.startsWith('VL') ? id.slice(2) : undefined) ?? (kind === 'liked' ? 'LM' : undefined);
  const isSaved = !!h.saved;
  const editable = h.editable && kind === 'playlist';

  const playAll = () => {
    if (sorting) void playInOrder(shown);
    else if (h.play) void playEndpoint(h.play);
    else if (playlistId) void playEndpoint({ watchPlaylistEndpoint: { playlistId } });
    else if (data.tracks[0]) void playTrack(data.tracks[0]);
  };
  const shuffle = () => {
    if (h.shuffle) void playEndpoint(h.shuffle, t('셔플 재생'));
    else if (playlistId) void playEndpoint({ watchPlaylistEndpoint: { playlistId, params: 'wAEB8gECKAE%3D' } }, t('셔플 재생'));
  };

  /** 끌어서 순서 바꾸기: 옮긴 곡을 새 자리 다음 곡 앞으로(맨 끝이면 맨 뒤로) */
  const reorder = async (from: number, to: number) => {
    if (!playlistId) return;
    const list = [...data.tracks];
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    const successor = list[to + 1];
    if (!moved?.setVideoId || (!successor && data.continuation)) {
      toast(t('목록을 끝까지 불러온 뒤 맨 끝으로 옮길 수 있습니다'), 'error');
      return;
    }
    res.setData((prev) => ({ ...prev, tracks: list }));
    try {
      await ytm.movePlaylistItem(playlistId, moved.setVideoId, successor?.setVideoId);
    } catch (err) {
      toastError(err, t('순서를 바꾸지 못했습니다'));
      res.reload();
    }
  };

  const menu = (e: MouseEvent) => {
    const entries: MenuEntry[] = [];
    if (playlistId) {
      entries.push(
        { label: t('다음에 재생'), action: () => enqueue({ playlistId }, title, 'next') },
        { label: t('대기열 끝에 추가'), action: () => enqueue({ playlistId }, title, 'end') },
      );
    }
    if (h.radio) entries.push({ label: t('믹스 시작'), action: () => playEndpoint(h.radio!, t('믹스를 시작')) });
    if (data.tracks.length) entries.push(addToPlaylistEntry(data.tracks.filter((t) => t.available)));
    if (editable && playlistId) {
      entries.push(
        { label: '', separator: true },
        { label: t('정보 바꾸기…'), action: () => openDialog(createElement(RenamePlaylistDialog, { playlistId, title: h.title, description: h.description, onDone: res.reload })) },
        {
          label: t('플레이리스트 삭제…'),
          danger: true,
          action: () =>
            openDialog(
              createElement(ConfirmDialog, {
                title: t('플레이리스트 삭제'),
                message: t('{title|을} 삭제합니다. 되돌릴 수 없습니다.', { title: h.title }),
                confirmLabel: t('삭제'),
                onConfirm: async () => {
                  const ok = await deletePlaylist(playlistId, h.title);
                  if (ok) go({ name: 'library' });
                  return ok;
                },
              }),
            ),
        },
      );
    }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu(r.left, r.bottom + 6, entries);
  };

  const canSave = !!playlistId && !editable && kind !== 'liked';
  // 목록 도구는 곡이 많아지는 플레이리스트·좋아요 표시한 곡에만(앨범은 짧다)
  const showTools = kind !== 'album' && (data.tracks.length > 1 || needAll);
  const loadingRest = needAll && !!data.continuation;
  const canLocate = !!playingId && shown.some((track) => track.videoId === playingId);
  const locate = () => {
    const row = listBox.current?.querySelector<HTMLElement>('.track.is-current');
    // 부드러운 스크롤은 화면이 그려질 때만 움직이므로, 동작 줄이기 설정이거나 창이 가려져 있으면 바로 옮긴다.
    const smooth = document.visibilityState === 'visible' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    row?.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
  };
  return (
    <div className="page">
      <header className="hero">
        {kind === 'liked' ? (
          <div className="hero__art hero__art--liked" aria-hidden="true"><Icon name="heart" size={72} filled /></div>
        ) : (
          <Cover src={h.thumbnail} size={232} className="hero__art" />
        )}
        <div className="hero__text">
          <span className="hero__type">{kind === 'liked' ? t('자동 플레이리스트') : h.typeLabel || (kind === 'album' ? t('앨범') : t('플레이리스트'))}</span>
          <h1 className="hero__title">{title}</h1>
          <div className="hero__meta">
            <ArtistLinks artists={h.artists} className="hero__artists" />
            {h.year && <span>{h.year}</span>}
            {h.stats && <span>{h.stats}</span>}
          </div>
          {h.description && <p className="hero__desc">{h.description}</p>}
          <div className="hero__actions">
            <button type="button" className="btn btn--primary btn--play" onClick={playAll} disabled={!data.tracks.length && !h.play}>
              <Icon name="play" size={18} /> {t('재생')}
            </button>
            <button type="button" className="btn btn--quiet" onClick={shuffle} disabled={!h.shuffle && !playlistId}>
              <Icon name="shuffle" size={17} /> {t('셔플')}
            </button>
            {canSave && (
              <button
                type="button"
                className={`btn btn--quiet${isSaved ? ' is-on' : ''}`}
                onClick={async () => {
                  const next = !isSaved;
                  // 기억해 둔 화면 값(useAsync)도 함께 고친다. 다른 화면에 갔다 와도 저장 표시가 맞게.
                  if (await setSaved(playlistId!, title, next)) res.setData((prev) => ({ ...prev, header: { ...prev.header, saved: next } }));
                }}
              >
                <Icon name="bookmark" size={17} filled={!!isSaved} /> {isSaved ? t('보관함에 있음') : t('보관함에 저장')}
              </button>
            )}
            <button type="button" className="icon-btn icon-btn--round" aria-label={t('더 보기')} onClick={menu}>
              <Icon name="more" size={20} />
            </button>
          </div>
        </div>
      </header>

      {showTools && (
        <ListTools filter={filter} onFilter={setFilter} sort={sort} onSort={setSort} found={shown.length} loadingRest={loadingRest} canLocate={canLocate} onLocate={locate} />
      )}
      {data.tracks.length === 0 ? (
        <Empty title={kind === 'liked' ? t('아직 좋아요 표시한 곡이 없습니다') : t('곡이 없습니다')}>
          <p>{kind === 'liked' ? t('곡 옆의 하트를 누르면 여기에 모입니다.') : editable ? t('곡의 ⋯ 메뉴에서 "플레이리스트에 추가"를 고르세요.') : ''}</p>
        </Empty>
      ) : shown.length === 0 ? (
        loadingRest ? (
          <Loading label={t('나머지 곡을 불러오는 중…')} />
        ) : (
          <Empty title={t('{query|와} 맞는 곡이 없습니다', { query: filter.trim() })}>
            <p>{t('다른 낱말로 찾거나 초성(ㅂㅍㅈ)으로 찾아보세요.')}</p>
          </Empty>
        )
      ) : (
        <div ref={listBox}>
          <TrackList
            tracks={shown}
            numbered={kind === 'album'}
            showCover={kind !== 'album'}
            showAlbum={kind !== 'album'}
            editablePlaylistId={editable ? playlistId : undefined}
            onRemoved={onRemoved}
            // 찾거나 정렬하는 중에는 보이는 자리와 실제 자리가 달라 순서 바꾸기를 끈다.
            onReorder={!needAll && editable && playlistId && data.tracks.every((t) => t.setVideoId) ? reorder : undefined}
            onPlay={sorting ? playShown : undefined}
          />
        </div>
      )}
      {!filtering && editable && playlistId && data.sectionsContinuation && (
        <Suggestions playlistId={playlistId} title={h.title} continuation={data.sectionsContinuation} revision={revision} />
      )}
      {data.continuation && !needAll && <LoadMore onReach={more} busy={busy} />}
      {!filtering && data.shelves.map((s, i) => <ShelfView key={`${s.title}-${i}`} shelf={s} />)}
    </div>
  );
}
