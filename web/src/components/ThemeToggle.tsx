import { Monitor, Moon, Sun } from 'lucide-react';
import { THEME_MODES, type ThemeMode } from '../lib/theme';

const ICON: Record<ThemeMode, React.ReactNode> = {
  light: <Sun className="h-3.5 w-3.5" />,
  system: <Monitor className="h-3.5 w-3.5" />,
  dark: <Moon className="h-3.5 w-3.5" />,
};

/** Light / System / Dark, as a segmented control. `system` is the middle
 *  option because it sits between the two it can resolve to. */
export function ThemeToggle({
  mode,
  onChange,
}: {
  mode: ThemeMode;
  onChange: (mode: ThemeMode) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-canvas p-1">
      {THEME_MODES.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={mode === option.value}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            mode === option.value
              ? 'bg-accent-strong text-on-accent'
              : 'text-fg-muted hover:bg-surface-2 hover:text-fg'
          }`}
        >
          {ICON[option.value]}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}
