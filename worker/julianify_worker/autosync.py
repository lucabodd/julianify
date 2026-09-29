"""Allineamento automatico spartito-registrazione (Sync Toolbox, MrMsDTW).

Il client manda le note dello spartito in secondi al tempo scritto (ripetizioni
già srotolate) e i punti da collocare (inizi di battuta o di movimento). Dalle
note si ricavano feature chroma e di attacco dello stesso tipo di quelle
estratte dalla registrazione; il DTW multi-scala le allinea e i punti vengono
proiettati sul tempo reale dell'esecuzione.
"""

import math

import numpy as np

from .audio import decode
from .protocol import WorkerError

SAMPLE_RATE = 22050
FEATURE_RATE = 50
STEP_WEIGHTS = np.array([1.5, 1.5, 2.0])
THRESHOLD_REC = 10 ** 6
MAX_NOTES = 200_000
MAX_TARGETS = 20_000
MIN_ANCHOR_GAP = 2.0  # secondi tra due ancore e dagli estremi
CONFIDENCE_WINDOW = 1.0  # secondi di spartito attorno a ogni punto
LOW_CONFIDENCE = 0.45  # somiglianza chroma sotto cui un punto è sospetto
SUSPICIOUS_JUMP = 1.6  # variazione del tempo locale attraverso un punto (zig-zag)
REFINE_WINDOW = 0.08  # secondi di ricerca dell'attacco attorno alla stima del DTW
REFINE_OFFSET = 0.025  # il DTW tende ad anticipare: la ricerca è centrata un po' dopo
REFINE_PROMINENCE = 2.0  # l'attacco deve superare di tanto il livello del contesto
ONSET_EDGE_THRESHOLD = 0.2  # attacco "netto": frazione dei più forti del brano
ONSET_TAIL = 3.0  # secondi di risonanza lasciati dopo l'ultimo attacco
EDGE_TOLERANCE = 0.05  # un'ancora entro questi secondi dagli estremi fissa l'estremo
ANCHOR_MARGIN = 2.0  # oltre le ancore estreme si analizza al massimo il doppio del previsto


def _finite(value, name):
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise WorkerError(f'Valore non valido: {name}.') from None
    if not math.isfinite(number):
        raise WorkerError(f'Valore non valido: {name}.')
    return number


def notes_frame(notes):
    """DataFrame nel formato di Sync Toolbox; le altezze fuori dal pianoforte
    vengono spostate d'ottava (conta solo la classe di altezza)."""
    import pandas as pd

    rows = []
    for note in notes:
        if not isinstance(note, (list, tuple)) or len(note) < 3:
            continue
        try:
            start, duration, pitch = float(note[0]), float(note[1]), int(round(float(note[2])))
            velocity = float(note[3]) if len(note) > 3 else 80.0
        except (TypeError, ValueError):
            continue
        if not (math.isfinite(start) and math.isfinite(duration) and math.isfinite(velocity)):
            continue
        if start < 0 or duration <= 0 or not 0 <= pitch <= 127:
            continue
        while pitch < 21:
            pitch += 12
        while pitch > 108:
            pitch -= 12
        rows.append((start, max(duration, 0.03), pitch, min(127.0, max(1.0, velocity)), 'pitched'))
    if not rows:
        raise WorkerError('Lo spartito non contiene note utilizzabili per l\'allineamento.')
    rows.sort()
    return pd.DataFrame(rows, columns=['start', 'duration', 'pitch', 'velocity', 'instrument'])


def clean_anchors(raw, audio_seconds, score_seconds):
    """Coppie (secondi audio, secondi spartito) crescenti e ben distanziate."""
    pairs = []
    last_audio, last_score = 0.0, 0.0
    for pair in sorted(raw or [], key=lambda p: (p[1], p[0])):
        audio_t, score_t = float(pair[0]), float(pair[1])
        if not (math.isfinite(audio_t) and math.isfinite(score_t)):
            continue
        if audio_t > audio_seconds - MIN_ANCHOR_GAP or score_t > score_seconds - MIN_ANCHOR_GAP:
            continue
        if audio_t - last_audio < MIN_ANCHOR_GAP or score_t - last_score < MIN_ANCHOR_GAP:
            continue
        pairs.append((audio_t, score_t))
        last_audio, last_score = audio_t, score_t
    return pairs


def _anchor_ratio(ordered):
    """Rapporto mediano tempo audio / tempo spartito tra ancore consecutive."""
    ratios = [(a2 - a1) / (s2 - s1) for (a1, s1), (a2, s2) in zip(ordered, ordered[1:]) if s2 - s1 > 0.5 and a2 > a1]
    return min(2.0, max(0.5, float(np.median(ratios)))) if ratios else 1.0


def _pad(features, length):
    if features.shape[1] >= length:
        return features
    return np.pad(features, ((0, 0), (0, length - features.shape[1])))


def _chroma_features(f_pitch):
    from synctoolbox.feature.chroma import pitch_to_chroma, quantize_chroma
    return quantize_chroma(f_chroma=pitch_to_chroma(f_pitch=f_pitch))


def _dlnco(f_peaks, length):
    from synctoolbox.feature.dlnco import pitch_onset_features_to_DLNCO
    return pitch_onset_features_to_DLNCO(f_peaks=f_peaks, feature_rate=FEATURE_RATE,
                                         feature_sequence_length=length, visualize=False)


def _cens(f_chroma):
    from synctoolbox.feature.chroma import quantized_chroma_to_CENS
    return quantized_chroma_to_CENS(f_chroma, 201, 50, FEATURE_RATE)[0]


def _unit_columns(features):
    norms = np.linalg.norm(features, axis=0)
    return features / np.where(norms > 1e-9, norms, 1.0)


def confidence_along_path(f_audio, f_score, path, target_frames):
    """Somiglianza media (0..1) tra audio e spartito lungo il percorso vicino a ogni punto."""
    audio_unit = _unit_columns(f_audio)
    score_unit = _unit_columns(f_score)
    a_idx = np.clip(np.rint(path[0]).astype(int), 0, f_audio.shape[1] - 1)
    s_idx = np.clip(np.rint(path[1]).astype(int), 0, f_score.shape[1] - 1)
    similarity = np.einsum('ij,ij->j', audio_unit[:, a_idx], score_unit[:, s_idx])
    # i tratti muti (entrambi silenziosi) non dicono nulla: non contano
    active = (np.linalg.norm(f_audio[:, a_idx], axis=0) > 1e-9) & (np.linalg.norm(f_score[:, s_idx], axis=0) > 1e-9)
    half = CONFIDENCE_WINDOW * FEATURE_RATE
    result = []
    for frame in target_frames:
        lo = np.searchsorted(path[1], frame - half)
        hi = np.searchsorted(path[1], frame + half, side='right')
        window = active[lo:hi]
        result.append(float(similarity[lo:hi][window].mean()) if window.any() else None)
    return result


def suspicious_targets(score_times, audio_times, confidence):
    """Punti probabilmente sbagliati: il tempo locale cambia di colpo attorno al
    punto e poi torna com'era (zig-zag), oppure audio e spartito si somigliano poco."""
    score_times = np.asarray(score_times, dtype=float)
    audio_times = np.asarray(audio_times, dtype=float)
    flagged = {i for i, c in enumerate(confidence) if c is not None and c < LOW_CONFIDENCE}
    ds = np.diff(score_times)
    da = np.diff(audio_times)
    for i in range(1, len(score_times) - 1):
        if ds[i - 1] <= 1e-6 or ds[i] <= 1e-6:
            continue
        before = da[i - 1] / ds[i - 1]
        after = da[i] / ds[i]
        if before <= 1e-3 or after <= 1e-3 or abs(math.log(before / after)) > math.log(SUSPICIOUS_JUMP):
            flagged.add(i)
    return sorted(flagged)


def onset_envelope(audio, hop):
    """Flusso spettrale (librosa) allineato ad `audio`, un valore ogni `hop` campioni.

    L'audio viene prolungato all'indietro con la sua immagine speculare: così
    l'inizio del file (rumore di fondo che "parte" dal nulla) non sembra un attacco."""
    import librosa

    pad = min(audio.size, (SAMPLE_RATE // 2 // hop) * hop)
    padded = np.concatenate([audio[:pad][::-1], audio]) if pad else audio
    envelope = librosa.onset.onset_strength(y=padded, sr=SAMPLE_RATE, hop_length=hop)
    return envelope[pad // hop:]


def active_range(audio, threshold_db=-40.0):
    """Porzione con la musica: [primo campione, ultimo campione).

    Prima si scarta il silenzio (energia sotto `threshold_db` rispetto alle parti
    forti), poi il rumore stazionario (fruscio, brusio, sala) ai due estremi,
    riconoscibile perché non ha attacchi: la musica comincia al primo attacco
    netto e finisce qualche secondo dopo l'ultimo."""
    hop = SAMPLE_RATE // 50
    frames = audio.size // hop
    if frames < 2:
        return 0, audio.size
    rms = np.sqrt(np.mean(audio[:frames * hop].reshape(frames, hop) ** 2, axis=1))
    loud = float(np.percentile(rms, 99))
    if loud <= 1e-6:
        raise WorkerError('La porzione di registrazione scelta è silenziosa.')
    active = np.flatnonzero(rms > loud * 10 ** (threshold_db / 20))
    first = max(0, int(active[0]) * hop - SAMPLE_RATE // 20)
    last = min(audio.size, (int(active[-1]) + 1) * hop + SAMPLE_RATE // 5)

    hop = 512
    envelope = onset_envelope(audio[first:last], hop)
    threshold = max(ONSET_EDGE_THRESHOLD * float(np.percentile(envelope, 99.5)), 3.0 * float(np.median(envelope)))
    strong = np.flatnonzero(envelope > threshold)
    if strong.size == 0:
        return first, last

    def stationary(part):
        # rumore di fondo: nessun picco che spicchi (un'intro suonata piano invece sì)
        return part.size < 3 or float(part.max()) < 2.5 * max(float(np.median(part)), 1e-3)

    origin = first
    if stationary(envelope[:max(0, int(strong[0]) - 2)]):
        first = max(origin, origin + int(strong[0]) * hop - int(0.08 * SAMPLE_RATE))
    tail = int(strong[-1]) + int(ONSET_TAIL * SAMPLE_RATE / hop)
    if tail < envelope.size and stationary(envelope[tail:]):
        last = max(first + SAMPLE_RATE, min(last, origin + tail * hop))
    return first, last


def onset_targets(frame, targets, tolerance=0.015):
    """Per ogni punto: lo spartito ha un attacco proprio lì?"""
    starts = np.sort(frame['start'].to_numpy())
    result = []
    for t in targets:
        i = np.searchsorted(starts, t - tolerance)
        result.append(bool(i < starts.size and starts[i] <= t + tolerance))
    return result


class OnsetFinder:
    """Attacchi nella registrazione (flusso spettrale), per rifinire i punti del DTW."""

    HOP = 128

    def __init__(self, audio):
        self.envelope = onset_envelope(audio, self.HOP)
        self.step = self.HOP / SAMPLE_RATE

    def snap(self, t, window=None):
        """Inizio dell'attacco netto più vicino a `t` (secondi), oppure None.

        Il punto restituito è il minimo di energia che precede il picco:
        leggermente in anticipo, così un loop che parte lì non taglia l'attacco."""
        env, step = self.envelope, self.step
        window = window or REFINE_WINDOW
        t = t + REFINE_OFFSET
        centre = int(round(t / step))
        half = int(window / step)
        lo, hi = max(0, centre - half), min(env.size, centre + half + 1)
        if hi - lo < 3:
            return None
        offsets = np.arange(lo, hi) * step - t
        k = lo + int(np.argmax(env[lo:hi] * np.exp(-0.5 * (offsets / (window / 2)) ** 2)))
        if k == lo and lo > 0 and env[lo - 1] > env[lo]:
            return None  # il picco è prima della finestra
        limit = min(env.size - 1, k + int(0.03 / step))
        while k < limit and env[k + 1] > env[k]:
            k += 1
        context = int(1.0 / step)
        background = float(np.median(env[max(0, centre - context):centre + context + 1]))
        if env[k] <= REFINE_PROMINENCE * max(background, 1e-6):
            return None
        limit = max(0, k - int(0.04 / step))
        while k > limit and env[k - 1] < env[k]:
            k -= 1
        return k * step


def refine_on_onsets(finder, times, has_onset):
    """Aggancia agli attacchi i punti in cui lo spartito ha una nota. `times` in secondi."""
    refined = list(times)
    moved = 0
    for i, (t, onset) in enumerate(zip(times, has_onset)):
        snapped = finder.snap(t) if onset else None
        if snapped is not None:
            refined[i] = snapped
            moved += 1
    for i in range(1, len(refined)):  # l'ordine non deve mai invertirsi
        if refined[i] <= refined[i - 1]:
            refined[i] = max(times[i], refined[i - 1] + 0.001)
    return refined, moved


def autosync(params, protocol):
    from synctoolbox.dtw.mrmsdtw import sync_via_mrmsdtw_with_anchors
    from synctoolbox.dtw.utils import compute_optimal_chroma_shift, make_path_strictly_monotonic, shift_chroma_vectors
    from synctoolbox.feature.csv_tools import df_to_pitch_features, df_to_pitch_onset_features
    from synctoolbox.feature.pitch import audio_to_pitch_features
    from synctoolbox.feature.pitch_onset import audio_to_pitch_onset_features
    from synctoolbox.feature.utils import estimate_tuning

    path = params.get('audio')
    notes = params.get('notes') or []
    targets = [_finite(t, 'targets') for t in params.get('targets') or []]
    if not path:
        raise WorkerError('Parametro mancante: audio.')
    if len(notes) > MAX_NOTES or not targets or len(targets) > MAX_TARGETS:
        raise WorkerError('Numero di note o di punti non valido.')
    if any(b < a for a, b in zip(targets, targets[1:])) or targets[0] < 0:
        raise WorkerError('I punti da sincronizzare devono essere in ordine crescente.')
    frame = notes_frame(notes)
    score_seconds = max(_finite(params.get('scoreDuration', 0), 'scoreDuration'), targets[-1],
                        float((frame['start'] + frame['duration']).max()))
    anchors = []
    for pair in params.get('anchors') or []:
        if isinstance(pair, (list, tuple)) and len(pair) == 2:
            anchors.append((_finite(pair[0], 'anchors') / 1000, _finite(pair[1], 'anchors')))

    protocol.progress(0.01, 'Decodifica dell\'audio…', force=True)
    audio = decode(path, SAMPLE_RATE, 1)[0]
    total_seconds = audio.size / SAMPLE_RATE
    start = min(max(0.0, _finite(params.get('audioStartMs') or 0, 'audioStartMs') / 1000), total_seconds)
    end_ms = params.get('audioEndMs')
    end = total_seconds if end_ms is None else min(total_seconds, _finite(end_ms, 'audioEndMs') / 1000)
    # un sync point sull'inizio (o sulla fine) del tratto ne fissa l'istante nella registrazione
    start_fixed = end_fixed = False
    for audio_t, score_t in anchors:
        if score_t <= EDGE_TOLERANCE and 0 <= audio_t < total_seconds:
            start, start_fixed = audio_t, True
        elif score_t >= score_seconds - EDGE_TOLERANCE and 0 < audio_t <= total_seconds:
            end, end_fixed = audio_t, True
    # senza ancore agli estremi, i sync point esistenti delimitano comunque la
    # porzione utile (spartito che copre solo una parte della registrazione)
    if anchors:
        ordered = sorted(anchors, key=lambda p: p[1])
        ratio = _anchor_ratio(ordered)
        first_audio, first_score = ordered[0]
        last_audio, last_score = ordered[-1]
        if not start_fixed:
            start = max(start, first_audio - first_score * ratio * ANCHOR_MARGIN - 2.0)
        if not end_fixed:
            end = min(end, last_audio + (score_seconds - last_score) * ratio * ANCHOR_MARGIN + 2.0)
    if end - start < 3:
        raise WorkerError('La porzione di registrazione da analizzare è troppo corta.')
    # il silenzio all'inizio e alla fine confonderebbe gli estremi dell'allineamento
    first, last = active_range(audio[int(start * SAMPLE_RATE):int(end * SAMPLE_RATE)])
    segment_start = start
    if not start_fixed:
        start = segment_start + first / SAMPLE_RATE
    if not end_fixed:
        end = segment_start + last / SAMPLE_RATE
    segment = audio[int(start * SAMPLE_RATE):int(end * SAMPLE_RATE)]
    audio_seconds = segment.size / SAMPLE_RATE
    if audio_seconds < 3:
        raise WorkerError('La porzione di registrazione da analizzare è troppo corta.')
    if not 0.2 <= audio_seconds / score_seconds <= 5:
        raise WorkerError('La durata della registrazione è troppo diversa da quella dello spartito: '
                          'controlla la porzione di audio e le battute scelte.')

    protocol.progress(0.04, 'Stima dell\'accordatura…', force=True)
    tuning = int(estimate_tuning(segment, SAMPLE_RATE))

    protocol.progress(0.08, 'Analisi armonica della registrazione…', force=True)
    f_chroma_audio = _chroma_features(audio_to_pitch_features(
        f_audio=segment, Fs=SAMPLE_RATE, tuning_offset=tuning, feature_rate=FEATURE_RATE, verbose=False))
    protocol.progress(0.45, 'Analisi degli attacchi…', force=True)
    f_onset_audio = _dlnco(audio_to_pitch_onset_features(
        f_audio=segment, Fs=SAMPLE_RATE, tuning_offset=tuning, verbose=False), f_chroma_audio.shape[1])

    protocol.progress(0.8, 'Analisi dello spartito…', force=True)
    score_frames = int(math.ceil(score_seconds * FEATURE_RATE)) + 1
    f_chroma_score = _chroma_features(_pad(df_to_pitch_features(frame, feature_rate=FEATURE_RATE), score_frames))
    f_onset_score = _dlnco(df_to_pitch_onset_features(frame), f_chroma_score.shape[1])

    # trasposizione globale (capotasto, registrazione in un'altra tonalità)
    shift = int(compute_optimal_chroma_shift(_cens(f_chroma_audio), _cens(f_chroma_score)))
    f_chroma_score = shift_chroma_vectors(f_chroma_score, shift)
    f_onset_score = shift_chroma_vectors(f_onset_score, shift)

    protocol.progress(0.88, 'Allineamento…', force=True)
    inner = clean_anchors([(a - start, s) for a, s in anchors], audio_seconds, score_seconds)
    wp = sync_via_mrmsdtw_with_anchors(
        f_chroma1=f_chroma_audio, f_onset1=f_onset_audio, f_chroma2=f_chroma_score, f_onset2=f_onset_score,
        input_feature_rate=FEATURE_RATE, step_weights=STEP_WEIGHTS, threshold_rec=THRESHOLD_REC,
        anchor_pairs=inner or None, verbose=False)
    wp = make_path_strictly_monotonic(wp)

    target_frames = np.asarray(targets) * FEATURE_RATE
    times = list(np.interp(target_frames, wp[1], wp[0]) / FEATURE_RATE)
    moved = 0
    if params.get('refine', True):
        protocol.progress(0.94, 'Rifinitura sugli attacchi…', force=True)
        times, moved = refine_on_onsets(OnsetFinder(segment), times, onset_targets(frame, targets))
    confidence = confidence_along_path(f_chroma_audio, f_chroma_score, wp, target_frames)
    absolute = [(start + t) * 1000 for t in times]
    # i punti che coincidono con un sync point dell'utente restano dove li ha messi lui
    for audio_t, score_t in anchors:
        i = int(np.argmin(np.abs(np.asarray(targets) - score_t)))
        if abs(targets[i] - score_t) < 0.005 and (i == 0 or absolute[i - 1] < audio_t * 1000) \
                and (i + 1 == len(absolute) or absolute[i + 1] > audio_t * 1000):
            absolute[i] = audio_t * 1000

    protocol.progress(1.0, 'Fatto', force=True)
    return {
        'times': [round(float(t), 1) for t in absolute],
        'confidence': [None if c is None else round(c, 3) for c in confidence],
        'quality': round(float(np.mean([c for c in confidence if c is not None])), 3) if any(
            c is not None for c in confidence) else None,
        'suspicious': suspicious_targets(targets, absolute, confidence),
        'refined': moved,
        'tuningCents': tuning,
        'transposition': shift if shift <= 6 else shift - 12,
        'anchorsUsed': len(inner) + int(start_fixed) + int(end_fixed),
        'audioStartMs': round(start * 1000, 1),
        'audioEndMs': round(end * 1000, 1),
        'audioDurationMs': round(total_seconds * 1000, 1),
    }
