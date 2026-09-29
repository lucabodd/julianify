"""Lettura e scrittura dell'audio tramite ffmpeg (qualsiasi formato in ingresso)."""

import os
import shutil
import subprocess

import numpy as np

from .protocol import WorkerError


def ffmpeg_path():
    path = os.environ.get('JULIANIFY_FFMPEG') or shutil.which('ffmpeg')
    if not path:
        raise WorkerError('ffmpeg non è installato sul server.')
    return path


def _stderr_tail(data):
    text = data.decode('utf-8', 'replace').strip() if data else ''
    return text.splitlines()[-1] if text else 'errore sconosciuto'


def decode(path, sample_rate, channels):
    """Decodifica il primo flusso audio del file in float32 [canali, campioni]."""
    if not os.path.isfile(path):
        raise WorkerError('File audio non trovato.')
    cmd = [
        ffmpeg_path(), '-nostdin', '-hide_banner', '-loglevel', 'error',
        '-i', path, '-map', '0:a:0', '-ac', str(channels), '-ar', str(sample_rate),
        '-f', 'f32le', 'pipe:1',
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if proc.returncode != 0:
        raise WorkerError(f'Impossibile leggere l\'audio: {_stderr_tail(proc.stderr)}')
    data = np.frombuffer(proc.stdout, dtype='<f4')
    frames = data.size // channels
    if frames == 0:
        raise WorkerError('Il file non contiene audio.')
    return data[:frames * channels].reshape(frames, channels).T.copy()


def soft_limit(block, threshold=0.95):
    """Evita il clipping sui picchi senza abbassare il volume complessivo."""
    magnitude = np.abs(block)
    over = magnitude > threshold
    if over.any():
        room = 1.0 - threshold
        block[over] = np.sign(block[over]) * (threshold + room * np.tanh((magnitude[over] - threshold) / room))
    return block


class FlacWriter:
    """Codifica in streaming blocchi float32 [canali, campioni] in un file FLAC."""

    def __init__(self, path, sample_rate, channels):
        self.path = path
        self.channels = channels
        self.frames = 0
        self._proc = subprocess.Popen(
            [
                ffmpeg_path(), '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
                '-f', 'f32le', '-ar', str(sample_rate), '-ac', str(channels), '-i', 'pipe:0',
                '-c:a', 'flac', '-sample_fmt', 's16', '-compression_level', '5', path,
            ],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        )

    def write(self, block):
        if block.shape[0] != self.channels:
            raise ValueError('numero di canali errato')
        data = np.ascontiguousarray(block.T, dtype='<f4')
        try:
            self._proc.stdin.write(data.tobytes())
        except BrokenPipeError:
            self._proc.wait()
            raise WorkerError(f'Codifica FLAC interrotta: {_stderr_tail(self._proc.stderr.read())}') from None
        self.frames += block.shape[1]

    def close(self):
        self._proc.stdin.close()
        err = self._proc.stderr.read()
        self._proc.stderr.close()
        if self._proc.wait() != 0:
            raise WorkerError(f'Codifica FLAC non riuscita: {_stderr_tail(err)}')

    def abort(self):
        if self._proc.poll() is None:
            self._proc.kill()
            self._proc.wait()
        for stream in (self._proc.stdin, self._proc.stderr):
            try:
                stream.close()
            except (OSError, ValueError):
                pass
        try:
            os.remove(self.path)
        except OSError:
            pass
