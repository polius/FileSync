#!/usr/bin/env python3
"""Narration: the single source of truth for the FileSync video's words and timing.

Audio-first, exactly like the old pipeline: every line is synthesized and
measured, then a timeline is laid out so the visuals can track the voice. On top
of that we export *word onsets* — for each line you can tag a spoken substring
(an "anchor") and get the moment it is said; the web scenes use those to reveal
things exactly in step with the narration.

Outputs (all git-ignored):
  audio/<id>.wav      one clip per line (Kokoro neural TTS)
  narration.wav       the stitched voice track (48 kHz stereo)
  timeline.json       segments + scene windows + onsets, consumed by the renderer

Usage:
  python narration.py              # synthesize (Kokoro) then lay out the timeline
  python narration.py --reuse      # reuse audio/*.wav, just re-lay out the timeline
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
AUD = os.path.join(HERE, "audio")

# ---- voice -----------------------------------------------------------------
MODEL = os.environ.get("KOKORO_MODEL", os.path.join(HERE, "models", "kokoro-v1.0.onnx"))
VOICES = os.environ.get("KOKORO_VOICES", os.path.join(HERE, "models", "voices-v1.0.bin"))
VOICE = os.environ.get("KOKORO_VOICE", "af_heart")   # warm, confident
SPEED = float(os.environ.get("KOKORO_SPEED", "1.02"))
LANG = "en-us"

# ---- pacing ----------------------------------------------------------------
FPS = int(os.environ.get("FPS", "60"))
LEAD_IN = 2.4              # the cold open: the logo's signal comes on before any voice
GAP_SAME = 0.45            # pause between two lines in the same scene
GAP_SCENE = 1.2            # pause when the scene changes: long enough to finish
                           # reading, short enough to keep a promo's momentum
TAIL = 3.2                 # hold after the last line (settled end card)
# extra hold before a line (on top of the normal gap), to let a visual land
GAP_EXTRA = {
    "room2": 0.2,          # the room settles before the link is shared
    "send1": 0.5,          # the guests have joined before the drop
    "send2": 0.55,         # the files land before anyone downloads
    "direct2": 0.45,       # the files reach both phones first
    "verified2": 0.5,      # the key splits off before it is used
    "big2": 0.6,           # let the stream run for a beat
    "big3": 0.55,          # the transfer resumes and finishes
    "self2": 0.1,
    "outro2": -0.3,        # keep the closing line close to the name
}

# How long before its first line a scene should appear (seconds). The default
# is half the scene-change gap.
SCENE_LEAD = {"outro": 0.55}

# ---- the script ------------------------------------------------------------
# id, scene, voice-over, anchors {label: spoken substring} — anchors mark when a
# word is actually spoken so the visuals can reveal in sync. Short, warm lines:
# this is a promo, not a manual. The name is spelled "File Sync" here so the
# voice says two words instead of running them together.
LINES = [
    ("open1", "open", "This is File Sync.",
     {}),
    ("open2", "open", "Send files from one device to many, in real time.",
     {"many": "to many", "real": "in real time"}),
    ("room1", "room", "Open it, and you get a room.",
     {"room": "a room"}),
    ("room2", "room", "Share the link, or let people scan the QR code.",
     {"link": "the link", "qr": "scan"}),
    ("send1", "room", "Drop in files, or a whole folder.",
     {"drop": "Drop", "folder": "folder"}),
    ("send2", "room", "Everyone in the room can grab them right away. No installs, no accounts.",
     {"everyone": "Everyone", "grab": "grab", "installs": "No installs", "accounts": "no accounts"}),
    ("direct1", "direct", "Files go straight from browser to browser, encrypted on the way.",
     {"straight": "straight", "encrypted": "encrypted"}),
    ("direct2", "direct", "The server only introduces the devices, and never sees what you send.",
     {"server": "The server", "introduces": "introduces", "never": "never sees"}),
    ("verified1", "verified", "Every link carries a key that never reaches the server.",
     {"link": "Every link", "key": "a key", "never": "never reaches"}),
    ("verified2", "verified", "Joining with it proves that nobody, not even the server, is in between.",
     {"proves": "proves", "nobody": "nobody", "between": "in between"}),
    ("big1", "big", "There is no size limit. Files stream straight to disk.",
     {"size": "no size limit", "disk": "to disk"}),
    ("big2", "big", "If the connection drops, it picks up right where it stopped.",
     {"drops": "drops", "picks": "picks up"}),
    ("big3", "big", "And every file is checked when it lands.",
     {"checked": "checked", "lands": "lands"}),
    ("self1", "selfhost", "File Sync is free and open source.",
     {"free": "free", "open": "open source"}),
    ("self2", "selfhost", "Run your own with a single Docker command.",
     {"own": "your own", "command": "single Docker command"}),
    ("outro1", "outro", "File Sync.",
     {}),
    ("outro2", "outro", "Any file, to every device, in real time.",
     {"file": "Any file", "every": "every device", "real": "in real time"}),
]


def run(cmd):
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def duration(path):
    out = subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", path])
    return float(out.strip())


# Words the voice should say differently: (Kokoro's phonemes, ours).
PHONEMES = []


def synth():
    """Synthesize every line with the local Kokoro neural voice -> audio/<id>.wav."""
    os.makedirs(AUD, exist_ok=True)
    if not os.path.exists(MODEL) or not os.path.exists(VOICES):
        sys.exit(f"missing Kokoro models:\n  {MODEL}\n  {VOICES}\n"
                 "run ./setup.sh (or set KOKORO_MODEL / KOKORO_VOICES)")
    import soundfile as sf
    from kokoro_onnx import Kokoro
    kokoro = Kokoro(MODEL, VOICES)
    for sid, _scene, vo, _anchors in LINES:
        path = os.path.join(AUD, f"{sid}.wav")
        ph = kokoro.tokenizer.phonemize(vo, LANG)
        for a, b in PHONEMES:
            ph = ph.replace(a, b)
        samples, sr = kokoro.create(ph, voice=VOICE, speed=SPEED, is_phonemes=True)
        sf.write(path, samples, sr)
        print(f"  synth {sid:8s} {len(samples) / sr:5.2f}s  {vo}")


_WHISPER = []


def whisper_map(path, vo):
    """Map character positions in `vo` to seconds inside its clip from real word
    timestamps (faster-whisper). Also prints what was heard, so a mispronounced
    word shows up in the build log. Returns None when whisper is unavailable."""
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return None
    import difflib
    import numpy as np
    import soundfile as sf
    from scipy.signal import resample_poly
    if not _WHISPER:
        _WHISPER.append(WhisperModel("small.en", device="cpu", compute_type="int8",
                                     download_root=os.path.join(HERE, "models", "whisper")))
    x, sr = sf.read(path, dtype="float32")
    x = resample_poly(x if x.ndim == 1 else x.mean(axis=1), 16000, sr).astype(np.float32)
    segs, _ = _WHISPER[0].transcribe(x, word_timestamps=True, language="en")
    heard = [w for s in segs for w in s.words]
    print(f"    heard: {' '.join(w.word.strip() for w in heard)}")
    if not heard:
        return None
    # align letters only: whisper splits and spells words its own way
    norm = lambda c: c.lower() if c.isalnum() else ""
    vo_pos = [i for i, c in enumerate(vo) if norm(c)]
    vo_l = "".join(norm(vo[i]) for i in vo_pos)
    hw_l, hw_t = "", []
    for w in heard:
        for c in w.word:
            if norm(c):
                hw_l += norm(c); hw_t.append(w.start)
    at = {}
    for a, b, n in difflib.SequenceMatcher(None, vo_l, hw_l, autojunk=False).get_matching_blocks():
        for k in range(n):
            at[vo_pos[a + k]] = hw_t[b + k]
    keys = sorted(at)

    def where(i):
        later = [k for k in keys if k >= i]
        return at[later[0]] if later else at[keys[-1]]
    return where


def make_silence(sec):
    sec = round(sec, 3)
    path = os.path.join(AUD, f"sil_{int(sec * 1000)}.wav")
    if not os.path.exists(path):
        run(["ffmpeg", "-y", "-f", "lavfi", "-t", f"{sec}",
             "-i", "anullsrc=r=24000:cl=mono", path])
    return path


def speech_map(path, vo):
    """Map character positions in `vo` to seconds inside its clip.

    Kokoro pauses at punctuation, so a plain character ratio drifts on lines
    with several clauses. Find the pauses in the audio, pair the longest ones
    with the punctuation breaks in the text, and interpolate by character
    count only inside each clause.
    """
    import numpy as np
    import soundfile as sf
    x, sr = sf.read(path)
    if x.ndim > 1:
        x = x.mean(axis=1)
    hop = int(sr * 0.01)
    rms = np.sqrt(np.convolve(x ** 2, np.ones(hop) / hop, "same")[::hop])
    loud = rms > max(1e-4, 0.08 * np.percentile(rms, 95))
    idx = np.flatnonzero(loud)
    if idx.size == 0:
        return lambda i: len(vo) and 0.0
    first, last = idx[0], idx[-1]
    # silent runs (>= 90 ms) strictly inside the speech
    pauses, run = [], None
    for k in range(first, last + 1):
        if not loud[k]:
            run = k if run is None else run
        elif run is not None:
            if k - run >= 9:
                pauses.append((k - run, run, k))
            run = None
    breaks = [m.end() for m in __import__("re").finditer(r"[,.;:?!\u2014]+\s*", vo) if m.end() < len(vo)]
    knots = [(0, first * 0.01), (len(vo), (last + 1) * 0.01)]
    if breaks and len(pauses) >= len(breaks):
        chosen = sorted(sorted(pauses, reverse=True)[:len(breaks)], key=lambda p: p[1])
        knots[1:1] = [(c, e * 0.01) for c, (_, _, e) in zip(breaks, chosen)]
        # the clause before each break ends where its pause starts
        ends = [(c - 1, s0 * 0.01) for c, (_, s0, _) in zip(breaks, chosen)]
        knots = sorted(knots + ends)
    cs, ts = zip(*knots)
    return lambda i: float(np.interp(i, cs, ts))


def onset(vo, start, where, sub):
    """Time (s) at which `sub` is spoken."""
    i = vo.find(sub)
    if i < 0:
        raise ValueError(f"anchor {sub!r} not found in {vo!r}")
    return round(start + where(i), 3)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reuse", action="store_true",
                    help="reuse audio/*.wav instead of re-synthesizing")
    args = ap.parse_args()

    if not args.reuse:
        print("synthesizing narration (Kokoro)")
        synth()

    durs = [duration(os.path.join(AUD, f"{sid}.wav")) for sid, *_ in LINES]

    # ---- lay out the timeline from real audio durations --------------------
    segs, parts, t = [], [make_silence(LEAD_IN)], LEAD_IN
    for i, (sid, scene, vo, anchors) in enumerate(LINES):
        if i > 0:
            gap = GAP_SCENE if scene != LINES[i - 1][1] else GAP_SAME
            gap += GAP_EXTRA.get(sid, 0.0)
            parts.append(make_silence(gap))
            t += gap
        start, dur = t, durs[i]
        clip = os.path.join(AUD, f"{sid}.wav")
        where = whisper_map(clip, vo) or speech_map(clip, vo)
        parts.append(os.path.join(AUD, f"{sid}.wav"))
        t += dur
        segs.append({
            "id": sid, "scene": scene, "vo": vo,
            "start": round(start, 3), "dur": round(dur, 3),
            "end": round(start + dur, 3),
            "onsets": {k: onset(vo, start, where, s) for k, s in anchors.items()},
        })
    parts.append(make_silence(TAIL))
    video_end = round(t + TAIL, 3)

    # ---- stitch the voice track -------------------------------------------
    listfile = os.path.join(AUD, "concat.txt")
    with open(listfile, "w") as f:
        for p in parts:
            f.write(f"file '{p}'\n")
    narration = os.path.join(HERE, "narration.wav")
    run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", listfile,
         "-ar", "48000", "-ac", "2", narration])

    # ---- scene windows (boundaries centred in the scene-change gaps) -------
    order = []
    for s in segs:
        if not order or order[-1]["name"] != s["scene"]:
            order.append({"name": s["scene"], "first": s["start"], "last_end": s["end"]})
        else:
            order[-1]["last_end"] = s["end"]
    scenes = []
    for i, sc in enumerate(order):
        if i == 0:
            start = 0.0
        elif sc["name"] in SCENE_LEAD:
            start = sc["first"] - SCENE_LEAD[sc["name"]]
        else:
            start = (order[i - 1]["last_end"] + sc["first"]) / 2
        scenes.append({"name": sc["name"], "start": round(start, 3)})
    for i in range(len(scenes)):
        scenes[i]["end"] = round(scenes[i + 1]["start"], 3) if i + 1 < len(scenes) else video_end

    timeline = {"fps": FPS, "video_end": video_end,
                "narration_dur": round(duration(narration), 3),
                "segments": segs, "scenes": scenes}
    with open(os.path.join(HERE, "timeline.json"), "w") as f:
        json.dump(timeline, f, indent=2)

    print(f"\nnarration {timeline['narration_dur']:.2f}s   video {video_end:.2f}s "
          f"({video_end / 60:.2f} min)")
    for sc in scenes:
        print(f"  {sc['name']:7s} {sc['start']:6.2f} -> {sc['end']:6.2f}")


if __name__ == "__main__":
    main()
