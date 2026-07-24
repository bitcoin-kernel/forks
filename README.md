# fork·watch

A browser-native Bitcoin **fork and stale-block monitor** in the spirit of
[ForkMonitor](https://github.com/jonathanbier/forkmonitor) — but with no server and no trusted
nodes. Chain tips are observed from many independent witnesses, every header is re-verified
locally (proof-of-work, linkage, cumulative work), and forks, reorgs and stale blocks are
recorded **with the evidence kept**.

A sibling of [block·health](https://bitcoin-kernel.com/health/), built on the same stack:
the vendored [bitcoin-kernel](https://github.com/bitcoin-kernel) engine, NIP-333 header
streams, and the canonical WebRTC mesh library.

## How it watches

Three classes of witness feed one fork-aware header tree:

1. **Nostr publishers** — NIP-333 kind-33333 events (newest 12 headers per event), any number
   of publisher keys. The publisher is a filter, not an authority.
2. **Esplora explorers** — mempool.space and blockstream.info tips, headers fetched and
   verified per block. Explorers are dumb byte sources; a wrong answer convicts itself.
3. **Mesh peers** — block·health browsers advertise their self-verified header-chain tips over
   WebRTC; fork·watch joins the same rooms as a silent witness (`?peer=wss://…&room=…`, same
   link format as health). Every browser in the room is an independent observer with its own
   network position.

## What it records

- **Stale blocks / reorgs** — when the best tip moves to a non-descendant, the displaced arm is
  marked stale and kept forever. The stale arm *is* the observation.
- **Chain splits** — two children under one parent, while both arms are live.
- **Witness divergence** — a source whose tip is not on the locally-verified best chain.
- **Invalid headers** — a witness offering a header that fails its own proof-of-work.
- **Height lies** — a witness claiming a height the parent linkage contradicts.
- **Slow blocks** — an hour without a block, for context.

Events persist in `localStorage` and survive reloads. The header tree prunes deep linear
history but **never** prunes stale blocks or fork points.

## What it deliberately does not do (yet)

ForkMonitor's multi-implementation invalid-*block* detection and per-block inflation checks
need real full nodes with UTXO sets — out of reach of header-level monitoring. The roadmap
(shared with block·health) closes some of the gap: full-block archival of stale blocks at the
moment they die, snapshot-based validation, and publishing signed fork-event notes back to
nostr so browsers become a decentralized alert network.

## Layout

```
index.html       the app: witnesses, detection, timeline UI
header-tree.js   fork-aware header DAG: PoW-checked inserts, work-weighed best tip,
                 stale marking, evidence-preserving pruning
peer-source.js   block·health mesh peer (same wire protocol), vendored from health
                 plus an any-peer fetch extension: tips + headers as witnesses, and
                 scanned blocks pulled from peers' caches before falling back to esplora
webrtc-mesh.js   vendored verbatim from bitcoin-kernel/health (the canonical copy):
                 mesh-hello instance dedupe, peer/attempt caps, keep-oldest connections
engine/          vendored bitcoin-kernel codec + JSON-LD consensus schemas
tests/           node test suite (regtest chains, real PoW)
```

## Run locally

```
python3 -m http.server 8900    # then open http://localhost:8900/
node tests/test-header-tree.mjs
```

No build step, no backend — static files on GitHub Pages.

## License

AGPL-3.0-or-later. Copyright © 2026 Melvin Carvalho. See [LICENSE](LICENSE).

Includes vendored code from [bitcoin-kernel](https://github.com/bitcoin-kernel/kernel), also AGPL-3.0.
