// Network: owns the signaling socket and every PeerLink, keyed by remote peer id.
//
// The room asks for a link with connect(); inbound offers become links only when the
// room's accept() hook agrees. When two peers dial each other at the same moment
// ("glare"), the peer with the lower id keeps its outgoing link and the other answers.

import { Emitter, randomId } from './util.js';
import { PeerLink } from './link.js';

export class Network extends Emitter {
  #signaling;
  #key;
  #accept;
  #links = new Map();

  constructor({ signaling, key, accept }) {
    super();
    this.#signaling = signaling;
    this.#key = key || null;
    this.#accept = accept;
    signaling.on('signal', (from, payload) => this.#onSignal(from, payload));
    signaling.on('unavailable', (id) => {
      const link = this.#links.get(id);
      if (link && link.state === 'connecting' && link.initiator) link.close('unavailable');
    });
  }

  get localId() { return this.#signaling.id; }

  link(remoteId) {
    const l = this.#links.get(remoteId);
    return l && l.state !== 'down' ? l : null;
  }

  signal(to, payload) {
    this.#signaling.send(to, payload);
  }

  connect(remoteId, { mustVerify = false } = {}) {
    const existing = this.link(remoteId);
    if (existing) return existing;
    const link = this.#create(remoteId, randomId(), true, mustVerify);
    this.#signaling.iceServers()
      .then((ice) => link.start(ice))
      .catch(() => link.close('no-ice'));
    return link;
  }

  closeAll(reason = 'leaving') {
    for (const link of this.#links.values()) link.close(reason);
    this.#links.clear();
  }

  #create(remoteId, linkId, initiator, mustVerify) {
    const link = new PeerLink({ net: this, localId: this.localId, remoteId, linkId, initiator, key: this.#key, mustVerify });
    this.#links.set(remoteId, link);
    link.on('down', () => {
      if (this.#links.get(remoteId) === link) this.#links.delete(remoteId);
    });
    return link;
  }

  async #onSignal(from, payload) {
    if (typeof payload.link !== 'string') return;
    const current = this.#links.get(from);
    if (current && current.linkId === payload.link) {
      current.handleSignal(payload);
      return;
    }
    if (payload.kind !== 'offer' || typeof payload.sdp !== 'string') return;

    if (current && current.state !== 'down') {
      // Glare: both sides dialed. Lower id wins and keeps its own outgoing link.
      if (current.initiator && current.state === 'connecting' && this.localId < from) return;
      // An open link being replaced means the remote reloaded or lost its connection.
      current.close('replaced');
    }

    let allowed = false;
    try { allowed = await this.#accept(from); } catch { allowed = false; }
    if (!allowed) {
      this.#signaling.send(from, { kind: 'close', link: payload.link });
      return;
    }
    const link = this.#create(from, payload.link, false, false);
    this.emit('link', link);
    try {
      link.start(await this.#signaling.iceServers(), payload);
    } catch {
      link.close('no-ice');
    }
  }
}
