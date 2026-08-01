import { useCallback, useEffect, useState } from 'react';
import * as api from './lib/api';
import { useTheme } from './lib/theme';
import type { EngineSettings, ScreenType, User } from './types';
import { AnalysisScreen } from './components/GameAnalysis/AnalysisScreen';
import { ClassicScreen } from './components/ClassicScreen';
import { ProgressScreen } from './components/Dashboard/ProgressScreen';
import { Header } from './components/Header';
import { LoginScreen } from './components/LoginScreen';
import { SettingsModal } from './components/SettingsModal';

const SCREEN_KEY = 'engine-room:screen';

export default function App() {
  // One owner for the theme: the dialog is the only thing that sets it, and
  // everything else reads the CSS tokens it writes onto <html>.
  const theme = useTheme();
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [screen, setScreen] = useState<ScreenType>(
    () => (localStorage.getItem(SCREEN_KEY) as ScreenType) || 'analysis',
  );
  const [settings, setSettings] = useState<EngineSettings | null>(null);
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
      return;
    }
    api.getSettings().then(setSettings).catch(() => setSettings(null));
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
    <div className="flex min-h-screen flex-col bg-canvas font-sans text-fg">
      <Header
        currentScreen={screen}
        onSelectScreen={setScreen}
        onOpenSettings={() => setSettingsOpen(true)}
        onLogout={handleLogout}
        user={user}
      />

      {screen === 'analysis' && (
        <AnalysisScreen
          user={user}
          settings={settings}
          onOpenSettings={() => setSettingsOpen(true)}
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
        <ClassicScreen
          title="Puzzles"
          blurb="Puzzles haven't been rebuilt on this UI yet. They run unchanged in the classic
                 UI, against the same puzzle store and the same Glicko-2 rating."
          features={[
            'Puzzles built from your own mistakes',
            'The Lichess puzzle database, filtered by theme',
            'Per-theme progress and a rating across both sources',
          ]}
        />
      )}

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onSaved={setSettings}
        user={user}
        onProfileSaved={setUser}
        themeMode={theme.mode}
        onChangeTheme={theme.setMode}
      />
    </div>
  );
}
