import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { Db } from './db.ts';
import { config } from './config.ts';
import { assertSepolia, createChainReader } from './rpc.ts';
import { follow, ingestRange } from './ingest.ts';
import { hops, traceAddress, traceTx } from './trace.ts';

const USAGE = `usage:
  npm run ingest -- --from <block> --to <block>      ingest a range (re-runnable, resumes)
  npm run ingest -- --follow [--from <block>]         follow the head, CONFIRMATIONS behind
  npm run find-seeds [-- --minHops 3 --maxEdges 25]   list small txs/addresses with >= 3-hop traces
  npm run verify                                      re-run README seeds, diff against docs/expected/*.json`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    from: { type: 'string' },
    to: { type: 'string' },
    follow: { type: 'boolean', default: false },
    chunk: { type: 'string' },
    minHops: { type: 'string', default: '3' },
    maxEdges: { type: 'string', default: '25' },
  },
});

const cmd = positionals[0];
const db = new Db(config.dbPath);

if (cmd === 'ingest') {
  const url = config.rpcUrl();
  await assertSepolia(url);
  const rpc = createChainReader(url);
  const log = (m: string) => console.log(new Date().toISOString(), m);
  const logChunk = values.chunk ? Number(values.chunk) : undefined;

  if (values.follow) {
    const ac = new AbortController();
    process.on('SIGINT', () => ac.abort());
    await follow(db, rpc, {
      confirmations: config.confirmations,
      startBlock: values.from ? Number(values.from) : undefined,
      signal: ac.signal,
      logChunk,
      log,
    });
  } else {
    const from = Number(values.from);
    const to = Number(values.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) {
      console.error(USAGE);
      process.exit(1);
    }
    const cursor = db.getCursor();
    const start = cursor !== undefined && cursor >= from && cursor < to ? cursor + 1 : from;
    if (start !== from) log(`resuming from ${start} (cursor=${cursor})`);
    const t0 = Date.now();
    const s = await ingestRange(db, rpc, start, to, { logChunk, log });
    log(`done: ${JSON.stringify({ ...s, ...db.counts(), seconds: Math.round((Date.now() - t0) / 1000) })}`);
  }
} else if (cmd === 'find-seeds') {
  findSeeds(db, Number(values.minHops), Number(values.maxEdges));
} else if (cmd === 'verify') {
  process.exitCode = verifySeeds(db) ? 0 : 1;
} else {
  console.error(USAGE);
  process.exit(1);
}

db.close();

function findSeeds(db: Db, minHops: number, maxEdges: number) {
  const opts = { depth: minHops, direction: 'down' as const, maxNodes: 200, maxEdgesPerNode: 50 };
  const rows = db.sql
    .prepare(
      `SELECT DISTINCT tx_hash AS txHash FROM transfers
       WHERE log_index = -1 ORDER BY block_number LIMIT 20000`,
    )
    .all() as { txHash: string }[];

  const txs: { txHash: string; hops: number; nodes: number; edges: number }[] = [];
  for (const { txHash } of rows) {
    const r = traceTx(db, txHash, opts);
    if (!r) continue;
    const maxHop = Math.max(...r.nodes.map((n) => n.hop));
    if (maxHop >= minHops && !r.truncated && r.edges.length <= maxEdges)
      txs.push({ txHash, hops: maxHop, nodes: r.nodes.length, edges: r.edges.length });
    if (txs.length >= 10) break;
  }
  txs.sort((a, b) => a.edges - b.edges);

  const addrs: { address: string; hops: number; nodes: number; edges: number }[] = [];
  const seen = new Set<string>();
  for (const t of txs) {
    for (const e of db.transfersByTx(t.txHash)) {
      if (seen.has(e.from)) continue;
      seen.add(e.from);
      const r = traceAddress(db, e.from, opts);
      const maxHop = Math.max(...r.nodes.map((n) => n.hop));
      if (maxHop >= minHops && !r.truncated && r.edges.length <= maxEdges) addrs.push({ address: e.from, hops: maxHop, nodes: r.nodes.length, edges: r.edges.length });
    }
    if (addrs.length >= 5) break;
  }
  addrs.sort((a, b) => a.edges - b.edges);

  console.log(JSON.stringify({ window: db.window(), txs: txs.slice(0, 5), addresses: addrs.slice(0, 3) }, null, 2));
}

function verifySeeds(db: Db): boolean {
  const manifest = JSON.parse(readFileSync('docs/expected/seeds.json', 'utf8')) as {
    queries: { key: string; kind: 'tx' | 'address' | 'hops'; value?: string; from?: string; to?: string; opts: any }[];
  };
  let ok = true;
  for (const q of manifest.queries) {
    const expected = JSON.parse(readFileSync(`docs/expected/${q.key}.json`, 'utf8'));
    const actual =
      q.kind === 'tx' ? traceTx(db, q.value!, q.opts)
      : q.kind === 'address' ? traceAddress(db, q.value!, q.opts)
      : hops(db, q.from!, q.to!, q.opts);
    const diff = actual ? compare(expected, actual) : ['no result (tx not in window?)'];
    console.log(`${diff.length ? 'FAIL' : 'ok  '} ${q.key} ${q.kind} ${q.value ?? `${q.from} -> ${q.to}`}`);
    for (const d of diff) console.log(`      ${d}`);
    ok &&= diff.length === 0;
  }
  console.log(ok ? 'all seeds match' : 'MISMATCH: expected output differs from this DB');
  return ok;
}

function compare(expected: any, actual: any): string[] {
  const out: string[] = [];
  const edgeKey = (e: any) => `${e.txHash}:${e.logIndex}`;
  const nodeKey = (n: any) => `${n.address}@${n.hop}`;
  if ('hops' in expected) {
    if (expected.hops !== actual.hops) out.push(`hops: expected ${expected.hops}, got ${actual.hops}`);
    if (expected.path.join('>') !== actual.path.join('>')) out.push(`path differs: ${actual.path.join(' > ')}`);
    return out;
  }
  const setDiff = (label: string, a: string[], b: string[]) => {
    const A = new Set(a), B = new Set(b);
    const missing = a.filter((x) => !B.has(x)), extra = b.filter((x) => !A.has(x));
    if (missing.length) out.push(`${label} missing: ${missing.join(', ')}`);
    if (extra.length) out.push(`${label} unexpected: ${extra.join(', ')}`);
  };
  setDiff('nodes', expected.nodes.map(nodeKey), actual.nodes.map(nodeKey));
  setDiff('edges', expected.edges.map(edgeKey), actual.edges.map(edgeKey));
  if (expected.truncated !== actual.truncated) out.push(`truncated: expected ${expected.truncated}, got ${actual.truncated}`);
  return out;
}
