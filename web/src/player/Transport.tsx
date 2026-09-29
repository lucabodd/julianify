import { Icon } from '../components/Icon';
import type { PlayerController, PlayerSnapshot } from './controller';
import { formatTime, percent } from './format';
import type { Timeline } from './timeline';

interface TransportProps {
  controller: PlayerController;
  snap: PlayerSnapshot;
  timeline: Timeline | null;
  hasAudio: boolean;
  onSetA: () => void;
  onSetB: () => void;
  onClearLoop: () => void;
}

const SPEED_PRESETS = [0.5, 0.6, 0.75, 0.9, 1];

export function Transport({ controller, snap, timeline, hasAudio, onSetA, onSetB, onClearLoop }: TransportProps) {
  const bar = timeline?.barAtTick(snap.tick);
  const totalBars = controller.score?.masterBars.length ?? 0;
  const rangeBars =
    snap.range && timeline
      ? [timeline.barAtTick(snap.range.startTick), timeline.barAtTick(Math.max(snap.range.startTick, snap.range.endTick - 1))]
      : null;

  return (
    <div className="transport">
      <div className="transport-group">
        <button className="icon-button big" title="Torna all'inizio (Esc)" onClick={() => controller.stop()} disabled={!hasAudio}>
          <Icon name="stop" />
        </button>
        <button
          className="play-button"
          title={snap.playing ? 'Pausa (Spazio)' : 'Riproduci (Spazio)'}
          onClick={() => controller.togglePlay()}
          disabled={!hasAudio || !snap.audioReady}
        >
          <Icon name={snap.playing ? 'pause' : 'play'} size={22} />
        </button>
        <div className="time-display" title="Tempo della traccia audio">
          <strong>{formatTime(snap.audioTimeMs)}</strong>
          <span className="muted"> / {formatTime(snap.audioDurationMs, 0)}</span>
        </div>
        <div className="bar-display" title="Battuta corrente">
          Batt. <strong>{bar ? bar.barIndex + 1 : '–'}</strong>
          <span className="muted">/{totalBars || '–'}</span>
          {bar && bar.occurrence > 0 && <span className="badge">{bar.occurrence + 1}ª</span>}
        </div>
      </div>

      <div className="transport-group speed" title="Velocità (tono invariato) — tasti − e +">
        <Icon name="gauge" />
        <button className="icon-button" onClick={() => controller.setSpeed(Math.round((snap.speed - 0.05) * 100) / 100)} aria-label="Più lento">
          <Icon name="minus" size={14} />
        </button>
        <input
          type="range"
          min={0.25}
          max={1.5}
          step={0.01}
          value={snap.speed}
          onChange={(e) => controller.setSpeed(Number(e.target.value))}
          aria-label="Velocità"
        />
        <button className="icon-button" onClick={() => controller.setSpeed(Math.round((snap.speed + 0.05) * 100) / 100)} aria-label="Più veloce">
          <Icon name="plus" size={14} />
        </button>
        <span className={`speed-value${snap.speed !== 1 ? ' changed' : ''}`}>{percent(snap.speed)}</span>
        <select
          className="compact"
          value=""
          onChange={(e) => e.target.value && controller.setSpeed(Number(e.target.value))}
          aria-label="Velocità predefinite"
        >
          <option value="">▾</option>
          {SPEED_PRESETS.map((s) => (
            <option key={s} value={s}>
              {percent(s)}
            </option>
          ))}
        </select>
      </div>

      <div className="transport-group loop">
        <button onClick={onSetA} title="Inizio del loop sulla posizione corrente ( [ )" disabled={!timeline}>
          A
        </button>
        <button onClick={onSetB} title="Fine del loop sulla posizione corrente ( ] )" disabled={!timeline}>
          B
        </button>
        <button
          className={snap.looping && snap.range ? 'toggle active' : 'toggle'}
          onClick={() => controller.setLooping(!snap.looping)}
          disabled={!snap.range}
          title="Ripeti l'intervallo A-B (L)"
        >
          <Icon name="repeat" /> Loop
        </button>
        {rangeBars && rangeBars[0] && rangeBars[1] && (
          <span className="range-label">
            {rangeBars[0].barIndex + 1}–{rangeBars[1].barIndex + 1}
          </span>
        )}
        {snap.range && (
          <button className="icon-button" title="Cancella il loop (X)" onClick={onClearLoop}>
            <Icon name="close" size={14} />
          </button>
        )}
      </div>

      <div className="transport-group volume" title="Volume">
        <Icon name={snap.volume === 0 ? 'mute' : 'volume'} />
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={snap.volume}
          onChange={(e) => controller.setVolume(Number(e.target.value))}
          aria-label="Volume"
        />
      </div>
    </div>
  );
}
