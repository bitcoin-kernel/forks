// A silent witness on the block·health mesh. Speaks the same wire protocol as
// health's PeerSource — reads `have` adverts (for the header tip they carry)
// and pulls recent headers with `getheaders` — but advertises nothing and
// serves nothing: it only listens. Every peer in the room becomes an
// independent chain-tip witness for the fork monitor; their headers are
// self-certifying, so nothing they say is trusted, only verified.
import { MeshCore } from './webrtc-mesh.js';

const HDR_BATCH = 500;

export class PeerWitness {
  constructor({ signalUrl, room = 'b17c0100b10c48ea1710', iceServers, onTip = () => {}, onStatus = () => {} }) {
    this.onTip = onTip;       // (peerId, {height, hash, start})
    this.onStatus = onStatus;
    this.state = new Map();   // peerId -> { tip, hdrReq }
    this.closed = false;
    this.core = new MeshCore({
      url: signalUrl, room, iceServers, channelLabel: 'blocks', // health's channel label — same rooms
      onPeer: (id) => { this.state.set(id, { tip: null, hdrReq: null }); this._emit(); },
      onDrop: (id) => {
        const st = this.state.get(id);
        this.state.delete(id);
        if (st?.hdrReq) { const r = st.hdrReq; st.hdrReq = null; r.resolve(null); }
        this._emit();
      },
      onData: (id, data) => this._onData(id, data),
      onChange: () => this._emit(),
    });
  }

  start() { if (this.core.url) this.core.start(); }
  close() { this.closed = true; this.core.stop(); this.state.clear(); }
  status() { const c = this.core.status(); return { connected: c.connected, ws: c.ws, peers: c.peers }; }
  _emit() { try { this.onStatus(this.status()); } catch {} }

  _onData(id, data) {
    const st = this.state.get(id);
    if (!st || typeof data !== 'string') return; // binary block transfers are not for us
    let m; try { m = JSON.parse(data); } catch { return; }
    if (m.t === 'have' && m.tip && Number.isInteger(m.tip.height) && typeof m.tip.hash === 'string') {
      st.tip = m.tip;
      try { this.onTip(id, m.tip); } catch {}
    } else if (m.t === 'headers') {
      const r = st.hdrReq;
      if (!r) return;
      st.hdrReq = null;
      const ok = Number.isInteger(m.start) && typeof m.hex === 'string' && m.hex.length > 0
        && m.hex.length % 160 === 0 && m.hex.length <= HDR_BATCH * 160 && /^[0-9a-f]+$/.test(m.hex);
      r.resolve(ok ? { start: m.start, count: m.hex.length / 160, hex: m.hex } : null);
    } else if (m.t === 'getblock') {
      this._send(id, { t: 'noblock', id: m.id, hash: m.hash }); // we hold nothing
    }
  }

  _send(id, obj) { this.core.send(id, JSON.stringify(obj)); }

  // Ask a specific peer for headers (their recent chain around a tip we
  // haven't verified yet). Resolves {start, count, hex} or null.
  requestHeaders(id, from, count = 24, timeoutMs = 10000) {
    const st = this.state.get(id);
    if (!st || st.hdrReq || this.core.channel(id)?.readyState !== 'open') return Promise.resolve(null);
    return new Promise((resolve) => {
      const done = (v) => { clearTimeout(timer); resolve(v); };
      const timer = setTimeout(() => { st.hdrReq = null; done(null); }, timeoutMs);
      st.hdrReq = { resolve: done };
      this._send(id, { t: 'getheaders', from, count: Math.min(count, HDR_BATCH) });
    });
  }
}
