"""Test del worker: python -m unittest discover -s tests (dalla cartella worker)."""

import importlib.util
import io
import json
import math
import os
import subprocess
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from julianify_worker import audio as audio_io  # noqa: E402
from julianify_worker import autosync as sync  # noqa: E402
from julianify_worker.protocol import Protocol, WorkerError  # noqa: E402
from julianify_worker.stems import _chunks, cpu_threads  # noqa: E402

WORKER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_worker(command, params=None, env=None):
    proc = subprocess.run(
        [sys.executable, '-m', 'julianify_worker', command],
        input=json.dumps(params or {}).encode(), cwd=WORKER_DIR,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={**os.environ, **(env or {})}, timeout=300,
    )
    messages = [json.loads(line) for line in proc.stdout.decode().splitlines() if line.strip()]
    return proc.returncode, messages


class ProtocolTest(unittest.TestCase):
    def test_messages_are_json_lines_and_progress_is_throttled(self):
        stream = io.StringIO()
        protocol = Protocol(stream)
        protocol.progress(0.1, 'Uno', force=True)
        protocol.progress(0.2, 'Uno')  # stesso messaggio subito dopo: scartato
        protocol.progress(0.3, 'Due')  # messaggio nuovo: inviato
        protocol.send({'type': 'result', 'result': {'ok': True}})
        lines = [json.loads(line) for line in stream.getvalue().splitlines()]
        self.assertEqual([m.get('message') for m in lines[:2]], ['Uno', 'Due'])
        self.assertEqual(lines[-1], {'type': 'result', 'result': {'ok': True}})

    def test_stage_maps_fraction(self):
        stream = io.StringIO()
        protocol = Protocol(stream)
        stage = protocol.stage(0.5, 0.7, 'Fase')
        stage.update(0.5)
        self.assertAlmostEqual(json.loads(stream.getvalue().splitlines()[0])['progress'], 0.5)


class AudioTest(unittest.TestCase):
    def test_decode_resamples_and_flac_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = os.path.join(tmp, 'sine.wav')
            subprocess.run([audio_io.ffmpeg_path(), '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
                            '-ar', '48000', source], check=True)
            data = audio_io.decode(source, 22050, 1)
            self.assertEqual(data.shape[0], 1)
            self.assertAlmostEqual(data.shape[1] / 22050, 1.0, places=2)
            stereo = audio_io.decode(source, 44100, 2)
            target = os.path.join(tmp, 'out.flac')
            writer = audio_io.FlacWriter(target, 44100, 2)
            writer.write(stereo[:, :20000])
            writer.write(stereo[:, 20000:])
            writer.close()
            back = audio_io.decode(target, 44100, 2)
            self.assertEqual(back.shape, stereo.shape)
            self.assertLess(float(np.max(np.abs(back - stereo))), 1e-3)

    def test_decode_missing_file(self):
        with self.assertRaises(WorkerError):
            audio_io.decode('/non/esiste.mp3', 22050, 1)

    def test_soft_limit_keeps_small_values(self):
        block = np.array([[0.5, -0.9, 1.4, -2.0]], dtype=np.float32)
        out = audio_io.soft_limit(block.copy())
        self.assertEqual(out[0, 0], 0.5)
        self.assertEqual(out[0, 1], np.float32(-0.9))
        self.assertTrue(np.all(np.abs(out) <= 1.0))
        self.assertLess(out[0, 2], out[0, 3] * -1 + 0.001)


class StemsHelpersTest(unittest.TestCase):
    def test_chunks_overlap_and_cover(self):
        spans = _chunks(100, 30, 5)
        self.assertEqual(spans, [(0, 35), (30, 65), (60, 95), (90, 100)])
        self.assertEqual(_chunks(20, 30, 5), [(0, 20)])

    def test_cpu_threads_env(self):
        os.environ['JULIANIFY_WORKER_THREADS'] = '3'
        try:
            self.assertEqual(cpu_threads(), 3)
        finally:
            del os.environ['JULIANIFY_WORKER_THREADS']
        self.assertGreaterEqual(cpu_threads(), 1)


class AutosyncHelpersTest(unittest.TestCase):
    def test_notes_frame_folds_octaves_and_skips_invalid(self):
        frame = sync.notes_frame([[0, 1, 12, 90], [0.5, 0.01, 120, 90], [1, -1, 60, 90], ['x', 1, 60], [2, 1, 64]])
        self.assertEqual(list(frame['pitch']), [24, 108, 64])
        self.assertEqual(list(frame['duration'])[1], 0.03)
        with self.assertRaises(WorkerError):
            sync.notes_frame([[0, 0, 60, 90]])

    def test_clean_anchors(self):
        pairs = sync.clean_anchors([(5, 4), (1, 0.5), (5.5, 4.5), (20, 12), (99, 50)], 60, 30)
        self.assertEqual(pairs, [(5.0, 4.0), (20.0, 12.0)])

    def test_suspicious_zigzag(self):
        score = [0, 2, 4, 6, 8, 10]
        audio = [1000, 3000, 5000, 7900, 9000, 11000]  # il quarto punto è in ritardo
        self.assertIn(3, sync.suspicious_targets(score, audio, [0.9] * 6))
        self.assertEqual(sync.suspicious_targets(score, [1000, 3000, 5000, 7000, 9000, 11000], [0.9] * 6), [])
        self.assertEqual(sync.suspicious_targets([0, 2, 4], [0, 2000, 4000], [0.9, 0.2, 0.9]), [1])

    def test_active_range_skips_silence(self):
        rate = sync.SAMPLE_RATE
        signal = np.zeros(rate * 3, dtype=np.float32)
        signal[rate:2 * rate] = 0.3 * np.sin(np.arange(rate) * 2 * np.pi * 220 / rate)
        first, last = sync.active_range(signal)
        self.assertAlmostEqual(first / rate, 0.95, delta=0.03)
        self.assertAlmostEqual(last / rate, 2.2, delta=0.03)


CHORDS = [[50, 53, 57, 60], [43, 53, 59, 62], [48, 55, 59, 64], [45, 55, 61, 64],
          [50, 53, 57, 60], [43, 53, 59, 62], [48, 52, 55, 60], [48, 52, 55, 59]]


def synth_performance(rate, bar_seconds, intro):
    """Accordi con attacchi netti; la durata di ogni battuta varia (rubato)."""
    total = intro + sum(bar_seconds) + 1.5
    out = np.zeros(int(total * rate), dtype=np.float32)
    starts = []
    t = intro
    for chord, length in zip(CHORDS, bar_seconds):
        starts.append(t)
        for half in range(2):
            onset = t + half * length / 2
            i0 = int(onset * rate)
            n = int(min(length / 2 + 0.3, total - onset) * rate)
            k = np.arange(n) / rate
            env = np.exp(-3.0 * k) * np.minimum(1.0, k / 0.004)
            for midi in chord + [chord[0] - 12]:
                f = 440.0 * 2 ** ((midi - 69) / 12)
                tone = sum(a * np.sin(2 * np.pi * f * h * k) for h, a in ((1, 1.0), (2, 0.4), (3, 0.2)))
                out[i0:i0 + n] += (0.08 * env * tone).astype(np.float32)
        t += length
    out += np.random.default_rng(0).normal(0, 0.002, out.size).astype(np.float32)
    return out, starts


@unittest.skipUnless(importlib.util.find_spec('synctoolbox'), 'synctoolbox assente')
class AutosyncEndToEndTest(unittest.TestCase):
    def test_rubato_performance_is_aligned(self):
        rate = 22050
        score_bar = 2.4  # 100 bpm, 4/4
        bar_seconds = [2.3, 2.5, 2.2, 2.6, 2.4, 2.1, 2.5, 2.9]
        signal, truth = synth_performance(rate, bar_seconds, intro=1.3)
        notes = []
        for i, chord in enumerate(CHORDS):
            for half in range(2):
                for midi in chord + [chord[0] - 12]:
                    notes.append([i * score_bar + half * score_bar / 2, score_bar / 2, midi, 90])
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'perf.wav')
            pcm = (np.clip(signal, -1, 1) * 32767).astype('<i2')
            subprocess.run([audio_io.ffmpeg_path(), '-v', 'error', '-f', 's16le', '-ar', str(rate), '-ac', '1',
                            '-i', 'pipe:0', path], input=pcm.tobytes(), check=True)
            code, messages = run_worker('autosync', {
                'audio': path, 'notes': notes, 'targets': [i * score_bar for i in range(8)],
                'scoreDuration': 8 * score_bar, 'anchors': [],
            })
        self.assertEqual(code, 0, messages[-1])
        result = messages[-1]['result']
        errors = [abs(a - b * 1000) for a, b in zip(result['times'], truth)]
        self.assertLess(max(errors), 40, errors)
        self.assertEqual(result['transposition'], 0)
        self.assertTrue(any(m['type'] == 'progress' for m in messages))


class CliTest(unittest.TestCase):
    def test_unknown_command(self):
        code, messages = run_worker('boh')
        self.assertEqual(code, 2)
        self.assertEqual(messages[-1]['type'], 'error')

    def test_invalid_params(self):
        proc = subprocess.run([sys.executable, '-m', 'julianify_worker', 'autosync'], input=b'{no', cwd=WORKER_DIR,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(json.loads(proc.stdout.decode().splitlines()[-1])['type'], 'error')

    def test_autosync_reports_user_errors(self):
        code, messages = run_worker('autosync', {'audio': '/non/esiste.wav', 'notes': [[0, 1, 60, 90]], 'targets': [0]})
        self.assertEqual(code, 2)
        self.assertIn('non trovato', messages[-1]['error'])

    def test_info(self):
        code, messages = run_worker('info')
        self.assertEqual(code, 0)
        result = messages[-1]['result']
        self.assertIn('features', result)
        self.assertGreaterEqual(result['threads'], 1)


if __name__ == '__main__':
    unittest.main()
