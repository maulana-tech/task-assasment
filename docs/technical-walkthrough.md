# Detailed Technical Walkthrough — Sepolia Transaction Trace System

## Project Structure

```
sepolia-trace/
├── .env.example              # RPC endpoint template
├── .env                      # Live config (gitignored)
├── package.json              # Dependencies, scripts, engine constraint
├── tsconfig.json             # TypeScript config
├── src/
│   ├── config.ts             # Environment variable parsing
│   ├── rpc.ts                # Viem client, retry logic, ChainReader interface
│   ├── db.ts                 # SQLite schema, CRUD operations
│   ├── ingest.ts             # Block ingestion, reorg handling, transfer extraction
│   ├── trace.ts              # BFS trace algorithm, shortest hops
│   ├── server.ts             # HTTP API server
│   └── cli.ts                # CLI commands (ingest, verify, find-seeds)
├── test/
│   ├── trace.test.ts         # 16 trace algorithm tests
│   └── ingest.test.ts        # 6 ingestion edge case tests
└── docs/
    ├── system-design.md      # Architecture document
    ├── contribution-attribution.md
    ├── chat-artifact.md
    └── expected/             # Seed query expected outputs
        ├── seeds.json        # Manifest of all 7 seed queries
        ├── tx1.json
        ├── tx2.json
        ├── tx3.json
        ├── addr1.json
        ├── addr2.json
        ├── hops1.json
        └── hops2.json
```

---

## File-by-File Breakdown

### `package.json`

```json
{
  "engines": { "node": ">=22.5" },   // Required: node:sqlite is experimental, needs 22+
  "dependencies": { "viem": "^2.21.0" },  // Only runtime dependency
  "devDependencies": {
    "@types/node": "^24.0.0",
    "tsx": "^4.19.0",       // TypeScript execution without build step
    "typescript": "^5.6.0"
  }
}
```

**Key scripts:**
- `npm test` — runs `node --import tsx --test "test/**/*.test.ts"` (built-in test runner)
- `npm run ingest` — runs `src/cli.ts` with env file loaded
- `npm run dev` — runs `src/server.ts` (API server)
- `npm run verify` — re-runs seed queries and diffs against `docs/expected/`
- `npm run typecheck` — `tsc --noEmit`

---

### `src/config.ts` (14 lines)

**Purpose:** Parse environment variables, fail fast if required vars missing.

```typescript
export const SEPOLIA_CHAIN_ID = 11155111;

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

export const config = {
  rpcUrl: () => required('SEPOLIA_RPC_URL'),  // Lazy eval — only fails if actually called
  dbPath: process.env.DB_PATH ?? 'data/trace.db',
  port: Number(process.env.PORT ?? 3000),
  confirmations: Number(process.env.CONFIRMATIONS ?? 6),
};
```

**Why lazy `rpcUrl()`?** Tests don't need an RPC URL. Making it a function instead of a property means the error only fires when the CLI actually tries to connect.

---

### `src/rpc.ts` (115 lines)

**Purpose:** Abstraction over Ethereum JSON-RPC via `viem`. Defines the `ChainReader` interface that tests can mock.

**Key types:**

```typescript
export type RpcBlock = {
  number: number;
  hash: string;
  parentHash: string;
  timestamp: number;
  transactions: { hash: string; transactionIndex: number; from: string; to: string | null; value: bigint }[];
};

export type RpcLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  transactionHash: string;
  transactionIndex: number;
  logIndex: number;
};

export interface ChainReader {
  blockNumber(): Promise<number>;
  getBlock(n: number): Promise<RpcBlock>;
  getTransferLogs(from: number, to: number): Promise<RpcLog[]>;
  getCode(address: string): Promise<string>;
}
```

**`withRetry` function:**
```typescript
export async function withRetry<T>(fn: () => Promise<T>, attempts = 6, baseMs = 250): Promise<T>
```
- Retries with exponential backoff: 250ms → 500ms → 1s → 2s → 4s → 8s
- Adds random jitter (0-100ms) to avoid thundering herd
- Does NOT retry `isRangeTooLarge` errors — those trigger span halving instead

**`isRangeTooLarge` function:**
```typescript
export function isRangeTooLarge(e: unknown): boolean
```
- Pattern-matches error messages from various providers (Alchemy, Infura, Tenderly, public nodes)
- Checks for: "more than", "too many", "range too large", "block range", "exceed", "limited to", "timeout"

**`createChainReader` function:**
- Creates a viem `PublicClient` connected to Sepolia
- Configures: `retryCount: 0` (we handle our own retry), `timeout: 60s`, `maxResponseBodySize: 64MB`
- Maps viem responses to our `RpcBlock`/`RpcLog` types

**`assertSepolia` function:**
- Calls `eth_chainId` and throws if not 11155111
- Run at the start of every ingest command

**Transfer topic constant:**
```typescript
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
```
- ERC-20 `Transfer(address,address,uint256)` event signature

---

### `src/db.ts` (191 lines)

**Purpose:** SQLite schema, prepared statements, all database operations.

**Schema (4 tables):**

```sql
-- Block headers. parentHash is critical for reorg detection.
blocks (
  number      INTEGER PRIMARY KEY,
  hash        TEXT NOT NULL,
  parent_hash TEXT NOT NULL,
  timestamp   INTEGER NOT NULL
)

-- Transfer edges. Each ETH transfer or ERC-20 event = one row.
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

-- Address cache. is_contract resolved lazily via eth_getCode.
addresses (
  address     TEXT PRIMARY KEY,
  is_contract INTEGER,             -- NULL = unknown, 0 = EOA, 1 = contract
  first_seen  INTEGER NOT NULL
)

-- Ingestion cursor. Single row, tracks highest committed block.
cursor (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  last_block INTEGER NOT NULL
)
```

**Indexes:**
```sql
ix_transfers_from ON transfers(from_addr, block_number)
ix_transfers_to   ON transfers(to_addr,   block_number)
ix_transfers_tx   ON transfers(tx_hash)
```

Why these indexes:
- `from_addr + block_number`: trace BFS repeatedly queries "all outgoing from X in range [lo, hi]"
- `to_addr + block_number`: same for incoming (upstream trace)
- `tx_hash`: `transfersByTx()` lookup for seed tx

**Key methods:**

| Method | What it does |
|---|---|
| `writeBlock(block, transfers)` | DELETE transfers for block, INSERT block + transfers, UPDATE cursor — all in one SQLite transaction |
| `rollbackFrom(n)` | `DELETE FROM blocks WHERE number >= n` (cascades to transfers), update cursor |
| `getCursor()` | Highest committed block number |
| `window()` | `[MIN(number), MAX(number)]` from blocks table |
| `transfersByTx(txHash)` | All transfers for a tx, ordered by log_index |
| `edgesFor(side, addrs, lo, hi, limit)` | Union of outgoing/incoming transfers for address list in block range |
| `isContract(addr)` | Check cache, return `null` if unknown |
| `setIsContract(addr, isContract)` | Upsert into addresses table |
| `counts()` | `{ blocks, transfers, addresses }` row counts |

**Why DELETE-then-INSERT per block?** Idempotency. Re-running the same range or overlapping ranges converges to identical rows. The UNIQUE constraint on `(tx_hash, log_index)` prevents duplicates.

**Why WAL mode?** Allows concurrent reads (API) while the ingester writes. Single-writer constraint is fine for this use case.

---

### `src/ingest.ts` (181 lines)

**Purpose:** Pull blocks from RPC, extract transfers, write to SQLite. Handle reorgs, retries, and provider limits.

**`ingestRange` function:**
```typescript
export async function ingestRange(
  db: Db, rpc: ChainReader, from: number, to: number, opts?: IngestOptions
): Promise<IngestStats>
```

Flow:
1. Start with chunk size from `opts.logChunk` (default 200), clamped to [10, 2000]
2. For each chunk:
   a. `rpc.getTransferLogs(n, end)` — get ERC-20 Transfer events
   b. If "too many results" error → halve chunk, retry (never grow past last failing size)
   c. `rpc.getBlock(b)` for each block in chunk (parallelized, concurrency=8)
   d. For each block: check `parentHash` against stored hash → detect reorg
   e. If reorg: find common ancestor, rollback, restart from there
   f. Otherwise: `extractTransfers(block, logs)` → `db.writeBlock()`
3. After each chunk: log progress, double chunk size (up to ceiling)

**`extractTransfers` function:**
```typescript
export function extractTransfers(block: RpcBlock, logs: RpcLog[]): Transfer[]
```

Two sources of transfers:

1. **Native ETH:** `tx.value > 0n && tx.to !== null` → `logIndex: -1`, `asset: 'ETH'`
2. **ERC-20:** `topics.length === 3 && data.length === 66` → extract from/to from topics, amount from data
   - Filters out: 4-topic (ERC-721), short data (not uint256)

**`findCommonAncestor` function:**
- Walk backward from block N, comparing stored hash to live hash
- First matching block = common ancestor
- Return its number (rollback to N-1)

**`verifyTail` function:**
- For follow mode: check last 12 stored blocks against chain
- If any hash mismatch → find ancestor, rollback
- Returns the block number to resume from

**`follow` function:**
- Poll loop: every 6s, get chain head - CONFIRMATIONS
- Verify tail, then ingest from cursor+1 to head
- SIGINT to stop

**`mapLimit` utility:**
- Parallel map with concurrency limit (default 8)
- Used for `getBlock` calls within a chunk

---

### `src/trace.ts` (213 lines)

**Purpose:** BFS trace algorithm and shortest hops. Core of the system.

**Types:**
```typescript
type Direction = 'down' | 'up' | 'both';

type TraceOptions = {
  depth?: number;           // max hops (default 3)
  direction?: Direction;    // default 'both'
  maxNodes?: number;        // cap on visited addresses (default 500)
  maxEdgesPerNode?: number; // fan-out cap (default 200)
  fromBlock?: number;       // override window start
  toBlock?: number;         // override window end
};

type TraceResult = {
  seed: { type: 'tx' | 'address'; value: string };
  window: [number, number];
  nodes: TraceNode[];       // { address, hop, isContract }
  edges: TraceEdge[];       // Transfer + { hop, direction }
  truncated: boolean;
  truncatedAt: string[];    // addresses where expansion stopped
};
```

**`traceTx` function:**
```typescript
export function traceTx(db, txHash, opts): TraceResult | undefined
```

1. Load seed edges: `db.transfersByTx(txHash)`
2. If no edges → return undefined (404)
3. Set seed position: `(block, txIndex, -1)` — the temporal origin
4. Mark all seed from/to as visited at hop 0
5. If direction !== 'up': BFS downstream from recipients
6. If direction !== 'down': BFS upstream from senders
7. `finish()`: build nodes list, deduplicate edges

**`traceAddress` function:**
```typescript
export function traceAddress(db, address, opts): TraceResult
```

Same BFS but:
- No seed tx → no temporal origin at hop 0
- Both directions by default
- Window is the time bound (not a seed timestamp)

**`hops` function:**
```typescript
export function hops(db, from, to, opts): HopsResult
```

Standard BFS for shortest path:
1. Start from source, expand via outgoing edges (or both if undirected)
2. Each hop satisfies temporal rule (after previous hop's position)
3. Return as soon as destination reached
4. `maxDepth` bounds search; `null` = unreachable

**Temporal rule implementation:**
```typescript
const after = (e: Transfer, p: Pos) => cmp(e, p) > 0;
const before = (e: Transfer, p: Pos) => cmp(e, p) < 0;
const cmp = (e: Transfer, p: Pos) =>
  e.blockNumber - p.block || e.txIndex - p.txIndex || e.logIndex - p.logIndex;
```
- Compares `(block, txIndex, logIndex)` tuples
- Downstream edges must be strictly after the address's position
- Upstream edges must be strictly before

**Cycle termination:**
- Each address visited once at shortest hop
- If reached again at same hop with earlier position → update position
- BFS ensures first visit = shortest hop

**Fan-out cap:**
```typescript
if (edges.length > o.maxEdgesPerNode) {
  edges = edges.slice(0, o.maxEdgesPerNode);
  res.truncated = true;
  res.truncatedAt.push(addr);
}
```

**`bfs` function (internal):**
```typescript
function bfs(db, res, visited, start, dir, o)
```

Core loop:
```
for hop = 1 to depth:
    for addr in frontier:
        edges = db.edgesFor(side, [addr], window[0], window[1], maxEdgesPerNode)
        if since: filter by temporal rule
        for each edge:
            add to result
            if destination not visited:
                mark visited at this hop
                add to next frontier
    frontier = next
```

---

### `src/server.ts` (122 lines)

**Purpose:** HTTP API server using `node:http`.

**Routes:**

| Route | Handler | Parameters |
|---|---|---|
| `GET /health` | Returns system status | none |
| `GET /trace/tx/:hash` | Transaction trace | `depth`, `direction`, `maxNodes`, `maxEdgesPerNode`, `fromBlock`, `toBlock` |
| `GET /trace/address/:addr` | Address trace | same as above |
| `GET /hops?from=&to=` | Shortest path | `maxDepth`, `undirected`, same opts |

**Validation:**
- Hash: `/^0x[0-99a-f]{64}$/i`
- Address: `/^0x[0-99a-f]{40}$/i`
- Direction: must be `down|up|both`
- Integer params: must be non-negative integers
- Limits: `depth ≤ 10`, `maxNodes ≤ 5000`, `maxEdgesPerNode ≤ 1000`, `maxDepth ≤ 12`

**Contract classification (`classify`):**
- After trace, check nodes with `isContract === null`
- Up to 50 per query
- `eth_getCode` → if code is `'0x'` it's an EOA, otherwise contract
- Cache in `addresses` table

**Error handling:**
- `HttpError` class with status code
- Non-HttpError → 500
- All responses JSON

**Entry point:**
```typescript
if (import.meta.url === `file://${process.argv[1]}`) {
  const db = new Db(config.dbPath);
  const rpc = createChainReader(config.rpcUrl());
  createApp(db, rpc).listen(config.port);
}
```
- Only starts server when run directly (not when imported for tests)

---

### `src/cli.ts` (148 lines)

**Purpose:** CLI entry point for ingest, verify, and find-seeds commands.

**Commands:**

1. **`npm run ingest -- --from A --to B`**
   - Validates range
   - Checks cursor for resume
   - Calls `ingestRange()`
   - Logs stats + elapsed time

2. **`npm run ingest -- --follow [--from A]`**
   - SIGINT handler for graceful shutdown
   - Calls `follow()` with confirmations from config

3. **`npm run verify`**
   - Reads `docs/expected/seeds.json` manifest
   - For each query: runs it against local DB
   - Compares nodes, edges, hops, path against expected JSON
   - Exit code 0 if all match, 1 on any mismatch

4. **`npm run find-seeds [-- --minHops 3 --maxEdges 25]`**
   - Scans first 20,000 ETH transfers
   - For each tx: trace downstream, check if ≥ minHops, edges ≤ maxEdges
   - Also finds addresses from those txs
   - Returns top 5 txs + 3 addresses as JSON

**`compare` function (for verify):**
- For trace results: compare node sets and edge sets by key
  - Node key: `address@hop`
  - Edge key: `txHash:logIndex`
- For hops results: compare `hops` count and `path` array
- Reports missing/extra nodes and edges

---

## `test/trace.test.ts` (198 lines)

**Purpose:** 16 tests for trace algorithm correctness.

**Test helpers:**
```typescript
function addr(c: string) { return '0x' + c.repeat(40); }
function tx(n: number) { return '0x' + n.toString(16).padStart(64, '0'); }
function graph(edges: [number, number, string, string, string?][]): Db
```

`graph()` creates an in-memory DB with blocks and transfers from a compact edge representation:
`[block, txIndex, from, to, asset?]`

**Tests:**

| Test | What it verifies |
|---|---|
| `traceTx downstream follows the chain up to depth` | A→B→C→D→E with depth=3 returns nodes at hop 0-3 |
| `depth limits the walk` | depth=1 only returns A, B, C |
| `temporal filter` | Downstream doesn't include pre-seed edges; upstream doesn't include post-seed |
| `same block ordering uses txIndex` | Two txs in same block ordered by txIndex |
| `cycles terminate` | A→B→C→A doesn't loop forever, A stays at hop 0 |
| `fan-out cap` | HUB with 30 outgoing, maxEdgesPerNode=5 → truncated=true, truncatedAt=[HUB] |
| `maxNodes stops expansion` | maxNodes=3 limits total visited addresses |
| `window restricts edges` | toBlock=11 hides edges at block 12+ |
| `unknown tx returns undefined` | Non-existent tx → undefined |
| `traceAddress both directions` | From B: reaches C (down), A and F (up) |
| `ERC-20 and ETH edges preserved` | Both asset types in result |
| `hops shortest directed path` | A→B→C→D + A→D: shortest is 1 hop |
| `hops direction matters` | E→A unreachable, but undirected finds path |
| `hops maxDepth bounds` | maxDepth=2 can't reach E, maxDepth=4 can |
| `per-hop temporal rule` | C→D predates funds reaching C → excluded from downstream |
| `earliest arrival at same hop` | Two paths to C at hop 1, earlier timestamp wins |

---

## `test/ingest.test.ts` (154 lines)

**Purpose:** 6 tests for ingestion edge cases.

**`FakeChain` mock:**
```typescript
class FakeChain implements ChainReader {
  calls = { getBlock: 0, getLogs: 0 };
  failLogsOnce = false;
  forkFrom = Infinity;  // simulate reorg at this block
  fork = '';            // suffix for forked hashes
  head = 100;
}
```

**Tests:**

| Test | What it verifies |
|---|---|
| `extractTransfers` | Native ETH (value>0) included, zero-value excluded, contract creation excluded, ERC-20 3-topic included, ERC-721 4-topic excluded |
| `duplicate ingestion idempotent` | Ingest range twice → same counts, cursor unchanged |
| `reorg rollback` | Fork at block 16 → rollback to ancestor, old txs removed, new txs present |
| `verifyTail catches late reorg` | After ingestion stops, fork at block 19 → verifyTail detects, rolls back |
| `getLogs span halving` | failLogsOnce → span halves from 100 to 50, completes successfully |
| `resumable cursor on RPC failure` | Fail at block 30 → cursor at last committed chunk, resume succeeds |

---

## `docs/expected/seeds.json`

Manifest of all 7 seed queries:

```json
{
  "queries": [
    { "key": "tx1", "kind": "tx", "value": "0x4c97c1e2...", "opts": { "depth": 3, "direction": "down" } },
    { "key": "tx2", "kind": "tx", "value": "0x8ccef51b...", "opts": { "depth": 3, "direction": "down" } },
    { "key": "tx3", "kind": "tx", "value": "0x684e9a9c...", "opts": { "depth": 3, "direction": "down" } },
    { "key": "addr1", "kind": "address", "value": "0x08ead670...", "opts": { "depth": 3, "direction": "down" } },
    { "key": "addr2", "kind": "address", "value": "0x1f759ef4...", "opts": { "depth": 3, "direction": "down" } },
    { "key": "hops1", "kind": "hops", "from": "0x1f759ef4...", "to": "0xf3d27499...", "opts": {} },
    { "key": "hops2", "kind": "hops", "from": "0x08ead670...", "to": "0xa396a53d...", "opts": {} }
  ]
}
```

Each `key` maps to a JSON file with the expected `nodes`, `edges`, `truncated`, and (for hops) `hops`/`path`.

---

## Data Flow

### Ingestion Flow

```
CLI (cli.ts)
  → assertSepolia()        // verify chain ID
  → createChainReader()    // viem client
  → ingestRange()          // (ingest.ts)
    → for each chunk:
        rpc.getTransferLogs(from, to)  // ERC-20 events
        rpc.getBlock(n) × chunk_size  // block headers + txs
        for each block:
          check parentHash vs stored   // reorg detection
          extractTransfers(block, logs)
          db.writeBlock(block, transfers)
    → update cursor
```

### Trace Query Flow

```
HTTP request (server.ts)
  → route()                // parse URL + params
  → traceTx(db, hash, opts)  // (trace.ts)
    → db.transfersByTx()     // seed edges
    → bfs(db, ..., 'down')   // downstream BFS
    → bfs(db, ..., 'up')     // upstream BFS
    → finish()               // build nodes, dedup edges
  → classify(db, rpc, result) // eth_getCode for unknown addresses
  → JSON response
```

### Hops Query Flow

```
HTTP request (server.ts)
  → route()
  → hops(db, from, to, opts)  // (trace.ts)
    → BFS from source
    → expand neighbors each hop
    → check temporal rule
    → return when destination reached or maxDepth hit
  → JSON response
```

---

## Key Design Decisions Explained

### Why SQLite over Postgres?
- Zero infrastructure — single file, comes with Node
- Sufficient for single-user trace tool
- WAL mode handles concurrent reads (API) + single writer (ingester)
- Trade-off: can't run multiple ingesters simultaneously

### Why transfer-only edges?
- Covers ETH + ERC-20 (the two required types)
- Simple, predictable data model
- Internal calls (contract → contract via code) would need `debug_traceTransaction`
- Public Sepolia endpoints don't expose it
- Adding it later = one more edge source in `extractTransfers`

### Why BFS not DFS?
- BFS guarantees shortest hop first
- Each address is visited once at its minimum distance
- Cycles terminate naturally (already visited = skip)
- DFS could visit the same node multiple times at longer paths

### Why DELETE-then-INSERT per block?
- Idempotency: re-running same range converges to identical rows
- No need for complex upsert logic
- Block granularity = small transactions (fast rollback on reorg)
- Trade-off: slightly slower than pure INSERT for first ingestion

### Why lazy contract classification?
- Eager classification during ingestion = thousands of `eth_getCode` calls
- Most addresses never appear in trace queries
- Lazy: only classify when returned in a trace response
- Cache in `addresses` table → one call per address lifetime

### Why `log_index = -1` for native ETH?
- ETH transfers don't have a log index (they're not events)
- Using -1 keeps `UNIQUE (tx_hash, log_index)` constraint valid
- Distinguishes ETH transfers from ERC-20 events in queries
- Convention used by many block explorers

---

## Technical Interview Preparation

Assessment bilang: *"In the technical interview we walk through your submission, ask you to explain specific code regardless of who authored it, and add a new requirement live. Be ready to run your system."*

Jadi interviewer akan:
1. Minta kamu **jelaskan kode tertentu** — meskipun AI yang tulis
2. **Add new requirement live** — kamu harus bisa adaptasi
3. **Run your system** — demonstrasi langsung

---

### Part 1: Code Walkthrough — Bisa Jelaskan Semua

#### Q: "Jelaskan `extractTransfers` di `src/ingest.ts:122`"

```typescript
export function extractTransfers(block: RpcBlock, logs: RpcLog[]): Transfer[] {
  const out: Transfer[] = [];
  // 1. Native ETH transfers
  for (const tx of block.transactions) {
    if (tx.value > 0n && tx.to) {    // skip contract creation (to=null)
      out.push({
        txHash: tx.hash,
        blockNumber: block.number,
        txIndex: tx.transactionIndex,
        logIndex: -1,                 // -1 = sentinel untuk native ETH
        from: tx.from.toLowerCase(),
        to: tx.to.toLowerCase(),
        asset: 'ETH',
        amount: tx.value.toString(),  // bigint → string untuk presisi
      });
    }
  }
  // 2. ERC-20 Transfer events
  for (const l of logs) {
    if (l.topics.length !== 3 || l.data.length !== 66) continue;
    // topics[0] = event signature, topics[1] = from (indexed), topics[2] = to (indexed)
    // data = amount (non-indexed, uint256)
    out.push({
      txHash: l.transactionHash,
      blockNumber: l.blockNumber,
      txIndex: l.transactionIndex,
      logIndex: l.logIndex,
      from: topicToAddress(l.topics[1]),  // potong 32-byte topic, ambil 20-byte address
      to: topicToAddress(l.topics[2]),
      asset: l.address.toLowerCase(),     // ERC-20 contract address
      amount: BigInt(l.data).toString(),
    });
  }
  return out;
}
```

**Kenapa `topics.length !== 3`?**
- ERC-20 Transfer punya 3 topik: signature, from (indexed), to (indexed)
- ERC-721 punya 4 topik: signature, from, to, tokenId
- Kita skip ERC-721 karena assment hanya minta ETH + ERC-20

**Kenapa `data.length !== 66`?**
- `0x` + 64 hex chars = 32 bytes = uint256
- Kalau lebih pendek, bukan standard ERC-20 amount

**Kenapa `logIndex = -1` untuk ETH?**
- ETH transfer bukan event, tidak punya log index
- Pakai -1 supaya `UNIQUE (tx_hash, log_index)` constraint tetap valid
- Memudahkan query: WHERE log_index = -1 artinya ETH

---

#### Q: "Jelaskan BFS di `src/trace.ts:124`"

```typescript
function bfs(db, res, visited, start, dir, o) {
  const side = dir === 'down' ? 'from' : 'to';  // query kolom mana
  let frontier = uniq(start);

  for (let hop = 1; hop <= o.depth && frontier.length > 0; hop++) {
    const next = new Set<string>();
    for (const addr of frontier) {
      const since = visited.get(addr)?.pos;  // kapan address ini terima/dana kirim

      // Query edges dari DB
      let edges = db.edgesFor(side, [addr], o.window[0], o.window[1], o.maxEdgesPerNode);

      // Temporal filter: downstream harus AFTER, upstream harus BEFORE
      if (since) edges = edges.filter((e) => (dir === 'down' ? after(e, since) : before(e, since)));

      // Fan-out cap
      if (edges.length > o.maxEdgesPerNode) {
        edges = edges.slice(0, o.maxEdgesPerNode);
        res.truncated = true;
        res.truncatedAt.push(addr);
      }

      for (const e of edges) {
        res.edges.push({ ...e, hop, direction: dir });
        const other = dir === 'down' ? e.to : e.from;

        if (!visited.has(other)) {
          // Baru ditemukan → tandai di hop ini
          visited.set(other, { hop, pos: posOf(e) });
          next.add(other);
        } else if (next.has(other) && seen.pos && ...) {
          // Sudah ditemukan di hop yang sama → update kalau lebih awal
          seen.pos = posOf(e);
        }
      }

      // MaxNodes cap
      if (visited.size >= o.maxNodes) {
        res.truncated = true;
        return;
      }
    }
    frontier = [...next];
  }
}
```

**Kenapa BFS bukan DFS?**
- BFS menjamin shortest hop pertama kali ditemukan
- Setiap address cuma dikunjungi sekali di minimum distance
- Cycles otomatis terminate (sudah visited = skip)
- DFS bisa kunjungi node yang sama beberapa kali di path lebih panjang

**Kenapa temporal rule per-hop?**
```
Seed tx di block 100: A → B
B → C di block 90 (SEBELUM seed) → TIDAK boleh masuk downstream
B → C di block 110 (SESUDAH seed) → boleh masuk downstream
```
Tapi juga:
```
B → C di block 110
C → D di block 105 (sebelum C terima dana dari B) → TIDAK boleh
C → D di block 115 (sesudah C terima dana dari B) → boleh
```
Ini mencegah tracing uang yang digerakkan sebelum dana sampai.

---

#### Q: "Jelaskan reorg handling di `src/ingest.ts:46-68`"

```typescript
let reorgAt: number | undefined;
for (const block of blocks) {
  const prev = db.getBlock(block.number - 1);
  if (prev && prev.hash !== block.parentHash) {
    // Parent hash tidak cocok → reorg terjadi
    reorgAt = await findCommonAncestor(db, rpc, block.number - 1);
    break;
  }
  // Normal: tulis block
  db.writeBlock(block, extractTransfers(block, logs));
}

if (reorgAt !== undefined) {
  stats.reorgs++;
  db.rollbackFrom(reorgAt + 1);  // hapus semua block >= reorgAt+1
  n = reorgAt + 1;               // mulai lagi dari ancestor
  continue;
}
```

**Analogi sederhana:**
- Bayangkan kamu punya catatan blok 1,2,3,4,5
- Tiba-tiba blockchain bilang: blok 3,4,5 itu salah, yang benar 3',4',5'
- Common ancestor = blok 2
- Hapus 3,4,5 → tulis ulang 3',4',5'

**Kenapa `findCommonAncestor` jalan backward?**
- Mulai dari block yang hash-nya beda
- Jalan mundur satu per satu, bandingkan stored hash vs live hash
- Pertama kali match = common ancestor

---

#### Q: "Jelaskan `writeBlock` di `src/db.ts:77`"

```typescript
writeBlock(block: BlockRow, transfers: Transfer[]) {
  this.sql.exec('BEGIN');
  try {
    this.sql.prepare('DELETE FROM transfers WHERE block_number = ?').run(block.number);
    this.sql.prepare('INSERT OR REPLACE INTO blocks ...').run(...);
    for (const t of transfers) {
      this.sql.prepare('INSERT OR IGNORE INTO transfers ...').run(...);
      this.sql.prepare('INSERT OR IGNORE INTO addresses ...').run(...);
    }
    this.sql.prepare('INSERT INTO cursor ...').run(block.number);
    this.sql.exec('COMMIT');
  } catch (e) {
    this.sql.exec('ROLLBACK');
    throw e;
  }
}
```

**Kenapa DELETE dulu baru INSERT?**
- Idempotency: kalau block yang sama di-ingest dua kali, hasilnya sama
- DELETE menghapus semua transfers lama untuk block itu
- INSERT menulis yang baru
- Cascade: DELETE transfers otomatis hapus referensi

**Kenapa pakai transaction?**
- Kalau gagal di tengah (misal disk penuh), database tetap konsisten
- ROLLBACK membatalkan semua perubahan
- Tanpa transaction, bisa terjadi partial write

---

#### Q: "Jelaskan `edgesFor` di `src/db.ts:144`"

```typescript
edgesFor(side: 'from' | 'to', addrs: string[], lo: number, hi: number, perAddrLimit: number): Transfer[] {
  const col = side === 'from' ? 'from_addr' : 'to_addr';
  const stmt = this.sql.prepare(
    `${SELECT_TRANSFER} WHERE ${col} = ? AND block_number BETWEEN ? AND ?
     ORDER BY block_number, tx_index, log_index LIMIT ?`
  );
  for (const a of addrs) out.push(...(stmt.all(a, lo, hi, perAddrLimit + 1) as Transfer[]));
  return out;
}
```

**Kenapa ada `perAddrLimit + 1`?**
- Kita ambil 1 lebih banyak dari limit
- Kalau hasilnya `limit + 1`, berarti ada fan-out yang perlu di-cap
- Caller (bfs) bisa cek dan set `truncated = true`

**Kenapa ORDER BY `block_number, tx_index, log_index`?**
- Konsisten dengan temporal ordering
- Block dulu, lalu txIndex (dalam block yang sama), lalu logIndex (dalam tx yang sama)
- Ini urutan chronologis yang benar

---

### Part 2: System Design Questions

#### Q: "Kenapa pakai SQLite bukan Postgres?"

**Jawaban:**
- **Requirements**: "Justify your data model" — SQLite paling sederhana
- **Zero config**: Tidak perlu install service, single file
- **ACID**: WAL mode, transaction support
- **Sufficient**: Untuk single-user trace tool, 280k rows tidak masalah
- **Trade-off**: Single writer (tidak bisa multiple ingester), tapi untuk use case ini oke
- **Kalau production**: Pindah ke Postgres untuk concurrent writes, connection pooling

---

#### Q: "Kalau harus scale ke mainnet, apa yang berubah?"

**Jawaban:**
1. **Storage**: SQLite → Postgres (concurrent writes, better indexing)
2. **Ingestion**: Parallel chunk processing, multiple workers
3. **Caching**: Redis untuk hot traces (LRU)
4. **API**: Rate limiting, pagination, WebSocket untuk follow mode
5. **Monitoring**: Metrics, logging, alerting
6. **Internal calls**: Tambah `debug_traceTransaction` untuk contract interactions
7. **ERC-721/1155**: Tambah topic filter di `getTransferLogs`

---

#### Q: "Bagaimana kalau RPC provider down?"

**Jawaban:**
- `withRetry`: 6 attempts, exponential backoff (250ms → 8s)
- `isRangeTooLarge`: deteksi rate limit, trigger span halving
- `getCursor`: resume dari block terakhir yang committed
- Kalau semua gagal: throw error, user bisa ganti `SEPOLIA_RPC_URL`
- Tidak ada data loss karena idempotent

---

#### Q: "Apa bottleneck dari sistem ini?"

**Jawaban:**
1. **RPC calls**: `getBlock` per block, `getTransferLogs` per chunk — ini paling lambat
2. **SQLite writes**: WAL mode helps, tapi tetap single writer
3. **Trace BFS**: query per address, bisa lambat kalau banyak edges
4. **Contract classification**: `eth_getCode` per address unknown

**Optimasi yang sudah dilakukan:**
- Chunk adaptive (auto-halve on provider limit)
- Parallel getBlock (concurrency 8)
- Lazy contract classification (only when queried)
- Indexes on from_addr + block_number

---

### Part 3: Algorithm Questions

#### Q: "Kenapa temporal rule per-hop bukan cuma relatif ke seed?"

**Jawaban:**
```
Seed: A → B di block 100
B → C di block 110 (ok)
C → D di block 105 (SEBELUM C terima dari B!)
```
Kalau cuma cek relatif ke seed: block 105 > 100, D akan di-trace
Tapi C belum terima uang dari B di block 105, jadi itu bukan "follow the money"

**Per-hop rule**: Setiap hop harus AFTER alamat itu terima dana sebelumnya

---

#### Q: "Bagaimana kamu handle cycle?"

**Jawaban:**
```typescript
if (!visited.has(other)) {
  visited.set(other, { hop, pos: posOf(e) });
  next.add(other);
}
```
- Setiap address cuma dikunjungi sekali
- BFS menjamin hop pertama = shortest
- Kalau sudah visited, skip
- Tidak ada infinite loop

---

#### Q: "Apa complexity dari BFS trace?"

**Jawaban:**
- **Time**: O(V + E) di mana V = jumlah addresses, E = jumlah edges
- Tapi dibatasi oleh `maxNodes` dan `maxEdgesPerNode`
- Worst case: O(maxNodes × maxEdgesPerNode)
- **Space**: O(maxNodes) untuk visited set + frontier

---

### Part 4: Live Requirement — "Tambahkan Internal Call Tracing"

Assessment bilang: *"add a new requirement live"*

Kemungkinan mereka minta: **"Bagaimana kalau kita ingin trace internal calls (contract → contract)?"**

**Jawaban:**

1. **Tambah edge source baru**:
```typescript
// Di ingest.ts, tambah:
async function getInternalCalls(rpc, block): Promise<Transfer[]> {
  // debug_traceTransaction untuk setiap tx
  // Parse trace frames untuk internal value transfers
  // Return sebagai Transfer dengan source = 'internal'
}
```

2. **Schema tetap sama**:
- Transfer table sudah support asal ada from, to, asset, amount
- Tambah kolom `source: 'eth' | 'erc20' | 'internal'` (opsional)

3. **Trace algorithm tidak berubah**:
- BFS tetap query `edgesFor()`
- Tapi sekarang ada lebih banyak edges

4. **Trade-off**:
- `debug_traceTransaction` tidak tersedia di public endpoints
- Perlu archive node (Alchemy, Infura premium)
- Lebih banyak RPC calls (per tx, bukan per block)
- Storage lebih besar

---

### Part 5: Behavioral Questions

#### Q: "Apa yang kamu pelajari dari project ini?"

**Jawaban:**
- Blockchain data extraction butuh handling reorgs, idempotency
- Public RPC endpoints punya rate limits yang unpredictable
- Temporal ordering kritis untuk "follow the money"
- Simple data model (SQLite) bisa cukup untuk use case spesifik
- AI membantu accelerate development, tapi human harus verify dan defend

---

#### Q: "Bagaimana kamu divide work dengan AI?"

**Jawaban:**
- **Saya**: Ingestion, data model, trace algorithm — core logic
- **AI**: API layer, tests, documentation — boilerplate dan repetitive work
- **Jointly**: AI draft, saya review dan approve
- Yang penting: saya bisa **explain every line** meskipun AI yang tulis

---

#### Q: "Apa kekurangan dari sistem ini?"

**Jawaban jujur:**
1. Tidak ada internal call tracing (butuh debug_traceTransaction)
2. Tidak ada ERC-721/1155 support
3. SQLite single writer
4. Tidak ada caching layer
5. Tidak ada authentication
6. Window-bounded (data di luar window tidak terlihat)

---

### Part 6: Demo Script — "Run Your System"

Siapkan terminal, jalankan:

```bash
# 1. Show tests pass
npm test

# 2. Show ingest status
npm run verify

# 3. Start API
npm run dev

# 4. Query seed tx
curl "localhost:3000/trace/tx/0x4c97c1e24c03bd19fcbb9c4eb2fcadf476caf5730e8621cd18183a0b333550d9?depth=3&direction=down"

# 5. Query health
curl localhost:3000/health

# 6. Query hops
curl "localhost:3000/hops?from=0x1f759ef4c554c9b6cd72cdbf220e57fa8d63aee1&to=0xf3d27499da2e5c8f5b5eb4c4fa23775e5978844e"
```

**Yang ditunjukkan:**
- Tests pass → kode benar
- Verify pass → data sesuai expected
- API running → bisa query langsung
- Response sesuai README → konsisten

---

### Part 7: Cheat Sheet — Angka Penting

| Item | Value |
|---|---|
| Block window | 11672000 – 11673999 |
| Total blocks | 2,000 |
| Total transfers | 280,051 |
| Total addresses | 51,725 |
| Tests | 22 (pass 22, fail 0) |
| API routes | 4 (/health, /trace/tx, /trace/address, /hops) |
| Seed queries | 7 (3 tx, 2 address, 2 hops) |
| Ingest time | ~520 seconds (public Tenderly) |
| Runtime dependency | 1 (viem) |
| Chain ID | 11155111 (Sepolia) |
| RPC env var | SEPOLIA_RPC_URL |
