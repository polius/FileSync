# FileSync E2E tests

Drives real browsers (Chromium, Firefox, WebKit) against a running FileSync
deployment to verify that file transfers work end-to-end across the matrix of
{browser engine} × {sink mode} × {ICE mode}.

This folder is **not** packaged into the Docker image — the Dockerfile only
copies `api/`, `web/`, and `nginx.conf`. Tests run on the host.

## Install

```bash
cd e2e
npm install
npx playwright install chromium firefox webkit
```

## Run

```bash
# Single-cell smoke (Chromium / SW sink / auto ICE / 100 MB):
npm run smoke

# Full matrix (defaults: all engines, all sinks, auto/stun/turn, 100 MiB):
npm run matrix

# Override anything (e.g. point at the live dev deployment, bump to 1 GiB):
node run.mjs --engines=chromium,webkit --sinks=sw --ice=auto --size=1G \
             --base-url=https://dev.filesync.app
```

## Flags

| flag           | default                  | notes |
|----------------|--------------------------|-------|
| `--base-url`   | `http://localhost`       | the FileSync deployment under test |
| `--engines`    | `chromium,firefox,webkit`| comma-separated; Edge ≈ chromium |
| `--sinks`      | `sw,fs,blob`             | `fs` skipped on non-Chromium by spec |
| `--ice`        | `auto,stun,turn`         | passes through `?ice=` to the app |
| `--size`       | `100M`                   | suffixes `K`/`M`/`G`; Blob auto-capped at 400 MiB |
| `--smoke`      | _off_                    | shortcut: `chromium`, `sw`, `auto` |
| `--keep`       | _off_                    | keep downloaded files in `downloads/` for inspection |

## What "n/a" means in the matrix

- **FS Access on Firefox / WebKit** — API doesn't exist in those engines (spec, not bug).
- **Blob sink at large sizes** — documented practical ceiling is ~500 MB. We
  auto-skip Blob cells when `size > 400 MB` rather than report a misleading ❌.

## What this does NOT test

- **Real mobile WebRTC.** Playwright's mobile presets are UA + viewport only;
  they run the desktop engine binary. For real Mobile Safari / Chrome Android
  behaviour you need actual devices or a service like BrowserStack.
- **Cross-network NAT traversal.** All tests here run sender + receiver on the
  same machine. To prove TURN-relay actually works across symmetric NATs you
  need two real networks.

## Interruption harness (`interruption/`)

Drives a sender + receiver (two Chromium browsers) and injects mid-transfer
network interruptions; see the header of `interruption/run.mjs` for the scenario
list. Highlights:

```bash
# 20s receiver blackout -> transparent resume, byte-exact file
cd interruption && node run.mjs --scenario=t2 --freeze-ms=20000 --sink=sw --ice=auto --observe=90000

# "Download all" bundle: 20s blackout during file 2 of 2 -> transparent resume;
# the delivered files.zip is unpacked and every member hash is verified
node run.mjs --scenario=zip --sink=sw --ice=auto --observe=90000
```
