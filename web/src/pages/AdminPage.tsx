import { useEffect, useState } from 'react';
import type { User } from '../../../shared/types';
import { api } from '../api';
import { useSession } from '../App';
import { Icon } from '../components/Icon';
import { ConfirmDialog, Modal } from '../components/Modal';
import { notify, notifyError } from '../components/toast';

export function AdminPage() {
  const { user: me, info } = useSession();
  const worker = info?.worker;
  const [users, setUsers] = useState<User[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<User | null>(null);
  const [deleting, setDeleting] = useState<User | null>(null);

  const reload = () => api.listUsers().then(setUsers, notifyError);
  useEffect(() => {
    void reload();
  }, []);

  const patch = async (user: User, data: Parameters<typeof api.updateUser>[1]) => {
    try {
      await api.updateUser(user.id, data);
      await reload();
    } catch (err) {
      notifyError(err);
    }
  };

  return (
    <main className="admin">
      <div className="library-toolbar">
        <h1>Utenti</h1>
        <span className="spacer" />
        <button className="primary" onClick={() => setCreating(true)}>
          <Icon name="plus" /> Nuovo utente
        </button>
      </div>
      <p className="muted">
        Solo gli utenti abilitati possono accedere. Ogni utente ha i propri spartiti; gli spartiti condivisi sono visibili a
        tutti, mentre note e loop restano personali.
      </p>
      {users && (
        <table className="table">
          <thead>
            <tr>
              <th>Utente</th>
              <th>Ruolo</th>
              <th>Stato</th>
              <th>Ultimo accesso</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={u.isEnabled ? '' : 'disabled-row'}>
                <td>
                  <strong>{u.username}</strong>
                  {u.displayName && <span className="muted"> — {u.displayName}</span>}
                  {u.id === me.id && <span className="badge">tu</span>}
                </td>
                <td>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={u.isAdmin}
                      disabled={u.id === me.id}
                      onChange={(e) => void patch(u, { isAdmin: e.target.checked })}
                    />
                    Amministratore
                  </label>
                </td>
                <td>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={u.isEnabled}
                      disabled={u.id === me.id}
                      onChange={(e) => void patch(u, { isEnabled: e.target.checked })}
                    />
                    Abilitato
                  </label>
                </td>
                <td className="muted">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('it-IT') : 'mai'}</td>
                <td className="row-actions">
                  <button className="icon-button" title="Imposta password" onClick={() => setResetting(u)}>
                    <Icon name="lock" />
                  </button>
                  <button className="icon-button" title="Elimina" disabled={u.id === me.id} onClick={() => setDeleting(u)}>
                    <Icon name="trash" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="admin-subtitle">Worker di calcolo</h2>
      {worker ? (
        <p className={worker.status === 'ready' ? 'muted' : 'notice'}>
          {worker.status === 'ready' && (
            <>
              <span className="badge success">attivo</span> Separazione degli strumenti: {worker.stems ? 'sì' : 'no'} ·
              sincronizzazione automatica: {worker.autosync ? 'sì' : 'no'} · {worker.threads ?? '?'} thread su{' '}
              {worker.device === 'cuda' ? 'GPU' : 'CPU'}.
            </>
          )}
          {worker.status === 'detecting' && 'Verifica del worker Python in corso…'}
          {(worker.status === 'unavailable' || worker.status === 'disabled') && (
            <>
              <span className="badge">non attivo</span> Senza il worker Python non sono disponibili la separazione degli
              strumenti (Demucs) e la sincronizzazione automatica. Per attivarlo reinstalla con <code>WITH_WORKER=1</code>{' '}
              (vedi README).
            </>
          )}
          {worker.message && <span className="small"> {worker.message}</span>}
        </p>
      ) : (
        <p className="muted">Stato non disponibile.</p>
      )}
      {creating && (
        <CreateUserDialog
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void reload();
          }}
        />
      )}
      {resetting && <ResetPasswordDialog user={resetting} onClose={() => setResetting(null)} />}
      {deleting && (
        <ConfirmDialog
          title="Eliminare l'utente?"
          message={`L'utente “${deleting.username}” verrà eliminato insieme a tutti i suoi spartiti, tracce audio, note e loop.`}
          confirmLabel="Elimina"
          danger
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await api.deleteUser(deleting.id);
              notify('Utente eliminato', 'success');
              await reload();
            } catch (err) {
              notifyError(err);
            }
          }}
        />
      )}
    </main>
  );
}

function CreateUserDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await api.createUser({ username: username.trim(), password, displayName: displayName.trim() || undefined, isAdmin });
      notify(`Utente “${username}” creato`, 'success');
      onCreated();
    } catch (err) {
      notifyError(err);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Nuovo utente"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Annulla</button>
          <button className="primary" disabled={busy || !username || password.length < 8} onClick={submit}>
            Crea
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
          Nome utente
          <input value={username} autoComplete="off" onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label>
          Nome visualizzato (facoltativo)
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <label>
          Password (almeno 8 caratteri)
          <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
          Amministratore (può gestire gli utenti)
        </label>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function ResetPasswordDialog({ user, onClose }: { user: User; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api.updateUser(user.id, { password });
      notify(`Password di “${user.username}” aggiornata`, 'success');
      onClose();
    } catch (err) {
      notifyError(err);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Nuova password per ${user.username}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Annulla</button>
          <button className="primary" disabled={busy || password.length < 8} onClick={submit}>
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
          Nuova password (almeno 8 caratteri)
          <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <p className="muted small">Le sessioni aperte dall'utente verranno chiuse.</p>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
