// Off-main-thread block scanner for the miner league: fetch a raw block by
// hash from esplora, verify the bytes hash back to the requested block hash
// (a wrong answer convicts itself), decode, and report {pool, nonStd}.
// The raw block never crosses to the UI thread.
import { Codec } from './engine/codec/codec.js';
import { dsha256, bytesToHex, reverseHex } from './engine/codec/hash.js';
import { scanBlock } from './block-scan.js';

let codec = null;

const jl = async (n) => (await fetch(`./engine/schema/${n}.jsonld`)).json();

async function fetchRaw(hash) {
  const sources = [
    `https://mempool.space/api/block/${hash}/raw`,
    `https://blockstream.info/api/block/${hash}/raw`,
  ];
  let lastErr;
  for (const url of sources) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) { lastErr = new Error(`${url} -> ${r.status}`); continue; }
      return new Uint8Array(await r.arrayBuffer());
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('no block source');
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'init') {
      codec = new Codec(await jl('core'), await jl('proof'), await jl('p2p'));
      self.postMessage({ type: 'ready' });
      return;
    }
    if (m.type === 'scan') {
      if (!codec) throw new Error('scanner not initialised');
      const bytes = await fetchRaw(m.hash);
      if (bytes.length < 80 || reverseHex(dsha256(bytes.subarray(0, 80))) !== m.hash) throw new Error('bytes do not match requested hash');
      const block = codec.decode('Block', bytesToHex(bytes));
      // self-verify even when the hash came from an explorer, not the PoW-checked tree
      if (!codec.checkProofOfWork(block.header)) throw new Error('header fails proof-of-work');
      self.postMessage({ type: 'scanned', hash: m.hash, height: m.height, ...scanBlock(block) });
    }
  } catch (e) {
    self.postMessage({ type: 'scanerr', hash: m.hash, height: m.height, error: String(e && e.message || e) });
  }
};
