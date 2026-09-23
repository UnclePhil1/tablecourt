#!/usr/bin/env python3
"""Builds the sound effects in assets/audio/sfx/ from scratch.  python3 tools/make_sfx.py

These are synthesised rather than recorded, but they are baked into real files with proper
envelopes, resonance and filtering, which is why they sound like a ball and a bat instead of the
oscillator beeps the game used to make live. Drop real recordings over the top with the same
filenames whenever you have them: nothing else needs to change.

A table tennis impact is mostly one very short click plus the bat or table ringing underneath it,
so each sound here is a noise transient layered over one or two damped resonances.
"""
import math, os, random, struct, wave

SR = 22050                    # plenty for short impacts; halves the download
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets', 'audio', 'sfx')

def silence(dur): return [0.0] * int(SR * dur)

def noise(dur, seed):
    r = random.Random(seed)
    return [r.uniform(-1, 1) for _ in range(int(SR * dur))]

def biquad(x, kind, f0, q):
    """One biquad, enough to shape a click into something with a body."""
    w = 2 * math.pi * f0 / SR
    a = math.sin(w) / (2 * q)
    cw = math.cos(w)
    if kind == 'lp':
        b0, b1, b2 = (1 - cw) / 2, 1 - cw, (1 - cw) / 2
    elif kind == 'hp':
        b0, b1, b2 = (1 + cw) / 2, -(1 + cw), (1 + cw) / 2
    else:                                    # band pass, constant peak
        b0, b1, b2 = a, 0.0, -a
    a0, a1, a2 = 1 + a, -2 * cw, 1 - a
    b0, b1, b2, a1, a2 = b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0
    y = [0.0] * len(x)
    x1 = x2 = y1 = y2 = 0.0
    for i, s in enumerate(x):
        o = b0 * s + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2, x1 = x1, s
        y2, y1 = y1, o
        y[i] = o
    return y

def decay(x, tau, hold=0.0):
    """Exponential fall, with a tiny attack so nothing clicks at the very start."""
    n = len(x)
    atk = max(1, int(SR * 0.0006))
    out = [0.0] * n
    for i in range(n):
        t = i / SR
        e = math.exp(-max(0.0, t - hold) / tau)
        if i < atk: e *= i / atk
        out[i] = x[i] * e
    return out

def ring(dur, freq, tau, detune=0.0):
    """A struck body: the bat face, or the table top."""
    n = int(SR * dur)
    out = [0.0] * n
    for i in range(n):
        t = i / SR
        s = math.sin(2 * math.pi * freq * t)
        if detune: s += 0.5 * math.sin(2 * math.pi * freq * detune * t)
        out[i] = s * math.exp(-t / tau)
    return out

def mix(*layers):
    n = max(len(l) for l in layers)
    out = [0.0] * n
    for l in layers:
        for i, s in enumerate(l):
            out[i] += s
    return out

def norm(x, peak=0.89):
    m = max(1e-9, max(abs(s) for s in x))
    return [s * peak / m for s in x]

def write(name, x):
    x = norm(x)
    path = os.path.join(OUT, name)
    with wave.open(path, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(b''.join(struct.pack('<h', int(max(-1, min(1, s)) * 32767)) for s in x))
    print('  %-22s %5.0f ms  %6d bytes' % (name, len(x) / SR * 1000, os.path.getsize(path)))

def paddle(name, hardness, seed):
    """hardness 0..1 — harder is brighter, louder and carries more low thump."""
    dur = 0.10 + hardness * 0.07
    click = decay(biquad(noise(dur, seed), 'bp', 2200 + hardness * 2200, 0.8), 0.004 + hardness * 0.004)
    body = decay(ring(dur, 780 + hardness * 520, 0.030 + hardness * 0.02, 1.48), 0.030 + hardness * 0.02)
    thump = decay(ring(dur, 150 + hardness * 90, 0.05), 0.05)
    write(name, mix([s * (0.75 + 0.25 * hardness) for s in click],
                    [s * 0.55 for s in body],
                    [s * (0.15 + 0.5 * hardness) for s in thump]))

os.makedirs(OUT, exist_ok=True)
print('writing', OUT)
paddle('hit-soft.wav', 0.0, 11)
paddle('hit-medium.wav', 0.5, 22)
paddle('hit-hard.wav', 1.0, 33)

# the table: a hollow wooden tok
write('bounce-table.wav', mix(
    [s * 0.6 for s in decay(biquad(noise(0.13, 44), 'bp', 3200, 1.1), 0.0035)],
    [s * 0.9 for s in decay(ring(0.13, 470, 0.040, 2.02), 0.040)],
    [s * 0.3 for s in decay(ring(0.13, 236, 0.055), 0.055)]))

# the net: cloth, almost no pitch
write('net.wav', mix(
    [s * 1.0 for s in decay(biquad(biquad(noise(0.20, 55), 'lp', 900, 0.7), 'hp', 180, 0.7), 0.045)],
    [s * 0.25 for s in decay(ring(0.20, 165, 0.06), 0.06)]))

# the floor: duller and lower than the table
write('floor.wav', mix(
    [s * 0.45 for s in decay(biquad(noise(0.22, 66), 'lp', 1200, 0.8), 0.010)],
    [s * 0.9 for s in decay(ring(0.22, 190, 0.070, 1.51), 0.070)],
    [s * 0.5 for s in decay(ring(0.22, 95, 0.090), 0.090)]))

# the serve: the toss tick, then a light contact
write('serve.wav', mix(
    [s * 0.5 for s in decay(biquad(noise(0.16, 77), 'bp', 5200, 1.4), 0.003)],
    [s * 0.5 for s in decay(biquad(noise(0.16, 78), 'bp', 2600, 0.9), 0.006, hold=0.055)],
    [s * 0.4 for s in decay(ring(0.16, 900, 0.02), 0.02, hold=0.055)]))

def sting(name, notes, step, dur, tau, shape='sine'):
    total = step * (len(notes) - 1) + dur
    n = int(SR * total)
    out = [0.0] * n
    for k, f in enumerate(notes):
        off = int(SR * step * k)
        for i in range(int(SR * dur)):
            if off + i >= n: break
            t = i / SR
            s = math.sin(2 * math.pi * f * t)
            if shape == 'soft': s = (s + 0.35 * math.sin(4 * math.pi * f * t)) / 1.35
            out[off + i] += s * math.exp(-t / tau) * 0.8
    return write(name, out)

sting('point-won.wav',  [660, 880, 1320], 0.085, 0.30, 0.10)
sting('point-lost.wav', [330, 247],       0.110, 0.34, 0.13)
sting('match-won.wav',  [523, 659, 784, 1047], 0.135, 0.55, 0.20, 'soft')
sting('match-lost.wav', [392, 330, 262, 196],  0.150, 0.60, 0.24, 'soft')
sting('ui.wav', [1200], 0.0, 0.05, 0.012)
