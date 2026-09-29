import { useState } from 'react';
import type { AudioTrack } from '../../../shared/types';
import { Icon } from '../components/Icon';
import { ConfirmDialog } from '../components/Modal';
import type { PlayerController } from './controller';
import { barName, formatTime } from './format';
import type { ScorePosition } from './scoreTools';
import { positionLabel } from './scoreTools';
import type { Timeline } from './timeline';
import type { SyncEditor, TapStep } from './useSyncEditor';

interface SyncPanelProps {
  controller: PlayerController;
  editor: SyncEditor;
  audio: AudioTrack | null;
  timeline: Timeline | null;
  selection: ScorePosition | null;
  latencyMs: number;
  onLatencyChange: (ms: number) => void;
}

const STEPS: Array<{ value: TapStep; label: string }> = [
  { value: 1, label: 'ogni battuta' },
  { value: 2, label: 'ogni 2 battute' },
  { value: 4, label: 'ogni 4 battute' },
  { value: 'beat', label: 'ogni movimento (rubato)' },
];

const SAVE_LABELS = { saved: 'Salvato', dirty: 'Modifiche in attesa…', saving: 'Salvataggio…', error: 'Errore di salvataggio' };

export function SyncPanel({ controller, editor, audio, timeline, selection, latencyMs, onLatencyChange }: SyncPanelProps) {
  const [confirmClear, setConfirmClear] = useState(false);
  const [startOrder, setStartOrder] = useState<number | ''>('');

  if (!audio) {
    return (
      <div className="panel-body">
        <p className="muted">Aggiungi prima una traccia audio: i sync point collegano le battute dello spartito agli istanti della registrazione.</p>
      </div>
    );
  }

  const anchors = editor.syncMap?.anchors ?? [];
  const anchorIndex = new Map(anchors.map((a, i) => [a.index, i]));
  const invalid = editor.syncMap?.invalid ?? new Set<number>();
  const next = editor.nextTarget;
  const selectionLabel = selection ? positionLabel(controller.score, selection) : null;

  return (
    <div className="panel-body sync-panel">
      <p className="muted small">
        Indica dove inizia ogni battuta nella registrazione: tra un sync point e l'altro il cursore segue il tempo reale
        dell'esecuzione. Per un brano a tempo costante bastano l'inizio e la fine; per un'esecuzione rubato conviene un punto a
        battuta (o a movimento).
      </p>

      {!editor.canEdit && <p className="notice">Solo il proprietario dello spartito può modificare i sync point.</p>}

      <section className="panel-section">
        <h3>
          <Icon name="tap" /> Tap durante l'ascolto
        </h3>
        <div className="field-row">
          <select value={String(editor.tapStep)} onChange={(e) => editor.setTapStep(e.target.value === 'beat' ? 'beat' : (Number(e.target.value) as TapStep))} disabled={editor.tapActive}>
            {STEPS.map((s) => (
              <option key={String(s.value)} value={String(s.value)}>
                {s.label}
              </option>
            ))}
          </select>
          <select
            value={startOrder === '' ? '' : String(startOrder)}
            onChange={(e) => setStartOrder(e.target.value === '' ? '' : Number(e.target.value))}
            disabled={editor.tapActive || !timeline}
            title="Battuta da cui iniziare"
          >
            <option value="">dalla posizione attuale</option>
            {timeline?.bars.map((b) => (
              <option key={b.order} value={b.order}>
                dalla battuta {barName(b.barIndex, b.occurrence)}
              </option>
            ))}
          </select>
        </div>
        {editor.tapActive ? (
          <div className="tap-box">
            <button className="tap-button" onClick={editor.tap} title="Premi T sull'attacco">
              TAP <kbd>T</kbd>
            </button>
            <div>
              <div>
                Prossimo tap: <strong>{next ? positionLabel(controller.score, { barIndex: next.bar.barIndex, position: next.position }) : '—'}</strong>
                {next && next.bar.occurrence > 0 && <span className="badge">{next.bar.occurrence + 1}ª volta</span>}
              </div>
              <div className="field-row">
                <button onClick={editor.undo} disabled={!editor.canUndo}>
                  <Icon name="undo" /> Annulla (Z)
                </button>
                <button onClick={editor.stopTap}>Fine</button>
              </div>
            </div>
          </div>
        ) : (
          <button
            className="primary"
            disabled={!editor.canEdit || !timeline}
            onClick={() => editor.startTap(startOrder === '' ? undefined : startOrder)}
          >
            <Icon name="tap" /> Avvia tap
          </button>
        )}
        <p className="muted small">
          Avvia il tap, fai partire l'audio (anche rallentato: la precisione migliora) e premi <kbd>T</kbd> su ogni attacco.
        </p>
      </section>

      <section className="panel-section">
        <h3>
          <Icon name="target" /> Assegna manualmente
        </h3>
        <p className="muted small">
          In modalità sync un clic sullo spartito seleziona il punto senza spostare l'audio. Posiziona l'audio sull'attacco
          (forma d'onda, frecce) e assegna.
        </p>
        <button className="primary" disabled={!editor.canEdit || !selection || !timeline} onClick={() => selection && editor.assign(selection.barIndex, selection.position)}>
          {selectionLabel ? `${selectionLabel} → ${formatTime(controller.audio.currentTime * 1000, 2)}` : 'Seleziona un punto dello spartito'}
          <kbd>S</kbd>
        </button>
      </section>

      <section className="panel-section">
        <div className="section-title-row">
          <h3>
            <Icon name="flag" /> Sync point ({editor.points.length})
          </h3>
          <span className={`save-state save-${editor.saveState}`}>{editor.canEdit ? SAVE_LABELS[editor.saveState] : ''}</span>
        </div>
        {editor.points.length === 0 ? (
          <p className="muted small">Nessun sync point: lo spartito segue il tempo scritto partendo dall'inizio dell'audio.</p>
        ) : (
          <table className="table compact sync-table">
            <thead>
              <tr>
                <th>Punto</th>
                <th>Tempo audio</th>
                <th title="Tempo effettivo della registrazione fino al punto successivo">♩ reale</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {editor.points.map((p, index) => {
                const ai = anchorIndex.get(index);
                const bpm = ai !== undefined ? editor.syncMap?.segmentBpm(ai) : null;
                return (
                  <tr key={`${p.barIndex}-${p.barOccurence}-${p.barPosition}`} className={invalid.has(index) ? 'invalid' : ''}>
                    <td>
                      {positionLabel(controller.score, { barIndex: p.barIndex, position: p.barPosition })}
                      {p.barOccurence > 0 && <span className="badge">{p.barOccurence + 1}ª</span>}
                      {invalid.has(index) && (
                        <span className="badge danger" title="Ignorato: tempo non crescente o battuta inesistente">
                          !
                        </span>
                      )}
                    </td>
                    <td>
                      <button className="link" title="Ascolta da qui" onClick={() => controller.seekAudioMs(Math.max(0, p.millisecondOffset - 1500))}>
                        {formatTime(p.millisecondOffset, 2)}
                      </button>
                    </td>
                    <td className="muted">{bpm ? bpm.toFixed(1) : ''}</td>
                    <td className="row-actions">
                      <button className="icon-button" title="-10 ms" disabled={!editor.canEdit} onClick={() => editor.nudge(index, -10)}>
                        ‹
                      </button>
                      <button className="icon-button" title="+10 ms" disabled={!editor.canEdit} onClick={() => editor.nudge(index, 10)}>
                        ›
                      </button>
                      <button className="icon-button" title="Elimina" disabled={!editor.canEdit} onClick={() => editor.remove(index)}>
                        <Icon name="trash" size={15} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {editor.points.length > 0 && editor.canEdit && (
          <div className="field-row">
            <span className="muted small">Sposta tutti:</span>
            <button onClick={() => editor.shiftAll(-50)}>−50 ms</button>
            <button onClick={() => editor.shiftAll(-10)}>−10</button>
            <button onClick={() => editor.shiftAll(10)}>+10</button>
            <button onClick={() => editor.shiftAll(50)}>+50 ms</button>
            <span className="spacer" />
            <button className="danger-link" onClick={() => setConfirmClear(true)}>
              Elimina tutti
            </button>
          </div>
        )}
      </section>

      <section className="panel-section">
        <h3>
          <Icon name="settings" /> Latenza audio
        </h3>
        <div className="field-row">
          <input
            type="range"
            min={0}
            max={400}
            step={5}
            value={latencyMs}
            onChange={(e) => onLatencyChange(Number(e.target.value))}
            aria-label="Latenza audio"
          />
          <span>{latencyMs} ms</span>
        </div>
        <p className="muted small">
          Con cuffie Bluetooth il suono arriva in ritardo: aumenta il valore finché il cursore e i tap coincidono con ciò che
          senti (vale solo per questo dispositivo).
        </p>
      </section>

      {confirmClear && (
        <ConfirmDialog
          title="Eliminare tutti i sync point?"
          message="Potrai annullare con Z finché resti su questa pagina."
          confirmLabel="Elimina"
          danger
          onClose={() => setConfirmClear(false)}
          onConfirm={() => editor.clear()}
        />
      )}
    </div>
  );
}
