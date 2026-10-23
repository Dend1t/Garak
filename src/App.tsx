import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { LangKeyed, useLang } from './i18n/react';
import { rustStrings } from './i18n/rust';
import { UpdateBanner } from './components/UpdateBanner';
import { UPDATE_CHECK_ENABLED } from './lib/update';
import * as ytm from './lib/ytm/client';
import { onMenuAction } from './lib/tauri';
import { startLibrarySync } from './state/library';
import { back, forward, go, useRoute, type Route } from './state/nav';
import { patchPlayer, playerStore, startPlayerSync } from './state/player';
import { stepLyricScale, toast, toastError, togglePanel, toggleLyrics, useLayout } from './state/ui';
import { ContextMenuHost, Toasts } from './components/ContextMenu';
import { DialogHost } from './components/Dialogs';
import { TooltipHost } from './components/Tooltip';
import { LoginGate } from './components/LoginGate';
import { LyricsView } from './components/LyricsView';
import { PlayerBar } from './components/PlayerBar';
import { QueuePanel } from './components/QueuePanel';
import { EqPanel } from './components/EqPanel';
import { describeEqFailure, startEqSync } from './lib/eq';
import { setTheme, type ThemeId } from './lib/theme';
import { lastChartId } from './lib/spotify';
import { Sidebar } from './components/Sidebar';
import { focusSearch, TopBar } from './components/TopBar';
import { ArtistView } from './views/ArtistView';
import { BrowseView } from './views/BrowseView';
import { CollectionView } from './views/CollectionView';
import { HomeView } from './views/HomeView';
import { LibraryView } from './views/LibraryView';
import { SearchView } from './views/SearchView';
import { SpotifyView } from './views/SpotifyView';
import { SettingsView } from './views/SettingsView';
import { ExploreView, MoodView } from './views/ExploreView';
import { StatsView } from './views/StatsView';
import { onVideoWindow } from './lib/tauri';
import { startPrefsSync } from './state/prefs';
import { startNowTrackSync } from './state/nowTrack';
import { stepVolume, toggleMute, VOLUME_STEP } from './state/volume';
import { toggleLike } from './state/library';
import { layoutStore } from './state/ui';
import { startAlbumTheme } from './lib/theme';

// 같은 종류 화면 사이를 옮길 때(앨범 → 다른 앨범) 앞 화면의 상태(보관함 저장 표시·구독 단추·목록 찾기 글자 등)가
// 남지 않게 화면마다 key를 준다.
function View({ route }: { route: Route }) {
  switch (route.name) {
    case 'home':
      return <HomeView />;
    case 'search':
      return <SearchView query={route.query} params={route.params} />;
    case 'album':
      return <CollectionView key={`album:${route.id}`} kind="album" id={route.id} />;
    case 'playlist':
      return <CollectionView key={`playlist:${route.id}`} kind="playlist" id={route.id} />;
    case 'liked':
      return <CollectionView key="liked" kind="liked" />;
    case 'artist':
      return <ArtistView key={`artist:${route.id}`} id={route.id} />;
    case 'browse':
      return <BrowseView key={`browse:${route.id}:${route.params ?? ''}`} id={route.id} params={route.params} title={route.title} />;
    case 'library':
      return <LibraryView tab={route.tab} />;
    case 'explore':
      return <ExploreView />;
    case 'mood':
      return <MoodView key={`mood:${route.params}`} params={route.params} title={route.title} />;
    case 'stats':
      return <StatsView />;
    case 'spotify':
      return <SpotifyView key={`spotify:${route.id}`} id={route.id} />;
    case 'settings':
      return <SettingsView />;
  }
}

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

/**
 * 화면 단축키: 스페이스(재생/일시정지), ⌘/Ctrl+←→(이전·다음 곡), ⌘/Ctrl+↑↓(음량), M(음소거), ⌘/Ctrl+F(검색) 등.
 * 입력 중에는 쓰지 않는다.
 */
function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      const run = (p: Promise<unknown>) => p.catch((err) => toastError(err));
      if (mod && !e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        stepVolume(e.key === 'ArrowUp' ? VOLUME_STEP : -VOLUME_STEP);
      } else if (e.code === 'KeyM' && !mod && !e.altKey && !e.shiftKey && !e.repeat) {
        // 글자 대신 자판 위치(e.code)로 본다: 한글 입력 상태에서는 e.key가 'ㅡ'다.
        e.preventDefault();
        toggleMute({ announce: true });
      } else if (e.code === 'Space' && !mod) {
        e.preventDefault();
        patchPlayer({ playing: !playerStore.get().playing });
        void run(ytm.control('toggle'));
      } else if (mod && e.key === 'ArrowRight') {
        e.preventDefault();
        void run(ytm.control('next'));
      } else if (mod && e.key === 'ArrowLeft') {
        e.preventDefault();
        void run(ytm.control('previous'));
      } else if (!mod && e.key === 'ArrowRight' && e.shiftKey) {
        void run(ytm.control('seekBy', 10));
      } else if (!mod && e.key === 'ArrowLeft' && e.shiftKey) {
        void run(ytm.control('seekBy', -10));
      } else if (mod && (e.key === 'f' || e.key === 'k')) {
        e.preventDefault();
        focusSearch();
      } else if (mod && (e.key === '=' || e.key === '+' || e.key === '-' || e.key === '0')) {
        // 가사 글자 크기(맥은 메뉴 단축키가 먼저 받는다)
        e.preventDefault();
        stepLyricScale(e.key === '-' ? -1 : e.key === '0' ? 0 : 1);
        toggleLyrics(true);
      } else if (mod && e.key === ',') {
        e.preventDefault();
        go({ name: 'settings' });
      } else if (mod && e.key === 'e') {
        e.preventDefault();
        togglePanel('eq');
      } else if (mod && e.key === 'l') {
        e.preventDefault();
        toggleLyrics();
      } else if (mod && e.key === '[') {
        back();
      } else if (mod && e.key === ']') {
        forward();
      } else if (e.altKey && e.key === 'ArrowLeft') {
        back();
      } else if (e.altKey && e.key === 'ArrowRight') {
        forward();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function App() {
  const route = useRoute();
  const lyrics = useLayout((s) => s.lyrics);
  const panel = useLayout((s) => s.panel);
  const main = useRef<HTMLElement>(null);
  const lang = useLang();
  useShortcuts();

  // 맥 메뉴·트레이·창 제목도 지금 언어로(Rust가 다시 만든다).
  useEffect(() => {
    invoke('set_ui_strings', { strings: rustStrings() }).catch((err) => console.warn('[i18n] 메뉴 문구 보내기 실패', err));
  }, [lang]);

  useEffect(() => {
    const stops: Promise<() => void>[] = [
      startPlayerSync(),
      startLibrarySync(),
      startEqSync((reason) => toast(describeEqFailure(reason), 'error')),
      onVideoWindow((open) => layoutStore.set((s) => ({ ...s, video: open }))),
      Promise.resolve(startAlbumTheme(() => playerStore.get().artwork, (fn) => playerStore.subscribe(fn))),
      Promise.resolve(startNowTrackSync()),
    ];
    startPrefsSync();
    stops.push(
      onMenuAction((action) => {
        if (action === 'lyrics') toggleLyrics();
        else if (action === 'queue') togglePanel('queue');
        else if (action === 'eq') togglePanel('eq');
        else if (action === 'lyrics-bigger' || action === 'lyrics-smaller' || action === 'lyrics-reset') {
          stepLyricScale(action === 'lyrics-bigger' ? 1 : action === 'lyrics-smaller' ? -1 : 0);
          toggleLyrics(true);
        }
        else if (action === 'home') go({ name: 'home' });
        else if (action === 'explore') go({ name: 'explore' });
        else if (action === 'stats') go({ name: 'stats' });
        else if (action === 'like-current') {
          const p = playerStore.get();
          if (p.videoId && !p.ad) void toggleLike({ videoId: p.videoId, title: p.title });
        }
        else if (action === 'settings') go({ name: 'settings' });
        else if (action === 'spotify') go({ name: 'spotify', id: lastChartId() });
        else if (action.startsWith('theme:')) setTheme(action.slice(6) as ThemeId);
        else if (action === 'library') go({ name: 'library' });
        else if (action === 'search') focusSearch();
        else if (action === 'back') back();
        else if (action === 'forward') forward();
      }),
    );
    return () => {
      for (const p of stops) void p.then((stop) => stop());
    };
  }, []);

  // 화면을 옮기면 맨 위로, 가사는 닫는다.
  useEffect(() => {
    main.current?.scrollTo({ top: 0 });
    toggleLyrics(false);
  }, [route]);

  return (
    <LangKeyed>
      <div className={`app${panel !== 'none' ? ' app--panel' : ''}`}>
        <Sidebar />
        <main className="main" ref={main}>
          <TopBar />
          <View route={route} />
        </main>
        {lyrics && <LyricsView />}
        {panel === 'queue' && <QueuePanel />}
        {panel === 'eq' && <EqPanel />}
        <PlayerBar />
        <LoginGate />
        <ContextMenuHost />
        <DialogHost />
        <Toasts />
        <TooltipHost />
        {UPDATE_CHECK_ENABLED && <UpdateBanner />}
      </div>
    </LangKeyed>
  );
}
