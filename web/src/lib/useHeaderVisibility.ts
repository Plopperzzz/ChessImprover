import { useCallback, useEffect, useRef, useState } from 'react';
import { NARROW } from './media';

/** How long an explicit `hide()` outranks the scroll listener. Long enough to
 *  cover a smooth scroll settling — that scroll is *why* the header was
 *  hidden, and it must not be read back as "the reader wants it again". */
const PIN_MS = 800;

export interface HeaderVisibility {
  hidden: boolean;
  /**
   * Hide the header now, regardless of scrolling, and hold it hidden for a
   * moment. Returns whether it applies at this width, so a caller can put the
   * rest of its "get out of the way" behaviour behind the same answer rather
   * than testing the breakpoint a second time.
   */
  hide: () => boolean;
}

/**
 * Whether the top bar is on screen.
 *
 * It leaves upwards as you read down a phone screen and comes back the moment
 * you scroll up. Stepping through a game asks for it directly (`hide`), since
 * that is the other time the screen should be nothing but the game.
 *
 * Lives here rather than in `Header` because two things now decide it, and
 * only one of them is the header's own business.
 *
 * Scroll events don't bubble, so this listens in the capture phase: every
 * screen scrolls inside its own panel rather than moving the window, and this
 * has no way of knowing which panel that is.
 */
export function useHeaderVisibility(): HeaderVisibility {
  const [hidden, setHidden] = useState(false);
  /** While this is in the future, scrolling doesn't get a vote. */
  const pinnedUntil = useRef(0);

  useEffect(() => {
    const narrow = window.matchMedia(NARROW);
    // Per scroller, because more than one can be scrolled on a screen and
    // their positions have nothing to do with each other.
    const lastTop = new WeakMap<EventTarget, number>();

    const onScroll = (event: Event) => {
      const target = event.target;
      if (!target) return;
      const top =
        target === document
          ? window.scrollY
          : ((target as HTMLElement).scrollTop ?? 0);
      const previous = lastTop.get(target) ?? 0;
      // Recorded even while pinned, so the first scroll after the pin expires
      // is measured from where the page actually is rather than from a jump.
      lastTop.set(target, top);
      if (!narrow.matches || Date.now() < pinnedUntil.current) return;
      const delta = top - previous;
      // A few pixels of wobble — a tap that nudges the list, momentum settling
      // — is not a direction, and flickering the header is worse than leaving
      // it where it is.
      if (Math.abs(delta) < 6) return;
      // Near the top there is nothing to gain by hiding, and hiding there is
      // what makes a header feel like it's fighting you.
      setHidden(delta > 0 && top > 64);
    };

    const onWidthChange = () => setHidden(false);
    window.addEventListener('scroll', onScroll, true);
    narrow.addEventListener('change', onWidthChange);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      narrow.removeEventListener('change', onWidthChange);
    };
  }, []);

  const hide = useCallback(() => {
    if (!window.matchMedia(NARROW).matches) return false;
    pinnedUntil.current = Date.now() + PIN_MS;
    setHidden(true);
    return true;
  }, []);

  return { hidden, hide };
}
