import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AudioTrack, FlatSyncPoint } from '../../../shared/types';
import { api } from '../api';
import { notifyError } from '../components/toast';
import type { PlayerController } from './controller';
import { beatsPerBar } from './scoreTools';
import { SyncMap, type PlaybackBar } from './timeline';

export type TapStep = 'beat' | 1 | 2 | 4;
export type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

export interface TapTarget {
  bar: PlaybackBar;
  position: number;
}

export interface SyncEditor {
  points: FlatSyncPoint[];
  syncMap: SyncMap | null;
  saveState: SaveState;
  canEdit: boolean;
  tapActive: boolean;
  tapStep: TapStep;
  nextTarget: TapTarget | null;
  setTapStep: (step: TapStep) => void;
  startTap: (fromOrder?: number) => void;
  stopTap: () => void;
  tap: () => void;
  undo: () => void;
  canUndo: boolean;
  assign: (barIndex: number, position: number, occurrence?: number) => FlatSyncPoint | null;
  setTime: (index: number, ms: number) => void;
  nudge: (index: number, deltaMs: number) => void;
  shiftAll: (deltaMs: number) => void;
  remove: (index: number) => void;
  clear: () => void;
}

function samePoint(a: FlatSyncPoint, b: { barIndex: number; barOccurence: number; barPosition: number }): boolean {
  return a.barIndex === b.barIndex && a.barOccurence === b.barOccurence && Math.abs(a.barPosition - b.barPosition) < 0.001;
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}

/**
 * Stato e comandi dell'editor dei sync point per la traccia audio attiva:
 * tap sulle battute durante l'ascolto, assegnazione manuale, spostamenti fini,
 * annulla e salvataggio automatico.
 */
export function useSyncEditor(
  controller: PlayerController | null,
  audioTrack: AudioTrack | null,
  canEdit: boolean,
  timelineVersion: number,
  onSaved: (audio: AudioTrack) => void,
): SyncEditor {
  const [points, setPoints] = useState<FlatSyncPoint[]>(audioTrack?.syncPoints ?? []);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [tapActive, setTapActive] = useState(false);
  const [tapStep, setTapStep] = useState<TapStep>(1);
  const [targetIndex, setTargetIndex] = useState(0);
  const targets = useRef<TapTarget[]>([]);
  const history = useRef<Array<{ points: FlatSyncPoint[]; targetIndex: number }>>([]);
  const [historySize, setHistorySize] = useState(0);
  const pointsRef = useRef(points);
  pointsRef.current = points;
  const audioId = audioTrack?.id ?? null;

  useEffect(() => {
    setPoints(audioTrack?.syncPoints ?? []);
    setSaveState('saved');
    setTapActive(false);
    history.current = [];
    setHistorySize(0);
    // Si ricarica solo quando cambia la traccia, non ad ogni salvataggio.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioId]);

  const timeline = controller?.timeline ?? null;
  const syncMap = useMemo(
    () => (timeline ? new SyncMap(timeline, points) : null),
    // timelineVersion cambia quando alphaTab rigenera la tabella dei tick
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timeline, points, timelineVersion],
  );

  useEffect(() => {
    if (!controller || !audioId) return;
    controller.applySyncPoints(syncMap ? syncMap.validPoints() : points);
  }, [controller, syncMap, points, audioId]);

  // Salvataggio automatico (con ritardo per raggruppare i tap).
  useEffect(() => {
    if (saveState !== 'dirty' || !audioId || !canEdit) return;
    const timer = window.setTimeout(async () => {
      setSaveState('saving');
      try {
        const saved = await api.updateAudio(audioId, { syncPoints: pointsRef.current });
        onSaved(saved);
        setSaveState((s) => (s === 'saving' ? 'saved' : s));
      } catch (err) {
        notifyError(err);
        setSaveState('error');
      }
    }, 900);
    return () => window.clearTimeout(timer);
  }, [saveState, points, audioId, canEdit, onSaved]);

  const commit = useCallback(
    (next: FlatSyncPoint[], nextTargetIndex?: number) => {
      if (!canEdit) return;
      history.current.push({ points: pointsRef.current, targetIndex });
      if (history.current.length > 200) history.current.shift();
      setHistorySize(history.current.length);
      const sorted = timeline
        ? [...next].sort(
            (a, b) =>
              (timeline.tickOf(a.barIndex, a.barOccurence, a.barPosition) ?? 0) -
                (timeline.tickOf(b.barIndex, b.barOccurence, b.barPosition) ?? 0) || a.millisecondOffset - b.millisecondOffset,
          )
        : next;
      setPoints(sorted);
      pointsRef.current = sorted;
      if (nextTargetIndex !== undefined) setTargetIndex(nextTargetIndex);
      setSaveState('dirty');
    },
    [canEdit, targetIndex, timeline],
  );

  const upsert = useCallback(
    (list: FlatSyncPoint[], point: FlatSyncPoint): FlatSyncPoint[] => {
      const index = list.findIndex((p) => samePoint(p, point));
      if (index >= 0) return list.map((p, i) => (i === index ? point : p));
      return [...list, point];
    },
    [],
  );

  const buildTargets = useCallback(
    (fromOrder: number, step: TapStep): TapTarget[] => {
      const score = controller?.score;
      if (!timeline || !score) return [];
      const list: TapTarget[] = [];
      for (let order = fromOrder; order < timeline.bars.length; order++) {
        const bar = timeline.bars[order];
        if (step === 'beat') {
          const beats = beatsPerBar(score.masterBars[bar.barIndex]);
          for (let j = 0; j < beats; j++) list.push({ bar, position: j / beats });
        } else if ((order - fromOrder) % step === 0) {
          list.push({ bar, position: 0 });
        }
      }
      return list;
    },
    [controller, timeline],
  );

  const startTap = useCallback(
    (fromOrder?: number) => {
      if (!controller || !timeline || !canEdit) return;
      let order = fromOrder;
      if (order === undefined) {
        const tick = controller.getSnapshot().tick;
        const bar = timeline.barAtTick(tick);
        order = bar ? bar.order : 0;
        // Se il battere della battuta corrente è già passato si parte dalla successiva.
        if (bar && tick > bar.startTick + (bar.endTick - bar.startTick) * 0.1 && controller.audio.currentTime > 0.05) order += 1;
      }
      targets.current = buildTargets(Math.max(0, Math.min(order, timeline.bars.length - 1)), tapStep);
      setTargetIndex(0);
      setTapActive(targets.current.length > 0);
    },
    [buildTargets, canEdit, controller, tapStep, timeline],
  );

  const stopTap = useCallback(() => setTapActive(false), []);

  const tap = useCallback(() => {
    if (!tapActive || !controller) return;
    const target = targets.current[targetIndex];
    if (!target) {
      setTapActive(false);
      return;
    }
    const ms = round(controller.audio.currentTime * 1000 - controller.latencyMs);
    const point: FlatSyncPoint = {
      barIndex: target.bar.barIndex,
      barOccurence: target.bar.occurrence,
      barPosition: target.position,
      millisecondOffset: Math.max(0, ms),
    };
    commit(upsert(pointsRef.current, point), targetIndex + 1);
    if (targetIndex + 1 >= targets.current.length) setTapActive(false);
  }, [commit, controller, tapActive, targetIndex, upsert]);

  const undo = useCallback(() => {
    const last = history.current.pop();
    setHistorySize(history.current.length);
    if (!last) return;
    setPoints(last.points);
    pointsRef.current = last.points;
    setTargetIndex(last.targetIndex);
    setSaveState('dirty');
  }, []);

  const assign = useCallback(
    (barIndex: number, position: number, occurrence?: number): FlatSyncPoint | null => {
      if (!controller || !timeline) return null;
      const audioMs = controller.audio.currentTime * 1000;
      let occ = occurrence;
      if (occ === undefined) {
        const candidates = timeline.occurrencesOf(barIndex);
        if (candidates.length === 0) return null;
        // Tra le ripetizioni della battuta sceglie quella più vicina al punto d'ascolto.
        let best = candidates[0];
        let bestDistance = Infinity;
        for (const c of candidates) {
          const tick = c.startTick + position * (c.endTick - c.startTick);
          const distance = Math.abs((syncMap ? syncMap.tickToAudio(tick) : timeline.tickToMs(tick)) - audioMs);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = c;
          }
        }
        occ = best.occurrence;
      }
      const point: FlatSyncPoint = { barIndex, barOccurence: occ, barPosition: position, millisecondOffset: round(audioMs) };
      commit(upsert(pointsRef.current, point));
      return point;
    },
    [commit, controller, syncMap, timeline, upsert],
  );

  const setTime = useCallback(
    (index: number, ms: number) => {
      const list = pointsRef.current;
      if (!list[index]) return;
      commit(list.map((p, i) => (i === index ? { ...p, millisecondOffset: round(Math.max(0, ms)) } : p)));
    },
    [commit],
  );

  const nudge = useCallback(
    (index: number, deltaMs: number) => {
      const p = pointsRef.current[index];
      if (p) setTime(index, p.millisecondOffset + deltaMs);
    },
    [setTime],
  );

  const shiftAll = useCallback(
    (deltaMs: number) => commit(pointsRef.current.map((p) => ({ ...p, millisecondOffset: round(Math.max(0, p.millisecondOffset + deltaMs)) }))),
    [commit],
  );

  const remove = useCallback((index: number) => commit(pointsRef.current.filter((_, i) => i !== index)), [commit]);
  const clear = useCallback(() => commit([]), [commit]);

  return {
    points,
    syncMap,
    saveState,
    canEdit,
    tapActive,
    tapStep,
    nextTarget: tapActive ? (targets.current[targetIndex] ?? null) : null,
    setTapStep,
    startTap,
    stopTap,
    tap,
    undo,
    canUndo: historySize > 0,
    assign,
    setTime,
    nudge,
    shiftAll,
    remove,
    clear,
  };
}
