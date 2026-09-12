import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Transfer = {
  txHash: string;
  blockNumber: number;
  txIndex: number;
  logIndex: number;
  from: string;
  to: string;
  asset: string;
  amount: string;
};

export type BlockRow = { number: number; hash: string; parentHash: string; timestamp: number };

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS blocks (
  number      INTEGER PRIMARY KEY,
  hash        TEXT NOT NULL,
  parent_hash TEXT NOT NULL,
  timestamp   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS transfers (
  id           INTEGER PRIMARY KEY,
  tx_hash      TEXT    NOT NULL,
  block_number INTEGER NOT NULL REFERENCES blocks(number) ON DELETE CASCADE,
  tx_index     INTEGER NOT NULL,
  log_index    INTEGER NOT NULL,
  from_addr    TEXT    NOT NULL,
  to_addr      TEXT    NOT NULL,
  asset        TEXT    NOT NULL,
  amount       TEXT    NOT NULL,
  UNIQUE (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS ix_transfers_from ON transfers(from_addr, block_number);
CREATE INDEX IF NOT EXISTS ix_transfers_to   ON transfers(to_addr,   block_number);
CREATE INDEX IF NOT EXISTS ix_transfers_tx   ON transfers(tx_hash);

CREATE TABLE IF NOT EXISTS addresses (
  address     TEXT PRIMARY KEY,
  is_contract INTEGER,
  first_seen  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cursor (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  last_block INTEGER NOT NULL
);
`;

export class Db {
  readonly sql: DatabaseSync;

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.sql = new DatabaseSync(path);
    this.sql.exec(SCHEMA);
  }

  close() {
    this.sql.close();
  }

  getBlock(number: number): BlockRow | undefined {
    const r = this.sql
      .prepare('SELECT number, hash, parent_hash AS parentHash, timestamp FROM blocks WHERE number = ?')
      .get(number) as BlockRow | undefined;
    return r;
  }

  writeBlock(block: BlockRow, transfers: Transfer[]) {
    const insBlock = this.sql.prepare(
      'INSERT OR REPLACE INTO blocks (number, hash, parent_hash, timestamp) VALUES (?, ?, ?, ?)',
    );
    const delTx = this.sql.prepare('DELETE FROM transfers WHERE block_number = ?');
    const insTx = this.sql.prepare(
      `INSERT OR IGNORE INTO transfers
         (tx_hash, block_number, tx_index, log_index, from_addr, to_addr, asset, amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insAddr = this.sql.prepare(
      'INSERT OR IGNORE INTO addresses (address, is_contract, first_seen) VALUES (?, NULL, ?)',
    );
    const setCursor = this.sql.prepare(
      'INSERT INTO cursor (id, last_block) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET last_block = MAX(last_block, excluded.last_block)',
    );

    this.sql.exec('BEGIN');
    try {
      delTx.run(block.number);
      insBlock.run(block.number, block.hash, block.parentHash, block.timestamp);
      for (const t of transfers) {
        insTx.run(t.txHash, t.blockNumber, t.txIndex, t.logIndex, t.from, t.to, t.asset, t.amount);
        insAddr.run(t.from, t.blockNumber);
        insAddr.run(t.to, t.blockNumber);
      }
      setCursor.run(block.number);
      this.sql.exec('COMMIT');
    } catch (e) {
      this.sql.exec('ROLLBACK');
      throw e;
    }
  }

  rollbackFrom(n: number) {
    this.sql.exec('BEGIN');
    try {
      this.sql.prepare('DELETE FROM blocks WHERE number >= ?').run(n);
      this.sql.prepare('UPDATE cursor SET last_block = ? WHERE id = 1 AND last_block >= ?').run(n - 1, n);
      this.sql.exec('COMMIT');
    } catch (e) {
      this.sql.exec('ROLLBACK');
      throw e;
    }
  }

  getCursor(): number | undefined {
    const r = this.sql.prepare('SELECT last_block FROM cursor WHERE id = 1').get() as
      | { last_block: number }
      | undefined;
    return r?.last_block;
  }

  window(): [number, number] | undefined {
    const r = this.sql.prepare('SELECT MIN(number) AS lo, MAX(number) AS hi FROM blocks').get() as {
      lo: number | null;
      hi: number | null;
    };
    return r.lo == null || r.hi == null ? undefined : [r.lo, r.hi];
  }

  transfersByTx(txHash: string): Transfer[] {
    return this.sql
      .prepare(`${SELECT_TRANSFER} WHERE tx_hash = ? ORDER BY log_index`)
      .all(txHash) as Transfer[];
  }

  edgesFor(
    side: 'from' | 'to',
    addrs: string[],
    lo: number,
    hi: number,
    perAddrLimit: number,
  ): Transfer[] {
    if (addrs.length === 0) return [];
    const col = side === 'from' ? 'from_addr' : 'to_addr';
    const out: Transfer[] = [];
    const stmt = this.sql.prepare(
      `${SELECT_TRANSFER} WHERE ${col} = ? AND block_number BETWEEN ? AND ?
       ORDER BY block_number, tx_index, log_index LIMIT ?`,
    );
    for (const a of addrs) out.push(...(stmt.all(a, lo, hi, perAddrLimit + 1) as Transfer[]));
    return out;
  }

  isContract(address: string): boolean | null {
    const r = this.sql.prepare('SELECT is_contract FROM addresses WHERE address = ?').get(address) as
      | { is_contract: number | null }
      | undefined;
    return r?.is_contract == null ? null : r.is_contract === 1;
  }

  setIsContract(address: string, isContract: boolean, firstSeen = 0) {
    this.sql
      .prepare(
        `INSERT INTO addresses (address, is_contract, first_seen) VALUES (?, ?, ?)
         ON CONFLICT(address) DO UPDATE SET is_contract = excluded.is_contract`,
      )
      .run(address, isContract ? 1 : 0, firstSeen);
  }

  counts() {
    const one = (q: string) => (this.sql.prepare(q).get() as { n: number }).n;
    return {
      blocks: one('SELECT COUNT(*) AS n FROM blocks'),
      transfers: one('SELECT COUNT(*) AS n FROM transfers'),
      addresses: one('SELECT COUNT(*) AS n FROM addresses'),
    };
  }
}

const SELECT_TRANSFER = `
  SELECT tx_hash AS txHash, block_number AS blockNumber, tx_index AS txIndex, log_index AS logIndex,
         from_addr AS "from", to_addr AS "to", asset, amount
  FROM transfers`;
