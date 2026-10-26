#!/usr/bin/env python3
"""Sound design: render the scenes' cue list (cues.json) into one effects track.

The scenes register every cue themselves (api.cue in web/), so a sound always
sits on the frame that causes it. Every effect is synthesized, like the music.

  sfx.py --cues cues.json --duration 56.5 --out sfx.wav
"""
from __future__ import annotations

import argparse
import json
import os

import numpy as np
import soundfile as sf
from scipy import signal

from music import SR, add, bp, env, hp, lp, reverb_ir

HERE = os.path.dirname(os.path.abspath(__file__))
rng = np.random.default_rng(5)


def T(sec):
    return np.arange(int(sec * SR)) / SR


def sweep_noise(sec, f0, f1, q=0.5):
    """Noise through a band that glides from f0 to f1, with a bell envelope."""
    n = int(sec * SR)
    x = rng.standard_normal(n)
    out = np.zeros(n)
    hop = int(0.02 * SR)
    for i in range(0, n, hop):
        u = i / n
        c = f0 * (f1 / f0) ** u
        seg = bp(x[max(0, i - 4 * hop): i + hop], c * (1 - q), min(c * (1 + q), SR / 2.2))
        out[i:i + hop] = seg[-min(hop, n - i):]
    u = np.arange(n) / n
    return out * np.sin(np.pi * u) ** 1.6


def key():
    t = T(0.05)
    f = 1800 + rng.random() * 1400
    click = hp(rng.standard_normal(t.size), 2500) * np.exp(-t / 0.004)
    body = np.sin(2 * np.pi * f * t) * np.exp(-t / 0.006) * 0.4
    thock = np.sin(2 * np.pi * (240 + rng.random() * 60) * t) * np.exp(-t / 0.012) * 0.5
    return (click * 0.6 + body + thock) * 0.16


def enter():
    t = T(0.12)
    return (hp(rng.standard_normal(t.size), 1500) * np.exp(-t / 0.006) * 0.5
            + np.sin(2 * np.pi * 170 * t) * np.exp(-t / 0.03)) * 0.26


def pop():
    t = T(0.25)
    f = 620 * (1 + 0.9 * (1 - np.exp(-t / 0.02)))
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * env(t.size, 0.002, 0.06) * 0.2


def tick():
    t = T(0.08)
    return np.sin(2 * np.pi * 2600 * t) * np.exp(-t / 0.012) * 0.12


def blip():
    t = T(0.18)
    return (np.sin(2 * np.pi * 1320 * t) + 0.4 * np.sin(2 * np.pi * 1980 * t)) * env(t.size, 0.002, 0.04) * 0.14


def swish():
    return sweep_noise(0.5, 900, 6000, 0.45) * 0.5


def whoosh():
    x = sweep_noise(0.75, 250, 4200, 0.6) * 0.55
    t = T(0.75)
    rumble = lp(rng.standard_normal(t.size), 180) * np.sin(np.pi * t / 0.75) ** 2 * 0.6
    return x + rumble


def hit():
    t = T(3.2)
    f = 42 + 60 * np.exp(-t / 0.06)
    sub = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.7) * 0.9
    crack = bp(rng.standard_normal(t.size), 300, 6000) * np.exp(-t / 0.05) * 0.5
    # a bright shimmer that blooms under the logo (G, B, D, two octaves up)
    shim = sum(np.sin(2 * np.pi * hz * t + i) for i, hz in enumerate((1568.0, 1975.5, 2349.3, 3136.0)))
    shim *= np.minimum(1, t / 0.03) * np.exp(-t / 1.1) * 0.06
    return np.tanh(1.3 * (sub + crack)) * 0.7 + shim


def thud():
    t = T(0.6)
    f = 55 + 70 * np.exp(-t / 0.04)
    return np.tanh(1.5 * (np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.18)
                          + hp(rng.standard_normal(t.size), 2000) * np.exp(-t / 0.004) * 0.3)) * 0.55


def chime():
    t = T(1.8)
    x = np.zeros(t.size)
    for f0, d in ((1318.5, 0.0), (1975.5, 0.09)):      # E6 then B6
        tt = np.maximum(0, t - d)
        for k, a in ((1, 1), (2.76, 0.3), (5.4, 0.12)):  # bell-ish partials
            x += np.sin(2 * np.pi * f0 * k * tt) * a * np.exp(-tt / (0.6 / k)) * (t >= d)
    return x * np.minimum(1, t / 0.003) * 0.09


def deny():
    t = T(0.36)
    sq = lambda f, a, b: np.sign(np.sin(2 * np.pi * f * t)) * ((t >= a) & (t < b)) * np.exp(-(t - a).clip(0) / 0.08)
    return lp(sq(196, 0, 0.14) + sq(156, 0.15, 0.34), 1800) * 0.11 + thud()[: t.size] * 0.5


def ping():
    """the logo's signal: a soft sonar ping that rises a touch, with a quiet echo"""
    t = T(0.7)
    f = 1568.0 * (1 + 0.04 * (1 - np.exp(-t / 0.05)))
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * env(t.size, 0.004, 0.12)
    x += 0.5 * np.sin(2 * np.pi * 3136.0 * t) * env(t.size, 0.002, 0.05)
    d = int(0.16 * SR)
    x[d:] += 0.3 * x[:-d]
    return x * 0.13


def stream():
    """a quick shower of tiny data blips while the file moves"""
    n = int(1.0 * SR)
    x = np.zeros((n, 2))
    for k in range(26):
        at = k / 26 * 0.9 + rng.random() * 0.02
        f = 2000 + rng.random() * 3000
        tt = T(0.04)
        add(x, at, np.sin(2 * np.pi * f * tt) * np.exp(-tt / 0.008) * 0.05 * np.sin(np.pi * k / 26), pan=rng.random() * 1.4 - 0.7)
    return x


FX = {"key": key, "enter": enter, "pop": pop, "tick": tick, "blip": blip, "swish": swish,
      "whoosh": whoosh, "hit": hit, "thud": thud, "chime": chime, "deny": deny, "stream": stream, "ping": ping}
# how much of each effect goes to the reverb
SEND = {"hit": 0.5, "chime": 0.6, "whoosh": 0.3, "swish": 0.3, "pop": 0.25, "thud": 0.3, "blip": 0.3, "tick": 0.3, "ping": 0.5}
# where a whoosh peaks relative to its cue (they are cued ahead of the cut)
PAN = {"whoosh": 0.0}


def build(cues, duration):
    n = int(duration * SR) + SR
    dry = np.zeros((n, 2))
    send = np.zeros((n, 2))
    for c in cues:
        x = FX[c["type"]]() * c.get("gain", 1)
        if x.ndim == 2:
            dry[int(c["t"] * SR): int(c["t"] * SR) + x.shape[0]] += x[: max(0, n - int(c["t"] * SR))]
            continue
        pan = PAN.get(c["type"], (rng.random() - 0.5) * 0.3)
        add(dry, c["t"], x, pan=pan)
        if c["type"] in SEND:
            add(send, c["t"], x * SEND[c["type"]], pan=pan)
    ir = reverb_ir(2.8, 0.9)
    wet = np.stack([signal.fftconvolve(send[:, ch], ir[:, ch])[:n] for ch in range(2)], axis=1)
    out = (dry + wet * 0.6)[: int(duration * SR)]
    return np.clip(out, -0.98, 0.98)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cues", default=os.path.join(HERE, "cues.json"))
    ap.add_argument("--duration", type=float, required=True)
    ap.add_argument("--out", default=os.path.join(HERE, "sfx.wav"))
    args = ap.parse_args()
    cues = json.load(open(args.cues))
    sf.write(args.out, build(cues, args.duration), SR, subtype="PCM_24")
    print(f"sfx: {len(cues)} cues -> {args.out}")


if __name__ == "__main__":
    main()
