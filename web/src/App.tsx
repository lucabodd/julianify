import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ServerInfo, User } from '../../shared/types';
import { ApiError, api, onUnauthorized } from './api';
import { Icon } from './components/Icon';
import { Modal } from './components/Modal';
import { Toasts, notify, notifyError } from './components/toast';
import { AdminPage } from './pages/AdminPage';
import { LibraryPage } from './pages/LibraryPage';
import { LoginPage } from './pages/LoginPage';
import { PlayerPage } from './pages/PlayerPage';
import { navigate, useRoute } from './router';

interface Session {
  user: User;
  info: ServerInfo | null;
  logout: () => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('Sessione non disponibile');
  return session;
}

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const route = useRoute();

  useEffect(() => {
    api.me().then(setUser, (err) => {
      if (!(err instanceof ApiError && err.status === 401)) notifyError(err);
      setUser(null);
    });
    return onUnauthorized(() => setUser(null));
  }, []);

  useEffect(() => {
    if (user) api.info().then(setInfo, () => setInfo(null));
  }, [user]);

  const logout = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setUser(null);
  }, []);

  if (user === undefined) return <div className="splash">Caricamento…</div>;
  if (user === null) {
    return (
      <>
        <LoginPage onLogin={setUser} />
        <Toasts />
      </>
    );
  }

  return (
    <SessionContext.Provider value={{ user, info, logout }}>
      {route.name === 'score' ? (
        <PlayerPage key={route.id} scoreId={route.id} />
      ) : (
        <div className="page">
          <TopBar />
          {route.name === 'admin' && user.isAdmin ? <AdminPage /> : <LibraryPage />}
        </div>
      )}
      <Toasts />
    </SessionContext.Provider>
  );
}

function TopBar() {
  const { user, logout } = useSession();
  const route = useRoute();
  const [menuOpen, setMenuOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);

  return (
    <header className="topbar">
      <a className="brand" href="#/">
        <img src="/favicon.svg" alt="" width={28} height={28} />
        <span>Julianify</span>
      </a>
      <nav className="topnav">
        <a href="#/" className={route.name === 'library' ? 'active' : ''}>
          <Icon name="music" /> Libreria
        </a>
        {user.isAdmin && (
          <a href="#/admin" className={route.name === 'admin' ? 'active' : ''}>
            <Icon name="users" /> Utenti
          </a>
        )}
      </nav>
      <div className="user-menu">
        <button className="ghost" onClick={() => setMenuOpen((v) => !v)} aria-expanded={menuOpen}>
          <Icon name="user" /> {user.displayName || user.username} <Icon name="chevronDown" size={14} />
        </button>
        {menuOpen && (
          <div className="dropdown" onMouseLeave={() => setMenuOpen(false)}>
            <button
              onClick={() => {
                setMenuOpen(false);
                setPasswordOpen(true);
              }}
            >
              <Icon name="lock" /> Cambia password
            </button>
            <button
              onClick={() => {
                setMenuOpen(false);
                navigate('/');
                void logout();
              }}
            >
              <Icon name="logout" /> Esci
            </button>
          </div>
        )}
      </div>
      {passwordOpen && <ChangePasswordDialog onClose={() => setPasswordOpen(false)} />}
    </header>
  );
}

function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (next !== repeat) {
      notify('Le nuove password non coincidono', 'error');
      return;
    }
    setBusy(true);
    try {
      await api.changePassword(current, next);
      notify('Password aggiornata', 'success');
      onClose();
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Cambia password"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Annulla</button>
          <button className="primary" disabled={busy || !current || next.length < 8} onClick={submit}>
            Salva
          </button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label>
          Password attuale
          <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </label>
        <label>
          Nuova password (almeno 8 caratteri)
          <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </label>
        <label>
          Ripeti nuova password
          <input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        </label>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
