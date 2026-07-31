import { useEffect, useState } from 'react';
import { ShieldCheck, UserPlus } from 'lucide-react';
import * as api from '../lib/api';
import type { Account, User } from '../types';

/** No passwords: this is the two-person home app the backend was written for
 *  (`auth.create_account`), so signing in is picking which account you are. */
export function LoginScreen({ onLogin }: { onLogin: (user: User) => void }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .listAccounts()
      .then(setAccounts)
      .catch((e) => setError(e.message));
  }, []);

  const signIn = async (name: string) => {
    setBusy(true);
    setError(null);
    try {
      onLogin(await api.login(name));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createAccount(username.trim(), displayName.trim());
      await signIn(username.trim().toLowerCase());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-stone-950 p-6 text-stone-100">
      <div className="w-full max-w-sm rounded-2xl border border-stone-800 bg-stone-900 p-6 shadow-2xl">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-amber-600 to-amber-800 ring-1 ring-amber-500/30">
            <ShieldCheck className="h-5 w-5 text-amber-100" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Engine Room</h1>
            <p className="text-xs text-stone-400">Pick your account</p>
          </div>
        </div>

        {accounts === null && !error && <p className="text-sm text-stone-400">Loading…</p>}

        <div className="space-y-2">
          {accounts?.map((account) => (
            <button
              key={account.id}
              disabled={busy}
              onClick={() => signIn(account.username)}
              className="flex w-full items-center justify-between rounded-xl border border-stone-800 bg-stone-950 px-4 py-3 text-left transition-colors hover:border-amber-600/50 hover:bg-stone-900 disabled:opacity-50"
            >
              <span>
                <span className="block text-sm font-semibold">{account.display_name}</span>
                <span className="block font-mono text-[11px] text-stone-500">
                  {account.username}
                </span>
              </span>
              <span className="font-mono text-[11px] text-stone-500">
                {account.game_count} games
              </span>
            </button>
          ))}
        </div>

        {accounts?.length === 0 && (
          <p className="mb-3 text-sm text-stone-400">
            No accounts yet — make the first one.
          </p>
        )}

        {showCreate ? (
          <form onSubmit={create} className="mt-4 space-y-2">
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="username"
              required
              className="w-full rounded-lg border border-stone-800 bg-stone-950 px-3 py-2 text-sm outline-none focus:border-amber-600"
            />
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="display name (must match your PGN headers)"
              required
              className="w-full rounded-lg border border-stone-800 bg-stone-950 px-3 py-2 text-sm outline-none focus:border-amber-600"
            />
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-lg bg-amber-600 px-3 py-2 text-sm font-semibold text-white hover:bg-amber-500 disabled:opacity-50"
            >
              Create and sign in
            </button>
          </form>
        ) : (
          <button
            onClick={() => setShowCreate(true)}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg border border-stone-800 px-3 py-2 text-xs text-stone-400 hover:text-stone-200"
          >
            <UserPlus className="h-3.5 w-3.5" /> New account
          </button>
        )}

        {error && (
          <p className="mt-4 rounded-lg bg-red-950/60 px-3 py-2 text-xs text-red-300">{error}</p>
        )}
      </div>
    </div>
  );
}
