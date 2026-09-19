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

## TURN relay cells on localhost

The deployed coturn refuses to relay into private ranges (`--denied-peer-ip` in
`deploy/docker-compose.yml`: RFC1918, CGNAT `100.64/10`, IPv6 ULA + link-local)
so the TURN server can't be used as a pivot into the host's network. Loopback
and link-local are refused by coturn by default; the explicit lines for those
are belt-and-suspenders. Peers over the internet always present public
candidates, so real transfers are unaffected — but relay-forced tests against a
**localhost stack cannot connect**: two browsers on the Docker host only ever
offer private/loopback candidates, and every relayed path to them is refused by
design (observed as a fast 403 on the permission/channel bind, not a hang).

One edge case: a peer on the **server's own LAN**. The relayed path to its
private host candidate is now refused, and ICE falls back to the peer's public
srflx/relay candidates — which on a hairpin-challenged home router may not
connect. Deployments serving the outside world are unaffected.

- **Relay smoke against a real deployment** — the deny list is active, so this is
  also the check that the hardening didn't break legitimate relaying:

  ```bash
  node run.mjs --sinks=sw --ice=turn --size=20M --base-url=https://<your-domain>
  ```

- **Relay-forced local runs** (opt-in matrix `turn` cells via `--ice`, and the
  interruption `t3`/`t4`/`zip` scenarios) need coturn without the deny flags.
  Temporarily comment out the `--denied-peer-ip=` lines in **both**
  `deploy/docker-compose.yml` and `deploy/docker-compose-ssl.yml`, restart the
  stack, run the tests, then uncomment and restart again. Don't use
  `git checkout --` to "restore" — before this change is committed that would
  wipe the hardening instead of restoring it.

  The default `run.mjs` matrix is `auto,stun` for exactly this reason: its
  `turn` cells fail by design against the hardened stack. Opt in explicitly:

  ```bash
  node run.mjs --ice=auto,stun,turn
  ```

- **Negative check (optional)** — with the *default* stack, relaying to one of the
  server's private addresses must be refused. Run `turnutils_peer` on the
  server, then from a machine on the same network relay to it with
  `turnutils_uclient` (ephemeral creds from `/api/credentials`; the JWT payload
  is plain base64). Expected: `channel bind: error 403` within milliseconds.
  coturn also logs `A peer IP <ip> denied in the range: <range>` at ERROR level,
  but not for every refusal — treat the client-side 403 as the reliable signal.
  With the deny flags commented out, the same probe connects.

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
