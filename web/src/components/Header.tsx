import { useLayoutEffect, useRef, useState } from 'react';
import { BarChart3, Bot, LayoutDashboard, LogOut, Puzzle, Settings, ShieldCheck } from 'lucide-react';
import type { ScreenType, User } from '../types';

interface HeaderProps {
  currentScreen: ScreenType;
  onSelectScreen: (screen: ScreenType) => void;
  onOpenSettings: () => void;
  onLogout: () => void;
  user: User;
  /** Out of the way (D9/D12). Decided by `useHeaderVisibility`, which App
   *  owns, because stepping through a game asks for it as well as scrolling
   *  does. */
  hidden: boolean;
}

const NAV: { id: ScreenType; label: string; icon: React.ReactNode }[] = [
  { id: 'analysis', label: 'Game Analysis', icon: <BarChart3 className="h-4 w-4" /> },
  { id: 'dashboard', label: 'Progress', icon: <LayoutDashboard className="h-4 w-4" /> },
  { id: 'play', label: 'Play Maia', icon: <Bot className="h-4 w-4" /> },
  { id: 'puzzles', label: 'Puzzles', icon: <Puzzle className="h-4 w-4" /> },
];

export function Header({
  currentScreen,
  onSelectScreen,
  onOpenSettings,
  onLogout,
  user,
  hidden,
}: HeaderProps) {
  const ref = useRef<HTMLElement>(null);
  const [height, setHeight] = useState(0);

  // Its own height, so hiding it is a negative margin of exactly that much:
  // the header leaves the flex column rather than sliding over the content and
  // leaving a band of empty page behind it. Measured rather than assumed —
  // the mobile nav row makes it a different height on a phone.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setHeight(element.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Deliberately not `sticky`: the app shell doesn't scroll — each screen
  // scrolls inside itself — so sticking meant nothing, except that it pinned
  // the header to the top of the shell's scrollport and so survived the
  // negative margin that is supposed to take it away.
  return (
    <header
      ref={ref}
      style={{ marginTop: hidden && height ? -height : 0 }}
      className="z-40 shrink-0 border-b border-line/80 bg-canvas/95 text-fg backdrop-blur-md transition-[margin-top] duration-200 ease-out"
    >
      <div className="mx-auto flex h-16 max-w-[1800px] items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-accent-strong to-accent-deep shadow-md ring-1 ring-accent/30">
            <ShieldCheck className="h-5 w-5 text-on-accent" />
          </div>
          <div className="hidden sm:block">
            <div className="flex items-center gap-2">
              <span className="text-lg font-semibold tracking-tight">Engine Room</span>
            </div>
            <p className="font-mono text-xs text-fg-muted">STOCKFISH · MAIA3</p>
          </div>
        </div>

        <nav className="hidden items-center gap-1 rounded-xl bg-surface/90 p-1 ring-1 ring-line md:flex">
          {NAV.map((item) => (
            <button
              key={item.id}
              onClick={() => onSelectScreen(item.id)}
              className={`flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-medium transition-all ${
                currentScreen === item.id
                  ? 'bg-accent-strong/90 text-on-accent ring-1 ring-accent/30'
                  : 'text-fg-muted hover:bg-surface-2/60 hover:text-fg-2'
              }`}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <span className="hidden text-xs text-fg-muted sm:inline">{user.display_name}</span>
          <button
            onClick={onOpenSettings}
            title="Engine settings"
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface/80 text-fg-2 ring-1 ring-line transition-all hover:bg-surface-2 hover:text-fg"
          >
            <Settings className="h-4 w-4" />
          </button>
          <button
            onClick={onLogout}
            title="Log out"
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface/80 text-fg-2 ring-1 ring-line transition-all hover:bg-surface-2 hover:text-fg"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="scrollbar-none flex overflow-x-auto border-t border-line/60 bg-canvas px-2 py-1.5 md:hidden">
        {NAV.map((item) => (
          <button
            key={item.id}
            onClick={() => onSelectScreen(item.id)}
            className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
              currentScreen === item.id
                ? 'bg-accent-strong text-on-accent'
                : 'text-fg-muted hover:text-fg-2'
            }`}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </div>
    </header>
  );
}
