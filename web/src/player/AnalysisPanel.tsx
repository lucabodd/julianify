import { useEffect, useMemo, useState } from 'react';
import type { Annotation, AnnotationInput, AnnotationKind } from '../../../shared/types';
import { Icon } from '../components/Icon';
import { ConfirmDialog } from '../components/Modal';
import { notify, notifyError } from '../components/toast';
import type { AnalysisModel, AnalyzedChord } from './analysis';
import type { LayerOptions } from './AnnotationLayer';
import type { PlaybackRange, PlayerController } from './controller';
import {
  CATEGORY_LABELS,
  MODE_LABELS,
  MODES,
  analyzeProgression,
  describeVoicing,
  detectChords,
  estimateKeys,
  formatKey,
  formatKeyItalian,
  parseChord,
  parseKey,
  pitchName,
  prettyAccidentals,
  type KeyInfo,
  type Mode,
} from './harmony';
import {
  collectNotes,
  comparePositions,
  detectionSlots,
  pitchHistogram,
  positionLabel,
  scoreChordNames,
  type ScorePosition,
} from './scoreTools';
import type { Timeline } from './timeline';

export type EditingState = { mode: 'new'; kind: AnnotationKind; position: ScorePosition } | { mode: 'edit'; annotation: Annotation };

interface AnalysisPanelProps {
  controller: PlayerController;
  timeline: Timeline | null;
  annotations: Annotation[];
  model: AnalysisModel;
  selection: ScorePosition | null;
  range: PlaybackRange | null;
  editing: EditingState | null;
  setEditing: (editing: EditingState | null) => void;
  layers: LayerOptions;
  setLayers: (layers: LayerOptions) => void;
  onCreate: (input: AnnotationInput) => Promise<Annotation>;
  onCreateMany: (inputs: AnnotationInput[]) => Promise<number>;
  onUpdate: (id: number, input: Partial<AnnotationInput>) => Promise<Annotation>;
  onDelete: (id: number) => Promise<void>;
  onDeleteKind: (kind: AnnotationKind) => Promise<void>;
  onSeek: (pos: ScorePosition) => void;
}

const KIND_LABELS: Record<AnnotationKind, string> = { chord: 'Accordo', section: 'Sezione', key: 'Tonalità', note: 'Appunto' };
const KIND_ICONS: Record<AnnotationKind, 'chord' | 'flag' | 'key' | 'note'> = { chord: 'chord', section: 'flag', key: 'key', note: 'note' };
const SECTION_PRESETS = ['Intro', 'Tema', 'Strofa', 'Pre-ritornello', 'Ritornello', 'Bridge', 'Solo', 'Interludio', 'Coda', 'Outro', 'A', 'B', 'C'];
const COLORS = ['#e8b04b', '#4fb3a5', '#7aa2f7', '#e5534b', '#b48ead', '#8fbc5a'];
const MODE_STORAGE: Record<Mode, string> = {
  major: '',
  minor: 'm',
  dorian: ' dorian',
  phrygian: ' phrygian',
  lydian: ' lydian',
  mixolydian: ' mixolydian',
  locrian: ' locrian',
};

function keyToText(key: KeyInfo): string {
  const flats = key.mode === 'major' ? [1, 3, 5, 8, 10].includes(key.tonic) : [3, 5, 10].includes(key.tonic);
  return `${pitchName(key.tonic, flats)}${MODE_STORAGE[key.mode]}`;
}

type RangeChoice = 'all' | 'loop';

function barsFor(choice: RangeChoice, controller: PlayerController, timeline: Timeline | null, range: PlaybackRange | null): [number, number] {
  const total = controller.score?.masterBars.length ?? 0;
  if (choice === 'loop' && range && timeline) {
    const a = timeline.barAtTick(range.startTick);
    const b = timeline.barAtTick(Math.max(range.startTick, range.endTick - 1));
    if (a && b) return [Math.min(a.barIndex, b.barIndex), Math.max(a.barIndex, b.barIndex)];
  }
  return [0, Math.max(0, total - 1)];
}

export function AnalysisPanel(props: AnalysisPanelProps) {
  const { controller, annotations, model, selection, editing, setEditing, layers, setLayers } = props;
  const [filter, setFilter] = useState<AnnotationKind | 'all'>('all');
  const [toolsOpen, setToolsOpen] = useState(false);
  const score = controller.score;

  const visible = useMemo(
    () => annotations.filter((a) => filter === 'all' || a.kind === filter).sort((a, b) => comparePositions(a, b) || a.id - b.id),
    [annotations, filter],
  );
  const chordById = useMemo(() => new Map(model.chords.map((c) => [c.annotation.id, c])), [model]);
  const tracks = score?.tracks ?? [];
  const selectionKey = selection ? model.keyAt(selection) : null;

  return (
    <div className="panel-body analysis-panel">
      <section className="panel-section">
        <div className="selection-row">
          {selection ? (
            <>
              <strong>{positionLabel(score, selection)}</strong>
              {selectionKey && <span className="muted small">in {formatKeyItalian(selectionKey)}</span>}
            </>
          ) : (
            <span className="muted">Clicca un punto dello spartito per aggiungere un'analisi</span>
          )}
        </div>
        <div className="add-buttons">
          {(['chord', 'section', 'key', 'note'] as AnnotationKind[]).map((kind) => (
            <button key={kind} disabled={!selection} onClick={() => selection && setEditing({ mode: 'new', kind, position: selection })}>
              <Icon name={KIND_ICONS[kind]} /> {KIND_LABELS[kind]}
              {kind === 'chord' && <kbd>A</kbd>}
              {kind === 'note' && <kbd>N</kbd>}
            </button>
          ))}
        </div>
      </section>

      {editing && (
        <AnnotationEditor
          key={editing.mode === 'edit' ? `e${editing.annotation.id}` : `n${editing.kind}${editing.position.barIndex}:${editing.position.position}`}
          controller={controller}
          model={model}
          editing={editing}
          onCancel={() => setEditing(null)}
          onSave={async (input) => {
            try {
              if (editing.mode === 'edit') await props.onUpdate(editing.annotation.id, input);
              else await props.onCreate(input);
              setEditing(null);
            } catch (err) {
              notifyError(err);
            }
          }}
          onDelete={
            editing.mode === 'edit'
              ? async () => {
                  await props.onDelete(editing.annotation.id);
                  setEditing(null);
                }
              : undefined
          }
        />
      )}

      <section className="panel-section">
        <h3>
          <Icon name="layers" /> Livelli
        </h3>
        <div className="layer-toggles">
          <label className="checkbox">
            <input type="checkbox" checked={layers.chords} onChange={(e) => setLayers({ ...layers, chords: e.target.checked })} /> Sigle
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={layers.analysis} onChange={(e) => setLayers({ ...layers, analysis: e.target.checked })} /> Gradi e
            funzioni
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={layers.sections} onChange={(e) => setLayers({ ...layers, sections: e.target.checked })} /> Sezioni,
            tonalità, appunti
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={layers.intervals} onChange={(e) => setLayers({ ...layers, intervals: e.target.checked })} />{' '}
            Intervalli della melodia sull'accordo
          </label>
          {layers.intervals && (
            <select
              value={layers.intervalTrack ?? ''}
              onChange={(e) => setLayers({ ...layers, intervalTrack: e.target.value === '' ? null : Number(e.target.value) })}
            >
              {tracks.map((t) => (
                <option key={t.index} value={t.index}>
                  {t.name || `Traccia ${t.index + 1}`}
                  {controller.api.tracks.some((x) => x.index === t.index) ? '' : ' (non visualizzata)'}
                </option>
              ))}
            </select>
          )}
        </div>
        <Legend />
      </section>

      <section className="panel-section">
        <button className="section-toggle" onClick={() => setToolsOpen((v) => !v)}>
          <Icon name={toolsOpen ? 'chevronDown' : 'chevronRight'} /> <Icon name="sparkles" /> Strumenti di analisi
        </button>
        {toolsOpen && <AnalysisTools {...props} />}
      </section>

      <section className="panel-section">
        <div className="section-title-row">
          <h3>
            <Icon name="note" /> Analisi ({annotations.length})
          </h3>
          <select className="compact" value={filter} onChange={(e) => setFilter(e.target.value as AnnotationKind | 'all')}>
            <option value="all">tutte</option>
            <option value="chord">accordi</option>
            <option value="section">sezioni</option>
            <option value="key">tonalità</option>
            <option value="note">appunti</option>
          </select>
        </div>
        {visible.length === 0 && <p className="muted small">Ancora nessuna analisi.</p>}
        <ul className="annotation-list">
          {visible.map((a) => (
            <AnnotationRow
              key={a.id}
              annotation={a}
              chord={chordById.get(a.id) ?? null}
              label={positionLabel(score, a)}
              active={editing?.mode === 'edit' && editing.annotation.id === a.id}
              onSeek={() => props.onSeek(a)}
              onEdit={() => setEditing({ mode: 'edit', annotation: a })}
              onDelete={() => void props.onDelete(a.id)}
            />
          ))}
        </ul>
      </section>
    </div>
  );
}

function Legend() {
  const items: Array<[string, string]> = [
    ['diatonic', 'diatonico'],
    ['secondary', 'dominante secondaria'],
    ['substitute', 'SubV (tritono)'],
    ['related-ii', 'ii correlato'],
    ['backdoor', 'backdoor'],
    ['interchange', 'interscambio modale'],
    ['passing', 'diminuito di passaggio'],
    ['chromatic', 'cromatico'],
  ];
  return (
    <div className="legend">
      {items.map(([cat, label]) => (
        <span key={cat} className={`legend-item cat-${cat}`}>
          {label}
        </span>
      ))}
      <span className="legend-sep" />
      <span className="legend-item fn-chord">nota dell'accordo</span>
      <span className="legend-item fn-tension">tensione</span>
      <span className="legend-item fn-avoid">nota da evitare</span>
      <span className="legend-item fn-outside">cromatica</span>
    </div>
  );
}

function AnnotationRow({
  annotation,
  chord,
  label,
  active,
  onSeek,
  onEdit,
  onDelete,
}: {
  annotation: Annotation;
  chord: AnalyzedChord | null;
  label: string;
  active: boolean;
  onSeek: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const key = annotation.kind === 'key' ? parseKey(annotation.text) : null;
  return (
    <li className={`annotation-row kind-${annotation.kind}${active ? ' active' : ''}`}>
      <button className="annotation-main" onClick={onSeek} title="Vai a questo punto">
        <span className="annotation-pos">{label}</span>
        <span className="annotation-content">
          {annotation.kind === 'chord' ? (
            <>
              <strong>{prettyAccidentals(annotation.text)}</strong>
              {chord?.roman && <span className={`roman cat-${annotation.analysis ? 'manual' : (chord.analysis?.category ?? 'none')}`}>{chord.roman}</span>}
              {chord?.analysis?.func && <span className="func">{chord.analysis.func}</span>}
              {chord?.analysis?.scale && <span className="scale muted small">{chord.analysis.scale}</span>}
              {chord?.analysis && chord.analysis.category !== 'diatonic' && (
                <span className="muted small">
                  {CATEGORY_LABELS[chord.analysis.category]}
                  {chord.analysis.borrowedFrom ? ` (da ${MODE_LABELS[chord.analysis.borrowedFrom]})` : ''}
                </span>
              )}
            </>
          ) : annotation.kind === 'key' ? (
            <strong>{key ? formatKeyItalian(key) : annotation.text}</strong>
          ) : (
            <span style={annotation.color ? { borderLeftColor: annotation.color } : undefined} className="annotation-text">
              {annotation.text}
            </span>
          )}
        </span>
      </button>
      <button className="icon-button" title="Modifica" onClick={onEdit}>
        <Icon name="edit" size={15} />
      </button>
      <button className="icon-button" title="Elimina" onClick={onDelete}>
        <Icon name="trash" size={15} />
      </button>
    </li>
  );
}

function AnnotationEditor({
  controller,
  model,
  editing,
  onSave,
  onCancel,
  onDelete,
}: {
  controller: PlayerController;
  model: AnalysisModel;
  editing: EditingState;
  onSave: (input: AnnotationInput) => Promise<void>;
  onCancel: () => void;
  onDelete?: () => Promise<void>;
}) {
  const kind = editing.mode === 'new' ? editing.kind : editing.annotation.kind;
  const position: ScorePosition =
    editing.mode === 'new' ? editing.position : { barIndex: editing.annotation.barIndex, position: editing.annotation.position };
  const initial = editing.mode === 'edit' ? editing.annotation : null;
  const [text, setText] = useState(initial?.text ?? '');
  const [analysis, setAnalysis] = useState(initial?.analysis ?? '');
  const [color, setColor] = useState<string | null>(initial?.color ?? null);
  const initialKey = kind === 'key' ? (parseKey(initial?.text ?? '') ?? model.keyAt(position)) : null;
  const [keyTonic, setKeyTonic] = useState(initialKey?.tonic ?? 0);
  const [keyMode, setKeyMode] = useState<Mode>(initialKey?.mode ?? 'major');
  const [busy, setBusy] = useState(false);
  const score = controller.score;
  const flats = model.flatsAt(position);

  // Finestra delle note: dal punto scelto fino al prossimo accordo nella stessa battuta.
  const windowEnd = useMemo(() => {
    const next = model.chords.find(
      (c) => c.annotation.barIndex === position.barIndex && c.annotation.position > position.position + 1e-6 && c.annotation.id !== initial?.id,
    );
    return next ? next.annotation.position : 1;
  }, [model, position.barIndex, position.position, initial?.id]);

  const suggestions = useMemo(() => {
    if (kind !== 'chord' || !score) return [];
    return detectChords(collectNotes(score, position.barIndex, position.position, windowEnd), flats, 5);
  }, [kind, score, position.barIndex, position.position, windowEnd, flats]);

  useEffect(() => {
    if (kind === 'chord' && !initial && suggestions[0] && text === '') setText(suggestions[0].symbol);
    // solo alla prima proposta
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestions]);

  const preview = useMemo(() => {
    if (kind !== 'chord' || !text.trim()) return null;
    const following = model.chords.filter((c) => comparePositions(c.annotation, position) > 0 && c.annotation.id !== initial?.id).slice(0, 2);
    const items = [{ symbol: text, key: model.keyAt(position) }, ...following.map((c) => ({ symbol: c.annotation.text, key: c.key }))];
    return analyzeProgression(items)[0];
  }, [kind, text, model, position, initial?.id]);

  const voicing = useMemo(() => {
    if (kind !== 'chord' || !score) return null;
    const parsed = parseChord(text);
    if (!parsed) return null;
    const notes = collectNotes(score, position.barIndex, position.position, Math.min(windowEnd, position.position + 0.02));
    if (notes.length === 0) return null;
    return describeVoicing(
      notes.map((n) => n.midi),
      parsed,
      flats,
    );
  }, [kind, score, text, position, windowEnd, flats]);

  const keySuggestions = useMemo(() => {
    if (kind !== 'key' || !score) return [];
    const to = Math.min(score.masterBars.length - 1, position.barIndex + 15);
    return estimateKeys(pitchHistogram(score, position.barIndex, to), 3);
  }, [kind, score, position.barIndex]);

  const save = async () => {
    const value = kind === 'key' ? keyToText({ tonic: keyTonic, mode: keyMode }) : text.trim();
    if (!value) return;
    if (kind === 'chord' && !parseChord(value)) {
      notify('Sigla non riconosciuta: la salvo comunque, ma senza analisi automatica', 'info');
    }
    setBusy(true);
    await onSave({
      barIndex: position.barIndex,
      position: position.position,
      kind,
      text: value,
      analysis: kind === 'chord' ? analysis.trim() || null : null,
      color,
    });
    setBusy(false);
  };

  return (
    <section className="panel-section editor">
      <div className="section-title-row">
        <h3>
          <Icon name={KIND_ICONS[kind]} /> {editing.mode === 'new' ? 'Nuovo' : 'Modifica'}: {KIND_LABELS[kind].toLowerCase()}
        </h3>
        <span className="muted small">{positionLabel(score, position)}</span>
      </div>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {kind === 'chord' && (
          <>
            <label>
              Sigla
              <input autoFocus value={text} placeholder="es. Dm9, G13(b9), Cmaj7#11, F/G" onChange={(e) => setText(e.target.value)} />
            </label>
            {suggestions.length > 0 && (
              <div className="chips" aria-label="Accordi riconosciuti dalle note">
                <span className="muted small">Dalle note:</span>
                {suggestions.map((s) => (
                  <button type="button" key={s.symbol} className={`chip${s.symbol === text ? ' active' : ''}`} onClick={() => setText(s.symbol)}>
                    {prettyAccidentals(s.symbol)}
                  </button>
                ))}
              </div>
            )}
            {voicing && <p className="small voicing">Voicing: {voicing}</p>}
            {preview && (
              <div className="analysis-preview">
                <span className={`roman big cat-${preview.category}`}>{preview.roman}</span>
                <span>
                  {CATEGORY_LABELS[preview.category]}
                  {preview.borrowedFrom ? ` (da ${MODE_LABELS[preview.borrowedFrom]})` : ''}
                  {preview.func ? ` · funzione ${preview.func}` : ''}
                </span>
                {preview.scale && <span className="muted">Scala: {preview.scale}</span>}
                <span className="muted small">in {formatKeyItalian(model.keyAt(position))}</span>
              </div>
            )}
            <label>
              Analisi personalizzata (facoltativa)
              <input value={analysis} placeholder={preview?.roman ?? 'es. V7/ii, SubV7, IVmaj7'} onChange={(e) => setAnalysis(e.target.value)} />
            </label>
          </>
        )}
        {kind === 'section' && (
          <>
            <label>
              Nome della sezione
              <input autoFocus value={text} onChange={(e) => setText(e.target.value)} />
            </label>
            <div className="chips">
              {SECTION_PRESETS.map((p) => (
                <button type="button" key={p} className={`chip${p === text ? ' active' : ''}`} onClick={() => setText(p)}>
                  {p}
                </button>
              ))}
            </div>
          </>
        )}
        {kind === 'key' && (
          <>
            <div className="form-grid">
              <label>
                Tonica
                <select value={keyTonic} onChange={(e) => setKeyTonic(Number(e.target.value))}>
                  {Array.from({ length: 12 }, (_, pc) => (
                    <option key={pc} value={pc}>
                      {pitchName(pc, false)}
                      {pitchName(pc, true) !== pitchName(pc, false) ? ` / ${pitchName(pc, true)}` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Modo
                <select value={keyMode} onChange={(e) => setKeyMode(e.target.value as Mode)}>
                  {MODES.map((m) => (
                    <option key={m} value={m}>
                      {MODE_LABELS[m]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="small">
              Da qui in poi: <strong>{formatKeyItalian({ tonic: keyTonic, mode: keyMode })}</strong>
            </p>
            {keySuggestions.length > 0 && (
              <div className="chips">
                <span className="muted small">Stima dalle note:</span>
                {keySuggestions.map((k) => (
                  <button
                    type="button"
                    key={`${k.tonic}${k.mode}`}
                    className="chip"
                    onClick={() => {
                      setKeyTonic(k.tonic);
                      setKeyMode(k.mode);
                    }}
                  >
                    {formatKey(k)} <span className="muted">{Math.round(k.score * 100)}%</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        {kind === 'note' && (
          <label>
            Appunto
            <textarea autoFocus rows={4} value={text} placeholder="es. linea cromatica verso la 3 di G7, pedale di La…" onChange={(e) => setText(e.target.value)} />
          </label>
        )}
        {(kind === 'section' || kind === 'note') && (
          <div className="chips">
            <span className="muted small">Colore:</span>
            {COLORS.map((c) => (
              <button
                type="button"
                key={c}
                className={`swatch${color === c ? ' active' : ''}`}
                style={{ background: c }}
                onClick={() => setColor(color === c ? null : c)}
                aria-label={`Colore ${c}`}
              />
            ))}
          </div>
        )}
        <div className="field-row">
          {onDelete && (
            <button type="button" className="danger-link" onClick={() => void onDelete()}>
              <Icon name="trash" size={15} /> Elimina
            </button>
          )}
          <span className="spacer" />
          <button type="button" onClick={onCancel}>
            Annulla
          </button>
          <button className="primary" type="submit" disabled={busy || (kind !== 'key' && !text.trim())}>
            Salva
          </button>
        </div>
      </form>
    </section>
  );
}

function AnalysisTools({ controller, timeline, range, annotations, model, onCreateMany, onDeleteKind }: AnalysisPanelProps) {
  const score = controller.score;
  const [granularity, setGranularity] = useState<'bar' | 'half' | 'beat'>('half');
  const [scope, setScope] = useState<RangeChoice>('all');
  const [busy, setBusy] = useState(false);
  const [keyScope, setKeyScope] = useState<RangeChoice>('all');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const embedded = useMemo(() => (score ? scoreChordNames(score) : []), [score]);

  const keyEstimate = useMemo(() => {
    if (!score) return [];
    const [from, to] = barsFor(keyScope, controller, timeline, range);
    return estimateKeys(pitchHistogram(score, from, to), 3).map((k) => ({ ...k, from }));
  }, [score, keyScope, controller, timeline, range]);

  if (!score) return null;
  const hasChordAt = (pos: ScorePosition, to = pos.position + 1e-6) =>
    annotations.some((a) => a.kind === 'chord' && a.barIndex === pos.barIndex && a.position >= pos.position - 1e-6 && a.position < to);

  const importEmbedded = async () => {
    const inputs = embedded
      .filter((c) => !hasChordAt(c))
      .map((c) => ({ barIndex: c.barIndex, position: c.position, kind: 'chord' as const, text: c.name }));
    if (inputs.length === 0) {
      notify('Le sigle dello spartito sono già tutte presenti');
      return;
    }
    setBusy(true);
    try {
      const n = await onCreateMany(inputs);
      notify(`${n} sigle importate dallo spartito`, 'success');
    } finally {
      setBusy(false);
    }
  };

  const detect = async () => {
    const [from, to] = barsFor(scope, controller, timeline, range);
    const inputs: AnnotationInput[] = [];
    let previous = '';
    for (const slot of detectionSlots(score, granularity, from, to)) {
      const notes = collectNotes(score, slot.barIndex, slot.position, slot.to);
      if (notes.length === 0) continue;
      if (hasChordAt(slot, slot.to)) {
        previous = '';
        continue;
      }
      const best = detectChords(notes, model.flatsAt(slot), 1)[0];
      if (!best || best.symbol === previous) continue;
      previous = best.symbol;
      inputs.push({ barIndex: slot.barIndex, position: slot.position, kind: 'chord', text: best.symbol });
    }
    if (inputs.length === 0) {
      notify('Nessun nuovo accordo da aggiungere');
      return;
    }
    setBusy(true);
    try {
      const n = await onCreateMany(inputs);
      notify(`${n} accordi rilevati: controllali e correggili dove serve`, 'success', 6000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tools">
      <div className="tool">
        <h4>Sigle presenti nel file</h4>
        {embedded.length > 0 ? (
          <button onClick={importEmbedded} disabled={busy}>
            Importa {embedded.length} sigle dallo spartito
          </button>
        ) : (
          <p className="muted small">Il file non contiene sigle d'accordo.</p>
        )}
      </div>
      <div className="tool">
        <h4>Riconosci gli accordi dalle note</h4>
        <div className="field-row">
          <select value={granularity} onChange={(e) => setGranularity(e.target.value as 'bar' | 'half' | 'beat')}>
            <option value="bar">uno per battuta</option>
            <option value="half">ogni mezza battuta</option>
            <option value="beat">ogni movimento</option>
          </select>
          <select value={scope} onChange={(e) => setScope(e.target.value as RangeChoice)}>
            <option value="all">tutto il brano</option>
            <option value="loop" disabled={!range}>
              solo il loop A-B
            </option>
          </select>
          <button onClick={detect} disabled={busy}>
            Rileva
          </button>
        </div>
        <p className="muted small">
          Usa le note di tutte le tracce (basso compreso) e salta i punti in cui hai già scritto una sigla. Con voicing senza
          fondamentale o linee molto cromatiche i risultati vanno rivisti.
        </p>
      </div>
      <div className="tool">
        <h4>Stima della tonalità</h4>
        <div className="field-row">
          <select value={keyScope} onChange={(e) => setKeyScope(e.target.value as RangeChoice)}>
            <option value="all">tutto il brano</option>
            <option value="loop" disabled={!range}>
              solo il loop A-B
            </option>
          </select>
        </div>
        <div className="chips">
          {keyEstimate.map((k) => (
            <button
              key={`${k.tonic}${k.mode}`}
              className="chip"
              title="Aggiungi come tonalità all'inizio dell'intervallo"
              onClick={async () => {
                await onCreateMany([{ barIndex: k.from, position: 0, kind: 'key', text: keyToText(k) }]);
                notify(`Tonalità ${formatKeyItalian(k)} da battuta ${k.from + 1}`, 'success');
              }}
            >
              {formatKeyItalian(k)} <span className="muted">{Math.round(k.score * 100)}%</span>
            </button>
          ))}
        </div>
        <p className="muted small">
          Stima statistica (profili di Krumhansl) su maggiore/minore: per i modi (dorico, misolidio, lidio…) imposta la tonalità a
          mano.
        </p>
      </div>
      <div className="tool">
        <button className="danger-link" onClick={() => setConfirmDelete(true)} disabled={!annotations.some((a) => a.kind === 'chord')}>
          Elimina tutte le sigle
        </button>
      </div>
      {confirmDelete && (
        <ConfirmDialog
          title="Eliminare tutte le sigle?"
          message="Verranno eliminati tutti gli accordi e le analisi personalizzate di questo spartito (sezioni, tonalità e appunti restano)."
          confirmLabel="Elimina"
          danger
          onClose={() => setConfirmDelete(false)}
          onConfirm={() => onDeleteKind('chord')}
        />
      )}
    </div>
  );
}
