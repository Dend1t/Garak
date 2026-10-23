// 둘러보기: 분위기·장르 단추, 최신 음악, YouTube Music 차트(나라 고르기).
import { useState } from 'react';
import { t } from '../i18n';
import { regionName } from '../lib/charts';
import { useAsync } from '../lib/useAsync';
import * as ytm from '../lib/ytm/client';
import { go } from '../state/nav';
import { ShelfView } from '../components/Cards';
import { Icon } from '../components/Icon';
import { ErrorState, Loading } from './common';

/** YouTube Music 차트 나라(ISO 코드, 전 세계는 ZZ) */
export const YTM_CHART_COUNTRIES: string[] = ['KR', 'ZZ', 'US', 'JP', 'GB', 'FR', 'DE', 'CA', 'AU', 'BR', 'MX', 'IN', 'ID', 'PH'];

/** 한국어 화면의 나라 이름(예전 그대로: Intl은 '대한민국'·'오스트레일리아'로 써서) */
const KO_COUNTRY: Record<string, string> = {
  KR: '한국', ZZ: '전 세계', US: '미국', JP: '일본', GB: '영국', FR: '프랑스', DE: '독일',
  CA: '캐나다', AU: '호주', BR: '브라질', MX: '멕시코', IN: '인도', ID: '인도네시아', PH: '필리핀',
};

/** 나라 이름을 지금 언어로(한국어는 위 이름, 전 세계(ZZ)는 번역 문구) */
const countryName = (code: string) => (code === 'ZZ' ? t('전 세계') : regionName(code, KO_COUNTRY[code] ?? code));

const COUNTRY_KEY = 'ytm-desktop:ytm-chart-country';
function loadCountry() {
  try {
    const v = localStorage.getItem(COUNTRY_KEY);
    return v && YTM_CHART_COUNTRIES.includes(v) ? v : 'KR';
  } catch {
    return 'KR';
  }
}

export function ExploreView() {
  const moods = useAsync('moods', () => ytm.moods());
  const releases = useAsync('new-releases', () => ytm.newReleases());
  const [country, setCountry] = useState(loadCountry);
  const charts = useAsync(`ytm-charts:${country}`, () => ytm.ytmCharts(country));

  const pick = (code: string) => {
    setCountry(code);
    try {
      localStorage.setItem(COUNTRY_KEY, code);
    } catch {
      // 기억 못 해도 된다.
    }
  };

  return (
    <div className="page">
      <header className="page__head">
        <h1 className="page__title">{t('둘러보기')}</h1>
      </header>

      <section className="shelf">
        <h2 className="shelf__title">{t('분위기 및 장르')}</h2>
        {moods.loading && !moods.data ? (
          <Loading />
        ) : moods.error ? (
          <ErrorState message={moods.error} onRetry={moods.reload} />
        ) : (
          moods.data?.sections.map((s) => (
            <div key={s.title} className="moods">
              {moods.data!.sections.length > 1 && <h3 className="moods__title">{s.title}</h3>}
              <div className="moods__grid">
                {s.items.map((m) => (
                  <button
                    key={m.params ?? m.label}
                    type="button"
                    className="mood"
                    onClick={() => m.params && go({ name: 'mood', params: m.params, title: m.label })}
                  >
                    <span className="mood__label">{m.label}</span>
                    <Icon name="forward" size={16} className="mood__go" />
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </section>

      <section className="shelf">
        <header className="shelf__head">
          <h2 className="shelf__title">{t('YouTube Music 차트')}</h2>
        </header>
        <div className="chips" role="radiogroup" aria-label={t('차트 나라')}>
          {YTM_CHART_COUNTRIES.map((code) => (
            <button key={code} type="button" role="radio" aria-checked={code === country} className={`chip${code === country ? ' is-on' : ''}`} onClick={() => pick(code)}>
              {countryName(code)}
            </button>
          ))}
        </div>
        {charts.loading && !charts.data ? (
          <Loading />
        ) : charts.error ? (
          <ErrorState message={charts.error} onRetry={charts.reload} />
        ) : (
          charts.data?.shelves.map((s, i) => <ShelfView key={`${s.title}-${i}`} shelf={s} trackLimit={10} />)
        )}
      </section>

      {releases.loading && !releases.data ? (
        <Loading />
      ) : releases.error ? (
        <ErrorState message={releases.error} onRetry={releases.reload} />
      ) : (
        releases.data?.shelves.map((s, i) => <ShelfView key={`${s.title}-${i}`} shelf={{ ...s, title: s.title || t('최신 음악') }} />)
      )}
    </div>
  );
}

export function MoodView({ params, title }: { params: string; title: string }) {
  const res = useAsync(`mood:${params}`, () => ytm.moodCategory(params));
  if (res.loading && !res.data) return <div className="page"><Loading /></div>;
  if (res.error) return <div className="page"><ErrorState message={res.error} onRetry={res.reload} /></div>;
  const data = res.data;
  if (!data) return null;
  return (
    <div className="page">
      <header className="page__head">
        <h1 className="page__title">{data.title || title}</h1>
      </header>
      {data.shelves.map((s, i) => <ShelfView key={`${s.title}-${i}`} shelf={s} />)}
    </div>
  );
}
