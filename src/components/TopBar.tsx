import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { t } from '../i18n';
import * as ytm from '../lib/ytm/client';
import { modKey } from '../lib/keys';
import { parseLink, type LinkTarget } from '../lib/ytm/links';
import type { Suggestions } from '../lib/ytm/types';
import { playEndpoint, playTrack } from '../state/library';
import { back, forward, go, replace, routeForBrowse, useCanGo, useRoute } from '../state/nav';
import { toast } from '../state/ui';
import { Cover } from './Cover';
import { Icon, type IconName } from './Icon';

/** 다른 곳(메뉴·단축키)에서 검색창에 초점을 줄 때 쓴다. */
export const focusSearch = () => document.querySelector<HTMLInputElement>('#search-input')?.focus();

/** 붙여 넣은 링크로 할 일(검색창 아래에 보여 주는 이름과 아이콘) */
function linkAction(link: LinkTarget): { icon: IconName; label: string } {
  switch (link.kind) {
    case 'track':
      return { icon: 'play', label: t('링크의 곡 재생') };
    case 'playlist':
      // 앨범 공유 링크(OLAK5uy_…)는 목록 화면이 앨범 화면으로 바꿔 연다(CollectionView).
      if (link.browseId.startsWith('VLOLAK5uy_')) return { icon: 'note', label: t('앨범 열기') };
      return { icon: 'queue', label: link.browseId === 'VLLM' ? t('좋아요 표시한 곡 열기') : t('플레이리스트 열기') };
    case 'album':
      return { icon: 'note', label: t('앨범 열기') };
    case 'artist':
      return { icon: 'radio', label: t('아티스트 열기') };
    case 'browse':
      return { icon: 'link', label: t('링크 열기') };
    case 'search':
      return { icon: 'search', label: t('{query} 검색', { query: link.query }) };
    case 'spotify':
      return { icon: 'chart', label: t('Spotify 플레이리스트 열기') };
  }
}

/** 링크 열기: 곡은 바로 재생(목록 링크면 그 목록 안에서, 아니면 그 곡의 믹스로), 나머지는 그 화면으로. */
function openLink(link: LinkTarget) {
  switch (link.kind) {
    case 'track': {
      const watch: Record<string, unknown> = link.playlistId
        ? { videoId: link.videoId, playlistId: link.playlistId }
        : { videoId: link.videoId, playlistId: `RDAMVM${link.videoId}`, params: 'wAEB' };
      if (link.start) watch.startTimeSeconds = link.start;
      toast(t('링크의 곡을 재생합니다'));
      void playEndpoint({ watchEndpoint: watch });
      return;
    }
    case 'search':
      go({ name: 'search', query: link.query });
      return;
    case 'spotify':
      go({ name: 'spotify', id: link.playlistId });
      return;
    default:
      go(routeForBrowse(link.browseId));
  }
}

function SearchBox() {
  const route = useRoute();
  const routeQuery = route.name === 'search' ? route.query : '';
  const [value, setValue] = useState(routeQuery);
  const [open, setOpen] = useState(false);
  const [sugg, setSugg] = useState<Suggestions | null>(null);
  const [cursor, setCursor] = useState(-1);
  const timer = useRef(0);

  useEffect(() => setValue(routeQuery), [routeQuery]);
  // 붙여 넣은 YouTube Music·YouTube·Spotify 링크면 검색 대신 그 곡·목록을 연다.
  const link = useMemo(() => parseLink(value), [value]);
  useEffect(() => {
    clearTimeout(timer.current);
    const q = value.trim();
    if (!q || q === routeQuery || link) {
      setSugg(null);
      return;
    }
    timer.current = window.setTimeout(() => {
      ytm.suggestions(q).then(setSugg, () => setSugg(null));
    }, 180);
    return () => clearTimeout(timer.current);
  }, [value, routeQuery, link]);

  const submit = (q: string) => {
    const query = q.trim();
    if (!query) return;
    setOpen(false);
    setValue(query);
    if (route.name === 'search' && !route.query) replace({ name: 'search', query });
    else go({ name: 'search', query });
  };

  const followLink = (target: LinkTarget, input: HTMLInputElement | null) => {
    setOpen(false);
    setCursor(-1);
    // 검색 화면에 있었으면 그 검색어로 되돌린다(다른 화면으로 옮기면 검색어가 비워진다).
    setValue(routeQuery);
    input?.blur();
    openLink(target);
  };

  const queries = sugg?.queries.slice(0, 6) ?? [];
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setCursor((c) => Math.min(queries.length - 1, c + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(-1, c - 1));
    } else if (e.key === 'Enter') {
      if (link) {
        e.preventDefault();
        followLink(link, e.currentTarget);
        return;
      }
      submit(cursor >= 0 && queries[cursor] ? queries[cursor] : value);
      setCursor(-1);
    } else if (e.key === 'Escape') {
      setOpen(false);
      (e.target as HTMLInputElement).blur();
    }
  };

  const showDrop = open && sugg && (queries.length || sugg.tracks.length || sugg.cards.length);
  const action = link ? linkAction(link) : undefined;
  return (
    <div className="searchbox" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}>
      <Icon name="search" size={18} className="searchbox__icon" />
      <input
        id="search-input"
        className="searchbox__input"
        type="search"
        placeholder={t('노래, 앨범, 아티스트 검색')}
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setOpen(true);
          setCursor(-1);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
        aria-expanded={!!showDrop || (open && !!link)}
        aria-controls="search-suggestions"
      />
      {open && link && action ? (
        <div className="suggest" id="search-suggestions" role="listbox">
          <button
            type="button"
            role="option"
            aria-selected="true"
            className="suggest__item suggest__link is-on"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => followLink(link, document.querySelector<HTMLInputElement>('#search-input'))}
          >
            <span className="suggest__link-icon" aria-hidden="true"><Icon name={action.icon} size={18} /></span>
            <span>
              <b>{action.label}</b>
              <small>{t('Enter를 누르면 앱에서 엽니다')}</small>
            </span>
          </button>
        </div>
      ) : showDrop ? (
        <div className="suggest" id="search-suggestions" role="listbox">
          {queries.map((q, i) => (
            <button key={q} type="button" role="option" aria-selected={i === cursor} className={`suggest__query${i === cursor ? ' is-on' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => submit(q)}>
              <Icon name="search" size={15} />
              {q}
            </button>
          ))}
          {(sugg!.cards.length > 0 || sugg!.tracks.length > 0) && <div className="suggest__sep" />}
          {sugg!.cards.slice(0, 3).map((c) => (
            <button
              key={c.browseId}
              type="button"
              className="suggest__item"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setOpen(false);
                if (c.browseId) go(routeForBrowse(c.browseId, c.params, c.title));
              }}
            >
              <Cover src={c.thumbnail} size={36} round={c.kind === 'artist'} />
              <span><b>{c.title}</b><small>{c.subtitle}</small></span>
            </button>
          ))}
          {sugg!.tracks.slice(0, 3).map((track) => (
            <button
              key={track.videoId}
              type="button"
              className="suggest__item"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setOpen(false);
                void playTrack(track);
              }}
            >
              <Cover src={track.thumbnail} size={36} />
              <span><b>{track.title}</b><small>{track.artists.map((a) => a.name).join(', ')}</small></span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function TopBar() {
  const can = useCanGo();
  return (
    // 맥은 제목 막대가 없어 이 줄로 창을 끈다. 단추·검색칸 말고 어디를 눌러도 끌리게 deep(Tauri가 누를 수 있는 요소는 뺀다).
    <div className="topbar" data-tauri-drag-region="deep">
      <div className="topbar__nav">
        <button type="button" className="icon-btn icon-btn--round" aria-label={t('뒤로')} data-tip-key={modKey('[')} data-tip-side="bottom" disabled={!(can & 1)} onClick={back}>
          <Icon name="back" size={18} />
        </button>
        <button type="button" className="icon-btn icon-btn--round" aria-label={t('앞으로')} data-tip-key={modKey(']')} data-tip-side="bottom" disabled={!(can & 2)} onClick={forward}>
          <Icon name="forward" size={18} />
        </button>
      </div>
      <SearchBox />
    </div>
  );
}
