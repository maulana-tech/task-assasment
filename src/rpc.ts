import { createPublicClient, http, type Hex, type Log } from 'viem';
import { sepolia } from 'viem/chains';
import { SEPOLIA_CHAIN_ID } from './config.ts';

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;

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

export async function withRetry<T>(fn: () => Promise<T>, attempts = 6, baseMs = 250): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (isRangeTooLarge(e)) throw e;
      const delay = Math.min(8000, baseMs * 2 ** i) + Math.random() * 100;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

export function isRangeTooLarge(e: unknown): boolean {
  const m = String((e as Error)?.message ?? e).toLowerCase();
  return (
    m.includes('more than') ||
    m.includes('too many') ||
    m.includes('range too large') ||
    m.includes('block range') ||
    m.includes('exceed') ||
    m.includes('limited to') ||
    m.includes('timeout')
  );
}

export function createChainReader(url: string): ChainReader {
  const client = createPublicClient({ chain: sepolia, transport: http(url, { retryCount: 0, timeout: 60_000, maxResponseBodySize: 64 * 1024 * 1024 }) });

  const reader: ChainReader = {
    blockNumber: () => withRetry(async () => Number(await client.getBlockNumber())),

    getBlock: (n) =>
      withRetry(async () => {
        const b = await client.getBlock({ blockNumber: BigInt(n), includeTransactions: true });
        return {
          number: Number(b.number),
          hash: b.hash,
          parentHash: b.parentHash,
          timestamp: Number(b.timestamp),
          transactions: b.transactions.map((t) => ({
            hash: t.hash,
            transactionIndex: t.transactionIndex,
            from: t.from,
            to: t.to,
            value: t.value,
          })),
        };
      }),

    getTransferLogs: (from, to) =>
      withRetry(async () => {
        const logs = await client.getLogs({
          fromBlock: BigInt(from),
          toBlock: BigInt(to),
          topics: [TRANSFER_TOPIC],
        } as any);
        return (logs as Log[]).map(toRpcLog);
      }),

    getCode: (address) => withRetry(() => client.getCode({ address: address as Hex }).then((c) => c ?? '0x')),
  };
  return reader;
}

function toRpcLog(l: Log): RpcLog {
  return {
    address: l.address,
    topics: l.topics as string[],
    data: l.data,
    blockNumber: Number(l.blockNumber),
    transactionHash: l.transactionHash!,
    transactionIndex: l.transactionIndex!,
    logIndex: l.logIndex!,
  };
}

export async function assertSepolia(url: string) {
  const client = createPublicClient({ transport: http(url) });
  const id = await client.getChainId();
  if (id !== SEPOLIA_CHAIN_ID) throw new Error(`RPC is chain ${id}, expected Sepolia (${SEPOLIA_CHAIN_ID})`);
}
