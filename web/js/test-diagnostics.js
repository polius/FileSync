// FileSync diagnostics page logic (extracted from test.html so the site CSP can
// keep script-src 'self'). Loads at the end of <body> — same execution order as
// the previous inline block.
const IP = document.getElementById('ip');
const Stun = document.getElementById('stun');
const Turn = document.getElementById('turn');
const Err = document.getElementById('err');

const diagnostics = {
  timestamp: new Date().toISOString(),
  url: window.location.href,
  origin: window.location.origin,
  userAgent: navigator.userAgent,
  platform: navigator.platform,
  language: navigator.language,
  hardwareConcurrency: navigator.hardwareConcurrency,
  deviceMemoryGB: navigator.deviceMemory,
  secureContext: window.isSecureContext === true,
  capabilities: {},
  sink: null,
  iceServers: { stun: false, turn: false, publicIP: null },
};

// Render a status pill into a cell. Pass an explicit state ('ok'|'bad'|'warn'|'wait')
// or let it derive from the boolean: true→ok, false→bad, null/undefined→wait.
function setCell(id, ok, label, state) {
  const el = document.getElementById(id);
  if (!el) return;
  let cls, text;
  if (state) { cls = state; text = label || ''; }
  else if (ok === true)  { cls = 'ok';  text = label || 'Yes'; }
  else if (ok === false) { cls = 'bad'; text = label || 'No'; }
  else                   { cls = 'wait'; text = label || 'Checking…'; }
  el.innerHTML = '';
  const span = document.createElement('span');
  span.className = 'pill ' + cls;
  span.textContent = text;
  el.appendChild(span);
}

function detectCapabilities() {
  const secure  = window.isSecureContext === true;
  const webrtc  = typeof RTCPeerConnection !== 'undefined';
  const swApi   = 'serviceWorker' in navigator;
  const fsApi   = typeof window.showSaveFilePicker === 'function';
  const streams = typeof ReadableStream !== 'undefined';

  setCell('cap-secure', secure, secure ? 'Secure' : 'Insecure');
  setCell('cap-webrtc', webrtc, webrtc ? 'Supported' : 'Unsupported');
  setCell('cap-sw-api', swApi, swApi ? 'Supported' : 'Unsupported');

  // FS Access is a desktop-Chromium API and needs a secure context — show the partial
  // (supported-but-insecure) case as a warning rather than a flat failure.
  if (!fsApi)        setCell('cap-fs', null, 'Not supported (Chromium desktop)', 'bad');
  else if (!secure)  setCell('cap-fs', null, 'Supported, needs HTTPS', 'warn');
  else               setCell('cap-fs', null, 'Available', 'ok');

  setCell('cap-streams', streams, streams ? 'Supported' : 'Unsupported');

  diagnostics.capabilities = {
    secureContext: secure,
    webrtc, serviceWorkerApi: swApi,
    fileSystemAccessApi: fsApi,
    readableStream: streams,
  };

  return { secure, webrtc, swApi, fsApi, streams };
}

// Compute the at-a-glance verdict from whatever is known so far.
function updateOverall() {
  const host = document.getElementById('overall-status');
  const icon = document.getElementById('overall-icon');
  const title = document.getElementById('overall-title');
  const sub = document.getElementById('overall-sub');
  if (!host) return;

  const caps = diagnostics.capabilities || {};
  const active = diagnostics.sink && diagnostics.sink.active;
  let state, glyph, t, s;

  if (caps.webrtc === false || active === 'none') {
    state = 'bad'; glyph = '✕';
    t = 'Not supported in this browser';
    s = 'This browser lacks WebRTC, which FileSync needs to move files. Try Chrome, Edge, Firefox, or Safari.';
  } else if (active === 'blob') {
    state = 'warn'; glyph = '!';
    t = 'Works, with limits';
    s = 'Received files are buffered in memory here, so transfers above ~500 MB may fail. Serve FileSync over HTTPS to stream large files straight to disk.';
  } else if (active === 'fs' || active === 'sw') {
    state = 'ok'; glyph = '✓';
    t = 'Ready to transfer';
    s = active === 'fs'
      ? 'Files stream directly to a location you choose — no size limit beyond free disk space.'
      : 'Files stream to disk through the browser download — memory-safe for files of any size.';
  } else {
    state = 'wait'; glyph = '⏳';
    t = 'Running diagnostics…';
    s = "Checking this browser's transfer capabilities.";
  }

  host.className = 'hero hero--' + state;
  icon.textContent = glyph;
  title.textContent = t;
  sub.textContent = s;
}

// Static metadata for the three sinks. Order is the selection priority FS > SW > Blob.
const SINK_TIERS = [
  {
    key: 'fs',
    name: 'File System Access API',
    desc: 'Streams bytes directly to a file the user picks via a native save dialog. Constant memory use; best UX (user picks destination before transfer starts).',
  },
  {
    key: 'sw',
    name: 'Service Worker streaming',
    desc: 'Streams bytes to disk through the browser\'s normal download UI. Constant memory use; universal modern-browser support in secure contexts.',
  },
  {
    key: 'blob',
    name: 'Blob (legacy fallback)',
    desc: 'Buffers the entire file in JS heap before triggering a download. Memory use scales with file size; practical ceiling ~500 MB.',
  },
];

// Detect per-sink availability the same way sink.js does, so the diagnostic page
// and the production app stay aligned. Returns { fs:{available,reason}, sw, blob }.
function detectSinkAvailability(caps) {
  const out = {
    fs:   { available: false, reason: '' },
    sw:   { available: false, reason: '' },
    blob: { available: true,  reason: 'Available (always — fallback path).' },
  };
  if (!caps.fsApi) {
    out.fs.reason = 'Not supported by this browser (Chromium-only API).';
  } else if (!caps.secure) {
    out.fs.reason = 'Requires HTTPS or localhost (secure context).';
  } else {
    out.fs.available = true;
    out.fs.reason = 'Available.';
  }
  if (!caps.swApi) {
    out.sw.reason = 'Not supported by this browser.';
  } else if (!caps.secure) {
    out.sw.reason = 'Requires HTTPS or localhost (secure context).';
  } else {
    out.sw.available = true;
    out.sw.reason = 'Available.';
  }
  return out;
}

function resolveSink(caps) {
  const list    = document.getElementById('sink-tier-list');
  const explain = document.getElementById('sink-explain');
  list.innerHTML = '';

  if (!caps.webrtc) {
    const div = document.createElement('div');
    div.className = 'tier';
    div.innerHTML = '<div class="tier-icon">✕</div><div class="tier-body"><div class="tier-title">No method available</div><div class="tier-desc">This browser does not support WebRTC. FileSync will not work here at all.</div></div>';
    list.appendChild(div);
    diagnostics.sink = { active: 'none', reason: 'no-webrtc' };
    return;
  }

  const availability = detectSinkAvailability(caps);

  // Allow ?sink=… override to force a specific sink (must still be available).
  const forced = (function () {
    try {
      const q = new URLSearchParams(window.location.search).get('sink');
      if (q && ['fs','sw','blob'].includes(q)) return q;
    } catch {}
    return null;
  })();

  // Selection logic — mirror sink.js: forced wins if available, else FS > SW > Blob.
  let active;
  if (forced && availability[forced].available) active = forced;
  else if (availability.fs.available)            active = 'fs';
  else if (availability.sw.available)            active = 'sw';
  else                                           active = 'blob';

  // Render the three rows in priority order.
  for (const tier of SINK_TIERS) {
    const a = availability[tier.key];
    const isActive = tier.key === active;
    const div = document.createElement('div');
    div.className = 'tier' + (isActive ? ' selected' : '') + (a.available ? '' : ' unavailable');

    // Header line: icon + name + tag
    const tagPieces = [];
    if (isActive && forced === tier.key)              tagPieces.push('<span class="tier-tag forced-tag">Forced</span>');
    else if (isActive && tier.key === 'blob')         tagPieces.push('<span class="tier-tag fallback-tag">In use · fallback</span>');
    else if (isActive)                                tagPieces.push('<span class="tier-tag selected-tag">In use</span>');

    const icon = isActive ? '●' : (a.available ? '○' : '✕');
    div.innerHTML = `
      <div class="tier-icon">${icon}</div>
      <div class="tier-body">
        <div class="tier-title"><span class="tier-name"></span>${tagPieces.join('')}</div>
        <div class="tier-desc"></div>
        <div class="tier-reason"></div>
      </div>
    `;
    // Insert text content via textContent so we never interpret HTML in the static
    // strings (defense-in-depth even though SINK_TIERS is hardcoded).
    div.querySelector('.tier-name').textContent = tier.name;
    div.querySelector('.tier-desc').textContent = tier.desc;
    div.querySelector('.tier-reason').textContent = a.reason;
    list.appendChild(div);
  }

  // Bottom-line explanation focused on what the operator should DO with this info.
  if (active === 'blob') {
    const reasons = [];
    if (!caps.secure) reasons.push('insecure HTTP context — deploy with HTTPS to unlock streaming sinks');
    if (!caps.swApi)  reasons.push('Service Worker API not available in this browser');
    if (!caps.fsApi)  reasons.push('File System Access API not available in this browser');
    explain.textContent = 'This browser landed on the Blob fallback because: ' +
      (reasons.join('; ') || 'no better option detected') +
      '. Large transfers (>~500 MB) will fail in this configuration.';
  } else if (forced && forced === active) {
    explain.textContent = `?sink=${forced} override is active — the auto-detection would otherwise pick the best supported sink.`;
  } else {
    explain.textContent = '';
  }

  // Diagnostics JSON gets the full picture so support reports are self-contained.
  diagnostics.sink = {
    active,
    forced: forced || null,
    availability,
  };
}

async function probeServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    setCell('cap-sw-active', false, window.isSecureContext ? 'Browser lacks SW support' : 'Insecure context');
    diagnostics.capabilities.serviceWorkerActive = false;
    return;
  }
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    if (reg.active) {
      setCell('cap-sw-active', true, 'Active');
      diagnostics.capabilities.serviceWorkerActive = true;
      return;
    }
    // Wait briefly for activation.
    const worker = reg.installing || reg.waiting;
    if (!worker) { setCell('cap-sw-active', false, 'No installing/waiting worker'); diagnostics.capabilities.serviceWorkerActive = false; return; }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      worker.addEventListener('statechange', () => {
        if (worker.state === 'activated') { clearTimeout(timer); resolve(); }
      });
    });
    const ok = navigator.serviceWorker.controller != null || (reg.active != null);
    setCell('cap-sw-active', !!ok, ok ? 'Active' : 'Registered but did not activate in 5s');
    diagnostics.capabilities.serviceWorkerActive = !!ok;
  } catch (err) {
    setCell('cap-sw-active', false, 'Registration failed: ' + (err && err.message || err));
    diagnostics.capabilities.serviceWorkerActive = false;
    diagnostics.capabilities.serviceWorkerError = String(err);
  }
}

function refreshDiagnosticsView() {
  document.getElementById('diagnostics-json').textContent = JSON.stringify(diagnostics, null, 2);
}

document.getElementById('copy-btn').addEventListener('click', async () => {
  const status = document.getElementById('copy-status');
  const text = JSON.stringify(diagnostics, null, 2);
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
    }
    status.textContent = 'Copied to clipboard!'; status.style.color = 'var(--ok)';
  } catch (err) {
    status.textContent = 'Copy failed — select the report below and copy manually.'; status.style.color = 'var(--bad)';
  }
  setTimeout(() => { status.textContent = ''; status.style.color = ''; }, 3000);
});

function maybeShowLocalhostNotice() {
  // Show only when the diagnostic page itself is loaded from a loopback URL.
  // In any other deployment (LAN IP, public IP, domain), the STUN/TURN reachability
  // tests are meaningful and the notice would be misleading.
  const h = window.location.hostname;
  const isLoopback = h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
  if (isLoopback) {
    const el = document.getElementById('localhost-notice');
    if (el) el.style.display = 'flex';
    diagnostics.localhostDevMode = true;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  maybeShowLocalhostNotice();
  const caps = detectCapabilities();
  resolveSink(caps);
  updateOverall();
  refreshDiagnosticsView();
  await probeServiceWorker();
  // Re-resolve sink in case SW activation changed things (it doesn't change the choice,
  // but the active flag is informational).
  updateOverall();
  refreshDiagnosticsView();
  if (caps.webrtc) {
    try { await iceTest(); }
    catch (err) { Err.innerHTML = '<span style="color:var(--bad)">ICE test error: ' + (err.message || err) + '</span>'; }
    refreshDiagnosticsView();
  }
  try { await signalingProbe(); }
  catch (err) { console.error('signaling probe error:', err); }
  updateOverall();
  refreshDiagnosticsView();
});

// ---- Signaling-layer probe -------------------------------------------------------
// Connects to /ws as TWO ephemeral peer ids from the same browser, sends a synthetic
// relay candidate from peer A to peer B through the signaling server, and inspects
// what peer B receives. This verifies:
//   1. The signaling WebSocket is reachable.
//   2. The server's ICE-candidate rewriting is rewriting relay addresses with
//      Docker-internal IPs to the host the receiver used to reach the server.
//
// We don't ask coturn or RTCPeerConnection for anything here — it's a pure
// signaling-path test, which is what the support engineer needs to distinguish
// "rewriting works, coturn doesn't" from "rewriting broken, coturn fine".
async function signalingProbe() {
  const sigWs = document.getElementById('signal-ws');
  const sigRw = document.getElementById('signal-rewrite');
  const wsUrl = (window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host + '/ws';

  diagnostics.signalingProbe = {
    wsUrl,
    wsReachable: false,
    bothRegistered: false,
    relayCandidateSent: null,
    relayCandidateReceived: null,
    rewriteWorking: null,
    rewriteAddress: null,
    error: null,
  };

  // 8-char ids — uses the strict charset the server validates.
  const r = () => 'probe' + Math.random().toString(36).slice(2, 8);
  const idA = r(), idB = r();

  let wsA, wsB;
  try {
    wsA = await openWs(wsUrl, idA);
    wsB = await openWs(wsUrl, idB);
  } catch (err) {
    diagnostics.signalingProbe.error = String(err);
    sigWs.innerHTML = '🔴 Could not connect to signaling server: ' + err.message;
    sigRw.innerHTML = '⚪ Skipped — signaling unreachable.';
    if (wsA && wsA.readyState === 1) wsA.close();
    if (wsB && wsB.readyState === 1) wsB.close();
    return;
  }

  diagnostics.signalingProbe.wsReachable = true;
  diagnostics.signalingProbe.bothRegistered = true;
  sigWs.innerHTML = '🟢 Signaling server reachable; two ephemeral peers registered.';

  // Send a synthetic relay candidate from A to B.
  const dockerIp = '172.23.0.2';   // a private IP that should trigger rewriting
  const relayCand = `candidate:4 1 UDP 8331263 ${dockerIp} 50042 typ relay raddr ${dockerIp} rport 50042`;
  const out = {
    type: 'signal',
    to: idB,
    payload: {
      kind: 'candidate',
      connectionId: 'probe-conn-' + Math.random().toString(36).slice(2, 8),
      candidate: { candidate: relayCand, address: dockerIp, sdpMid: '0', sdpMLineIndex: 0 },
    },
  };
  diagnostics.signalingProbe.relayCandidateSent = relayCand;
  wsA.send(JSON.stringify(out));

  // Wait for B to receive (with a short timeout).
  const received = await waitFor(wsB, 5000, (msg) =>
    msg && msg.type === 'signal' && msg.payload && msg.payload.kind === 'candidate'
  );

  try { wsA.close(); wsB.close(); } catch {}

  if (!received) {
    sigRw.innerHTML = '🔴 Did not receive forwarded candidate within 5s. Signaling relay may be broken.';
    return;
  }

  const receivedLine = received.payload && received.payload.candidate && received.payload.candidate.candidate;
  const receivedAddr = received.payload && received.payload.candidate && received.payload.candidate.address;
  diagnostics.signalingProbe.relayCandidateReceived = receivedLine;
  diagnostics.signalingProbe.rewriteAddress = receivedAddr;

  if (!receivedLine) {
    sigRw.innerHTML = '🔴 Received message but no candidate line in payload.';
    return;
  }

  if (receivedLine.includes(dockerIp)) {
    // Same address came back → no rewriting happened.
    diagnostics.signalingProbe.rewriteWorking = false;
    sigRw.innerHTML = '🔴 Relay address was <strong>not</strong> rewritten. The remote peer would see <code>' + dockerIp + '</code> — unreachable from outside Docker. Either the server is missing the rewriter or the deployment is running a stale image.';
    return;
  }
  diagnostics.signalingProbe.rewriteWorking = true;
  sigRw.innerHTML = '🟢 Relay address rewritten correctly to <code>' + receivedAddr + '</code> for this client. Remote peers will receive a reachable relay address.';
}

function openWs(url, id) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('WebSocket open timed out after 5s'));
    }, 5000);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'register', id }));
    };
    const onMsg = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m && m.type === 'registered') {
        clearTimeout(timeout);
        ws.removeEventListener('message', onMsg);
        resolve(ws);
      } else if (m && m.type === 'error') {
        clearTimeout(timeout);
        try { ws.close(); } catch {}
        reject(new Error('Server rejected register: ' + (m.message || m.code)));
      }
    };
    ws.addEventListener('message', onMsg);
    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('WebSocket error during open'));
    };
    ws.onclose = (ev) => {
      clearTimeout(timeout);
      reject(new Error('WebSocket closed during open (code ' + ev.code + ')'));
    };
  });
}

function waitFor(ws, timeoutMs, predicate) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeoutMs);
    const onMsg = (ev) => {
      if (done) return;
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (predicate(m)) {
        done = true;
        clearTimeout(t);
        ws.removeEventListener('message', onMsg);
        resolve(m);
      }
    };
    ws.addEventListener('message', onMsg);
  });
}

// ---- ICE Server Test -------------------------------------------------------------
// Captures full ICE-gathering state so support reports include the actual list of
// candidates the browser produced — host vs srflx vs relay — and any errors the
// browser fired via onicecandidateerror. This is the data we need to distinguish
// "STUN/TURN unreachable" from "browser refused to surface the candidates".
async function iceTest() {
  const ice = {
    stunUrl: null,
    turnUdpUrl: null,
    turnTcpUrl: null,
    credentialsFetched: false,
    jwtDecoded: false,
    gatheringState: 'new',
    gatheringTimedOut: false,
    candidates: [],
    candidateErrors: [],
  };
  diagnostics.iceTest = ice;
  refreshDiagnosticsView();

  // 1. Fetch credentials
  const token = await _getToken();
  if (!token) {
    Err.innerHTML = '<span style="color:var(--bad)">Could not fetch TURN credentials from /api/credentials.</span>';
    return;
  }
  ice.credentialsFetched = true;

  // 2. Decode JWT payload
  let payload;
  try {
    payload = _decodeJwt(token);
    ice.jwtDecoded = true;
  } catch (err) {
    Err.innerHTML = '<span style="color:var(--bad)">Failed to decode TURN credentials: ' + (err.message || err) + '</span>';
    return;
  }

  // Use the hostname as the page is served from. The production turn.js intentionally
  // does NOT substitute 'localhost' for '127.0.0.1' (see comment in turn.js for the
  // reasoning); the test page mirrors that behavior so the diagnostic reflects what
  // the real app will see.
  const host = window.location.hostname;
  ice.stunUrl = `stun:${host}:3478`;
  ice.turnUdpUrl = `turn:${host}:3478`;
  ice.turnTcpUrl = `turn:${host}:3478?transport=tcp`;

  // 3. Create RTCPeerConnection with both UDP and TCP TURN URLs so we can verify
  // each transport independently. We never connect to a remote — we only gather.
  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: ice.stunUrl },
      {
        urls: [ice.turnUdpUrl, ice.turnTcpUrl],
        username: payload.username,
        credential: payload.credential,
      },
    ],
  });

  const matchType = (c) => {
    if (c.type) return c.type;
    // Spec: `candidate:... typ <name> ...`. Use a precise token match so we
    // don't false-positive on IP literals or hostnames containing the type word.
    const m = c.candidate && c.candidate.match(/\btyp\s+(host|srflx|prflx|relay)\b/);
    return m ? m[1] : null;
  };
  const matchAddr = (c) => {
    if (c.address) return c.address;
    // SDP candidate line: `candidate:foundation comp proto prio <addr> <port> typ ...`
    const m = c.candidate && c.candidate.match(/^candidate:\S+\s+\d+\s+\S+\s+\d+\s+(\S+)\s+\d+\s+typ/);
    return m ? m[1] : null;
  };
  const matchTransport = (c) => {
    if (c.protocol) return c.protocol.toLowerCase();
    const m = c.candidate && c.candidate.match(/^candidate:\S+\s+\d+\s+(udp|tcp)/i);
    return m ? m[1].toLowerCase() : null;
  };

  pc.onicecandidate = (e) => {
    if (!e.candidate) {
      // null candidate signals end-of-candidates
      return;
    }
    if (!e.candidate.candidate) return;

    const type      = matchType(e.candidate);
    const address   = matchAddr(e.candidate);
    const transport = matchTransport(e.candidate);
    ice.candidates.push({ type, address, transport, raw: e.candidate.candidate });

    if (type === 'srflx') {
      IP.innerHTML = '🟢 Your public IP address is ' + (address || 'unknown');
      Stun.innerHTML = '🟢 The STUN server is reachable.';
      diagnostics.iceServers.stun = true;
      diagnostics.iceServers.publicIP = address || null;
    }
    if (type === 'relay') {
      Turn.innerHTML = '🟢 The TURN server is reachable.'
        + (transport ? ' (' + transport + ')' : '');
      diagnostics.iceServers.turn = true;
    }
    refreshDiagnosticsView();
  };

  pc.onicecandidateerror = (e) => {
    ice.candidateErrors.push({
      url: e.url || null,
      address: e.address || null,
      port: e.port || null,
      errorCode: e.errorCode || null,
      errorText: e.errorText || null,
    });
    refreshDiagnosticsView();
  };

  pc.onicegatheringstatechange = () => {
    ice.gatheringState = pc.iceGatheringState;
    if (pc.iceGatheringState === 'complete') {
      // After gathering completes, decide what to report based on what actually
      // arrived. Avoid leaving the placeholder red text if the user can see real
      // diagnostic info.
      const types = new Set(ice.candidates.map(c => c.type));
      if (!types.has('srflx') && !diagnostics.iceServers.stun) {
        const n = ice.candidates.length;
        Stun.innerHTML = '🔴 STUN unreachable — gathered ' + n + ' candidate(s), none reflexive. '
          + 'See the report below for details.';
        IP.innerHTML = '🔴 Public IP could not be determined.';
      }
      if (!types.has('relay') && !diagnostics.iceServers.turn) {
        Turn.innerHTML = '🔴 TURN unreachable — no relay candidates were allocated. '
          + 'Check credentials, server reachability, and that UDP/TCP 3478 is open.';
      }
      try { pc.close(); } catch {}
      refreshDiagnosticsView();
    }
  };

  // 4. Kick off ICE gathering.
  //
  // createDataChannel MUST be called before createOffer — otherwise the offer's SDP
  // contains no m=application section, the ICE agent has no transport to attach
  // candidates to, and gathering never starts (verified empirically against real
  // Chromium: 0 candidates produced when ordered the other way). The SDP calls are
  // awaited so genuine failures surface instead of being swallowed silently.
  try {
    pc.createDataChannel('filesync-test');
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
  } catch (err) {
    Err.innerHTML = '<span style="color:var(--bad)">SDP setup failed: ' + (err.message || err) + '</span>';
    try { pc.close(); } catch {}
    return;
  }

  // 5. Safety timeout — some networks cause Firefox/Safari to hang at "gathering"
  // for ages. After 15 seconds we report whatever we have.
  setTimeout(() => {
    if (pc.iceGatheringState !== 'complete') {
      ice.gatheringTimedOut = true;
      if (!diagnostics.iceServers.stun) {
        Stun.innerHTML = '🔴 STUN check timed out after 15s.';
      }
      if (!diagnostics.iceServers.turn) {
        Turn.innerHTML = '🔴 TURN check timed out after 15s.';
      }
      try { pc.close(); } catch {}
      refreshDiagnosticsView();
    }
  }, 15000);
}

async function _getToken() {
  try {
    const response = await fetch('/api/credentials', { method: 'GET' });
    if (!response.ok) throw new Error(`Failed to fetch token: ${response.status} ${response.statusText}`);
    const data = await response.json();
    const token = data?.token;
    if (!token) throw new Error('No token found in server response.');
    return token;
  } catch (err) {
    console.error('Error fetching token:', err);
  }
}

// base64url + UTF-8 aware JWT payload decoder. The previous implementation used
// raw atob() on the payload section, but JWTs are base64url-encoded (uses '-'/'_'
// instead of '+'/'/' and strips padding). atob() rejects '-'/'_' with
// InvalidCharacterError — which fired intermittently depending on the random bytes
// in the HMAC/uuid, producing a hard-to-debug "sometimes works" failure.
function _decodeJwt(token) {
  const parts = (token || '').split('.');
  if (parts.length < 2) throw new Error('Malformed JWT (expected at least 2 segments).');
  let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) b64 += '=';
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const json = new TextDecoder('utf-8').decode(bytes);
  return JSON.parse(json);
}
