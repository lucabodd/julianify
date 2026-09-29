"""Separazione degli strumenti con Demucs e mixaggio delle versioni richieste.

Il brano viene elaborato a blocchi di un minuto con qualche secondo di
sovrapposizione (dissolvenza incrociata), così la memoria resta limitata anche
per brani lunghi e ogni versione viene scritta in FLAC mentre si procede.
Le versioni hanno esattamente la durata dell'originale decodificato: i sync
point restano validi per tutte.
"""

import glob
import math
import os
import random

import numpy as np

from .audio import FlacWriter, decode, soft_limit
from .protocol import WorkerError

DEFAULT_MODEL = 'htdemucs_6s'
CHUNK_SECONDS = 60.0
OVERLAP_SECONDS = 4.0
SEGMENT_OVERLAP = 0.25


def cpu_threads():
    """CPU utilizzabili, rispettando affinità e quota del container."""
    env = os.environ.get('JULIANIFY_WORKER_THREADS', '')
    if env.isdigit() and int(env) > 0:
        return int(env)
    try:
        count = len(os.sched_getaffinity(0))
    except AttributeError:
        count = os.cpu_count() or 1
    try:
        with open('/sys/fs/cgroup/cpu.max', encoding='ascii') as f:
            quota, period = f.read().split()
        if quota != 'max':
            count = min(count, max(1, math.ceil(int(quota) / int(period))))
    except (OSError, ValueError):
        pass
    return max(1, count)


def pick_device(requested):
    import torch
    if requested in (None, '', 'auto'):
        return 'cuda' if torch.cuda.is_available() else 'cpu'
    if requested == 'cuda' and not torch.cuda.is_available():
        raise WorkerError('GPU CUDA non disponibile.')
    return requested


def _hf_cached(name):
    """Modello già nella cache di HuggingFace (senza importare huggingface_hub)."""
    from demucs.hf import DEFAULT_NAMESPACE, hf_repo_name
    home = os.environ.get('HF_HOME') or os.path.join(os.path.expanduser('~'), '.cache', 'huggingface')
    hub = os.environ.get('HF_HUB_CACHE') or os.path.join(home, 'hub')
    repo = f'models--{DEFAULT_NAMESPACE}--{hf_repo_name(name)}'
    return bool(glob.glob(os.path.join(hub, repo, 'snapshots', '*', f'{name}.yaml')))


def _legacy_cached(name):
    """Modello già nella cache di torch.hub (archivio storico di Demucs, usato se HuggingFace non risponde)."""
    import torch
    import yaml
    from demucs.pretrained import REMOTE_ROOT
    try:
        with open(REMOTE_ROOT / f'{name}.yaml', encoding='utf-8') as f:
            signatures = yaml.safe_load(f).get('models') or []
    except OSError:
        return False
    checkpoints = os.path.join(torch.hub.get_dir(), 'checkpoints')
    return bool(signatures) and all(glob.glob(os.path.join(checkpoints, f'{sig}-*.th')) for sig in signatures)


def model_cached(name):
    try:
        return _hf_cached(name) or _legacy_cached(name)
    except Exception:
        return False


def prefer_cached_model(name):
    """Se il modello è già in cache non interroga HuggingFace a ogni avvio: in
    una LAN senza Internet la richiesta resterebbe appesa fino al timeout."""
    if 'HF_HUB_OFFLINE' not in os.environ and model_cached(name):
        os.environ['HF_HUB_OFFLINE'] = '1'


def load_model(name):
    from demucs.pretrained import get_model
    try:
        model = get_model(name)
    except Exception as exc:  # rete assente, cache vuota, nome errato…
        raise WorkerError(f'Modello Demucs «{name}» non disponibile: {exc}') from exc
    model.eval()
    return model


def _chunks(length, chunk, overlap):
    """Blocchi [inizio, fine) da elaborare; ognuno sborda di `overlap` nel successivo."""
    spans = []
    start = 0
    while start < length:
        end = min(length, start + chunk + overlap)
        spans.append((start, end))
        if end == length:
            break
        start += chunk
    return spans


def separate(params, protocol):
    import torch
    from demucs.apply import apply_model

    source = params.get('input')
    outputs = params.get('outputs') or []
    if not source or not outputs:
        raise WorkerError('Parametri mancanti: input e outputs.')
    shifts = int(params.get('shifts', 1))

    torch.set_num_threads(cpu_threads())
    random.seed(0)  # gli shift casuali di Demucs diventano ripetibili
    device = pick_device(params.get('device'))

    protocol.progress(0.0, 'Caricamento del modello…', force=True)
    prefer_cached_model(params.get('model') or DEFAULT_MODEL)
    model = load_model(params.get('model') or DEFAULT_MODEL)
    sources = list(model.sources)
    plans = []
    for output in outputs:
        stems = output.get('stems') or []
        unknown = [s for s in stems if s not in sources]
        if not output.get('path') or not stems or unknown:
            raise WorkerError(f'Versione non valida: {", ".join(unknown) or "nessuno strumento"}.')
        plans.append((output['path'], [sources.index(s) for s in stems]))

    protocol.progress(0.01, 'Decodifica dell\'audio…', force=True)
    rate = model.samplerate
    channels = model.audio_channels
    wav = decode(source, rate, channels)
    length = wav.shape[1]
    if length < rate:
        raise WorkerError('La registrazione è troppo corta.')
    # stessa normalizzazione di demucs.api.Separator, ma calcolata sull'intero brano
    reference = wav.mean(0)
    mean = float(reference.mean())
    std = float(reference.std()) + 1e-8

    chunk = int(float(params.get('chunkSeconds', CHUNK_SECONDS)) * rate)
    overlap = int(float(params.get('overlapSeconds', OVERLAP_SECONDS)) * rate)
    spans = _chunks(length, chunk, overlap)
    total_work = sum(end - start for start, end in spans)
    sub_model = model.models[0] if hasattr(model, 'models') else model
    n_models = len(model.models) if hasattr(model, 'models') else 1
    stride = float(getattr(sub_model, 'segment', 8.0)) * (1 - SEGMENT_OVERLAP) * rate

    stage = protocol.stage(0.03, 0.99, 'Separazione degli strumenti…')
    writers = []
    try:
        for path, _ in plans:
            writers.append(FlacWriter(path, rate, channels))
        done_work = 0
        tail = None
        for start, end in spans:
            span = end - start
            expected = max(1, n_models * max(1, shifts) * math.ceil((span + 0.5 * rate) / stride))
            finished = [0]

            def on_segment(info, span=span, expected=expected, finished=finished, done_work=done_work):
                if info.get('state') == 'end':
                    finished[0] += 1
                    stage.update((done_work + span * min(1.0, finished[0] / expected)) / total_work)

            block = torch.from_numpy((wav[:, start:end] - mean) / std)
            with torch.no_grad():
                out = apply_model(model, block[None], shifts=shifts, split=True, overlap=SEGMENT_OVERLAP,
                                  progress=False, device=device, callback=on_segment)[0]
            out = out.cpu().numpy() * std  # [strumenti, canali, campioni]
            if tail is not None:
                k = tail.shape[-1]
                ramp = np.linspace(0.0, 1.0, k, dtype=np.float32)
                out[..., :k] = tail * (1.0 - ramp) + out[..., :k] * ramp
            if end < length:
                keep = span - overlap
                tail = out[..., keep:].copy()
                emit = out[..., :keep]
            else:
                tail = None
                emit = out
            for writer, (_, indices) in zip(writers, plans):
                writer.write(soft_limit(emit[indices].sum(axis=0) + mean))
            done_work += span
            stage.update(done_work / total_work)
        for writer in writers:
            writer.close()
    except BaseException:
        for writer in writers:
            writer.abort()
        raise

    protocol.progress(1.0, 'Fatto', force=True)
    return {
        'model': params.get('model') or DEFAULT_MODEL,
        'device': device,
        'sampleRate': rate,
        'durationMs': round(length / rate * 1000, 3),
        'outputs': [{'path': w.path, 'frames': w.frames} for w in writers],
    }


def download_models(params, protocol):
    names = params.get('models') or [DEFAULT_MODEL]
    for index, name in enumerate(names):
        protocol.progress(index / len(names), f'Download del modello {name}…', force=True)
        load_model(name)
    return {'models': names}
