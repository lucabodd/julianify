// Collega alphaTab (rendering + cursore) all'elemento <audio> con la traccia originale.
// alphaTab lavora in modalità "media esterno": non produce suoni, legge la posizione
// dall'audio e, grazie ai sync point, sa quale battuta corrisponde a ogni istante.
import * as alphaTab from '@coderline/alphatab';
import type { FlatSyncPoint } from '../../../shared/types';
import { Timeline } from './timeline';

export type StaveProfileName = 'default' | 'tab' | 'score' | 'mixed';
export type LayoutName = 'page' | 'horizontal';

export interface PlaybackRange {
  startTick: number;
  endTick: number;
}

export interface PlayerSnapshot {
  scoreLoaded: boolean;
  rendering: boolean;
  renderVersion: number;
  timelineVersion: number;
  playing: boolean;
  audioReady: boolean;
  audioDurationMs: number;
  audioTimeMs: number;
  tick: number;
  speed: number;
  volume: number;
  looping: boolean;
  range: PlaybackRange | null;
  error: string | null;
  /** Sync point incorporati nel file (Guitar Pro 8). */
  embeddedSyncPoints: number;
  /** Il file contiene la traccia audio (Guitar Pro 8). */
  embeddedAudio: boolean;
}

type Listener = () => void;

export interface BeatClick {
  beat: alphaTab.model.Beat;
  shiftKey: boolean;
}

const STAVE_PROFILES: Record<StaveProfileName, alphaTab.StaveProfile> = {
  default: alphaTab.StaveProfile.Default,
  tab: alphaTab.StaveProfile.Tab,
  score: alphaTab.StaveProfile.Score,
  mixed: alphaTab.StaveProfile.ScoreTab,
};

export class PlayerController {
  readonly api: alphaTab.AlphaTabApi;
  readonly audio: HTMLAudioElement;
  timeline: Timeline | null = null;

  private snapshot: PlayerSnapshot = {
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
  /** Sync point e audio incorporati nel file, letti al primo caricamento dello spartito. */
  embedded: { syncPoints: FlatSyncPoint[]; audio: Uint8Array | null } = { syncPoints: [], audio: null };
  private loadedScore: alphaTab.model.Score | null = null;
  private listeners = new Set<Listener>();
  private beatClickListeners = new Set<(click: BeatClick) => void>();
  private rangeListeners = new Set<(range: PlaybackRange | null) => void>();
  private loopListeners = new Set<() => void>();
  private raf = 0;
  private lastUiUpdate = 0;
  private dragStart: alphaTab.model.Beat | null = null;
  private dragging = false;
  private shiftDown = false;
  private highlight: { start: alphaTab.model.Beat; end: alphaTab.model.Beat } | null = null;
  private syncPoints: FlatSyncPoint[] = [];
  private disposers: Array<() => void> = [];
  private destroyed = false;
  /** Pausa (ms) tra una ripetizione e l'altra del loop. */
  loopGapMs = 0;
  /**
   * Latenza dell'uscita audio (ms), es. cuffie Bluetooth: il cursore viene ritardato
   * di questo valore per coincidere con ciò che si sente.
   */
  latencyMs = 0;
  private gapTimer = 0;
  /** Invalida i ripristini di posizione in sospeso quando cambia la sorgente audio. */
  private switchToken = 0;

  constructor(host: HTMLElement, scrollElement: HTMLElement) {
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.preservesPitch = true;
    this.audio.className = 'player-audio';
    this.audio.hidden = true;
    document.body.appendChild(this.audio);

    this.api = new alphaTab.AlphaTabApi(host, {
      core: {
        fontDirectory: '/font/',
        enableLazyLoading: true,
        useWorkers: true,
        logLevel: alphaTab.LogLevel.Warning,
      },
      display: {
        layoutMode: alphaTab.LayoutMode.Page,
        staveProfile: alphaTab.StaveProfile.Default,
        scale: 1,
        systemPaddingTop: 44,
        firstSystemPaddingTop: 44,
        systemPaddingBottom: 26,
        lastSystemPaddingBottom: 32,
      },
      notation: {
        rhythmMode: alphaTab.TabRhythmMode.ShowWithBars,
      },
      player: {
        playerMode: alphaTab.PlayerMode.EnabledExternalMedia,
        enableCursor: true,
        enableAnimatedBeatCursor: true,
        enableElementHighlighting: true,
        enableUserInteraction: false,
        scrollElement,
        scrollMode: alphaTab.ScrollMode.Continuous,
        scrollOffsetY: -60,
      },
    });

    this.attachMediaHandler();
    this.bindAudioEvents();
    this.bindApiEvents();
  }

  // ------------------------------------------------------------------ stato

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): PlayerSnapshot => this.snapshot;

  private update(patch: Partial<PlayerSnapshot>): void {
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if ((this.snapshot as unknown as Record<string, unknown>)[k] !== v) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((l) => l());
  }

  onBeatClick(listener: (click: BeatClick) => void): () => void {
    this.beatClickListeners.add(listener);
    return () => this.beatClickListeners.delete(listener);
  }

  onRangeSelected(listener: (range: PlaybackRange | null) => void): () => void {
    this.rangeListeners.add(listener);
    return () => this.rangeListeners.delete(listener);
  }

  /** Chiamato a ogni ripetizione del loop A-B. */
  onLoopRepeat(listener: () => void): () => void {
    this.loopListeners.add(listener);
    return () => this.loopListeners.delete(listener);
  }

  get score(): alphaTab.model.Score | null {
    return this.api.score;
  }

  // ------------------------------------------------------------ collegamenti

  private get output(): alphaTab.synth.IExternalMediaSynthOutput | null {
    const player = this.api.player;
    return player ? (player.output as unknown as alphaTab.synth.IExternalMediaSynthOutput) : null;
  }

  private attachMediaHandler(): void {
    const audio = this.audio;
    const handler: alphaTab.synth.IExternalMediaHandler = {
      get backingTrackDuration() {
        return Number.isFinite(audio.duration) ? audio.duration * 1000 : 0;
      },
      get playbackRate() {
        return audio.playbackRate;
      },
      set playbackRate(value: number) {
        audio.playbackRate = value;
      },
      get masterVolume() {
        return audio.volume;
      },
      set masterVolume(value: number) {
        audio.volume = Math.max(0, Math.min(1, value));
      },
      seekTo: (time: number) => {
        if (!Number.isFinite(time)) return;
        const duration = Number.isFinite(audio.duration) ? audio.duration : Infinity;
        audio.currentTime = Math.max(0, Math.min(duration, (time + this.latencyMs) / 1000));
      },
      play: () => {
        if (!audio.src) return;
        audio.play().catch(() => this.api.pause());
      },
      pause: () => audio.pause(),
    };
    const assign = () => {
      const output = this.output;
      if (output) output.handler = handler;
    };
    assign();
    const off = this.api.playerReady.on(assign);
    this.disposers.push(off);
  }

  private pushPosition(): void {
    this.output?.updatePosition(Math.max(0, this.audio.currentTime * 1000 - this.latencyMs));
  }

  setLatency(ms: number): void {
    this.latencyMs = Math.max(0, Math.min(1000, ms));
    this.pushPosition();
  }

  private startUpdateLoop(): void {
    if (this.raf) return;
    const loop = () => {
      if (this.destroyed || this.audio.paused) {
        this.raf = 0;
        return;
      }
      this.pushPosition();
      const now = performance.now();
      if (now - this.lastUiUpdate > 100) {
        this.lastUiUpdate = now;
        this.update({ audioTimeMs: this.audio.currentTime * 1000 });
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private bindAudioEvents(): void {
    const audio = this.audio;
    const on = (event: string, fn: () => void) => {
      audio.addEventListener(event, fn);
      this.disposers.push(() => audio.removeEventListener(event, fn));
    };
    on('loadedmetadata', () => {
      this.update({ audioReady: true, audioDurationMs: audio.duration * 1000, error: null });
      this.pushPosition();
    });
    on('play', () => {
      if (this.api.playerState !== alphaTab.synth.PlayerState.Playing && this.api.isReadyForPlayback) this.api.play();
      this.update({ playing: true });
      this.startUpdateLoop();
    });
    on('pause', () => {
      this.pauseAlphaTab();
      this.pushPosition();
      this.update({ playing: false, audioTimeMs: audio.currentTime * 1000 });
    });
    on('seeked', () => {
      this.pushPosition();
      this.update({ audioTimeMs: audio.currentTime * 1000 });
    });
    on('timeupdate', () => {
      if (audio.paused) {
        this.pushPosition();
        this.update({ audioTimeMs: audio.currentTime * 1000 });
      }
    });
    on('ended', () => {
      this.pauseAlphaTab();
      this.update({ playing: false });
    });
    on('ratechange', () => this.update({ speed: audio.playbackRate }));
    on('volumechange', () => this.update({ volume: audio.volume }));
    on('error', () => {
      if (audio.getAttribute('src')) this.update({ audioReady: false, error: 'Impossibile riprodurre la traccia audio (formato non supportato dal browser?)' });
    });
  }

  private bindApiEvents(): void {
    const api = this.api;
    const add = (off: () => void) => this.disposers.push(off);

    add(
      api.scoreLoaded.on((score) => {
        // scoreLoaded arriva anche al cambio di tracce: i dati incorporati si leggono una volta.
        if (score !== this.loadedScore) {
          this.loadedScore = score;
          this.embedded = { syncPoints: score.exportFlatSyncPoints(), audio: score.backingTrack?.rawAudioFile ?? null };
        }
        this.update({
          scoreLoaded: true,
          error: null,
          embeddedSyncPoints: this.embedded.syncPoints.length,
          embeddedAudio: !!this.embedded.audio?.length,
        });
      }),
    );
    add(api.renderStarted.on(() => this.update({ rendering: true })));
    add(
      api.postRenderFinished.on(() => {
        if (this.highlight) api.highlightPlaybackRange(this.highlight.start, this.highlight.end);
        this.update({ rendering: false, renderVersion: this.snapshot.renderVersion + 1 });
      }),
    );
    add(
      api.midiLoaded.on(() => {
        const cache = api.tickCache;
        const score = api.score;
        if (cache && score) {
          this.timeline = Timeline.fromTickLookup(cache.masterBars, score.tempo);
          this.update({ timelineVersion: this.snapshot.timelineVersion + 1 });
        }
      }),
    );
    add(
      api.error.on((e) => {
        this.update({ error: e.message || 'Errore durante il caricamento dello spartito', rendering: false });
      }),
    );
    add(api.playerPositionChanged.on((e) => this.update({ tick: e.currentTick })));
    add(
      api.playerFinished.on(() => {
        // Con il loop attivo alphaTab riparte da A: notifichiamo la ripetizione.
        if (api.isLooping && api.playbackRange) {
          this.loopListeners.forEach((l) => l());
          if (this.loopGapMs > 0) {
            this.audio.pause();
            window.clearTimeout(this.gapTimer);
            this.gapTimer = window.setTimeout(() => this.play(), this.loopGapMs);
          }
        }
      }),
    );

    // Selezione nello spartito: clic = posiziona/seleziona, trascinamento = intervallo A-B.
    add(
      api.beatMouseDown.on((beat) => {
        this.dragStart = beat;
        this.dragging = false;
      }),
    );
    add(
      api.beatMouseMove.on((beat) => {
        if (!this.dragStart || beat === this.dragStart) return;
        this.dragging = true;
        this.highlight = { start: this.dragStart, end: beat };
        api.highlightPlaybackRange(this.dragStart, beat);
      }),
    );
    add(
      api.beatMouseUp.on((beat) => {
        const start = this.dragStart;
        this.dragStart = null;
        if (this.dragging && start && beat) {
          this.dragging = false;
          this.highlight = { start, end: beat };
          api.highlightPlaybackRange(start, beat);
          api.applyPlaybackRangeFromHighlight();
          api.isLooping = true;
          const range = api.playbackRange ? { startTick: api.playbackRange.startTick, endTick: api.playbackRange.endTick } : null;
          this.update({ range, looping: true });
          this.rangeListeners.forEach((l) => l(range));
          return;
        }
        this.dragging = false;
        if (beat) this.beatClickListeners.forEach((l) => l({ beat, shiftKey: this.shiftDown }));
      }),
    );
    const trackShift = (e: KeyboardEvent | MouseEvent) => {
      this.shiftDown = e.shiftKey;
    };
    window.addEventListener('mousedown', trackShift, true);
    this.disposers.push(() => window.removeEventListener('mousedown', trackShift, true));
  }

  // --------------------------------------------------------------- comandi

  loadScore(data: ArrayBuffer, trackIndexes?: number[]): void {
    this.update({ scoreLoaded: false, rendering: true, error: null });
    this.timeline = null;
    try {
      const ok = this.api.load(data, trackIndexes);
      if (!ok) this.update({ error: 'Formato dello spartito non riconosciuto', rendering: false });
    } catch (err) {
      this.update({ error: err instanceof Error ? err.message : String(err), rendering: false });
    }
  }

  setTracks(indexes: number[]): void {
    const score = this.api.score;
    if (!score) return;
    const tracks = indexes.map((i) => score.tracks[i]).filter(Boolean);
    if (tracks.length > 0) this.api.renderTracks(tracks);
  }

  /**
   * Passa a un'altra versione della stessa registrazione (es. senza chitarra)
   * restando nello stesso punto e continuando a suonare se stava suonando.
   */
  switchAudio(url: string): void {
    const time = this.audio.currentTime;
    const resume = !this.audio.paused;
    this.setAudio(url);
    const token = this.switchToken;
    this.audio.addEventListener(
      'loadedmetadata',
      () => {
        if (token !== this.switchToken || this.destroyed) return;
        this.audio.currentTime = Math.min(time, this.audio.duration || time);
        this.pushPosition();
        if (resume) this.play();
      },
      { once: true },
    );
  }

  setAudio(url: string | null): void {
    this.switchToken++;
    this.pause();
    this.update({ audioReady: false, audioDurationMs: 0, audioTimeMs: 0, error: null });
    if (url) {
      this.audio.src = url;
      this.audio.load();
    } else {
      this.audio.removeAttribute('src');
      this.audio.load();
    }
  }

  play(): void {
    window.clearTimeout(this.gapTimer);
    if (!this.audio.getAttribute('src')) return;
    if (this.api.isReadyForPlayback) this.api.play();
    else this.audio.play().catch(() => undefined);
  }

  pause(): void {
    window.clearTimeout(this.gapTimer);
    this.pauseAlphaTab();
    if (!this.audio.paused) this.audio.pause();
  }

  /**
   * Mette in pausa alphaTab lasciando l'audio dove si trova: alphaTab di suo riporta
   * il cursore all'inizio del beat corrente (e alla sua prima esecuzione, anche se si
   * è nel secondo giro di un ritornello), spostando anche la traccia audio.
   */
  private pauseAlphaTab(): void {
    if (this.api.playerState !== alphaTab.synth.PlayerState.Playing) return;
    const time = this.audio.currentTime;
    this.api.pause();
    if (Math.abs(this.audio.currentTime - time) > 0.0005) this.audio.currentTime = time;
    this.pushPosition();
  }

  togglePlay(): void {
    if (this.audio.paused) this.play();
    else this.pause();
  }

  /** Ferma e torna all'inizio (del loop, se attivo). */
  stop(): void {
    window.clearTimeout(this.gapTimer);
    this.api.stop();
    if (!this.audio.paused) this.audio.pause();
  }

  seekTick(tick: number): void {
    this.api.tickPosition = Math.max(0, Math.round(tick));
  }

  seekAudioMs(ms: number): void {
    this.audio.currentTime = Math.max(0, ms / 1000);
    this.pushPosition();
  }

  setSpeed(speed: number): void {
    const value = Math.max(0.25, Math.min(2, speed));
    this.api.playbackSpeed = value;
    // defaultPlaybackRate sopravvive al cambio di sorgente dell'elemento audio.
    this.audio.defaultPlaybackRate = value;
    this.audio.playbackRate = value;
    this.update({ speed: value });
  }

  setVolume(volume: number): void {
    this.api.masterVolume = volume;
    this.audio.volume = Math.max(0, Math.min(1, volume));
    this.update({ volume: this.audio.volume });
  }

  setLooping(looping: boolean): void {
    this.api.isLooping = looping;
    this.update({ looping });
  }

  /** Imposta l'intervallo A-B (in tick) ed evidenzia le battute corrispondenti. */
  setRange(range: PlaybackRange | null, seekToStart = false): void {
    const api = this.api;
    if (!range) {
      api.playbackRange = null;
      this.highlight = null;
      api.clearPlaybackRangeHighlight();
      this.update({ range: null });
      return;
    }
    const pr = new alphaTab.synth.PlaybackRange();
    pr.startTick = Math.round(range.startTick);
    pr.endTick = Math.round(range.endTick);
    api.playbackRange = pr;
    const start = this.beatAtTick(range.startTick);
    const end = this.beatAtTick(Math.max(range.startTick, range.endTick - 1));
    if (start && end) {
      this.highlight = { start, end };
      api.highlightPlaybackRange(start, end);
    }
    this.update({ range: { startTick: pr.startTick, endTick: pr.endTick } });
    if (seekToStart) this.seekTick(pr.startTick);
  }

  beatAtTick(tick: number): alphaTab.model.Beat | null {
    const cache = this.api.tickCache;
    if (!cache) return null;
    const tracks = new Set(this.api.tracks.map((t) => t.index));
    return cache.findBeat(tracks, Math.max(0, tick))?.beat ?? null;
  }

  /** Tick di inizio di un beat (prima esecuzione) e relativo alla battuta. */
  beatStartTick(beat: alphaTab.model.Beat): number {
    return this.api.tickCache?.getBeatStart(beat) ?? beat.absolutePlaybackStart;
  }

  applySyncPoints(points: FlatSyncPoint[]): void {
    this.syncPoints = points;
    const score = this.api.score;
    if (!score) return;
    score.applyFlatSyncPoints(points);
    this.api.updateSyncPoints();
    this.pushPosition();
  }

  /** Da richiamare dopo un nuovo caricamento dello spartito per riapplicare i sync point. */
  reapplySyncPoints(): void {
    this.applySyncPoints(this.syncPoints);
  }

  setDisplay(
    options: { scale?: number; layout?: LayoutName; staveProfile?: StaveProfileName; followCursor?: boolean },
    render = true,
  ): void {
    const s = this.api.settings;
    if (options.scale !== undefined) s.display.scale = options.scale;
    if (options.layout !== undefined) {
      s.display.layoutMode = options.layout === 'horizontal' ? alphaTab.LayoutMode.Horizontal : alphaTab.LayoutMode.Page;
    }
    if (options.staveProfile !== undefined) s.display.staveProfile = STAVE_PROFILES[options.staveProfile];
    if (options.followCursor !== undefined) {
      s.player.scrollMode = options.followCursor ? alphaTab.ScrollMode.Continuous : alphaTab.ScrollMode.Off;
    }
    this.api.updateSettings();
    if (render && this.api.score) this.api.render();
  }

  /** Mostra o nasconde le sigle scritte nel file (per non duplicare quelle dell'analisi). */
  setScoreChordNames(show: boolean, render = true): void {
    const elements = this.api.settings.notation.elements;
    if ((elements.get(alphaTab.NotationElement.EffectChordNames) ?? true) === show) return;
    elements.set(alphaTab.NotationElement.EffectChordNames, show);
    this.api.updateSettings();
    if (render && this.api.score) this.api.render();
  }

  setPadding(top: number, bottom: number, render = true): void {
    const d = this.api.settings.display;
    if (d.systemPaddingTop === top && d.systemPaddingBottom === bottom) return;
    // Il primo e l'ultimo sistema usano impostazioni proprie (che sostituiscono le altre).
    d.systemPaddingTop = top;
    d.firstSystemPaddingTop = top;
    d.systemPaddingBottom = bottom;
    d.lastSystemPaddingBottom = bottom + 6;
    this.api.updateSettings();
    if (render && this.api.score) this.api.render();
  }

  destroy(): void {
    this.destroyed = true;
    window.clearTimeout(this.gapTimer);
    cancelAnimationFrame(this.raf);
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.remove();
    this.disposers.forEach((d) => d());
    this.api.destroy();
    this.listeners.clear();
  }
}
