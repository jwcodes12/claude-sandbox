#!/usr/bin/env python3
# promo/lute.py — synthesize a medieval-ish lute bed (Karplus-Strong plucked
# strings over a soft drone), pure stdlib, mono 24kHz WAV.
#   usage: lute.py <seconds> <out.wav>
import math, random, struct, sys, wave

SR = 24000
DUR = float(sys.argv[1])
OUT = sys.argv[2]
random.seed(11)

N = int(SR * DUR)
buf = [0.0] * N

def midi_hz(m): return 440.0 * 2 ** ((m - 69) / 12)

def pluck(t0, midi, vol=0.22, decay=0.996):
    """Karplus–Strong plucked string starting at t0 seconds."""
    hz = midi_hz(midi)
    period = max(2, int(SR / hz))
    ks = [random.uniform(-1, 1) for _ in range(period)]
    start = int(t0 * SR)
    length = int(SR * 2.2)
    i = 0
    for n in range(start, min(N, start + length)):
        v = ks[i % period]
        ks[i % period] = decay * 0.5 * (ks[i % period] + ks[(i + 1) % period])
        # gentle attack to avoid clicks
        env = min(1.0, (n - start) / (SR * 0.004))
        buf[n] += vol * env * v
        i += 1

def drone(midi, vol=0.045):
    hz = midi_hz(midi)
    for n in range(N):
        t = n / SR
        # two slightly detuned sines + slow tremolo = organ-ish drone
        v = math.sin(2 * math.pi * hz * t) + 0.6 * math.sin(2 * math.pi * hz * 1.003 * t)
        trem = 0.85 + 0.15 * math.sin(2 * math.pi * 0.22 * t)
        edge = min(1.0, t / 1.5, (DUR - t) / 2.0)   # fade in/out
        buf[n] += vol * trem * max(0.0, edge) * v

# D dorian: drone on D2 + A2
drone(38); drone(45, 0.03)

# chord cycle (lute arpeggios, ~84 bpm feel): Dm, C, B♭, A
CHORDS = [
    [50, 53, 57, 62],   # D3 F3 A3 D4
    [48, 52, 55, 60],   # C3 E3 G3 C4
    [46, 50, 53, 58],   # Bb2 D3 F3 Bb3
    [45, 49, 52, 57],   # A2 C#3 E3 A3
]
BAR = 60 / 84 * 4       # one chord per bar
t = 0.0
bar = 0
while t < DUR - 1.0:
    notes = CHORDS[bar % 4]
    # pattern: low pluck then rolling arpeggio on eighth notes
    eighth = BAR / 8
    order = [0, 2, 1, 3, 2, 1, 2, 3]
    for k, idx in enumerate(order):
        tt = t + k * eighth + random.uniform(-0.008, 0.008)  # humanize
        if tt < DUR - 0.5:
            pluck(tt, notes[idx], vol=0.16 if k else 0.24)
    bar += 1
    t += BAR

# normalize to -14 dBFS-ish peak
peak = max(abs(v) for v in buf) or 1.0
scale = 0.55 / peak
with wave.open(OUT, 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes(b''.join(struct.pack('<h', int(max(-1, min(1, v * scale)) * 32767)) for v in buf))
print(f"lute bed: {DUR:.1f}s -> {OUT}")
