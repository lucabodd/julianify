"""Canale verso il server: un oggetto JSON per riga su stdout.

Messaggi:
  {"type": "progress", "progress": 0.42, "message": "Separazione…"}
  {"type": "result", "result": {...}}
  {"type": "error", "error": "testo per l'utente"}

Molte librerie (tqdm, numba, demucs…) scrivono su stdout per conto loro: il
descrittore originale viene riservato ai messaggi e tutto il resto finisce su
stderr, che il server registra nei log.
"""

import json
import os
import sys
import time


class WorkerError(Exception):
    """Errore previsto, con un messaggio da mostrare all'utente."""


class Protocol:
    def __init__(self, stream=None):
        if stream is None:
            fd = os.dup(1)
            os.dup2(2, 1)
            sys.stdout = sys.stderr
            stream = os.fdopen(fd, 'w', encoding='utf-8', buffering=1)
        self._out = stream
        self._last_time = 0.0
        self._last_message = None

    def send(self, message):
        self._out.write(json.dumps(message, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n')
        self._out.flush()

    def progress(self, value, message=None, force=False):
        """Avanzamento 0..1; i messaggi troppo fitti vengono scartati."""
        now = time.monotonic()
        if not force and message == self._last_message and now - self._last_time < 0.5:
            return
        self._last_time = now
        self._last_message = message
        payload = {'type': 'progress', 'progress': round(min(1.0, max(0.0, float(value))), 4)}
        if message:
            payload['message'] = message
        self.send(payload)

    def stage(self, start, end, message=None):
        """Sotto-intervallo [start, end] dell'avanzamento totale."""
        return Stage(self, start, end, message)


class Stage:
    def __init__(self, protocol, start, end, message):
        self.protocol = protocol
        self.start = start
        self.end = end
        self.message = message
        protocol.progress(start, message, force=True)

    def update(self, fraction, message=None):
        fraction = min(1.0, max(0.0, fraction))
        self.protocol.progress(self.start + (self.end - self.start) * fraction, message or self.message)
