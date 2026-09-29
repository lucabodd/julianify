import { useEffect, useMemo, useState } from 'react';
import {
  AUDIO_VARIANTS,
  type AudioTrack,
  type AutoSyncGranularity,
  type AutoSyncJobParams,
  type AutoSyncResult,
  type Job,
  type WorkerInfo,
} from '../../../shared/types';
import { Icon } from '../components/Icon';
import { notify } from '../components/toast';
import { buildAutoSyncRequest, mergeAutoSync, pointKey } from './autosync';
import type { PlayerController } from './controller';
import { barName } from './format';
import { JobProgress } from './JobProgress';
import { positionLabel } from './scoreTools';
import type { Timeline } from './timeline';
import type { JobsState } from './useJobs';
import type { SyncEditor } from './useSyncEditor';

type AutoSyncJob = Job<AutoSyncJobParams, AutoSyncResult>;

interface Props {
  controller: PlayerController;
  editor: SyncEditor;
  timeline: Timeline | null;
  /** Registrazione originale (custode dei sync point) e sue versioni separate. */
  family: AudioTrack[];
  worker: WorkerInfo | null;
  jobs: JobsState;
  /** Punti da ricontrollare dopo l'applicazione (chiavi di `pointKey`). */
  onApplied: (review: Set<string>) => void;
}

const MAX_SUSPICIOUS_LISTED = 8;
// somiglianza media: ~0,85-0,92 sui brani ben allineati, ~0,4-0,6 con note o audio sbagliati
const LOW_QUALITY = 0.7;

export function AutoSyncSection({ controller, editor, timeline, family, worker, jobs, onApplied }: Props) {
  const original = family[0];
  const bars = timeline?.bars ?? [];
  const last = Math.max(0, bars.length - 1);
  const [granularity, setGranularity] = useState<AutoSyncGranularity>('bar');
  const [fromOrder, setFromOrder] = useState(0);
  const [toOrder, setToOrder] = useState(last);
  const [analyzeId, setAnalyzeId] = useState(original.id);
  const pointsCount = editor.points.length;
  // pochi sync point inseriti a mano sono quasi sempre riferimenti voluti (inizio, sezioni)
  const [useAnchors, setUseAnchors] = useState(pointsCount > 0 && pointsCount <= 8);

  useEffect(() => setToOrder(last), [last]);
  useEffect(() => setAnalyzeId(original.id), [original.id]);

  const job = useMemo(
    () => (jobs.jobs.find((j) => j.kind === 'autosync' && j.audioId === original.id) as AutoSyncJob | undefined) ?? null,
    [jobs.jobs, original.id],
  );

  if (!worker?.autosync) {
    return (
      <section className="panel-section">
        <h3>
          <Icon name="sparkles" /> Sincronizzazione automatica
        </h3>
        <p className="muted small">
          {worker?.status === 'detecting'
            ? 'Verifica del worker in corso…'
            : `Non disponibile su questo server: ${worker?.message ?? 'worker Python non installato'}. Si attiva installando Julianify con WITH_WORKER=1 (vedi README).`}
        </p>
      </section>
    );
  }

  const start = async () => {
    const score = controller.score;
    if (!score || !timeline) return;
    const request = buildAutoSyncRequest(score, timeline, {
      granularity,
      fromOrder: Math.min(fromOrder, toOrder),
      toOrder: Math.max(fromOrder, toOrder),
      anchors: useAnchors ? editor.syncMap : null,
    });
    if (request.notes.length === 0) {
      notify('Nelle battute scelte lo spartito non ha note: non c\'è nulla da allineare', 'error');
      return;
    }
    await jobs.startAutoSync(original.id, { ...request, analyzeAudioId: analyzeId === original.id ? null : analyzeId });
  };

  const apply = (done: AutoSyncJob) => {
    if (!timeline || !done.result) return;
    const merged = mergeAutoSync(editor.points, timeline, done.params, done.result.times);
    editor.replaceAll(merged);
    const review = new Set(
      done.result.suspicious
        .map((i) => done.params.points[i])
        .filter(Boolean)
        .map(([barIndex, occurrence, position]) => pointKey(barIndex, occurrence, position)),
    );
    onApplied(review);
    void jobs.dismiss(done.id);
    notify(`Sync point aggiornati: ${done.result.times.length} punti calcolati`, 'success');
  };

  const running = job && (job.status === 'queued' || job.status === 'running');
  const variants = family.slice(1);

  return (
    <section className="panel-section autosync">
      <h3>
        <Icon name="sparkles" /> Sincronizzazione automatica
      </h3>

      {running && job && <JobProgress job={job} onCancel={() => void jobs.cancel(job.id)} />}

      {job?.status === 'error' && (
        <div className="notice error field-row">
          <span>Non riuscita: {job.error}</span>
          <button className="link" onClick={() => void jobs.dismiss(job.id)}>
            Chiudi
          </button>
        </div>
      )}

      {job?.status === 'done' && job.result && (
        <AutoSyncResultBox
          controller={controller}
          timeline={timeline}
          job={job}
          onApply={() => apply(job)}
          onDiscard={() => void jobs.dismiss(job.id)}
        />
      )}

      {!running && job?.status !== 'done' && (
        <>
          <p className="muted small">
            Confronta le note dello spartito con la registrazione e mette un sync point su ogni battuta (o movimento). Funziona
            anche con esecuzioni rubato; se la registrazione ha un'introduzione che lo spartito non contiene, inserisci prima un
            sync point sulla prima battuta.
          </p>
          <div className="form-grid">
            <label>
              Punti
              <select value={granularity} onChange={(e) => setGranularity(e.target.value as AutoSyncGranularity)}>
                <option value="bar">uno per battuta</option>
                <option value="beat">uno per movimento (rubato)</option>
              </select>
            </label>
            <label>
              Aggiorna dalla battuta
              <select value={fromOrder} onChange={(e) => setFromOrder(Number(e.target.value))} disabled={!timeline}>
                {bars.map((b) => (
                  <option key={b.order} value={b.order}>
                    {barName(b.barIndex, b.occurrence)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              fino alla battuta
              <select value={toOrder} onChange={(e) => setToOrder(Number(e.target.value))} disabled={!timeline}>
                {bars.map((b) => (
                  <option key={b.order} value={b.order}>
                    {barName(b.barIndex, b.occurrence)}
                  </option>
                ))}
              </select>
            </label>
            {variants.length > 0 && (
              <label>
                Analizza
                <select value={analyzeId} onChange={(e) => setAnalyzeId(Number(e.target.value))}>
                  <option value={original.id}>l'originale</option>
                  {variants.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.variant ? AUDIO_VARIANTS[v.variant].label.toLowerCase() : v.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {(fromOrder > 0 || toOrder < last) && (
            <p className="muted small">
              L'allineamento usa sempre tutto lo spartito; vengono sostituiti solo i sync point delle battute scelte.
            </p>
          )}
          {pointsCount > 0 && (
            <label className="checkbox small">
              <input type="checkbox" checked={useAnchors} onChange={(e) => setUseAnchors(e.target.checked)} />
              Rispetta i sync point già inseriti ({pointsCount}) come riferimento
            </label>
          )}
          {variants.some((v) => v.variant === 'guitar') && analyzeId === original.id && (
            <p className="muted small">
              Se lo spartito contiene solo la chitarra, analizzare la chitarra isolata di solito è più preciso.
            </p>
          )}
          <button className="primary" disabled={!editor.canEdit || !timeline} onClick={() => void start()}>
            <Icon name="sparkles" /> Sincronizza automaticamente
          </button>
          {!editor.canEdit && <p className="muted small">Solo il proprietario dello spartito può sincronizzare.</p>}
        </>
      )}
    </section>
  );
}

function AutoSyncResultBox({
  controller,
  timeline,
  job,
  onApply,
  onDiscard,
}: {
  controller: PlayerController;
  timeline: Timeline | null;
  job: AutoSyncJob;
  onApply: () => void;
  onDiscard: () => void;
}) {
  const result = job.result!;
  const params = job.params;
  const from = timeline?.bars[params.fromOrder];
  const to = timeline?.bars[params.toOrder];
  const suspicious = result.suspicious
    .map((i) => params.points[i])
    .filter(Boolean)
    .map(([barIndex, occurrence, position]) => {
      const label = positionLabel(controller.score, { barIndex, position });
      return occurrence > 0 ? `${label} (${occurrence + 1}ª volta)` : label;
    });
  const semitones = result.transposition;
  return (
    <div className="autosync-result">
      <p>
        <Icon name="check" /> <strong>{result.times.length} punti calcolati</strong>
        {result.refined > 0 && <span className="muted"> · {result.refined} agganciati all'attacco delle note</span>}
      </p>
      {((result.quality !== null && result.quality < LOW_QUALITY) || Math.abs(semitones) >= 3) && (
        <p className="notice small">
          La registrazione somiglia poco allo spartito: il risultato potrebbe essere inaffidabile. Controlla che le note e la
          porzione scelta corrispondano{params.analyzeAudioId ? ', oppure analizza la registrazione completa' : ''}.
        </p>
      )}
      {semitones !== 0 && (
        <p className="small">
          La registrazione suona {Math.abs(semitones)} {Math.abs(semitones) === 1 ? 'semitono' : 'semitoni'}{' '}
          {semitones > 0 ? 'sopra' : 'sotto'} lo spartito (capotasto o tonalità diversa?).
        </p>
      )}
      {Math.abs(result.tuningCents) >= 15 && (
        <p className="small muted">
          Accordatura della registrazione: {result.tuningCents > 0 ? '+' : ''}
          {result.tuningCents} cent rispetto al La 440.
        </p>
      )}
      {suspicious.length > 0 ? (
        <p className="notice small">
          Da controllare: {suspicious.slice(0, MAX_SUSPICIOUS_LISTED).join(', ')}
          {suspicious.length > MAX_SUSPICIOUS_LISTED && ` e altri ${suspicious.length - MAX_SUSPICIOUS_LISTED}`}. Dopo
          l'applicazione sono segnati con <span className="badge warn">?</span> nella tabella.
        </p>
      ) : (
        <p className="small muted">Nessun punto dubbio.</p>
      )}
      <div className="field-row">
        <button className="primary" onClick={onApply}>
          <Icon name="check" /> Applica
        </button>
        <button onClick={onDiscard}>Scarta</button>
      </div>
      <p className="muted small">
        Sostituisce i sync point{' '}
        {from && to
          ? `dalla battuta ${barName(from.barIndex, from.occurrence)} alla ${barName(to.barIndex, to.occurrence)}`
          : 'del tratto allineato'}
        ; gli altri restano. Puoi annullare con <kbd>Z</kbd>.
      </p>
    </div>
  );
}
