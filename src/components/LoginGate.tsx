// 로그인 전·연결 중 안내. 로그인은 숨은 YouTube Music 창을 잠깐 띄워 Google 화면에서 하거나,
// 맥에서는 크롬에 로그인된 계정을 그대로 가져온다(src-tauri/src/login.rs).
import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { chromeLoginAvailable, importChromeLogin, showEngine } from '../lib/tauri';
import { useLibrary } from '../state/library';
import { toast, toastError } from '../state/ui';
import { Logo } from './Logo';

/** 이 시간이 지나도 연결이 안 되면 다시 연결 버튼을 보인다. */
const SLOW_MS = 15000;

export function LoginGate() {
  const status = useLibrary((s) => s.status);
  const [slow, setSlow] = useState(false);
  const [chrome, setChrome] = useState(false);
  const [importing, setImporting] = useState(false);
  useEffect(() => {
    chromeLoginAvailable().then(setChrome, () => setChrome(false));
  }, []);
  useEffect(() => {
    setSlow(false);
    if (status.ready) return;
    const timer = window.setTimeout(() => setSlow(true), SLOW_MS);
    return () => window.clearTimeout(timer);
  }, [status.ready]);

  const login = () => showEngine('login').catch((err) => toastError(err, t('로그인 창을 열지 못했습니다')));
  const fromChrome = async () => {
    setImporting(true);
    try {
      const { profile } = await importChromeLogin();
      toast(t("크롬 '{profile}' 프로필의 로그인을 가져왔습니다", { profile }));
    } catch (err) {
      toastError(err, t('크롬 로그인을 가져오지 못했습니다'));
    } finally {
      setImporting(false);
    }
  };
  // music.youtube.com이 아닌 곳(로그인 전 안내 페이지)에 있으면 로그인이 필요한 상태다.
  const needsLogin = status.host !== '' && (!status.loggedIn || status.host !== 'music.youtube.com');

  if (status.ready && status.loggedIn) return null;
  return (
    <div className="gate">
      <div className="gate__card">
        <Logo size={64} />
        {needsLogin ? (
          <>
            <h1 className="gate__title">{t('YouTube Music 계정으로 로그인하세요')}</h1>
            <p className="gate__text">
              {t('음악은 내 YouTube Music 계정으로 재생되고, 좋아요와 플레이리스트도 그 계정에 저장됩니다. 로그인은 Google 화면에서 하며, 이 앱은 비밀번호를 보거나 저장하지 않습니다.')}
            </p>
            {chrome ? (
              <>
                <button type="button" className="btn btn--primary btn--large" onClick={fromChrome} disabled={importing}>
                  {importing ? t('가져오는 중…') : t('크롬 로그인 가져오기')}
                </button>
                <p className="gate__hint">{t("크롬에 로그인된 YouTube 계정을 그대로 씁니다. 처음에는 맥이 키체인 접근을 물으니 '허용'을 누르세요.")}</p>
                <button type="button" className="btn btn--quiet" onClick={login}>{t('Google 계정으로 로그인')}</button>
              </>
            ) : (
              <button type="button" className="btn btn--primary btn--large" onClick={login}>{t('Google 계정으로 로그인')}</button>
            )}
          </>
        ) : (
          <>
            <h1 className="gate__title">{t('YouTube Music에 연결하는 중…')}</h1>
            <p className="gate__text">{t('처음 실행하면 몇 초 걸립니다.')}</p>
            {slow && (
              <div className="gate__actions">
                <button type="button" className="btn btn--quiet" onClick={() => showEngine('reload').catch((err) => toastError(err))}>{t('다시 연결')}</button>
                <button type="button" className="btn btn--quiet" onClick={login}>{t('로그인 화면 열기')}</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
