# FileSync video

The FileSync promo: a **~66-second, 1920×1080, 60 fps MP4** with a neural
voice-over, an original synthesized score, and sound design cued from the
picture.

It is built from scratch: a small **web "video engine"** (HTML/CSS/JS)
rendered deterministically by headless Chromium, one frame at a time. The
pipeline is the one behind the [fsend](https://github.com/polius/fsend) and
[VAULT](https://github.com/polius/vault) videos.

Design rules the film follows, so any future edit stays on-model:

- **One idea per shot.** Every screen says one thing, in big type, and the
  narration says the same thing at the same moment.
- **Show the real app.** The room scene puts the actual `web/index.html` and
  `web/css/app.css` on screen, in a browser window and on two phones, filled
  in from the app's own templates and strings. When the UI changes, the film
  changes with it.
- **One device to many.** The host sends, two guests receive: the same three
  names (Teal Bison, Sapphire Goose, Yellow Raven) carry through every scene.
- **The logo's signal.** The film opens on the logo's arcs lighting up one by
  one. Behind everything, the same arcs rise from below the frame and a wave
  runs through them at every cut, and each cut is carried by a ring of signal.
  Orange is FileSync, blue is a transfer, green is verified.
- **Only true claims.** Everything said or shown matches the app, the README
  and the About panel. Check there before changing a line.
- **Every sound has a cause on screen.** Scenes register their own cues, so
  sound and picture cannot drift apart.

This folder holds **only the source**. Frames, audio, the model weights and the
MP4 itself are all generated and git-ignored. Regenerate with `./make.sh`.

---

## Why not a screen recording

If every pixel is a **pure function of the timestamp**, then

- the same input always produces the same frame (reviews are meaningful),
- we can render at 2× and downsample, so type and thin strokes stay crisp at
  1080p (supersampling),
- timing is driven by the *measured* narration audio, so the visuals stay in
  sync no matter how fast the voice reads.

So the "renderer" is a web page, and the "render farm" is `page.screenshot()`
in a loop. The app copies are iframes with the app's scripts removed and its
animations switched off; the scenes set their DOM for each frame.

Scene arc, timed to the narration:

```
open (the signal comes on, name)  →  room (share, drop, everyone grabs)  →  direct
     →  verified  →  big (any size, resume, SHA-256)  →  selfhost  →  outro
```

---

## Setup

Needs **Python 3.10+**, **ffmpeg**, and a network connection for the first run.

```sh
cd scripts/explainer
./setup.sh --models        # venv + deps + chromium + Kokoro weights (~340 MB)
```

Everything is installed *inside this folder* (`.venv/`, `models/`).

## Build

```sh
./make.sh                                       # the whole pipeline -> filesync-video.mp4
./make.sh --output ~/Desktop/filesync-video.mp4
```

Stages (`build.py` prints them as `[n/7]`):

1. **narration**: `narration.py` synthesizes every line with **Kokoro-82M**
   (local ONNX, voice `af_heart`) and lays out `timeline.json`: scene windows
   plus *word onsets*. Each clip is transcribed back with **faster-whisper**
   (`small.en`, fetched once into `models/whisper/`): its word timestamps place
   the onsets, so a visual lands on the exact word it is spoken, and the
   transcript is printed as `heard:`, so a mispronounced word shows up in the
   build log. The script spells the name "File Sync" so the voice says two
   words.
2. **cues**: the page is loaded once and the scenes' sound-effect cues are
   dumped to `cues.json`.
3. **capture**: `capture.py` serves the app's `web/` at the root and the film
   under `/film/`, then drives headless Chromium, calling `window.__render(t)`
   and screenshotting every frame at **2×**, across parallel workers.
4. **audio**: `sfx.py` renders the cues, `music.py` composes the score, the
   voice ducks the score through a sidechain compressor, and the mix is
   two-pass loudness-normalized.
5. **encode**: lanczos-downscale to 1080p, BT.709 tags, a whisper of grain,
   x264 CRF 17.
6. **captions**: a `.srt` sidecar, one cue per sentence.
7. **mux**.

Useful flags:

```sh
./make.sh --skip-capture          # re-encode / re-mix from frames/ on disk
./make.sh --skip-narration        # reuse audio/ + timeline.json
./make.sh --workers 4 --crf 16 --grain 0
FPS=30 ./make.sh                  # a faster draft (also re-times the narration)
```

To look at stills while iterating on the visuals (fast, 1×, no encode):

```sh
.venv/bin/python capture.py --preview 9.5,27,38      # -> preview/*.png
```

To write a thumbnail with a play button:

```sh
./make.sh --poster 6.6                                # -> web/assets/video-poster.png
```

---

## Files

| File | Role |
|---|---|
| `narration.py` | the script and pacing. **Start here** to change the wording. |
| `web/engine.js` | the renderer: `render(t)`, scene layers and cameras, push-through cuts with the signal ring, the arcs background, accent colour keys, the cue registry, and `appFrame()`, which loads the real app into an iframe |
| `web/scenes.js` | the seven scenes, `room()` (fills an app copy in the way `view.js` does), the pointer |
| `web/style.css` | palette (the app's dark theme and logo), type, window and phone frames, cards |
| `web/fonts/` | JetBrains Mono (OFL); Public Sans and Acme come from the app |
| `capture.py` | http server + Playwright frame loop (`--preview`, `--poster`, `--cues`) |
| `music.py` | the score: 118 BPM, Gmaj7–D6/9–Em7–Cmaj7; kick, hats, claps, bass, supersaw pad, pluck arpeggio, risers, sidechain, convolution reverb, arranged from the timeline |
| `sfx.py` | the sound design: whoosh, key, enter, pop, swish, hit, thud, chime, deny, blip, tick, stream, ping |
| `build.py` | orchestrates all seven stages |
| `setup.sh` / `make.sh` | one-time setup / one-shot build |

## Customizing

- **Wording and pacing**: edit `LINES` in `narration.py`. `GAP_SAME`,
  `GAP_SCENE` and `GAP_EXTRA` decide how fast the film feels. Adding a line?
  Give it a scene and, if a visual should land on a word, an anchor
  (`{"grab": "grab"}`); scenes read it with `api.on("<line-id>", "<anchor>")`.
- **Visuals**: `web/scenes.js` and `web/style.css`. A scene moves its camera
  with `camera(cam, t, keys)`, recolours the film with `api.accent(t, hex)`,
  sends a wave through the arcs with `api.pulse(t)`, and makes a sound with
  `api.cue(type, t, gain)`.
- **The app changed?** The window and phones pick up new markup and CSS on
  their own. If `view.js` changes what it writes into a row (a string, a
  state), mirror it in `room()` in `scenes.js`.

## Notes

- **Rendering cost is fill-rate bound.** Soft light is drawn with radial
  gradients, never `filter: blur()` on large layers. Film grain is added once
  by ffmpeg.
- Hidden scene layers use `display: none`, not `visibility: hidden`: a child
  set to `visibility: visible` by a reveal would otherwise show through.
- `at(parent, x, y, …)` already centres its child; don't add another
  `translate(-50%, -50%)` to it.
- Layout that depends on text size is measured in `afterFonts()`, which runs
  on the first rendered frame, before any transform is applied and after the
  app iframes have loaded. Give every element its real text before then.
- **Never scale the app copies with a transform.** A scaled iframe is a
  stretched bitmap and its text goes soft. `appFrame()` sizes the iframe in
  stage pixels and enlarges the app with CSS `zoom`, which lays it out at the
  bigger size; the window and phones are only ever translated. Rects from
  `getBoundingClientRect()` inside the frame already include the zoom.
- The app copies are moved, not scrolled (`room().scroll`), because a short
  page can't scroll its last card to the top. Only `#main` and the top nav
  move, so the drop overlay and toasts stay where the app puts them.
- `api.accent()` keys at or after the scene's start: the engine resets the
  accent to orange at every scene start.
- **Do not commit** `frames/`, `preview/`, `audio/`, `captions/`,
  `timeline.json`, `cues.json`, `*.wav`, `*.mp4`, `models/` or `.venv/`.
