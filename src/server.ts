import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Db } from './db.ts';
import { config } from './config.ts';
import { createChainReader, type ChainReader } from './rpc.ts';
import { hops, traceAddress, traceTx, type Direction, type TraceOptions, type TraceResult } from './trace.ts';

const HASH = /^0x[0-9a-f]{64}$/i;
const ADDR = /^0x[0-9a-f]{40}$/i;
const LIMITS = { depth: 10, maxNodes: 5000, maxEdgesPerNode: 1000, maxDepth: 12 };

class HttpError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
  }
}

export function createApp(db: Db, rpc?: ChainReader) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const started = Date.now();
    try {
      const body = await route(db, rpc, url);
      send(res, 200, body);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      send(res, status, { error: (e as Error).message });
    }
    console.log(`${req.method} ${url.pathname}${url.search} ${res.statusCode} ${Date.now() - started}ms`);
  });
}

async function route(db: Db, rpc: ChainReader | undefined, url: URL): Promise<unknown> {
  const p = url.pathname.split('/').filter(Boolean);
  const q = url.searchParams;

  if (p[0] === 'health' && p.length === 1) {
    const cursor = db.getCursor();
    const head = rpc ? await rpc.blockNumber().catch(() => null) : null;
    return { ok: true, chainId: 11155111, window: db.window() ?? null, cursor, head, lag: head && cursor ? head - cursor : null, ...db.counts() };
  }

  if (p[0] === 'trace' && p[1] === 'tx' && p.length === 3) {
    const hash = p[2];
    if (!HASH.test(hash)) throw new HttpError(400, 'invalid tx hash');
    const r = traceTx(db, hash, traceOpts(q));
    if (!r) throw new HttpError(404, `tx ${hash} has no value transfers in ingested window ${JSON.stringify(db.window())}`);
    await classify(db, rpc, r);
    return r;
  }

  if (p[0] === 'trace' && p[1] === 'address' && p.length === 3) {
    const addr = p[2];
    if (!ADDR.test(addr)) throw new HttpError(400, 'invalid address');
    const r = traceAddress(db, addr, traceOpts(q));
    await classify(db, rpc, r);
    return r;
  }

  if (p[0] === 'hops' && p.length === 1) {
    const from = q.get('from') ?? '';
    const to = q.get('to') ?? '';
    if (!ADDR.test(from) || !ADDR.test(to)) throw new HttpError(400, 'from and to must be addresses');
    return hops(db, from, to, {
      ...traceOpts(q),
      maxDepth: int(q, 'maxDepth', 6, LIMITS.maxDepth),
      undirected: q.get('undirected') === 'true',
    });
  }

  throw new HttpError(404, 'not found. routes: /health, /trace/tx/:hash, /trace/address/:addr, /hops?from=&to=');
}

function traceOpts(q: URLSearchParams): TraceOptions {
  const direction = q.get('direction') ?? 'both';
  if (!['down', 'up', 'both'].includes(direction)) throw new HttpError(400, 'direction must be down|up|both');
  return {
    depth: int(q, 'depth', 3, LIMITS.depth),
    direction: direction as Direction,
    maxNodes: int(q, 'maxNodes', 500, LIMITS.maxNodes),
    maxEdgesPerNode: int(q, 'maxEdgesPerNode', 200, LIMITS.maxEdgesPerNode),
    fromBlock: q.has('fromBlock') ? int(q, 'fromBlock', 0, Number.MAX_SAFE_INTEGER) : undefined,
    toBlock: q.has('toBlock') ? int(q, 'toBlock', 0, Number.MAX_SAFE_INTEGER) : undefined,
  };
}

function int(q: URLSearchParams, key: string, dflt: number, max: number): number {
  const raw = q.get(key);
  if (raw == null) return dflt;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 0) throw new HttpError(400, `${key} must be a non-negative integer`);
  return Math.min(v, max);
}

async function classify(db: Db, rpc: ChainReader | undefined, r: TraceResult, limit = 50) {
  if (!rpc) return;
  const unknown = r.nodes.filter((n) => n.isContract === null).slice(0, limit);
  await Promise.all(
    unknown.map(async (n) => {
      try {
        const code = await rpc.getCode(n.address);
        n.isContract = code !== '0x';
        db.setIsContract(n.address, n.isContract);
      } catch {
      }
    }),
  );
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = new Db(config.dbPath);
  const rpc = createChainReader(config.rpcUrl());
  createApp(db, rpc).listen(config.port, () => {
    console.log(`trace api on http://localhost:${config.port}  db=${config.dbPath} window=${JSON.stringify(db.window())}`);
  });
}

export type { IncomingMessage };
