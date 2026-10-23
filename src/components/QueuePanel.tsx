// 오른쪽 "지금 곡" 패널: 다음 트랙(대기열) · 관련 항목 · 댓글 (YouTube Music 재생 화면의 탭과 같다).
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { t, tk } from '../i18n';
import * as ytm from '../lib/ytm/client';
import type { Card, CommentsPage, QueueItem, Shelf, Track } from '../lib/ytm/types';
import { playEndpoint, playTrack } from '../state/library';
import { go, routeForBrowse } from '../state/nav';
import { usePlayer, formatTime } from '../state/player';
import { describeError } from '../lib/tauri';
import { openMenu, setPanelTab, toastError, togglePanel, useLayout, type PanelTab } from '../state/ui';
import { Cover } from './Cover';
import { Icon } from './Icon';
import { cardMenu, trackMenu } from './menus';

type QueueData = Awaited<ReturnType<typeof ytm.queue>>;

// 이름은 표시만 해 두고 그릴 때 번역한다.
const TABS: { id: PanelTab; label: string }[] = [
  { id: 'queue', label: tk('다음 트랙') },
  { id: 'related', label: tk('관련 항목') },
  { id: 'comments', label: tk('댓글') },
];

/** 대기열·관련 항목의 곡 한 줄. 미니 플레이어는 우클릭 메뉴 없이(withMenu=false) 쓴다. */
export function TrackItem({ track, current = false, onClick, withMenu = true }: { track: Track; current?: boolean; onClick: () => void; withMenu?: boolean }) {
  const menu = (e: MouseEvent) => {
    e.preventDefault();
    openMenu(e.clientX, e.clientY, trackMenu(track));
  };
  return (
    <button type="button" className={`qitem${current ? ' is-current' : ''}`} onClick={onClick} onContextMenu={withMenu ? menu : (e) => e.preventDefault()}>
      <Cover src={track.thumbnail} size={40} />
      <span className="qitem__meta">
        <span className="qitem__title">{track.title}</span>
        <span className="qitem__artist">{track.artists.map((a) => a.name).join(', ')}</span>
      </span>
      <span className="qitem__time">{track.duration !== undefined ? formatTime(track.duration) : ''}</span>
    </button>
  );
}

/** 지금 대기열(큰 창 패널·미니 플레이어 공용): 곡이 바뀌면, 그리고 8초마다 다시 읽는다. */
export function useQueue() {
  const videoId = usePlayer((s) => s.videoId);
  const [data, setData] = useState<QueueData | null>(null);
  const [error, setError] = useState(false);
  const lastText = useRef('');

  const refresh = useCallback(() => {
    ytm.queue().then(
      (q) => {
        // 8초마다 다시 읽지만 대개 그대로다. 바뀌었을 때만 새로 그린다.
        const text = JSON.stringify(q);
        if (text !== lastText.current) {
          lastText.current = text;
          setData(q);
        }
        setError(false);
      },
      (err) => {
        console.warn('[queue]', err);
        setError(true);
      },
    );
  }, []);

  // 곡이 바뀌면 대기열을 다시 읽는다(자동 재생으로 뒤가 늘어나기도 한다).
  // 창이 가려져 있는 동안은 쉬고, 다시 보이면 바로 읽는다.
  useEffect(() => {
    refresh();
    const timer = window.setInterval(() => !document.hidden && refresh(), 8000);
    const onVisible = () => !document.hidden && refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [videoId, refresh]);

  const jump = (index: number) =>
    ytm.queueJump(index).then(() => setTimeout(refresh, 600), (err) => toastError(err, t('그 곡으로 가지 못했습니다')));

  const items = data?.items ?? [];
  const current = items.findIndex((i) => i?.selected);
  const now = current >= 0 ? (items[current] as QueueItem) : undefined;
  const upcoming = items.map((item, index) => ({ item, index })).slice(current + 1).filter((x): x is { item: QueueItem; index: number } => !!x.item);
  const automix = data?.automix ?? [];
  return { data, error, items, now, upcoming, automix, jump };
}

function QueueTab() {
  const { data, error, items, now, upcoming, automix, jump } = useQueue();

  if (error && !data) return <p className="panel__empty">{t('대기열을 읽지 못했습니다.')}</p>;
  if (!data) return <p className="panel__empty">{t('불러오는 중…')}</p>;
  if (items.length === 0) return <p className="panel__empty">{t('곡을 재생하면 다음에 나올 곡이 여기에 쌓입니다.')}</p>;
  return (
    <>
      {now && (
        <>
          <h3 className="panel__section">{t('지금 재생 중')}</h3>
          <TrackItem track={now.track} current onClick={() => undefined} />
        </>
      )}
      {upcoming.length > 0 && <h3 className="panel__section">{t('다음 곡')}</h3>}
      {upcoming.map(({ item, index }) => <TrackItem key={`q-${index}-${item.track.videoId}`} track={item.track} onClick={() => jump(index)} />)}
      {automix.length > 0 && <h3 className="panel__section">{t('이어서 자동 재생')}</h3>}
      {automix.map((track, i) => <TrackItem key={`a-${i}-${track.videoId}`} track={track} onClick={() => playTrack(track)} />)}
    </>
  );
}

function CardItem({ card }: { card: Card }) {
  const open = () => {
    if (card.browseId) go(routeForBrowse(card.browseId, card.params, card.title));
    else if (card.play) void playEndpoint(card.play);
  };
  const menu = (e: MouseEvent) => {
    e.preventDefault();
    const entries = cardMenu(card);
    if (entries.length) openMenu(e.clientX, e.clientY, entries);
  };
  const round = card.kind === 'artist' || card.kind === 'profile';
  return (
    <button type="button" className="pcard" onClick={open} onContextMenu={menu}>
      <Cover src={card.thumbnail} size="100%" round={round} />
      <span className="pcard__title" data-tip={card.title} data-tip-show="overflow">{card.title}</span>
      <span className="pcard__sub">{card.subtitle}</span>
    </button>
  );
}

function RelatedTab() {
  const videoId = usePlayer((s) => s.videoId);
  const ad = usePlayer((s) => s.ad);
  const [state, setState] = useState<{ id: string; shelves?: Shelf[]; error?: string }>({ id: '' });
  useEffect(() => {
    if (!videoId || ad) return;
    let alive = true;
    setState({ id: videoId });
    ytm.related(videoId).then(
      (r) => alive && setState({ id: videoId, shelves: r.shelves }),
      (err) => alive && setState({ id: videoId, error: describeError(err) }),
    );
    return () => {
      alive = false;
    };
  }, [videoId, ad]);

  if (!videoId) return <p className="panel__empty">{t('곡을 재생하면 비슷한 곡과 아티스트가 여기에 나옵니다.')}</p>;
  if (state.error) return <p className="panel__empty">{t('관련 항목을 불러오지 못했습니다: {error}', { error: state.error })}</p>;
  if (!state.shelves || state.id !== videoId) return <p className="panel__empty">{t('불러오는 중…')}</p>;
  if (!state.shelves.length) return <p className="panel__empty">{t('이 곡은 관련 항목이 없습니다.')}</p>;
  return (
    <>
      {state.shelves.map((s, i) => (
        <section key={`${s.title}-${i}`} className="psection">
          <h3 className="panel__section">{s.title}</h3>
          {s.tracks.slice(0, 10).map((track, j) => <TrackItem key={`${track.videoId}-${j}`} track={track} onClick={() => playTrack(track)} />)}
          {s.cards.length > 0 && (
            <div className="pcards">
              {s.cards.slice(0, 6).map((c, j) => <CardItem key={`${c.browseId ?? c.videoId}-${j}`} card={c} />)}
            </div>
          )}
        </section>
      ))}
    </>
  );
}

function CommentsTab() {
  const videoId = usePlayer((s) => s.videoId);
  const ad = usePlayer((s) => s.ad);
  const [state, setState] = useState<{ id: string; page?: CommentsPage; error?: string; busy?: boolean }>({ id: '' });
  useEffect(() => {
    if (!videoId || ad) return;
    let alive = true;
    setState({ id: videoId });
    ytm.comments(videoId).then(
      (page) => alive && setState({ id: videoId, page }),
      (err) => alive && setState({ id: videoId, error: describeError(err) }),
    );
    return () => {
      alive = false;
    };
  }, [videoId, ad]);

  const more = async () => {
    const token = state.page?.continuation;
    if (!token || state.busy) return;
    setState((s) => ({ ...s, busy: true }));
    try {
      const next = await ytm.commentsMore(token);
      setState((s) => (s.id === videoId && s.page ? { ...s, busy: false, page: { ...s.page, comments: [...s.page.comments, ...next.comments], continuation: next.continuation } } : s));
    } catch (err) {
      toastError(err, t('댓글을 더 불러오지 못했습니다'));
      setState((s) => ({ ...s, busy: false }));
    }
  };

  if (!videoId) return <p className="panel__empty">{t('곡을 재생하면 댓글이 여기에 나옵니다.')}</p>;
  if (state.error) return <p className="panel__empty">{t('댓글을 불러오지 못했습니다: {error}', { error: state.error })}</p>;
  if (!state.page || state.id !== videoId) return <p className="panel__empty">{t('불러오는 중…')}</p>;
  if (!state.page.comments.length) return <p className="panel__empty">{t('댓글이 없거나 댓글을 막은 곡입니다.')}</p>;
  return (
    <>
      {state.page.countText && <h3 className="panel__section">{state.page.countText}</h3>}
      <ul className="comments">
        {state.page.comments.map((c) => (
          <li key={c.id} className="comment">
            <Cover src={c.avatar} size={32} round />
            <div className="comment__body">
              <div className="comment__head">
                <span className={`comment__author${c.isArtist ? ' is-artist' : ''}`}>{c.author}</span>
                <span className="comment__time">{c.published}</span>
              </div>
              <p className="comment__text">{c.text}</p>
              {(c.likes || c.replies) && (
                <div className="comment__meta">
                  {c.likes && <span><Icon name="heart" size={12} /> {c.likes}</span>}
                  {c.replies && <span><Icon name="comment" size={12} /> {t('답글 {n}', { n: c.replies })}</span>}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
      {state.page.continuation && (
        <button type="button" className="btn btn--quiet comments__more" disabled={state.busy} onClick={more}>
          {state.busy ? t('불러오는 중…') : t('댓글 더 보기')}
        </button>
      )}
    </>
  );
}

export function QueuePanel() {
  const tab = useLayout((s) => s.panelTab);
  return (
    <aside className="panel" aria-label={t('지금 곡')}>
      <header className="panel__head">
        <div className="panel__tabs" role="tablist" aria-label={t('지금 곡')}>
          {TABS.map((item) => (
            <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={`panel__tab${tab === item.id ? ' is-on' : ''}`} onClick={() => setPanelTab(item.id)}>
              {t(item.label)}
            </button>
          ))}
        </div>
        <button type="button" className="icon-btn" aria-label={t('패널 닫기')} onClick={() => togglePanel('queue')}>
          <Icon name="close" size={18} />
        </button>
      </header>
      <div className="panel__body" role="tabpanel">
        {tab === 'queue' ? <QueueTab /> : tab === 'related' ? <RelatedTab /> : <CommentsTab />}
      </div>
    </aside>
  );
}
