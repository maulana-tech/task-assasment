import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db, type Transfer } from '../src/db.ts';
import { hops, traceAddress, traceTx } from '../src/trace.ts';

const A = addr('a'), B = addr('b'), C = addr('c'), D = addr('d'), E = addr('e'), F = addr('f'), HUB = addr('1');
function addr(c: string) {
  return '0x' + c.repeat(40);
}
function tx(n: number) {
  return '0x' + n.toString(16).padStart(64, '0');
}

function graph(edges: [number, number, string, string, string?][]): Db {
  const db = new Db();
  const byBlock = new Map<number, Transfer[]>();
  edges.forEach(([block, txIndex, from, to, asset = 'ETH'], i) => {
    const t: Transfer = { txHash: tx(i + 1), blockNumber: block, txIndex, logIndex: -1, from, to, asset, amount: '1' };
    (byBlock.get(block) ?? byBlock.set(block, []).get(block)!).push(t);
  });
  for (let b = Math.min(...byBlock.keys()); b <= Math.max(...byBlock.keys()); b++) {
    db.writeBlock({ number: b, hash: `0xh${b}`, parentHash: `0xh${b - 1}`, timestamp: b }, byBlock.get(b) ?? []);
  }
  return db;
}

const chain = () =>
  graph([
    [5, 0, F, B],
    [10, 0, A, B],
    [11, 0, B, C],
    [12, 0, C, D],
    [13, 0, D, E],
  ]);

test('traceTx downstream follows the chain up to depth', () => {
  const db = chain();
  const r = traceTx(db, tx(2), { depth: 3, direction: 'down' })!;
  assert.deepEqual(
    r.nodes.map((n) => [n.address, n.hop]),
    [[A, 0], [B, 0], [C, 1], [D, 2], [E, 3]],
  );
  assert.equal(r.edges.length, 4);
  assert.equal(r.truncated, false);
});

test('depth limits the walk', () => {
  const r = traceTx(chain(), tx(2), { depth: 1, direction: 'down' })!;
  assert.deepEqual(r.nodes.map((n) => n.address), [A, B, C]);
});

test('temporal filter: transfers before the seed are not downstream, transfers after are not upstream', () => {
  const db = chain();
  const down = traceTx(db, tx(3), { depth: 3, direction: 'down' })!;
  assert.ok(!down.edges.some((e) => e.from === F), 'F->B (blk 5) must not appear downstream of B->C');
  assert.ok(!down.edges.some((e) => e.from === A), 'A->B (blk 10) must not appear downstream');

  const up = traceTx(db, tx(3), { depth: 3, direction: 'up' })!;
  assert.deepEqual(up.edges.filter((e) => e.hop > 0).map((e) => e.from).sort(), [A, F]);
  assert.ok(!up.edges.some((e) => e.to === D), 'C->D (blk 12) must not appear upstream');
});

test('same block ordering uses txIndex', () => {
  const db = graph([
    [20, 0, A, B],
    [20, 1, B, C],
  ]);
  const r = traceTx(db, tx(1), { direction: 'down' })!;
  assert.deepEqual(r.nodes.map((n) => n.address), [A, B, C]);
  const u = traceTx(db, tx(2), { direction: 'up' })!;
  assert.ok(u.edges.some((e) => e.from === A && e.hop === 1));
});

test('cycles terminate and each address is reported at its shortest hop', () => {
  const db = graph([
    [10, 0, A, B],
    [11, 0, B, C],
    [12, 0, C, A],
    [13, 0, A, B],
  ]);
  const r = traceTx(db, tx(1), { depth: 10, direction: 'down' })!;
  assert.equal(r.nodes.find((n) => n.address === A)!.hop, 0);
  assert.equal(r.nodes.length, 3);
  assert.equal(r.truncated, false);
});

test('fan-out cap marks the result truncated and names the address', () => {
  const edges: [number, number, string, string][] = [[10, 0, A, HUB]];
  for (let i = 0; i < 30; i++) edges.push([11, i, HUB, '0x' + i.toString(16).padStart(40, '0')]);
  const db = graph(edges);
  const r = traceTx(db, tx(1), { direction: 'down', maxEdgesPerNode: 5 })!;
  assert.equal(r.truncated, true);
  assert.deepEqual(r.truncatedAt, [HUB]);
  assert.equal(r.edges.filter((e) => e.hop === 1).length, 5);

  const full = traceTx(db, tx(1), { direction: 'down', maxEdgesPerNode: 100 })!;
  assert.equal(full.truncated, false);
  assert.equal(full.edges.length, 31);
});

test('maxNodes stops expansion', () => {
  const r = traceTx(chain(), tx(2), { depth: 5, direction: 'down', maxNodes: 3 })!;
  assert.equal(r.truncated, true);
  assert.ok(r.nodes.length <= 3);
});

test('window restricts which edges are visible', () => {
  const r = traceTx(chain(), tx(2), { depth: 5, direction: 'down', toBlock: 11 })!;
  assert.deepEqual(r.nodes.map((n) => n.address), [A, B, C]);
});

test('unknown tx returns undefined', () => {
  assert.equal(traceTx(chain(), tx(999)), undefined);
});

test('traceAddress walks both directions from the address with no temporal seed', () => {
  const r = traceAddress(chain(), B, { depth: 2 });
  const hop = Object.fromEntries(r.nodes.map((n) => [n.address, n.hop]));
  assert.deepEqual(hop, { [B]: 0, [C]: 1, [A]: 1, [F]: 1, [D]: 2 });
  assert.equal(r.edges.length, 4);
});

test('ERC-20 and ETH edges are both traversed, asset preserved', () => {
  const token = addr('9');
  const db = graph([
    [10, 0, A, B, 'ETH'],
    [11, 0, B, C, token],
  ]);
  const r = traceTx(db, tx(1), { direction: 'down' })!;
  assert.deepEqual(r.edges.map((e) => e.asset), ['ETH', token]);
});

test('hops: shortest directed path, with path and edges', () => {
  const db = graph([
    [10, 0, A, B],
    [11, 0, B, C],
    [12, 0, C, D],
    [10, 1, A, D],
  ]);
  const r = hops(db, A, D);
  assert.equal(r.hops, 1);
  assert.deepEqual(r.path, [A, D]);
  assert.equal(r.edges.length, 1);

  const r2 = hops(db, A, C);
  assert.equal(r2.hops, 2);
  assert.deepEqual(r2.path, [A, B, C]);
});

test('hops: direction matters unless undirected', () => {
  const db = chain();
  assert.equal(hops(db, E, A).hops, null);
  assert.equal(hops(db, E, A, { undirected: true }).hops, 4);
  assert.equal(hops(db, A, A).hops, 0);
});

test('hops: maxDepth bounds the search', () => {
  const r = hops(chain(), A, E, { maxDepth: 2 });
  assert.equal(r.hops, null);
  assert.equal(hops(chain(), A, E, { maxDepth: 4 }).hops, 4);
});

test('temporal rule is per hop, not just relative to the seed', () => {
  const db = graph([
    [10, 0, A, B],
    [15, 0, C, D],
    [20, 0, B, C],
    [25, 0, C, E],
  ]);
  const r = traceTx(db, tx(1), { depth: 3, direction: 'down' })!;
  assert.deepEqual(r.nodes.map((n) => n.address), [A, B, C, E]);
  assert.ok(!r.edges.some((e) => e.to === D), 'C->D predates the funds reaching C');

  assert.equal(hops(db, A, D).hops, null);
  assert.equal(hops(db, A, E).hops, 3);
  assert.equal(hops(db, A, D, { undirected: true }).hops, 3);
});

test('a node reached twice at the same hop keeps the earliest arrival downstream', () => {
  const X = addr('0');
  const db = new Db();
  const seed = tx(1);
  db.writeBlock({ number: 5, hash: '0xh5', parentHash: '0xh4', timestamp: 5 }, [
    { txHash: seed, blockNumber: 5, txIndex: 0, logIndex: -1, from: X, to: A, asset: 'ETH', amount: '1' },
    { txHash: seed, blockNumber: 5, txIndex: 0, logIndex: 0, from: X, to: B, asset: addr('9'), amount: '1' },
  ]);
  const one = (n: number, block: number, from: string, to: string) =>
    db.writeBlock({ number: block, hash: `0xh${block}`, parentHash: `0xh${block - 1}`, timestamp: block }, [
      { txHash: tx(n), blockNumber: block, txIndex: 0, logIndex: -1, from, to, asset: 'ETH', amount: '1' },
    ]);
  one(2, 10, B, C);
  one(3, 11, C, D);
  one(4, 12, A, C);

  const r = traceTx(db, seed, { depth: 3, direction: 'down' })!;
  assert.ok(r.nodes.some((n) => n.address === D), 'D reachable through the earlier arrival at C');
  assert.equal(r.nodes.find((n) => n.address === C)!.hop, 1);
});
