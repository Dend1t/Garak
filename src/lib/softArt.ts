// 흐린 표지 배경(가사 화면·전체 화면 모드·미니 플레이어).
// 화면만 한 요소에 CSS blur(40~90px)를 걸면 그 넓이를 통째로 흐리게 처리하고, 위에서 가사·스펙트럼이 움직일 때마다
// 다시 합성해야 해서 비쌌다(윈도우 WebView2에서 특히). 표지를 아주 작게(96px) 줄여 한 번만 흐리게 만든 그림을 늘려 깐다.
// 흐린 그림은 늘려도 부드럽게 이어져 보기에는 거의 같다. 그림을 만들지 못하면(표지 서버가 읽기를 막는 등) CSS 흐림으로 돌아간다.
import { useEffect, useState } from 'react';

/** 줄인 그림의 긴 변(px) */
const SIZE = 96;
/** 최근에 만든 그림을 이만큼 기억한다(곡을 오가거나 화면을 다시 열 때 다시 만들지 않게). */
const CACHE_MAX = 24;
const cache = new Map<string, string>();

function remember(key: string, image: string) {
  cache.delete(key);
  cache.set(key, image);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
}

/** 상자 흐림 한 번(가로 또는 세로). 가장자리는 끝 픽셀을 늘려 쓴다. */
function boxPass(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, horizontal: boolean) {
  const lines = horizontal ? h : w;
  const len = horizontal ? w : h;
  const step = horizontal ? 3 : w * 3;
  const lineStep = horizontal ? w * 3 : 3;
  const k = 1 / (2 * r + 1);
  for (let line = 0; line < lines; line++) {
    const base = line * lineStep;
    for (let c = 0; c < 3; c++) {
      const at = (i: number) => src[base + Math.min(len - 1, Math.max(0, i)) * step + c];
      let sum = 0;
      for (let i = -r; i <= r; i++) sum += at(i);
      for (let i = 0; i < len; i++) {
        dst[base + i * step + c] = sum * k;
        sum += at(i + r + 1) - at(i - r);
      }
    }
  }
}

/** 표지를 줄여 상자 흐림을 세 번(가우스 흐림에 가깝다) 건 PNG 주소. radius는 줄인 그림 기준 픽셀. */
async function makeSoft(url: string, radius: number): Promise<string> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.referrerPolicy = 'no-referrer';
  img.src = url;
  await img.decode();
  const scale = SIZE / Math.max(img.naturalWidth, img.naturalHeight, 1);
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no_canvas');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  // 다른 곳의 그림을 읽지 못하게 막힌 경우 여기서 예외가 난다(그러면 CSS 흐림을 쓴다).
  const pixels = ctx.getImageData(0, 0, w, h);
  const data = pixels.data;
  const a = new Float32Array(w * h * 3);
  const b = new Float32Array(w * h * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    a[j] = data[i];
    a[j + 1] = data[i + 1];
    a[j + 2] = data[i + 2];
  }
  for (let n = 0; n < 3; n++) {
    boxPass(a, b, w, h, radius, true);
    boxPass(b, a, w, h, radius, false);
  }
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    data[i] = a[j];
    data[i + 1] = a[j + 1];
    data[i + 2] = a[j + 2];
    data[i + 3] = 255;
  }
  ctx.putImageData(pixels, 0, 0);
  return canvas.toDataURL('image/png');
}

/**
 * 표지 주소 → 미리 흐린 작은 그림의 주소(CSS url()에 넣는다). radius는 96px로 줄인 그림 기준 흐림 반경(픽셀)이다.
 * 화면에 깔리는 크기가 클수록 같은 반경도 더 흐려 보이므로, 쓰는 곳마다 원래 CSS 흐림과 비슷해지도록 고른다.
 * 새 표지를 만드는 동안은 이전 그림을 그대로 준다. null이면(아직 없거나 만들지 못함) 쓰는 쪽이 원래 CSS 흐림으로 그린다.
 */
export function useSoftArt(url: string, radius: number): string | null {
  const key = `${radius}|${url}`;
  const [state, setState] = useState<{ key: string; image: string | null }>(() => ({ key, image: (url && cache.get(key)) || null }));

  useEffect(() => {
    if (!url) {
      setState({ key, image: null });
      return;
    }
    const hit = cache.get(key);
    if (hit) {
      setState({ key, image: hit });
      return;
    }
    let alive = true;
    makeSoft(url, radius).then(
      (image) => {
        remember(key, image);
        if (alive) setState({ key, image });
      },
      (err) => {
        console.warn('[softArt] 흐린 표지를 만들지 못해 CSS 흐림을 씁니다', err);
        if (alive) setState({ key, image: null });
      },
    );
    return () => {
      alive = false;
    };
  }, [key, url, radius]);

  // 새 표지를 만드는 동안은 이전 그림을 그대로 둔다(곡이 바뀌는 순간 배경이 비거나 비싼 흐림으로 바뀌지 않게).
  return state.image;
}
