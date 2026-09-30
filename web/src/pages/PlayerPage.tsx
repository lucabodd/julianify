import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  AUDIO_VARIANTS,
  type Annotation,
  type AnnotationInput,
  type AudioTrack,
  type Job,
  type SavedLoop,
  type ScoreDetail,
  type ScorePrefs,
  type StemsJobParams,
} from '../../../shared/types';
import { api } from '../api';
import { useSession } from '../App';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { Icon } from '../components/Icon';
import { notify, notifyError } from '../components/toast';
import { buildAnalysis } from '../player/analysis';
import { AnalysisPanel, type EditingState } from '../player/AnalysisPanel';
import { AnnotationLayer, layerPadding, type LayerOptions } from '../player/AnnotationLayer';
import { AudioTracksDialog, variantOrder } from '../player/AudioTracksDialog';
import { PlayerController, type LayoutName, type PlaybackRange, type PlayerSnapshot, type StaveProfileName } from '../player/controller';
import { LoopPanel } from '../player/LoopPanel';
import { beatPosition, beatsPerBar, positionLabel, type ScorePosition } from '../player/scoreTools';
import { SyncPanel } from '../player/SyncPanel';
import { Transport, type AudioVersion } from '../player/Transport';
import { isJobActive, useJobs } from '../player/useJobs';
import { useSpeedTrainer } from '../player/useSpeedTrainer';
import { useSyncEditor } from '../player/useSyncEditor';
import { Waveform } from '../player/Waveform';
import { useLocalStorage } from '../useLocalStorage';

type PanelName = 'analysis' | 'loops' | 'sync';

interface ViewSettings {
  zoom: number;
  layout: LayoutName;
  staveProfile: StaveProfileName;
  followCursor: boolean;
}

const EMPTY_SNAPSHOT: PlayerSnapshot = {
  scoreLoaded: false,
  rendering: false,
  renderVersion: 0,
  timelineVersion: 0,
  playing: false,
  audioReady: false,
  audioDurationMs: 0,
  audioTimeMs: 0,
  tick: 0,
  speed: 1,
  volume: 1,
  looping: false,
  range: null,
  error: null,
  embeddedSyncPoints: 0,
  embeddedAudio: false,
};

/** Estensione dell'audio incorporato in un file Guitar Pro 8, dai primi byte. */
function audioExtension(bytes: Uint8Array): string {
  const text = (start: number, length: number) => String.fromCharCode(...bytes.slice(start, start + length));
  if (text(0, 4) === 'RIFF') return 'wav';
  if (text(0, 4) === 'OggS') return 'ogg';
  if (text(0, 4) === 'fLaC') return 'flac';
  if (text(4, 4) === 'ftyp') return 'm4a';
  return 'mp3';
}

const DEFAULT_LAYERS: LayerOptions = { chords: true, analysis: true, sections: true, intervals: false, intervalTrack: null };
const EMPTY_SET = new Set<number>();
const noopSubscribe = () => () => undefined;
const emptySnapshot = () => EMPTY_SNAPSHOT;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export function PlayerPage({ scoreId }: { scoreId: number }) {
  const { info } = useSession();
  const [score, setScore] = useState<ScoreDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<ScorePrefs | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [loops, setLoops] = useState<SavedLoop[]>([]);
  const [audioId, setAudioId] = useState<number | null>(null);
  const [controller, setController] = useState<PlayerController | null>(null);
  const [panel, setPanel] = useLocalStorage<PanelName | null>('julianify.panel', 'analysis');
  const [showWaveform, setShowWaveform] = useState(false);
  const [selection, setSelection] = useState<ScorePosition | null>(null);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [layers, setLayers] = useLocalStorage<LayerOptions>('julianify.layers', DEFAULT_LAYERS);
  const [latency, setLatency] = useLocalStorage<number>('julianify.latency', 0);
  const [gapMs, setGapMs] = useState(0);
  const [audioDialog, setAudioDialog] = useState(false);
  const [tracksMenu, setTracksMenu] = useState(false);
  const [viewMenu, setViewMenu] = useState(false);
  const [trackIndexes, setTrackIndexes] = useState<number[]>([0]);
  const [view, setView] = useState<ViewSettings>({ zoom: 1, layout: 'page', staveProfile: 'default', followCursor: true });
  const hostRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef(panel);
  panelRef.current = panel;

  const snap = useSyncExternalStore(controller?.subscribe ?? noopSubscribe, controller?.getSnapshot ?? emptySnapshot);
  const hideScoreChords = layers.chords && annotations.some((a) => a.kind === 'chord');
  const timeline = snap.timelineVersion > 0 ? (controller?.timeline ?? null) : null;
  const allTracks = score?.audioTracks;
  const activeAudio = allTracks?.find((t) => t.id === audioId) ?? null;
  // Le versioni separate (senza chitarra…) condividono i sync point della registrazione originale.
  const syncTrack = (activeAudio?.parentId != null && allTracks?.find((t) => t.id === activeAudio.parentId)) || activeAudio;
  const family = useMemo(
    () =>
      syncTrack && allTracks
        ? [syncTrack, ...allTracks.filter((t) => t.parentId === syncTrack.id).sort((a, b) => variantOrder(a) - variantOrder(b))]
        : [],
    [syncTrack, allTracks],
  );
  const versions = useMemo<AudioVersion[]>(
    () =>
      family.map((t) => ({
        id: t.id,
        label: t.variant ? AUDIO_VARIANTS[t.variant].label : 'Originale',
        title: t.variant ? AUDIO_VARIANTS[t.variant].description || AUDIO_VARIANTS[t.variant].label : 'Registrazione originale',
      })),
    [family],
  );
  const familyOf = useRef<(id: number | null) => number | null>(() => null);
  familyOf.current = (id) => {
    const track = allTracks?.find((t) => t.id === id);
    return track ? (track.parentId ?? track.id) : null;
  };

  // ------------------------------------------------------------ caricamento
  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getScore(scoreId), api.getPrefs(scoreId), api.listAnnotations(scoreId), api.listLoops(scoreId)]).then(
      ([s, p, a, l]) => {
        if (cancelled) return;
        setScore(s);
        setPrefs(p);
        setAnnotations(a);
        setLoops(l);
        const audio = s.audioTracks.find((t) => t.id === p.audioId) ?? s.audioTracks[0] ?? null;
        setAudioId(audio?.id ?? null);
        setTrackIndexes(p.trackIndexes?.length ? p.trackIndexes : [0]);
        setView((v) => ({
          zoom: p.zoom ?? v.zoom,
          layout: p.layout ?? v.layout,
          staveProfile: p.staveProfile ?? v.staveProfile,
          followCursor: v.followCursor,
        }));
        setShowWaveform(p.showWaveform ?? false);
        document.title = `${s.title} · Julianify`;
      },
      (err: Error) => !cancelled && setLoadError(err.message),
    );
    return () => {
      cancelled = true;
      document.title = 'Julianify';
    };
  }, [scoreId]);

  useEffect(() => {
    const c = new PlayerController(hostRef.current!, scrollRef.current!);
    setController(c);
    return () => c.destroy();
  }, []);

  const prefsReady = prefs !== null;
  useEffect(() => {
    if (!controller || !score || !prefsReady) return;
    let cancelled = false;
    const pad = layerPadding(layers);
    controller.setPadding(pad.top, pad.bottom, false);
    controller.setScoreChordNames(!hideScoreChords, false);
    controller.setDisplay({ scale: view.zoom, layout: view.layout, staveProfile: view.staveProfile, followCursor: view.followCursor }, false);
    fetch(api.scoreFileUrl(score.id), { credentials: 'same-origin' })
      .then((res) => {
        if (!res.ok) throw new Error(`Impossibile scaricare lo spartito (${res.status})`);
        return res.arrayBuffer();
      })
      .then((data) => {
        if (!cancelled) controller.loadScore(data, trackIndexes);
      })
      .catch((err: Error) => !cancelled && setLoadError(err.message));
    return () => {
      cancelled = true;
    };
    // Si ricarica solo se cambia lo spartito (o il suo file).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, score?.id, score?.fileSize, prefsReady]);

  // Tracce effettivamente visualizzate dopo il caricamento.
  useEffect(() => {
    if (!controller || !snap.scoreLoaded) return;
    const shown = controller.api.tracks.map((t) => t.index);
    if (shown.length > 0) setTrackIndexes(shown);
    if (layers.intervalTrack === null || !controller.score?.tracks[layers.intervalTrack]) {
      setLayers({ ...layers, intervalTrack: shown[0] ?? 0 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, snap.scoreLoaded]);

  // Tra versioni della stessa registrazione si cambia al volo, restando nello stesso punto.
  const loadedFamily = useRef<number | null>(null);
  useEffect(() => {
    if (!controller) return;
    const url = audioId ? api.audioStreamUrl(audioId) : null;
    const familyId = familyOf.current(audioId);
    if (url && familyId !== null && familyId === loadedFamily.current && controller.getSnapshot().audioReady) {
      controller.switchAudio(url);
    } else {
      controller.setAudio(url);
    }
    loadedFamily.current = familyId;
  }, [controller, audioId]);

  useEffect(() => {
    if (controller && prefs) {
      controller.setSpeed(prefs.speed ?? 1);
      controller.setVolume(prefs.volume ?? 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, prefsReady]);

  useEffect(() => controller?.setLatency(latency), [controller, latency]);
  useEffect(() => {
    if (controller) controller.loopGapMs = gapMs;
  }, [controller, gapMs]);

  // Le sigle dell'analisi sostituiscono quelle scritte nel file (niente doppioni).
  useEffect(() => {
    if (controller && snap.scoreLoaded) controller.setScoreChordNames(!hideScoreChords);
  }, [controller, snap.scoreLoaded, hideScoreChords]);

  // Spazio sopra/sotto i sistemi per i livelli di analisi.
  useEffect(() => {
    if (!controller || !snap.scoreLoaded) return;
    const pad = layerPadding(layers);
    controller.setPadding(pad.top, pad.bottom);
  }, [controller, snap.scoreLoaded, layers]);

  // Salvataggio (ritardato) delle preferenze dello spartito.
  const prefsToSave = useMemo<ScorePrefs | null>(
    () =>
      prefsReady
        ? {
            audioId,
            speed: Math.round(snap.speed * 100) / 100,
            volume: Math.round(snap.volume * 100) / 100,
            trackIndexes,
            zoom: view.zoom,
            layout: view.layout,
            staveProfile: view.staveProfile,
            showWaveform,
          }
        : null,
    [prefsReady, audioId, snap.speed, snap.volume, trackIndexes, view, showWaveform],
  );
  useEffect(() => {
    if (!prefsToSave) return;
    const timer = window.setTimeout(() => void api.savePrefs(scoreId, prefsToSave).catch(() => undefined), 1500);
    return () => window.clearTimeout(timer);
  }, [prefsToSave, scoreId]);

  // ------------------------------------------------------------- sync point
  const onAudioSaved = useCallback((audio: AudioTrack) => {
    setScore((s) =>
      s
        ? {
            ...s,
            audioTracks: s.audioTracks.map((t) =>
              t.id === audio.id ? audio : t.parentId === audio.id ? { ...t, syncPoints: audio.syncPoints } : t,
            ),
          }
        : s,
    );
  }, []);
  const syncEditor = useSyncEditor(controller, syncTrack, score?.isOwner ?? false, snap.timelineVersion, onAudioSaved);
  const trainer = useSpeedTrainer(controller);

  // ------------------------------------------------ lavori del worker Python
  const onJobFinished = useCallback(
    (job: Job) => {
      if (job.kind === 'stems') {
        if (job.status === 'done') {
          api.getScore(scoreId).then(
            (fresh) => setScore((s) => (s ? { ...s, audioTracks: fresh.audioTracks, audioCount: fresh.audioCount } : fresh)),
            notifyError,
          );
          const names = ((job.params as StemsJobParams | null)?.variants ?? [])
            .map((v) => AUDIO_VARIANTS[v]?.label)
            .filter(Boolean)
            .join(', ');
          notify(`Versioni pronte${names ? `: ${names}` : ''}. Le trovi nella barra in alto (tasto V)`, 'success');
        } else if (job.status === 'error') {
          notify(`Separazione non riuscita: ${job.error}`, 'error');
        }
      } else if (job.status === 'done') {
        notify('Sincronizzazione calcolata: controllala e applicala dal pannello Sync', 'success');
      } else if (job.status === 'error') {
        notify(`Sincronizzazione non riuscita: ${job.error}`, 'error');
      }
    },
    [scoreId],
  );
  const jobs = useJobs(scoreId, onJobFinished);
  const activeJobs = jobs.jobs.filter(isJobActive);

  // --------------------------------------------------------------- analisi
  const model = useMemo(
    () => buildAnalysis(snap.scoreLoaded ? (controller?.score ?? null) : null, annotations),
    // lo spartito cambia solo con scoreLoaded/timeline
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [annotations, snap.scoreLoaded, snap.timelineVersion, controller],
  );

  const occurrenceTick = useCallback(
    (pos: ScorePosition): number | null => {
      if (!timeline || !controller) return null;
      const occurrences = timeline.occurrencesOf(pos.barIndex);
      if (occurrences.length === 0) return null;
      // Tra le ripetizioni sceglie quella più vicina al punto in cui ci si trova.
      const current = controller.getSnapshot().tick;
      let best = occurrences[0];
      for (const o of occurrences) if (Math.abs(o.startTick - current) < Math.abs(best.startTick - current)) best = o;
      return best.startTick + pos.position * (best.endTick - best.startTick);
    },
    [controller, timeline],
  );

  const seekPosition = useCallback(
    (pos: ScorePosition) => {
      const tick = occurrenceTick(pos);
      if (tick !== null) controller?.seekTick(tick);
      setSelection(pos);
    },
    [controller, occurrenceTick],
  );

  useEffect(() => {
    if (!controller) return;
    return controller.onBeatClick(({ beat }) => {
      const pos = beatPosition(beat);
      setSelection(pos);
      // In modalità sync il clic seleziona soltanto: l'audio resta dov'è.
      if (panelRef.current !== 'sync') {
        const tick = occurrenceTick(pos);
        if (tick !== null) controller.seekTick(tick);
      }
    });
  }, [controller, occurrenceTick]);

  const createAnnotation = useCallback(
    async (input: AnnotationInput) => {
      const created = await api.createAnnotation(scoreId, input);
      setAnnotations((list) => [...list, created]);
      return created;
    },
    [scoreId],
  );
  const createMany = useCallback(
    async (inputs: AnnotationInput[]) => {
      try {
        const created = await api.createAnnotations(scoreId, inputs);
        setAnnotations((list) => [...list, ...created]);
        return created.length;
      } catch (err) {
        notifyError(err);
        return 0;
      }
    },
    [scoreId],
  );
  const updateAnnotation = useCallback(async (id: number, input: Partial<AnnotationInput>) => {
    const updated = await api.updateAnnotation(id, input);
    setAnnotations((list) => list.map((a) => (a.id === id ? updated : a)));
    return updated;
  }, []);
  const deleteAnnotation = useCallback(async (id: number) => {
    try {
      await api.deleteAnnotation(id);
      setAnnotations((list) => list.filter((a) => a.id !== id));
    } catch (err) {
      notifyError(err);
    }
  }, []);
  const deleteKind = useCallback(
    async (kind: Annotation['kind']) => {
      try {
        await api.deleteAnnotationsOfKind(scoreId, kind);
        setAnnotations((list) => list.filter((a) => a.kind !== kind));
      } catch (err) {
        notifyError(err);
      }
    },
    [scoreId],
  );

  // ------------------------------------------------------------------ loop
  const snapToBeat = useCallback(
    (tick: number, mode: 'floor' | 'ceil'): number => {
      const bar = timeline?.barAtTick(tick);
      const score = controller?.score;
      if (!bar || !score) return tick;
      const beats = beatsPerBar(score.masterBars[bar.barIndex]);
      const len = (bar.endTick - bar.startTick) / beats;
      const n = (tick - bar.startTick) / len;
      return bar.startTick + (mode === 'floor' ? Math.floor(n + 0.02) : Math.ceil(n - 0.02)) * len;
    },
    [controller, timeline],
  );

  const setA = useCallback(() => {
    if (!controller || !timeline) return;
    const tick = snapToBeat(controller.getSnapshot().tick, 'floor');
    const range = controller.getSnapshot().range;
    const bar = timeline.barAtTick(tick);
    const end = range && range.endTick > tick + 10 ? range.endTick : (bar?.endTick ?? tick + 3840);
    controller.setRange({ startTick: tick, endTick: end });
    controller.setLooping(true);
  }, [controller, snapToBeat, timeline]);

  const setB = useCallback(() => {
    if (!controller || !timeline) return;
    const tick = snapToBeat(controller.getSnapshot().tick, 'ceil');
    const range = controller.getSnapshot().range;
    const bar = timeline.barAtTick(Math.max(0, tick - 1));
    const start = range && range.startTick < tick - 10 ? range.startTick : (bar?.startTick ?? 0);
    if (tick <= start) return;
    controller.setRange({ startTick: start, endTick: tick });
    controller.setLooping(true);
  }, [controller, snapToBeat, timeline]);

  const clearLoop = useCallback(() => {
    controller?.setRange(null);
    controller?.setLooping(false);
  }, [controller]);

  const saveLoop = useCallback(
    async (name: string) => {
      const range = snap.range;
      if (!range || !timeline) return;
      try {
        const loop = await api.createLoop(scoreId, {
          name,
          startTick: Math.round(range.startTick),
          endTick: Math.round(range.endTick),
          startBar: timeline.barAtTick(range.startTick)?.barIndex ?? 0,
          endBar: timeline.barAtTick(Math.max(range.startTick, range.endTick - 1))?.barIndex ?? 0,
          speed: snap.speed,
        });
        setLoops((list) => [...list, loop].sort((a, b) => a.startTick - b.startTick));
        notify(`Loop “${loop.name}” salvato`, 'success');
      } catch (err) {
        notifyError(err);
      }
    },
    [scoreId, snap.range, snap.speed, timeline],
  );

  const activateLoop = useCallback(
    (loop: SavedLoop) => {
      if (!controller) return;
      controller.setRange({ startTick: loop.startTick, endTick: loop.endTick }, true);
      controller.setLooping(true);
      controller.setSpeed(loop.speed);
      trainer.reset();
    },
    [controller, trainer],
  );

  const onRangeFromWaveform = useCallback(
    (range: PlaybackRange) => {
      if (range.endTick > range.startTick) controller?.setRange(range);
    },
    [controller],
  );

  // Guitar Pro 8 può incorporare la registrazione e i sync point: si importano insieme.
  const importEmbeddedAudio = useCallback(async () => {
    const bytes = controller?.embedded.audio;
    if (!controller || !score || !bytes) return;
    try {
      const ext = audioExtension(bytes);
      const file = new File([bytes.slice()], `${score.title || 'audio'}.${ext}`, { type: `audio/${ext === 'm4a' ? 'mp4' : ext}` });
      notify("Importo l'audio incluso nel file…");
      let audio = await api.uploadAudio(score.id, file, `${score.title} (dal file)`);
      if (controller.embedded.syncPoints.length > 0) {
        audio = await api.updateAudio(audio.id, { syncPoints: controller.embedded.syncPoints });
      }
      setScore((s) => (s ? { ...s, audioTracks: [...s.audioTracks, audio], audioCount: s.audioCount + 1 } : s));
      setAudioId(audio.id);
      notify(`Traccia importata${audio.syncPoints.length ? ` con ${audio.syncPoints.length} sync point` : ''}`, 'success');
    } catch (err) {
      notifyError(err);
    }
  }, [controller, score]);

  // -------------------------------------------------------------- tastiera
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyHandler.current = (e: KeyboardEvent) => {
    if (!controller || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
    if (document.querySelector('.modal-backdrop')) return;
    const key = e.key;
    const tick = snap.tick;
    const handled = () => e.preventDefault();
    switch (key) {
      case ' ':
        handled();
        controller.togglePlay();
        break;
      case 'Escape':
        if (editing) setEditing(null);
        else if (syncEditor.tapActive) syncEditor.stopTap();
        else controller.stop();
        break;
      case 'ArrowLeft':
      case 'ArrowRight': {
        if (!timeline) break;
        handled();
        const bar = timeline.barAtTick(tick);
        if (!bar) break;
        const nearStart = tick - bar.startTick < (bar.endTick - bar.startTick) * 0.15;
        const target = key === 'ArrowRight' ? timeline.bars[bar.order + 1] : nearStart ? timeline.bars[bar.order - 1] : bar;
        if (target) controller.seekTick(target.startTick);
        break;
      }
      case '[':
        setA();
        break;
      case ']':
        setB();
        break;
      case 'l':
      case 'L':
        if (snap.range) controller.setLooping(!snap.looping);
        break;
      case 'x':
      case 'X':
        clearLoop();
        break;
      case '-':
        controller.setSpeed(Math.round((snap.speed - 0.05) * 100) / 100);
        break;
      case '+':
      case '=':
        controller.setSpeed(Math.round((snap.speed + 0.05) * 100) / 100);
        break;
      case '0':
        controller.setSpeed(1);
        break;
      case 't':
      case 'T':
        if (syncEditor.tapActive) {
          handled();
          syncEditor.tap();
        }
        break;
      case 'z':
      case 'Z':
        if (panel === 'sync') syncEditor.undo();
        break;
      case 's':
      case 'S':
        if (panel === 'sync' && selection) syncEditor.assign(selection.barIndex, selection.position);
        break;
      case 'a':
      case 'A':
        if (selection) {
          setPanel('analysis');
          setEditing({ mode: 'new', kind: 'chord', position: selection });
        }
        break;
      case 'n':
      case 'N':
        if (selection) {
          setPanel('analysis');
          setEditing({ mode: 'new', kind: 'note', position: selection });
        }
        break;
      case 'w':
      case 'W':
        setShowWaveform((v) => !v);
        break;
      case 'v':
      case 'V':
        if (versions.length > 1) {
          const index = versions.findIndex((v) => v.id === audioId);
          setAudioId(versions[(index + 1) % versions.length].id);
        }
        break;
      default:
        return;
    }
  };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  // ----------------------------------------------------------------- vista
  const applyView = (next: Partial<ViewSettings>) => {
    const merged = { ...view, ...next };
    setView(merged);
    controller?.setDisplay({ scale: merged.zoom, layout: merged.layout, staveProfile: merged.staveProfile, followCursor: merged.followCursor });
  };

  const toggleTrack = (index: number) => {
    const next = trackIndexes.includes(index) ? trackIndexes.filter((i) => i !== index) : [...trackIndexes, index].sort((a, b) => a - b);
    if (next.length === 0) return;
    setTrackIndexes(next);
    controller?.setTracks(next);
  };

  const scoreTracks = snap.scoreLoaded ? (controller?.score?.tracks ?? []) : [];
  const showWave = showWaveform || panel === 'sync';

  if (loadError && !score) {
    return (
      <div className="page">
        <div className="empty-state">
          <h2>Impossibile aprire lo spartito</h2>
          <p>{loadError}</p>
          <a href="#/">Torna alla libreria</a>
        </div>
      </div>
    );
  }

  return (
    <div className={`player${panel ? ' with-panel' : ''}${showWave ? ' with-waveform' : ''}`}>
      <header className="player-header">
        <a className="icon-button" href="#/" title="Torna alla libreria">
          <Icon name="back" />
        </a>
        <div className="player-title">
          <strong>{score?.title ?? 'Caricamento…'}</strong>
          {score?.artist && <span className="muted"> — {score.artist}</span>}
        </div>

        <div className="header-controls">
          <div className="audio-select">
            <Icon name="music" />
            <select
              value={syncTrack?.id ?? ''}
              onChange={(e) => setAudioId(e.target.value ? Number(e.target.value) : null)}
              aria-label="Traccia audio"
              disabled={!score || score.audioTracks.length === 0}
            >
              {score?.audioTracks.length === 0 && <option value="">Nessuna traccia audio</option>}
              {score?.audioTracks
                .filter((t) => t.parentId === null)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </select>
            <button className="icon-button" title="Gestisci tracce audio" onClick={() => setAudioDialog(true)} disabled={!score}>
              <Icon name="settings" />
            </button>
          </div>

          <div className="menu-anchor">
            <button onClick={() => setTracksMenu((v) => !v)} disabled={scoreTracks.length === 0} aria-expanded={tracksMenu}>
              <Icon name="layers" /> Tracce ({trackIndexes.length}/{scoreTracks.length || '–'})
            </button>
            {tracksMenu && (
              <div className="dropdown wide" onMouseLeave={() => setTracksMenu(false)}>
                {scoreTracks.map((t) => (
                  <label key={t.index} className="checkbox">
                    <input type="checkbox" checked={trackIndexes.includes(t.index)} onChange={() => toggleTrack(t.index)} />
                    {t.name || `Traccia ${t.index + 1}`}
                    {t.isPercussion && <span className="muted small"> (percussioni)</span>}
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="menu-anchor">
            <button onClick={() => setViewMenu((v) => !v)} aria-expanded={viewMenu}>
              <Icon name="zoomIn" /> Vista
            </button>
            {viewMenu && (
              <div className="dropdown wide view-menu" onMouseLeave={() => setViewMenu(false)}>
                <div className="field-row">
                  <span>Zoom</span>
                  <button className="icon-button" onClick={() => applyView({ zoom: Math.max(0.5, Math.round((view.zoom - 0.1) * 10) / 10) })}>
                    <Icon name="zoomOut" />
                  </button>
                  <span>{Math.round(view.zoom * 100)}%</span>
                  <button className="icon-button" onClick={() => applyView({ zoom: Math.min(2, Math.round((view.zoom + 0.1) * 10) / 10) })}>
                    <Icon name="zoomIn" />
                  </button>
                </div>
                <label>
                  Notazione
                  <select value={view.staveProfile} onChange={(e) => applyView({ staveProfile: e.target.value as StaveProfileName })}>
                    <option value="default">Automatica</option>
                    <option value="mixed">Pentagramma + tablatura</option>
                    <option value="score">Solo pentagramma</option>
                    <option value="tab">Solo tablatura</option>
                  </select>
                </label>
                <label>
                  Impaginazione
                  <select value={view.layout} onChange={(e) => applyView({ layout: e.target.value as LayoutName })}>
                    <option value="page">Pagina</option>
                    <option value="horizontal">Orizzontale (una riga)</option>
                  </select>
                </label>
                <label className="checkbox">
                  <input type="checkbox" checked={view.followCursor} onChange={(e) => applyView({ followCursor: e.target.checked })} />
                  Scorri seguendo il cursore
                </label>
                <label className="checkbox">
                  <input type="checkbox" checked={showWaveform} onChange={(e) => setShowWaveform(e.target.checked)} />
                  Forma d'onda <kbd>W</kbd>
                </label>
              </div>
            )}
          </div>

          {activeJobs.length > 0 && (
            <button
              className="job-chip"
              onClick={() => (activeJobs[0].kind === 'stems' ? setAudioDialog(true) : setPanel('sync'))}
              title={activeJobs[0].message ?? 'Lavoro in corso sul server'}
            >
              <span className="spinner" aria-hidden />
              {activeJobs[0].kind === 'stems' ? 'Separazione' : 'Sincronizzazione'}
              {activeJobs[0].status === 'running' ? ` ${Math.round(activeJobs[0].progress * 100)}%` : ' in coda'}
            </button>
          )}

          <nav className="panel-tabs" aria-label="Pannelli">
            {(
              [
                ['analysis', 'note', 'Analisi'],
                ['loops', 'repeat', 'Loop'],
                ['sync', 'sync', 'Sync'],
              ] as const
            ).map(([name, icon, label]) => (
              <button key={name} className={panel === name ? 'active' : ''} onClick={() => setPanel(panel === name ? null : name)}>
                <Icon name={icon} /> {label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {controller && (
        <Transport
          controller={controller}
          snap={snap}
          timeline={timeline}
          hasAudio={!!activeAudio}
          versions={versions}
          activeVersion={audioId}
          onVersion={setAudioId}
          onSetA={setA}
          onSetB={setB}
          onClearLoop={clearLoop}
        />
      )}

      <div className="player-main">
        <div className="score-scroll" ref={scrollRef}>
          {score && score.audioTracks.length === 0 && (
            <div className="banner">
              <Icon name="info" />
              <span>
                Aggiungi la traccia audio originale per ascoltare lo spartito a tempo.
                {!score.isOwner && ' (Solo il proprietario può aggiungerla.)'}
              </span>
              {score.isOwner && snap.embeddedAudio && (
                <button className="primary" onClick={() => void importEmbeddedAudio()}>
                  <Icon name="music" /> Usa l'audio incluso nel file
                </button>
              )}
              {score.isOwner && (
                <button className={snap.embeddedAudio ? '' : 'primary'} onClick={() => setAudioDialog(true)}>
                  <Icon name="upload" /> Aggiungi traccia audio
                </button>
              )}
            </div>
          )}
          {snap.error && <div className="banner error">{snap.error}</div>}
          {panel === 'sync' && (
            <div className="banner sync-banner">
              <Icon name="sync" /> Modalità sync: il clic sullo spartito seleziona senza spostare l'audio
              {selection && <strong> · {positionLabel(controller?.score ?? null, selection)}</strong>}
            </div>
          )}
          <div className="score-stage">
            <div className="score-host" ref={hostRef} />
            {controller && (
              <ErrorBoundary label="Errore nel livello di analisi">
              <AnnotationLayer
                controller={controller}
                renderVersion={snap.renderVersion}
                annotations={annotations}
                model={model}
                layers={layers}
                selection={selection}
                onSelectAnnotation={(a) => {
                  setPanel('analysis');
                  setEditing({ mode: 'edit', annotation: a });
                  setSelection({ barIndex: a.barIndex, position: a.position });
                }}
              />
              </ErrorBoundary>
            )}
            {(!snap.scoreLoaded || snap.rendering) && !snap.error && <div className="score-loading">Caricamento spartito…</div>}
          </div>
        </div>

        {panel && controller && (
          <aside className="side-panel">
            <ErrorBoundary label="Errore nel pannello">
            {panel === 'analysis' && (
              <AnalysisPanel
                controller={controller}
                timeline={timeline}
                annotations={annotations}
                model={model}
                selection={selection}
                range={snap.range}
                editing={editing}
                setEditing={setEditing}
                layers={layers}
                setLayers={setLayers}
                onCreate={createAnnotation}
                onCreateMany={createMany}
                onUpdate={updateAnnotation}
                onDelete={deleteAnnotation}
                onDeleteKind={deleteKind}
                onSeek={seekPosition}
              />
            )}
            {panel === 'loops' && (
              <LoopPanel
                snap={snap}
                timeline={timeline}
                loops={loops}
                trainer={trainer}
                gapMs={gapMs}
                onGapChange={setGapMs}
                onSave={saveLoop}
                onActivate={activateLoop}
                onDelete={async (loop) => {
                  try {
                    await api.deleteLoop(loop.id);
                    setLoops((list) => list.filter((l) => l.id !== loop.id));
                  } catch (err) {
                    notifyError(err);
                  }
                }}
                onRename={async (loop, name) => {
                  try {
                    const updated = await api.updateLoop(loop.id, { name });
                    setLoops((list) => list.map((l) => (l.id === loop.id ? updated : l)));
                  } catch (err) {
                    notifyError(err);
                  }
                }}
              />
            )}
            {panel === 'sync' && (
              <SyncPanel
                controller={controller}
                editor={syncEditor}
                family={family}
                worker={info?.worker ?? null}
                jobs={jobs}
                timeline={timeline}
                selection={selection}
                latencyMs={latency}
                onLatencyChange={setLatency}
              />
            )}
            </ErrorBoundary>
          </aside>
        )}
      </div>

      {showWave && controller && activeAudio && (
        <div className="waveform-panel">
          <ErrorBoundary label="Errore nella forma d'onda">
          <Waveform
            controller={controller}
            audio={activeAudio}
            canEdit={score?.isOwner ?? false}
            timeline={timeline}
            syncMap={syncEditor.syncMap}
            points={syncEditor.points}
            invalid={syncEditor.syncMap?.invalid ?? EMPTY_SET}
            range={snap.range}
            showGrid={panel === 'sync'}
            onMovePoint={syncEditor.setTime}
            onRangeChange={onRangeFromWaveform}
          />
          </ErrorBoundary>
        </div>
      )}

      {audioDialog && score && (
        <AudioTracksDialog
          score={score}
          activeAudioId={audioId}
          jobs={jobs}
          onClose={() => setAudioDialog(false)}
          onChanged={(tracks, select) => {
            setScore({ ...score, audioTracks: tracks, audioCount: tracks.filter((t) => t.parentId === null).length });
            if (select !== undefined) {
              setAudioId(select);
              setAudioDialog(false);
            } else if (!tracks.some((t) => t.id === audioId)) {
              // eliminata la traccia in ascolto: si torna all'originale, se c'è ancora
              const parent = tracks.find((t) => t.id === activeAudio?.parentId);
              setAudioId(parent?.id ?? tracks.find((t) => t.parentId === null)?.id ?? null);
            }
          }}
        />
      )}
    </div>
  );
}
