import { useEffect, useRef, useState } from 'react';
import {
  AUDIO_EXTENSIONS,
  AUDIO_VARIANT_ORDER,
  AUDIO_VARIANTS,
  type AudioTrack,
  type AudioVariant,
  type LibraryEntry,
  type ScoreDetail,
} from '../../../shared/types';
import { api } from '../api';
import { useSession } from '../App';
import { Icon } from '../components/Icon';
import { ConfirmDialog, Modal } from '../components/Modal';
import { notify, notifyError } from '../components/toast';
import { formatTime } from './format';
import { JobProgress } from './JobProgress';
import { isJobActive, type JobsState } from './useJobs';

interface Props {
  score: ScoreDetail;
  activeAudioId: number | null;
  jobs: JobsState;
  onClose: () => void;
  onChanged: (tracks: AudioTrack[], select?: number) => void;
}

const DEFAULT_VARIANTS: AudioVariant[] = ['no_guitar', 'guitar'];

export function variantOrder(track: AudioTrack): number {
  return track.variant ? AUDIO_VARIANT_ORDER.indexOf(track.variant) : -1;
}

/**
 * Gestione delle tracce audio dello spartito: caricamento, libreria musicale,
 * nomi e separazione degli strumenti (versioni senza chitarra, solo chitarra…).
 */
export function AudioTracksDialog({ score, activeAudioId, jobs, onClose, onChanged }: Props) {
  const { info } = useSession();
  const tracks = score.audioTracks;
  const [uploading, setUploading] = useState<number | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [deleting, setDeleting] = useState<AudioTrack | null>(null);
  const [separating, setSeparating] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const canEdit = score.isOwner;
  const worker = info?.worker ?? null;

  const apply = (next: AudioTrack[], select?: number) => onChanged(next, select);
  const originals = tracks.filter((t) => t.parentId === null);
  const variantsOf = (id: number) => tracks.filter((t) => t.parentId === id).sort((a, b) => variantOrder(a) - variantOrder(b));
  const stemsJob = (id: number) => jobs.jobs.find((j) => j.kind === 'stems' && j.audioId === id) ?? null;

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
          Ogni registrazione (es. versione in studio, live) ha i propri sync point; le versioni separate (senza chitarra, solo
          chitarra…) usano quelli della registrazione da cui derivano. Formati: {AUDIO_EXTENSIONS.join(', ')}.
        </p>
        <ul className="audio-list">
          {originals.flatMap((original) => {
            const job = stemsJob(original.id);
            const rows = [original, ...variantsOf(original.id)].map((t) => (
            <li key={t.id} className={`${t.id === activeAudioId ? 'active' : ''}${t.parentId !== null ? ' variant' : ''}`}>
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
                  <Icon name={t.parentId !== null ? 'wave' : t.source === 'library' ? 'folder' : 'music'} />
                  <span>
                    <strong>{t.name}</strong>
                    <span className="muted small">
                      {t.parentId !== null
                        ? `${t.variant ? AUDIO_VARIANTS[t.variant].description || 'versione separata' : 'versione separata'} · sync point dell'originale`
                        : `${t.source === 'library' ? t.libraryPath : 'caricata'} · ${t.syncPoints.length} sync point`}
                      {t.durationMs ? ` · ${formatTime(t.durationMs, 0)}` : ''}
                    </span>
                  </span>
                </button>
              )}
              {canEdit && editing !== t.id && (
                <>
                  {t.parentId === null && worker?.stems && (
                    <button
                      className={`icon-button${separating === t.id ? ' active' : ''}`}
                      title="Separa gli strumenti (basi senza chitarra, chitarra isolata…)"
                      onClick={() => setSeparating(separating === t.id ? null : t.id)}
                      disabled={!!job && isJobActive(job)}
                    >
                      <Icon name="layers" size={15} />
                    </button>
                  )}
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
            ));
            if (job && isJobActive(job)) {
              rows.push(
                <li key={`job-${job.id}`} className="variant job-row">
                  <JobProgress job={job} onCancel={() => void jobs.cancel(job.id)} />
                </li>,
              );
            } else if (job?.status === 'error') {
              rows.push(
                <li key={`job-${job.id}`} className="variant">
                  <span className="notice error grow">Separazione non riuscita: {job.error}</span>
                  <button className="link" onClick={() => void jobs.dismiss(job.id)}>
                    Chiudi
                  </button>
                </li>,
              );
            }
            if (separating === original.id && !(job && isJobActive(job))) {
              rows.push(
                <li key={`stems-${original.id}`} className="variant">
                  <StemsForm
                    existing={variantsOf(original.id).map((v) => v.variant).filter((v): v is AudioVariant => v !== null)}
                    message={worker?.message ?? null}
                    onStart={async (variants) => {
                      if (await jobs.startStems(original.id, variants)) setSeparating(null);
                    }}
                    onCancel={() => setSeparating(null)}
                  />
                </li>,
              );
            }
            return rows;
          })}
          {tracks.length === 0 && <li className="muted">Nessuna traccia audio.</li>}
        </ul>
        {canEdit && worker && !worker.stems && worker.status !== 'detecting' && tracks.length > 0 && (
          <p className="muted small">
            Separazione degli strumenti non disponibile: {worker.message ?? 'worker Python non installato'}.
          </p>
        )}
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
          message={
            deleting.parentId !== null
              ? `“${deleting.name}” verrà eliminata (la registrazione originale resta).`
              : `“${deleting.name}” e i suoi sync point verranno eliminati` +
                (variantsOf(deleting.id).length > 0 ? `, insieme alle ${variantsOf(deleting.id).length} versioni separate` : '') +
                (deleting.source === 'library' ? ' (il file nella libreria musicale non viene toccato)' : '') +
                '.'
          }
          confirmLabel="Elimina"
          danger
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await api.deleteAudio(deleting.id);
              apply(tracks.filter((t) => t.id !== deleting.id && t.parentId !== deleting.id));
            } catch (err) {
              notifyError(err);
            }
          }}
        />
      )}
    </>
  );
}

function StemsForm({
  existing,
  message,
  onStart,
  onCancel,
}: {
  existing: AudioVariant[];
  message: string | null;
  onStart: (variants: AudioVariant[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [chosen, setChosen] = useState<AudioVariant[]>(DEFAULT_VARIANTS.filter((v) => !existing.includes(v)));
  const [busy, setBusy] = useState(false);
  const toggle = (v: AudioVariant) => setChosen((list) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]));
  return (
    <div className="stems-form">
      <strong className="small">Versioni da creare</strong>
      <div className="stems-options">
        {AUDIO_VARIANT_ORDER.map((v) => (
          <label key={v} className="checkbox small" title={AUDIO_VARIANTS[v].description}>
            <input
              type="checkbox"
              checked={existing.includes(v) || chosen.includes(v)}
              disabled={existing.includes(v) || busy}
              onChange={() => toggle(v)}
            />
            {AUDIO_VARIANTS[v].label}
            {existing.includes(v) && <span className="muted"> (già presente)</span>}
          </label>
        ))}
      </div>
      <p className="muted small">
        Separazione con Demucs (6 strumenti): richiede qualche minuto, circa metà della durata del brano su 4 core. Le versioni
        restano sincronizzate con l'originale.
        {message && ` ${message}`}
      </p>
      <div className="field-row">
        <button
          className="primary"
          disabled={chosen.length === 0 || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onStart(chosen);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Icon name="layers" /> Separa
        </button>
        <button onClick={onCancel} disabled={busy}>
          Annulla
        </button>
      </div>
    </div>
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
