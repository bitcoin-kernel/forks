// Per-block scan for the miner league: who mined it (coinbase tag), and how
// many of its OP_RETURN outputs exceed the historical 80-byte-data /
// 83-byte-script datacarrier standard. Pure functions over a decoded block —
// no fetching, no storage — so the whole file is testable in node.
//
// The pool-marker list and tag heuristics follow the same approach as
// block·health (and mempool.space): attribution is the pool's own coinbase
// stamp, derived entirely from the block itself, no attribution service.

// Printable ASCII of the coinbase scriptSig; everything else becomes a space.
export function coinbaseTag(scriptSigHex) {
  let s = '';
  for (let i = 0; i < scriptSigHex.length; i += 2) {
    const b = parseInt(scriptSigHex.slice(i, i + 2), 16);
    s += (b >= 0x20 && b <= 0x7e) ? String.fromCharCode(b) : ' ';
  }
  return s.replace(/\s+/g, ' ').trim();
}

// Ordered — first substring hit wins.
const POOLS = [
  ['Foundry USA', 'Foundry USA'], ['AntPool', 'AntPool'], ['SpiderPool', 'SpiderPool'],
  ['ViaBTC', 'ViaBTC'], ['F2Pool', 'F2Pool'], ['f2pool', 'F2Pool'],
  ['Binance', 'Binance Pool'], ['SlushPool', 'Braiins Pool'], ['Braiins', 'Braiins Pool'],
  ['slush', 'Braiins Pool'], ['MARA', 'MARA Pool'], ['Luxor', 'Luxor'],
  ['SBICrypto', 'SBI Crypto'], ['SBI Crypto', 'SBI Crypto'], ['SecPool', 'SECPOOL'],
  ['SECPOOL', 'SECPOOL'], ['Poolin', 'Poolin'], ['poolin', 'Poolin'],
  ['OCEAN', 'OCEAN'], ['Ultimus', 'ULTIMUSPOOL'], ['ULTIMUS', 'ULTIMUSPOOL'],
  ['WhitePool', 'WhitePool'], ['Carbon', 'Carbon Negative'], ['BTC.com', 'BTC.com'],
  ['btccom', 'BTC.com'], ['EMCD', 'EMCD'], ['emcd', 'EMCD'], ['Rawpool', 'Rawpool'],
  ['NovaBlock', 'NovaBlock'], ['bitFuFu', 'Mining Squared'], ['Mining Squared', 'Mining Squared'],
  ['/solo', 'Solo CKPool'], ['ckpool', 'CKPool'], ['PEGA', 'Pega Pool'],
  ['public-pool', 'Public Pool'], ['1THash', '1THash'], ['Bitdeer', 'Bitdeer'],
  ['SigmaPool', 'SigmaPool'], ['Terra Pool', 'Terra Pool'],
];
export function identifyPool(tag) {
  for (const [needle, name] of POOLS) if (tag.includes(needle)) return name;
  return null;
}

const isWitnessCommitment = (spk) => spk.startsWith('6a24aa21a9ed');

// Payload bytes pushed after OP_RETURN (null if not a clean OP_RETURN).
// Truncated pushes count only the bytes actually present.
export function opReturnDataBytes(spkHex) {
  const b = [];
  for (let i = 0; i < spkHex.length; i += 2) b.push(parseInt(spkHex.slice(i, i + 2), 16));
  if (b[0] !== 0x6a) return null;
  let i = 1, data = 0;
  while (i < b.length) {
    const op = b[i++];
    let len;
    if (op >= 0x01 && op <= 0x4b) len = op;
    else if (op === 0x4c) { if (i + 1 > b.length) break; len = b[i]; i += 1; }
    else if (op === 0x4d) { if (i + 2 > b.length) break; len = b[i] | (b[i + 1] << 8); i += 2; }
    else if (op === 0x4e) { if (i + 4 > b.length) break; len = b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24); i += 4; }
    else continue; // OP_N / other opcodes carry no push payload
    data += Math.min(len, b.length - i); i += len;
  }
  return data;
}

// -> { pool, tag, outputs, nonStd } for a decoded block
export function scanBlock(block) {
  const tag = coinbaseTag(block.transactions[0].inputs[0].scriptSig);
  let outputs = 0, nonStd = 0;
  for (const tx of block.transactions) {
    for (const o of tx.outputs) {
      const spk = o.scriptPubKey;
      if (!spk.startsWith('6a') || isWitnessCommitment(spk)) continue;
      outputs++;
      const dataBytes = opReturnDataBytes(spk);
      if ((dataBytes != null && dataBytes > 80) || spk.length / 2 > 83) nonStd++;
    }
  }
  return { pool: identifyPool(tag), tag, outputs, nonStd };
}
