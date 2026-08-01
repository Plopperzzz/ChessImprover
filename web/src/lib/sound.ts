/**
 * The sounds a board makes.
 *
 * Files live in `assets/audio/<set>/`, one subdirectory per set with the same
 * names inside each (B9). `default` is the original flat directory, moved
 * rather than copied, and the classic UI plays from the same place — so a set
 * chosen in either front end is heard in both.
 *
 * Sounds only ever follow something the user did: a move they stepped to, a
 * game ending. Never the analysis animation, which walks a hundred positions
 * and would be unbearable.
 */

/** Named for the event rather than the file, so a set can rename its art
 *  without every caller learning about it. Mirrors `paths.AUDIO_FILES`. */
export const SOUND_FILES = {
  move: 'move-self.webm',
  opponent: 'move-opponent.webm',
  capture: 'capture.webm',
  castle: 'castle.webm',
  check: 'move-check.webm',
  promote: 'promote.webm',
  illegal: 'illegal.webm',
  start: 'game-start.webm',
  end: 'game-end.webm',
  lowtime: 'tenseconds.webm',
  brilliant: 'brilliant-86fb4d6.mp3',
  correct: 'correct-c1411f4.mp3',
  wrong: 'fail-blip-hi-2b78df0.mp3',
  solved: 'puzzle-solved-fee614d.mp3',
} as const;

export type SoundName = keyof typeof SOUND_FILES;

const DEFAULT_SET = 'default';
/** The key the classic UI already uses, so muting in one UI mutes both. */
const SOUND_KEY = 'sound';

const cache = new Map<string, HTMLAudioElement>();

export function soundEnabled(): boolean {
  return localStorage.getItem(SOUND_KEY) !== 'off';
}

export function setSoundEnabled(on: boolean): void {
  localStorage.setItem(SOUND_KEY, on ? 'on' : 'off');
}

function element(set: string, name: SoundName): HTMLAudioElement {
  const key = `${set}/${name}`;
  let audio = cache.get(key);
  if (!audio) {
    audio = new Audio(`/assets/audio/${set}/${SOUND_FILES[name]}`);
    audio.volume = 0.55;
    // A set is allowed to carry the board sounds and not the puzzle ones
    // (`paths.AUDIO_REQUIRED`), so a missing file falls back to the default
    // set's copy rather than playing nothing.
    if (set !== DEFAULT_SET) {
      audio.addEventListener(
        'error',
        () => {
          audio!.src = `/assets/audio/${DEFAULT_SET}/${SOUND_FILES[name]}`;
        },
        { once: true },
      );
    }
    cache.set(key, audio);
  }
  return audio;
}

export function playSound(set: string, name: SoundName): void {
  if (!soundEnabled()) return;
  try {
    const audio = element(set || DEFAULT_SET, name);
    audio.currentTime = 0;
    // Autoplay policy rejects until the page has been interacted with. Every
    // call here follows a click or a key, but a rejected promise must not
    // surface as an unhandled rejection.
    void audio.play().catch(() => undefined);
  } catch {
    // Sound is never worth breaking a move over.
  }
}

/** The sound a move makes, read off its SAN — which works whether the move was
 *  played, arrived from the server, or was stepped onto in a stored game. */
export function playMoveSound(set: string, san: string | null, mine: boolean): void {
  if (!san) {
    playSound(set, mine ? 'move' : 'opponent');
    return;
  }
  if (san.includes('#') || san.includes('+')) playSound(set, 'check');
  else if (san.includes('=')) playSound(set, 'promote');
  else if (san.startsWith('O-O')) playSound(set, 'castle');
  else if (san.includes('x')) playSound(set, 'capture');
  else playSound(set, mine ? 'move' : 'opponent');
}
