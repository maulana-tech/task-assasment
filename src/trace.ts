import type { Db, Transfer } from './db.ts';

export type Direction = 'down' | 'up' | 'both';

export type TraceOptions = {
  depth?: number;
  direction?: Direction;
  maxNodes?: number;
  maxEdgesPerNode?: number;
  fromBlock?: number;
  toBlock?: number;
};

export type TraceNode = { address: string; hop: number; isContract: boolean | null };
export type TraceEdge = Transfer & { hop: number; direction: 'down' | 'up' };
export type TraceResult = {
  seed: { type: 'tx' | 'address'; value: string };
  window: [number, number];
  nodes: TraceNode[];
  edges: TraceEdge[];
  truncated: boolean;
  truncatedAt: string[];
};

type Pos = { block: number; txIndex: number; logIndex: number };

const DEFAULTS = { depth: 3, direction: 'both' as Direction, maxNodes: 500, maxEdgesPerNode: 200 };

export function traceTx(db: Db, txHash: string, opts: TraceOptions = {}): TraceResult | undefined {
  const seedEdges = db.transfersByTx(txHash.toLowerCase());
  if (seedEdges.length === 0) return undefined;
  const o = resolve(db, opts);
  const seedPos: Pos = { block: seedEdges[0].blockNumber, txIndex: seedEdges[0].txIndex, logIndex: -1 };

  const res = emptyResult({ type: 'tx', value: txHash.toLowerCase() }, o.window);
  const visited: Visited = new Map();

  for (const e of seedEdges) {
    res.edges.push({ ...e, hop: 0, direction: 'down' });
    visited.set(e.from, { hop: 0, pos: seedPos });
    visited.set(e.to, { hop: 0, pos: seedPos });
  }

  if (o.direction !== 'up') bfs(db, res, visited, seedEdges.map((e) => e.to), 'down', o);
  if (o.direction !== 'down') bfs(db, res, visited, seedEdges.map((e) => e.from), 'up', o);

  finish(db, res, visited);
  return res;
}

export function traceAddress(db: Db, address: string, opts: TraceOptions = {}): TraceResult {
  const o = resolve(db, opts);
  const addr = address.toLowerCase();
  const res = emptyResult({ type: 'address', value: addr }, o.window);
  const visited: Visited = new Map([[addr, { hop: 0 }]]);

  if (o.direction !== 'up') bfs(db, res, visited, [addr], 'down', o);
  if (o.direction !== 'down') bfs(db, res, visited, [addr], 'up', o);

  finish(db, res, visited);
  return res;
}

export type HopsResult = {
  from: string;
  to: string;
  window: [number, number];
  hops: number | null;
  path: string[];
  edges: Transfer[];
  truncated: boolean;
};

export function hops(
  db: Db,
  from: string,
  to: string,
  opts: TraceOptions & { maxDepth?: number; undirected?: boolean } = {},
): HopsResult {
  const o = resolve(db, opts);
  const src = from.toLowerCase();
  const dst = to.toLowerCase();
  const maxDepth = opts.maxDepth ?? 6;
  const base = { from: src, to: dst, window: o.window };
  if (src === dst) return { ...base, hops: 0, path: [src], edges: [], truncated: false };

  const parent = new Map<string, { prev: string; edge: Transfer; pos?: Pos } | null>([[src, null]]);
  let frontier = [src];
  let truncated = false;

  for (let hop = 1; hop <= maxDepth && frontier.length > 0; hop++) {
    const next = new Set<string>();
    const sides: ('from' | 'to')[] = opts.undirected ? ['from', 'to'] : ['from'];
    for (const a of frontier) {
      const since = parent.get(a)?.pos;
      for (const side of sides) {
        let edges = db.edgesFor(side, [a], o.window[0], o.window[1], o.maxEdgesPerNode);
        if (since) edges = edges.filter((e) => after(e, since));
        if (edges.length > o.maxEdgesPerNode) truncated = true;
        for (const e of edges.slice(0, o.maxEdgesPerNode)) {
          const b = side === 'from' ? e.to : e.from;
          if (parent.has(b)) {
            const existing = parent.get(b);
            if (!(next.has(b) && existing?.pos && cmp(e, existing.pos) < 0)) continue;
          }
          parent.set(b, { prev: a, edge: e, pos: opts.undirected ? undefined : posOf(e) });
          if (b === dst) return { ...base, ...unwind(parent, dst), truncated };
          next.add(b);
        }
      }
      if (parent.size >= o.maxNodes) {
        truncated = true;
        break;
      }
    }
    frontier = [...next];
    if (truncated && parent.size >= o.maxNodes) break;
  }
  return { ...base, hops: null, path: [], edges: [], truncated };
}

type Visited = Map<string, { hop: number; pos?: Pos }>;

function bfs(
  db: Db,
  res: TraceResult,
  visited: Visited,
  start: string[],
  dir: 'down' | 'up',
  o: Required<Omit<TraceOptions, 'fromBlock' | 'toBlock'>> & { window: [number, number] },
) {
  const side = dir === 'down' ? 'from' : 'to';
  let frontier = uniq(start);

  for (let hop = 1; hop <= o.depth && frontier.length > 0; hop++) {
    const next = new Set<string>();
    for (const addr of frontier) {
      const since = visited.get(addr)?.pos;
      let edges = db.edgesFor(side, [addr], o.window[0], o.window[1], o.maxEdgesPerNode);
      if (since) edges = edges.filter((e) => (dir === 'down' ? after(e, since) : before(e, since)));
      if (edges.length > o.maxEdgesPerNode) {
        edges = edges.slice(0, o.maxEdgesPerNode);
        res.truncated = true;
        res.truncatedAt.push(addr);
      }
      for (const e of edges) {
        res.edges.push({ ...e, hop, direction: dir });
        const other = dir === 'down' ? e.to : e.from;
        const seen = visited.get(other);
        if (!seen) {
          visited.set(other, { hop, pos: posOf(e) });
          next.add(other);
        } else if (next.has(other) && seen.pos && (dir === 'down' ? cmp(e, seen.pos) < 0 : cmp(e, seen.pos) > 0)) {
          seen.pos = posOf(e);
        }
      }
      if (visited.size >= o.maxNodes) {
        res.truncated = true;
        if (!res.truncatedAt.includes(addr)) res.truncatedAt.push(addr);
        return;
      }
    }
    frontier = [...next];
  }
}

const posOf = (e: Transfer): Pos => ({ block: e.blockNumber, txIndex: e.txIndex, logIndex: e.logIndex });
const cmp = (e: Transfer, p: Pos) =>
  e.blockNumber - p.block || e.txIndex - p.txIndex || e.logIndex - p.logIndex;
const after = (e: Transfer, p: Pos) => cmp(e, p) > 0;
const before = (e: Transfer, p: Pos) => cmp(e, p) < 0;

function resolve(db: Db, opts: TraceOptions) {
  const w = db.window() ?? [0, 0];
  return {
    depth: opts.depth ?? DEFAULTS.depth,
    direction: opts.direction ?? DEFAULTS.direction,
    maxNodes: opts.maxNodes ?? DEFAULTS.maxNodes,
    maxEdgesPerNode: opts.maxEdgesPerNode ?? DEFAULTS.maxEdgesPerNode,
    window: [opts.fromBlock ?? w[0], opts.toBlock ?? w[1]] as [number, number],
  };
}

function emptyResult(seed: TraceResult['seed'], window: [number, number]): TraceResult {
  return { seed, window, nodes: [], edges: [], truncated: false, truncatedAt: [] };
}

function finish(db: Db, res: TraceResult, visited: Visited) {
  res.nodes = [...visited].map(([address, { hop }]) => ({ address, hop, isContract: db.isContract(address) }));
  res.nodes.sort((a, b) => a.hop - b.hop || a.address.localeCompare(b.address));
  const seen = new Set<string>();
  res.edges = res.edges.filter((e) => {
    const k = `${e.txHash}:${e.logIndex}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function unwind(parent: Map<string, { prev: string; edge: Transfer } | null>, dst: string) {
  const path = [dst];
  const edges: Transfer[] = [];
  for (let cur = dst; ; ) {
    const p = parent.get(cur)!;
    if (!p) break;
    edges.unshift(p.edge);
    path.unshift(p.prev);
    cur = p.prev;
  }
  return { hops: edges.length, path, edges };
}

const uniq = <T>(xs: T[]) => [...new Set(xs)];
