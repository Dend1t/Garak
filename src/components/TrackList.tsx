import { memo, useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import { t } from '../i18n';
import { useLang } from '../i18n/react';
import type { Ref, Track } from '../lib/ytm/types';
import { toggleLike, playTrack, useLiked } from '../state/library';
import { go, routeForBrowse } from '../state/nav';
import { formatTime, usePlayer } from '../state/player';
import { openMenu } from '../state/ui';
import { Cover } from './Cover';
import { Icon } from './Icon';
import { trackMenu, type TrackMenuContext } from './menus';

export function ArtistLinks({ artists, className = '' }: { artists: Ref[]; className?: string }) {
  if (!artists.length) return null;
  return (
    <span className={`artist-links ${className}`}>
      {artists.map((a, i) => (
        <span key={`${a.name}${i}`}>
          {i > 0 && ', '}
          {a.id ? (
            <button type="button" className="link" onClick={(e) => { e.stopPropagation(); go(routeForBrowse(a.id!)); }}>
              {a.name}
            </button>
          ) : (
            a.name
          )}
        </span>
      ))}
    </span>
  );
}

function Bars() {
  return (
    <span className="bars" aria-label={t('재생 중')}>
      <i /><i /><i />
    </span>
  );
}

/** 끌어서 순서 바꾸기. 목록이 다시 그려져도 같은 객체라 줄(memo)이 다시 그려지지 않는다. */
interface DragHandlers {
  start: (index: number, e: DragEvent) => void;
  over: (index: number, e: DragEvent) => void;
  drop: (index: number, e: DragEvent) => void;
  end: () => void;
}

interface RowProps extends TrackMenuContext {
  track: Track;
  position: number;
  numbered: boolean;
  showCover: boolean;
  showAlbum: boolean;
  drag?: DragHandlers;
  dropTarget?: boolean;
  /** 재생을 목록이 정한다(정렬한 화면: 보이는 순서대로). 없으면 곡의 원래 맥락으로 재생 */
  onPlay?: (track: Track, position: number) => void;
}

const Row = memo(function Row({ track, position, numbered, showCover, showAlbum, editablePlaylistId, onRemoved, drag, dropTarget, onPlay }: RowProps) {
  const isCurrent = usePlayer((s) => s.videoId === track.videoId);
  const isPlaying = usePlayer((s) => s.videoId === track.videoId && s.playing);
  const liked = useLiked(track.videoId);
  // memo라 부모가 다시 그려도 건너뛰므로, 언어가 바뀌면 직접 다시 그린다.
  useLang();
  const menu = (e: MouseEvent) => {
    e.preventDefault();
    openMenu(e.clientX, e.clientY, trackMenu(track, { editablePlaylistId, onRemoved }));
  };
  const lead = numbered ? (track.index ?? position + 1) : null;
  const play = () => (onPlay ? onPlay(track, position) : void playTrack(track));
  const dragProps = drag && {
    draggable: true,
    onDragStart: (e: DragEvent) => drag.start(position, e),
    onDragOver: (e: DragEvent) => drag.over(position, e),
    onDrop: (e: DragEvent) => drag.drop(position, e),
    onDragEnd: drag.end,
  };
  return (
    <div
      className={`track${isCurrent ? ' is-current' : ''}${track.available ? '' : ' is-unavailable'}${drag ? ' is-draggable' : ''}${dropTarget ? ' is-drop-target' : ''}`}
      role="row"
      onDoubleClick={play}
      onContextMenu={menu}
      {...dragProps}
    >
      {drag && <span className="track__grip" aria-hidden="true" title={t('끌어서 순서 바꾸기')}><Icon name="grip" size={14} /></span>}
      <div className="track__lead" role="cell">
        {showCover && <Cover src={track.thumbnail} size={40} />}
        {lead !== null && !showCover && <span className="track__num">{isPlaying ? <Bars /> : lead}</span>}
        <button type="button" className="track__play" aria-label={t('{title} 재생', { title: track.title })} onClick={play} disabled={!track.available}>
          <Icon name="play" size={16} />
        </button>
        {showCover && isPlaying && <span className="track__cover-bars"><Bars /></span>}
      </div>
      <div className="track__main" role="cell">
        <span className="track__title" title={track.title}>
          {track.title}
          {track.isVideo && <span className="track__badge">{t('영상')}</span>}
        </span>
        <ArtistLinks artists={track.artists} className="track__artists" />
      </div>
      {showAlbum && (
        <div className="track__album" role="cell">
          {track.album?.id ? (
            <button type="button" className="link" onClick={() => go({ name: 'album', id: track.album!.id! })}>{track.album.name}</button>
          ) : (
            track.album?.name
          )}
        </div>
      )}
      <div className="track__tail" role="cell">
        <button
          type="button"
          className={`icon-btn track__like${liked ? ' is-on' : ''}`}
          aria-label={liked ? t('좋아요 취소') : t('좋아요')}
          aria-pressed={liked}
          onClick={() => toggleLike(track)}
        >
          <Icon name="heart" size={17} filled={liked} />
        </button>
        <span className="track__time">{track.duration !== undefined ? formatTime(track.duration) : ''}</span>
        <button type="button" className="icon-btn track__more" aria-label={t('더 보기')} onClick={menu}>
          <Icon name="more" size={18} />
        </button>
      </div>
    </div>
  );
});

interface Props extends TrackMenuContext {
  tracks: Track[];
  /** 재생을 목록이 정한다(정렬한 화면). 없으면 곡의 원래 맥락으로 재생 */
  onPlay?: (track: Track, position: number) => void;
  /** 내 재생목록: 끌어서 순서 바꾸기(from 자리 곡을 to 자리로) */
  onReorder?: (from: number, to: number) => void;
  /** 앨범처럼 수록 순서가 의미 있을 때 번호를 보인다 */
  numbered?: boolean;
  showCover?: boolean;
  showAlbum?: boolean;
  limit?: number;
}

/**
 * 곡 목록. 줄(Row)은 memo라 넘기는 값이 그대로면 다시 그리지 않는다. 좋아요 표시한 곡처럼 수천 줄이 되는 목록에서
 * 곡이 바뀌거나 다음 쪽을 받을 때 줄 전체를 다시 그리지 않도록, 줄에 넘기는 함수는 늘 같은 것이어야 한다.
 */
export function TrackList({ tracks, numbered = false, showCover = true, showAlbum = true, limit, editablePlaylistId, onRemoved, onReorder, onPlay }: Props) {
  const list = limit ? tracks.slice(0, limit) : tracks;
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const reorderRef = useRef(onReorder);
  reorderRef.current = onReorder;
  const handlers = useMemo<DragHandlers>(
    () => ({
      start: (i, e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(i));
        setDrag({ from: i, over: i });
      },
      over: (i, e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setDrag((d) => (d && d.over !== i ? { ...d, over: i } : d));
      },
      drop: (i, e) => {
        e.preventDefault();
        const d = dragRef.current;
        if (d && d.from !== i) reorderRef.current?.(d.from, i);
        setDrag(null);
      },
      end: () => setDrag(null),
    }),
    [],
  );
  return (
    <div className={`tracks${showAlbum ? '' : ' tracks--no-album'}`} role="table">
      {list.map((t, i) => (
        <Row
          key={`${t.videoId}-${t.setVideoId ?? i}`}
          track={t}
          position={i}
          numbered={numbered}
          showCover={showCover}
          showAlbum={showAlbum}
          editablePlaylistId={editablePlaylistId}
          onRemoved={onRemoved}
          drag={onReorder ? handlers : undefined}
          dropTarget={!!drag && drag.over === i && drag.from !== i}
          onPlay={onPlay}
        />
      ))}
    </div>
  );
}
