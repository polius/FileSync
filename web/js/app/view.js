// View: renders a Room into the static markup in index.html and turns user actions into
// Room calls. Rendering is batched to one pass per animation frame. User-supplied text is
// only ever assigned through textContent.

import { formatBytes, formatRate, formatDuration } from './util.js';
import { filesFromInput, filesFromDrop, filesFromPaste, typeLabel } from './files.js';
import { drawQr } from './qr.js';
import { local, session } from './storage.js';

const $ = (id) => document.getElementById(id);
const THEMES = ['auto', 'light', 'dark'];
const THEME_LABEL = { auto: 'Auto', light: 'Light', dark: 'Dark' };
const THEME_ICON = { auto: '#i-auto', light: '#i-sun', dark: '#i-moon' };
const AVATAR_COLORS = ['#2f6fdf', '#0f8a6a', '#b4570d', '#8a3fd1', '#c2306b', '#0e7c99', '#5a6b0f', '#a8461d'];
const URL_RE = /^https?:\/\/[^\s<>"']+$/i;

function setIcon(useEl, href) { useEl.setAttribute('href', href); }

function avatarColor(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function initials(name) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export class View {
  #room;
  #opts;
  #frame = 0;
  #fileRows = new Map();
  #textRows = new Map();
  #lastShareUrl = '';
  #dragDepth = 0;

  constructor(room, opts) {
    this.#room = room;
    this.#opts = opts;
    room.on('change', () => this.schedule());
    room.on('toast', ({ text, kind }) => this.toast(text, kind));
    this.#bind();
    this.#applyTheme(local.get('filesync.theme') || 'auto', false);
    if (!window.isSecureContext && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) && !session.get('filesync.insecureDismissed')) {
      $('insecure-banner').hidden = false;
    }
    this.schedule();
  }

  schedule() {
    if (this.#frame) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      this.#render();
    });
  }

  // ---- toasts ---------------------------------------------------------------------------

  toast(text, kind = 'info') {
    const box = $('toasts');
    const el = document.createElement('div');
    el.className = `toast ${kind === 'error' ? 'error' : ''}`;
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'icon');
    icon.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', kind === 'success' ? '#i-check' : kind === 'error' || kind === 'warn' ? '#i-alert' : '#i-info');
    icon.append(use);
    const span = document.createElement('span');
    span.textContent = text;
    el.append(icon, span);
    box.append(el);
    while (box.children.length > 3) box.firstElementChild.remove();
    setTimeout(() => el.remove(), kind === 'error' ? 7000 : 4000);
  }

  // ---- binding --------------------------------------------------------------------------

  #bind() {
    const room = this.#room;

    $('theme-btn').addEventListener('click', () => {
      const current = local.get('filesync.theme') || 'auto';
      this.#applyTheme(THEMES[(THEMES.indexOf(current) + 1) % THEMES.length], true);
    });
    $('about-btn').addEventListener('click', () => $('about-dialog').showModal());
    $('new-room-btn').addEventListener('click', () => this.#opts.onNewRoom());
    $('brand').addEventListener('click', (ev) => { ev.preventDefault(); this.#opts.onNewRoom(); });
    $('insecure-close').addEventListener('click', () => {
      $('insecure-banner').hidden = true;
      session.set('filesync.insecureDismissed', '1');
    });
    $('error-retry').addEventListener('click', () => location.reload());

    // Share
    $('share-link').addEventListener('focus', (ev) => ev.target.select());
    $('copy-btn').addEventListener('click', () => this.#copy($('share-link').value, $('share-link')));
    if (typeof navigator.share === 'function') {
      $('share-btn').hidden = false;
      $('share-btn').addEventListener('click', () => {
        navigator.share({ title: 'FileSync', text: 'Join my FileSync room to get the files.', url: this.#opts.shareUrl() }).catch(() => {});
      });
    }
    const wide = window.matchMedia('(min-width: 721px)');
    const syncQr = () => { $('qr-box').open = wide.matches; };
    wide.addEventListener('change', syncQr);
    syncQr();
    $('qr-box').addEventListener('toggle', () => this.#drawQr(true));

    // Password (host)
    $('password-btn').addEventListener('click', () => {
      $('set-password-input').value = '';
      $('password-remove').hidden = !room.secured;
      $('password-dialog').returnValue = '';
      $('password-dialog').showModal();
    });
    this.#reveal('set-password-reveal', 'set-password-input');
    $('password-dialog').addEventListener('close', async () => {
      const dlg = $('password-dialog');
      if (dlg.returnValue === 'ok' && $('set-password-input').value) {
        await room.setPassword($('set-password-input').value);
        this.toast('Password set. New people will need it to join.', 'success');
      } else if (dlg.returnValue === 'remove') {
        await room.setPassword('');
        this.toast('Password removed.', 'success');
      }
      $('set-password-input').value = '';
    });

    // Password (guest)
    this.#reveal('password-reveal', 'password-input');
    $('password-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const value = $('password-input').value;
      if (!value) {
        this.#showPasswordError('Enter the password.');
        return;
      }
      $('password-submit').disabled = true;
      $('password-spinner').hidden = false;
      $('password-error').hidden = true;
      await room.submitPassword(value);
    });

    // Sending
    $('send-files-btn').addEventListener('click', () => $('file-input').click());
    $('send-folder-btn').addEventListener('click', () => $('folder-input').click());
    for (const id of ['file-input', 'folder-input']) {
      $(id).addEventListener('change', (ev) => {
        this.#add(filesFromInput(ev.target));
        ev.target.value = '';
      });
    }
    window.addEventListener('dragenter', (ev) => {
      if (!this.#canSend() || !ev.dataTransfer?.types?.includes('Files')) return;
      ev.preventDefault();
      this.#dragDepth += 1;
      $('drop-overlay').hidden = false;
    });
    window.addEventListener('dragover', (ev) => {
      if (ev.dataTransfer?.types?.includes('Files')) ev.preventDefault();
    });
    window.addEventListener('dragleave', () => {
      this.#dragDepth = Math.max(0, this.#dragDepth - 1);
      if (!this.#dragDepth) $('drop-overlay').hidden = true;
    });
    window.addEventListener('drop', async (ev) => {
      if (!ev.dataTransfer?.types?.includes('Files')) return;
      ev.preventDefault();
      this.#dragDepth = 0;
      $('drop-overlay').hidden = true;
      if (this.#canSend()) this.#add(await filesFromDrop(ev.dataTransfer));
    });
    document.addEventListener('paste', (ev) => {
      if (!this.#canSend()) return;
      const target = ev.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      const entries = filesFromPaste(ev.clipboardData);
      if (entries.length) {
        ev.preventDefault();
        this.#add(entries);
        return;
      }
      const text = ev.clipboardData?.getData('text/plain');
      if (text?.trim()) {
        ev.preventDefault();
        $('text-input').value = text;
        $('text-input').focus();
        this.toast('Pasted into the message box. Select Send to share it.', 'info');
      }
    });

    // People
    $('rename-btn').addEventListener('click', () => {
      $('rename-input').value = room.me.name;
      $('rename-error').hidden = true;
      $('rename-dialog').showModal();
      $('rename-input').select();
    });
    $('rename-form').addEventListener('submit', (ev) => {
      if (ev.submitter?.value !== 'ok') return;
      const name = $('rename-input').value.trim();
      if (!name) {
        ev.preventDefault();
        $('rename-error').textContent = 'Enter a name.';
        $('rename-error').hidden = false;
        return;
      }
      if (room.rename(name)) {
        this.#opts.onRename(room.me.name);
        this.toast(`You’re now ${room.me.name}.`, 'success');
      }
    });

    // Files
    $('download-all-btn').addEventListener('click', () => room.downloadAll());
    $('bundle-action').addEventListener('click', () => {
      if (room.bundle?.state === 'running') room.cancelBundle();
      else room.dismissBundle();
    });
    $('files').addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-act]');
      if (!btn) return;
      const id = btn.closest('li.file')?.dataset.id;
      if (!id) return;
      switch (btn.dataset.act) {
        case 'download':
        case 'retry':
        case 'resume':
          room.download(id);
          break;
        case 'cancel':
          room.cancelDownload(id);
          break;
        case 'remove':
          room.removeFile(id);
          this.toast('Stopped sharing the file.', 'info');
          break;
      }
    });

    // Messages
    $('text-form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (room.sendText($('text-input').value)) $('text-input').value = '';
    });
    $('text-input').addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) $('text-form').requestSubmit();
    });
    $('texts').addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-act="copy-text"]');
      if (!btn) return;
      const body = btn.closest('li.text')?.querySelector('.text-body');
      if (body) this.#copy(body.textContent, null);
    });

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.#syncThemeAssets());
  }

  #reveal(btnId, inputId) {
    $(btnId).addEventListener('click', () => {
      const input = $(inputId);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      $(btnId).textContent = show ? 'Hide' : 'Show';
      $(btnId).setAttribute('aria-pressed', String(show));
      input.focus();
    });
  }

  #canSend() {
    return this.#room.phase === 'ready';
  }

  #add(entries) {
    if (!entries.length) return;
    const { added, skipped } = this.#room.addFiles(entries);
    if (added) this.toast(added === 1 ? 'Sharing 1 file.' : `Sharing ${added} files.`, 'success');
    if (skipped) this.toast(skipped === 1 ? 'That file is already shared.' : `${skipped} files were already shared.`, 'info');
  }

  async #copy(text, fallbackInput) {
    try {
      await navigator.clipboard.writeText(text);
      if (fallbackInput) {
        setIcon($('copy-icon'), '#i-check');
        $('copy-label').textContent = 'Copied';
        setTimeout(() => { setIcon($('copy-icon'), '#i-copy'); $('copy-label').textContent = 'Copy'; }, 1600);
      }
      this.toast('Copied to the clipboard.', 'success');
    } catch {
      if (fallbackInput) {
        fallbackInput.focus();
        fallbackInput.select();
      }
      this.toast(fallbackInput ? 'Couldn’t copy automatically. The link is selected: press Ctrl+C or ⌘C.' : 'Couldn’t copy automatically. Select the text and copy it.', 'warn');
    }
  }

  #applyTheme(mode, persist) {
    if (mode === 'light' || mode === 'dark') document.documentElement.setAttribute('data-theme', mode);
    else document.documentElement.removeAttribute('data-theme');
    if (persist) local.set('filesync.theme', mode);
    setIcon($('theme-icon'), THEME_ICON[mode]);
    $('theme-label').textContent = THEME_LABEL[mode];
    const next = THEMES[(THEMES.indexOf(mode) + 1) % THEMES.length];
    $('theme-btn').setAttribute('aria-label', `Theme: ${THEME_LABEL[mode]}. Switch to ${THEME_LABEL[next]}`);
    $('theme-btn').title = mode === 'auto' ? 'Theme follows your system' : `${THEME_LABEL[mode]} theme`;
    this.#syncThemeAssets();
  }

  #syncThemeAssets() {
    const explicit = document.documentElement.getAttribute('data-theme');
    const dark = explicit ? explicit === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    const v = $('comic').src.split('?')[1];
    $('comic').src = `/assets/${dark ? 'comic-dark' : 'comic'}.png${v ? `?${v}` : ''}`;
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.content = dark ? '#111418' : '#f6f7f9';
  }

  #showPasswordError(text) {
    $('password-error').textContent = text;
    $('password-error').hidden = false;
  }

  #drawQr(force = false) {
    const url = this.#opts.shareUrl();
    if (!url || (!force && url === this.#lastShareUrl)) return;
    if (!$('qr-box').open) return;
    this.#lastShareUrl = url;
    drawQr($('qr'), url);
  }

  // ---- render ---------------------------------------------------------------------------

  #render() {
    const room = this.#room;
    $('joining').hidden = room.phase !== 'joining' && room.phase !== 'starting';
    $('password-panel').hidden = room.phase !== 'password';
    $('error-panel').hidden = room.phase !== 'error';
    $('room').hidden = room.phase !== 'ready';
    $('new-room-btn').hidden = room.phase !== 'ready' && room.phase !== 'error';

    if (room.version) {
      $('version').textContent = /^\d/.test(room.version) ? `v${room.version}` : room.version;
      $('version').hidden = false;
    }

    this.#renderBanner();
    if (room.phase === 'starting' || room.phase === 'joining') this.#renderJoining();
    if (room.phase === 'password') this.#renderPassword();
    if (room.phase === 'error') {
      $('error-title').textContent = room.error.title;
      $('error-detail').textContent = room.error.detail;
      $('error-retry').hidden = room.error.code === 'no-webrtc';
      document.title = `${room.error.title} · FileSync`;
    }
    if (room.phase !== 'ready') return;

    this.#renderShare();
    this.#renderPeople();
    this.#renderFiles();
    this.#renderBundle();
    this.#renderTexts();
  }

  #renderBanner() {
    const room = this.#room;
    let text = '';
    if (room.server === 'reconnecting') text = 'Lost connection to the server. Reconnecting…';
    else if (!room.isHost && room.phase === 'ready' && room.hostLink === 'reconnecting') text = 'Lost connection to the host. Reconnecting…';
    $('conn-banner').hidden = !text;
    if (text) $('conn-banner-text').textContent = text;
  }

  #renderJoining() {
    const room = this.#room;
    $('joining-detail').textContent = room.isHost
      ? 'Setting up your room…'
      : room.hostLink === 'reconnecting' ? 'Still trying to reach the host…' : 'Connecting directly to the person who shared the link.';
  }

  #renderPassword() {
    const room = this.#room;
    const err = room.passwordError;
    const btn = $('password-submit');
    $('password-spinner').hidden = true;
    if (!err) {
      btn.disabled = false;
      return;
    }
    const left = Math.ceil((err.at + err.retryAfter * 1000 - Date.now()) / 1000);
    if (left > 0) {
      btn.disabled = true;
      this.#showPasswordError(`That password isn’t right. Try again in ${left} s.`);
      setTimeout(() => this.schedule(), 1000);
    } else {
      btn.disabled = false;
      this.#showPasswordError('That password isn’t right. Try again.');
      if (document.activeElement === document.body) $('password-input').focus();
    }
    $('password-input').select?.();
  }

  #renderShare() {
    const room = this.#room;
    const url = this.#opts.shareUrl();
    if ($('share-link').value !== url) $('share-link').value = url;
    this.#drawQr();

    const others = [...room.members.values()].filter((m) => !m.isMe);
    const dot = $('status-dot');
    if (room.isHost) {
      document.title = others.length ? `FileSync · ${others.length} connected` : 'FileSync · Waiting for people';
      dot.className = `dot ${others.length ? 'ok' : 'wait'}`;
      $('status-text').textContent = others.length === 0 ? 'Waiting for people to join'
        : others.length === 1 ? '1 person connected' : `${others.length} people connected`;
      $('share-title').textContent = 'Share this link with the devices you want to send files to';
    } else {
      const host = room.members.get(room.hostId);
      const reconnecting = room.hostLink === 'reconnecting';
      document.title = 'FileSync · Room';
      dot.className = `dot ${reconnecting ? 'wait' : 'ok'}`;
      $('status-text').textContent = reconnecting ? 'Reconnecting to the host…' : `Connected to ${host?.name || 'the host'}`;
      $('share-title').textContent = 'You’re in the room. Invite more devices with this link';
    }

    const vb = $('verify-badge');
    vb.hidden = room.isHost;
    if (!room.isHost) {
      vb.replaceChildren();
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('class', 'icon');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      icon.append(use);
      const label = document.createElement('span');
      if (room.verified) {
        vb.className = 'badge ok';
        use.setAttribute('href', '#i-shield');
        label.textContent = 'Verified connection';
        vb.title = 'The link’s security key confirmed that you’re connected directly to the host, with nobody in between.';
      } else {
        vb.className = 'badge';
        use.setAttribute('href', '#i-info');
        label.textContent = 'Not verified';
        vb.title = 'You joined without the security key that shared links include, so FileSync can’t rule out a server in the middle. Use the full shared link to verify.';
      }
      vb.append(icon, label);
    }
    $('password-badge').hidden = !room.secured;
    $('password-btn').hidden = !room.isHost;
    $('password-btn').textContent = room.secured ? 'Change password' : 'Add a password';
  }

  #renderPeople() {
    const room = this.#room;
    const list = $('people');
    const tpl = $('person-tpl');
    const members = [...room.members.values()].sort((a, b) => (b.isHost - a.isHost) || (b.isMe - a.isMe) || a.name.localeCompare(b.name));
    const rows = members.map((m) => {
      const li = tpl.content.firstElementChild.cloneNode(true);
      const av = li.querySelector('.avatar');
      av.textContent = initials(m.name);
      av.style.setProperty('--avatar', avatarColor(m.id));
      li.querySelector('.person-name').textContent = m.name;
      li.querySelector('.host-tag').hidden = !m.isHost;
      li.querySelector('.me-tag').hidden = !m.isMe;
      li.querySelector('.verified-tag').hidden = !(room.isHost && !m.isMe && m.verified);
      return li;
    });
    list.replaceChildren(...rows);
    $('people-count').textContent = `(${members.length})`;
    $('people-empty').hidden = members.length > 1;
  }

  #renderFiles() {
    const room = this.#room;
    const list = $('files');
    const tpl = $('file-tpl');
    const files = [...room.files.values()];
    // Newest first.
    for (const f of files) {
      if (this.#fileRows.has(f.id)) continue;
      const li = tpl.content.firstElementChild.cloneNode(true);
      li.dataset.id = f.id;
      li.querySelector('.file-base').textContent = f.name;
      li.querySelector('.file-path').textContent = f.path ? `${f.path}/` : '';
      li.querySelector('.file-ext').textContent = typeLabel(f.name);
      list.prepend(li);
      this.#fileRows.set(f.id, li);
    }
    for (const [id, li] of this.#fileRows) {
      if (!room.files.has(id)) { li.remove(); this.#fileRows.delete(id); }
    }
    for (const f of files) this.#renderFile(this.#fileRows.get(f.id), f);

    const shared = files.filter((f) => f.mine ? f.status === 'shared' : f.status !== 'unavailable');
    const total = shared.reduce((s, f) => s + f.size, 0);
    $('files-count').textContent = files.length ? `(${shared.length} · ${formatBytes(total)})` : '';
    $('files-empty').hidden = files.length > 0;
    const downloadable = files.filter((f) => !f.mine && ['available', 'done', 'failed'].includes(f.status) && room.members.has(f.owner));
    $('download-all-btn').hidden = downloadable.length < 2 || room.bundle?.state === 'running';
    $('download-all-label').textContent = `Download all (${downloadable.length})`;
  }

  #renderFile(li, f) {
    const room = this.#room;
    const owner = f.mine ? 'you' : (room.members.get(f.owner)?.name || 'someone who left');
    const thumb = li.querySelector('.file-thumb img');
    if (f.thumb && thumb.getAttribute('src') !== f.thumb) { thumb.src = f.thumb; thumb.hidden = false; li.querySelector('.file-ext').hidden = true; }

    const meta = li.querySelector('.file-meta');
    const note = li.querySelector('.file-note');
    const bar = li.querySelector('.bar');
    const recv = li.querySelector('.receivers');
    const show = { download: false, resume: false, retry: false, cancel: false, remove: false };
    let noteText = '';
    let noteKind = '';
    let barState = null;
    let metaText = `${formatBytes(f.size)} · from ${owner}`;
    const inBundle = room.bundle?.state === 'running' && room.bundle.ids.has(f.id);

    if (f.mine) {
      metaText = `${formatBytes(f.size)} · shared by you`;
      if (f.status === 'shared') {
        show.remove = true;
        const recs = [...f.receivers.values()];
        recv.hidden = recs.length === 0;
        if (recs.length) {
          const sending = recs.filter((r) => r.status === 'sending').length;
          const done = recs.filter((r) => r.status === 'done').length;
          const parts = [];
          if (sending) parts.push(`sending to ${sending}`);
          if (done) parts.push(`${done} received`);
          recv.querySelector('summary').textContent = parts.length ? parts.join(' · ').replace(/^./, (c) => c.toUpperCase()) : `${recs.length} stopped`;
          const items = recs.map((r) => {
            const item = document.createElement('li');
            const name = document.createElement('span');
            name.textContent = r.name;
            const state = document.createElement('span');
            state.textContent = r.status === 'done' ? 'Received' : r.status === 'sending' ? `${Math.floor((r.bytes / Math.max(1, f.size)) * 100)}%`
              : r.status === 'paused' ? 'Interrupted' : 'Stopped';
            item.append(name, state);
            return item;
          });
          recv.querySelector('ul').replaceChildren(...items);
        }
      } else {
        recv.hidden = true;
        noteText = 'You stopped sharing this file.';
      }
    } else {
      recv.hidden = true;
      switch (f.status) {
        case 'available':
          show.download = !inBundle;
          break;
        case 'waiting':
          metaText = `${formatBytes(f.size)} · connecting to ${owner}…`;
          barState = 'paused';
          show.cancel = !inBundle;
          break;
        case 'queued':
          metaText = `${formatBytes(f.size)} · ${owner} is busy, you’re ${ordinal(f.queuePos || 1)} in line`;
          barState = 'paused';
          show.cancel = !inBundle;
          break;
        case 'transferring': {
          const rate = f.meter.rate;
          const left = rate > 0 ? (f.size - f.written) / rate : NaN;
          metaText = `${formatBytes(f.written)} of ${formatBytes(f.size)}${rate > 0 ? ` · ${formatRate(rate)} · ${formatDuration(left)} left` : ''}`;
          barState = 'active';
          show.cancel = !inBundle;
          break;
        }
        case 'retrying':
          metaText = `${formatBytes(f.written)} of ${formatBytes(f.size)} · reconnecting…`;
          barState = 'paused';
          show.cancel = !inBundle;
          break;
        case 'paused':
          metaText = `${formatBytes(f.written)} of ${formatBytes(f.size)} · paused`;
          barState = 'paused';
          noteText = f.error || '';
          noteKind = 'bad';
          show.resume = true;
          show.cancel = true;
          break;
        case 'done':
          noteText = f.sha256 ? 'Saved and verified (SHA-256)' : 'Saved';
          noteKind = 'ok';
          show.download = !inBundle;
          break;
        case 'failed':
          noteText = f.error || 'The download didn’t finish.';
          noteKind = 'bad';
          show.retry = !inBundle;
          break;
        case 'unavailable':
          noteText = f.error || 'No longer available.';
          break;
      }
    }

    meta.textContent = metaText;
    li.classList.toggle('inactive', f.status === 'unavailable' || f.status === 'removed');
    note.hidden = !noteText;
    note.className = `file-note ${noteKind}`;
    note.textContent = noteText;
    if (f.status === 'done' && f.sha256) note.title = `SHA-256: ${f.sha256}`; else note.removeAttribute('title');
    li.querySelector('.done-mark').hidden = f.status !== 'done';
    bar.hidden = !barState;
    if (barState) {
      bar.className = `bar ${barState === 'done' ? 'done' : barState === 'paused' ? 'paused' : ''}`;
      const pct = f.size > 0 ? (f.written / f.size) * 100 : 100;
      bar.querySelector('span').style.setProperty('--p', `${barState === 'done' ? 100 : pct.toFixed(1)}%`);
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-label', `Download of ${f.name}`);
      bar.setAttribute('aria-valuenow', String(Math.floor(barState === 'done' ? 100 : pct)));
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', '100');
    }
    for (const btn of li.querySelectorAll('button[data-act]')) {
      btn.hidden = !show[btn.dataset.act];
      btn.setAttribute('aria-label', `${btn.textContent.trim()}: ${f.name}`);
    }
    if (show.download && f.status === 'done') li.querySelector('[data-act="download"] span').textContent = 'Download again';
    else li.querySelector('[data-act="download"] span').textContent = 'Download';
  }

  #renderBundle() {
    const b = this.#room.bundle;
    $('bundle').hidden = !b || b.state === 'cancelled';
    if (!b) return;
    if (b.state === 'cancelled') { this.#room.dismissBundle(); return; }
    const current = b.current?.file;
    const bytes = b.doneBytes + (current && b.state === 'running' ? current.written : 0);
    const pct = b.total ? Math.min(100, (bytes / b.total) * 100) : 0;
    const bar = $('bundle-bar');
    bar.querySelector('span').style.setProperty('--p', `${b.state === 'done' ? 100 : pct.toFixed(1)}%`);
    bar.className = `bar ${b.state === 'done' ? 'done' : b.state === 'failed' ? 'paused' : ''}`;
    if (b.state === 'running') {
      $('bundle-title').textContent = `Downloading ${Math.min(b.index, b.count)} of ${b.count} files as one zip`;
      $('bundle-detail').textContent = `${formatBytes(bytes)} of ${formatBytes(b.total)}`;
      $('bundle-action').textContent = 'Cancel';
    } else if (b.state === 'done') {
      $('bundle-title').textContent = 'Zip saved';
      $('bundle-detail').textContent = b.skipped ? `${b.count - b.skipped} files. ${b.skipped} weren’t available.` : `${b.count} files · ${formatBytes(b.total)}`;
      $('bundle-action').textContent = 'Dismiss';
    } else {
      $('bundle-title').textContent = 'Download all stopped';
      $('bundle-detail').textContent = b.error || 'The zip wasn’t saved.';
      $('bundle-action').textContent = 'Dismiss';
    }
  }

  #renderTexts() {
    const room = this.#room;
    const list = $('texts');
    const tpl = $('text-tpl');
    for (const t of room.texts) {
      if (this.#textRows.has(t.id)) continue;
      const li = tpl.content.firstElementChild.cloneNode(true);
      li.querySelector('.text-from').textContent = t.from === room.me.id ? 'You' : t.name;
      const time = li.querySelector('time');
      const d = new Date(t.at);
      time.dateTime = d.toISOString();
      time.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      li.querySelector('.text-body').textContent = t.body;
      const trimmed = t.body.trim();
      if (URL_RE.test(trimmed)) {
        const a = li.querySelector('[data-act="open"]');
        a.href = trimmed;
        a.hidden = false;
      }
      list.prepend(li);
      this.#textRows.set(t.id, li);
    }
    const ids = new Set(room.texts.map((t) => t.id));
    for (const [id, li] of this.#textRows) if (!ids.has(id)) { li.remove(); this.#textRows.delete(id); }
    $('texts-count').textContent = room.texts.length ? `(${room.texts.length})` : '';
  }
}
