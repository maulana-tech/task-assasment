import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/db.ts';
import { extractTransfers, ingestRange, verifyTail } from '../src/ingest.ts';
import { TRANSFER_TOPIC, type ChainReader, type RpcBlock, type RpcLog } from '../src/rpc.ts';

const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const TOKEN = '0x' + '9'.repeat(40);
const pad = (a: string) => '0x' + a.slice(2).padStart(64, '0');
const hash = (n: number, fork = '') => `0xblock${n}${fork}`;

class FakeChain implements ChainReader {
  calls = { getBlock: 0, getLogs: 0 };
  failLogsOnce = false;
  forkFrom = Infinity;
  fork = '';
  head = 100;

  private h(n: number) {
    return n >= this.forkFrom ? hash(n, this.fork) : hash(n);
  }
  async blockNumber() {
    return this.head;
  }
  async getBlock(n: number): Promise<RpcBlock> {
    this.calls.getBlock++;
    return {
      number: n,
      hash: this.h(n),
      parentHash: this.h(n - 1),
      timestamp: n,
      transactions: [{ hash: `0xtx${n}${n >= this.forkFrom ? this.fork : ''}`, transactionIndex: 0, from: A, to: B, value: 10n }],
    };
  }
  async getTransferLogs(from: number, to: number): Promise<RpcLog[]> {
    this.calls.getLogs++;
    if (this.failLogsOnce) {
      this.failLogsOnce = false;
      throw new Error('query returned more than 10000 results');
    }
    const out: RpcLog[] = [];
    for (let n = from; n <= to; n++) {
      out.push({
        address: TOKEN,
        topics: [TRANSFER_TOPIC, pad(B), pad(A)],
        data: pad('0x5'),
        blockNumber: n,
        transactionHash: `0xtx${n}${n >= this.forkFrom ? this.fork : ''}`,
        transactionIndex: 0,
        logIndex: 3,
      });
    }
    return out;
  }
  async getCode() {
    return '0x';
  }
}

test('extractTransfers: native ETH + ERC-20 in, ERC-721 and zero-value out', () => {
  const block: RpcBlock = {
    number: 1, hash: '0x1', parentHash: '0x0', timestamp: 0,
    transactions: [
      { hash: '0xt1', transactionIndex: 0, from: A, to: B, value: 7n },
      { hash: '0xt2', transactionIndex: 1, from: A, to: B, value: 0n },
      { hash: '0xt3', transactionIndex: 2, from: A, to: null, value: 1n },
    ],
  };
  const logs: RpcLog[] = [
    { address: TOKEN, topics: [TRANSFER_TOPIC, pad(A), pad(B)], data: pad('0xff'), blockNumber: 1, transactionHash: '0xt2', transactionIndex: 1, logIndex: 0 },
    { address: TOKEN, topics: [TRANSFER_TOPIC, pad(A), pad(B), pad('0x1')], data: '0x', blockNumber: 1, transactionHash: '0xt2', transactionIndex: 1, logIndex: 1 },
  ];
  const t = extractTransfers(block, logs);
  assert.deepEqual(
    t.map((x) => [x.txHash, x.logIndex, x.asset, x.amount]),
    [['0xt1', -1, 'ETH', '7'], ['0xt2', 0, TOKEN, '255']],
  );
});

test('duplicate ingestion is idempotent', async () => {
  const db = new Db();
  const rpc = new FakeChain();
  await ingestRange(db, rpc, 1, 20);
  const first = db.counts();
  assert.deepEqual(first, { blocks: 20, transfers: 40, addresses: 2 });

  await ingestRange(db, rpc, 1, 20);
  await ingestRange(db, rpc, 10, 15);
  assert.deepEqual(db.counts(), first);
  assert.equal(db.getCursor(), 20);
});

test('reorg: mismatched parent hash rolls back to the common ancestor and re-ingests', async () => {
  const db = new Db();
  const rpc = new FakeChain();
  await ingestRange(db, rpc, 1, 20);
  const staleTx = db.transfersByTx('0xtx17');
  assert.equal(staleTx.length, 2);

  rpc.forkFrom = 16;
  rpc.fork = 'x';
  const s = await ingestRange(db, rpc, 21, 25);

  assert.equal(s.reorgs, 1);
  assert.equal(db.getBlock(15)!.hash, hash(15), 'block 15 untouched');
  assert.equal(db.getBlock(16)!.hash, hash(16, 'x'), 'block 16 replaced');
  assert.equal(db.transfersByTx('0xtx17').length, 0, 'orphaned tx rows removed');
  assert.equal(db.transfersByTx('0xtx17x').length, 2, 'canonical tx rows present');
  assert.deepEqual(db.counts(), { blocks: 25, transfers: 50, addresses: 2 });
  assert.equal(db.getCursor(), 25);
});

test('verifyTail catches a reorg that happened after ingestion stopped', async () => {
  const db = new Db();
  const rpc = new FakeChain();
  await ingestRange(db, rpc, 1, 20);
  rpc.forkFrom = 19;
  rpc.fork = 'y';
  const rolledBackTo = await verifyTail(db, rpc, 12);
  assert.equal(rolledBackTo, 19);
  assert.equal(db.getCursor(), 18);
  assert.equal(db.window()![1], 18);
});

test('getLogs "too many results" halves the span and completes', async () => {
  const db = new Db();
  const rpc = new FakeChain();
  rpc.failLogsOnce = true;
  const s = await ingestRange(db, rpc, 1, 100, { logChunk: 100 });
  assert.equal(s.blocks, 100);
  assert.equal(rpc.calls.getLogs, 3, 'one failed call at span 100, then two of 50');
  assert.deepEqual(db.counts(), { blocks: 100, transfers: 200, addresses: 2 });
});

test('a transient RPC failure mid-range leaves a resumable cursor', async () => {
  const db = new Db();
  const rpc = new FakeChain();
  const flaky: ChainReader = {
    ...rpc,
    blockNumber: () => rpc.blockNumber(),
    getTransferLogs: (f, t) => rpc.getTransferLogs(f, t),
    getCode: () => rpc.getCode(),
    getBlock: async (n) => {
      if (n === 30) throw new Error('ECONNRESET');
      return rpc.getBlock(n);
    },
  };
  await assert.rejects(ingestRange(db, flaky, 1, 50, { logChunk: 10 }));
  const cursor = db.getCursor()!;
  assert.ok(cursor >= 10 && cursor < 30, `cursor ${cursor} sits at the last committed chunk`);
  await ingestRange(db, rpc, cursor + 1, 50, { logChunk: 10 });
  assert.deepEqual(db.counts(), { blocks: 50, transfers: 100, addresses: 2 });
});
