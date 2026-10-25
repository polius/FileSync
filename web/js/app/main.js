// Boot: decide whether this tab hosts or joins a room, restore its session after a reload,
// then wire the Room to the View.
//
//   /                     start a new room (then the address becomes /<room>#k=<key>)
//   /<room>#k=<key>       join with the link's security key (verified)
//   /<room>               join from a typed code (works, but not verified)
//
// Session data lives in sessionStorage, per tab: a reload keeps the same room and peer id
// (the server holds our id for a short grace period), a new tab starts fresh.

import { Room } from './room.js';
import { View } from './view.js';
import { Signaling } from './signaling.js';
import { Network } from './net.js';
import { openSink, registerServiceWorker, installSinkBadge } from './sink.js';
import { installIceModeBadge } from './mode.js';
import { makeThumbnail } from './files.js';
import { local, session } from './storage.js';
import { generateRoomId, generateName, randomId, randomToken, randomLinkKey, ROOM_ID_RE, LINK_KEY_RE, cleanName } from './util.js';
import { downloadZip } from '../vendors/client-zip.min.js';

const HOST_KEY = 'filesync.host';
const guestKey = (roomId) => `filesync.guest.${roomId}`;

function readFragmentKey() {
  const m = /(?:^#|&)k=([^&]+)/.exec(location.hash);
  return m && LINK_KEY_RE.test(m[1]) ? m[1] : null;
}

function resolveSession() {
  const path = location.pathname.replace(/^\/+|\/+$/g, '');
  const host = session.getJSON(HOST_KEY);
  if (ROOM_ID_RE.test(path)) {
    if (host && host.roomId === path) return { role: 'host', ...host };
    const key = readFragmentKey();
    const saved = session.getJSON(guestKey(path));
    const guest = saved && typeof saved.id === 'string' && typeof saved.token === 'string'
      ? saved : { id: randomId(), token: randomToken() };
    session.setJSON(guestKey(path), guest);
    return { role: 'guest', roomId: path, id: guest.id, token: guest.token, key };
  }
  // A fresh room. The host's peer id is the room id.
  const fresh = { roomId: generateRoomId(), token: randomToken(), key: randomLinkKey(), verifier: null };
  session.setJSON(HOST_KEY, fresh);
  history.replaceState(null, '', `/${fresh.roomId}#k=${fresh.key}`);
  return { role: 'host', ...fresh };
}

function myName() {
  const saved = cleanName(local.get('filesync.name') || '');
  if (saved) return saved;
  const name = generateName();
  local.set('filesync.name', name);
  return name;
}

const swReady = registerServiceWorker().catch(() => {});

function boot() {
  const s = resolveSession();
  const room = new Room({
    role: s.role,
    roomId: s.roomId,
    me: { id: s.role === 'host' ? s.roomId : s.id, token: s.token, name: myName() },
    key: s.key,
    verifier: s.role === 'host' ? s.verifier : null,
    deps: {
      Signaling,
      Network,
      makeThumbnail,
      downloadZip,
      // Wait for the Service Worker before choosing a sink (it is usually ready long
      // before the first click, so this keeps the save dialog inside the user gesture).
      openSink: async (opts) => { await swReady; return openSink(opts); },
    },
  });

  // Persist the host's password verifier so a reload keeps the room protected.
  room.on('settings', () => {
    if (room.isHost) session.setJSON(HOST_KEY, { roomId: s.roomId, token: s.token, key: s.key, verifier: room.verifier });
  });

  const shareUrl = () => `${location.origin}/${room.roomId}${s.key ? `#k=${s.key}` : ''}`;
  const view = new View(room, {
    shareUrl,
    onRename: (name) => local.set('filesync.name', name),
    onNewRoom: () => {
      const go = () => {
        room.leave();
        session.remove(HOST_KEY);
        location.assign('/');
      };
      if (!room.busy) return go();
      const dlg = document.getElementById('confirm-dialog');
      document.getElementById('confirm-title').textContent = 'Leave this room?';
      document.getElementById('confirm-text').textContent = room.isHost
        ? 'Everyone in the room will be disconnected and transfers will stop.'
        : 'Your transfers will stop, and files you shared will no longer be available.';
      document.getElementById('confirm-ok').textContent = 'Leave room';
      dlg.returnValue = '';
      dlg.addEventListener('close', () => { if (dlg.returnValue === 'ok') go(); }, { once: true });
      dlg.showModal();
    },
  });

  // Ask before closing only when it would break something for someone.
  window.addEventListener('beforeunload', (ev) => {
    if (!room.busy) return;
    ev.preventDefault();
    ev.returnValue = '';
  });
  window.addEventListener('pagehide', (ev) => { if (!ev.persisted) room.leave(); });

  installSinkBadge();
  installIceModeBadge();
  room.start();
  return { room, view };
}

const app = boot();
// Handy in the console and for end-to-end tests.
window.__filesync = Object.assign(window.__filesync || {}, { room: app.room });
