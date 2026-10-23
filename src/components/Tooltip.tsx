// 툴팁: 창마다 하나를 띄운다. 브라우저 기본 툴팁(title)은 맥에서 1초 넘게 기다려야 뜨고 모양도 앱과 달라
// 쓰지 않는다(2026-10-23). 요소에 붙이는 표시:
// - data-tip="글": 마우스를 올리거나 키보드로 고르면 보인다.
//   data-tip-show="overflow"면 글이 잘렸을 때만, "iconic"이면 요소의 글자가 숨었을 때만(좁은 사이드바) 보인다.
// - 표시가 없어도 글자·표지 없이 아이콘만 있는 단추·링크는 aria-label을 보인다(새 단추도 빠지지 않게).
//   화면 낭독기에서 숨긴 장식 글자(aria-hidden, 예: 글자 크기 단추의 '가')는 글자로 치지 않는다.
// - data-tip-key="⌘L": 단축키를 옆에 붙인다(lib/keys.ts). data-tip-side="bottom"|"right": 놓을 쪽(기본 위, 자리가 없으면 반대쪽).
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** 처음 뜨기까지(ms). 하나가 떴다 사라진 뒤 WARM_MS 안에 다른 요소로 옮기면 바로 뜬다. */
const SHOW_MS = 350;
const WARM_MS = 600;
/** 요소와 툴팁 사이, 창 가장자리와 툴팁 사이(px) */
const GAP = 8;
const MARGIN = 8;
const TIP_ID = 'app-tooltip';

type Side = 'top' | 'bottom' | 'right';

interface Tip {
  /** 새 툴팁마다 바뀐다(같은 요소의 글만 바뀌면 그대로 두어 다시 나타나는 움직임 없이 글만 바꾼다). */
  id: number;
  el: HTMLElement;
  text: string;
  key?: string;
  side: Side;
}

const ICON_ONLY = 'button[aria-label], a[aria-label], [role="button"][aria-label]';

/** 보이는 글자(숨은 요소·aria-hidden 장식 제외) */
function visibleText(el: HTMLElement) {
  let text = el.innerText;
  for (const deco of el.querySelectorAll<HTMLElement>('[aria-hidden="true"]')) text = text.replace(deco.innerText, '');
  return text.trim();
}

const truncated = (el: HTMLElement) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;

let nextId = 0;

/** 이 자리(또는 그 조상)가 보일 툴팁. 없으면 null. */
function tipAt(target: EventTarget | null): Omit<Tip, 'id'> | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest<HTMLElement>(`[data-tip], ${ICON_ONLY}`);
  if (!el) return null;
  const { tip, tipShow, tipKey, tipSide } = el.dataset;
  let text: string | null;
  if (tip !== undefined) {
    if (tipShow === 'overflow' && !truncated(el)) return null;
    if (tipShow === 'iconic' && visibleText(el)) return null;
    text = tip;
  } else {
    if (visibleText(el) || el.querySelector('img')) return null;
    text = el.getAttribute('aria-label');
  }
  text = text?.trim() ?? '';
  if (!text) return null;
  const side: Side = tipSide === 'bottom' || tipSide === 'right' ? tipSide : 'top';
  return { el, text, key: tipKey || undefined, side };
}

/** 화면 낭독기가 이미 읽는 이름(aria-label이나 글자)과 툴팁 글이 다를 때만 설명으로 잇는다. */
const addsInfo = (tip: Omit<Tip, 'id'>) => tip.text !== (tip.el.getAttribute('aria-label') ?? tip.el.innerText).trim();

export function TooltipHost() {
  const [tip, setTip] = useState<Tip | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer = 0;
    /** 마우스·포커스가 있는 툴팁 요소(아직 뜨기 전일 수도 있다) */
    let current: HTMLElement | null = null;
    let shown: Tip | null = null;
    let warmUntil = 0;
    /** 누른 요소: 마우스가 떠날 때까지 다시 띄우지 않는다(누르면 메뉴가 열리거나 모양이 바뀐다). */
    let pressed: HTMLElement | null = null;
    /** 띄운 요소의 글·이름이 바뀌면(음량 값 등) 툴팁도 바꾼다. */
    const watcher = new MutationObserver(() => {
      if (!current) return;
      const fresh = tipAt(current);
      if (fresh?.el === current) reveal(fresh);
      else hide();
    });

    const unlink = () => {
      watcher.disconnect();
      if (shown && shown.el.getAttribute('aria-describedby') === TIP_ID) shown.el.removeAttribute('aria-describedby');
    };
    const reveal = (found: Omit<Tip, 'id'>) => {
      const next = { ...found, id: shown?.el === found.el ? shown.id : ++nextId };
      unlink();
      shown = next;
      if (addsInfo(next) && !next.el.hasAttribute('aria-describedby')) next.el.setAttribute('aria-describedby', TIP_ID);
      watcher.observe(next.el, { attributes: true, attributeFilter: ['data-tip', 'data-tip-key', 'aria-label'], childList: true, subtree: true, characterData: true });
      setTip(next);
    };
    const hide = () => {
      window.clearTimeout(timer);
      if (shown) warmUntil = performance.now() + WARM_MS;
      unlink();
      shown = null;
      current = null;
      setTip(null);
    };
    const open = (el: HTMLElement) => {
      window.clearTimeout(timer);
      const warm = shown !== null || performance.now() < warmUntil;
      if (shown) hide();
      current = el;
      // 뜨는 순간의 글로 다시 본다(그동안 잘림·글이 바뀌었을 수 있다).
      const go = () => {
        const fresh = tipAt(el);
        if (current === el && fresh?.el === el) reveal(fresh);
      };
      if (warm) go();
      else timer = window.setTimeout(go, SHOW_MS);
    };

    const onOver = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const target = e.target as Node;
      if (pressed && !pressed.contains(target)) pressed = null;
      const el = tipAt(e.target)?.el ?? null;
      if (el === current) return;
      if (!el || el === pressed) {
        if (current) hide();
        return;
      }
      open(el);
    };
    const onOut = (e: PointerEvent) => {
      // 창 밖으로 나가면 relatedTarget이 없다.
      if (!e.relatedTarget && current) hide();
    };
    const onDown = () => {
      pressed = current;
      if (current) hide();
    };
    const onFocus = (e: FocusEvent) => {
      const el = e.target instanceof HTMLElement && e.target.matches(':focus-visible') ? tipAt(e.target)?.el : null;
      if (el && el !== current) open(el);
    };
    const onBlur = (e: FocusEvent) => {
      if (current && e.target instanceof Node && current.contains(e.target)) hide();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && current) hide();
    };
    const onAway = () => {
      if (current) hide();
    };
    // 툴팁 요소를 담은 곳이 스크롤될 때만 끈다(가사·대기열이 저절로 스크롤돼도 다른 곳 툴팁은 그대로).
    const onScroll = (e: Event) => {
      if (current && (e.target === document || (e.target instanceof Node && e.target.contains(current)))) hide();
    };

    document.addEventListener('pointerover', onOver);
    document.addEventListener('pointerout', onOut);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('focusin', onFocus);
    document.addEventListener('focusout', onBlur);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onAway);
    window.addEventListener('blur', onAway);
    return () => {
      hide();
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointerout', onOut);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('focusout', onBlur);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onAway);
      window.removeEventListener('blur', onAway);
    };
  }, []);

  // 그린 뒤 크기를 재서 놓는다(보이기 전에 끝나 깜빡이지 않는다).
  useLayoutEffect(() => {
    const node = box.current;
    if (!tip || !node) return;
    const r = tip.el.getBoundingClientRect();
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x: number;
    let y: number;
    if (tip.side === 'right' && r.right + GAP + w <= vw - MARGIN) {
      x = r.right + GAP;
      y = r.top + r.height / 2 - h / 2;
    } else {
      const above = r.top - GAP - h;
      const below = r.bottom + GAP;
      if (tip.side === 'bottom') y = below + h <= vh - MARGIN ? below : above;
      else y = above >= MARGIN ? above : below;
      x = r.left + r.width / 2 - w / 2;
    }
    node.style.left = `${Math.round(Math.min(Math.max(x, MARGIN), vw - MARGIN - w))}px`;
    node.style.top = `${Math.round(Math.min(Math.max(y, MARGIN), vh - MARGIN - h))}px`;
    node.style.visibility = 'visible';
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div key={tip.id} ref={box} id={TIP_ID} className="tip" role="tooltip" style={{ visibility: 'hidden' }}>
      <span>{tip.text}</span>
      {tip.key && <kbd className="tip__key">{tip.key}</kbd>}
    </div>,
    document.body,
  );
}
