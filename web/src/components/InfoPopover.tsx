import { useEffect, useId, useRef, useState } from 'react';
import { Info } from 'lucide-react';

interface InfoPopoverProps {
  /** Read out to screen readers, and the button's tooltip. */
  label: string;
  children: React.ReactNode;
  /** Which side of the button the panel opens towards. */
  align?: 'left' | 'right';
}

/**
 * An `i` in a circle that opens a small panel.
 *
 * The Progress screen had two blocks of caveat text sitting permanently on
 * screen — what the fit is unsure about, and what its confidence means. Both
 * are worth reading once and not on every visit, which is what this is for.
 *
 * Click to open, click anywhere else or press Escape to close. Deliberately
 * not hover: the content is a paragraph, and a panel that vanishes when the
 * pointer crosses a gap can't be read.
 */
export function InfoPopover({ label, children, align = 'right' }: InfoPopoverProps) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLSpanElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <span ref={wrapper} className="relative inline-flex align-middle">
      <button
        type="button"
        title={label}
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((v) => !v)}
        className={`flex h-4 w-4 items-center justify-center rounded-full text-fg-subtle transition-colors hover:text-accent ${
          open ? 'text-accent' : ''
        }`}
      >
        <Info className="h-3.5 w-3.5" />
      </button>

      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label={label}
          className={`absolute top-6 z-30 w-72 rounded-xl border border-line bg-surface p-3 text-left text-[11px] leading-relaxed font-normal tracking-normal text-fg-2 normal-case shadow-xl ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          {children}
        </div>
      )}
    </span>
  );
}
