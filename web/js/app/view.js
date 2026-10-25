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
const URL_RE = /^https?:\/\/[^\s<>"']+$/i;

function setIcon(useEl, href) { useEl.setAttribute('href', href); }

function percent(done, total) { return `${Math.floor((Math.min(done, total) / Math.max(1, total)) * 100)}%`; }

function svgIcon(href) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', href);
  svg.append(use);
  return svg;
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
  #peopleKey = '';
  #lastShareUrl = '';
  #dragDepth = 0;
  #about = false;
  #seenTexts = new Set();
  #wide = window.matchMedia('(min-width: 721px)');

  constructor(room, opts) {
    this.#room = room;
    this.#opts = opts;
    room.on('change', () => this.schedule());
    room.on('toast', ({ text, kind }) => {
      // The open Messages dialog already shows new messages.
      if (kind === 'message' && $('messages-dialog').open) return;
      this.toast(text, kind);
    });
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
    el.className = `toast ${kind}`;
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'icon');
    icon.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', kind === 'success' ? '#i-check-circle-fill' : kind === 'error' || kind === 'warn' ? '#i-exclamation-circle-fill'
      : kind === 'message' ? '#i-chat-left-text' : '#i-info-circle-fill');
    icon.append(use);
    const span = document.createElement('span');
    span.textContent = text;
    el.append(icon, span);
    if (kind === 'message') el.addEventListener('click', () => { el.remove(); this.#openMessages(); });
    box.append(el);
    while (box.children.length > 3) box.firstElementChild.remove();
    // Confirmations go quickly; anything to read or act on stays longer. Fades out.
    setTimeout(() => {
      el.classList.add('leaving');
      el.addEventListener('animationend', () => el.remove(), { once: true });
    }, kind === 'success' ? 2500 : kind === 'error' ? 7000 : 4000);
  }

  // ---- binding --------------------------------------------------------------------------

  #bind() {
    const room = this.#room;

    $('theme-btn').addEventListener('click', () => {
      const current = local.get('filesync.theme') || 'auto';
      this.#applyTheme(THEMES[(THEMES.indexOf(current) + 1) % THEMES.length], true);
    });
    // About replaces the page content while open, like v1; the link turns into "Go back".
    $('about-btn').addEventListener('click', () => {
      this.#about = !this.#about;
      $('about-btn').textContent = this.#about ? 'Go back' : 'About';
      $('about-btn').setAttribute('aria-expanded', String(this.#about));
      this.#render();
      if (this.#about) $('about-title').scrollIntoView({ block: 'nearest' });
    });
    $('brand').addEventListener('click', (ev) => { ev.preventDefault(); this.#opts.onNewRoom(); });
    $('insecure-close').addEventListener('click', () => {
      $('insecure-banner').hidden = true;
      session.set('filesync.insecureDismissed', '1');
    });
    $('error-retry').addEventListener('click', () => location.reload());

    // Share
    // The box shows the link up to the room code, which is easy to type; copying (button or
    // keyboard) gives the full link with the key after the # that makes the join verified.
    $('share-link').addEventListener('focus', (ev) => ev.target.select());
    $('share-link').addEventListener('copy', (ev) => {
      const input = ev.target;
      if (input.selectionStart !== 0 || input.selectionEnd !== input.value.length) return;
      ev.preventDefault();
      ev.clipboardData.setData('text/plain', this.#opts.shareUrl());
    });
    $('copy-btn').addEventListener('click', () => this.#copy(this.#opts.shareUrl(), $('share-link')));
    // A click copies without focusing or selecting; Tab focus still selects for keyboard copy.
    $('share-link').addEventListener('mousedown', (ev) => ev.preventDefault());
    $('share-link').addEventListener('click', () => this.#copy(this.#opts.shareUrl(), $('share-link')));
    if (typeof navigator.share === 'function') {
      $('share-btn').hidden = false;
      $('share-btn').addEventListener('click', () => {
        navigator.share({ title: 'FileSync', text: 'Join my FileSync room to get the files.', url: this.#opts.shareUrl() }).catch(() => {});
      });
    }
    const syncQr = () => { $('qr-box').open = this.#wide.matches; this.#fitQr(); };
    this.#wide.addEventListener('change', syncQr);
    syncQr();
    $('qr-box').addEventListener('toggle', () => this.#drawQr(true));
    // On wide screens the QR runs from the status line to the bottom of the buttons.
    new ResizeObserver(() => this.#fitQr()).observe(document.querySelector('.share-main'));

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
        this.#openMessages();
        $('text-input').value = text;
        this.#fitComposer();
      }
    });

    // People
    // Only a dialog's main action is a submit button, so Enter in its field saves. ✕, Cancel
    // and Remove password close the dialog with their data-close value instead.
    document.addEventListener('click', (ev) => {
      const btn = ev.target.closest('dialog [data-close]');
      if (btn) btn.closest('dialog').close(btn.dataset.close || 'cancel');
    });
    $('people').addEventListener('click', (ev) => {
      if (!ev.target.closest('button[data-act="rename"]')) return;
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
    $('messages-btn').addEventListener('click', () => this.#openMessages());
    $('messages-dialog').addEventListener('close', () => this.schedule());
    $('text-form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (room.sendText($('text-input').value)) {
        $('text-input').value = '';
        this.#fitComposer();
      }
    });
    // Enter sends, Shift+Enter adds a line; the box grows with its text.
    $('text-input').addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        $('text-form').requestSubmit();
      }
    });
    $('text-input').addEventListener('input', () => this.#fitComposer());
    $('texts').addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-act]');
      const li = btn?.closest('li.text');
      if (!li) return;
      if (btn.dataset.act === 'copy-text') this.#copy(li.querySelector('.text-body').textContent, null);
      if (btn.dataset.act === 'delete-text' && !room.deleteText(li.dataset.id)) {
        this.toast('Couldn’t delete the message: you’re not connected to the host. Try again in a moment.', 'warn');
      }
    });

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.#syncThemeAssets());
  }

  #reveal(btnId, inputId) {
    $(btnId).addEventListener('click', () => {
      const input = $(inputId);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      setIcon($(btnId).querySelector('use'), show ? '#i-eye-slash-fill' : '#i-eye-fill');
      $(btnId).setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      $(btnId).setAttribute('aria-pressed', String(show));
      input.focus();
    });
  }

  #openMessages() {
    const dlg = $('messages-dialog');
    if (!dlg.open) dlg.showModal();
    this.#renderTexts();
    $('messages-body').scrollTop = $('messages-body').scrollHeight;
    $('text-input').focus();
  }

  #fitComposer() {
    const ta = $('text-input');
    ta.style.height = '';
    if (ta.value) ta.style.height = `${ta.scrollHeight + 3}px`;
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
        setIcon($('copy-icon'), '#i-check-lg');
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
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.content = dark ? '#212529' : '#ffffff';
    this.#drawQr(true); // the modules use the theme's text color
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

  #fitQr() {
    const canvas = $('qr');
    let size = 185;
    if (this.#wide.matches) {
      const top = document.querySelector('.status-row').getBoundingClientRect().top;
      const bottom = document.querySelector('.send-actions').getBoundingClientRect().bottom;
      if (bottom <= top) return; // not laid out yet
      size = Math.round(Math.min(260, Math.max(150, bottom - top)));
    }
    if (Math.abs(canvas.clientWidth - size) < 2 && canvas.style.width) return;
    canvas.style.width = canvas.style.height = `${size}px`;
    this.#drawQr(true);
  }

  // ---- render ---------------------------------------------------------------------------

  #render() {
    const room = this.#room;
    const about = this.#about;
    $('about-panel').hidden = !about;
    $('joining').hidden = about || (room.phase !== 'joining' && room.phase !== 'starting');
    $('password-panel').hidden = about || room.phase !== 'password';
    $('error-panel').hidden = about || room.phase !== 'error';
    $('room').hidden = about || room.phase !== 'ready';

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
    const shown = url.split('#')[0];
    if ($('share-link').value !== shown) $('share-link').value = shown;
    $('share-link').dataset.link = url;
    this.#drawQr();

    const others = [...room.members.values()].filter((m) => !m.isMe);
    const dot = $('status-dot');
    if (room.isHost) {
      document.title = others.length ? `FileSync · ${others.length} connected` : 'FileSync · Waiting for people';
      dot.className = `dot ${others.length ? 'ok' : 'wait'}`;
      $('status-text').textContent = others.length === 0 ? 'Waiting for people to join…'
        : others.length === 1 ? `Connected to ${others[0].name}` : `${others.length} people connected`;
      $('share-title').textContent = 'Share the room link with the devices you want to send files to.';
    } else {
      const host = room.members.get(room.hostId);
      const reconnecting = room.hostLink === 'reconnecting';
      document.title = 'FileSync · Room';
      dot.className = `dot ${reconnecting ? 'wait' : 'ok'}`;
      $('status-text').textContent = reconnecting ? 'Reconnecting to the host…' : `Connected to ${host?.name || 'the host'}`;
      $('share-title').textContent = 'You’re in the room. Invite more devices with this link.';
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
        vb.className = 'pill ok';
        use.setAttribute('href', '#i-shield-fill-check');
        label.textContent = 'Verified';
        vb.title = 'The link’s security key confirmed that you’re connected directly to the host, with nobody in between.';
      } else {
        vb.className = 'pill';
        use.setAttribute('href', '#i-info-circle');
        label.textContent = 'Not verified';
        vb.title = 'You joined without the security key that shared links include, so FileSync can’t rule out a server in the middle. Use the full shared link to verify.';
      }
      vb.append(icon, label);
    }
    $('password-badge').hidden = !room.secured;
    $('password-btn').hidden = !room.isHost;
    $('password-btn-label').textContent = room.secured ? 'Change password' : 'Add password';
  }

  #renderPeople() {
    const room = this.#room;
    const list = $('people');
    const tpl = $('person-tpl');
    const members = [...room.members.values()].sort((a, b) => (b.isHost - a.isHost) || (b.isMe - a.isMe) || a.name.localeCompare(b.name));
    // Rebuild only when the list changes, so the Change name button keeps focus mid-transfer.
    const key = JSON.stringify([room.isHost, members.map((m) => [m.id, m.name, m.isHost, m.isMe, m.verified])]);
    if (key === this.#peopleKey) return;
    this.#peopleKey = key;
    const hadFocus = list.contains(document.activeElement);
    const rows = members.map((m) => {
      const li = tpl.content.firstElementChild.cloneNode(true);
      // v1 markers: a star for the host, a bolt for everyone connected.
      li.classList.toggle('host', m.isHost);
      setIcon(li.querySelector('.role use'), m.isHost ? '#i-star-fill' : '#i-lightning-charge-fill');
      li.querySelector('.role').setAttribute('aria-label', m.isHost ? 'Host' : 'Connected');
      li.querySelector('.role').setAttribute('role', 'img');
      li.querySelector('.person-name').textContent = m.isMe ? `${m.name} (You)` : m.name;
      li.querySelector('.verified-tag').toggleAttribute('hidden', !(room.isHost && !m.isMe && m.verified));
      li.querySelector('.rename').hidden = !m.isMe;
      return li;
    });
    list.replaceChildren(...rows);
    if (hadFocus) list.querySelector('.rename:not([hidden])')?.focus();
    $('people-count').textContent = `(${members.length})`;
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
      li.title = `${f.path ? `${f.path}/` : ''}${f.name} (${typeLabel(f.name)})`;
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
    const thumb = li.querySelector('.file-thumb');
    if (f.thumb && thumb.getAttribute('src') !== f.thumb) { thumb.src = f.thumb; thumb.hidden = false; }

    const meta = li.querySelector('.file-meta');
    const note = li.querySelector('.file-note');
    const bar = li.querySelector('.bar');
    const recv = li.querySelector('.receivers');
    const show = { download: false, resume: false, retry: false, cancel: false, remove: false };
    let noteText = '';
    let noteKind = '';
    let barState = null;
    let metaText = `${formatBytes(f.size)} | Sent by ${owner}`;
    const inBundle = room.bundle?.state === 'running' && room.bundle.ids.has(f.id);

    if (f.mine) {
      metaText = `${formatBytes(f.size)} | Sent by you`;
      if (f.status === 'shared') {
        show.remove = true;
        const recs = [...f.receivers.values()];
        recv.hidden = recs.length === 0;
        if (recs.length) {
          const count = (status) => recs.filter((r) => r.status === status).length;
          const sending = count('sending');
          const done = count('done');
          const paused = count('paused');
          const stopped = recs.length - sending - done - paused;
          const parts = [];
          if (sending) parts.push(`Sending to ${sending}`);
          if (done) parts.push(`Received by ${done}`);
          if (paused) parts.push(`${paused} interrupted`);
          if (stopped) parts.push(`${stopped} stopped`);
          recv.querySelector('.recv-summary').textContent = parts.map((p, i) => (i ? p[0].toLowerCase() + p.slice(1) : p)).join(' · ');
          const summaryIcon = recv.querySelector('.icon.state');
          summaryIcon.setAttribute('class', `icon state ${sending ? 'sending' : done === recs.length ? 'ok' : ''}`);
          setIcon(summaryIcon.querySelector('use'), sending ? '#i-arrow-up-short' : done === recs.length ? '#i-check-circle-fill' : '#i-exclamation-circle-fill');
          const items = recs.map((r) => {
            const item = document.createElement('li');
            const name = document.createElement('span');
            name.className = 'recv-name';
            name.textContent = r.name;
            const state = document.createElement('span');
            const label = document.createElement('span');
            if (r.status === 'sending') {
              const pct = Math.floor((r.bytes / Math.max(1, f.size)) * 100);
              const bar = document.createElement('span');
              bar.className = 'bar';
              bar.setAttribute('aria-hidden', 'true');
              const fill = document.createElement('span');
              fill.style.setProperty('--p', `${pct}%`);
              bar.append(fill);
              label.textContent = `${pct}%`;
              state.className = 'recv-state';
              state.append(bar, label);
            } else {
              const [cls, href, text] = r.status === 'done' ? ['ok', '#i-check-circle-fill', 'Received']
                : r.status === 'paused' ? ['warn', '#i-exclamation-circle-fill', 'Interrupted'] : ['', '#i-x-circle-fill', 'Stopped'];
              label.textContent = text;
              state.className = `recv-state ${cls}`;
              state.append(svgIcon(href), label);
            }
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
          metaText = `${formatBytes(f.size)} | Connecting to ${owner}…`;
          barState = 'paused';
          show.cancel = !inBundle;
          break;
        case 'queued':
          metaText = `${formatBytes(f.size)} | ${owner} is busy, you’re ${ordinal(f.queuePos || 1)} in line`;
          barState = 'paused';
          show.cancel = !inBundle;
          break;
        case 'transferring': {
          const rate = f.meter.rate;
          const left = rate > 0 ? (f.size - f.written) / rate : NaN;
          metaText = `${percent(f.written, f.size)} | ${formatBytes(f.written)} of ${formatBytes(f.size)}${rate > 0 ? ` | ${formatRate(rate)} | ${formatDuration(left)} left` : ''}`;
          barState = 'active';
          show.cancel = !inBundle;
          break;
        }
        case 'retrying':
          metaText = `${percent(f.written, f.size)} | ${formatBytes(f.written)} of ${formatBytes(f.size)} | Reconnecting…`;
          barState = 'paused';
          show.cancel = !inBundle;
          break;
        case 'paused':
          metaText = `${percent(f.written, f.size)} | ${formatBytes(f.written)} of ${formatBytes(f.size)} | Paused`;
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
    // v1 row marker: arrow for direction, spinner while moving, check or cross when settled.
    const busy = !f.mine && ['waiting', 'queued', 'transferring', 'retrying'].includes(f.status);
    const state = li.querySelector('.state');
    const mark = f.status === 'done' ? ['#i-check-circle-fill', 'ok'] : f.status === 'failed' ? ['#i-x-circle-fill', 'bad']
      : [f.mine ? '#i-arrow-up-short' : '#i-arrow-down-short', ''];
    setIcon(state.querySelector('use'), mark[0]);
    state.setAttribute('class', `icon state ${mark[1]}`);
    state.toggleAttribute('hidden', busy);
    li.querySelector('.file-name .spinner').hidden = !busy;
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
    li.querySelector('[data-act="download"] span').textContent = f.status === 'done' ? 'Download again' : 'Download';
    for (const btn of li.querySelectorAll('button[data-act]')) {
      btn.hidden = !show[btn.dataset.act];
      const label = btn.textContent.trim();
      btn.title = label;
      btn.setAttribute('aria-label', `${label}: ${f.name}`);
    }
  }

  #renderBundle() {
    const b = this.#room.bundle;
    $('bundle').hidden = !b || b.state === 'cancelled';
    if (!b) return;
    if (b.state === 'cancelled') { this.#room.dismissBundle(); return; }
    const current = b.current?.file;
    const bytes = Math.min(b.total, b.doneBytes + (current && b.state === 'running' ? current.written : 0));
    const pct = b.total ? Math.min(100, (bytes / b.total) * 100) : 0;
    const bar = $('bundle-bar');
    bar.querySelector('span').style.setProperty('--p', `${b.state === 'done' ? 100 : pct.toFixed(1)}%`);
    bar.className = `bar ${b.state === 'done' ? 'done' : b.state === 'failed' ? 'paused' : ''}`;
    if (b.state === 'running') {
      $('bundle-title').textContent = `Downloading ${Math.min(b.index, b.count)} of ${b.count} files as one zip`;
      $('bundle-detail').textContent = `${percent(bytes, b.total)} | ${formatBytes(bytes)} of ${formatBytes(b.total)}`;
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
    let added = false;
    for (const t of room.texts) {
      if (this.#textRows.has(t.id)) continue;
      const li = tpl.content.firstElementChild.cloneNode(true);
      li.classList.toggle('mine', t.from === room.me.id);
      li.querySelector('[data-act="delete-text"]').hidden = t.from !== room.me.id;
      li.dataset.id = t.id;
      li.dataset.from = t.from;
      li.dataset.at = String(t.at);
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
      added = true;
      list.append(li);
      this.#textRows.set(t.id, li);
    }
    const ids = new Set(room.texts.map((t) => t.id));
    for (const [id, li] of this.#textRows) if (!ids.has(id)) { li.remove(); this.#textRows.delete(id); }
    $('texts-count').textContent = room.texts.length ? `(${room.texts.length})` : '';
    $('texts-empty').hidden = room.texts.length > 0;
    // A run of messages from one sender within two minutes shows the name and time once.
    let prev = null;
    for (const li of list.children) {
      li.classList.toggle('cont', !!prev && prev.dataset.from === li.dataset.from && li.dataset.at - prev.dataset.at < 120000);
      prev = li;
    }

    // Unread: messages from others that arrived while the dialog was closed.
    const open = $('messages-dialog').open;
    if (open) for (const t of room.texts) this.#seenTexts.add(t.id);
    if (open && added) $('messages-body').scrollTop = $('messages-body').scrollHeight;
    const unread = room.texts.filter((t) => t.from !== room.me.id && !this.#seenTexts.has(t.id)).length;
    $('messages-badge').hidden = !unread;
    $('messages-badge').textContent = unread > 99 ? '99+' : String(unread);
    $('messages-btn').setAttribute('aria-label', unread ? `Messages, ${unread} unread` : 'Messages');
  }
}
