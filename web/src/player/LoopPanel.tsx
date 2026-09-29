import { useState } from 'react';
import type { SavedLoop } from '../../../shared/types';
import { Icon } from '../components/Icon';
import type { PlayerSnapshot } from './controller';
import { percent } from './format';
import type { Timeline } from './timeline';
import type { SpeedTrainer } from './useSpeedTrainer';

interface LoopPanelProps {
  snap: PlayerSnapshot;
  timeline: Timeline | null;
  loops: SavedLoop[];
  trainer: SpeedTrainer;
  gapMs: number;
  onGapChange: (ms: number) => void;
  onSave: (name: string) => Promise<void>;
  onActivate: (loop: SavedLoop) => void;
  onDelete: (loop: SavedLoop) => void;
  onRename: (loop: SavedLoop, name: string) => void;
}

export function LoopPanel({ snap, timeline, loops, trainer, gapMs, onGapChange, onSave, onActivate, onDelete, onRename }: LoopPanelProps) {
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const range = snap.range;
  const startBar = range && timeline ? timeline.barAtTick(range.startTick) : null;
  const endBar = range && timeline ? timeline.barAtTick(Math.max(range.startTick, range.endTick - 1)) : null;
  const t = trainer.settings;

  return (
    <div className="panel-body loop-panel">
      <section className="panel-section">
        <h3>
          <Icon name="repeat" /> Loop corrente
        </h3>
        {range && startBar && endBar ? (
          <>
            <p>
              Battute <strong>{startBar.barIndex + 1}</strong> → <strong>{endBar.barIndex + 1}</strong>
              {snap.looping ? <span className="badge success">attivo</span> : <span className="badge">in pausa</span>}
            </p>
            <form
              className="field-row"
              onSubmit={async (e) => {
                e.preventDefault();
                await onSave(name.trim() || `Battute ${startBar.barIndex + 1}–${endBar.barIndex + 1}`);
                setName('');
              }}
            >
              <input placeholder="Nome (es. Assolo, Intro…)" value={name} onChange={(e) => setName(e.target.value)} />
              <button className="primary" type="submit">
                <Icon name="bookmark" /> Salva
              </button>
            </form>
          </>
        ) : (
          <p className="muted small">
            Trascina sullo spartito da una nota all'altra per creare il loop, oppure usa i tasti <kbd>[</kbd> e <kbd>]</kbd> (A e B)
            durante l'ascolto.
          </p>
        )}
        <div className="field-row">
          <label className="inline">
            Pausa tra le ripetizioni
            <select value={gapMs} onChange={(e) => onGapChange(Number(e.target.value))}>
              <option value={0}>nessuna</option>
              <option value={1000}>1 s</option>
              <option value={2000}>2 s</option>
              <option value={3000}>3 s</option>
              <option value={5000}>5 s</option>
            </select>
          </label>
        </div>
      </section>

      <section className="panel-section">
        <h3>
          <Icon name="gauge" /> Allenatore di velocità
        </h3>
        <label className="checkbox">
          <input type="checkbox" checked={t.enabled} onChange={(e) => trainer.update({ enabled: e.target.checked })} />
          Aumenta la velocità a ogni giro del loop
        </label>
        <div className="form-grid trainer-grid">
          <label>
            Parti da
            <select value={t.start} onChange={(e) => trainer.update({ start: Number(e.target.value) })}>
              {[0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9].map((v) => (
                <option key={v} value={v}>
                  {percent(v)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Aumento
            <select value={t.step} onChange={(e) => trainer.update({ step: Number(e.target.value) })}>
              {[0.02, 0.05, 0.1].map((v) => (
                <option key={v} value={v}>
                  +{percent(v)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Ogni
            <select value={t.every} onChange={(e) => trainer.update({ every: Number(e.target.value) })}>
              {[1, 2, 3, 4, 5].map((v) => (
                <option key={v} value={v}>
                  {v} {v === 1 ? 'giro' : 'giri'}
                </option>
              ))}
            </select>
          </label>
          <label>
            Fino a
            <select value={t.target} onChange={(e) => trainer.update({ target: Number(e.target.value) })}>
              {[0.8, 0.9, 1, 1.1, 1.2].map((v) => (
                <option key={v} value={v}>
                  {percent(v)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="muted small">
          Ripetizioni: <strong>{trainer.repetitions}</strong> · velocità attuale <strong>{percent(snap.speed)}</strong>{' '}
          <button className="link" onClick={trainer.reset}>
            ricomincia
          </button>
        </p>
      </section>

      <section className="panel-section">
        <h3>
          <Icon name="bookmark" /> Loop salvati
        </h3>
        {loops.length === 0 && <p className="muted small">Nessun loop salvato.</p>}
        <ul className="loop-list">
          {loops.map((loop) => (
            <li key={loop.id} className={range && range.startTick === loop.startTick && range.endTick === loop.endTick ? 'active' : ''}>
              {renaming === loop.id ? (
                <form
                  className="field-row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    onRename(loop, renameValue.trim() || loop.name);
                    setRenaming(null);
                  }}
                >
                  <input autoFocus value={renameValue} onChange={(e) => setRenameValue(e.target.value)} />
                  <button type="submit">OK</button>
                </form>
              ) : (
                <>
                  <button className="loop-main" onClick={() => onActivate(loop)} title="Attiva questo loop">
                    <strong>{loop.name}</strong>
                    <span className="muted small">
                      batt. {loop.startBar + 1}–{loop.endBar + 1} · {percent(loop.speed)}
                    </span>
                  </button>
                  <button
                    className="icon-button"
                    title="Rinomina"
                    onClick={() => {
                      setRenaming(loop.id);
                      setRenameValue(loop.name);
                    }}
                  >
                    <Icon name="edit" size={15} />
                  </button>
                  <button className="icon-button" title="Elimina" onClick={() => onDelete(loop)}>
                    <Icon name="trash" size={15} />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
        {loops.length > 0 && (
          <p className="muted small">Un loop salvato ricorda anche la velocità a cui lo stavi studiando.</p>
        )}
      </section>
      <p className="muted small">
        Suggerimento: <kbd>Spazio</kbd> play/pausa · <kbd>L</kbd> loop · <kbd>−</kbd>/<kbd>+</kbd> velocità · <kbd>←</kbd>/<kbd>→</kbd>{' '}
        battuta precedente/successiva
      </p>
    </div>
  );
}
