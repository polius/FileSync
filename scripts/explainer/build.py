#!/usr/bin/env python3
"""Build the FileSync video end to end.

  narration (Kokoro) -> timeline.json -> cues.json -> headless-Chromium frames ->
  voice + ducked score + sound design -> h264 -> filesync-video.mp4 (+ captions)

Run it from anywhere; paths are resolved relative to this file.

  python build.py                      # the whole thing
  python build.py --skip-capture       # re-encode from frames/ already on disk
  python build.py --skip-narration     # reuse audio/ + timeline.json
  python build.py --no-music
  python build.py --output ~/Desktop/filesync-video.mp4
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
FRAMES = os.path.join(HERE, "frames")
CAPTIONS = os.path.join(HERE, "captions")
PY = sys.executable


def run(cmd, **kw):
    print("  $", " ".join(str(c) for c in cmd), flush=True)
    subprocess.run(cmd, check=True, **kw)


def loudnorm(src, dst, i=-16.0, tp=-1.5):
    """Two-pass EBU R128 normalization: measure, then apply as one linear gain
    (single-pass loudnorm rides the gain and audibly pumps a music bed)."""
    out = subprocess.run(["ffmpeg", "-hide_banner", "-i", src, "-af",
                          f"loudnorm=I={i}:TP={tp}:LRA=11:print_format=json", "-f", "null", "-"],
                         check=True, capture_output=True, text=True).stderr
    m = json.loads(out[out.rindex("{"): out.rindex("}") + 1])
    run(["ffmpeg", "-v", "error", "-y", "-i", src, "-af",
         f"loudnorm=I={i}:TP={tp}:LRA=11:measured_I={m['input_i']}:measured_TP={m['input_tp']}:"
         f"measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true",
         "-ar", "48000", "-ac", "2", dst])


def write_srt(timeline, path):
    """One cue per sentence, timed proportionally inside each spoken line."""
    def fmt(t):
        h = int(t // 3600); m = int(t % 3600 // 60); s = int(t % 60)
        ms = int(round((t - int(t)) * 1000))
        return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

    cues = []
    for seg in timeline["segments"]:
        parts = [p for p in re.split(r"(?<=[.?!]) +", seg["vo"].strip()) if p]
        dur = seg["end"] - seg["start"]
        total = sum(len(p) for p in parts) or 1
        tc = seg["start"]
        for p in parts:
            d = dur * len(p) / total
            cues.append((tc, tc + d, p))
            tc += d
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        for i, (a, b, text) in enumerate(cues, 1):
            f.write(f"{i}\n{fmt(a)} --> {fmt(b)}\n{text}\n\n")
    return len(cues)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeline", default=os.path.join(HERE, "timeline.json"))
    ap.add_argument("--output", default=os.path.join(HERE, "filesync-video.mp4"))
    ap.add_argument("--scale", type=int, default=2, help="capture supersample factor")
    ap.add_argument("--workers", type=int, default=min(8, max(1, (os.cpu_count() or 4) - 2)),
                    help="parallel capture processes")
    ap.add_argument("--crf", type=int, default=17)
    ap.add_argument("--grain", type=int, default=3, help="film grain strength (0 = off)")
    ap.add_argument("--skip-narration", action="store_true")
    ap.add_argument("--skip-capture", action="store_true")
    ap.add_argument("--no-music", action="store_true")
    ap.add_argument("--music-level", type=float, default=-23.5, help="score loudness, LUFS (before ducking)")
    ap.add_argument("--sfx-gain", type=float, default=0.75)
    ap.add_argument("--preview", default=None,
                    help="comma-separated timestamps: write stills to preview/ and stop")
    ap.add_argument("--poster", default=None,
                    help="timestamp: rewrite the README thumbnail and stop")
    args = ap.parse_args()
    capture_py = os.path.join(HERE, "capture.py")

    # 0) stills (visual iteration / README art — no audio, no encode) --------
    if args.preview is not None:
        run([PY, capture_py, "--preview", args.preview, "--scale", "1"])
        return
    if args.poster is not None:
        run([PY, capture_py, "--poster", args.poster, "--scale", str(args.scale)])
        return

    t0 = time.time()

    # 1) narration -> audio/*.wav + narration.wav + timeline.json -------------
    if not args.skip_narration:
        print("[1/7] narration")
        run([PY, os.path.join(HERE, "narration.py")])
    timeline = json.load(open(args.timeline))
    dur, fps = timeline["video_end"], timeline["fps"]
    total_frames = int(round(dur * fps))
    print(f"      {dur:.2f}s @ {fps}fps  = {total_frames} frames")

    # 2) the scenes' sound-effect cues ----------------------------------------
    print("[2/7] cues")
    cues = os.path.join(HERE, "cues.json")
    run([PY, capture_py, "--cues", cues])

    # 3) frames --------------------------------------------------------------
    if not args.skip_capture:
        workers = max(1, args.workers)
        print(f"[3/7] capture frames  ({workers} worker{'s' if workers > 1 else ''})")
        if os.path.isdir(FRAMES):
            shutil.rmtree(FRAMES)
        os.makedirs(FRAMES, exist_ok=True)
        # contiguous frame ranges -> one complete f%05d.png sequence
        bounds = [round(total_frames * i / workers) for i in range(workers + 1)]
        procs = [subprocess.Popen([PY, capture_py, "--out", FRAMES, "--scale", str(args.scale),
                                   "--frames", f"{bounds[i]}:{bounds[i + 1]}"])
                 for i in range(workers)]
        if max(p.wait() for p in procs) != 0:
            sys.exit("capture failed")

    # 4) audio ---------------------------------------------------------------
    print("[4/7] audio")
    voice = os.path.join(HERE, "narration_norm.wav")
    loudnorm(os.path.join(HERE, "narration.wav"), voice, -16)
    sfx = os.path.join(HERE, "sfx.wav")
    run([PY, os.path.join(HERE, "sfx.py"), "--cues", cues, "--duration", str(dur), "--out", sfx])
    inputs = ["-i", voice, "-i", sfx]
    graph = f"[1:a]volume={args.sfx_gain}[fx];"
    if args.no_music:
        graph += "[0:a][fx]amix=inputs=2:duration=first:normalize=0[pre]"
    else:
        music_raw, music = os.path.join(HERE, "music.wav"), os.path.join(HERE, "music_norm.wav")
        run([PY, os.path.join(HERE, "music.py"), "--timeline", args.timeline, "--cues", cues, "--out", music_raw])
        loudnorm(music_raw, music, args.music_level, -3)
        inputs += ["-i", music]
        # the voice ducks the score: ~7 dB under speech, back up in the gaps
        graph += ("[0:a]asplit=2[v][key];"
                  "[2:a][key]sidechaincompress=threshold=0.025:ratio=5:attack=40:release=450:makeup=1[bed];"
                  "[v][bed][fx]amix=inputs=3:duration=first:normalize=0[pre]")
    pre = os.path.join(HERE, "mix_pre.wav")
    run(["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", graph, "-map", "[pre]",
         "-ar", "48000", "-ac", "2", "-c:a", "pcm_s24le", pre])
    mix = os.path.join(HERE, "mix.wav")
    loudnorm(pre, mix, -14, -1.0)       # streaming loudness, true peak under -1 dB

    # 5) video-only ----------------------------------------------------------
    print("[5/7] encode video")
    video_only = os.path.join(HERE, "video_only.mp4")
    # supersampled frames -> 1080p (lanczos), tagged BT.709 so players don't
    # shift the colours, then a whisper of temporal grain against banding
    vf = ("scale=1920:1080:flags=lanczos:out_color_matrix=bt709:out_range=tv,"
          f"noise=alls={args.grain}:allf=t+u,format=yuv420p")
    run(["ffmpeg", "-v", "error", "-stats", "-y", "-framerate", str(fps), "-i", os.path.join(FRAMES, "f%05d.png"),
         "-vf", vf, "-c:v", "libx264", "-preset", "slow", "-crf", str(args.crf),
         "-profile:v", "high", "-level", "4.2", "-colorspace", "bt709", "-color_primaries", "bt709",
         "-color_trc", "bt709", "-color_range", "tv", "-movflags", "+faststart", video_only])

    # 6) captions ------------------------------------------------------------
    print("[6/7] captions")
    n = write_srt(timeline, os.path.join(CAPTIONS, "filesync-video.srt"))
    print(f"      {n} cues -> captions/filesync-video.srt (sidecar, off by default)")

    # 7) mux -----------------------------------------------------------------
    print("[7/7] mux")
    out = os.path.abspath(os.path.expanduser(args.output))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    run(["ffmpeg", "-v", "error", "-y", "-i", video_only, "-i", mix,
         "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "256k",
         "-movflags", "+faststart", out])
    print(f"\ndone in {time.time() - t0:.0f}s -> {out}  ({os.path.getsize(out) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
