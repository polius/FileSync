// ICE mode override (dev/testing). Mirrors the ?sink= pattern in sink.js.
//
// Modes:
//   - 'auto' (default): STUN + TURN, browser picks the best path.
//   - 'stun': drop TURN entries from iceServers before constructing the
//             RTCPeerConnection. The browser can still gather host and srflx
//             (STUN) candidates and use a direct or NAT-pierced path. Note this
//             only filters *this* peer's local candidates — the remote can still
//             offer a relay candidate, which the browser would happily use. To
//             guarantee an end-to-end direct connection, load both peers with
//             ?ice=stun.
//   - 'turn': set iceTransportPolicy: 'relay' so every byte goes through coturn.
//             Setting this on one side is enough to force the whole connection
//             onto relay candidates (the policy filters both local generation
//             and remote acceptance).
//
// Usage from a caller building an RTCConfiguration:
//   const iceServers = await turn.getServers();
//   const peer = new Peer(id, { config: applyIceMode({ iceServers }) });

import { addDevBadge } from '../devBadge.js';

const ICE_MODES = ['auto', 'stun', 'turn'];
const STORAGE_KEY = 'filesync.ice';
const QUERY_KEY = 'ice';

function readOverride() {
  let mode = null;
  try {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get(QUERY_KEY);
    if (fromQuery && ICE_MODES.includes(fromQuery)) {
      mode = fromQuery;
      if (mode === 'auto') window.sessionStorage.removeItem(STORAGE_KEY);
      else window.sessionStorage.setItem(STORAGE_KEY, mode);
    }
    if (!mode) {
      const stored = window.sessionStorage.getItem(STORAGE_KEY);
      if (stored && ICE_MODES.includes(stored) && stored !== 'auto') mode = stored;
    }
  } catch {}
  return mode; // null means "auto"
}

export const iceModeState = {
  forced: readOverride(), // null | 'stun' | 'turn'
};

export function activeIceMode() {
  return iceModeState.forced || 'auto';
}

// Apply the active mode to a candidate RTCConfiguration. Mutates and returns the
// input for ergonomics — callers spread the result into `new Peer({ config })`.
export function applyIceMode(config) {
  const mode = activeIceMode();
  if (mode === 'stun') {
    config.iceServers = (config.iceServers || []).filter((entry) => {
      const urls = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
      return urls.every((u) => typeof u === 'string' && u.toLowerCase().startsWith('stun:'));
    });
  } else if (mode === 'turn') {
    config.iceTransportPolicy = 'relay';
  }
  return config;
}

export function installIceModeBadge() {
  if (!iceModeState.forced) return;
  const tooltip =
    iceModeState.forced === 'turn'
      ? 'Forcing TURN relay (iceTransportPolicy: "relay"). Click to clear, or run __filesync.resetIce().'
      : 'Dropping TURN servers — direct/STUN only on this side. For true end-to-end direct mode, both peers need ?ice=stun. Click to clear.';
  addDevBadge({
    label: `ice: ${iceModeState.forced} (forced)`,
    tooltip,
    onClear: resetIce,
  });
}

function resetIce() {
  try { window.sessionStorage.removeItem(STORAGE_KEY); } catch {}
  const url = new URL(window.location.href);
  url.searchParams.delete(QUERY_KEY);
  window.location.replace(url.toString());
}

if (typeof window !== 'undefined') {
  window.__filesync = window.__filesync || {};
  window.__filesync.iceModeState = iceModeState;
  window.__filesync.activeIce = activeIceMode;
  window.__filesync.resetIce = resetIce;
}
