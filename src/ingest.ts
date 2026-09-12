import type { Db, Transfer } from './db.ts';
import { isRangeTooLarge, type ChainReader, type RpcBlock, type RpcLog } from './rpc.ts';

export type IngestOptions = {
  logChunk?: number;
  concurrency?: number;
  log?: (msg: string) => void;
};

export type IngestStats = { blocks: number; transfers: number; reorgs: number; logChunk: number };

const MIN_CHUNK = 10;
const MAX_CHUNK = 2000;

export async function ingestRange(
  db: Db,
  rpc: ChainReader,
  from: number,
  to: number,
  opts: IngestOptions = {},
): Promise<IngestStats> {
  const log = opts.log ?? (() => {});
  const concurrency = opts.concurrency ?? 8;
  let chunk = clamp(opts.logChunk ?? 200, MIN_CHUNK, MAX_CHUNK);
  let ceiling = MAX_CHUNK;
  const stats: IngestStats = { blocks: 0, transfers: 0, reorgs: 0, logChunk: chunk };

  let n = from;
  while (n <= to) {
    const end = Math.min(n + chunk - 1, to);

    let logs: RpcLog[];
    try {
      logs = await rpc.getTransferLogs(n, end);
    } catch (e) {
      if (!isRangeTooLarge(e) || chunk === MIN_CHUNK) throw e;
      chunk = Math.max(MIN_CHUNK, Math.floor(chunk / 2));
      ceiling = chunk;
      log(`getLogs span too large (${String((e as Error).message).split('\n')[0].slice(0, 120)}), halving to ${chunk}`);
      continue;
    }
    const logsByBlock = groupBy(logs, (l) => l.blockNumber);

    const blocks = await mapLimit(range(n, end), concurrency, (b) => rpc.getBlock(b));

    let reorgAt: number | undefined;
    for (const block of blocks) {
      const prev = db.getBlock(block.number - 1);
      if (prev && prev.hash !== block.parentHash) {
        reorgAt = await findCommonAncestor(db, rpc, block.number - 1);
        break;
      }
      const transfers = extractTransfers(block, logsByBlock.get(block.number) ?? []);
      db.writeBlock(
        { number: block.number, hash: block.hash, parentHash: block.parentHash, timestamp: block.timestamp },
        transfers,
      );
      stats.blocks++;
      stats.transfers += transfers.length;
    }

    if (reorgAt !== undefined) {
      stats.reorgs++;
      log(`reorg detected, rolling back to block ${reorgAt}`);
      db.rollbackFrom(reorgAt + 1);
      n = reorgAt + 1;
      continue;
    }

    log(`ingested ${n}..${end} (${stats.transfers} transfers so far)`);
    n = end + 1;
    chunk = Math.min(ceiling, chunk * 2);
    stats.logChunk = chunk;
  }
  return stats;
}

async function findCommonAncestor(db: Db, rpc: ChainReader, n: number): Promise<number> {
  for (let k = n; ; k--) {
    const stored = db.getBlock(k);
    if (!stored) return k;
    const live = await rpc.getBlock(k);
    if (live.hash === stored.hash) return k;
  }
}

export async function verifyTail(db: Db, rpc: ChainReader, depth: number): Promise<number | undefined> {
  const w = db.window();
  if (!w) return undefined;
  const [lo, hi] = w;
  for (let k = hi; k >= Math.max(lo, hi - depth + 1); k--) {
    const stored = db.getBlock(k)!;
    const live = await rpc.getBlock(k);
    if (live.hash !== stored.hash) {
      const anc = await findCommonAncestor(db, rpc, k - 1);
      db.rollbackFrom(anc + 1);
      return anc + 1;
    }
  }
  return undefined;
}

export async function follow(
  db: Db,
  rpc: ChainReader,
  opts: IngestOptions & { confirmations: number; pollMs?: number; signal?: AbortSignal; startBlock?: number },
) {
  const log = opts.log ?? (() => {});
  while (!opts.signal?.aborted) {
    const head = (await rpc.blockNumber()) - opts.confirmations;
    const rolledBackTo = await verifyTail(db, rpc, 12);
    const cursor = rolledBackTo !== undefined ? rolledBackTo - 1 : db.getCursor();
    const from = cursor !== undefined ? cursor + 1 : (opts.startBlock ?? head);
    if (from <= head) {
      const s = await ingestRange(db, rpc, from, head, opts);
      log(`follow: ${from}..${head} +${s.transfers} transfers`);
    }
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 6000));
  }
}

export function extractTransfers(block: RpcBlock, logs: RpcLog[]): Transfer[] {
  const out: Transfer[] = [];
  for (const tx of block.transactions) {
    if (tx.value > 0n && tx.to) {
      out.push({
        txHash: tx.hash,
        blockNumber: block.number,
        txIndex: tx.transactionIndex,
        logIndex: -1,
        from: tx.from.toLowerCase(),
        to: tx.to.toLowerCase(),
        asset: 'ETH',
        amount: tx.value.toString(),
      });
    }
  }
  for (const l of logs) {
    if (l.topics.length !== 3 || l.data.length !== 66) continue;
    out.push({
      txHash: l.transactionHash,
      blockNumber: l.blockNumber,
      txIndex: l.transactionIndex,
      logIndex: l.logIndex,
      from: topicToAddress(l.topics[1]),
      to: topicToAddress(l.topics[2]),
      asset: l.address.toLowerCase(),
      amount: BigInt(l.data).toString(),
    });
  }
  return out;
}

const topicToAddress = (t: string) => ('0x' + t.slice(-40)).toLowerCase();
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

function groupBy<T, K>(xs: T[], key: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of xs) {
    const k = key(x);
    const arr = m.get(k);
    if (arr) arr.push(x);
    else m.set(k, [x]);
  }
  return m;
}

async function mapLimit<T, R>(xs: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, xs.length) }, async () => {
      while (i < xs.length) {
        const idx = i++;
        out[idx] = await fn(xs[idx]);
      }
    }),
  );
  return out;
}
