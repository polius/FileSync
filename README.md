<div align="center">
<img src="web/assets/icon.png" alt="FileSync Logo" width="80">
<h1 align="center">FileSync</h1>

**Send files from one device to many, in real time — private, peer-to-peer, with no size limit.**

<p align="center">
<a href="https://github.com/polius/filesync/actions/workflows/release.yml"><img src="https://github.com/polius/filesync/actions/workflows/release.yml/badge.svg"></a>&nbsp;<a href="https://github.com/polius/filesync/releases"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/polius/filesync"></a>&nbsp;<a href="https://hub.docker.com/r/poliuscorp/filesync"><img alt="Docker Pulls" src="https://img.shields.io/docker/pulls/poliuscorp/filesync"></a>&nbsp;<a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-blue.svg"></a>
</p>

<br>

![FileSync](web/assets/filesync.png?v=4.3.0)

</div>

## Features

- **Private**: files go directly between browsers over encrypted WebRTC; the server never sees them.
- **Any file size**: files stream to disk as they arrive, so memory use stays flat no matter the size.
- **Automatic resume**: interrupted transfers reconnect and continue from where they stopped.
- **One-to-many**: share a room link or QR code and send to many devices at once.
- **Works across networks**: direct connection when possible, automatic relay when not.
- **No installs or accounts**: recipients just open a link; rooms can be password-protected.
- **Self-hosted**: a single Docker image you run yourself.

## Self-hosting

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/)
- [Docker Compose](https://docs.docker.com/compose/install/)

### Option A — HTTP (quick local test)

For quickly testing the app locally — not meant for production. Use [Option B](#option-b--https-own-domain-recommended) instead.

1. Download [`deploy/docker-compose.yml`](deploy/docker-compose.yml).
2. Start it:

```bash
docker compose up -d
```

Open `http://localhost` on the machine running Docker.

### Option B — HTTPS (own domain, recommended)

1. Download [`deploy/docker-compose-ssl.yml`](deploy/docker-compose-ssl.yml) and [`deploy/Caddyfile`](deploy/Caddyfile).
2. Open `Caddyfile` and replace `yourdomain.com` (the first line) with your domain. Leave the rest of the file as it is.
3. Start it:

```bash
docker compose -f docker-compose-ssl.yml up -d
```

Open `https://yourdomain.com`.

## Required ports

Open these on your server's firewall:

| Port | Protocol | Purpose |
|---|---|---|
| `80` (HTTP) / `443` (HTTPS) | TCP | Web interface |
| `3478` | TCP + UDP | STUN/TURN, peer-to-peer connection setup |
| `50000–50100` | UDP | TURN relay range, used when a direct connection isn't possible |

The 50000–50100 UDP range carries relayed traffic for the minority of connections that can't go direct, typically a peer behind symmetric NAT or a firewall that blocks UDP.

## Customizing ports (optional)

**HTTP port.** In `docker-compose.yml`, change the **first** number of the `filesync` port mapping. The second is the container's internal port; leave it as `80`:

```yaml
ports:
  - "8080:80"   # serve on http://localhost:8080
```

**HTTPS port.** Keep Caddy on `443`. For a non-standard external port, put your own reverse proxy in front, terminate TLS there, and forward to FileSync's internal HTTP port.

## How it works

FileSync uses native [WebRTC](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API) to transfer files directly between browsers, with no intermediate server in the data path. A WebSocket signaling server (served at `/ws` by the FileSync app itself) assists with connection setup only — relaying SDP offers/answers and ICE candidates between peers; once the peer-to-peer connection is established, file bytes flow directly between browsers and the server is no longer involved.

On the receiving side, the first save method the browser supports is used, in this order:

1. **File System Access API** — streams to a file you pick. Desktop Chromium browsers (Chrome, Edge, Brave, Opera) over HTTPS.
2. **Service Worker** — streams into a normal browser download. All modern browsers over HTTPS.
3. **Blob** — buffers the entire file in memory before saving. Last resort; the only option over plain HTTP.

The first two require a secure context (HTTPS or localhost), so serving FileSync over HTTPS is recommended: it enables memory-safe transfers of any size.

![File Transfer - https://xkcd.com/949](web/assets/comic.png)

*Comic: [xkcd #949 — "File Transfer"](https://xkcd.com/949) by [Randall Munroe](https://xkcd.com), licensed under [CC BY-NC 2.5](https://creativecommons.org/licenses/by-nc/2.5/).*

## Related projects

If you prefer the terminal, check out [fsend](https://github.com/polius/fsend) — fast, private file sharing from your command line.

## License

Released under the [MIT License](LICENSE).
