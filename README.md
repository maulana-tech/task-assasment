# Sepolia Transaction Trace System

Given a transaction hash or an address, return the chain of related ETH and ERC-20 transfers upstream and downstream, the addresses and contracts involved, and the number of hops between two addresses.

- Network: **Ethereum Sepolia, chain ID 11155111** (the CLI refuses any other chain).
- Stack: Node 24 + TypeScript, `viem` for RPC, SQLite via Node's built-in `node:sqlite`, plain `node:http` for the API, `node:test` for tests. One runtime dependency.
- Architecture: [`docs/system-design.md`](docs/system-design.md).

## Running it

### 0. Prerequisites

| Need | Version | Check |
|---|---|---|
| Node.js | ≥ 22.5 (developed on 24.15) | `node -v` |
| npm | any recent | `npm -v` |
| Internet access to a Sepolia JSON-RPC endpoint | – | see step 2 |

No Docker, no Postgres, no native build step. SQLite comes from Node's built-in `node:sqlite`.

### 1. Install

```bash
git clone <this repo> sepolia-trace
cd sepolia-trace
npm install
```

### 2. Configure the RPC endpoint

```bash
cp .env.example .env
```

`.env` holds one required variable:

```ini
SEPOLIA_RPC_URL=https://sepolia.gateway.tenderly.co   # any Sepolia JSON-RPC URL
DB_PATH=data/trace.db                                  # optional
PORT=3000                                              # optional
CONFIRMATIONS=6                                        # optional, follow mode lag
```

The default is Tenderly's public Sepolia gateway, which accepts topic-only `eth_getLogs` and needs no key. An Alchemy / Infura / QuickNode Sepolia URL works too and is faster. The CLI checks `eth_chainId` and refuses anything that is not 11155111.

Known-bad public endpoints (found while building this): `ethereum-sepolia-rpc.publicnode.com` refuses `getLogs` without an address filter, `1rpc.io/sepolia` caps `getLogs` at 50 blocks and drops requests, `drpc.org` paywalls Sepolia.

### 3. Run the tests (no network needed)

```bash
npm test
```

Expected: `pass 22, fail 0` in about a second. They use an in-memory database and a fake chain.

### 4. Ingest the block window

```bash
npm run ingest -- --from 11672000 --to 11673999
```

What you will see:

```
2026-09-10T09:15:41Z ingested 11672000..11672199 (24188 transfers so far)
...
2026-09-10T09:19:08Z done: {"blocks":2000,"transfers":280051,"reorgs":0,"addresses":51725,"seconds":228}
```

- Takes about 4 minutes on the public gateway (2,000 blocks, ~280k transfers). Alchemy/Infura: about half that.
- Lines like `getLogs span too large (...), halving to 100` are normal: the ingester probes the provider's `getLogs` limit once and settles.
- Safe to interrupt with Ctrl-C and re-run the same command: it resumes from the last committed block.
- Safe to run twice: rows converge to the same set (delete-then-insert per block).
- In a hurry? A 50-block slice is enough to hit the API, though the README seeds need the full window:
  `npm run ingest -- --from 11672000 --to 11672049`

### 5. Start the API

```bash
npm run dev
# trace api on http://localhost:3000  db=data/trace.db window=[11672000,11673999]
```

Then, in another terminal:

```bash
curl localhost:3000/health

# trace a transaction 3 hops downstream
curl "localhost:3000/trace/tx/0x4c97c1e24c03bd19fcbb9c4eb2fcadf476caf5730e8621cd18183a0b333550d9?depth=3&direction=down"

# trace an address, both directions (default), within a sub-window
curl "localhost:3000/trace/address/0x08ead670c7b652707010e400768a7303a7b3d8de?depth=2&fromBlock=11672000&toBlock=11672500"

# hops between two addresses
curl "localhost:3000/hops?from=0x1f759ef4c554c9b6cd72cdbf220e57fa8d63aee1&to=0xf3d27499da2e5c8f5b5eb4c4fa23775e5978844e"
```

Full route and parameter reference: [API](#api). Seed queries with expected results: [Seed transactions and addresses](#seed-transactions-and-addresses).

### 6. Verify your ingest matches ours

```bash
npm run verify
```

Re-runs the seven README seed queries against your local database and diffs nodes, edges, hops and paths against `docs/expected/*.json`. Expected output ends with `all seeds match`. Exit code 1 on any mismatch.

### 7. Optional: follow the chain head

```bash
npm run ingest -- --follow                  # continues from the ingested window
DB_PATH=data/live.db npm run ingest -- --follow --from 11680000   # or a fresh DB from a given block
```

Polls every 6 s, stays `CONFIRMATIONS` blocks behind the head, re-verifies the last 12 stored block hashes each poll and rolls back on a reorg. Ctrl-C to stop. Note that this extends the ingested window past 11673999, so `npm run verify` results may gain edges; use a separate `DB_PATH` if you want to keep the graded window intact.

### 8. Optional: find your own seeds

```bash
npm run find-seeds -- --minHops 3 --maxEdges 25
```

Scans the database for transactions and addresses whose downstream trace reaches at least `minHops` with a small, readable edge count.

### All commands

| Command | What it does |
|---|---|
| `npm test` | 22 unit tests, no network |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run ingest -- --from A --to B [--chunk N]` | ingest a block range, resumable, idempotent |
| `npm run ingest -- --follow [--from A]` | follow the head |
| `npm run dev` / `npm start` | HTTP API on `$PORT` (3000) |
| `npm run verify` | diff seed traces against `docs/expected/` |
| `npm run find-seeds [-- --minHops 3 --maxEdges 25]` | list seed candidates |

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Missing required env var SEPOLIA_RPC_URL` | `.env` not created, or the variable is empty. `cp .env.example .env`. |
| `RPC is chain N, expected Sepolia (11155111)` | The URL points at mainnet or another testnet. |
| Ingest aborts with an RPC error after several retries | Provider rate limit or outage. Re-run the same command, it resumes. Or switch `SEPOLIA_RPC_URL`. |
| `404 tx ... has no value transfers in ingested window` | Either the tx is outside the ingested blocks, or it moved no ETH and emitted no ERC-20 `Transfer`. `GET /health` shows the window. |
| Empty `nodes`/`edges` for an address | The address was not active inside the window. The response's `window` field tells you what was searched. |
| `npm run verify` reports mismatches | Your DB does not cover exactly 11672000–11673999, or follow mode extended it. Re-ingest into a fresh `DB_PATH`. |

## Block window

| | |
|---|---|
| Start block | **11672000** |
| End block | **11673999** |
| Blocks | 2,000 consecutive |
| Mined | 2026-09-10 02:24 to 09:16 UTC |
| Contents | native ETH transfers (`value > 0`) and ERC-20 `Transfer` events (3-topic form) |

Ingest of this window from Tenderly's public gateway took 228 s and produced:

| blocks | transfers | of which ETH | of which ERC-20 | distinct txs | distinct addresses |
|---|---|---|---|---|---|
| 2,000 | 280,051 | 65,518 | 214,533 | 123,074 | 51,725 |

The last 100 blocks were re-ingested once they were 20+ blocks deep (idempotent, converged to identical rows, no reorg observed).

## Seed transactions and addresses

Each seed below produces a trace of at least three hops inside the window. Expected outputs were captured from the live testnet with the commands shown; re-run them to verify.

### tx1: `0x4c97c1e24c03bd19fcbb9c4eb2fcadf476caf5730e8621cd18183a0b333550d9`

ETH hop chain: EOA → EOA → EOA → contract → token contract (mixed ETH then ERC-20).

```bash
curl "localhost:3000/trace/tx/0x4c97c1e24c03bd19fcbb9c4eb2fcadf476caf5730e8621cd18183a0b333550d9?depth=3&direction=down"
```

Expected: **3 hops**, 5 nodes, 5 edges, `truncated: false`. Full JSON: [`docs/expected/tx1.json`](docs/expected/tx1.json).

| hop | block | from | to | asset | amount |
|---|---|---|---|---|---|
| 0 | 11672097 | `0x1f759ef4…` | `0xb5caaba7…` | ETH | 122215791402540 |
| 1 | 11672229 | `0xb5caaba7…` | `0xb5f5fd2b…` | ETH | 9977211319981000 |
| 1 | 11672452 | `0xb5caaba7…` | `0xb5f5fd2b…` | ETH | 75134809342000 |
| 2 | 11672231 | `0xb5f5fd2b…` | `0x467c1a8b…` | ETH | 1000000000000000 |
| 3 | 11672439 | `0x467c1a8b…` | `0xf3d27499…` | 0xf9d81dc4… | 3000000000000000000 |

### tx2: `0x8ccef51b8e71a1654ec70f0bbf611b9cca05c24b10775d77bfeb9a1c672ee8c4`

ETH in, ERC-20 out: hop 1 is a token transfer, fan-out of 2 at hop 1 and hop 2.

```bash
curl "localhost:3000/trace/tx/0x8ccef51b8e71a1654ec70f0bbf611b9cca05c24b10775d77bfeb9a1c672ee8c4?depth=3&direction=down"
```

Expected: **3 hops**, 7 nodes, 11 edges, `truncated: false`. Full JSON: [`docs/expected/tx2.json`](docs/expected/tx2.json).

| hop | block | from | to | asset | amount |
|---|---|---|---|---|---|
| 0 | 11672000 | `0x08ead670…` | `0x491f9fdd…` | ETH | 100000000000000000 |
| 1 | 11672003 | `0x491f9fdd…` | `0xba0f8cb0…` | 0x1c7d4b19… | 311 |
| 1 | 11672077 | `0x491f9fdd…` | `0xcecca65f…` | 0x1c7d4b19… | 1100000 |
| 2 | 11672392 | `0xcecca65f…` | `0xc0b541d5…` | 0x1c7d4b19… | 1200000 |
| 2 | 11672410 | `0xcecca65f…` | `0xb1a3aeec…` | 0x1c7d4b19… | 1000000 |
| 2 | 11673292 | `0xcecca65f…` | `0xb1a3aeec…` | 0x1c7d4b19… | 1900000 |
| 2 | 11673724 | `0xcecca65f…` | `0xc0b541d5…` | 0x1c7d4b19… | 2100000 |
| 3 | 11673511 | `0xb1a3aeec…` | `0xa396a53d…` | 0x1c7d4b19… | 2000000 |
| 3 | 11673581 | `0xb1a3aeec…` | `0xa396a53d…` | 0x1c7d4b19… | 1900000 |
| 3 | 11673586 | `0xb1a3aeec…` | `0xa396a53d…` | 0x1c7d4b19… | 800000 |
| 3 | 11673589 | `0xb1a3aeec…` | `0xa396a53d…` | 0x1c7d4b19… | 1200000 |

### tx3: `0x684e9a9c970c7fb86713f7abab4977145a119c1937ca04b1a2316be6746c1e21`

swap-shaped tx with 3 transfers inside the seed, hop 2 happens inside the *same* tx as hop 1 (router forwarding), ordered by logIndex.

```bash
curl "localhost:3000/trace/tx/0x684e9a9c970c7fb86713f7abab4977145a119c1937ca04b1a2316be6746c1e21?depth=3&direction=down"
```

Expected: **3 hops**, 7 nodes, 16 edges, `truncated: false`. Full JSON: [`docs/expected/tx3.json`](docs/expected/tx3.json).

| hop | block | from | to | asset | amount |
|---|---|---|---|---|---|
| 0 | 11672103 | `0xc932aaca…` | `0x3f1f176e…` | ETH | 528232502394008 |
| 0 | 11672103 | `0x3f1f176e…` | `0x8dcf17f2…` | 0x097d90c9… | 528232502394008 |
| 0 | 11672103 | `0x8dcf17f2…` | `0x66f9e073…` | 0x097d90c9… | 325066155319408 |
| 1 | 11672104 | `0x3f1f176e…` | `0x8dcf17f2…` | 0x097d90c9… | 215356327899077 |
| 1 | 11672104 | `0x8dcf17f2…` | `0x66f9e073…` | 0x097d90c9… | 12189980824477 |
| 1 | 11672414 | `0x8dcf17f2…` | `0x581c075d…` | 0x097d90c9… | 0 |
| 1 | 11672414 | `0x8dcf17f2…` | `0x66f9e073…` | 0x097d90c9… | 4040728814611 |
| 1 | 11673625 | `0x8dcf17f2…` | `0x66f9e073…` | 0x097d90c9… | 4046549973939 |
| 1 | 11673632 | `0x8dcf17f2…` | `0x66f9e073…` | 0x097d90c9… | 4046549973939 |
| 1 | 11673806 | `0x8dcf17f2…` | `0x66f9e073…` | 0x097d90c9… | 327557643798616 |
| 1 | 11673810 | `0x8dcf17f2…` | `0x66f9e073…` | 0x097d90c9… | 4043921528377 |
| 1 | 11673813 | `0x8dcf17f2…` | `0x66f9e073…` | 0x097d90c9… | 12131764585133 |
| 1 | 11673911 | `0x8dcf17f2…` | `0x66f9e073…` | 0x097d90c9… | 4043921528377 |
| 1 | 11673914 | `0x8dcf17f2…` | `0x66f9e073…` | 0x097d90c9… | 16175686113511 |
| 2 | 11672414 | `0x581c075d…` | `0xb74e717d…` | 0x797291a9… | 2000000000000000000 |
| 3 | 11672613 | `0xb74e717d…` | `0x896319dc…` | 0x797291a9… | 1000000000000000000 |

### addr1: `0x08ead670c7b652707010e400768a7303a7b3d8de`

address trace, ETH + ERC-20 out, reaches 3 hops through a contract.

```bash
curl "localhost:3000/trace/address/0x08ead670c7b652707010e400768a7303a7b3d8de?depth=3&direction=down"
```

Expected: **3 hops**, 6 nodes, 8 edges, `truncated: false`. Full JSON: [`docs/expected/addr1.json`](docs/expected/addr1.json).

| hop | block | from | to | asset | amount |
|---|---|---|---|---|---|
| 1 | 11672000 | `0x08ead670…` | `0x491f9fdd…` | ETH | 100000000000000000 |
| 1 | 11672000 | `0x08ead670…` | `0x491f9fdd…` | 0x1c7d4b19… | 20000000 |
| 2 | 11672003 | `0x491f9fdd…` | `0xba0f8cb0…` | 0x1c7d4b19… | 311 |
| 2 | 11672077 | `0x491f9fdd…` | `0xcecca65f…` | 0x1c7d4b19… | 1100000 |
| 3 | 11672392 | `0xcecca65f…` | `0xc0b541d5…` | 0x1c7d4b19… | 1200000 |
| 3 | 11672410 | `0xcecca65f…` | `0xb1a3aeec…` | 0x1c7d4b19… | 1000000 |
| 3 | 11673292 | `0xcecca65f…` | `0xb1a3aeec…` | 0x1c7d4b19… | 1900000 |
| 3 | 11673724 | `0xcecca65f…` | `0xc0b541d5…` | 0x1c7d4b19… | 2100000 |

### addr2: `0x1f759ef4c554c9b6cd72cdbf220e57fa8d63aee1`

address trace, 5 ETH payments to one recipient collapse into one node, 3 hops.

```bash
curl "localhost:3000/trace/address/0x1f759ef4c554c9b6cd72cdbf220e57fa8d63aee1?depth=3&direction=down"
```

Expected: **3 hops**, 4 nodes, 8 edges, `truncated: false`. Full JSON: [`docs/expected/addr2.json`](docs/expected/addr2.json).

| hop | block | from | to | asset | amount |
|---|---|---|---|---|---|
| 1 | 11672097 | `0x1f759ef4…` | `0xb5caaba7…` | ETH | 122215791402540 |
| 1 | 11672227 | `0x1f759ef4…` | `0xb5caaba7…` | ETH | 95698490036881 |
| 1 | 11672246 | `0x1f759ef4…` | `0xb5caaba7…` | ETH | 82269601107172 |
| 1 | 11672437 | `0x1f759ef4…` | `0xb5caaba7…` | ETH | 82269601107172 |
| 1 | 11672439 | `0x1f759ef4…` | `0xb5caaba7…` | ETH | 107835577870086 |
| 2 | 11672229 | `0xb5caaba7…` | `0xb5f5fd2b…` | ETH | 9977211319981000 |
| 2 | 11672452 | `0xb5caaba7…` | `0xb5f5fd2b…` | ETH | 75134809342000 |
| 3 | 11672231 | `0xb5f5fd2b…` | `0x467c1a8b…` | ETH | 1000000000000000 |

### Hops between two addresses

```bash
curl "localhost:3000/hops?from=0x1f759ef4c554c9b6cd72cdbf220e57fa8d63aee1&to=0xf3d27499da2e5c8f5b5eb4c4fa23775e5978844e"
curl "localhost:3000/hops?from=0x08ead670c7b652707010e400768a7303a7b3d8de&to=0xa396a53d1f6071defabeaa077693c58551a706fb"
```

| from | to | expected hops | path |
|---|---|---|---|
| `0x1f759ef4…` | `0xf3d27499…` | **4** | `0x1f759e` → `0xb5caab` → `0xb5f5fd` → `0x467c1a` → `0xf3d274` |
| `0x08ead670…` | `0xa396a53d…` | **4** | `0x08ead6` → `0x491f9f` → `0xcecca6` → `0xb1a3ae` → `0xa396a5` |

Full JSON: [`docs/expected/hops1.json`](docs/expected/hops1.json), [`docs/expected/hops2.json`](docs/expected/hops2.json).

Run all of the above against your own ingest and diff them with one command:

```bash
npm run verify      # re-runs every seed query and compares nodes/edges/hops with docs/expected/*.json
```


## API

All responses are JSON. Addresses are lowercased. Amounts are decimal strings (uint256).

| Route | Query params | Description |
|---|---|---|
| `GET /health` | – | ingested window, cursor, chain head, lag, row counts |
| `GET /trace/tx/:hash` | `depth` (3), `direction` down\|up\|both (both), `maxNodes` (500), `maxEdgesPerNode` (200), `fromBlock`, `toBlock` | trace a transaction |
| `GET /trace/address/:addr` | same as above | trace an address over the window |
| `GET /hops?from=&to=` | `maxDepth` (6), `undirected` (false), `fromBlock`, `toBlock`, `maxNodes`, `maxEdgesPerNode` | shortest path in hops between two addresses |

Trace response shape:

```jsonc
{
  "seed": { "type": "tx", "value": "0x…" },
  "window": [11672000, 11673999],
  "nodes": [ { "address": "0x…", "hop": 0, "isContract": false }, … ],
  "edges": [ { "txHash": "0x…", "blockNumber": 11672010, "txIndex": 3, "logIndex": -1,
               "from": "0x…", "to": "0x…", "asset": "ETH", "amount": "1000000000000000",
               "hop": 1, "direction": "down" }, … ],
  "truncated": false,
  "truncatedAt": []
}
```

- `logIndex: -1` marks the native ETH transfer of a tx; ERC-20 edges carry the real log index and `asset` = token contract.
- `isContract` is resolved lazily with `eth_getCode` and cached; `null` means not yet classified.
- `truncated: true` means a fan-out or node cap was hit and `truncatedAt` lists the addresses where expansion stopped. The system returns partial traces, never partial traces disguised as complete ones.
- A tx that exists on chain but has no value transfers in the ingested window → `404` with the window in the message.

## Semantics worth knowing

**Downstream is temporal.** For `trace/tx`, downstream edges must occur *after* the seed tx (`(block, txIndex, logIndex)` ordering) and upstream edges *before* it. Without this, tracing a tx "downstream" would happily include money the recipient moved before it ever received anything from the seed. `trace/address` has no seed time, the window is its time bound.

**Hops follow fund direction** by default (`A → … → B`). Pass `undirected=true` to ignore direction.

**Each address is expanded once, at its shortest hop.** Cycles terminate, and `nodes[].hop` is the minimum distance from the seed.

## Ingestion

```bash
npm run ingest -- --from A --to B        # range mode, idempotent, resumes from the cursor if interrupted
npm run ingest -- --follow               # follow the head, CONFIRMATIONS (6) blocks behind, polls every 6s
npm run ingest -- --from A --to B --chunk 50   # force a starting getLogs span
```

- Each block is written in one SQLite transaction (delete-then-insert), so re-running a range or overlapping ranges converges to identical rows.
- Reorgs are detected by comparing each block's `parentHash` to the stored hash of its parent. On mismatch the ingester walks back to the common ancestor, deletes everything above it, and re-ingests. Follow mode additionally re-verifies the last 12 stored block hashes every poll.
- RPC calls retry with exponential backoff (6 attempts, 250 ms → 8 s). `eth_getLogs` spans halve on "too many results / range too large" errors and never grow back past the last failing size.

## Tests

```bash
npm test
```

- `test/trace.test.ts` (16): depth limit, direction, temporal filter, same-block ordering by txIndex, cycles, fan-out cap with `truncatedAt`, `maxNodes`, window restriction, unknown tx, address trace, mixed ETH/ERC-20, shortest path, directed vs undirected, `maxDepth`, per-hop temporal rule, same-hop earliest arrival.
- `test/ingest.test.ts` (6): native/ERC-20/ERC-721 extraction, duplicate ingestion idempotency, reorg rollback and re-ingest, tail verification after a late reorg, `getLogs` span halving, resumable cursor after a mid-range RPC failure.

Tests run against an in-memory SQLite and a fake chain, no network.

## Project layout

```
src/config.ts   env parsing
src/rpc.ts      viem client, retry, ChainReader interface (tests inject a fake)
src/db.ts       schema + prepared statements
src/ingest.ts   range / follow ingestion, reorg handling, transfer extraction
src/trace.ts    BFS trace (tx, address) and hops
src/server.ts   HTTP API
src/cli.ts      ingest + find-seeds commands
test/           node:test suites
docs/           system-design.md, chat-artifacts/
```

## Assumptions and limits

- Internal calls (ETH moved by contract code, e.g. through a router or multisig) are not visible without a tracing RPC (`debug_traceTransaction`). Public Sepolia endpoints don't expose it, so they are out of scope, as the assessment allows. Adding them is one more edge source in `extractTransfers`.
- ERC-721 / ERC-1155 movements are skipped on purpose (4-topic `Transfer`, different event for 1155).
- Contract-creation txs with value (`to = null`) are skipped; there were none in the window that mattered for the seeds.
- Traces stop at the window edge. An address that is active outside the window simply shows fewer edges.
- SQLite is single-writer: run one ingester at a time. The API can run concurrently with it.
