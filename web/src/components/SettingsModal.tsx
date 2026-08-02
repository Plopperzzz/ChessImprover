import { useEffect, useState } from 'react';
import {
  Bot,
  Cpu,
  Grid2x2,
  Loader2,
  Palette,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import * as api from '../lib/api';
import { setSoundEnabled, soundEnabled } from '../lib/sound';
import { ACCENTS, PALETTES, type ThemeState } from '../lib/theme';
import type { Account, EngineSettings, User } from '../types';
import { ThemeToggle } from './ThemeToggle';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  settings: EngineSettings | null;
  onSaved: (settings: EngineSettings) => void;
  user: User;
  onProfileSaved: (user: User) => void;
  /** Deleting the account you are signed into logs you out server-side, so the
   *  app has to drop the user it is holding. */
  onLoggedOut: () => void;
  theme: ThemeState;
  /** Per-screen board/piece/sound choices (A7). */
  prefs: api.ScreenPrefs | null;
  onPrefsSaved: (prefs: api.ScreenPrefs) => void;
}

/** The screens that draw a board, in the order the header lists them. Must
 *  match `engine_settings.SCREENS`, which rejects anything else. */
const SCREEN_LABELS: { id: api.ScreenPrefName; label: string }[] = [
  { id: 'analysis', label: 'Game Analysis' },
  { id: 'puzzles', label: 'Puzzles' },
  { id: 'play', label: 'Play vs Maia' },
];

const PREF_KINDS = ['board_set', 'piece_set', 'sound_set'] as const;
type PrefKind = (typeof PREF_KINDS)[number];

/** A set that was chosen and has since left the disk still has to appear in
 *  its select, or the control renders blank and the only way to see what is
 *  wrong is to read the database. Marked, and still selected, so changing it
 *  is a choice rather than an accident. */
function withMissing(names: string[], chosen: string): string[] {
  return chosen && !names.includes(chosen) ? [...names, chosen] : names;
}

const optionLabel = (name: string, names: string[]) =>
  names.includes(name) ? name : `${name} (missing)`;

/** Every screen following the defaults — what the draft holds until the real
 *  preferences arrive, and what a reset puts back. */
const emptyScreens = () =>
  Object.fromEntries(
    SCREEN_LABELS.map(({ id }) => [id, { board_set: '', piece_set: '', sound_set: '' }]),
  ) as Record<api.ScreenPrefName, Record<PrefKind, string>>;

type PaneId = 'theme' | 'analysis' | 'maia' | 'board' | 'account';

const PANES: { id: PaneId; label: string; icon: React.ReactNode }[] = [
  { id: 'theme', label: 'Theme', icon: <Palette className="h-4 w-4" /> },
  { id: 'analysis', label: 'Analysis engine', icon: <Cpu className="h-4 w-4" /> },
  { id: 'maia', label: 'Maia engine', icon: <Bot className="h-4 w-4" /> },
  { id: 'board', label: 'Board & pieces', icon: <Grid2x2 className="h-4 w-4" /> },
  { id: 'account', label: 'Account', icon: <UserRound className="h-4 w-4" /> },
];

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium tracking-wide text-fg-muted uppercase">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-fg-subtle">{hint}</span>}
    </label>
  );
}

function PaneHeading({ title, blurb }: { title: string; blurb?: string }) {
  return (
    <div className="mb-4">
      <h3 className="text-xs font-semibold tracking-wider text-accent uppercase">{title}</h3>
      {blurb && <p className="mt-1 text-[11px] leading-relaxed text-fg-subtle">{blurb}</p>}
    </div>
  );
}

const inputClass =
  'w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-fg outline-none focus:border-accent-strong';

/**
 * Settings, as a two-pane dialog: the sub-menu picks a pane, the pane fills
 * the right-hand side.
 *
 * The panes share **one** engine-settings draft. `PUT /api/settings` replaces
 * the whole `EngineSettings` row — a field left out of the body is reset to its
 * pydantic default, not left alone — so splitting the dialog into panes must
 * not turn into one PUT per pane. Same for the profile: the changed fields are
 * collected and sent once.
 *
 * Theme, palette and accent are the exception. They are browser settings the
 * server never sees, and they apply as you click rather than on Save, because
 * the whole point of picking a colour is watching it land.
 */
export function SettingsModal({
  open,
  onClose,
  settings,
  onSaved,
  user,
  onProfileSaved,
  onLoggedOut,
  theme,
  prefs,
  onPrefsSaved,
}: SettingsModalProps) {
  const [pane, setPane] = useState<PaneId>('theme');
  const [draft, setDraft] = useState<EngineSettings | null>(settings);
  const [profile, setProfile] = useState({
    piece_set: user.piece_set,
    board_set: user.board_set,
    sound_set: user.sound_set,
    show_legal_moves: user.show_legal_moves,
  });
  /** The per-screen overrides, edited as a draft and sent on Save like
   *  everything else here. '' is "follow the default", which is also what the
   *  endpoint takes to clear one. */
  const [screens, setScreens] = useState<
    Record<api.ScreenPrefName, Record<PrefKind, string>>
  >(() => emptyScreens());
  const [audio, setAudio] = useState<api.AudioSet[]>([]);
  const [soundOn, setSoundOn] = useState(soundEnabled);
  const [families, setFamilies] = useState<api.EngineFamily[]>([]);
  const [assetSets, setAssetSets] = useState<api.AssetSet[]>([]);
  /** Boards that are only a board -- `assets/boards/*.png`. A separate call
   *  because they are a separate thing on disk: `/api/asset-sets` lists
   *  directories holding pieces (and sometimes a board), and reading only that
   *  is why this dropdown offered three boards while two dozen sat unused. */
  const [boardImages, setBoardImages] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- account pane ---------------------------------------------------------
  const [displayName, setDisplayName] = useState(user.display_name);
  const [username, setUsername] = useState(user.username);
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [accountNote, setAccountNote] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => setDraft(settings), [settings]);

  useEffect(() => {
    setProfile({
      piece_set: user.piece_set,
      board_set: user.board_set,
      sound_set: user.sound_set,
      show_legal_moves: user.show_legal_moves,
    });
    setDisplayName(user.display_name);
    setUsername(user.username);
  }, [user]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setAccountNote(null);
    setConfirmingDelete(false);
    api
      .listEngines()
      .then((r) => setFamilies(r.families))
      .catch(() => setFamilies([]));
    api.assetSets().then(setAssetSets).catch(() => setAssetSets([]));
    api
      .boardImages()
      .then((images) => setBoardImages(images.map((image) => image.name)))
      .catch(() => setBoardImages([]));
    api.audioSets().then(setAudio).catch(() => setAudio([]));
    api.listAccounts().then(setAccounts).catch(() => setAccounts(null));
  }, [open]);

  // Overrides come in as null-means-default; the selects want ''.
  useEffect(() => {
    if (!prefs) return;
    setScreens(
      Object.fromEntries(
        SCREEN_LABELS.map(({ id }) => [
          id,
          Object.fromEntries(PREF_KINDS.map((kind) => [kind, prefs.screens[id][kind] ?? ''])),
        ]),
      ) as Record<api.ScreenPrefName, Record<PrefKind, string>>,
    );
  }, [prefs]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const set = <K extends keyof EngineSettings>(key: K, value: EngineSettings[K]) =>
    setDraft((d) => (d ? { ...d, [key]: value } : d));

  const stockfishFamilies = families.filter((f) => f.kind === 'stockfish');
  const maiaFamilies = families.filter((f) => f.kind === 'maia');
  const pieceOptions = assetSets.filter((s) => s.has_pieces).map((s) => s.name);
  // Both sources, in one list. A name in both -- a set called `neo` alongside a
  // `neo.png` -- is one board as far as the server is concerned (it accepts
  // either spelling and `Board` draws whichever exists), so it appears once.
  const boardOptions = [
    ...new Set([...assetSets.filter((s) => s.has_board).map((s) => s.name), ...boardImages]),
  ].sort();

  const profileChanges = () => {
    const patch: Record<string, unknown> = {};
    if (profile.piece_set !== user.piece_set) patch.piece_set = profile.piece_set;
    if (profile.board_set !== user.board_set) patch.board_set = profile.board_set;
    if (profile.sound_set !== user.sound_set) patch.sound_set = profile.sound_set;
    if (profile.show_legal_moves !== user.show_legal_moves)
      patch.show_legal_moves = Boolean(profile.show_legal_moves);
    return patch;
  };

  /** One patch per screen that actually changed. A screen nobody has touched
   *  is not written, so it keeps following the defaults rather than being
   *  pinned to whatever they happened to be today. */
  const screenChanges = () =>
    SCREEN_LABELS.flatMap(({ id }) => {
      const before = prefs?.screens[id];
      const patch: Record<string, string> = {};
      for (const kind of PREF_KINDS) {
        if ((before?.[kind] ?? '') !== screens[id][kind]) patch[kind] = screens[id][kind];
      }
      return Object.keys(patch).length > 0 ? [[id, patch] as const] : [];
    });

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const patch = profileChanges();
      if (Object.keys(patch).length > 0) onProfileSaved(await api.putProfile(patch));
      let latest: api.ScreenPrefs | null = null;
      for (const [screen, screenPatch] of screenChanges()) {
        latest = await api.putScreenPrefs(screen, screenPatch);
      }
      if (latest) onPrefsSaved(latest);
      // One PUT for every pane's engine settings, carrying every field that
      // was read back -- see `api.saveSettings`.
      if (draft) onSaved(await api.saveSettings(draft));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const rename = async () => {
    setBusy(true);
    setError(null);
    setAccountNote(null);
    try {
      const updated = await api.renameAccount(user.id, {
        username: username.trim().toLowerCase(),
        display_name: displayName.trim(),
      });
      onProfileSaved(updated);
      const { changed, assigned, unassigned } = updated.rematched;
      setAccountNote(
        changed === 0
          ? 'Renamed. Every game already sat on the right side.'
          : `Renamed. ${changed} game${changed === 1 ? '' : 's'} re-matched: ${assigned} now yours, ${unassigned} left unassigned.`,
      );
      api.listAccounts().then(setAccounts).catch(() => undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.deleteAccount(user.id);
      if (result.logged_out) onLoggedOut();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const mine = accounts?.find((a) => a.id === user.id);
  const nameChanged =
    displayName.trim() !== user.display_name || username.trim().toLowerCase() !== user.username;
  const engineSettingsMissing = !draft;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-line bg-surface text-fg shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-lg font-semibold">Settings</h2>
          <button
            onClick={onClose}
            aria-label="Close settings"
            className="rounded-lg p-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          {/* The sub-menu. Horizontal on a phone, where a 160px rail would eat
              half the width. */}
          <nav className="scrollbar-none flex shrink-0 gap-1 overflow-x-auto border-b border-line p-2 sm:w-48 sm:flex-col sm:overflow-x-visible sm:border-r sm:border-b-0 sm:p-3">
            {PANES.map((item) => (
              <button
                key={item.id}
                onClick={() => setPane(item.id)}
                aria-current={pane === item.id}
                className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-medium transition-colors ${
                  pane === item.id
                    ? 'bg-accent-strong text-on-accent'
                    : 'text-fg-muted hover:bg-surface-2 hover:text-fg'
                }`}
              >
                {item.icon}
                <span className="whitespace-nowrap">{item.label}</span>
              </button>
            ))}
          </nav>

          <div className="thin-scroll min-h-0 flex-1 overflow-y-auto p-5">
            {pane === 'theme' && (
              <div className="space-y-6">
                <div>
                  <PaneHeading
                    title="Appearance"
                    blurb="Kept in this browser, not on the server, and applied as you pick — there is nothing here to save."
                  />
                  <ThemeToggle mode={theme.mode} onChange={theme.setMode} />
                </div>

                <div>
                  <PaneHeading
                    title="Palette"
                    blurb="The greys the panels and text are built from. Each is defined for both light and dark."
                  />
                  <div className="flex flex-wrap gap-2">
                    {PALETTES.map((option) => (
                      <button
                        key={option.value}
                        onClick={() => theme.setPalette(option.value)}
                        aria-pressed={theme.palette === option.value}
                        className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
                          theme.palette === option.value
                            ? 'border-accent bg-accent/10 text-fg'
                            : 'border-line text-fg-muted hover:text-fg'
                        }`}
                      >
                        <span
                          className="h-5 w-5 shrink-0 rounded-full ring-1 ring-line-2"
                          style={{
                            backgroundImage: `linear-gradient(135deg, ${option.swatch[0]} 50%, ${option.swatch[1]} 50%)`,
                          }}
                        />
                        <span>
                          <span className="block font-medium">{option.label}</span>
                          <span className="block text-[10px] text-fg-subtle">{option.note}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <PaneHeading
                    title="Accent"
                    blurb="Buttons, highlights and the first series on every chart. Each accent brings its own secondary, used for the calibrated estimate and the second line."
                  />
                  <div className="flex flex-wrap gap-2">
                    {ACCENTS.map((option) => (
                      <button
                        key={option.value}
                        onClick={() => theme.setAccent(option.value)}
                        aria-pressed={theme.accent === option.value}
                        title={option.label}
                        className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors ${
                          theme.accent === option.value
                            ? 'border-accent bg-accent/10 text-fg'
                            : 'border-line text-fg-muted hover:text-fg'
                        }`}
                      >
                        <span
                          className="h-5 w-5 shrink-0 rounded-full"
                          style={{ backgroundColor: option.swatch }}
                        />
                        <span>{option.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {pane === 'analysis' && (
              <div className="space-y-4">
                <PaneHeading
                  title="Analysis engine"
                  blurb="Stockfish: the pass that classifies every move and drives the eval bar."
                />
                {engineSettingsMissing ? (
                  <p className="text-sm text-fg-muted">Loading…</p>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Stockfish" hint={draft.stockfish_binary ?? 'not resolved'}>
                      <select
                        className={inputClass}
                        value={draft.stockfish_path ?? ''}
                        onChange={(e) => set('stockfish_path', e.target.value || null)}
                      >
                        <option value="">none</option>
                        {stockfishFamilies.flatMap((family) =>
                          family.members.map((member) => (
                            <option key={member.value} value={member.value}>
                              {family.label} — {member.name}
                            </option>
                          )),
                        )}
                      </select>
                    </Field>
                    <Field label="Stockfish threads">
                      <input
                        type="number"
                        min={1}
                        max={64}
                        className={inputClass}
                        value={draft.stockfish_threads}
                        onChange={(e) => set('stockfish_threads', Number(e.target.value))}
                      />
                    </Field>
                    <Field label="Search limit">
                      <select
                        className={inputClass}
                        value={draft.sf_limit_type}
                        onChange={(e) =>
                          set('sf_limit_type', e.target.value as 'depth' | 'movetime')
                        }
                      >
                        <option value="depth">depth</option>
                        <option value="movetime">movetime (ms)</option>
                      </select>
                    </Field>
                    <Field label="Limit value">
                      <input
                        type="number"
                        min={1}
                        className={inputClass}
                        value={draft.sf_limit_value}
                        onChange={(e) => set('sf_limit_value', Number(e.target.value))}
                      />
                    </Field>
                  </div>
                )}
              </div>
            )}

            {pane === 'maia' && (
              <div className="space-y-4">
                <PaneHeading
                  title="Maia engine"
                  blurb="The Elo sweep: every position you played is put to Maia at each rating on the grid, and the estimate is the peak of the fitted match-rate curve. A finer step costs proportionally more engine time."
                />
                {engineSettingsMissing ? (
                  <p className="text-sm text-fg-muted">Loading…</p>
                ) : (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Maia" hint={draft.maia_binary ?? 'not resolved'}>
                        <select
                          className={inputClass}
                          value={draft.maia_path ?? ''}
                          onChange={(e) => set('maia_path', e.target.value || null)}
                        >
                          <option value="">none</option>
                          {maiaFamilies.flatMap((family) =>
                            family.members.map((member) => (
                              <option key={member.value} value={member.value}>
                                {family.label} — {member.name}
                              </option>
                            )),
                          )}
                        </select>
                      </Field>
                      <Field label="Maia model size">
                        <select
                          className={inputClass}
                          value={draft.maia_model_size}
                          onChange={(e) => set('maia_model_size', e.target.value)}
                        >
                          {['5m', '25m', '79m'].map((size) => (
                            <option key={size} value={size}>
                              {size}
                            </option>
                          ))}
                        </select>
                      </Field>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-3">
                      <Field label="Elo min">
                        <input
                          type="number"
                          className={inputClass}
                          value={draft.maia_elo_min}
                          onChange={(e) => set('maia_elo_min', Number(e.target.value))}
                        />
                      </Field>
                      <Field label="Elo max">
                        <input
                          type="number"
                          className={inputClass}
                          value={draft.maia_elo_max}
                          onChange={(e) => set('maia_elo_max', Number(e.target.value))}
                        />
                      </Field>
                      <Field label="Step">
                        <input
                          type="number"
                          className={inputClass}
                          value={draft.maia_elo_step}
                          onChange={(e) => set('maia_elo_step', Number(e.target.value))}
                        />
                      </Field>
                      <Field
                        label="Ranked candidates"
                        hint="How deep in Maia's ordering a move still counts."
                      >
                        <input
                          type="number"
                          min={1}
                          max={9}
                          className={inputClass}
                          value={draft.maia_multipv}
                          onChange={(e) => set('maia_multipv', Number(e.target.value))}
                        />
                      </Field>
                      <Field label="Brilliant moves">
                        <select
                          className={inputClass}
                          value={draft.brilliant_enabled ? '1' : '0'}
                          onChange={(e) => set('brilliant_enabled', e.target.value === '1')}
                        >
                          <option value="1">enabled</option>
                          <option value="0">disabled</option>
                        </select>
                      </Field>
                      <Field label="Ask Maia for its policy">
                        <select
                          className={inputClass}
                          value={draft.maia_policy ? '1' : '0'}
                          onChange={(e) => set('maia_policy', e.target.value === '1')}
                        >
                          <option value="1">yes</option>
                          <option value="0">no (score by rank)</option>
                        </select>
                      </Field>
                    </div>
                  </>
                )}
              </div>
            )}

            {pane === 'board' && (
              <div className="space-y-6">
                <div>
                  <PaneHeading
                    title="Defaults"
                    blurb="What every screen draws with unless it has been given something of its own below."
                  />
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field label="Piece set">
                      <select
                        className={inputClass}
                        value={profile.piece_set}
                        onChange={(e) => setProfile((p) => ({ ...p, piece_set: e.target.value }))}
                      >
                        {withMissing(pieceOptions, profile.piece_set).map((name) => (
                          <option key={name} value={name}>
                            {optionLabel(name, pieceOptions)}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Board">
                      <select
                        className={inputClass}
                        value={profile.board_set}
                        onChange={(e) => setProfile((p) => ({ ...p, board_set: e.target.value }))}
                      >
                        {withMissing(boardOptions, profile.board_set).map((name) => (
                          <option key={name} value={name}>
                            {optionLabel(name, boardOptions)}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Sound set">
                      <select
                        className={inputClass}
                        value={profile.sound_set}
                        onChange={(e) => setProfile((p) => ({ ...p, sound_set: e.target.value }))}
                      >
                        {withMissing(
                          audio.map((s) => s.name),
                          profile.sound_set,
                        ).map((name) => (
                          <option key={name} value={name}>
                            {optionLabel(name, audio.map((s) => s.name))}
                            {audio.find((s) => s.name === name)?.complete === false
                              ? ' (board sounds only)'
                              : ''}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                </div>

                <div>
                  <PaneHeading
                    title="Per screen"
                    blurb="A different board, pieces or sounds where you want them. Anything left on Default follows the row above, and keeps following it when that changes."
                  />
                  <div className="thin-scroll -mx-1 overflow-x-auto px-1">
                    <table className="w-full min-w-[28rem] border-separate border-spacing-y-1.5 text-xs">
                      <thead>
                        <tr className="text-[10px] tracking-wide text-fg-subtle uppercase">
                          <th className="text-left font-medium">Screen</th>
                          <th className="text-left font-medium">Pieces</th>
                          <th className="text-left font-medium">Board</th>
                          <th className="text-left font-medium">Sounds</th>
                        </tr>
                      </thead>
                      <tbody>
                        {SCREEN_LABELS.map(({ id, label }) => (
                          <tr key={id}>
                            <td className="pr-2 align-middle text-fg-2">{label}</td>
                            {(
                              [
                                ['piece_set', pieceOptions],
                                ['board_set', boardOptions],
                                ['sound_set', audio.map((s) => s.name)],
                              ] as const
                            ).map(([kind, names]) => (
                              <td key={kind} className="pr-2 align-middle">
                                <select
                                  aria-label={`${label} ${kind.replace('_set', '')}`}
                                  className="w-full rounded-lg border border-line bg-canvas px-2 py-1.5 text-xs text-fg outline-none focus:border-accent-strong"
                                  value={screens[id][kind]}
                                  onChange={(e) =>
                                    setScreens((s) => ({
                                      ...s,
                                      [id]: { ...s[id], [kind]: e.target.value },
                                    }))
                                  }
                                >
                                  <option value="">Default</option>
                                  {withMissing(names, screens[id][kind]).map((name) => (
                                    <option key={name} value={name}>
                                      {optionLabel(name, names)}
                                    </option>
                                  ))}
                                </select>
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="mt-2 text-[11px] text-fg-subtle">
                    Puzzles and Play vs Maia are still the classic UI here; these apply there
                    too, since both front ends read the same preferences.
                  </p>
                </div>

                <div>
                  <PaneHeading title="Board behaviour" />
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Show legal moves">
                      <select
                        className={inputClass}
                        value={profile.show_legal_moves ? '1' : '0'}
                        onChange={(e) =>
                          setProfile((p) => ({
                            ...p,
                            show_legal_moves: e.target.value === '1' ? 1 : 0,
                          }))
                        }
                      >
                        <option value="1">yes</option>
                        <option value="0">no</option>
                      </select>
                    </Field>
                    <Field
                      label="Play sounds"
                      hint="Kept in this browser, and shared with the classic UI."
                    >
                      <select
                        className={inputClass}
                        value={soundOn ? '1' : '0'}
                        onChange={(e) => {
                          const on = e.target.value === '1';
                          setSoundEnabled(on);
                          setSoundOn(on);
                        }}
                      >
                        <option value="1">yes</option>
                        <option value="0">no</option>
                      </select>
                    </Field>
                  </div>
                </div>
              </div>
            )}

            {pane === 'account' && (
              <div className="space-y-4">
                <PaneHeading
                  title="Account"
                  blurb="Your display name is matched against the White/Black headers of everything you upload — it is what decides which side of each game was yours. Renaming re-matches the whole library, which is the fix for games that imported as unassigned."
                />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Display name" hint="Your chess.com or Lichess handle.">
                    <input
                      className={inputClass}
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                    />
                  </Field>
                  <Field label="Username" hint="How you sign in. Lower-cased.">
                    <input
                      className={inputClass}
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                    />
                  </Field>
                </div>
                <button
                  onClick={rename}
                  disabled={busy || !nameChanged || !displayName.trim() || !username.trim()}
                  className="flex items-center gap-2 rounded-lg bg-accent-strong px-4 py-2 text-sm font-semibold text-on-accent hover:bg-accent disabled:opacity-40"
                >
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                  Rename and re-match
                </button>
                {accountNote && <p className="text-[11px] text-positive">{accountNote}</p>}

                <div className="mt-6 rounded-xl border border-danger-line bg-danger-surface p-3">
                  <h4 className="text-xs font-semibold text-danger-fg">Delete this account</h4>
                  <p className="mt-1 text-[11px] leading-relaxed text-fg-2">
                    Removes the account and everything filed under it
                    {mine
                      ? `: ${mine.game_count} game${mine.game_count === 1 ? '' : 's'}, ${
                          mine.analysis_count
                        } analysis run${mine.analysis_count === 1 ? '' : 's'} and ${
                          mine.puzzle_count
                        } puzzle${mine.puzzle_count === 1 ? '' : 's'}`
                      : ''}
                    . This cannot be undone.
                  </p>
                  {confirmingDelete ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        onClick={remove}
                        disabled={busy}
                        className="flex items-center gap-1.5 rounded-lg bg-danger px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                      >
                        {busy ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                        Yes, delete {user.display_name} and all of it
                      </button>
                      <button
                        onClick={() => setConfirmingDelete(false)}
                        className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-2 hover:bg-surface-2"
                      >
                        Keep it
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmingDelete(true)}
                      className="mt-2 flex items-center gap-1.5 rounded-lg border border-danger-line px-3 py-1.5 text-xs font-medium text-danger-fg hover:bg-danger/10"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete account
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {error && (
          <p className="mx-5 mb-2 rounded-lg bg-danger-surface px-3 py-2 text-xs text-danger-fg">
            {error}
          </p>
        )}

        <div className="flex items-center justify-between gap-2 border-t border-line px-5 py-4">
          <p className="hidden text-[11px] text-fg-subtle sm:block">
            Theme changes apply immediately; the rest saves here.
          </p>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded-lg border border-line px-4 py-2 text-sm text-fg-2 hover:bg-surface-2"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="flex items-center gap-2 rounded-lg bg-accent-strong px-4 py-2 text-sm font-semibold text-on-accent hover:bg-accent disabled:opacity-50"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Save settings
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
