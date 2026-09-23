import React, { useState } from 'react';

// Full-screen gate shown until the owner is logged in. Rendered inside the
// existing stage background so the brand look carries through.
export default function OwnerGate({ configured, usernameRequired, onAuthenticated }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        onAuthenticated();
        return;
      }
      setError(
        data.message ||
          (res.status === 429
            ? 'Too many attempts. Wait a few minutes.'
            : 'Incorrect login.')
      );
    } catch (err) {
      setError(`Network error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  const input =
    'w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-lg ' +
    'text-white placeholder-teslyr-mute outline-none focus:border-teslyr-crimson';

  return (
    <div className="relative flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="w-full max-w-sm animate-riseIn">
        <p className="font-display text-5xl font-extrabold tracking-tight text-teslyr-crimson sm:text-6xl">
          Teslyr
        </p>

        {configured ? (
          <>
            <p className="mt-3 text-sm uppercase tracking-[0.22em] text-teslyr-mute">
              Owner login
            </p>
            <form onSubmit={submit} className="mt-8 flex flex-col gap-3 text-left">
              {usernameRequired ? (
                <input
                  className={input}
                  type="text"
                  autoComplete="username"
                  placeholder="Username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  aria-label="Username"
                />
              ) : null}
              <input
                className={input}
                type="password"
                autoComplete="current-password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-label="Password"
                autoFocus
              />
              <button
                type="submit"
                disabled={busy}
                className="mt-2 rounded-xl bg-teslyr-crimson px-4 py-3 text-lg font-semibold text-white active:bg-teslyr-ember disabled:opacity-60"
              >
                {busy ? 'Unlocking…' : 'Unlock'}
              </button>
              {error ? (
                <p className="mt-1 text-sm text-teslyr-ember" role="alert">
                  {error}
                </p>
              ) : null}
            </form>
          </>
        ) : (
          <div className="mt-6 text-teslyr-soft">
            <p className="text-lg font-semibold text-white">Playback is locked</p>
            <p className="mt-3 text-sm leading-relaxed text-teslyr-mute">
              Owner login isn’t configured yet. Set{' '}
              <code className="rounded bg-black/50 px-1.5 py-0.5 text-teslyr-soft">
                OWNER_PASSWORD
              </code>{' '}
              on the server to unlock the car’s now-playing lyrics.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
