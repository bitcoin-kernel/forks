// Fork-aware header tree — the data structure a fork monitor needs where a
// node needs only a chain. Every header observed from any source (nostr
// publisher, esplora, mesh peer) is PoW-checked and inserted into a DAG keyed
// by block hash, linked by prevBlockHash. Nothing is ever overwritten: when
// the best tip moves to a block that is NOT a descendant of the previous best,
// the displaced arm is marked stale and kept — that arm IS the observation.
//
// Heights: derived from the parent when the parent is in the tree (a claimed
// height that disagrees is itself reported); otherwise the claimant's height
// anchors a new root. Work is cumulative per connected component, so tips of
// the same component compare by total PoW exactly as consensus does.
//
// Persistence: localStorage JSON. Linear history older than `depth` below the
// best tip is pruned — but stale blocks and fork points are kept forever;
// they are rare and they are the product.

const hasLS = typeof localStorage !== 'undefined';

export class HeaderTree {
  constructor({ codec, engine, storageKey = 'forkwatch.tree', depth = 5000 }) {
    this.codec = codec;
    this.engine = engine;   // HeaderEngine — used for work()
    this.storageKey = storageKey;
    this.depth = depth;
    this.nodes = new Map(); // hash -> {hex, height, prev, sources:Set, firstSeen, stale}
    this.children = new Map(); // hash -> Set of child hashes
    this.cum = new Map();   // hash -> cumulative BigInt work within its component
    this.bestHash = null;
    this.load();
  }

  node(hash) { return this.nodes.get(hash) || null; }
  get best() { return this.bestHash ? this.nodes.get(this.bestHash) : null; }
  get size() { return this.nodes.size; }

  tips() {
    const out = [];
    for (const [hash, n] of this.nodes) if (!(this.children.get(hash)?.size)) out.push({ hash, ...n });
    return out;
  }

  // Number of live (non-stale) tips at or near the best height — >1 means an
  // unresolved fork is being mined right now.
  liveTips() {
    const bh = this.best?.height ?? 0;
    return this.tips().filter((t) => !t.stale && t.height >= bh - 1);
  }

  // Is `a` an ancestor of (or equal to) `b`? Walks parent links.
  isAncestor(aHash, bHash) {
    const a = this.nodes.get(aHash);
    let cur = this.nodes.get(bHash), curHash = bHash;
    if (!a || !cur) return false;
    while (cur && cur.height >= a.height) {
      if (curHash === aHash) return true;
      curHash = cur.prev; cur = this.nodes.get(curHash);
    }
    return false;
  }

  // Insert one header (160-char hex). Returns { events: [...] } — everything
  // noteworthy that this observation revealed. Types:
  //   invalid-pow      source offered a header failing its own target
  //   height-mismatch  source's claimed height disagrees with the parent link
  //   fork             a second child appeared under one parent (split!)
  //   stale            the best tip moved to a non-descendant; old arm marked
  add(hex, claimedHeight, source) {
    const events = [];
    if (typeof hex !== 'string' || hex.length !== 160 || !/^[0-9a-f]+$/.test(hex)) return { events };
    let header;
    try { header = this.codec.decode('BlockHeader', hex); } catch { return { events }; }
    const hash = this.codec.blockHash(header);
    if (!this.codec.checkProofOfWork(header)) {
      events.push({ type: 'invalid-pow', hash, source, height: claimedHeight ?? null });
      return { events };
    }
    const existing = this.nodes.get(hash);
    if (existing) { existing.sources.add(source); return { events, hash }; }

    const parent = this.nodes.get(header.prevBlockHash);
    let height = parent ? parent.height + 1 : (Number.isInteger(claimedHeight) ? claimedHeight : null);
    if (height == null) return { events }; // unanchorable root — ignore
    if (parent && Number.isInteger(claimedHeight) && claimedHeight !== height) {
      events.push({ type: 'height-mismatch', hash, source, claimed: claimedHeight, actual: height });
    }
    const n = { hex, height, prev: header.prevBlockHash, sources: new Set([source]), firstSeen: Date.now(), stale: false, time: header.time };
    this.nodes.set(hash, n);
    if (!this.children.has(header.prevBlockHash)) this.children.set(header.prevBlockHash, new Set());
    const sibs = this.children.get(header.prevBlockHash);
    sibs.add(hash);
    if (parent && sibs.size === 2) {
      events.push({ type: 'fork', parent: header.prevBlockHash, height, arms: [...sibs], source });
    }
    this.cum.set(hash, (parent ? this.cum.get(header.prevBlockHash) ?? 0n : 0n) + this.engine.work(header));

    events.push(...this.#updateBest(hash));
    return { events, hash };
  }

  // Batch of consecutive headers (e.g. a nostr window) — heights follow start.
  addBatch(hexes, startHeight, source) {
    const events = [];
    hexes.forEach((hx, i) => events.push(...this.add(hx, startHeight == null ? null : startHeight + i, source).events));
    return { events };
  }

  #updateBest(newHash) {
    const events = [];
    const prevBest = this.bestHash;
    const w = (h) => this.cum.get(h) ?? 0n;
    if (!prevBest || w(newHash) > w(prevBest)
      || (w(newHash) === w(prevBest) && (this.nodes.get(newHash)?.height ?? 0) > (this.nodes.get(prevBest)?.height ?? 0))) {
      this.bestHash = newHash;
      if (prevBest && prevBest !== newHash && !this.isAncestor(prevBest, newHash)) {
        // reorg: everything from the common ancestor up the old arm is stale
        const staleArm = [];
        let cur = prevBest;
        while (cur && !this.isAncestor(cur, newHash)) {
          const cn = this.nodes.get(cur);
          if (!cn) break;
          cn.stale = true;
          staleArm.push({ hash: cur, height: cn.height });
          cur = cn.prev;
        }
        if (staleArm.length) {
          events.push({ type: 'stale', depth: staleArm.length, arm: staleArm.reverse(), newTip: newHash, newHeight: this.nodes.get(newHash).height });
        }
      }
    }
    return events;
  }

  // Drop old linear history; keep anything stale, any fork point's arms, and
  // everything within `depth` of the best tip.
  prune() {
    const bh = this.best?.height;
    if (bh == null) return 0;
    const cutoff = bh - this.depth;
    let dropped = 0;
    for (const [hash, n] of this.nodes) {
      if (n.height >= cutoff || n.stale) continue;
      if ((this.children.get(n.prev)?.size ?? 0) > 1) continue; // fork-point child
      if ((this.children.get(hash)?.size ?? 0) > 1) continue;   // fork point itself
      this.nodes.delete(hash); this.cum.delete(hash);
      this.children.get(n.prev)?.delete(hash);
      this.children.delete(hash);
      dropped++;
    }
    return dropped;
  }

  save() {
    if (!hasLS) return;
    try {
      const out = {};
      for (const [hash, n] of this.nodes) {
        out[hash] = [n.hex, n.height, n.stale ? 1 : 0, [...n.sources].slice(0, 8), n.firstSeen];
      }
      localStorage.setItem(this.storageKey, JSON.stringify({ best: this.bestHash, nodes: out }));
    } catch { /* quota — monitoring continues in memory */ }
  }

  load() {
    if (!hasLS) return;
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(this.storageKey) || 'null'); } catch {}
    if (!raw || !raw.nodes) return;
    // two passes: insert nodes, then rebuild child links + cumulative work by height order
    const entries = Object.entries(raw.nodes)
      .map(([hash, [hex, height, stale, sources, firstSeen]]) => ({ hash, hex, height, stale: !!stale, sources, firstSeen }))
      .sort((a, b) => a.height - b.height);
    for (const e of entries) {
      let header;
      try { header = this.codec.decode('BlockHeader', e.hex); } catch { continue; }
      const n = { hex: e.hex, height: e.height, prev: header.prevBlockHash, sources: new Set(e.sources || []), firstSeen: e.firstSeen || Date.now(), stale: e.stale, time: header.time };
      this.nodes.set(e.hash, n);
      if (!this.children.has(n.prev)) this.children.set(n.prev, new Set());
      this.children.get(n.prev).add(e.hash);
      const pw = this.cum.get(n.prev) ?? 0n;
      this.cum.set(e.hash, pw + this.engine.work(header));
    }
    this.bestHash = raw.best && this.nodes.has(raw.best) ? raw.best : null;
    if (!this.bestHash) for (const [hash] of this.nodes) if (!this.bestHash || (this.cum.get(hash) > this.cum.get(this.bestHash))) this.bestHash = hash;
  }
}

// tiny helper shared by app code: split a concatenated hex header string
export const splitHeaders = (hex) => {
  const out = [];
  if (typeof hex === 'string') for (let i = 0; i + 160 <= hex.length; i += 160) out.push(hex.slice(i, i + 160));
  return out;
};
