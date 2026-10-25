/* FileSync video — the scenes.
 *
 * Every scene is a function (cam, api) -> render(t) where t is seconds since the
 * scene's start (negative while it is cutting in). `cam` is the scene's camera:
 * transform it to push, pan or drift the whole shot. Moments come from the
 * narration via api.on(line, anchor) / api.segStart(line), so a frame is a pure
 * function of t and the visuals track the voice. Sound effects are registered
 * up front with api.cue(type, t) and mixed by sfx.py.
 *
 * The app on screen is the real one: web/index.html and app.css in an iframe
 * (see appFrame in engine.js). The scenes fill it in the way view.js does, with
 * the same templates and the same strings, so the film can't drift from the UI.
 */
(function () {
  const A = window.Toolkit;
  const { clamp, lerp, ramp, rnd, outQuint, outCubic, outExpo, inCubic, inOutCubic, inOutSine,
          outBack, spring, reveal, el, svg, at, setText, setHTML, words, kin, afterFonts, appFrame } = A;

  const ORANGE = "#fc912d", BLUE = "#3d8bfd", GREEN = "#3ec486", AMBER = "#ffc44d";
  const HOST = "files.example.com", ROOM = "fhp-soyd-xqn", KEY = "7Kp2xQm9vL4nB8wR3tYc1A";
  const LINK = `https://${HOST}/${ROOM}`;
  const ME = "Teal Bison", G1 = "Sapphire Goose", G2 = "Yellow Raven";
  const FILES = [   // dropped together; the app lists the newest first
    { id: "q", name: "Quarterly report.pdf", path: "", size: 2_400_000 },
    { id: "v", name: "holiday-video.mp4", path: "", size: 248_000_000 },
    { id: "d", name: "brand-guide.pdf", path: "Design assets", size: 18_200_000 },
  ];
  const fmt = (b) => window.APPUTIL.formatBytes(b);
  const rate = (b) => window.APPUTIL.formatRate(b);
  const dur = (s) => window.APPUTIL.formatDuration(s);
  const pct = (done, total) => `${Math.floor((Math.min(done, total) / Math.max(1, total)) * 100)}%`;

  /* ------------------------------------------------------------------ *
   *  icons — stroked, on a 24px grid
   * ------------------------------------------------------------------ */
  const P = {
    lock: `<rect x="4.5" y="10.5" width="15" height="10.5" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>`,
    file: `<path d="M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8z"/><path d="M14 3v5h5"/>`,
    video: `<path d="M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8z"/><path d="M14 3v5h5"/><path d="M10 11.5v5l4.2-2.5z"/>`,
    laptop: `<rect x="4" y="5" width="16" height="11" rx="1.8"/><path d="M2 19.5h20"/>`,
    phone: `<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>`,
    server: `<rect x="4" y="4" width="16" height="6.5" rx="1.8"/><rect x="4" y="13.5" width="16" height="6.5" rx="1.8"/><path d="M7.5 7.25h.01M7.5 16.75h.01"/>`,
    disk: `<rect x="3" y="13" width="18" height="7" rx="2"/><path d="M5 13l2.5-7.5A2 2 0 0 1 9.4 4h5.2a2 2 0 0 1 1.9 1.5L19 13"/><path d="M7 16.5h.01M10 16.5h.01"/>`,
    check: `<path d="M5 12.5l4.5 4.5L19 7.5"/>`,
    shield: `<path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6z"/><path d="M8.8 12.2l2.2 2.2 4.4-4.6"/>`,
    unplug: `<path d="M9 15l-2 2a3.5 3.5 0 0 1-5-5l2-2M15 9l2-2a3.5 3.5 0 0 1 5 5l-2 2"/><path d="M8 3.5l1 2.5M3.5 8l2.5 1M16 20.5l-1-2.5M20.5 16l-2.5-1"/>`,
    x: `<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>`,
    box: `<path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9"/>`,
    user: `<circle cx="12" cy="8" r="3.6"/><path d="M5 20.5c.8-3.6 3.6-5.6 7-5.6s6.2 2 7 5.6"/>`,
  };
  const bigIcon = (name, size, sw = 1.7) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name]}</svg>`;

  /* the logo: an orange tile with the signal coming on, dot then three arcs */
  const ARC = (r) => {
    const a0 = (-90 - 48) * Math.PI / 180, a1 = (-90 + 48) * Math.PI / 180;
    return `M${(50 + r * Math.cos(a0)).toFixed(2)} ${(71 + r * Math.sin(a0)).toFixed(2)} A ${r} ${r} 0 0 1 ${(50 + r * Math.cos(a1)).toFixed(2)} ${(71 + r * Math.sin(a1)).toFixed(2)}`;
  };
  let logoId = 0;
  function logoSvg(cls = "") {
    const id = "lg" + logoId++;
    return `<svg class="${cls}" viewBox="0 0 100 100" style="overflow:visible" aria-hidden="true">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffa03f"/><stop offset="1" stop-color="#f7841c"/></linearGradient></defs>
      <rect class="tile" x="0" y="0" width="100" height="100" rx="23" fill="url(#${id})"/>
      <g fill="none" stroke="#fff" stroke-width="8.2" stroke-linecap="round">
        <path class="sig" d="M44.2 66.5h11.6L50 73.5z" fill="#fff" stroke-width="5" stroke-linejoin="round"/>
        <path class="sig" d="${ARC(15)}"/><path class="sig" d="${ARC(28)}"/><path class="sig" d="${ARC(41)}"/>
      </g>
    </svg>`;
  }
  /* the lockup: logo + FileSync. tile 0..1 pops the tile in, sig 0..4 lights the
     signal, k 0..8 brings the letters, centre 1..0 slides the logo aside */
  function lockup(parent, size) {
    const n = el("div", "lockup", parent);
    n.style.fontSize = size + "px";
    n.innerHTML = `${logoSvg("mark")}<div class="word">${"FileSync".split("").map((c) => `<span>${c}</span>`).join("")}</div>`;
    const mark = n.querySelector(".mark"), sig = [...n.querySelectorAll(".sig")];
    const letters = [...n.querySelectorAll(".word span")];
    let shift = 0;
    afterFonts(() => {
      const r = n.getBoundingClientRect(), m = mark.getBoundingClientRect();
      shift = (r.left + r.width / 2) - (m.left + m.width / 2);
    });
    return {
      node: n, mark,
      set(tile, s, k, centre = 0) {
        mark.style.transform = `translateX(${(shift * centre).toFixed(1)}px) scale(${(tile <= 0 ? 0 : spring(tile * 1.3, 9, 5)).toFixed(4)})`;
        mark.style.opacity = Math.min(1, tile * 4).toFixed(3);
        sig.forEach((p, i) => {
          const q = clamp(s - i);
          p.setAttribute("opacity", q.toFixed(3));
          p.style.transformOrigin = "50px 71px";
          p.style.transform = `scale(${lerp(0.7, 1, outBack(q, 2)).toFixed(4)})`;
        });
        letters.forEach((c, i) => {
          const p = outQuint(clamp(k - i));
          c.style.opacity = p.toFixed(3);
          c.style.transform = `translateY(${(36 * (1 - p)).toFixed(1)}px)`;
        });
      },
    };
  }

  /* a soft light, drawn as a gradient (no blur filters) */
  function bloom(parent, x, y, size, color) {
    const b = el("div", "abs", parent);
    Object.assign(b.style, { left: x - size / 2 + "px", top: y - size / 2 + "px", width: size + "px", height: size + "px",
      borderRadius: "50%", background: `radial-gradient(closest-side, ${color}, transparent)` });
    return b;
  }

  /* camera: interpolate between keyframes [t, scale, x, y, dur] with an ease */
  function camera(cam, t, keys, drift = 1) {
    let s = keys[0][1], x = keys[0][2], y = keys[0][3];
    for (let i = 1; i < keys.length; i++) {
      const [t1, s1, x1, y1, d = 0.9] = keys[i];
      const p = inOutCubic(ramp(t, t1, t1 + d));
      s = lerp(s, s1, p); x = lerp(x, x1, p); y = lerp(y, y1, p);
    }
    x += drift * 6 * Math.sin(t * 0.45); y += drift * 4 * Math.cos(t * 0.37);
    s *= 1 + 0.004 * drift * Math.sin(t * 0.3);
    cam.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) scale(${s.toFixed(5)})`;
  }

  const blink = (t, period = 1.0) => (((t % period) + period) % period < period * 0.55 ? 1 : 0);
  function typeCues(api, t0, text, rate, gain = 0.6) {
    for (let i = 0; i < text.length; i++) api.cue("key", t0 + i * rate + (rnd(i * 3.1 + t0) - 0.5) * rate * 0.35, gain);
  }
  const typed = (text, t, t0, rate) => text.slice(0, clamp(Math.floor((t - t0) / rate) + 1, 0, text.length) * (t >= t0 ? 1 : 0));
  const hex = (seed, n) => { let s = ""; for (let i = 0; i < n; i++) s += Math.floor(rnd(seed + i * 7.3) * 256).toString(16).padStart(2, "0"); return s; };

  /* a position that eases between waypoints [t, x, y] */
  function path(keys) {
    return (t) => {
      if (t <= keys[0][0]) return [keys[0][1], keys[0][2]];
      for (let i = 1; i < keys.length; i++) {
        if (t < keys[i][0]) {
          const p = inOutCubic(ramp(t, keys[i - 1][0], keys[i][0]));
          return [lerp(keys[i - 1][1], keys[i][1], p), lerp(keys[i - 1][2], keys[i][2], p)];
        }
      }
      const k = keys[keys.length - 1];
      return [k[1], k[2]];
    };
  }
  /* a point on a quadratic curve */
  const qpt = ([x0, y0], [cx, cy], [x1, y1], u) =>
    [(1 - u) * (1 - u) * x0 + 2 * u * (1 - u) * cx + u * u * x1, (1 - u) * (1 - u) * y0 + 2 * u * (1 - u) * cy + u * u * y1];

  /* the pointer, with a press and a ripple on each click */
  const POINTER = `<svg viewBox="0 0 24 24" width="44" height="44" style="overflow:visible"><path d="M5 2.5l14.5 8-6.4 1.7-3.2 6.6z"
    fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
  function pointer(parent) {
    const n = el("div", "cursor", parent, POINTER);
    const rip = el("div", "ripple", parent);
    n.style.transformOrigin = "9px 4px";
    return function (t, [x, y], clicks, alpha = 1) {
      let press = 0, rp = -1;
      for (const c of clicks) {
        if (t > c - 0.08 && t < c + 0.18) press = Math.max(press, Math.sin(Math.PI * ramp(t, c - 0.08, c + 0.18)));
        if (t >= c && t < c + 0.55) rp = ramp(t, c, c + 0.55);
      }
      n.style.opacity = alpha.toFixed(3);
      n.style.transform = `translate(${(x - 9).toFixed(1)}px, ${(y - 4).toFixed(1)}px) scale(${(1 - 0.16 * press).toFixed(3)})`;
      if (rp >= 0) {
        rip.style.opacity = ((1 - rp) * 0.9 * alpha).toFixed(3);
        rip.style.left = x + "px"; rip.style.top = y + "px";
        rip.style.transform = `scale(${(0.3 + 0.9 * outCubic(rp)).toFixed(3)})`;
      } else rip.style.opacity = 0;
    };
  }
  /* a finger tap: just the ripple */
  function tapper(parent) {
    const rip = el("div", "ripple", parent);
    return function (t, [x, y], t0) {
      const rp = ramp(t, t0, t0 + 0.55);
      rip.style.opacity = (rp > 0 && rp < 1 ? (1 - rp) : 0).toFixed(3);
      rip.style.left = x + "px"; rip.style.top = y + "px";
      rip.style.transform = `scale(${(0.3 + 0.9 * outCubic(rp)).toFixed(3)})`;
    };
  }

  /* the step captions beside the app: numbered, because they are a sequence */
  function stepCaptions(layer, items) {
    const box = el("div", "steps", layer);
    return items.map(([n, title, sub]) => {
      const s = el("div", "step", box);
      el("div", "n", s, n);
      const tt = el("div", "t", s);
      const ws = words(tt, title);
      const ss = el("div", "s", s, sub);
      return { s, ws, ss };
    });
  }
  function playSteps(steps, t, starts, out = null) {
    steps.forEach((st, i) => {
      kin(st.ws, t, starts[i], 0.06, 0.55, out);
      reveal(st.ss, ramp(t, starts[i] + 0.25, starts[i] + 0.75), { dy: 14, alpha: out == null ? 1 : 1 - ramp(t, out, out + 0.3) });
      reveal(st.s.querySelector(".n"), ramp(t, starts[i] - 0.05, starts[i] + 0.4), { dy: 0, dx: -16, alpha: out == null ? 1 : 1 - ramp(t, out, out + 0.3) });
      const next = starts[i + 1];
      st.s.style.opacity = next == null ? 1 : lerp(1, 0.3, ramp(t, next - 0.1, next + 0.35)).toFixed(3);
    });
  }

  /* ====================================================================== *
   *  the real app, in a browser window or on a phone
   * ====================================================================== */
  function placed(node, frameX, frameY) {
    const P = { x: 0, y: 0 };
    return {
      /* moved only, never scaled, so the app stays sharp */
      place(x, y, alpha = 1) {
        P.x = x; P.y = y;
        node.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
        node.style.opacity = alpha.toFixed(3);
        node.style.visibility = alpha > 0 ? "visible" : "hidden";
      },
      /* where an element inside the app is now, on stage (rects already include the zoom) */
      pt(elm, dx = 0.5, dy = 0.5) {
        const r = elm.getBoundingClientRect();
        return [Math.round(P.x) + frameX + r.left + r.width * dx, Math.round(P.y) + frameY + r.top + r.height * dy];
      },
      rect(elm, pad = 0) {
        const r = elm.getBoundingClientRect();
        return [Math.round(P.x) + frameX + r.left - pad, Math.round(P.y) + frameY + r.top - pad, r.width + 2 * pad, r.height + 2 * pad];
      },
    };
  }
  function browser(parent, { w, h, zoom }) {
    const win = el("div", "win", parent);
    Object.assign(win.style, { left: 0, top: 0, width: w + "px", height: h + "px" });
    win.innerHTML = `<div class="chrome"><i></i><i></i><i></i><div class="url">${bigIcon("lock", 17, 2.2)}${HOST}/${ROOM}</div></div><div class="vp"></div>`;
    const frame = appFrame(win.querySelector(".vp"), w, h - 60, zoom);
    return Object.assign({ node: win, frame, zoom }, placed(win, 0, 60));
  }
  function phone(parent, name, { w, h, zoom }) {
    const n = el("div", "phone", parent);
    Object.assign(n.style, { left: 0, top: 0, width: w + "px", height: h + "px" });
    n.innerHTML = `<div class="screen"><div class="notch"></div></div><div class="tag">${bigIcon("shield", 24, 2.2)}${name}</div>`;
    const frame = appFrame(n.querySelector(".screen"), w - 28, h - 28, zoom);
    return Object.assign({ node: n, frame, zoom, tag: n.querySelector(".tag") }, placed(n, 14, 14));
  }

  /* Fill a copy of the app in, the way view.js renders a room. */
  function room(frame, { host, me, people }) {
    const doc = frame.contentDocument, win = frame.contentWindow;
    const $ = (id) => doc.getElementById(id);
    $("room").hidden = false;
    $("share-link").value = LINK;
    if (host) {   // view.js opens the QR beside the link on wide screens and fits it to the column
      $("qr-box").open = true;
      const z = parseFloat(doc.documentElement.style.zoom) || 1;
      const top = doc.querySelector(".status-row").getBoundingClientRect().top;
      const bottom = doc.querySelector(".send-actions").getBoundingClientRect().bottom;
      const size = Math.round(Math.min(260, Math.max(150, (bottom - top) / z)));
      $("qr").style.width = $("qr").style.height = `${size}px`;
    }
    window.drawQr($("qr"), `${LINK}#k=${KEY}`);
    $("password-btn").hidden = !host;
    $("share-title").textContent = host ? "Share the room link with the devices you want to send files to."
      : "You’re in the room. Invite more devices with this link.";
    const vb = $("verify-badge");
    vb.hidden = host;
    if (!host) {
      vb.className = "pill ok";
      vb.innerHTML = `<svg class="icon"><use href="#i-shield-fill-check"/></svg><span>Verified</span>`;
    }
    const others = people.filter((p) => p.name !== me);
    if (!host) setStatus(`Connected to ${ME}`, true);

    function setStatus(text, ok) {
      setText($("status-text"), text);
      const cls = `dot ${ok ? "ok" : "wait"}`;
      if ($("status-dot").className !== cls) $("status-dot").className = cls;
    }
    let peopleKey = "";
    function setPeople(n) {   // the first n people are in the room
      const list = people.slice(0, n);
      const key = list.map((p) => p.name).join();
      if (key === peopleKey) return;
      peopleKey = key;
      $("people").replaceChildren(...list.map((m) => {
        const li = $("person-tpl").content.firstElementChild.cloneNode(true);
        li.classList.toggle("host", !!m.host);
        li.querySelector(".role use").setAttribute("href", m.host ? "#i-star-fill" : "#i-lightning-charge-fill");
        li.querySelector(".person-name").textContent = m.name === me ? `${m.name} (You)` : m.name;
        li.querySelector(".verified-tag").toggleAttribute("hidden", !(host && m.name !== me));
        li.querySelector(".rename").hidden = m.name !== me;
        return li;
      }));
      $("people-count").textContent = `(${list.length})`;
      if (host) {
        const o = list.length - 1;
        setStatus(o === 0 ? "Waiting for people to join…" : o === 1 ? `Connected to ${list[1].name}` : `${o} people connected`, o > 0);
      }
    }
    setPeople(host ? 1 : people.length);

    const rows = {};
    for (const f of FILES) {
      const li = $("file-tpl").content.firstElementChild.cloneNode(true);
      li.querySelector(".file-base").textContent = f.name;
      li.querySelector(".file-path").textContent = f.path ? `${f.path}/` : "";
      li.hidden = true;
      $("files").prepend(li);
      rows[f.id] = li;
    }
    /* one file row, as view.js #renderFile draws it */
    function setFile(id, s) {
      const f = FILES.find((x) => x.id === id), li = rows[id];
      li.hidden = !s;
      if (!s) return;
      const meta = li.querySelector(".file-meta"), note = li.querySelector(".file-note");
      const bar = li.querySelector(".bar"), recv = li.querySelector(".receivers");
      const show = { download: false, cancel: false, remove: false };
      let metaText = `${fmt(f.size)} | Sent by ${host ? "you" : ME}`, noteText = "", noteKind = "", barState = null;
      if (host) {
        show.remove = true;
        const recs = s.receivers || [];
        recv.hidden = recs.length === 0;
        if (recs.length) {
          const sending = recs.filter((r) => r.status === "sending").length;
          const done = recs.filter((r) => r.status === "done").length;
          const parts = [];
          if (sending) parts.push(`Sending to ${sending}`);
          if (done) parts.push(`Received by ${done}`);
          setText(recv.querySelector(".recv-summary"), parts.map((p, i) => (i ? p[0].toLowerCase() + p.slice(1) : p)).join(" · "));
          const ic = recv.querySelector(".icon.state");
          ic.setAttribute("class", `icon state ${sending ? "sending" : done === recs.length ? "ok" : ""}`);
          ic.querySelector("use").setAttribute("href", sending ? "#i-arrow-up-short" : "#i-check-circle-fill");
        }
      } else {
        recv.hidden = true;
        if (s.status === "available") show.download = !s.inBundle;
        if (s.status === "transferring") {
          const left = s.rate > 0 ? (f.size - s.written) / s.rate : NaN;
          metaText = `${pct(s.written, f.size)} | ${fmt(s.written)} of ${fmt(f.size)}${s.rate > 0 ? ` | ${rate(s.rate)} | ${dur(left)} left` : ""}`;
          barState = "active";
          show.cancel = !s.inBundle;
        }
        if (s.status === "done") { noteText = "Saved and verified (SHA-256)"; noteKind = "ok"; show.download = !s.inBundle; }
      }
      setText(meta, metaText);
      note.hidden = !noteText;
      note.className = `file-note ${noteKind}`;
      setText(note, noteText);
      const busy = !host && s.status === "transferring";
      const state = li.querySelector(".state");
      state.querySelector("use").setAttribute("href", s.status === "done" ? "#i-check-circle-fill" : host ? "#i-arrow-up-short" : "#i-arrow-down-short");
      state.setAttribute("class", `icon state ${s.status === "done" ? "ok" : ""}`);
      state.toggleAttribute("hidden", busy);
      li.querySelector(".file-name .spinner").hidden = !busy;
      bar.hidden = !barState;
      if (barState) bar.querySelector("span").style.setProperty("--p", `${((s.written / f.size) * 100).toFixed(1)}%`);
      for (const btn of li.querySelectorAll("button[data-act]")) btn.hidden = !show[btn.dataset.act];
    }
    function setFiles(states) {   // { id: state | null }
      let n = 0, total = 0;
      for (const f of FILES) { setFile(f.id, states[f.id]); if (states[f.id]) { n++; total += f.size; } }
      setText($("files-count"), n ? `(${n} · ${fmt(total)})` : "");
      $("files-empty").hidden = n > 0;
    }
    /* Download all: hidden while the zip is being made, like the app */
    function setBundle(b, available) {
      $("download-all-btn").hidden = !!b || available < 2;
      setText($("download-all-label"), `Download all (${available})`);
      $("bundle").hidden = !b;
      if (!b) return;
      const bar = $("bundle-bar");
      bar.querySelector("span").style.setProperty("--p", `${b.done ? 100 : ((b.bytes / b.total) * 100).toFixed(1)}%`);
      bar.className = `bar ${b.done ? "done" : ""}`;
      setText($("bundle-title"), b.done ? "Zip saved" : `Downloading ${b.index} of ${FILES.length} files as one zip`);
      setText($("bundle-detail"), b.done ? `${FILES.length} files · ${fmt(b.total)}` : `${pct(b.bytes, b.total)} | ${fmt(b.bytes)} of ${fmt(b.total)}`);
      setText($("bundle-action"), b.done ? "Dismiss" : "Cancel");
    }
    /* a toast, as view.js makes it; a = 0..1 for its entrance and exit */
    const toast = el("div", "toast success");
    toast.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#i-check-circle-fill"/></svg><span>Copied to the clipboard.</span>`;
    $("toasts").append(doc.importNode(toast, true));
    const toastEl = $("toasts").lastElementChild;
    function setToast(a) {
      toastEl.style.display = a > 0 ? "" : "none";
      toastEl.style.opacity = a.toFixed(3);
      toastEl.style.transform = `translateY(${(-10 * (1 - a)).toFixed(1)}px)`;
    }
    setToast(0);
    // moved, not scrolled: a short page can't scroll its last card to the top. Only
    // the page content moves, so the drop overlay and the toasts stay fixed.
    function scroll(y) {
      const tr = `translateY(${(-y).toFixed(1)}px)`;
      $("main").style.transform = tr;
      doc.querySelector(".topnav").style.transform = tr;
    }
    return { doc, win, $, rows, setStatus, setPeople, setFiles, setBundle, setToast, scroll };
  }

  /* ====================================================================== *
   *  OPEN — the logo's signal comes on; the promise rises underneath
   * ====================================================================== */
  function open(cam, api) {
    const halo = bloom(cam, 960, 470, 1600, "color-mix(in srgb, var(--orange) 30%, transparent)");
    const halo2 = bloom(cam, 1100, 560, 1000, "color-mix(in srgb, var(--blue) 16%, transparent)");
    const wrap = at(cam, 960, 470, "");
    const lk = lockup(wrap, 160);
    const l1 = at(cam, 960, 650, "headline");
    const l2 = at(cam, 960, 752, "headline grad");
    const w1 = words(l1, "Send files from one device");
    const w2 = words(l2, "to many, in real time.");

    const T0 = 0.3, SIG = [0.95, 1.15, 1.35, 1.55], HIT = 1.75, K0 = HIT + 0.15, KR = 0.06;
    api.cue("pop", T0 + 0.05, 0.8);
    SIG.forEach((s, i) => api.cue(i ? "ping" : "tick", s, 0.45 + 0.12 * i));
    api.cue("hit", HIT, 1);
    api.pulse(HIT, 1.6);
    const s2 = api.segStart("open2");

    return function (t) {
      camera(cam, t, [[0, 1.08, 0, 0], [HIT, 1.0, 0, 0, 5]]);
      const sig = SIG.reduce((a, s) => a + outCubic(ramp(t, s - 0.05, s + 0.2)), 0);
      const k = t < K0 ? 0 : (t - K0) / KR * 0.6;
      const centre = 1 - outQuint(ramp(t, K0 - 0.05, K0 + 0.6));
      lk.set(ramp(t, T0, T0 + 0.6), sig, k, centre);
      const punch = t > HIT ? Math.exp(-(t - HIT) * 7) * 0.07 : 0;
      const lift = outQuint(ramp(t, s2 - 0.35, s2 + 0.55));
      wrap.style.transform = `translateY(${(-160 * lift).toFixed(1)}px) scale(${(1 + punch - 0.2 * lift).toFixed(4)})`;
      const flash = t > HIT ? Math.exp(-(t - HIT) * 2.2) : 0;
      halo.style.opacity = (ramp(t, 0.2, HIT) * 0.35 + 0.65 * flash + 0.15 * lift).toFixed(3);
      halo2.style.opacity = (0.5 * flash + 0.3 * ramp(t, HIT, HIT + 1)).toFixed(3);
      halo.style.transform = halo2.style.transform = `translateY(${(-160 * lift).toFixed(1)}px)`;
      kin(w1, t, s2 - 0.05, 0.065, 0.6);
      kin(w2, t, api.on("open2", "many") - 0.15, 0.075, 0.6);
    };
  }

  /* ====================================================================== *
   *  ROOM — open a room, share it, drop files, everyone grabs them
   * ====================================================================== */
  function roomScene(cam, api) {
    const layer = api.layer;
    // the host's window, big; then the two guests' phones, big
    const WIN = { w: 1250, h: 960, zoom: 1.5 }, WX = 630, WY = 60;
    const PHN = { w: 480, h: 930, zoom: 1.28 }, PX = [770, 1330], PY = 40;
    const H = browser(cam, WIN);
    const PH = [phone(cam, G1, PHN), phone(cam, G2, PHN)];
    const steps = stepCaptions(layer, [
      ["01", "Open a room.", "No accounts, nothing to install."],
      ["02", "Share the link.", "Or let people scan the QR code."],
      ["03", "Drop in files.", "Or a whole folder."],
      ["04", "Everyone gets them.", "No installs, no accounts."],
    ]);
    const chip = at(cam, 0, 0, "dragfile", `<div class="fi">${bigIcon("video", 32)}</div><div>holiday-video.mp4<small>and 2 more</small></div><div class="count">3</div>`);
    chip.style.position = "relative";
    const cur = pointer(cam);
    const taps = [tapper(cam), tapper(cam)];
    const glow = el("div", "abs", cam);
    Object.assign(glow.style, { border: "3px solid var(--orange)", borderRadius: "16px", boxShadow: "0 0 40px rgba(252,145,45,0.45)" });
    const scan = el("div", "abs", cam);
    Object.assign(scan.style, { height: "4px", borderRadius: "2px", background: "var(--orange)", boxShadow: "0 0 24px 6px rgba(252,145,45,0.6)" });

    // ---- the beats ----
    const s1 = api.segStart("room1"), s2 = api.segStart("room2"), s3 = api.segStart("send1"), s4 = api.segStart("send2");
    const CLICK = api.on("room2", "link") + 0.3, QR = api.on("room2", "qr");
    const J1 = QR + 0.7, J2 = J1 + 0.45;
    const SCROLL = s3 - 0.55;                        // the window scrolls to the files
    const DRAG0 = api.on("send1", "drop") - 0.2, DROP = DRAG0 + 1.1;
    const SWAP = s4 - 0.55;                          // the window gives way to the phones
    const LAND = SWAP + 0.75;                        // the files are on the phones
    const GRAB = Math.max(api.on("send2", "grab") + 0.05, LAND + 0.5), ZIP = GRAB + 0.45;
    const A0 = GRAB + 0.25, A1 = A0 + 2.2;           // phone 1 downloads the video
    const B0 = ZIP + 0.3, B1 = B0 + 2.6;             // phone 2 zips all three
    api.cue("pop", api.on("room1", "room"), 0.6);
    api.cue("enter", CLICK, 0.7);
    api.cue("blip", CLICK + 0.1, 0.6);
    api.cue("ping", QR, 0.6);
    api.cue("pop", J1, 0.8); api.cue("pop", J2, 0.8);
    api.cue("swish", DRAG0 + 0.1, 0.5);
    api.cue("thud", DROP, 0.8);
    api.cue("swish", SWAP + 0.1, 0.5);
    api.cue("pop", LAND, 0.6); api.cue("pop", LAND + 0.1, 0.6);
    api.cue("enter", GRAB, 0.7); api.cue("enter", ZIP, 0.7);
    api.cue("stream", A0, 0.6); api.cue("stream", B0 + 0.4, 0.5);
    api.cue("chime", Math.max(A1, B1) + 0.1, 0.9);
    api.pulse(J1, 0.8); api.pulse(LAND, 1);

    // filled in once the frames have loaded
    let h = null, g = [], M = {};
    const PEOPLE = [{ name: ME, host: true }, { name: G1 }, { name: G2 }];
    afterFonts(() => {
      h = room(H.frame, { host: true, me: ME, people: PEOPLE });
      g = [room(PH[0].frame, { host: false, me: G1, people: PEOPLE }), room(PH[1].frame, { host: false, me: G2, people: PEOPLE })];
      M.hostScroll = h.$("people-title").closest(".card").offsetTop - 16;
      M.phoneScroll = g.map((x) => x.$("people-title").closest(".card").offsetTop - 44);
    });

    return function (t) {
      if (!h) return;
      camera(cam, t, [[0, 1.0, 0, 0]], 0);
      playSteps(steps, t, [s1 - 0.1, s2 - 0.1, s3 - 0.1, s4 + 0.15]);

      // the window, then the phones: moved, never scaled
      const inA = outQuint(ramp(t, -0.3, 0.45)), outA = inOutCubic(ramp(t, SWAP, SWAP + 0.6));
      H.place(WX + 140 * outA, WY + 50 * (1 - inA), inA * (1 - outA));
      PH.forEach((p, i) => {
        const a = outQuint(ramp(t, SWAP + 0.25 + i * 0.12, SWAP + 0.95 + i * 0.12));
        p.place(PX[i], PY + 120 * (1 - a), a);
      });

      // the host: people join, then the files
      h.setPeople(t < J1 ? 1 : t < J2 ? 2 : 3);
      h.setToast(ramp(t, CLICK + 0.05, CLICK + 0.3) * (1 - ramp(t, CLICK + 2.2, CLICK + 2.5)));
      h.scroll(M.hostScroll * inOutCubic(ramp(t, SCROLL, SCROLL + 0.8)));
      h.$("drop-overlay").hidden = !(t > DROP - 0.55 && t < DROP);
      h.setFiles(Object.fromEntries(FILES.map((f) => [f.id, t < DROP ? null : { receivers: [] }])));

      // the guests: rows land, one downloads the video, the other zips everything
      const BT = FILES.reduce((s, f) => s + f.size, 0);
      const order = ["d", "v", "q"];                  // the zip takes them top to bottom
      const fsize = (id) => FILES.find((x) => x.id === id).size;
      const bBytes = BT * inOutSine(ramp(t, B0, B1));
      const bFile = (id) => {                          // bytes of one file inside the zip so far
        let before = 0;
        for (const k of order) { if (k === id) return clamp(bBytes - before, 0, fsize(k)); before += fsize(k); }
        return 0;
      };
      const vA = fsize("v") * inOutSine(clamp((t - A0) / (A1 - A0)));
      g.forEach((x, i) => {
        x.scroll(M.phoneScroll[i]);
        const st = {};
        const bun = i === 1 && t >= B0;
        for (const f of FILES) {
          if (t < LAND + i * 0.1) { st[f.id] = null; continue; }
          let s = { status: "available", inBundle: bun && t < B1 };
          if (i === 0 && f.id === "v" && t >= A0) {
            s = vA >= f.size ? { status: "done" } : { status: "transferring", written: vA, rate: 112_400_000 * (0.92 + 0.08 * Math.sin(t * 7)) };
          }
          if (bun) {
            const w = bFile(f.id);
            if (w >= f.size) s = { status: "done", inBundle: t < B1 };
            else if (w > 0) s = { status: "transferring", written: w, rate: 0, inBundle: true };
          }
          st[f.id] = s;
        }
        x.setFiles(st);
        let b = null;
        if (bun) {
          let idx = 1, acc = 0;
          for (const k of order) { acc += fsize(k); if (bBytes >= acc && idx < 3) idx++; }
          b = { bytes: bBytes, total: BT, index: idx, done: t >= B1 };
        }
        x.setBundle(b, t < LAND + i * 0.1 ? 0 : FILES.length);
      });

      // the pointer: copy the link, then drag the files in
      const linkP = H.pt(h.$("share-link"), 0.3, 0.5);
      const dropP = H.pt(h.$("files-title").closest(".card"), 0.5, 0.55);
      const pos = path([[CLICK - 1.2, 520, 980], [CLICK, linkP[0], linkP[1]], [CLICK + 0.9, linkP[0] + 60, linkP[1] + 280],
        [SCROLL, 420, 1030], [DRAG0, 300, 1010], [DROP, dropP[0], dropP[1]], [DROP + 1.0, dropP[0] + 140, dropP[1] + 160]])(t);
      cur(t, pos, [CLICK], ramp(t, CLICK - 1.2, CLICK - 0.9) * (1 - ramp(t, DROP + 0.4, DROP + 0.8)));
      const dragging = ramp(t, DRAG0 - 0.3, DRAG0) * (1 - ramp(t, DROP - 0.05, DROP + 0.15));
      chip.parentElement.style.left = (pos[0] + 150).toFixed(1) + "px";
      chip.parentElement.style.top = (pos[1] + 30).toFixed(1) + "px";
      chip.style.opacity = dragging.toFixed(3);
      chip.style.transform = `scale(${(lerp(0.85, 1, ramp(t, DRAG0 - 0.3, DRAG0)) * lerp(1, 0.6, ramp(t, DROP - 0.1, DROP + 0.15))).toFixed(3)})`;

      // the taps on the phones
      taps[0](t, PH[0].pt(g[0].rows.v.querySelector('[data-act="download"]')), GRAB);
      taps[1](t, PH[1].pt(g[1].$("download-all-btn")), ZIP);

      // highlights: the link box, the QR code (with a scan line), the folder
      let gl = null, ga = 0;
      const room1 = api.on("room1", "room"), fold = api.on("send1", "folder");
      if (t < QR - 0.2) {
        gl = H.rect(h.$("share-link").parentElement, 8);
        ga = ramp(t, room1 - 0.1, room1 + 0.2) * (1 - ramp(t, QR - 0.35, QR - 0.2));
      } else if (t < SCROLL) {
        gl = H.rect(h.$("qr"), 12);
        ga = ramp(t, QR - 0.2, QR + 0.1) * (1 - ramp(t, QR + 1.6, QR + 1.9));
      } else if (t > fold - 0.2 && t < SWAP) {
        gl = H.rect(h.rows.d, 0);
        ga = ramp(t, fold - 0.2, fold + 0.1) * (1 - ramp(t, fold + 1.1, fold + 1.4));
      }
      glow.style.opacity = ga.toFixed(3);
      if (gl) Object.assign(glow.style, { left: gl[0] + "px", top: gl[1] + "px", width: gl[2] + "px", height: gl[3] + "px" });
      const sp = ramp(t, QR, QR + 1.3);
      if (sp > 0 && sp < 1) {
        const [x, y, w, hh] = H.rect(h.$("qr"), 6);
        Object.assign(scan.style, { left: x + "px", width: w + "px", top: (y + hh * inOutSine(sp)).toFixed(1) + "px", opacity: Math.sin(Math.PI * sp).toFixed(3) });
      } else scan.style.opacity = 0;
    };
  }

  /* ====================================================================== *
   *  DIRECT — browser to browser; the server only introduces
   * ====================================================================== */
  function direct(cam, api) {
    const layer = api.layer;
    const HOSTP = [420, 690], GP = [[1500, 520], [1500, 860]], SRV = [960, 330];
    const g = svg("svg", { width: 1920, height: 1080, style: "position:absolute;inset:0;overflow:visible" }, cam);
    const C = [960, 690];
    const beams = GP.map((p) => svg("path", { d: `M${HOSTP[0] + 100} ${HOSTP[1]} Q ${C[0]} ${(HOSTP[1] + p[1]) / 2} ${p[0] - 100} ${p[1]}`,
      fill: "none", stroke: "var(--accent)", "stroke-width": 4, "stroke-linecap": "round", "stroke-dasharray": "2 14", opacity: 0 }, g));
    const intro = [HOSTP, ...GP].map((p) => svg("path", { d: `M${SRV[0]} ${SRV[1] + 95} L${p[0]} ${p[1] - 105}`, fill: "none",
      stroke: "rgba(255,255,255,0.5)", "stroke-width": 2.5, "stroke-dasharray": "8 10", "stroke-linecap": "round", opacity: 0 }, g));
    const node = (x, y, ic, name, role, size = 168) => {
      const n = el("div", "node", cam);
      n.style.left = x + "px"; n.style.top = y + "px";
      n.innerHTML = `<div class="card glass" style="width:${size}px;height:${size}px">${bigIcon(ic, size * 0.48)}</div><div class="name">${name}</div>${role ? `<div class="role">${role}</div>` : ""}`;
      return n;
    };
    const hostN = node(HOSTP[0], HOSTP[1] + 30, "laptop", ME, "sends");
    const gN = GP.map((p, i) => node(p[0], p[1] + 30, "phone", i ? G2 : G1, "receives", 150));
    const srvN = node(SRV[0], SRV[1], "server", "Server", "introduces", 150);
    const srvCard = srvN.querySelector(".card");
    const slash = el("div", "abs", srvCard);
    Object.assign(slash.style, { inset: 0, display: "grid", placeItems: "center" });
    slash.innerHTML = `<svg width="150" height="150" viewBox="0 0 150 150"><path d="M38 38L112 112" stroke="var(--red)" stroke-width="7" stroke-linecap="round"
      pathLength="100" stroke-dasharray="100 100" stroke-dashoffset="100"/></svg>`;
    const slashP = slash.querySelector("path");
    const never = at(cam, SRV[0] + 270, SRV[1] - 10, "chip", `${bigIcon("file", 28, 2)}never sees your files`);
    never.style.color = "var(--red)";
    const packets = [];
    for (let i = 0; i < 6; i++) packets.push(at(cam, 0, 0, "packet", bigIcon("file", 32, 2.2)));
    const locks = GP.map((p) => at(cam, 0, 0, "lockdot", bigIcon("lock", 26, 2.3)));

    const h1 = at(layer, 960, 120, "headline"), h2 = at(layer, 960, 120, "headline");
    const h1w = words(h1, "Straight from browser to browser.");
    const h2w = words(h2, "The server only introduces.");
    const ST = api.on("direct1", "straight"), ENC = api.on("direct1", "encrypted");
    const SV = api.on("direct2", "server") - 0.1, INT = api.on("direct2", "introduces"), NEV = api.on("direct2", "never");
    api.cue("swish", ST, 0.6);
    api.cue("tick", ENC, 0.6); api.cue("tick", ENC + 0.12, 0.6);
    api.cue("pop", SV + 0.1, 0.7);
    [0, 1, 2].forEach((i) => api.cue("blip", INT + 0.15 + i * 0.12, 0.6));
    api.cue("deny", NEV + 0.1, 0.7);
    api.pulse(ST, 0.8);

    return function (t) {
      camera(cam, t, [[0, 1.03, 0, 30], [SV - 0.5, 1.0, 0, 50, 1.2]], 0.9);
      kin(h1w, t, -0.1, 0.06, 0.55, api.segStart("direct2") - 0.6);
      kin(h2w, t, api.segStart("direct2") - 0.3, 0.06, 0.55);
      reveal(hostN, ramp(t, 0, 0.5), { dy: 30, base: "translate(-50%,-50%)", scale: 0.9 });
      gN.forEach((n, i) => reveal(n, ramp(t, 0.15 + i * 0.1, 0.65 + i * 0.1), { dy: 30, base: "translate(-50%,-50%)", scale: 0.9 }));
      beams.forEach((b, i) => {
        b.setAttribute("opacity", (0.75 * ramp(t, ST - 0.2 + i * 0.1, ST + 0.3 + i * 0.1)).toFixed(3));
        b.setAttribute("stroke-dashoffset", (-t * 50).toFixed(1));
      });
      // files stream along both paths, never through the server
      packets.forEach((p, k) => {
        const i = k % 2, phase = Math.floor(k / 2) / 3;
        const t0 = ST + 0.2 + i * 0.15;
        const u = t < t0 ? -1 : (((t - t0) * 0.55 + phase) % 1);
        const [x, y] = qpt([HOSTP[0] + 100, HOSTP[1]], [C[0], (HOSTP[1] + GP[i][1]) / 2], [GP[i][0] - 100, GP[i][1]], u);
        p.parentElement.style.left = x.toFixed(1) + "px"; p.parentElement.style.top = y.toFixed(1) + "px";
        p.style.opacity = (u < 0 ? 0 : Math.min(1, u * 8, (1 - u) * 8) * ramp(t, t0, t0 + 0.3)).toFixed(3);
        p.style.transform = `scale(${(0.8 + 0.2 * Math.sin(Math.PI * Math.max(0, u))).toFixed(3)})`;
      });
      locks.forEach((l, i) => {
        const [x, y] = qpt([HOSTP[0] + 100, HOSTP[1]], [C[0], (HOSTP[1] + GP[i][1]) / 2], [GP[i][0] - 100, GP[i][1]], 0.5);
        l.parentElement.style.left = x + "px"; l.parentElement.style.top = y + "px";
        const q = ramp(t, ENC + i * 0.12, ENC + 0.4 + i * 0.12);
        l.style.transform = `scale(${(q <= 0 ? 0 : spring(q * 1.3, 10, 5)).toFixed(4)})`;
        l.style.opacity = Math.min(1, q * 4).toFixed(3);
      });
      // the server: it introduces the devices, then steps back
      reveal(srvN, ramp(t, SV, SV + 0.5), { dy: -30, base: "translate(-50%,-50%)", scale: 0.9 });
      intro.forEach((p, i) => {
        const a = ramp(t, INT + i * 0.12, INT + 0.4 + i * 0.12);
        p.setAttribute("opacity", (0.8 * a * (1 - 0.65 * ramp(t, NEV - 0.4, NEV))).toFixed(3));
        p.setAttribute("stroke-dashoffset", (t * 30).toFixed(1));
      });
      slashP.setAttribute("stroke-dashoffset", (100 * (1 - outCubic(ramp(t, NEV + 0.05, NEV + 0.35)))).toFixed(1));
      reveal(never, ramp(t, NEV + 0.1, NEV + 0.5), { dy: 0, dx: -20 });
    };
  }

  /* ====================================================================== *
   *  VERIFIED — the key in the link never reaches the server
   * ====================================================================== */
  function verified(cam, api) {
    const layer = api.layer;
    const LY = 520;
    const link = at(cam, 960, LY, "link", `<span class="a">${LINK}</span><span class="k">#k=${KEY}</span>`);
    link.style.fontSize = "38px";
    const aPart = link.querySelector(".a"), kPart = link.querySelector(".k");
    const brk = el("div", "bracket", cam);
    const ktag = at(cam, 0, 0, "keytag", "the key, after the #");
    const srv = el("div", "node", cam);
    srv.style.left = "560px"; srv.style.top = "250px";
    srv.innerHTML = `<div class="card glass" style="width:130px;height:130px">${bigIcon("server", 62)}</div><div class="name" style="font-size:24px">Server</div>`;
    const g = svg("svg", { width: 1920, height: 1080, style: "position:absolute;inset:0;overflow:visible" }, cam);
    const up1 = svg("path", { fill: "none", stroke: "rgba(255,255,255,0.55)", "stroke-width": 3, "stroke-dasharray": "3 10", "stroke-linecap": "round" }, g);
    const up2 = svg("path", { fill: "none", stroke: "var(--orange)", "stroke-width": 3, "stroke-dasharray": "3 10", "stroke-linecap": "round" }, g);
    const stop = at(cam, 0, 0, "", `<div style="width:56px;height:56px;border-radius:50%;display:grid;place-items:center;background:#1b1e22;border:3px solid var(--red);color:var(--red)">${bigIcon("x", 30, 3)}</div>`);
    const never = at(cam, 0, 0, "chip", "never sent to any server");
    never.style.color = "var(--orange-l)";

    // then: two devices, joined with the key, and nobody in between
    const DY = 830;
    const dev = (x, ic, name) => { const n = el("div", "node", cam); n.style.left = x + "px"; n.style.top = DY + "px";
      n.innerHTML = `<div class="card glass" style="width:130px;height:130px">${bigIcon(ic, 62)}</div><div class="name" style="font-size:24px">${name}</div>`; return n; };
    const d1 = dev(520, "laptop", ME), d2 = dev(1400, "phone", G1);
    const wire = svg("path", { d: `M600 ${DY - 18} L1320 ${DY - 18}`, fill: "none", stroke: "var(--accent)", "stroke-width": 4, "stroke-linecap": "round", "stroke-dasharray": "2 14" }, g);
    const keyFly = at(cam, 0, 0, "", `<div style="padding:8px 16px;border-radius:12px;background:var(--orange);color:#1a1205;font:700 26px var(--mono)">#k=…</div>`);
    const pill = at(cam, 960, DY - 18, "pill-ok", `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0c-.69 0-1.843.265-2.928.56-1.11.3-2.229.655-2.887.87a1.54 1.54 0 0 0-1.044 1.262c-.596 4.477.787 7.795 2.465 9.99a11.8 11.8 0 0 0 2.517 2.453c.386.273.744.482 1.048.625.28.132.581.24.829.24s.548-.108.829-.24a7 7 0 0 0 1.048-.625 11.8 11.8 0 0 0 2.517-2.453c1.678-2.195 3.061-5.513 2.465-9.99a1.54 1.54 0 0 0-1.044-1.263 63 63 0 0 0-2.887-.87C9.843.266 8.69 0 8 0m2.146 5.146a.5.5 0 0 1 .708.708l-3 3a.5.5 0 0 1-.708 0l-1.5-1.5a.5.5 0 1 1 .708-.708L7.5 7.793z"/></svg>Verified`);
    const nob = at(cam, 960, DY + 105, "sub", "Nobody in between. Not even the server.");
    nob.style.fontSize = "32px";

    const h1 = at(layer, 960, 120, "headline"), h2 = at(layer, 960, 120, "headline");
    const h1w = words(h1, "The key stays in the link.");
    const h2w = words(h2, "Nobody in between.");
    const KEYT = api.on("verified1", "key"), NEV = api.on("verified1", "never");
    const s2 = api.segStart("verified2"), PRV = api.on("verified2", "proves"), NOB = api.on("verified2", "nobody"), BTW = api.on("verified2", "between");
    api.cue("blip", KEYT, 0.7);
    api.cue("swish", NEV - 0.1, 0.5);
    api.cue("deny", NEV + 0.45, 0.7);
    api.cue("swish", PRV, 0.6);
    api.cue("chime", NOB + 0.05, 0.9);
    api.accent(NOB, GREEN);
    api.pulse(NOB, 1);

    let M = null;
    afterFonts(() => {
      const r = link.getBoundingClientRect(), a = aPart.getBoundingClientRect(), k = kPart.getBoundingClientRect();
      M = { aMid: a.left + a.width / 2, kL: k.left, kR: k.right, kMid: k.left + k.width / 2, bottom: r.bottom, top: r.top };
    });

    return function (t) {
      camera(cam, t, [[0, 1.02, 0, 40], [s2 - 0.6, 1.0, 0, -120, 1.2]], 0.8);
      kin(h1w, t, -0.1, 0.06, 0.55, s2 - 0.6);
      kin(h2w, t, s2 - 0.3, 0.06, 0.55);
      reveal(link, ramp(t, 0, 0.5), { dy: 30, scale: 0.96 });
      if (!M) return;
      const kp = ramp(t, KEYT - 0.1, KEYT + 0.3);
      kPart.style.background = `rgba(252,145,45,${(0.16 * kp).toFixed(3)})`;
      aPart.style.opacity = lerp(1, 0.55, kp).toFixed(3);
      Object.assign(brk.style, { left: M.kL + "px", width: (M.kR - M.kL) + "px", top: M.bottom + 14 + "px",
        opacity: outCubic(kp).toFixed(3), transform: `scaleX(${lerp(0.6, 1, outCubic(kp)).toFixed(3)})` });
      ktag.parentElement.style.left = M.kMid + "px"; ktag.parentElement.style.top = M.bottom + 76 + "px";
      reveal(ktag, ramp(t, KEYT, KEYT + 0.4), { dy: 12 });
      // the address goes to the server; the key never does
      const gone = 1 - ramp(t, s2 - 0.7, s2 - 0.2);
      reveal(srv, ramp(t, NEV - 0.4, NEV), { dy: 20, base: "translate(-50%,-50%)", scale: 0.9, alpha: gone });
      [up1, up2].forEach((u) => (u.style.opacity = gone));
      stop.parentElement.style.opacity = never.parentElement.style.opacity = gone;
      const u1 = outCubic(ramp(t, NEV - 0.1, NEV + 0.5));
      const ax = M.aMid, ay = M.top - 12;
      up1.setAttribute("d", `M${ax} ${ay} L${lerp(ax, 640, u1).toFixed(1)} ${lerp(ay, 300, u1).toFixed(1)}`);
      up1.setAttribute("opacity", (u1 > 0 ? 1 : 0).toFixed(2));
      const u2 = outCubic(ramp(t, NEV + 0.1, NEV + 0.5));
      const kx = M.kMid, ky = M.top - 12, sx = lerp(kx, 640, 0.42), sy = lerp(ky, 300, 0.42);
      up2.setAttribute("d", `M${kx} ${ky} L${lerp(kx, sx, u2).toFixed(1)} ${lerp(ky, sy, u2).toFixed(1)}`);
      up2.setAttribute("opacity", (u2 > 0 ? 1 : 0).toFixed(2));
      stop.parentElement.style.left = sx + "px"; stop.parentElement.style.top = sy + "px";
      const sp = ramp(t, NEV + 0.45, NEV + 0.8);
      stop.style.transform = `scale(${(sp <= 0 ? 0 : spring(sp * 1.3, 10, 5)).toFixed(4)})`;
      never.parentElement.style.left = sx + 250 + "px"; never.parentElement.style.top = sy + "px";
      reveal(never, ramp(t, NEV + 0.6, NEV + 1.0), { dy: 0, dx: -20 });

      // the key joins the two devices; the check proves nobody is in between
      reveal(d1, ramp(t, s2 - 0.3, s2 + 0.2), { dy: 30, base: "translate(-50%,-50%)", scale: 0.9 });
      reveal(d2, ramp(t, s2 - 0.2, s2 + 0.3), { dy: 30, base: "translate(-50%,-50%)", scale: 0.9 });
      wire.setAttribute("opacity", (0.8 * ramp(t, s2, s2 + 0.4)).toFixed(3));
      wire.setAttribute("stroke-dashoffset", (-t * 40).toFixed(1));
      const f = inOutCubic(ramp(t, PRV - 0.1, NOB - 0.05));
      const [fx, fy] = qpt([M.kMid, M.bottom], [M.kMid - 100, DY - 260], [960, DY - 18], f);
      keyFly.parentElement.style.left = fx + "px"; keyFly.parentElement.style.top = fy + "px";
      keyFly.style.opacity = (f > 0 && f < 1 ? Math.min(1, f * 6) : 0).toFixed(3);
      const pp = ramp(t, NOB - 0.05, NOB + 0.5);
      pill.style.transform = `scale(${(pp <= 0 ? 0 : spring(pp * 1.3, 9, 4.5)).toFixed(4)})`;
      pill.style.opacity = Math.min(1, pp * 4).toFixed(3);
      reveal(nob, ramp(t, BTW - 0.6, BTW - 0.1), { dy: 14 });
    };
  }

  /* ====================================================================== *
   *  BIG — any size, straight to disk, resumes, checked on arrival
   * ====================================================================== */
  function big(cam, api) {
    const layer = api.layer;
    const SIZE = 48_600_000_000, RATE = 112_400_000;
    const CX = 800, CY = 560, DX = 1650;
    const card = at(cam, CX, CY, "xfer glass", `
      <div class="row"><div class="fi">${bigIcon("video", 46)}</div><div class="nm">raw-footage.mov</div><div class="size">48.6 GB</div></div>
      <div class="bar"><b></b><i class="mark"></i></div>
      <div class="meta"></div>
      <div class="note"></div>
      <div class="hash"></div>`);
    const $ = (s) => card.querySelector(s);
    const sizeN = $(".size"), fill = $(".bar b"), mark = $(".bar .mark"), meta = $(".meta"), note = $(".note"), hash = $(".hash");
    const disk = at(cam, DX, CY - 20, "disk", `<div class="card glass">${bigIcon("disk", 70)}</div><div class="label">Your disk</div>`);
    const g = svg("svg", { width: 1920, height: 1080, style: "position:absolute;inset:0;overflow:visible" }, cam);
    const pipe = svg("path", { d: `M${CX + 600} ${CY - 30} L${DX - 100} ${CY - 30}`, fill: "none", stroke: "var(--accent)", "stroke-width": 4, "stroke-linecap": "round", "stroke-dasharray": "2 14" }, g);
    const cut = at(cam, (CX + 600 + DX - 100) / 2, CY - 30, "", `<div style="width:60px;height:60px;border-radius:50%;display:grid;place-items:center;background:#1b1e22;border:3px solid var(--amber);color:var(--amber)">${bigIcon("unplug", 32, 2.2)}</div>`);

    const hs = [["No size limit.", ""], ["Picks up where it stopped.", ""], ["Checked when it lands.", "grad-g"]].map(([txt, cls]) => {
      const n = at(layer, 960, 150, "headline " + cls);
      return words(n, txt);
    });
    const SZ = api.on("big1", "size"), DISK = api.on("big1", "disk");
    const DROPT = api.on("big2", "drops"), PICK = api.on("big2", "picks") + 0.1;
    const CHK = api.on("big3", "checked"), LANDS = api.on("big3", "lands");
    const S0 = DISK - 0.2, P0 = 0.62;                   // streams to 62%, then the line drops
    const END = CHK - 0.15;
    api.cue("blip", SZ, 0.6);
    for (let i = 0; i < 6; i++) api.cue("tick", SZ + 0.05 + i * 0.07, 0.4);
    api.cue("stream", S0, 0.6);
    api.cue("deny", DROPT, 0.8);
    api.cue("enter", PICK, 0.7);
    api.cue("stream", PICK + 0.1, 0.6);
    api.cue("chime", LANDS, 1);
    api.accent(CHK, GREEN);
    api.pulse(LANDS, 1);

    return function (t) {
      camera(cam, t, [[0, 1.04, 0, 0], [0, 1.0, 0, 0, 6]], 1);
      kin(hs[0], t, -0.1, 0.07, 0.55, api.segStart("big2") - 0.5);
      kin(hs[1], t, api.segStart("big2") - 0.2, 0.06, 0.55, api.segStart("big3") - 0.5);
      kin(hs[2], t, api.segStart("big3") - 0.2, 0.06, 0.55);
      reveal(card, ramp(t, -0.2, 0.4), { dy: 40, scale: 0.96 });
      reveal(disk, ramp(t, DISK - 0.5, DISK), { dy: 0, dx: 40, scale: 0.9 });
      // the size rolls up: a few megabytes to tens of gigabytes
      const sz = Math.exp(lerp(Math.log(2_400_000), Math.log(SIZE), outCubic(ramp(t, SZ - 0.1, SZ + 0.5))));
      setText(sizeN, fmt(Math.round(sz)));
      // progress: stream, stall, resume from the same byte, finish
      let p, state;
      if (t < S0) { p = 0; state = "wait"; }
      else if (t < DROPT) { p = P0 * inOutSine(ramp(t, S0, DROPT)); state = "run"; }
      else if (t < PICK) { p = P0; state = "retry"; }
      else { p = lerp(P0, 1, inOutSine(ramp(t, PICK, END))); state = t >= END ? "done" : "run"; }
      fill.style.width = (p * 100).toFixed(2) + "%";
      fill.style.background = state === "retry" ? "var(--amber)" : state === "done" ? "var(--green)" : "var(--blue)";
      mark.style.left = P0 * 100 + "%";
      mark.style.opacity = ramp(t, DROPT, DROPT + 0.2).toFixed(3);
      const w = SIZE * p;
      const r = RATE * (0.94 + 0.06 * Math.sin(t * 5));
      // the app's own wording for each state
      setText(meta, state === "wait" ? `${fmt(SIZE)} | Sent by ${ME}`
        : state === "retry" ? `${pct(w, SIZE)} | ${fmt(w)} of ${fmt(SIZE)} | Reconnecting…`
        : state === "done" ? `${fmt(SIZE)} | Sent by ${ME}`
        : `${pct(w, SIZE)} | ${fmt(w)} of ${fmt(SIZE)} | ${rate(r)} | ${dur((SIZE - w) / r)} left`);
      pipe.setAttribute("opacity", (0.8 * ramp(t, S0 - 0.2, S0 + 0.2)).toFixed(3));
      pipe.setAttribute("stroke-dashoffset", state === "run" ? (-t * 60).toFixed(1) : (-Math.min(t, DROPT) * 60).toFixed(1));
      pipe.style.stroke = state === "retry" ? "var(--amber)" : "";
      const cp = ramp(t, DROPT, DROPT + 0.35) * (1 - ramp(t, PICK - 0.1, PICK + 0.2));
      cut.style.transform = `scale(${(cp <= 0 ? 0 : spring(cp * 1.3, 10, 5)).toFixed(4)})`;
      cut.style.opacity = Math.min(1, cp * 4).toFixed(3);
      // checked: the hash runs, then the app's note
      const hp = ramp(t, CHK - 0.1, LANDS);
      setText(hash, t < CHK - 0.1 ? "" : "SHA-256  " + hex(Math.floor(t * 30) * (hp < 1 ? 1 : 0) + 7, 24));
      hash.style.color = hp >= 1 ? "var(--green)" : "";
      setHTML(note, t >= LANDS ? `<svg viewBox="0 0 16 16" fill="var(--green)"><path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0m-3.97-3.03a.75.75 0 0 0-1.08.022L7.477 9.417 5.384 7.323a.75.75 0 0 0-1.06 1.06L6.97 11.03a.75.75 0 0 0 1.079-.02l3.992-4.99a.75.75 0 0 0-.01-1.05z"/></svg><span style="color:var(--green)">Saved and verified (SHA-256)</span>` : "");
      reveal(note, ramp(t, LANDS, LANDS + 0.3), { dy: 10 });
    };
  }

  /* ====================================================================== *
   *  SELFHOST — free, open source, yours to run
   * ====================================================================== */
  function selfhost(cam, api) {
    bloom(cam, 1380, 540, 1300, "color-mix(in srgb, var(--orange) 16%, transparent)");
    const h1 = el("div", "abs headline", cam); Object.assign(h1.style, { left: "150px", top: "350px", fontSize: "84px" });
    const h1w = words(h1, "Free and open source.");
    const h2 = el("div", "abs headline grad", cam); Object.assign(h2.style, { left: "150px", top: "462px", fontSize: "84px" });
    const h2w = words(h2, "Run your own.");
    const sub = el("div", "abs sub", cam); Object.assign(sub.style, { left: "154px", top: "600px", fontSize: "34px" });
    sub.innerHTML = `MIT License · <span style="font-family:var(--mono);color:var(--ink)">github.com/polius/filesync</span>`;

    const T = el("div", "term", cam);
    Object.assign(T.style, { left: "1090px", top: "330px", width: "720px", height: "380px" });
    T.innerHTML = `<div class="tb"><i></i><i></i><i></i><div class="ttl">you@server — zsh</div></div><div class="body"></div>`;
    const body = T.querySelector(".body");
    const ln = () => el("div", "ln", body);
    const cmd = ln(), o0 = ln(), o1 = ln(), o2 = ln(), o3 = ln();
    o0.innerHTML = `<span class="d">[+] Running 3/3</span>`;
    o1.innerHTML = ` <span class="ok">✔</span> Container filesync-init    <span class="d">Exited</span>`;
    o2.innerHTML = ` <span class="ok">✔</span> Container filesync-coturn  <span class="d">Started</span>`;
    o3.innerHTML = ` <span class="ok">✔</span> Container filesync-app     <span class="d">Started</span>`;

    const C = "docker compose up -d", RATE = 0.04;
    const c0 = api.on("self2", "command") - 0.5;
    const enter = c0 + C.length * RATE + 0.12;
    typeCues(api, c0, C, RATE, 0.45);
    api.cue("enter", enter, 0.9);
    [0, 1, 2].forEach((i) => api.cue("tick", enter + 0.45 + i * 0.22, 0.45));
    api.cue("chime", enter + 1.0, 0.5);

    return function (t) {
      camera(cam, t, [[0, 1.04, 0, 0], [0, 1.0, 0, 0, 5]]);
      kin(h1w, t, -0.1, 0.07, 0.55);
      kin(h2w, t, api.on("self2", "own") - 0.35, 0.07, 0.55);
      reveal(sub, ramp(t, api.on("self1", "open"), api.on("self1", "open") + 0.5), { dy: 14 });
      reveal(T, ramp(t, -0.1, 0.6), { dy: 50, scale: 0.96 });
      const caret = (on) => (on && blink(t, 0.9) ? '<span class="caret"></span>' : "");
      setHTML(cmd, `<span class="p">$</span> ${typed(C, t, c0, RATE)}${caret(t < enter)}`);
      reveal(o0, ramp(t, enter + 0.2, enter + 0.35), { dy: 8 });
      [o1, o2, o3].forEach((o, i) => reveal(o, ramp(t, enter + 0.45 + i * 0.22, enter + 0.6 + i * 0.22), { dy: 8 }));
    };
  }

  /* ====================================================================== *
   *  OUTRO — the name, the promise, where to find it
   * ====================================================================== */
  function outro(cam, api) {
    const halo = bloom(cam, 960, 330, 1500, "color-mix(in srgb, var(--orange) 28%, transparent)");
    const halo2 = bloom(cam, 1100, 400, 1000, "color-mix(in srgb, var(--blue) 14%, transparent)");
    const wrap = at(cam, 960, 330, "");
    const lk = lockup(wrap, 140);
    const tag = at(cam, 960, 540, "headline");
    const tw = words(tag, "Any file, to every device, in real time.");
    tag.style.fontSize = "64px";
    const url = at(cam, 960, 720, "url");
    url.innerHTML = `github.com/polius/filesync<b>·</b>open source<b>·</b>MIT`;

    const HIT = api.segStart("outro1") - 0.12;
    api.cue("hit", HIT, 1);
    api.pulse(HIT, 1.6);
    const T0 = api.on("outro2", "file") - 0.1;
    api.cue("pop", api.on("outro2", "real") + 0.6, 0.5);

    return function (t) {
      camera(cam, t, [[0, 1.0, 0, 0], [HIT, 1.04, 0, 0, 8]]);
      const pin = ramp(t, HIT - 0.3, HIT);
      lk.set(t < HIT ? inCubic(pin) : 1, 4 * outCubic(ramp(t, HIT - 0.2, HIT + 0.35)), 8, 0);
      const punch = t > HIT ? Math.exp(-(t - HIT) * 6) * 0.05 : 0;
      wrap.style.opacity = outQuint(ramp(t, HIT - 0.3, HIT - 0.1)).toFixed(3);
      wrap.style.transform = `scale(${(lerp(1.2, 1, outExpo(pin)) + punch).toFixed(4)})`;
      const fl = t > HIT ? Math.exp(-Math.max(0, t - HIT) * 1.8) : 0;
      halo.style.opacity = (pin * (0.45 + 0.55 * fl)).toFixed(3);
      halo2.style.opacity = (pin * (0.4 + 0.4 * fl)).toFixed(3);
      kin(tw, t, T0, 0.07, 0.6);
      reveal(url, ramp(t, api.on("outro2", "real") + 0.5, api.on("outro2", "real") + 1.0), { dy: 14 });
    };
  }

  Object.assign(window.SCENES, { open, room: roomScene, direct, verified, big, selfhost, outro });
})();
