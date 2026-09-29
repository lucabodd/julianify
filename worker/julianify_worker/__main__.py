"""python -m julianify_worker <info|stems|autosync|download-models>

Parametri JSON su stdin, messaggi JSON per riga su stdout (vedi protocol.py).
Codici di uscita: 0 riuscito, 2 errore previsto, 1 errore interno, 143 interrotto.
"""

import importlib.metadata
import json
import platform
import signal
import sys
import traceback

from . import __version__
from .protocol import Protocol, WorkerError


def _version(package):
    try:
        return importlib.metadata.version(package)
    except importlib.metadata.PackageNotFoundError:
        return None


def info(params, protocol):
    from .audio import ffmpeg_path
    from .stems import DEFAULT_MODEL, cpu_threads, model_cached

    result = {
        'worker': __version__,
        'python': platform.python_version(),
        'threads': cpu_threads(),
        'features': {},
    }
    try:
        result['ffmpeg'] = ffmpeg_path()
    except WorkerError as exc:
        result['ffmpeg'] = None
        result['features'] = {name: {'ok': False, 'error': str(exc)} for name in ('stems', 'autosync')}
        return result
    try:
        import torch
        from demucs.apply import apply_model  # noqa: F401
        result['torch'] = torch.__version__
        result['demucs'] = _version('demucs')
        result['device'] = 'cuda' if torch.cuda.is_available() else 'cpu'
        result['models'] = {DEFAULT_MODEL: model_cached(DEFAULT_MODEL)}
        result['features']['stems'] = {'ok': True}
    except Exception as exc:
        result['features']['stems'] = {'ok': False, 'error': f'Demucs non disponibile: {exc}'}
    try:
        from synctoolbox.dtw.mrmsdtw import sync_via_mrmsdtw_with_anchors  # noqa: F401
        result['synctoolbox'] = _version('synctoolbox')
        result['features']['autosync'] = {'ok': True}
    except Exception as exc:
        result['features']['autosync'] = {'ok': False, 'error': f'Sync Toolbox non disponibile: {exc}'}
    return result


def _stems(params, protocol):
    from .stems import separate
    return separate(params, protocol)


def _autosync(params, protocol):
    from .autosync import autosync
    return autosync(params, protocol)


def _download(params, protocol):
    from .stems import download_models
    return download_models(params, protocol)


COMMANDS = {
    'info': info,
    'stems': _stems,
    'autosync': _autosync,
    'download-models': _download,
}


def _terminate(signum, frame):
    raise SystemExit(143)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    protocol = Protocol()
    command = argv[0] if argv else ''
    handler = COMMANDS.get(command)
    if handler is None:
        protocol.send({'type': 'error', 'error': f'Comando sconosciuto: {command or "(nessuno)"}'})
        return 2
    signal.signal(signal.SIGTERM, _terminate)
    try:
        raw = sys.stdin.read() if not sys.stdin.isatty() else ''
        params = json.loads(raw) if raw.strip() else {}
        if not isinstance(params, dict):
            raise WorkerError('I parametri devono essere un oggetto JSON.')
        result = handler(params, protocol)
    except json.JSONDecodeError:
        protocol.send({'type': 'error', 'error': 'Parametri JSON non validi.'})
        return 2
    except WorkerError as exc:
        protocol.send({'type': 'error', 'error': str(exc)})
        return 2
    except MemoryError:
        protocol.send({'type': 'error', 'error': 'Memoria insufficiente sul server.'})
        return 1
    except Exception as exc:
        traceback.print_exc()
        protocol.send({'type': 'error', 'error': f'Errore interno del worker: {exc}'})
        return 1
    protocol.send({'type': 'result', 'result': result})
    return 0


if __name__ == '__main__':
    sys.exit(main())
