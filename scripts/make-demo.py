"""Genera i file di prova: demo.gp3 (Guitar Pro 3), demo.musicxml e demo.wav.

Uso:  pip install pyguitarpro && python3 scripts/make-demo.py <cartella-di-uscita>

Lo spartito è a 100 bpm; l'audio (sintetico: accordi, basso e click) è volutamente
a 104 bpm con 2 s di silenzio iniziale, così senza sync point il cursore andrebbe
fuori tempo: serve per provare il tap e la sincronizzazione.
"""
import math, struct, sys, wave, array
import guitarpro
from guitarpro import models as m

OUT = sys.argv[1] if len(sys.argv) > 1 else "."
SCORE_BPM = 100
AUDIO_BPM = 104
INTRO = 2.0

CHORDS = [  # (nome, [(corda, tasto)], radice MIDI basso, quinta MIDI basso)
    ('Dm7',   [(5, 5), (3, 5), (2, 6), (1, 5)], 38, 45),
    ('G7',    [(6, 3), (4, 3), (3, 4), (2, 3)], 43, 38),
    ('Cmaj7', [(5, 3), (3, 4), (2, 5), (1, 3)], 36, 43),
    ('A7',    [(6, 5), (4, 5), (3, 6), (2, 5)], 33, 40),
    ('Dm7',   [(5, 5), (3, 5), (2, 6), (1, 5)], 38, 45),
    ('Db7',   [(5, 4), (3, 4), (2, 6), (1, 4)], 37, 44),
    ('Cmaj7', [(5, 3), (3, 4), (2, 5), (1, 3)], 36, 43),
    ('C6',    [(5, 3), (3, 2), (2, 5), (1, 3)], 36, 43),
    ('Fm7',   [(6, 1), (4, 1), (3, 1), (2, 1)], 41, 36),
    ('Bb7',   [(5, 1), (3, 1), (2, 3), (1, 1)], 34, 41),
    ('Cmaj7', [(5, 3), (3, 4), (2, 5), (1, 3)], 36, 43),
    ('Cmaj7', [(5, 3), (3, 4), (2, 5), (1, 3)], 36, 43),
]
GUITAR_OPEN = {1: 64, 2: 59, 3: 55, 4: 50, 5: 45, 6: 40}
BASS_OPEN = {1: 43, 2: 38, 3: 33, 4: 28}
REPEAT_START, REPEAT_END = 4, 7  # battute 5-8 (0-based 4..7), suonate due volte
PLAY_ORDER = list(range(0, 8)) + list(range(4, 8)) + list(range(8, 12))


def bass_position(midi):
    for string in (4, 3, 2, 1):
        fret = midi - BASS_OPEN[string]
        if 0 <= fret <= 7:
            return string, fret
    raise ValueError(midi)


def make_gp3(path):
    song = m.Song(title='Julianify Demo', artist='Julianify', album='Test', tempo=SCORE_BPM)
    guitar = song.tracks[0]
    guitar.name = 'Chitarra'
    bass = m.Track(song, number=2, name='Basso', strings=[m.GuitarString(i, v) for i, v in BASS_OPEN.items()])
    bass.channel.instrument = 33
    bass.channel.channel = 1
    bass.channel.effectChannel = 1
    song.tracks.append(bass)
    # intestazioni e battute
    song.measureHeaders = []
    guitar.measures = []
    bass.measures = []
    start = 960
    for i in range(len(CHORDS)):
        header = m.MeasureHeader(number=i + 1, start=start)
        if i == REPEAT_START:
            header.isRepeatOpen = True
        if i == REPEAT_END:
            header.repeatClose = 1
        song.measureHeaders.append(header)
        guitar.measures.append(m.Measure(guitar, header))
        bass.measures.append(m.Measure(bass, header))
        start += 4 * 960
    for i, (name, voicing, root, fifth) in enumerate(CHORDS):
        gvoice = guitar.measures[i].voices[0]
        for half in range(2):
            beat = m.Beat(gvoice, duration=m.Duration(value=2), status=m.BeatStatus.normal)
            for string, fret in voicing:
                beat.notes.append(m.Note(beat, value=fret, string=string, type=m.NoteType.normal, velocity=95))
            if half == 0:
                strings = [-1] * 6
                for string, fret in voicing:
                    strings[string - 1] = fret
                chord = m.Chord(length=6, name=name, strings=strings, firstFret=max(1, min(f for _, f in voicing) or 1))
                chord.newFormat = False
                beat.effect.chord = chord
            gvoice.beats.append(beat)
        bvoice = bass.measures[i].voices[0]
        for midi in (root, fifth):
            beat = m.Beat(bvoice, duration=m.Duration(value=2), status=m.BeatStatus.normal)
            string, fret = bass_position(midi)
            beat.notes.append(m.Note(beat, value=fret, string=string, type=m.NoteType.normal, velocity=100))
            bvoice.beats.append(beat)
    guitarpro.write(song, path, version=(3, 0, 0))


def midi_freq(n):
    return 440.0 * 2 ** ((n - 69) / 12)


def make_wav(path, rate=16000):
    beat_s = 60.0 / AUDIO_BPM
    total = INTRO + len(PLAY_ORDER) * 4 * beat_s + 2.0
    n = int(total * rate)
    buf = array.array('f', [0.0]) * n

    def add_tone(t0, midi, dur, amp, harmonics=(1.0, 0.45, 0.2), decay=2.2):
        f = midi_freq(midi)
        i0 = int(t0 * rate)
        count = min(int(dur * rate), n - i0)
        w = [2 * math.pi * f * (h + 1) / rate for h in range(len(harmonics))]
        for k in range(count):
            env = amp * math.exp(-decay * k / rate) * min(1.0, k / 40)
            s = 0.0
            for h, a in enumerate(harmonics):
                s += a * math.sin(w[h] * k)
            buf[i0 + k] += env * s

    def add_click(t0, strong):
        i0 = int(t0 * rate)
        f = 1800 if strong else 1200
        for k in range(int(0.03 * rate)):
            buf[i0 + k] += (0.35 if strong else 0.2) * math.exp(-k / (0.006 * rate)) * math.sin(2 * math.pi * f * k / rate)

    for order, bar in enumerate(PLAY_ORDER):
        name, voicing, root, fifth = CHORDS[bar]
        t_bar = INTRO + order * 4 * beat_s
        for beat in range(4):
            add_click(t_bar + beat * beat_s, beat == 0)
        for half, bass_note in enumerate((root, fifth)):
            t = t_bar + half * 2 * beat_s
            for string, fret in voicing:
                add_tone(t + 0.012 * string, GUITAR_OPEN[string] + fret, 1.2, 0.09)
            add_tone(t, bass_note, 1.1, 0.22, harmonics=(1.0, 0.3), decay=2.8)
    peak = max(abs(x) for x in buf) or 1
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b''.join(struct.pack('<h', int(32000 * x / peak)) for x in buf))
    return [INTRO + i * 4 * beat_s for i in range(len(PLAY_ORDER))]


MUSICXML = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <work><work-title>Lead sheet di prova</work-title></work>
  <identification><creator type="composer">Julianify</creator></identification>
  <part-list><score-part id="P1"><part-name>Chitarra</part-name></score-part></part-list>
  <part id="P1">
{measures}
  </part>
</score-partwise>
"""

LEAD = [  # (radice, alterazione, kind, testo, melodia [(step, alter, octave, durata in quarti)])
    ('A', 0, 'minor-seventh', 'm7', [('C', 0, 5, 2), ('B', 0, 4, 1), ('A', 0, 4, 1)]),
    ('D', 0, 'dominant', '7', [('F', 1, 4, 2), ('A', 0, 4, 2)]),
    ('G', 0, 'major-seventh', 'maj7', [('B', 0, 4, 3), ('D', 0, 5, 1)]),
    ('C', 0, 'major-seventh', 'maj7', [('E', 0, 5, 2), ('D', 0, 5, 1), ('C', 0, 5, 1)]),
    ('F', 1, 'half-diminished', 'm7b5', [('A', 0, 4, 2), ('C', 0, 5, 2)]),
    ('B', 0, 'dominant', '7', [('D', 1, 5, 2), ('C', 0, 5, 1), ('B', 0, 4, 1)]),
    ('E', 0, 'minor-seventh', 'm7', [('G', 0, 4, 4)]),
    ('E', 0, 'minor-seventh', 'm7', [('E', 0, 4, 4)]),
]


def make_musicxml(path):
    parts = []
    for i, (root, alter, kind, text, melody) in enumerate(LEAD):
        attrs = ''
        if i == 0:
            attrs = ('<attributes><divisions>1</divisions><key><fifths>1</fifths><mode>major</mode></key>'
                     '<time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>'
                     '<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>120</per-minute></metronome></direction-type><sound tempo="120"/></direction>')
        harmony = (f'<harmony><root><root-step>{root}</root-step>' + (f'<root-alter>{alter}</root-alter>' if alter else '') +
                   f'</root><kind text="{text}">{kind}</kind></harmony>')
        notes = ''
        for step, nalter, octave, dur in melody:
            t = {1: 'quarter', 2: 'half', 3: 'half', 4: 'whole'}[dur]
            dot = '<dot/>' if dur == 3 else ''
            notes += (f'<note><pitch><step>{step}</step>' + (f'<alter>{nalter}</alter>' if nalter else '') +
                      f'<octave>{octave}</octave></pitch><duration>{dur}</duration><type>{t}</type>{dot}</note>')
        parts.append(f'    <measure number="{i + 1}">{attrs}{harmony}{notes}</measure>')
    with open(path, 'w') as f:
        f.write(MUSICXML.format(measures='\n'.join(parts)))


make_gp3(f'{OUT}/demo.gp3')
make_musicxml(f'{OUT}/demo.musicxml')
times = make_wav(f'{OUT}/demo.wav')
print('bar starts (s):', ', '.join(f'{t:.3f}' for t in times))
