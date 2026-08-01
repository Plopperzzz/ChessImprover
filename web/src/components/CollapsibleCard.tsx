import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

interface CollapsibleCardProps {
  title: string;
  /** Shown beside the title, in the folded state as much as the open one:
   *  a folded panel still has to say what is inside it. */
  summary?: ReactNode;
  icon?: ReactNode;
  /** Remembered across reloads under this key, the way the Games list on the
   *  analysis screen remembers whether you left it open. */
  storageKey: string;
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * A panel that folds, with its state kept.
 *
 * The Puzzles tab has four things beside the board that are reference rather
 * than action -- the motif picker, your per-motif record, the Lichess import
 * -- and open by default they push the board and its buttons off a phone
 * screen. Folded they cost a row each and say what is behind them, which is
 * all they need to do until you go looking.
 */
export function CollapsibleCard({
  title,
  summary,
  icon,
  storageKey,
  defaultOpen = false,
  children,
}: CollapsibleCardProps) {
  const [open, setOpen] = useState(() => {
    const stored = localStorage.getItem(storageKey);
    return stored == null ? defaultOpen : stored === '1';
  });

  const toggle = () => {
    setOpen((was) => {
      localStorage.setItem(storageKey, was ? '0' : '1');
      return !was;
    });
  };

  return (
    <div className="rounded-xl border border-line bg-surface">
      <button
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left"
      >
        <span className="flex min-w-0 items-center gap-2">
          {icon}
          <span className="text-xs font-semibold tracking-wide text-fg-2 uppercase">
            {title}
          </span>
          {summary != null && (
            <span className="truncate text-[11px] font-normal text-fg-subtle">{summary}</span>
          )}
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-fg-subtle transition-transform ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>
      {open && <div className="border-t border-line">{children}</div>}
    </div>
  );
}
