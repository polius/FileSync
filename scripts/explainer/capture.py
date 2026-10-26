#!/usr/bin/env python3
"""Capture the explainer: drive the web page in headless Chromium, one frame at a time.

The page (web/) is a pure function of the video timestamp, so we don't screen-
record — we set the time, screenshot, repeat. That makes every frame reproducible
and lets us supersample (render at Nx and downscale) for crisp type.

  capture.py --out frames                    # the whole video, 2x supersampled
  capture.py --preview 1.2,3.4,9.0           # a few stills into preview/ (fast, 1x)
  capture.py --out frames --frames 0:120     # a slice (used by --parallel)
  capture.py --cues cues.json                # the sound-effect cue list only
"""
from __future__ import annotations

import argparse
import functools
import http.server
import json
import os
import socketserver
import subprocess
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
APP = os.path.join(HERE, "..", "..", "web")


class _Handler(http.server.SimpleHTTPRequestHandler):
    """The app's web/ at the root, so the film can load the real index.html and
    app.css; the film itself under /film/."""

    def translate_path(self, path):
        if path.startswith("/film/"):
            return os.path.join(WEB, path[len("/film/"):].split("?")[0])
        return super().translate_path(path)

    def log_message(self, *a):  # keep the console clean
        pass


def serve(directory):
    handler = functools.partial(_Handler, directory=directory)
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    httpd.allow_reuse_address = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def new_page(pw, port, scale):
    browser = pw.chromium.launch(args=[
        "--force-color-profile=srgb", "--hide-scrollbars",
        "--disable-lcd-text", "--font-render-hinting=none",
        "--force-device-scale-factor=%d" % scale,
    ])
    page = browser.new_page(viewport={"width": 1920, "height": 1080},
                            device_scale_factor=scale)
    page.goto(f"http://127.0.0.1:{port}/film/index.html", wait_until="load")
    return browser, page


def init_page(page, timeline):
    page.evaluate("(tl) => window.__init(tl)", timeline)
    page.evaluate("window.__ready")


def capture_poster(pw, port, timeline, t, scale, out):
    """One still, downscaled exactly like the video encode, with the README play
    affordance layered on top (used for web/assets/video-poster).

    No film grain: it exists to mask banding in *motion*, and as a PNG it would
    triple the file size for nothing.
    """
    browser, page = new_page(pw, port, scale)
    try:
        init_page(page, timeline)
        page.evaluate("(t) => window.__render(t)", t)
        page.evaluate("window.__poster()")
        raw = os.path.join(HERE, "_poster_raw.png")
        page.screenshot(path=raw)
    finally:
        browser.close()

    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", raw,
         "-vf", "scale=1920:1080:flags=lanczos,format=rgb24",
         "-compression_level", "100", "-frames:v", "1", "-update", "1", out],
        check=True)
    os.remove(raw)
    print(f"poster t={t:.2f}s -> {out}  ({os.path.getsize(out) / 1e3:.0f} kB)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeline", default=os.path.join(HERE, "timeline.json"))
    ap.add_argument("--out", default=os.path.join(HERE, "frames"))
    ap.add_argument("--scale", type=int, default=2)
    ap.add_argument("--preview", default=None,
                    help="comma-separated timestamps -> preview/N.png (1x, fast)")
    ap.add_argument("--poster", default=None,
                    help="timestamp -> a 1080p still with a play button (README thumbnail)")
    ap.add_argument("--poster-out",
                    default=os.path.join(HERE, "..", "..", "web", "assets", "video-poster.png"),
                    help="where --poster writes (defaults to web/assets/video-poster.png)")
    ap.add_argument("--cues", default=None,
                    help="write the scenes' sound-effect cue list to this JSON file and stop")
    ap.add_argument("--frames", default=None, help="start:end frame range")
    ap.add_argument("--prefix", default="f")
    args = ap.parse_args()

    timeline = json.load(open(args.timeline))
    fps, dur = timeline["fps"], timeline["video_end"]

    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        httpd, port = serve(APP)
        try:
            if args.poster is not None:
                capture_poster(pw, port, timeline, float(args.poster),
                               args.scale, args.poster_out)
                return

            if args.cues is not None:
                browser, page = new_page(pw, port, 1)
                init_page(page, timeline)
                cues = page.evaluate("window.__cues()")
                browser.close()
                with open(args.cues, "w") as f:
                    json.dump(cues, f, indent=1)
                print(f"cues: {len(cues)} -> {args.cues}")
                return

            if args.preview is not None:
                scale = args.scale if args.scale != 2 else 1
                browser, page = new_page(pw, port, scale)
                init_page(page, timeline)
                out = os.path.join(HERE, "preview")
                os.makedirs(out, exist_ok=True)
                for i, ts in enumerate(args.preview.split(",")):
                    t = float(ts)
                    page.evaluate("(t) => window.__render(t)", t)
                    page.screenshot(path=os.path.join(out, f"p{i:02d}_{t:06.2f}s.png"))
                    print(f"preview {t:6.2f}s -> preview/p{i:02d}_{t:06.2f}s.png")
                browser.close()
                print(f"done: {len(args.preview.split(','))} stills in preview/ (scale {scale}x)")
                return

            os.makedirs(args.out, exist_ok=True)
            start, end = 0, int(round(dur * fps))
            if args.frames:
                a, b = args.frames.split(":")
                start, end = int(a), int(b)
            browser, page = new_page(pw, port, args.scale)
            init_page(page, timeline)
            for i in range(start, end):
                page.evaluate("(t) => window.__render(t)", i / fps)
                page.screenshot(path=os.path.join(args.out, f"{args.prefix}{i:05d}.png"))
                if i % 60 == 0:
                    print(f"  frame {i}/{end}  (t={i / fps:.1f}s)", flush=True)
            browser.close()
            print(f"done: frames {start}..{end} -> {args.out}")
        finally:
            httpd.shutdown()


if __name__ == "__main__":
    main()
