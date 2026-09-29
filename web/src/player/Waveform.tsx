import { useEffect, useMemo, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin, { type Region } from 'wavesurfer.js/plugins/regions';
import type { AudioTrack, FlatSyncPoint } from '../../../shared/types';
import { api } from '../api';
import { Icon } from '../components/Icon';
import type { PlaybackRange, PlayerController } from './controller';
import type { SyncMap, Timeline } from './timeline';

interface WaveformProps {
  controller: PlayerController;
  audio: AudioTrack;
  canEdit: boolean;
  timeline: Timeline | null;
  syncMap: SyncMap | null;
  points: FlatSyncPoint[];
  invalid: Set<number>;
  range: PlaybackRange | null;
  showGrid: boolean;
  onMovePoint: (index: number, ms: number) => void;
  onRangeChange: (range: PlaybackRange) => void;
}

function pointLabel(p: FlatSyncPoint): string {
  let label = String(p.barIndex + 1);
  if (p.barPosition > 0.001) label += `.${Math.round(p.barPosition * 100)}`;
  if (p.barOccurence > 0) label += ` (${p.barOccurence + 1}ª)`;
  return label;
}

/**
 * Forma d'onda della traccia audio con i sync point (trascinabili), la griglia delle
 * battute calcolata dai sync e l'intervallo del loop.
 */
export function Waveform(props: WaveformProps) {
  const { controller, audio, canEdit } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<ReturnType<typeof RegionsPlugin.create> | null>(null);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(0);
  const [zoom, setZoom] = useState(60);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    setReady(false);
    setLoading(0);
    const regions = RegionsPlugin.create();
    const ws = WaveSurfer.create({
      container,
      media: controller.audio,
      height: 84,
      waveColor: '#7d8699',
      progressColor: '#c99a3c',
      cursorColor: '#f4f1ea',
      cursorWidth: 2,
      minPxPerSec: zoom,
      normalize: true,
      autoScroll: true,
      autoCenter: false,
      interact: true,
      dragToSeek: false,
      plugins: [regions],
    });
    wsRef.current = ws;
    regionsRef.current = regions;
    ws.on('loading', (p) => setLoading(p));
    ws.on('ready', () => {
      if (!cancelled) setReady(true);
    });
    ws.on('decode', (duration) => {
      // Memorizza la forma d'onda sul server per non doverla ricalcolare ogni volta.
      if (!canEdit || audio.hasPeaks || cancelled) return;
      try {
        const [peaks] = ws.exportPeaks({ channels: 1, maxLength: Math.min(200_000, Math.ceil(duration * 100)), precision: 1000 });
        void api.savePeaks(audio.id, { duration, peaks: Array.from(peaks) }).catch(() => undefined);
      } catch {
        // non essenziale
      }
    });
    regions.on('region-updated', (region: Region) => {
      const p = propsRef.current;
      if (region.id.startsWith('sync-')) {
        p.onMovePoint(Number(region.id.slice(5)), region.start * 1000);
      } else if (region.id === 'loop' && p.syncMap) {
        p.onRangeChange({
          startTick: Math.max(0, p.syncMap.audioToTick(region.start * 1000)),
          endTick: p.syncMap.audioToTick(region.end * 1000),
        });
      }
    });
    regions.on('region-clicked', (region: Region, e: MouseEvent) => {
      e.stopPropagation();
      controller.seekAudioMs(region.start * 1000);
    });

    const url = new URL(api.audioStreamUrl(audio.id), window.location.href).href;
    const load = async () => {
      if (audio.hasPeaks) {
        try {
          const cached = await api.getPeaks(audio.id);
          if (cancelled) return;
          await ws.load(url, [cached.peaks], cached.duration);
          return;
        } catch {
          // ricalcola dal file
        }
      }
      if (!cancelled) await ws.load(url);
    };
    load().catch(() => undefined);

    return () => {
      cancelled = true;
      ws.destroy();
      wsRef.current = null;
      regionsRef.current = null;
    };
    // Il media element e la traccia determinano l'istanza; lo zoom viene aggiornato a parte.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, audio.id]);

  useEffect(() => {
    if (ready) wsRef.current?.zoom(zoom);
  }, [zoom, ready]);

  // Marcatori: sync point, griglia delle battute e loop.
  const gridTimes = useMemo(() => {
    const { timeline, syncMap, showGrid } = props;
    if (!timeline || !showGrid) return [];
    return timeline.bars.map((bar) => ({
      bar,
      time: (syncMap ? syncMap.tickToAudio(bar.startTick) : timeline.tickToMs(bar.startTick)) / 1000,
    }));
  }, [props.timeline, props.syncMap, props.showGrid]);

  useEffect(() => {
    const regions = regionsRef.current;
    const ws = wsRef.current;
    if (!regions || !ws || !ready) return;
    regions.clearRegions();
    const duration = ws.getDuration();

    const synced = new Set(props.points.filter((p) => p.barPosition < 0.001).map((p) => `${p.barIndex}:${p.barOccurence}`));
    for (const { bar, time } of gridTimes) {
      if (time < 0 || time > duration || synced.has(`${bar.barIndex}:${bar.occurrence}`)) continue;
      const label = document.createElement('span');
      label.className = 'wf-grid-label';
      label.textContent = bar.occurrence > 0 ? `${bar.barIndex + 1}'` : String(bar.barIndex + 1);
      regions.addRegion({ id: `grid-${bar.order}`, start: time, color: 'rgba(244,241,234,0.18)', drag: false, resize: false, content: label });
    }

    props.points.forEach((p, index) => {
      const label = document.createElement('span');
      label.className = `wf-sync-label${props.invalid.has(index) ? ' invalid' : ''}`;
      label.textContent = pointLabel(p);
      label.title = props.invalid.has(index)
        ? 'Sync point incoerente (tempo fuori ordine o battuta inesistente): ignorato'
        : 'Trascina per regolare';
      regions.addRegion({
        id: `sync-${index}`,
        start: p.millisecondOffset / 1000,
        color: props.invalid.has(index) ? '#e5534b' : '#4fb3a5',
        drag: canEdit,
        resize: false,
        content: label,
      });
    });

    const { range, syncMap } = props;
    if (range && syncMap) {
      const start = syncMap.tickToAudio(range.startTick) / 1000;
      const end = syncMap.tickToAudio(range.endTick) / 1000;
      if (end > start) {
        regions.addRegion({ id: 'loop', start, end, color: 'rgba(232,176,75,0.22)', drag: true, resize: true });
      }
    }
  }, [ready, gridTimes, props.points, props.invalid, props.range, props.syncMap, canEdit]);

  return (
    <div className="waveform">
      <div className="waveform-toolbar">
        <span className="muted small">
          {ready ? 'Clicca per spostarti · trascina i marcatori verdi per regolare i sync' : `Forma d'onda… ${loading ? `${loading}%` : ''}`}
        </span>
        <span className="spacer" />
        <button className="icon-button" title="Riduci zoom" onClick={() => setZoom((z) => Math.max(10, Math.round(z / 1.5)))}>
          <Icon name="zoomOut" />
        </button>
        <button className="icon-button" title="Aumenta zoom" onClick={() => setZoom((z) => Math.min(800, Math.round(z * 1.5)))}>
          <Icon name="zoomIn" />
        </button>
      </div>
      <div ref={containerRef} className="waveform-canvas" />
    </div>
  );
}
