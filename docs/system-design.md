# System Design — Sepolia Transaction Trace System

## 1. Overview

The system ingests native ETH transfers and ERC-20 `Transfer` events from Ethereum Sepolia into a local SQLite database, then answers three query types:

1. **Trace a transaction** — walk upstream (where did the money come from?) and downstream (where did it go?) from the seed tx.
2. **Trace an address** — same BFS walk, but rooted at an address with no temporal seed.
3. **Shortest hops between two addresses** — BFS on the transfer graph.

```
┌──────────┐    JSON-RPC     ┌─────────┐    SQLite     ┌───────────┐
│  Sepolia │ ──────────────► │ Ingest  │ ────────────► │    DB     │
│   Node   │                 │ Service │               │ (SQLite)  │
└──────────┘                 └─────────┘               └─────┬─────┘
                                                             │
                                    HTTP API ────────────────┤
                                    (node:http)              │
                                                             ▼
                                                       ┌───────────┐
                                                       │  Client   │
                                                       │ (curl/UI) │
                                                       └───────────┘
```

**Stack choices:**

| Component | Choice | Why |
|---|---|---|
| Language | Node 24 + TypeScript | Native `node:sqlite`, no build step |
| RPC client | `viem` | Reusable, well-typed, Sepolia chain preset |
| Storage | SQLite via `node:sqlite` | Zero-dependency, single-file, ACID, sufficient for single-writer |
| API | `node:http` | No framework dependency, one runtime dep total |
| Tests | `node:test` | Built-in, no test runner to install |

---

## 2. Data Model

Four tables in WAL mode. Foreign key with `ON DELETE CASCADE` links transfers to blocks.

```sql
blocks (
  number      INTEGER PRIMARY KEY,
  hash        TEXT NOT NULL,
  parent_hash TEXT NOT NULL,       -- for reorg detection
  timestamp   INTEGER NOT NULL
)

transfers (
  id           INTEGER PRIMARY KEY,
  tx_hash      TEXT NOT NULL,
  block_number INTEGER NOT NULL REFERENCES blocks(number) ON DELETE CASCADE,
  tx_index     INTEGER NOT NULL,
  log_index    INTEGER NOT NULL,   -- -1 = native ETH, >=0 = ERC-20 event
  from_addr    TEXT NOT NULL,
  to_addr      TEXT NOT NULL,
  asset        TEXT NOT NULL,      -- "ETH" or ERC-20 contract address
  amount       TEXT NOT NULL,      -- decimal string (uint256)
  UNIQUE (tx_hash, log_index)
)

addresses (
  address     TEXT PRIMARY KEY,
  is_contract INTEGER,             -- NULL = unknown, 0 = EOA, 1 = contract
  first_seen  INTEGER NOT NULL     -- block number
)

cursor (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  last_block INTEGER NOT NULL      -- highest committed block
)
```

**Key design decisions:**

- **Transfer as the edge unit.** Each ETH transfer or ERC-20 `Transfer` event becomes one row. This is the atomic unit of fund movement — a single tx can produce multiple transfer edges (fan-out).
- **`log_index = -1` sentinel.** Native ETH transfers don't have a log index; using -1 keeps the `UNIQUE (tx_hash, log_index)` constraint valid and distinguishes them from ERC-20 events.
- **Amount as string.** uint256 values exceed `Number.MAX_SAFE_INTEGER`; stored as decimal strings to preserve precision.
- **`addresses` table as cache.** Populated during ingestion, `is_contract` is lazily resolved during trace queries via `eth_getCode`. Avoids redundant RPC calls.
- **Single-writer SQLite.** The ingester and API share the same DB file. SQLite's WAL mode allows concurrent reads while the ingester writes. Only one ingester instance should run.

### Indexes

```sql
ix_transfers_from ON transfers(from_addr, block_number)
ix_transfers_to   ON transfers(to_addr,   block_number)
ix_transfers_tx   ON transfers(tx_hash)
```

The `from/to` indexes are critical: the trace BFS repeatedly queries "all outgoing transfers from address X in block range [lo, hi]" — a range scan on `from_addr + block_number`.

---

## 3. Ingestion

### Flow

```
for each chunk of N blocks:
  1. getTransferLogs(from, to)    -- ERC-20 Transfer events
  2. getBlock(n) for n in chunk   -- block headers + full txs
  3. for each block:
     a. check parentHash against stored hash → detect reorg
     b. extractTransfers(block, logs) → ETH + ERC-20 edges
     c. db.writeBlock() in one SQLite transaction (delete-then-insert)
  4. on reorg: find common ancestor, rollback, re-ingest from there
```

### Reorg Handling

Every block's `parentHash` is compared to the stored hash of the previous block. On mismatch:

1. Walk backward block-by-block, comparing stored hash to live hash.
2. The first block where hashes match is the common ancestor.
3. Delete all blocks above the ancestor (`DELETE FROM blocks WHERE number >= N` cascades to transfers).
4. Re-ingest from ancestor + 1.

Follow mode additionally re-verifies the last 12 stored block hashes each poll cycle, catching reorgs that happened while the ingester was offline.

### Idempotency

Each block is written as `DELETE WHERE block_number = N` then `INSERT`. Re-running the same range or overlapping ranges converges to identical rows. The cursor advances only on committed blocks.

### `eth_getLogs` Span Adaptation

Public Sepolia endpoints impose a limit on the block range of `eth_getLogs` queries. The ingester starts at 200 blocks, and if the RPC returns "too many results" or "range too large", it halves the span (200 → 100 → 50 → ...) until the call succeeds, then doubles back on success. This probe runs once and the ingester settles at the provider's actual limit.

### RPC Retry

All RPC calls (`getBlock`, `getTransferLogs`, `getCode`, `blockNumber`) retry with exponential backoff: 6 attempts, 250 ms base → 8 s max, plus jitter. "Range too large" errors are not retried — they trigger span halving instead.

---

## 4. Trace Algorithm

### 4.1 Transaction Trace (`traceTx`)

**Input:** transaction hash, depth, direction, window.

**Algorithm:**

1. **Seed phase.** Load all transfers belonging to the seed tx. Each transfer is a hop-0 edge. The seed's `(block, txIndex, -1)` position defines the temporal origin.

2. **BFS expansion.** For each direction (down, up, or both):

   ```
   frontier = [seed recipients (down) or seed senders (up)]
   for hop = 1 to depth:
       for addr in frontier:
           edges = db.edgesFor(addr, window)     -- outgoing for down, incoming for up
           edges = filter(edges, temporal rule)   -- must be after/before the addr's position
           for each edge:
               add edge to result
               if destination not visited:
                   mark visited at this hop
                   add to next frontier
   ```

3. **Temporal rule.** A downstream edge must occur strictly *after* the address received funds (by `(block, txIndex, logIndex)`). An upstream edge must occur strictly *before*. This prevents tracing money the recipient moved before the seed tx.

4. **Cycle termination.** Each address is visited once at its shortest hop. If a node is reachable again at the same hop via a different edge, the earlier arrival time wins.

5. **Fan-out cap.** If an address has more than `maxEdgesPerNode` outgoing edges in the window, only the first N are included and `truncated = true`.

### 4.2 Address Trace (`traceAddress`)

Same BFS, but there is no seed tx — the root address starts at hop 0 with no temporal position. Both directions are explored by default. The window (`fromBlock`, `toBlock`) bounds the search.

### 4.3 Shortest Hops (`hops`)

Standard BFS on the directed transfer graph:

1. Start from source address, expand neighbors via outgoing edges.
2. If `undirected = true`, also expand via incoming edges.
3. Each hop must satisfy the temporal rule (edges must be after the previous hop's position).
4. Return as soon as the destination is reached.
5. `maxDepth` bounds the search; `null` result means unreachable within the limit.

---

## 5. API

Plain `node:http`, four routes:

| Route | Description |
|---|---|
| `GET /health` | Window, cursor, chain head, lag, row counts |
| `GET /trace/tx/:hash` | BFS trace from a transaction |
| `GET /trace/address/:addr` | BFS trace from an address |
| `GET /hops?from=&to=` | Shortest path between two addresses |

**Query parameters:** `depth` (default 3), `direction` (down/up/both), `maxNodes` (500), `maxEdgesPerNode` (200), `fromBlock`, `toBlock`, `maxDepth` (6 for hops), `undirected` (false).

**Response format:**

```jsonc
{
  "seed": { "type": "tx" | "address", "value": "0x…" },
  "window": [startBlock, endBlock],
  "nodes": [ { "address": "0x…", "hop": 0, "isContract": false } ],
  "edges": [ { "txHash": "0x…", "blockNumber": N, "from": "0x…", "to": "0x…",
               "asset": "ETH" | "0x…", "amount": "1000000", "hop": 1, "direction": "down" } ],
  "truncated": false,
  "truncatedAt": []
}
```

**Contract classification.** `isContract` is resolved lazily during trace responses — up to 50 unknown addresses per query are classified via `eth_getCode` and cached in the `addresses` table. This avoids eager classification during ingestion (which would add thousands of RPC calls).

---

## 6. Trade-offs and Limitations

### What we chose

| Decision | Trade-off |
|---|---|
| SQLite over Postgres | Zero infrastructure, single-file deployment. Constrained to single-writer; acceptable for a single-user trace tool. |
| No ORM / raw SQL | Full control over query plans, minimal overhead. Schema changes require manual migration. |
| `node:http` over Express/Fastify | One runtime dependency (`viem`). Less ergonomic routing, but the API has only 4 routes. |
| Transfer-only edges | Simpler model, covers ETH + ERC-20. Misses internal contract calls. |
| `node:test` over Jest/Vitest | Built-in, zero config. Less ecosystem support for mocking. |

### What we deliberately skipped

1. **Internal calls (trace debug).** EVM `debug_traceTransaction` or `trace_block` would reveal ETH moved by contract code (router forwards, multisig disbursements). Public Sepolia endpoints don't expose this. Adding it would be one more edge source in `extractTransfers` — the data model already supports arbitrary `(from, to, asset)` edges.

2. **ERC-721 / ERC-1155.** The 4-topic `Transfer` (ERC-721 `Transfer(from, to, tokenId)`) and ERC-1155 `TransferSingle`/`TransferBatch` events have different signatures. They can be added as additional topic filters in `getTransferLogs` with minimal schema changes.

3. **Contract-creation txs.** Transactions with `to = null` (contract creation) carry value but have no recipient address in the standard sense. None appeared in the window that mattered for the seed traces.

4. **Visualization.** The API returns structured JSON. A frontend could render the graph with D3 or vis.js, but the assessment focuses on the backend trace logic.

### Known limits

- **Window-bounded.** Traces stop at window edges. An address active outside the window shows fewer edges.
- **Single-chain.** The CLI validates `eth_chainId === 11155111` and refuses anything else.
- **No snapshot isolation.** A trace query reading while the ingester writes could see partial state. WAL mode minimizes this window; in practice the API and ingester rarely overlap for a single user.

---

## 7. Test Strategy

All tests run against an in-memory SQLite and a `FakeChain` mock — no network calls.

**Trace tests (16):** depth limiting, temporal filtering (downstream must be after seed, upstream before), same-block ordering by txIndex, cycle termination, fan-out truncation, maxNodes cap, window restriction, unknown tx, address trace (both directions), mixed ETH/ERC-20 edges, shortest path, directed vs undirected hops, maxDepth bound, per-hop temporal rule, earliest arrival at same hop.

**Ingestion tests (6):** native ETH + ERC-20 extraction (ERC-721 filtered out), idempotent re-ingestion, reorg rollback and re-ingest, tail verification after late reorg, `getLogs` span halving on provider limit, resumable cursor after mid-range RPC failure.

---

## 8. File Layout

```
src/
  config.ts      env parsing, chain ID constant
  rpc.ts         viem client, retry, ChainReader interface (tests inject a fake)
  db.ts          SQLite schema, prepared statements, block/transfer CRUD
  ingest.ts      range/follow ingestion, reorg handling, transfer extraction
  trace.ts       BFS trace (tx, address) and shortest hops
  server.ts      HTTP API (4 routes)
  cli.ts         ingest, find-seeds, verify commands
test/
  trace.test.ts  16 trace algorithm tests
  ingest.test.ts 6 ingestion edge case tests
docs/
  system-design.md   this document
  expected/          seed query expected outputs (JSON)
```
