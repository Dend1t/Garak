// 이퀄라이저 패널: 실시간 스펙트럼 + 응답 곡선 + 10밴드 슬라이더·프리앰프·프리셋.
import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { t } from '../i18n';
import {
  applyPreset,
  BAND_LABELS,
  BANDS,
  describeEqFailure,
  keepVisualizer,
  MAX_DB,
  onSpectrum,
  PRESETS,
  responseCurve,
  setBand,
  updateEq,
  useEq,
  useEqStatus,
} from '../lib/eq';
import { cssColor, onThemeColors } from '../lib/theme';
import { usePlayer } from '../state/player';
import { togglePanel } from '../state/ui';
import { Icon } from './Icon';

/** 스펙트럼: 받은 막대(초당 25번)를 화면 주기에 맞춰 부드럽게 따라가고, 꼭짓점은 천천히 내려온다. */
function Spectrum() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const target = useRef<number[]>([]);
  const playing = usePlayer((s) => s.playing);

  useEffect(() => {
    const stopVis = keepVisualizer();
    const unlisten = onSpectrum((bars) => {
      target.current = bars;
    });
    return () => {
      stopVis();
      void unlisten.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ctx = el.getContext('2d');
    if (!ctx) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // 캔버스는 CSS 변수를 못 쓰므로 화면 색이 바뀔 때마다(테마, 앨범 색 테마의 곡 변경) 다시 읽는다.
    let colors = { low: '', high: '', peak: '' };
    const readColors = () => {
      colors = {
        low: cssColor('--violet', '#7b3ff2'),
        high: cssColor('--rose', '#ff4d6d'),
        peak: `rgb(${cssColor('--ink-rgb', '244 239 248')} / 0.7)`,
      };
    };
    readColors();
    const stopTheme = onThemeColors(readColors);
    const shown: number[] = [];
    const peaks: number[] = [];
    let raf = 0;
    let last = 0;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      // 초당 60번까지만 그린다(주사율이 높은 모니터에서 매 프레임 그리지 않게). 따라가기·내려오기는 시간 기준이라 빠르기가 같다.
      if (last && now - last < 1000 / 60 - 4) return;
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
      last = now;
      const follow = reduce ? 1 : 1 - Math.pow(0.65, dt * 60);
      const fall = 0.48 * dt;
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
        el.width = Math.round(w * dpr);
        el.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const bars = target.current;
      const n = bars.length || 48;
      const gap = 3;
      const bw = Math.max(2, (w - gap * (n - 1)) / n);
      const grad = ctx.createLinearGradient(0, h, 0, 0);
      grad.addColorStop(0, colors.low);
      grad.addColorStop(1, colors.high);
      // 막대와 꼭짓점을 각각 한 번에 칠한다.
      const tops = new Path2D();
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const v = (bars[i] ?? 0) / 255;
        shown[i] = (shown[i] ?? 0) + (v - (shown[i] ?? 0)) * follow;
        peaks[i] = Math.max(shown[i], (peaks[i] ?? 0) - fall);
        const x = i * (bw + gap);
        const bh = Math.max(2, shown[i] * (h - 6));
        ctx.roundRect(x, h - bh, bw, bh, Math.min(2, bw / 2));
        tops.rect(x, h - Math.max(2, peaks[i] * (h - 6)) - 3, bw, 2);
      }
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.fillStyle = colors.peak;
      ctx.fill(tops);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      stopTheme();
    };
  }, []);

  return (
    <div className="spectrum">
      <canvas ref={canvas} className="spectrum__canvas" aria-label={t('실시간 스펙트럼')} role="img" />
      {!playing && <span className="spectrum__idle">{t('곡을 재생하면 스펙트럼이 움직입니다')}</span>}
    </div>
  );
}

const CURVE_W = 300;
const CURVE_H = 120;

function Curve({ gains, preamp, enabled }: { gains: number[]; preamp: number; enabled: boolean }) {
  const path = useMemo(() => {
    const pts = responseCurve(gains, preamp);
    const lo = Math.log10(20);
    const hi = Math.log10(20000);
    return pts
      .map((p, i) => {
        const x = ((Math.log10(p.f) - lo) / (hi - lo)) * CURVE_W;
        const db = Math.max(-MAX_DB * 1.5, Math.min(MAX_DB * 1.5, p.db));
        const y = CURVE_H / 2 - (db / (MAX_DB * 1.5)) * (CURVE_H / 2 - 4);
        return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }, [gains, preamp]);
  return (
    <svg className={`curve${enabled ? '' : ' is-off'}`} viewBox={`0 0 ${CURVE_W} ${CURVE_H}`} preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" x2={CURVE_W} y1={CURVE_H / 2} y2={CURVE_H / 2} className="curve__zero" />
      <path d={`${path} L${CURVE_W},${CURVE_H} L0,${CURVE_H} Z`} className="curve__fill" />
      <path d={path} className="curve__line" />
    </svg>
  );
}

function Slider({ index }: { index: number }) {
  const value = useEq((s) => s.gains[index]);
  const enabled = useEq((s) => s.enabled);
  const style = { '--pos': `${((value + MAX_DB) / (2 * MAX_DB)) * 100}%` } as CSSProperties;
  return (
    <label className="band" title={`${BANDS[index]}Hz`}>
      <span className="band__value">{value > 0 ? `+${value}` : value}</span>
      <input
        type="range"
        className="band__range"
        min={-MAX_DB}
        max={MAX_DB}
        step={0.5}
        value={value}
        style={style}
        disabled={!enabled}
        aria-label={t('{band}Hz 이득 (dB)', { band: BAND_LABELS[index] })}
        onChange={(e) => setBand(index, Number(e.target.value))}
        onDoubleClick={() => setBand(index, 0)}
      />
      <span className="band__label">{BAND_LABELS[index]}</span>
    </label>
  );
}

export function EqPanel() {
  const enabled = useEq((s) => s.enabled);
  const gains = useEq((s) => s.gains);
  const preamp = useEq((s) => s.preamp);
  const preset = useEq((s) => s.preset);
  const failed = useEqStatus((s) => s.failed);

  return (
    <aside className="panel panel--eq" aria-label={t('이퀄라이저')}>
      <header className="panel__head">
        <h2 className="panel__title">{t('이퀄라이저')}</h2>
        <div className="panel__tools">
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            className={`switch${enabled ? ' is-on' : ''}`}
            onClick={() => updateEq({ enabled: !enabled })}
          >
            <span className="switch__knob" />
            <span className="sr-only">{enabled ? t('이퀄라이저 끄기') : t('이퀄라이저 켜기')}</span>
          </button>
          <button type="button" className="icon-btn" aria-label={t('이퀄라이저 닫기')} onClick={() => togglePanel('eq')}>
            <Icon name="close" size={18} />
          </button>
        </div>
      </header>
      <div className="panel__body eq">
        <Spectrum />
        {failed && <p className="eq__notice" role="alert">{describeEqFailure(failed)}</p>}

        <div className="eq__curve">
          <Curve gains={gains} preamp={preamp} enabled={enabled} />
          <span className="eq__scale eq__scale--top">+{MAX_DB}</span>
          <span className="eq__scale eq__scale--bottom">-{MAX_DB}</span>
        </div>

        <div className={`bands${enabled ? '' : ' is-off'}`}>
          {BANDS.map((_, i) => <Slider key={i} index={i} />)}
        </div>

        <label className="preamp">
          <span className="preamp__label">{t('프리앰프')}</span>
          <input
            type="range"
            className="range preamp__range"
            min={-MAX_DB}
            max={MAX_DB}
            step={0.5}
            value={preamp}
            disabled={!enabled}
            style={{ '--fill': `${((preamp + MAX_DB) / (2 * MAX_DB)) * 100}%` } as CSSProperties}
            onChange={(e) => updateEq({ preamp: Number(e.target.value), preset: preset === 'custom' ? 'custom' : preset })}
            aria-label={t('프리앰프 (dB)')}
          />
          <span className="preamp__value">{preamp > 0 ? `+${preamp}` : preamp} dB</span>
        </label>

        <div className="presets" role="radiogroup" aria-label={t('프리셋')}>
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={preset === p.id}
              className={`chip chip--small${preset === p.id ? ' is-on' : ''}`}
              disabled={!enabled}
              onClick={() => applyPreset(p.id)}
            >
              {t(p.label)}
            </button>
          ))}
          {preset === 'custom' && <span className="chip chip--small is-on" aria-current="true">{t('사용자 지정')}</span>}
        </div>
        <p className="eq__hint">
          {t('슬라이더를 두 번 누르면 0으로 돌아갑니다. 올린 만큼 프리앰프를 낮추면 소리가 깨지지 않습니다.')}
        </p>
      </div>
    </aside>
  );
}
