import { useCallback, useEffect, useRef, useState } from 'react';
import { notify } from '../components/toast';
import type { PlayerController } from './controller';

export interface TrainerSettings {
  enabled: boolean;
  start: number;
  step: number;
  every: number;
  target: number;
}

export interface SpeedTrainer {
  settings: TrainerSettings;
  repetitions: number;
  update: (patch: Partial<TrainerSettings>) => void;
  reset: () => void;
}

const DEFAULTS: TrainerSettings = { enabled: false, start: 0.6, step: 0.05, every: 2, target: 1 };

/**
 * Allenatore di velocità: a ogni N ripetizioni del loop aumenta la velocità di un
 * passo, fino all'obiettivo.
 */
export function useSpeedTrainer(controller: PlayerController | null): SpeedTrainer {
  const [settings, setSettings] = useState<TrainerSettings>(DEFAULTS);
  const [repetitions, setRepetitions] = useState(0);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const countRef = useRef(0);

  useEffect(() => {
    if (!controller) return;
    return controller.onLoopRepeat(() => {
      countRef.current += 1;
      setRepetitions(countRef.current);
      const s = settingsRef.current;
      if (!s.enabled || countRef.current % Math.max(1, s.every) !== 0) return;
      const current = controller.getSnapshot().speed;
      if (current >= s.target - 1e-6) return;
      const next = Math.min(s.target, Math.round((current + s.step) * 100) / 100);
      controller.setSpeed(next);
      notify(next >= s.target ? `Obiettivo raggiunto: ${Math.round(next * 100)}%` : `Velocità ${Math.round(next * 100)}%`, next >= s.target ? 'success' : 'info', 1800);
    });
  }, [controller]);

  const update = useCallback(
    (patch: Partial<TrainerSettings>) => {
      setSettings((prev) => {
        const next = { ...prev, ...patch };
        if (patch.enabled && !prev.enabled) {
          countRef.current = 0;
          setRepetitions(0);
          controller?.setSpeed(next.start);
        }
        return next;
      });
    },
    [controller],
  );

  const reset = useCallback(() => {
    countRef.current = 0;
    setRepetitions(0);
    if (settingsRef.current.enabled) controller?.setSpeed(settingsRef.current.start);
  }, [controller]);

  return { settings, repetitions, update, reset };
}
