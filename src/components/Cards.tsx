import { useRef, type MouseEvent } from 'react';
import { t, tk } from '../i18n';
import type { Card, Shelf } from '../lib/ytm/types';
import { playEndpoint } from '../state/library';
import { go, routeForBrowse } from '../state/nav';
import { openMenu } from '../state/ui';
import { Cover } from './Cover';
import { Icon } from './Icon';
import { cardMenu } from './menus';
import { TrackList } from './TrackList';

// 이름은 표시만 해 두고 그릴 때 번역한다.
const KIND_LABEL: Record<string, string> = {
  album: tk('앨범'), single: tk('싱글'), ep: 'EP', playlist: tk('플레이리스트'), artist: tk('아티스트'),
  song: tk('노래'), video: tk('영상'), episode: tk('에피소드'), podcast: tk('팟캐스트'), profile: tk('프로필'), other: '',
};
export const kindLabel = (kind: string) => t(KIND_LABEL[kind] ?? '');

export function CardTile({ card }: { card: Card }) {
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
    <div className={`tile${round ? ' tile--round' : ''}`} onContextMenu={menu}>
      <div className="tile__media">
        <button type="button" className="tile__art" onClick={open} aria-label={card.title}>
          <Cover src={card.thumbnail} size="100%" round={round} />
        </button>
        {card.play && !round && (
          <button
            type="button"
            className="tile__play"
            aria-label={t('{title} 재생', { title: card.title })}
            onClick={() => playEndpoint(card.play!)}
          >
            <Icon name="play" size={20} />
          </button>
        )}
      </div>
      <button type="button" className="tile__title" onClick={open} data-tip={card.title} data-tip-show="overflow">{card.title}</button>
      <div className="tile__sub" data-tip={card.subtitle} data-tip-show="overflow">{card.subtitle || kindLabel(card.kind)}</div>
    </div>
  );
}

/** 가로로 넘기는 카드 줄 */
export function CardRow({ cards }: { cards: Card[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const scroll = (dir: number) => ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.8, behavior: 'smooth' });
  return (
    <div className="row">
      <button type="button" className="row__nav row__nav--prev icon-btn" aria-label={t('이전')} onClick={() => scroll(-1)}>
        <Icon name="back" size={18} />
      </button>
      <div className="row__track" ref={ref}>
        {cards.map((c, i) => <CardTile key={`${c.browseId ?? c.videoId}-${i}`} card={c} />)}
      </div>
      <button type="button" className="row__nav row__nav--next icon-btn" aria-label={t('다음')} onClick={() => scroll(1)}>
        <Icon name="forward" size={18} />
      </button>
    </div>
  );
}

export function CardGrid({ cards }: { cards: Card[] }) {
  return (
    <div className="grid">
      {cards.map((c, i) => <CardTile key={`${c.browseId ?? c.videoId}-${i}`} card={c} />)}
    </div>
  );
}

/** 제목 + 곡 목록 또는 카드 줄 */
export function ShelfView({ shelf, grid = false, trackLimit }: { shelf: Shelf; grid?: boolean; trackLimit?: number }) {
  const more = shelf.more;
  return (
    <section className="shelf">
      {(shelf.title || more) && (
        <header className="shelf__head">
          <h2 className="shelf__title">{shelf.title}</h2>
          {more && (
            <button type="button" className="link shelf__more" onClick={() => go(routeForBrowse(more.browseId, more.params, shelf.title))}>
              {t('모두 보기@목록')}
            </button>
          )}
        </header>
      )}
      {shelf.tracks.length > 0 && <TrackList tracks={shelf.tracks} limit={trackLimit} />}
      {shelf.cards.length > 0 && (grid ? <CardGrid cards={shelf.cards} /> : <CardRow cards={shelf.cards} />)}
    </section>
  );
}
