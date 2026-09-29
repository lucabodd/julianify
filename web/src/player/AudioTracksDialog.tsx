import { useEffect, useRef, useState } from 'react';
import { AUDIO_EXTENSIONS, type AudioTrack, type LibraryEntry, type ScoreDetail } from '../../../shared/types';
import { api } from '../api';
import { useSession } from '../App';
import { Icon } from '../components/Icon';
import { ConfirmDialog, Modal } from '../components/Modal';
import { notify, notifyError } from '../components/toast';
import { formatTime } from './format';

interface Props {
  score: ScoreDetail;
  activeAudioId: number | null;
  onClose: () => void;
  onChanged: (tracks: AudioTrack[], select?: number) => void;
}

/** Gestione delle tracce audio dello spartito: caricamento, libreria musicale, nomi. */
export function AudioTracksDialog({ score, activeAudioId, onClose, onChanged }: Props) {
  const { info } = useSession();
  const [tracks, setTracks] = useState(score.audioTracks);
  const [uploading, setUploading] = useState<number | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [deleting, setDeleting] = useState<AudioTrack | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const canEdit = score.isOwner;

  const apply = (next: AudioTrack[], select?: number) => {
    setTracks(next);
    onChanged(next, select);
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    const probe = document.createElement('audio');
    if (file.type && probe.canPlayType(file.type) === '') {
      notify(`Il browser potrebbe non riprodurre questo formato (${file.type})`, 'info');
    }
    setUploading(0);
    try {
      const audio = await api.uploadAudio(score.id, file, undefined, setUploading);
      notify('Traccia audio caricata', 'success');
      apply([...tracks, audio], audio.id);
    } catch (err) {
      notifyError(err);
    } finally {
      setUploading(null);
    }
  };

  return (
    <>
      <Modal title="Tracce audio" onClose={onClose} wide>
        <p className="muted small">
          Ogni traccia (es. versione in studio, live, backing track) ha i propri sync point. Formati: {AUDIO_EXTENSIONS.join(', ')}.
        </p>
        <ul className="audio-list">
          {tracks.map((t) => (
            <li key={t.id} className={t.id === activeAudioId ? 'active' : ''}>
              {editing === t.id ? (
                <form
                  className="field-row grow"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    try {
                      const updated = await api.updateAudio(t.id, { name: name.trim() || t.name });
                      apply(tracks.map((x) => (x.id === t.id ? updated : x)));
                      setEditing(null);
                    } catch (err) {
                      notifyError(err);
                    }
                  }}
                >
                  <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
                  <button type="submit">OK</button>
                </form>
              ) : (
                <button className="audio-main" onClick={() => onChanged(tracks, t.id)}>
                  <Icon name={t.source === 'library' ? 'folder' : 'music'} />
                  <span>
                    <strong>{t.name}</strong>
                    <span className="muted small">
                      {t.source === 'library' ? t.libraryPath : 'caricata'} · {t.syncPoints.length} sync point
                      {t.durationMs ? ` · ${formatTime(t.durationMs, 0)}` : ''}
                    </span>
                  </span>
                </button>
              )}
              {canEdit && editing !== t.id && (
                <>
                  <button
                    className="icon-button"
                    title="Rinomina"
                    onClick={() => {
                      setEditing(t.id);
                      setName(t.name);
                    }}
                  >
                    <Icon name="edit" size={15} />
                  </button>
                  <button className="icon-button" title="Elimina" onClick={() => setDeleting(t)}>
                    <Icon name="trash" size={15} />
                  </button>
                </>
              )}
            </li>
          ))}
          {tracks.length === 0 && <li className="muted">Nessuna traccia audio.</li>}
        </ul>
        {canEdit ? (
          <div className="field-row">
            <button className="primary" onClick={() => fileInput.current?.click()} disabled={uploading !== null}>
              <Icon name="upload" /> Carica file audio
            </button>
            {info?.musicLibrary && (
              <button onClick={() => setBrowsing((v) => !v)}>
                <Icon name="folder" /> Scegli dalla libreria musicale
              </button>
            )}
            {uploading !== null && <progress value={uploading} max={1} />}
            <input
              ref={fileInput}
              type="file"
              hidden
              accept={`audio/*,${AUDIO_EXTENSIONS.map((e) => `.${e}`).join(',')}`}
              onChange={(e) => {
                void upload(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </div>
        ) : (
          <p className="notice">Solo il proprietario può aggiungere tracce a questo spartito.</p>
        )}
        {browsing && (
          <LibraryBrowser
            initialQueries={[score.title, score.artist ?? ''].filter((q) => q.trim().length > 1)}
            onPick={async (entry) => {
              try {
                const audio = await api.linkLibraryAudio(score.id, entry.path);
                notify('Traccia collegata dalla libreria', 'success');
                apply([...tracks, audio], audio.id);
                setBrowsing(false);
              } catch (err) {
                notifyError(err);
              }
            }}
          />
        )}
      </Modal>
      {deleting && (
        <ConfirmDialog
          title="Eliminare la traccia audio?"
          message={`“${deleting.name}” e i suoi sync point verranno eliminati${deleting.source === 'library' ? ' (il file nella libreria musicale non viene toccato)' : ''}.`}
          confirmLabel="Elimina"
          danger
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await api.deleteAudio(deleting.id);
              apply(tracks.filter((t) => t.id !== deleting.id));
            } catch (err) {
              notifyError(err);
            }
          }}
        />
      )}
    </>
  );
}

function LibraryBrowser({ initialQueries, onPick }: { initialQueries: string[]; onPick: (entry: LibraryEntry) => void }) {
  const [path, setPath] = useState('');
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const previewRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const q = query.trim();
    const timer = window.setTimeout(
      () => {
        (q ? api.searchLibrary(q) : api.browseLibrary(path))
          .then((res) => {
            if (cancelled) return;
            setEntries(res.entries);
            setTruncated(!!res.truncated);
            if (!q) setPath(res.path);
          })
          .catch(notifyError)
          .finally(() => !cancelled && setLoading(false));
      },
      q ? 300 : 0,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [path, query]);

  // All'apertura prova a cercare il titolo, poi l'artista; se non trova nulla mostra le cartelle.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const q of initialQueries) {
        const res = await api.searchLibrary(q).catch(() => null);
        if (cancelled) return;
        if (res && res.entries.length > 0) {
          setQuery(q);
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // solo all'apertura
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (preview && previewRef.current) void previewRef.current.play().catch(() => undefined);
  }, [preview]);

  const crumbs = path ? path.split('/') : [];

  return (
    <div className="library-browser">
      <div className="search">
        <Icon name="search" />
        <input placeholder="Cerca nella libreria (artista, album, titolo…)" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {!query.trim() && (
        <div className="crumbs">
          <button className="link" onClick={() => setPath('')}>
            Libreria
          </button>
          {crumbs.map((c, i) => (
            <span key={i}>
              {' / '}
              <button className="link" onClick={() => setPath(crumbs.slice(0, i + 1).join('/'))}>
                {c}
              </button>
            </span>
          ))}
        </div>
      )}
      <ul className="browser-list">
        {loading && <li className="muted">Caricamento…</li>}
        {!loading && entries.length === 0 && <li className="muted">Nessun risultato.</li>}
        {entries.map((e) =>
          e.type === 'dir' ? (
            <li key={e.path}>
              <button className="browser-item" onClick={() => setPath(e.path)}>
                <Icon name="folder" /> {e.name}
              </button>
            </li>
          ) : (
            <li key={e.path}>
              <button className="icon-button" title="Ascolta un'anteprima" onClick={() => setPreview(preview === e.path ? null : e.path)}>
                <Icon name={preview === e.path ? 'pause' : 'play'} size={14} />
              </button>
              <button className="browser-item" onClick={() => onPick(e)} title={e.path}>
                <Icon name="music" /> {e.name}
                {query.trim() && <span className="muted small"> — {e.path.slice(0, e.path.lastIndexOf('/'))}</span>}
              </button>
            </li>
          ),
        )}
        {truncated && <li className="muted small">Troppi risultati: affina la ricerca.</li>}
      </ul>
      {preview && <audio ref={previewRef} src={api.libraryStreamUrl(preview)} controls className="preview-audio" />}
    </div>
  );
}
