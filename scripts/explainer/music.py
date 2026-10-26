#!/usr/bin/env python3
"""Generate the score: a modern, minimal electronic bed arranged to the film.

Synthesized from scratch (no samples, no licensing), so the video never depends
on a music asset. The arrangement is read from timeline.json and cues.json:
the beat grid is anchored on the opening logo hit, every section change snaps
to that grid, and risers land exactly on the two hits. The voice is ducked
over it later, in build.py.

  open      pad swell + riser  ->  hit  ->  pad, sub, sparse pluck
  room      kick, bass, offbeat hats
  direct    + 16th hats, claps
  verified .. big   + 16th pluck arpeggio
  selfhost  breakdown: no kick, closed filter, riser into the end card
  outro     hit, a held chord, the arp rings out

  music.py --timeline timeline.json --cues cues.json --out music.wav
"""
from __future__ import annotations

import argparse
import json
import os

import numpy as np
import soundfile as sf
from scipy import signal

HERE = os.path.dirname(os.path.abspath(__file__))
SR = 48000
BPM = 118
BEAT = 60 / BPM

# I – V – vi – IV in G, two bars each; (bass, pad voicing) as MIDI notes
CHORDS = [
    (43, [55, 59, 62, 66]),      # Gmaj7
    (38, [57, 62, 64, 66]),      # D6/9
    (40, [55, 59, 62, 64]),      # Em7
    (36, [55, 59, 60, 64]),      # Cmaj7
]
FINAL = (43, [55, 59, 62, 66, 69])   # Gmaj9, held under the end card

rng = np.random.default_rng(11)


def hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def lp(x, f, order=2):
    return signal.sosfilt(signal.butter(order, f, "low", fs=SR, output="sos"), x)


def hp(x, f, order=2):
    return signal.sosfilt(signal.butter(order, f, "high", fs=SR, output="sos"), x)


def bp(x, lo, hi, order=2):
    return signal.sosfilt(signal.butter(order, [lo, hi], "band", fs=SR, output="sos"), x)


def add(buf, start, x, pan=0.0):
    """Mix mono `x` into stereo `buf` at `start` seconds, equal-power pan."""
    i = int(round(start * SR))
    if i >= buf.shape[0] or i + x.size <= 0:
        return
    if i < 0:
        x, i = x[-i:], 0
    x = x[: buf.shape[0] - i]
    a = (pan + 1) * np.pi / 4
    buf[i:i + x.size, 0] += x * np.cos(a)
    buf[i:i + x.size, 1] += x * np.sin(a)


def add_st(buf, start, x):
    """Mix stereo `x` into `buf` at `start` seconds."""
    i = int(round(start * SR))
    m = min(x.shape[0], buf.shape[0] - i)
    if m > 0:
        buf[i:i + m] += x[:m]


def env(n, a, d, r=None):
    """attack/decay envelope over n samples (exponential decay, linear attack)."""
    t = np.arange(n) / SR
    e = np.minimum(1, t / max(a, 1e-4)) * np.exp(-np.maximum(0, t - a) / d)
    if r:
        e *= np.clip((n / SR - t) / r, 0, 1)
    return e


def saw(f, n, harmonics=14, phase=0.0):
    t = np.arange(n) / SR
    x = np.zeros(n)
    for k in range(1, harmonics + 1):
        if f * k > SR / 2.2:
            break
        x += np.sin(2 * np.pi * f * k * t + phase * k) / k
    return x


def reverb_ir(seconds=2.4, decay=0.75):
    n = int(seconds * SR)
    t = np.arange(n) / SR
    ir = rng.standard_normal((n, 2)) * np.exp(-t / decay)[:, None]
    ir[:, 0] = lp(ir[:, 0], 5200); ir[:, 1] = lp(ir[:, 1], 5200)
    ir[: int(0.012 * SR)] = 0                     # pre-delay
    return ir / np.sqrt((ir ** 2).sum(axis=0))


def reverb(x, ir, wet=0.3):
    out = np.stack([signal.fftconvolve(x[:, c], ir[:, c])[: x.shape[0]] for c in range(2)], axis=1)
    return x * (1 - wet * 0.4) + out * wet


# ---- instruments --------------------------------------------------------------
def kick():
    n = int(0.5 * SR)
    t = np.arange(n) / SR
    f = 46 + 110 * np.exp(-t / 0.035)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.28)
    click = hp(rng.standard_normal(n), 3000) * np.exp(-t / 0.003) * 0.25
    return np.tanh(1.6 * (x + click)) * 0.9


def hat(open_=False):
    n = int((0.25 if open_ else 0.08) * SR)
    x = hp(rng.standard_normal(n), 7500, 4) * env(n, 0.001, 0.09 if open_ else 0.028)
    return x * 0.5


def clap():
    n = int(0.4 * SR)
    t = np.arange(n) / SR
    e = sum(np.exp(-np.maximum(0, t - d) / (0.006 if d < 0.02 else 0.13)) * (t >= d) for d in (0, 0.011, 0.022))
    return bp(rng.standard_normal(n), 900, 3800) * e * 0.5


def pluck(m, dur=0.5):
    n = int(dur * SR)
    f = hz(m)
    x = saw(f, n, 8) * 0.6 + np.sin(2 * np.pi * f * np.arange(n) / SR)
    x = lp(x, min(9000, f * 6)) * env(n, 0.002, 0.16)
    return x * 0.22


def bass_note(m, dur):
    n = int(dur * SR)
    x = saw(hz(m), n, 10) + 0.8 * np.sin(2 * np.pi * hz(m) * np.arange(n) / SR)
    return lp(x, 520) * env(n, 0.004, 0.18, r=0.02) * 0.42


def pad_chord(notes, dur, cutoff):
    n = int((dur + 1.2) * SR)
    x = np.zeros((n, 2))
    for m in notes:
        for v, det in enumerate((-0.11, 0.0, 0.11)):     # +/- 11 cents of detune
            f = hz(m) * 2 ** (det / 12)
            add(x, 0, saw(f, n, 12, phase=rng.random() * 6.28), pan=(v - 1) * 0.6)
    x[:, 0] = lp(x[:, 0], cutoff); x[:, 1] = lp(x[:, 1], cutoff)
    t = np.arange(n) / SR
    e = np.minimum(1, t / 0.5) * np.clip((dur + 1.2 - t) / 1.2, 0, 1)
    return x * e[:, None] * 0.05


def riser(dur, peak=0.35):
    n = int(dur * SR)
    t = np.arange(n) / SR
    out = np.zeros(n)
    noise = rng.standard_normal(n)
    hop = int(0.04 * SR)
    for i in range(0, n, hop):                       # a band that climbs
        u = i / n
        c = 300 * (40 ** u)
        seg = bp(noise[max(0, i - hop): i + hop], c * 0.7, min(c * 1.4, SR / 2.2))
        out[i: i + hop] = seg[-min(hop, n - i):] if i else seg[:hop]
    sweep = np.sin(2 * np.pi * np.cumsum(180 * (8 ** (t / dur))) / SR) * 0.25
    return (out + sweep) * (t / dur) ** 2.2 * peak


# ---- arrangement --------------------------------------------------------------
def build(timeline, cues):
    dur = timeline["video_end"]
    n = int(dur * SR) + SR
    mus = np.zeros((n, 2))        # dry, ducked by the kick
    drums = np.zeros((n, 2))
    send = np.zeros((n, 2))       # into the reverb

    starts = {s["name"]: s["start"] for s in timeline["scenes"]}
    hits = sorted(c["t"] for c in cues if c["type"] == "hit")
    h0, h1 = hits[0], hits[-1]
    snap = lambda t: h0 + round((t - h0) / BEAT) * BEAT
    demo, trust, routes, server = (snap(starts[k]) for k in ("room", "direct", "verified", "selfhost"))

    # beat grid, anchored on the first logo hit
    beats = [h0 + i * BEAT for i in range(int((h1 - h0) / BEAT) + 1)]
    kicks = [b for b in beats if demo <= b < server - 1e-6]

    # pads: the progression from the hit, one chord per two bars
    def chord_at(i):
        return CHORDS[i % 4]
    cutoff = lambda t: 900 if t < h0 else 1500 if t < demo else 2600 if t < server else 800
    add_pad = lambda t0, notes, d, c: add_st(mus, t0, pad_chord(notes, d, c))
    add_pad(0.0, CHORDS[0][1], h0, 700)
    bar2 = 8 * BEAT
    i, t = 0, h0
    while t < h1 - 0.05:
        d = min(bar2, h1 - t)
        add_pad(t, chord_at(i)[1], d, cutoff(t))
        # sub: a held sine under everything after the hit
        nn = int((d + 0.3) * SR)
        sub = np.sin(2 * np.pi * hz(chord_at(i)[0]) * np.arange(nn) / SR) * env(nn, 0.05, 30, r=0.3) * 0.16
        add(mus, t, sub)
        i, t = i + 1, t + bar2
    add_pad(h1, FINAL[1], dur - h1 - 1.0, 2400)
    nn = int((dur - h1) * SR)
    add(mus, h1, np.sin(2 * np.pi * hz(FINAL[0]) * np.arange(nn) / SR) * env(nn, 0.01, 3.0) * 0.2)

    # bass: driving 8ths while the drums play
    for k, b in enumerate(b for b in beats if demo <= b < server):
        ci = int((b - h0 + 1e-6) // bar2)
        root = chord_at(ci)[0]
        for half in (0, 1):
            m = root + (12 if (half and k % 2) else 0)
            add(mus, b + half * BEAT / 2, bass_note(m, BEAT / 2 * 0.95))

    # drums
    K = kick()
    for b in kicks:
        add(drums, b, K)
    for b in beats:
        if demo <= b < trust:
            add(drums, b + BEAT / 2, hat(), pan=0.25)
        elif trust <= b < server:
            for s, v in enumerate((0.45, 0.22, 0.9, 0.22)):
                add(drums, b + s * BEAT / 4, hat(open_=(s == 2 and int((b - h0) / BEAT) % 4 == 3)) * v, pan=0.3 - 0.2 * s)
            if int(round((b - h0) / BEAT)) % 2 == 1:
                c = clap()
                add(drums, b, c, pan=-0.05)
                add(send, b, c * 0.6)

    # pluck arpeggio: 8ths after the hit, 16ths through the routes, sparse in the break
    for b in beats:
        ci = int((b - h0 + 1e-6) // bar2)
        notes = chord_at(ci)[1] + [m + 12 for m in chord_at(ci)[1]]
        if b < demo and b >= h0 + 2 * BEAT:
            steps, vel = 2, 0.55
        elif routes <= b < server:
            steps, vel = 4, 0.75
        elif server <= b < h1 - 2 * BEAT:
            steps, vel = 1, 0.5
        else:
            continue
        for s in range(steps):
            k = int(round((b - h0) / BEAT)) * steps + s
            m = notes[(k * 3) % len(notes)] + 12
            p = pluck(m) * vel * (1 if s % 2 == 0 else 0.7)
            pan = 0.35 if k % 2 else -0.35
            add(mus, b + s * BEAT / steps, p, pan=pan)
            add(send, b + s * BEAT / steps, p * 0.8, pan=pan)
            # ping-pong echo, three dotted-8th repeats
            for r in range(1, 4):
                add(send, b + s * BEAT / steps + r * BEAT * 0.75, p * 0.42 ** r, pan=-pan if r % 2 else pan)
    # the outro arp rings out over the held chord
    for k in range(16):
        tt = h1 + k * BEAT / 2
        p = pluck(FINAL[1][k % 5] + 12) * 0.5 * np.exp(-k / 7)
        add(send, tt, p, pan=0.4 if k % 2 else -0.4)
        add(mus, tt, p * 0.6, pan=0.4 if k % 2 else -0.4)

    # risers into both hits, and a softer one into the demo drop
    for at, d, pk in ((h0, h0, 0.22), (h1, 4 * BEAT, 0.3), (demo, 2 * BEAT, 0.12)):
        r = riser(d, pk)
        add(mus, at - d, r, pan=0)
        add(send, at - d, r * 0.5)

    # sidechain: everything melodic ducks under the kick
    duck = np.ones(n)
    for b in kicks:
        i0 = int(b * SR)
        k = np.arange(min(int(0.35 * SR), n - i0)) / SR
        duck[i0:i0 + k.size] = np.minimum(duck[i0:i0 + k.size], 1 - 0.6 * np.exp(-k / 0.11))
    mus *= duck[:, None]

    ir = reverb_ir()
    wet = np.stack([signal.fftconvolve(send[:, c], ir[:, c])[:n] for c in range(2)], axis=1) * duck[:, None]
    out = mus + drums * 0.9 + wet * 0.55
    out = out[: int(dur * SR)]

    # gentle glue + fades, then leave headroom for the voice
    t = np.arange(out.shape[0]) / SR
    out *= np.minimum(1, t / 0.4)[:, None]
    out *= np.clip((dur - t) / 2.5, 0, 1)[:, None]
    out = np.tanh(out * 1.4) / 1.4
    return out / max(1e-9, np.abs(out).max()) * 0.6


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeline", default=os.path.join(HERE, "timeline.json"))
    ap.add_argument("--cues", default=os.path.join(HERE, "cues.json"))
    ap.add_argument("--out", default=os.path.join(HERE, "music.wav"))
    args = ap.parse_args()
    data = build(json.load(open(args.timeline)), json.load(open(args.cues)))
    sf.write(args.out, data, SR, subtype="PCM_24")
    print(f"music: {args.out}  {data.shape[0] / SR:.1f}s")


if __name__ == "__main__":
    main()
