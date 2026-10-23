// 내 청취 통계(이 기기에서 들은 기록): 들은 시간, 날짜별 막대, 많이 들은 곡·아티스트.
import { createElement, useMemo, useState } from 'react';
import { t, tk } from '../i18n';
import { clearPlays, statsSummary, type StatsRange } from '../lib/stats';
import { playEndpoint } from '../state/library';
import { openDialog } from '../state/ui';
import { Cover } from '../components/Cover';
import { ConfirmDialog } from '../components/Dialogs';
import { Empty } from './common';

const RANGES: { id: StatsRange; label: string }[] = [
  { id: 'week', label: tk('최근 7일') },
  { id: 'month', label: tk('최근 30일') },
  { id: 'year', label: tk('최근 1년') },
  { id: 'all', label: tk('전체') },
];

export function formatListen(seconds: number) {
  const m = Math.round(seconds / 60);
  if (m < 60) return t('{m}분', { m });
  const h = Math.floor(m / 60);
  return t('{h}시간 {m}분', { h, m: m % 60 });
}

export function StatsView() {
  const [range, setRange] = useState<StatsRange>('week');
  const [version, setVersion] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const s = useMemo(() => statsSummary(range), [range, version]);
  const max = Math.max(1, ...s.days.map((d) => d.seconds));
  const mix = (videoId: string) => playEndpoint({ watchEndpoint: { videoId, playlistId: `RDAMVM${videoId}`, params: 'wAEB' } });

  return (
    <div className="page stats">
      <header className="page__head">
        <h1 className="page__title">{t('청취 통계')}</h1>
        <div className="page__tools">
          <button
            type="button"
            className="btn btn--quiet"
            onClick={() =>
              openDialog(
                createElement(ConfirmDialog, {
                  title: t('청취 기록 지우기'),
                  message: t('이 기기에 남은 청취 기록을 모두 지웁니다. YouTube Music 계정의 재생 기록은 그대로입니다.'),
                  confirmLabel: t('지우기'),
                  onConfirm: async () => {
                    clearPlays();
                    setVersion((v) => v + 1);
                    return true;
                  },
                }),
              )
            }
          >
            {t('기록 지우기')}
          </button>
        </div>
      </header>
      <div className="chips" role="radiogroup" aria-label={t('기간')}>
        {RANGES.map((r) => (
          <button key={r.id} type="button" role="radio" aria-checked={r.id === range} className={`chip${r.id === range ? ' is-on' : ''}`} onClick={() => setRange(r.id)}>
            {t(r.label)}
          </button>
        ))}
      </div>

      {s.playCount === 0 ? (
        <Empty title={t('아직 기록이 없습니다')}>
          <p>{t('30초 넘게 들은 곡부터 이 기기에 기록됩니다.')}</p>
        </Empty>
      ) : (
        <>
          <div className="stats__totals">
            <div><b>{formatListen(s.totalSeconds)}</b><span>{t('들은 시간')}</span></div>
            <div><b>{t('{n}곡', { n: s.playCount })}</b><span>{t('재생@횟수')}</span></div>
            <div><b>{s.topArtists.length ? s.topArtists[0].name : '-'}</b><span>{t('가장 많이 들은 아티스트')}</span></div>
          </div>
          <div className="stats__bars" role="img" aria-label={t('날짜별 들은 시간')}>
            {s.days.map((d) => (
              <div key={d.label} className="stats__bar" data-tip={`${d.label} ${formatListen(d.seconds)}`}>
                <span style={{ height: `${Math.max(2, (d.seconds / max) * 100)}%` }} />
                <small>{s.days.length <= 7 || d.label.endsWith('/1') || d.label.endsWith('/15') ? d.label : ''}</small>
              </div>
            ))}
          </div>
          <div className="stats__cols">
            <section>
              <h2 className="shelf__title">{t('많이 들은 곡')}</h2>
              <ol className="stats__list">
                {s.topTracks.map((tr, i) => (
                  <li key={tr.id}>
                    <span className="stats__rank">{i + 1}</span>
                    <button type="button" className="stats__track" onClick={() => mix(tr.id)} data-tip={t('이 곡으로 믹스 재생')}>
                      <Cover src={tr.artwork} size={40} />
                      <span className="stats__meta"><b>{tr.title}</b><small>{tr.artist}</small></span>
                    </button>
                    <span className="stats__count">{t('{n}회', { n: tr.count })}</span>
                  </li>
                ))}
              </ol>
            </section>
            <section>
              <h2 className="shelf__title">{t('많이 들은 아티스트')}</h2>
              <ol className="stats__list">
                {s.topArtists.map((a, i) => (
                  <li key={a.name}>
                    <span className="stats__rank">{i + 1}</span>
                    <span className="stats__meta"><b>{a.name}</b><small>{formatListen(a.seconds)}</small></span>
                    <span className="stats__count">{t('{n}회', { n: a.count })}</span>
                  </li>
                ))}
              </ol>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
