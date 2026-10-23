// 누르거나 끌어서 재생 위치를 옮기는 막대의 동작(미니 플레이어·전체 화면이 같이 쓴다).
// 재생 바는 기본 range 입력을 쓴다(PlayerBar의 Seek). 키보드는 ←→ 5초, Home·End.
import { useRef, useState, type HTMLAttributes, type RefObject } from 'react';
import { t } from '../i18n';
import * as ytm from '../lib/ytm/client';
import { formatTime, patchPlayer, usePlayer, usePosition } from '../state/player';
import { toastError } from '../state/ui';

const KEY_STEP_S = 5;

export interface SeekBar {
  /** 보일 위치(초): 끄는 중이면 끄는 자리, 아니면 재생 위치 */
  value: number;
  duration: number;
  /** 0~1 */
  fill: number;
  dragging: boolean;
  disabled: boolean;
  /** 막대 요소에 펼쳐 넣는다(ref·slider 역할·포인터·키보드 처리) */
  props: HTMLAttributes<HTMLDivElement> & { ref: RefObject<HTMLDivElement | null> };
}

export function useSeekBar(fps = 10): SeekBar {
  const duration = usePlayer((s) => s.duration);
  const ad = usePlayer((s) => s.ad);
  const has = usePlayer((s) => !!s.videoId);
  const position = usePosition(fps);
  const [drag, setDrag] = useState<number | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  /** 누르고 있는 중(상태가 다시 그려지기 전에 손을 떼도 알 수 있게 ref로) */
  const pressed = useRef(false);
  const disabled = !has || ad || duration <= 0;
  const value = drag ?? position;
  const at = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * duration;
  };
  const commit = (v: number) => {
    setDrag(null);
    patchPlayer({ position: v });
    void ytm.control('seek', v).catch((err) => toastError(err, t('이동하지 못했습니다')));
  };
  return {
    value,
    duration,
    fill: duration > 0 ? Math.max(0, Math.min(1, value / duration)) : 0,
    dragging: drag !== null,
    disabled,
    props: {
      ref: bar,
      role: 'slider',
      tabIndex: disabled ? -1 : 0,
      'aria-label': t('재생 위치'),
      'aria-disabled': disabled,
      'aria-valuemin': 0,
      'aria-valuemax': Math.round(duration),
      'aria-valuenow': Math.round(value),
      'aria-valuetext': `${formatTime(value)} / ${formatTime(duration)}`,
      onPointerDown: (e) => {
        if (disabled || e.button !== 0) return;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // 포인터를 잡지 못해도 누른 자리로는 옮긴다.
        }
        pressed.current = true;
        setDrag(at(e.clientX));
      },
      onPointerMove: (e) => {
        if (!disabled && pressed.current) setDrag(at(e.clientX));
      },
      onPointerUp: (e) => {
        if (!pressed.current) return;
        pressed.current = false;
        commit(at(e.clientX));
      },
      onPointerCancel: () => {
        pressed.current = false;
        setDrag(null);
      },
      onKeyDown: (e) => {
        if (disabled) return;
        const to =
          e.key === 'ArrowLeft' ? position - KEY_STEP_S
          : e.key === 'ArrowRight' ? position + KEY_STEP_S
          : e.key === 'Home' ? 0
          : e.key === 'End' ? duration - 1
          : null;
        if (to === null) return;
        e.preventDefault();
        commit(Math.max(0, Math.min(duration - 1, to)));
      },
    },
  };
}
