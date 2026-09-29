import { useEffect, useMemo, useRef, useState } from 'react';
import { SCORE_EXTENSIONS, isScoreFile, type ScoreDetail, type ScoreSummary } from '../../../shared/types';
import { api } from '../api';
import { useSession } from '../App';
import { Icon } from '../components/Icon';
import { ConfirmDialog, Modal } from '../components/Modal';
import { notify, notifyError } from '../components/toast';
import { navigate } from '../router';
import { parseScoreFile, type ParsedScoreInfo } from '../scoreParse';

type SortKey = 'recent' | 'title' | 'artist';

const FORMAT_LABELS: Record<string, string> = {
  gp3: 'GP3',
  gp4: 'GP4',
  gp5: 'GP5',
  gpx: 'GP6',
  gp: 'GP7+',
  musicxml: 'MusicXML',
  mxl: 'MusicXML',
  capx: 'Capella',
};

const collator = new Intl.Collator('it', { sensitivity: 'base', numeric: true });

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function LibraryPage() {
  const [scores, setScores] = useState<ScoreSummary[] | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('recent');
  const [uploadFiles, setUploadFiles] = useState<File[] | null>(null);
  const [editing, setEditing] = useState<ScoreSummary | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const reload = () => api.listScores().then(setScores, notifyError);
  useEffect(() => {
    void reload();
  }, []);

  const visible = useMemo(() => {
    if (!scores) return [];
    const q = query.trim().toLowerCase();
    const filtered = q
      ? scores.filter((s) => [s.title, s.artist, s.album, s.originalFilename].some((v) => v?.toLowerCase().includes(q)))
      : scores;
    const sorted = [...filtered];
    if (sort === 'title') sorted.sort((a, b) => collator.compare(a.title, b.title));
    else if (sort === 'artist') sorted.sort((a, b) => collator.compare(a.artist ?? '', b.artist ?? '') || collator.compare(a.title, b.title));
    return sorted;
  }, [scores, query, sort]);

  const onFiles = (files: FileList | File[] | null) => {
    const list = Array.from(files ?? []).filter((f) => isScoreFile(f.name));
    if (files && Array.from(files).length > 0 && list.length === 0) {
      notify('Nessun file supportato: usa Guitar Pro, MusicXML o Capella', 'error');
      return;
    }
    if (list.length > 0) setUploadFiles(list);
  };

  return (
    <main
      className={`library${dragOver ? ' drag-over' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        onFiles(e.dataTransfer.files);
      }}
    >
      <div className="library-toolbar">
        <h1>I tuoi spartiti</h1>
        <div className="search">
          <Icon name="search" />
          <input placeholder="Cerca titolo, artista, album…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Ordina">
          <option value="recent">Più recenti</option>
          <option value="title">Titolo</option>
          <option value="artist">Artista</option>
        </select>
        <button className="primary" onClick={() => fileInput.current?.click()}>
          <Icon name="upload" /> Carica spartito
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          accept={SCORE_EXTENSIONS.map((e) => `.${e}`).join(',')}
          onChange={(e) => {
            onFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {scores === null ? (
        <p className="muted">Caricamento…</p>
      ) : scores.length === 0 ? (
        <div className="empty-state">
          <Icon name="music" size={48} />
          <h2>Nessuno spartito ancora</h2>
          <p>
            Carica una tablatura Guitar Pro (.gp3, .gp4, .gp5, .gpx, .gp) o un file MusicXML esportato da MuseScore
            (.musicxml, .mxl), poi aggiungi la traccia audio originale.
          </p>
          <p className="muted">Puoi anche trascinare i file in questa pagina.</p>
        </div>
      ) : (
        <ul className="score-list">
          {visible.map((s) => (
            <li key={s.id} className="score-item">
              <a className="score-main" href={`#/score/${s.id}`}>
                <span className="score-format">{FORMAT_LABELS[s.format] ?? s.format.toUpperCase()}</span>
                <span className="score-text">
                  <strong>{s.title}</strong>
                  <span className="muted">
                    {[s.artist, s.album].filter(Boolean).join(' — ') || s.originalFilename}
                  </span>
                </span>
              </a>
              <span className="score-meta">
                <span title="Tracce audio" className={s.audioCount === 0 ? 'warn' : ''}>
                  <Icon name="volume" size={15} /> {s.audioCount}
                </span>
                {s.shared && (
                  <span title={s.isOwner ? 'Condiviso con gli altri utenti' : `Condiviso da ${s.ownerName}`}>
                    <Icon name="share" size={15} /> {s.isOwner ? '' : s.ownerName}
                  </span>
                )}
                <span className="muted">{formatDate(s.updatedAt)}</span>
              </span>
              <span className="score-actions">
                {s.isOwner && (
                  <button className="icon-button" title="Modifica" onClick={() => setEditing(s)}>
                    <Icon name="edit" />
                  </button>
                )}
              </span>
            </li>
          ))}
          {visible.length === 0 && <li className="muted">Nessun risultato per “{query}”.</li>}
        </ul>
      )}

      {uploadFiles && (
        <UploadDialog
          files={uploadFiles}
          onClose={() => setUploadFiles(null)}
          onDone={(uploaded) => {
            setUploadFiles(null);
            void reload();
            if (uploaded.length === 1) navigate(`/score/${uploaded[0].id}`);
          }}
        />
      )}
      {editing && (
        <EditScoreDialog
          score={editing}
          onClose={() => setEditing(null)}
          onChanged={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
    </main>
  );
}

interface UploadRow {
  file: File;
  status: 'parsing' | 'ready' | 'error' | 'uploading' | 'done';
  error?: string;
  info?: ParsedScoreInfo;
  title: string;
  artist: string;
  album: string;
  progress: number;
}

function UploadDialog({ files, onClose, onDone }: { files: File[]; onClose: () => void; onDone: (s: ScoreDetail[]) => void }) {
  const { info } = useSession();
  const [rows, setRows] = useState<UploadRow[]>(() =>
    files.map((file) => ({ file, status: 'parsing', title: '', artist: '', album: '', progress: 0 })),
  );
  const [busy, setBusy] = useState(false);

  const update = (index: number, patch: Partial<UploadRow>) =>
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  useEffect(() => {
    files.forEach((file, index) => {
      parseScoreFile(file).then(
        (parsed) =>
          update(index, {
            status: 'ready',
            info: parsed,
            title: parsed.title || file.name.replace(/\.[^.]+$/, ''),
            artist: parsed.artist,
            album: parsed.album,
          }),
        (err: Error) => update(index, { status: 'error', error: err.message }),
      );
    });
  }, [files]);

  const maxBytes = (info?.maxUploadMb ?? 300) * 1024 * 1024;
  const ready = rows.filter((r) => r.status === 'ready');

  const uploadAll = async () => {
    setBusy(true);
    const uploaded: ScoreDetail[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.status !== 'ready') continue;
      if (row.file.size > maxBytes) {
        update(i, { status: 'error', error: 'File troppo grande' });
        continue;
      }
      update(i, { status: 'uploading' });
      try {
        const score = await api.uploadScore(row.file, { title: row.title, artist: row.artist, album: row.album }, (p) =>
          update(i, { progress: p }),
        );
        uploaded.push(score);
        update(i, { status: 'done', progress: 1 });
      } catch (err) {
        update(i, { status: 'error', error: err instanceof Error ? err.message : String(err) });
      }
    }
    setBusy(false);
    if (uploaded.length > 0) {
      notify(uploaded.length === 1 ? 'Spartito caricato' : `${uploaded.length} spartiti caricati`, 'success');
      onDone(uploaded);
    }
  };

  return (
    <Modal
      title={files.length === 1 ? 'Carica spartito' : `Carica ${files.length} spartiti`}
      onClose={onClose}
      wide
      footer={
        <>
          <button onClick={onClose} disabled={busy}>
            Annulla
          </button>
          <button className="primary" onClick={uploadAll} disabled={busy || ready.length === 0}>
            <Icon name="upload" /> Carica {ready.length > 1 ? `(${ready.length})` : ''}
          </button>
        </>
      }
    >
      <div className="upload-rows">
        {rows.map((row, i) => (
          <div key={i} className={`upload-row status-${row.status}`}>
            <div className="upload-file">
              <Icon name="file" /> <span>{row.file.name}</span>
              <span className="muted">{(row.file.size / 1024).toFixed(0)} KB</span>
            </div>
            {row.status === 'parsing' && <p className="muted">Analisi del file…</p>}
            {row.status === 'error' && <p className="form-error">{row.error}</p>}
            {(row.status === 'ready' || row.status === 'uploading' || row.status === 'done') && (
              <>
                <div className="form-grid">
                  <label>
                    Titolo
                    <input value={row.title} disabled={row.status !== 'ready'} onChange={(e) => update(i, { title: e.target.value })} />
                  </label>
                  <label>
                    Artista
                    <input value={row.artist} disabled={row.status !== 'ready'} onChange={(e) => update(i, { artist: e.target.value })} />
                  </label>
                  <label>
                    Album
                    <input value={row.album} disabled={row.status !== 'ready'} onChange={(e) => update(i, { album: e.target.value })} />
                  </label>
                </div>
                {row.info && (
                  <p className="muted small">
                    {row.info.tracks.length} {row.info.tracks.length === 1 ? 'traccia' : 'tracce'} ({row.info.tracks.slice(0, 4).join(', ')}
                    {row.info.tracks.length > 4 ? '…' : ''}) · {row.info.bars} battute · ♩ = {row.info.tempo}
                  </p>
                )}
                {row.status === 'uploading' && <progress value={row.progress} max={1} />}
                {row.status === 'done' && <p className="success small">Caricato ✓</p>}
              </>
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}

function EditScoreDialog({ score, onClose, onChanged }: { score: ScoreSummary; onClose: () => void; onChanged: () => void }) {
  const [title, setTitle] = useState(score.title);
  const [artist, setArtist] = useState(score.artist ?? '');
  const [album, setAlbum] = useState(score.album ?? '');
  const [shared, setShared] = useState(score.shared);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const replaceInput = useRef<HTMLInputElement>(null);

  const save = async () => {
    setBusy(true);
    try {
      await api.updateScore(score.id, { title, artist: artist || null, album: album || null, shared });
      notify('Spartito aggiornato', 'success');
      onChanged();
    } catch (err) {
      notifyError(err);
      setBusy(false);
    }
  };

  const replace = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      await parseScoreFile(file);
      await api.replaceScoreFile(score.id, file);
      notify('File sostituito: audio, sync point, note e loop sono stati mantenuti', 'success');
      onChanged();
    } catch (err) {
      notifyError(err);
      setBusy(false);
    }
  };

  return (
    <>
      <Modal
        title="Modifica spartito"
        onClose={onClose}
        footer={
          <>
            <button className="danger left" onClick={() => setConfirmDelete(true)} disabled={busy}>
              <Icon name="trash" /> Elimina
            </button>
            <button onClick={onClose}>Annulla</button>
            <button className="primary" onClick={save} disabled={busy || !title.trim()}>
              Salva
            </button>
          </>
        }
      >
        <div className="form">
          <label>
            Titolo
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label>
            Artista
            <input value={artist} onChange={(e) => setArtist(e.target.value)} />
          </label>
          <label>
            Album
            <input value={album} onChange={(e) => setAlbum(e.target.value)} />
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
            Condividi con gli altri utenti (possono consultarlo e aggiungere le proprie note)
          </label>
          <div className="field-row">
            <span className="muted small">File: {score.originalFilename}</span>
            <button onClick={() => replaceInput.current?.click()} disabled={busy}>
              <Icon name="upload" /> Sostituisci file…
            </button>
            <input
              ref={replaceInput}
              type="file"
              hidden
              accept={SCORE_EXTENSIONS.map((e) => `.${e}`).join(',')}
              onChange={(e) => void replace(e.target.files?.[0])}
            />
          </div>
        </div>
      </Modal>
      {confirmDelete && (
        <ConfirmDialog
          title="Eliminare lo spartito?"
          message={`“${score.title}” verrà eliminato insieme alle tracce audio caricate, ai sync point, alle note e ai loop. L'operazione non è reversibile.`}
          confirmLabel="Elimina"
          danger
          onClose={() => setConfirmDelete(false)}
          onConfirm={async () => {
            try {
              await api.deleteScore(score.id);
              notify('Spartito eliminato', 'success');
              onChanged();
            } catch (err) {
              notifyError(err);
            }
          }}
        />
      )}
    </>
  );
}
