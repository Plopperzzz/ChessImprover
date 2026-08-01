import { useEffect, useState } from 'react';

/**
 * The stacked layout: one column, board at full width, eval above it.
 *
 * Spelled once because more than the CSS depends on it now — the header hides
 * only here (D9), stepping clears the screen only here (D12), and the eval
 * plot becomes a bar only here (D13). A component that has to *behave*
 * differently can't ask a `lg:` class.
 */
export const NARROW = '(max-width: 1023px)';

/** Whether the window is in that layout, kept current across a resize and an
 *  orientation change. */
export function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);

  useEffect(() => {
    const media = window.matchMedia(NARROW);
    const onChange = () => setNarrow(media.matches);
    // Once on mount as well: the width can have changed between the initial
    // state being computed and the listener being attached.
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return narrow;
}
