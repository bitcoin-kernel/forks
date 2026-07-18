// HeaderTree test suite — regtest headers (real PoW at trivial difficulty).
// Run: node tests/test-header-tree.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { Codec } = await import(join(ROOT, 'engine/codec/codec.js'));
const { HeaderEngine } = await import(join(ROOT, 'engine/codec/headers.js'));
const { HeaderTree, splitHeaders } = await import(join(ROOT, 'header-tree.js'));

const jl = (n) => JSON.parse(readFileSync(join(ROOT, `engine/schema/${n}.jsonld`), 'utf8'));
const codec = new Codec(jl('core'), jl('proof'), jl('p2p'));
const eng = HeaderEngine.fromSchemas(codec, jl('chain'), jl('validate'), 'btc:regtest');
const BITS = eng.compactFromTarget(eng.powLimit);

function mineChain(prevHash, startTime, n, seed) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const h = { version: 4, prevBlockHash: prevHash, merkleRoot: (seed + i).toString(16).padStart(64, '0'), time: startTime + i * 600, bits: BITS, nonce: 0 };
    while (!codec.checkProofOfWork(h)) h.nonce++;
    out.push(h); prevHash = codec.blockHash(h);
  }
  return out;
}
const hex = (hs) => hs.map((h) => codec.encodeHex('BlockHeader', h));
const hash = (h) => codec.blockHash(h);

let passed = 0, failed = 0;
const check = (name, cond) => { if (cond) passed++; else { failed++; console.error('FAIL', name); } };
const types = (evs) => evs.map((e) => e.type);

const tree = new HeaderTree({ codec, engine: eng, depth: 50 });

// linear growth: no events beyond insertion
const main = mineChain('00'.repeat(32), 1_700_000_000, 20, 0x100); // heights 800..819
let r = tree.addBatch(hex(main), 800, 'nostr:test');
check('linear ingest quiet', r.events.length === 0 && tree.best.height === 819 && tree.size === 20);

// duplicate ingest from a second source: no growth, source recorded
r = tree.addBatch(hex(main.slice(10)), 810, 'esplora:mempool');
check('duplicate ingest merges sources', r.events.length === 0 && tree.size === 20
  && tree.node(hash(main[19])).sources.has('esplora:mempool'));

// a 1-block competing tip at the same height: fork event, no reorg (equal work loses to first-seen... lower cum)
const uncle = mineChain(hash(main[18]), 1_700_050_000, 1, 0x200);
r = tree.addBatch(hex(uncle), 819, 'peer:aa');
check('fork detected', types(r.events).includes('fork') && !types(r.events).includes('stale'));
check('two live tips during fork', tree.liveTips().length === 2);

// competing arm extends by one → heavier → reorg: old tip goes stale
const uncle2 = mineChain(hash(uncle[0]), 1_700_051_000, 1, 0x300);
r = tree.addBatch(hex(uncle2), 820, 'peer:aa');
const staleEv = r.events.find((e) => e.type === 'stale');
check('reorg → stale event depth 1', staleEv && staleEv.depth === 1 && staleEv.arm[0].hash === hash(main[19]));
check('old tip marked stale', tree.node(hash(main[19])).stale === true);
check('best moved to new arm', tree.best.height === 820 && tree.bestHash === hash(uncle2[0]));

// deep reorg: 3-block arm from height 817's parent outworks the 2-block uncle arm + main[19]... build 4 from main[16]
const deep = mineChain(hash(main[16]), 1_700_060_000, 5, 0x400); // heights 817..821
r = tree.addBatch(hex(deep), 817, 'peer:bb');
const deepEv = r.events.filter((e) => e.type === 'stale').pop();
check('deep reorg detected', deepEv && deepEv.depth === 4 && tree.best.height === 821);
check('displaced arm all stale', tree.node(hash(uncle2[0])).stale && tree.node(hash(main[17])).stale && tree.node(hash(main[18])).stale);

// invalid PoW from a source is an event, not an insertion
const bad = { ...mineChain(hash(deep[4]), 1_700_070_000, 1, 0x500)[0] };
do { bad.nonce = (bad.nonce + 1) >>> 0; } while (codec.checkProofOfWork(bad));
r = tree.add(codec.encodeHex('BlockHeader', bad), 822, 'peer:evil');
check('invalid pow reported, not stored', types(r.events).includes('invalid-pow') && tree.size === 27);

// height mismatch: correct header, lying claimed height
const next = mineChain(hash(deep[4]), 1_700_071_000, 1, 0x600);
r = tree.add(hex(next)[0], 900, 'peer:liar');
check('height mismatch flagged, parent wins', types(r.events).includes('height-mismatch') && tree.node(hash(next[0])).height === 822);

// ancestry
check('isAncestor true', tree.isAncestor(hash(main[0]), tree.bestHash));
check('isAncestor false across arms', !tree.isAncestor(hash(main[19]), tree.bestHash));

// prune: with depth 50 nothing goes; shrink depth → linear old nodes drop, stale + fork points stay
tree.depth = 2;
const dropped = tree.prune();
check('prune keeps stale + fork evidence', dropped > 0 && tree.node(hash(main[19])) && tree.node(hash(main[17]))
  && !tree.node(hash(main[3])));

// splitHeaders helper
check('splitHeaders', splitHeaders(hex(main.slice(0, 3)).join('')).length === 3);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
