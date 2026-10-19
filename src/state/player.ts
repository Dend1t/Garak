// 재생 상태: 엔진이 보내는 값 + 그 사이 재생 위치를 시계로 이어서 계산.
import { useEffect, useRef, useState } from 'react';
import { createStore, useStore } from '../lib/store';
import { getPlayerState, onPlayerState, type PlayerState } from '../lib/tauri';
import { flushPlays, recordState } from '../lib/stats';

export const EMPTY_PLAYER: PlayerState = {
  videoId: '',
  title: '',
  artist: '',
  album: '',
  artwork: '',
  duration: 0,
  position: 0,
  playing: false,
  buffering: false,
  ad: false,
  likeStatus: 'INDIFFERENT',
  repeat: 'NONE',
  volume: 100,
  muted: false,
  at: 0,
};

export const playerStore = createStore<PlayerState>(EMPTY_PLAYER);

/** 화면에서 바로 바꾼 값(탐색 막대를 놓은 직후 등)을 엔진 답이 오기 전까지 보여 준다. */
export function patchPlayer(patch: Partial<PlayerState>) {
  playerStore.set((s) => ({ ...s, ...patch, at: Date.now() }));
}

export async function startPlayerSync(record = true) {
  const first = await getPlayerState();
  if (first && typeof first === 'object' && 'videoId' in first) playerStore.set({ ...EMPTY_PLAYER, ...first });
  // 청취 기록(이 기기에만): 미니 플레이어 창은 기록하지 않는다(같은 곡이 두 번 세어지지 않게).
  if (record) window.addEventListener('beforeunload', () => flushPlays());
  return onPlayerState((s) => {
    playerStore.set({ ...EMPTY_PLAYER, ...s });
    if (record) recordState({ ...EMPTY_PLAYER, ...s });
  });
}

export function currentPosition(s: PlayerState, now = Date.now()): number {
  if (!s.playing || s.buffering || !s.at) return s.position;
  const pos = s.position + (now - s.at) / 1000;
  return s.duration > 0 ? Math.min(pos, s.duration) : pos;
}

export const usePlayer = <S>(select: (s: PlayerState) => S) => useStore(playerStore, select);

/** 재생 위치를 초당 fps번 이어서 계산한다(진행 막대용). */
export function usePosition(fps = 30): number {
  return usePositionSelect(fps, samePosition);
}

const samePosition = (pos: number) => pos;

/**
 * 재생 위치에서 고른 값(지금 가사 줄 등). 고른 값이 바뀔 때만 다시 그린다.
 * 재생 중이고 창이 보일 때만 초당 fps번 시계를 돌린다. 멈춰 있으면 위치가 바뀌지 않으니 재생 상태가 바뀔 때만 다시 고른다.
 * (예전에는 쓰는 곳마다 requestAnimationFrame을 매 프레임 돌려, 멈춰 있어도 화면 주사율만큼(144Hz 모니터면 초당 144번) 깨어났다.)
 */
export function usePositionSelect<T>(fps: number, select: (pos: number) => T): T {
  const pick = useRef(select);
  pick.current = select;
  const [pos, setPos] = useState(() => currentPosition(playerStore.get()));
  const shown = useRef(pos);
  useEffect(() => {
    let timer = 0;
    const update = () => {
      const next = currentPosition(playerStore.get());
      if (Object.is(pick.current(next), pick.current(shown.current))) return;
      shown.current = next;
      setPos(next);
    };
    const arm = () => {
      window.clearInterval(timer);
      timer = 0;
      update();
      const s = playerStore.get();
      if (s.playing && !s.buffering && !document.hidden) timer = window.setInterval(update, 1000 / fps);
    };
    arm();
    const stop = playerStore.subscribe(arm);
    document.addEventListener('visibilitychange', arm);
    return () => {
      window.clearInterval(timer);
      stop();
      document.removeEventListener('visibilitychange', arm);
    };
  }, [fps]);
  return select(pos);
}

export function formatTime(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '-:--';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
