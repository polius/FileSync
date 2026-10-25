# Third-party notices

FileSync includes the following third-party components.

| Component | Version | License | Where |
|---|---|---|---|
| [uqr](https://github.com/unjs/uqr) (based on Project Nayuki's QR Code generator) | 0.1.3 | MIT | `web/js/vendors/uqr.js` |
| [client-zip](https://github.com/Touffy/client-zip) | 2.x | MIT | `web/js/vendors/client-zip.min.js` |
| [Bootstrap Icons](https://icons.getbootstrap.com) (icon paths in the SVG sprite) | 1.11.3 | MIT | `web/index.html` |
| [Public Sans](https://github.com/uswds/public-sans) | Google Fonts v21 (Fontsource 5.3.0) | SIL Open Font License 1.1 | `web/assets/fonts/public-sans-*.woff2` |
| [Acme](https://fonts.google.com/specimen/Acme) | 1.x | SIL Open Font License 1.1 | `web/assets/fonts/acme-latin.woff2` |
| [xkcd #949 "File Transfer"](https://xkcd.com/949) by Randall Munroe | | CC BY-NC 2.5 | `web/assets/comic*.png` |

The container image also runs [nginx](https://nginx.org) (BSD-2-Clause), [Python](https://www.python.org) (PSF), [FastAPI](https://fastapi.tiangolo.com) (MIT), [Uvicorn](https://www.uvicorn.org) (BSD-3-Clause) and [tini](https://github.com/krallin/tini) (MIT). The compose files run [coturn](https://github.com/coturn/coturn) (BSD-3-Clause) and, for HTTPS, [Caddy](https://caddyserver.com) (Apache-2.0).

The xkcd comic is licensed for non-commercial use. If you run FileSync commercially, remove `web/assets/comic*.png` and the comic from `web/index.html`.
