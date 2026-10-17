// Resume-UI regression tests (C1). Run: node --test --test-force-exit "tests/js/*.test.mjs"

import test from 'node:test';
import assert from 'node:assert/strict';

// ---------- browser environment stubs (must exist before app modules are imported) ----------
function makeDoc() {
  const elements = new Map();
  const makeEl = (id) => ({
    id, style: {}, textContent: '', innerHTML: '', value: '', disabled: false,
    addEventListener() {}, removeEventListener() {}, focus() {}, click() {}, remove() {},
    appendChild() {}, setAttribute() {}, removeAttribute() {},
    classList: { add() {}, remove() {}, toggle() {} },
    querySelector() { return makeEl(`${id}-q`); },
  });
  return {
    elements,
    getElementById(id) { if (!elements.has(id)) elements.set(id, makeEl(id)); return elements.get(id); },
    createElement(tag) { return makeEl(`dyn-${tag}`); },
    body: makeEl('body'),
    addEventListener() {},
  };
}
globalThis.document = makeDoc();
const _ss = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (_ss.has(k) ? _ss.get(k) : null),
  setItem: (k, v) => _ss.set(k, String(v)),
  removeItem: (k) => _ss.delete(k),
  clear: () => _ss.clear(),
};
globalThis.window = globalThis;
globalThis.location = { search: '', href: 'http://localhost:8080/', protocol: 'http:', origin: 'http://localhost:8080', hostname: 'localhost', port: '8080', replace() {} };
globalThis.addEventListener = () => {};
globalThis.isSecureContext = false;
try { globalThis.navigator = { serviceWorker: undefined, clipboard: undefined }; }
catch { try { Object.defineProperty(globalThis, 'navigator', { value: { serviceWorker: undefined, clipboard: undefined }, configurable: true }); } catch {} }

const _userUrl = new URL('../../web/js/modules/webrtc/user.js', import.meta.url);
const { User } = await import(_userUrl.href);

const FILE_ID = 'file-11111111-2222-3333-4444-555555555555';
const disp = (suffix) => document.getElementById(`file-${FILE_ID}-${suffix}`).style.display;

test('resumable state keeps the download button visible so the user can retry', () => {
  const user = new User('room-abc');            // a guest (non-empty room id)
  const file = { id: FILE_ID, name: 'report.bin', size: 4096, resumeOffset: 1024 };

  user._showResumeAvailable(file);

  assert.equal(disp('download'), 'block', 'download button MUST be visible in the resumable state');
  assert.equal(disp('icon-failed'), 'block', 'failed icon is shown');
  assert.equal(disp('icon-loading'), 'none', 'spinner cleared');
  assert.equal(disp('abort'), 'none', 'abort control hidden');

  const err = document.getElementById(`file-${FILE_ID}-error`);
  assert.match(err.textContent, /Click download to try again/);
  assert.equal(document.getElementById(`file-${FILE_ID}-progress`).textContent, '25% | ');
});

test('_abortDownloadStart resumable path also leaves the retry button visible', () => {
  const user = new User('room-abc');
  const file = {
    id: FILE_ID, name: 'report.bin', size: 1000, resumeOffset: 400,
    canResume: true, in_progress: true, _resuming: true,
  };

  user._abortDownloadStart(file, FILE_ID, 'The sender is no longer connected.');

  assert.equal(disp('download'), 'block', 'retry affordance survives a failed resume start');
  assert.equal(file.in_progress, false);
  assert.equal(file._resuming, false);
});

test('_abortDownloadStart non-resumable path shows the button and clears the spinner', () => {
  const user = new User('room-abc');
  const file = {
    id: FILE_ID, name: 'report.bin', size: 1000, resumeOffset: 0,
    canResume: false, in_progress: true, _sink: null, _peer: null,
  };

  user._abortDownloadStart(file, FILE_ID, 'Could not start the download.');

  assert.equal(disp('download'), 'block');
  assert.equal(disp('abort'), 'none');
  assert.equal(disp('icon-loading'), 'none');
});

test('_setRowState maps the download flag to the control visibility', () => {
  const user = new User('room-abc');
  user._setRowState(FILE_ID, { loading: true, abort: true });
  assert.equal(disp('download'), 'none', 'download hidden while loading');
  assert.equal(disp('abort'), 'block');
  user._setRowState(FILE_ID, { download: true });
  assert.equal(disp('download'), 'block');
});

test('downloadAll refuses a second concurrent run (does not clobber live state)', async () => {
  const user = new User('room-abc');
  const live = { active: true, interval: setInterval(() => {}, 1000) };
  user._downloadAll = live;

  await user.downloadAll();

  assert.equal(user._downloadAll, live, 'the in-flight bundle state must be left untouched');
  clearInterval(live.interval);
});
