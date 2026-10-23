// 설정: 언어, 테마(색)와 가사 글자 크기, 계정·연결.
import type { CSSProperties } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { createElement, useEffect, useState } from 'react';
import { LANGS, setLangSetting, t, type LangSetting } from '../i18n';
import { useLangSetting } from '../i18n/react';
import { setTheme, THEMES, useTheme, type ThemeInfo } from '../lib/theme';
import { globalKey, modKey } from '../lib/keys';
import { logout, miniWindow, showEngine } from '../lib/tauri';
import { useStore } from '../lib/store';
import { SHORTCUT_LIST, shortcutFailures, updatePrefs, usePrefs, VOLUME_SHORTCUT_LIST } from '../state/prefs';
import { useLibrary } from '../state/library';
import { LYRIC_SCALES, openDialog, stepLyricScale, toast, toastError, useLyricScale } from '../state/ui';
import { ConfirmDialog } from '../components/Dialogs';
import { Icon } from '../components/Icon';

function Swatch({ theme }: { theme: ThemeInfo }) {
  const p = theme.preview;
  const style = {
    '--sw-bg': p.bg,
    '--sw-surface': p.surface,
    '--sw-ink': p.ink,
    '--sw-a': p.accent[0],
    '--sw-b': p.accent[1],
  } as CSSProperties;
  return (
    <span className={`swatch${theme.kind === 'auto' ? ' swatch--auto' : ''}`} style={style} aria-hidden="true">
      <span className="swatch__side" />
      <span className="swatch__main">
        <span className="swatch__line swatch__line--long" />
        <span className="swatch__line" />
        <span className="swatch__accent" />
      </span>
    </span>
  );
}

function Toggle({ on, label, hint, onChange }: { on: boolean; label: string; hint?: string; onChange: (v: boolean) => void }) {
  return (
    <div className="setting-row">
      <div className="setting-row__text">
        <span className="setting-row__label">{label}</span>
        {hint && <span className="field__hint">{hint}</span>}
      </div>
      <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch${on ? ' is-on' : ''}`} onClick={() => onChange(!on)}>
        <span className="switch__knob" />
      </button>
    </div>
  );
}

function DesktopPrefs() {
  const prefs = usePrefs((s) => s);
  const failed = useStore(shortcutFailures, (s) => s);
  return (
    <section className="settings__section" aria-labelledby="desktop-title">
      <h2 id="desktop-title" className="shelf__title">{t('재생 편의')}</h2>
      <Toggle on={prefs.notifications} label={t('곡이 바뀌면 알림')} hint={t('앱 창을 보고 있지 않을 때만 알립니다.')} onChange={(v) => updatePrefs({ notifications: v })} />
      <Toggle on={prefs.videoOnTop} label={t('영상 창을 늘 위에')} onChange={(v) => updatePrefs({ videoOnTop: v })} />
      <Toggle on={prefs.globalShortcuts} label={t('전역 단축키')} hint={t('다른 앱을 쓰는 중에도 됩니다.')} onChange={(v) => updatePrefs({ globalShortcuts: v })} />
      {prefs.globalShortcuts && (
        <>
          <ul className="shortcut-list">
            {[...SHORTCUT_LIST, ...(prefs.volumeShortcuts ? VOLUME_SHORTCUT_LIST : [])].map((k) => (
              <li key={k.key} className={failed.includes(k.label) ? 'is-failed' : ''}>
                <kbd>{globalKey(k.key)}</kbd> {t(k.label)}{failed.includes(k.label) ? ` — ${t('다른 앱이 쓰고 있어 등록하지 못했습니다')}` : ''}
              </li>
            ))}
          </ul>
          <Toggle
            on={prefs.volumeShortcuts}
            label={t('음량도 전역 단축키로')}
            hint={t('{keys}로 음량을 바꿉니다. 창 정리 앱처럼 같은 키를 쓰는 앱이 있으면 그 앱의 단축키가 듣지 않아 기본은 꺼 두었습니다.', { keys: `${globalKey('↑')} ${globalKey('↓')}` })}
            onChange={(v) => updatePrefs({ volumeShortcuts: v })}
          />
        </>
      )}
      <div className="settings__actions">
        <button type="button" className="btn btn--quiet" onClick={() => void miniWindow(true).catch((err) => toastError(err))}>{t('미니 플레이어 열기')}</button>
      </div>
    </section>
  );
}

export function SettingsView() {
  const theme = useTheme();
  const scale = useLyricScale();
  const account = useLibrary((s) => s.account);
  const loggedIn = useLibrary((s) => s.status.loggedIn);
  const askLogout = () =>
    openDialog(
      createElement(ConfirmDialog, {
        title: t('로그아웃'),
        message: t('이 앱에서만 로그아웃합니다. 크롬 등 다른 곳의 로그인은 그대로이고, 재생 중인 음악은 멈춥니다.'),
        confirmLabel: t('로그아웃'),
        onConfirm: async () => {
          try {
            await logout();
            toast(t('로그아웃했습니다'));
            return true;
          } catch (err) {
            toastError(err, t('로그아웃하지 못했습니다'));
            return false;
          }
        },
      }),
    );
  const lang = useLangSetting();
  const [version, setVersion] = useState('');
  useEffect(() => {
    getVersion().then(setVersion, () => setVersion(''));
  }, []);

  return (
    <div className="page settings">
      <header className="page__head">
        <h1 className="page__title">{t('설정')}</h1>
      </header>

      <section className="settings__section" aria-labelledby="lang-title">
        <h2 id="lang-title" className="shelf__title">{t('언어')}</h2>
        <div className="chips" role="radiogroup" aria-label={t('언어')}>
          {[{ id: 'system' as LangSetting, label: t('시스템 설정 따르기') }, ...LANGS].map((l) => (
            <button
              key={l.id}
              type="button"
              role="radio"
              aria-checked={lang === l.id}
              lang={l.id === 'system' ? undefined : l.id}
              className={`chip${lang === l.id ? ' is-on' : ''}`}
              onClick={() => setLangSetting(l.id)}
            >
              {l.label}
            </button>
          ))}
        </div>
        <p className="field__hint">{t('메뉴와 화면 글자를 이 언어로 보여 줍니다. YouTube Music에서 받아 오는 곡·묶음 이름은 계정 언어를 따릅니다.')}</p>
      </section>

      <section className="settings__section" aria-labelledby="theme-title">
        <h2 id="theme-title" className="shelf__title">{t('테마')}</h2>
        <div className="themes" role="radiogroup" aria-label={t('테마')}>
          {THEMES.map((th) => (
            <button
              key={th.id}
              type="button"
              role="radio"
              aria-checked={theme === th.id}
              className={`theme-card${theme === th.id ? ' is-on' : ''}`}
              onClick={() => setTheme(th.id)}
            >
              <Swatch theme={th} />
              <span className="theme-card__text">
                <span className="theme-card__label">
                  {t(th.label)}
                  {theme === th.id && <Icon name="check" size={16} />}
                </span>
                <span className="theme-card__desc">{t(th.description)}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="settings__section" aria-labelledby="lyrics-size-title">
        <h2 id="lyrics-size-title" className="shelf__title">{t('가사 글자 크기')}</h2>
        <div className="settings__row">
          <div className="textsize textsize--large" role="group" aria-label={t('가사 글자 크기')}>
            <button type="button" className="textsize__btn" aria-label={t('가사 글자 작게')} data-tip-key={modKey('-')} disabled={scale <= LYRIC_SCALES[0]} onClick={() => stepLyricScale(-1)}>
              <span className="textsize__glyph textsize__glyph--sm" aria-hidden="true">{t('가')}</span>
            </button>
            <button type="button" className="textsize__value" data-tip={t('기본 크기로')} data-tip-key={modKey('0')} onClick={() => stepLyricScale(0)}>
              {Math.round(scale * 100)}%
            </button>
            <button type="button" className="textsize__btn" aria-label={t('가사 글자 크게')} data-tip-key={modKey('=')} disabled={scale >= LYRIC_SCALES[LYRIC_SCALES.length - 1]} onClick={() => stepLyricScale(1)}>
              <span className="textsize__glyph textsize__glyph--lg" aria-hidden="true">{t('가')}</span>
            </button>
          </div>
          <span className="settings__preview" style={{ fontSize: `${Math.round(30 * scale)}px` }}>{t('이 밤 그날의 반딧불을')}</span>
        </div>
        <p className="field__hint">{t('가사 화면에서 ⌘= / ⌘- / ⌘0(윈도우는 Ctrl)으로도 바꿀 수 있습니다.')}</p>
      </section>

      <DesktopPrefs />

      <section className="settings__section" aria-labelledby="account-title">
        <h2 id="account-title" className="shelf__title">{t('계정과 연결')}</h2>
        <p className="settings__text">
          {account
            ? t('{name} 계정으로 로그인했습니다.', { name: account.handle ? `${account.name} (${account.handle})` : account.name })
            : t('로그인하지 않았습니다.')}
        </p>
        <div className="settings__actions">
          <button type="button" className="btn btn--quiet" onClick={() => showEngine('web').catch((err) => toastError(err))}>{t('YouTube Music 웹 화면 열기')}</button>
          <button type="button" className="btn btn--quiet" onClick={() => showEngine('login').catch((err) => toastError(err))}>{t('다른 계정으로 로그인')}</button>
          <button type="button" className="btn btn--quiet" onClick={() => showEngine('reload').catch((err) => toastError(err))}>{t('YouTube Music 다시 연결')}</button>
          {loggedIn && <button type="button" className="btn btn--quiet" onClick={askLogout}>{t('로그아웃')}</button>}
        </div>
        {version && <p className="field__hint">Garak {version}</p>}
      </section>
    </div>
  );
}
