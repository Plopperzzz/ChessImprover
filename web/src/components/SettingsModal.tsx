import { useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import * as api from '../lib/api';
import type { ThemeMode } from '../lib/theme';
import type { EngineSettings, User } from '../types';
import { ThemeToggle } from './ThemeToggle';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  settings: EngineSettings | null;
  onSaved: (settings: EngineSettings) => void;
  user: User;
  onProfileSaved: (user: User) => void;
  themeMode: ThemeMode;
  onChangeTheme: (mode: ThemeMode) => void;
}

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

const inputClass =
  'w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-fg outline-none focus:border-accent-strong';

export function SettingsModal({
  open,
  onClose,
  settings,
  onSaved,
  user,
  onProfileSaved,
  themeMode,
  onChangeTheme,
}: SettingsModalProps) {
  const [draft, setDraft] = useState<EngineSettings | null>(settings);
  const [families, setFamilies] = useState<api.EngineFamily[]>([]);
  const [assetSets, setAssetSets] = useState<api.AssetSet[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setDraft(settings), [settings]);

  useEffect(() => {
    if (!open) return;
    api
      .listEngines()
      .then((r) => setFamilies(r.families))
      .catch(() => setFamilies([]));
    api.assetSets().then(setAssetSets).catch(() => setAssetSets([]));
  }, [open]);

  if (!open) return null;

  const set = <K extends keyof EngineSettings>(key: K, value: EngineSettings[K]) =>
    setDraft((d) => (d ? { ...d, [key]: value } : d));

  const stockfishFamilies = families.filter((f) => f.kind === 'stockfish');
  const maiaFamilies = families.filter((f) => f.kind === 'maia');

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      // PUT replaces the whole settings row, so the draft carries every field
      // that was read back -- see `api.saveSettings`.
      onSaved(await api.saveSettings(draft));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const setProfile = async (patch: Record<string, unknown>) => {
    try {
      onProfileSaved(await api.putProfile(patch));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="thin-scroll max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-line bg-surface p-6 text-fg shadow-2xl"
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Settings</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Outside the `draft` check on purpose: the theme is a browser
            setting, so it stays usable even when the engine settings that fill
            the rest of the dialog haven't loaded (or failed to). */}
        <section className="mb-6 space-y-3 border-b border-line pb-6">
          <h3 className="text-xs font-semibold tracking-wider text-accent uppercase">
            Appearance
          </h3>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-xs text-[11px] leading-relaxed text-fg-subtle">
              Light, dark, or whichever the operating system is set to. Kept in this
              browser — it is not part of the engine settings the server stores.
            </p>
            <ThemeToggle mode={themeMode} onChange={onChangeTheme} />
          </div>
        </section>

        {!draft ? (
          <p className="text-sm text-fg-muted">Loading…</p>
        ) : (
          <div className="space-y-6">
            <section className="space-y-3">
              <h3 className="text-xs font-semibold tracking-wider text-accent uppercase">
                Engines
              </h3>
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
                    onChange={(e) => set('sf_limit_type', e.target.value as 'depth' | 'movetime')}
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
            </section>

            <section className="space-y-3">
              <h3 className="text-xs font-semibold tracking-wider text-accent uppercase">
                Elo sweep
              </h3>
              <p className="text-[11px] leading-relaxed text-fg-subtle">
                The grid the Full analysis button sweeps. Every position you played is put to
                Maia at each of these ratings; the estimate is the peak of the fitted match-rate
                curve. A finer step costs proportionally more engine time.
              </p>
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
            </section>

            <section className="space-y-3">
              <h3 className="text-xs font-semibold tracking-wider text-accent uppercase">
                Board
              </h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Piece set">
                  <select
                    className={inputClass}
                    value={user.piece_set}
                    onChange={(e) => setProfile({ piece_set: e.target.value })}
                  >
                    {assetSets
                      .filter((s) => s.has_pieces)
                      .map((s) => (
                        <option key={s.name} value={s.name}>
                          {s.name}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label="Board">
                  <select
                    className={inputClass}
                    value={user.board_set}
                    onChange={(e) => setProfile({ board_set: e.target.value })}
                  >
                    {assetSets
                      .filter((s) => s.has_board)
                      .map((s) => (
                        <option key={s.name} value={s.name}>
                          {s.name}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label="Show legal moves">
                  <select
                    className={inputClass}
                    value={user.show_legal_moves ? '1' : '0'}
                    onChange={(e) => setProfile({ show_legal_moves: e.target.value === '1' })}
                  >
                    <option value="1">yes</option>
                    <option value="0">no</option>
                  </select>
                </Field>
              </div>
            </section>

            {error && (
              <p className="rounded-lg bg-danger-surface px-3 py-2 text-xs text-danger-fg">{error}</p>
            )}

            <div className="flex justify-end gap-2 border-t border-line pt-4">
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
                Save engine settings
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
