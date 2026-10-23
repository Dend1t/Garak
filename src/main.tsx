import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import './styles.css';
import { App } from './App';
import { MiniApp } from './components/MiniApp';
import { getLang } from './i18n';
import { IS_MAC } from './lib/keys';
import { initTheme } from './lib/theme';

// 화면 오류·경고를 터미널 기록(ui_log)으로도 넘긴다. 넘기기 실패는 무시(원래 콘솔에는 남는다).
const forward = (level: string, parts: unknown[]) => {
  const message = parts
    .map((p) => (p instanceof Error ? `${p.message}\n${p.stack ?? ''}` : typeof p === 'string' ? p : JSON.stringify(p)))
    .join(' ');
  invoke('ui_log', { level, message }).catch(() => undefined);
};
for (const level of ['warn', 'error'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    forward(level, args);
  };
}
window.addEventListener('error', (e) => forward('error', [e.error ?? e.message]));
window.addEventListener('unhandledrejection', (e) => forward('error', ['처리 안 된 Promise 거부', e.reason]));

// 화면을 그리기 전에 테마를 적용해 처음 깜빡임을 막는다.
initTheme();
// 문서 언어(index.html은 ko)를 고른 언어로 맞춘다. 글꼴 고르기·화면 낭독기가 이 값을 쓴다. 바꿀 때는 i18n이 맞춘다.
document.documentElement.lang = getLang();
// 맥은 제목 막대 없이 신호등 단추가 화면 위에 얹혀서(lib.rs build_main_window) 그 자리를 비우는 스타일이 이 값을 본다.
document.documentElement.dataset.platform = IS_MAC ? 'mac' : 'other';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {location.hash === '#mini' ? <MiniApp /> : <App />}
  </StrictMode>,
);
