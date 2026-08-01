import { useCallback, useEffect, useState } from 'react';
import * as api from './lib/api';
import { useHeaderVisibility } from './lib/useHeaderVisibility';
import { useTheme } from './lib/theme';
import type { EngineSettings, ScreenType, User } from './types';
import { AnalysisScreen } from './components/GameAnalysis/AnalysisScreen';
import { ClassicScreen } from './components/ClassicScreen';
import { ProgressScreen } from './components/Dashboard/ProgressScreen';
import { Header } from './components/Header';
import { LoginScreen } from './components/LoginScreen';
import { PuzzleScreen } from './components/Puzzles/PuzzleScreen';
import { SettingsModal } from './components/SettingsModal';

const SCREEN_KEY = 'engine-room:screen';

export default function App() {
  // One owner for the theme: the dialog is the only thing that sets it, and
  // everything else reads the CSS tokens it writes onto <html>.
  const theme = useTheme();
  // Whether the top bar is on screen. Owned here because two things ask for
  // it: reading down a phone screen, and stepping through a game.
  const header = useHeaderVisibility();
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [screen, setScreen] = useState<ScreenType>(
    () => (localStorage.getItem(SCREEN_KEY) as ScreenType) || 'analysis',
  );
  const [settings, setSettings] = useState<EngineSettings | null>(null);
  const [prefs, setPrefs] = useState<api.ScreenPrefs | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // The session cookie outlives the page, so a reload asks who it belongs to
  // rather than sending you back through the account picker.
  useEffect(() => {
    api
      .me()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    if (!user) {
      setSettings(null);
      setPrefs(null);
      return;
    }
    api.getSettings().then(setSettings).catch(() => setSettings(null));
    // Which board, pieces and sounds each screen draws with (A7). Fetched
    // here rather than per screen so switching tabs doesn't re-ask.
    api.screenPrefs().then(setPrefs).catch(() => setPrefs(null));
  }, [user]);

  useEffect(() => localStorage.setItem(SCREEN_KEY, screen), [screen]);

  const handleLogout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setUser(null);
    }
  }, []);

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas text-sm text-fg-subtle">
        Loading…
      </div>
    );
  }

  if (!user) return <LoginScreen onLogin={setUser} />;

  return (
    // h-screen, not min-h-screen: both columns of the analysis screen scroll
    // inside themselves, which only works when the row they sit in has a
    // height to divide. With min-h- the page grew instead and the library's
    // upload controls ended up below the fold (B12).
    <div className="flex h-screen flex-col overflow-hidden bg-canvas font-sans text-fg">
      <Header
        currentScreen={screen}
        onSelectScreen={setScreen}
        onOpenSettings={() => setSettingsOpen(true)}
        onLogout={handleLogout}
        user={user}
        hidden={header.hidden}
      />

      {screen === 'analysis' && (
        <AnalysisScreen
          user={user}
          settings={settings}
          prefs={prefs}
          onOpenSettings={() => setSettingsOpen(true)}
          onHideHeader={header.hide}
        />
      )}
      {screen === 'dashboard' && <ProgressScreen />}
      {screen === 'play' && (
        <ClassicScreen
          title="Play vs Maia"
          blurb="Playing a live game against Maia hasn't been rebuilt on this UI yet. It runs
                 unchanged in the classic UI, over the same websocket and the same engine pool."
          features={[
            'Pick Maia’s Elo, your colour and a time control',
            'Pre-moves, and looking back through the game while you play',
            'Save the finished game straight into your library',
          ]}
        />
      )}
      {screen === 'puzzles' && (
        <PuzzleScreen
          user={user}
          settings={settings}
          prefs={prefs}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      )}

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onSaved={setSettings}
        user={user}
        onProfileSaved={setUser}
        onLoggedOut={() => setUser(null)}
        theme={theme}
        prefs={prefs}
        onPrefsSaved={setPrefs}
      />
    </div>
  );
}
