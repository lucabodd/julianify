import { useState } from 'react';
import type { User } from '../../../shared/types';
import { api } from '../api';

export function LoginPage({ onLogin }: { onLogin: (user: User) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLogin(await api.login(username.trim(), password));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <img src="/favicon.svg" alt="" width={56} height={56} />
          <h1>Julianify</h1>
          <p>Spartiti e tablature a tempo con la registrazione originale</p>
        </div>
        <label>
          Nome utente
          <input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label>
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <div className="form-error">{error}</div>}
        <button className="primary" type="submit" disabled={busy || !username || !password}>
          {busy ? 'Accesso…' : 'Entra'}
        </button>
      </form>
    </div>
  );
}
