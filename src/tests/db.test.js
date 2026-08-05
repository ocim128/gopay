// Tests for the SQLite connection (db.js) and schema migrations (migrations.js).
//
// These cover: WAL on disk, in-memory open, idempotent migrations, that every
// designed table/index exists, and that the partial unique index actually
// enforces amount uniqueness among pending payments while allowing reuse once a
// payment leaves the pending state.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, IN_MEMORY_PATH } from '../dal/sqlite/db.js';
import { runMigrations, SCHEMA_SQL } from '../dal/sqlite/migrations.js';

/** @returns {string[]} the names of all user tables in the database. */
function tableNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
}

/** @returns {string[]} the names of all indexes (explicit + implied) in the db. */
function indexNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='index'")
    .all()
    .map((r) => r.name);
}

describe('openDatabase', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'panel-db-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens an on-disk database in WAL mode and runs migrations', () => {
    const db = openDatabase({ dbPath: join(dir, 'panel.db') });
    try {
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(tableNames(db)).toContain('payments');
    } finally {
      db.close();
    }
  });

  it('opens an in-memory database when given :memory:', () => {
    const db = openDatabase({ dbPath: IN_MEMORY_PATH });
    try {
      expect(tableNames(db)).toEqual(
        expect.arrayContaining([
          'admin_users',
          'api_keys',
          'config',
          'payments',
          'settled_tx',
          'webhook_delivery_logs',
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('persists data across reopen (WAL durability)', () => {
    const path = join(dir, 'panel.db');
    const first = openDatabase({ dbPath: path });
    first
      .prepare('INSERT INTO config (key, value) VALUES (?, ?)')
      .run('poll_interval', '3000');
    first.close();

    const second = openDatabase({ dbPath: path });
    try {
      const row = second.prepare('SELECT value FROM config WHERE key = ?').get('poll_interval');
      expect(row.value).toBe('3000');
    } finally {
      second.close();
    }
  });
});

describe('runMigrations', () => {
  let db;

  beforeEach(() => {
    db = new Database(IN_MEMORY_PATH);
  });

  afterEach(() => {
    db.close();
  });

  it('creates all designed tables and indexes', () => {
    runMigrations(db);

    expect(tableNames(db)).toEqual(
      expect.arrayContaining([
        'payments',
        'settled_tx',
        'api_keys',
        'webhook_delivery_logs',
        'admin_users',
        'config',
      ]),
    );
    expect(indexNames(db)).toEqual(
      expect.arrayContaining(['uniq_pending_amount', 'idx_active_expires']),
    );
  });

  it('is idempotent when run multiple times', () => {
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    expect(() => db.exec(SCHEMA_SQL)).not.toThrow();
  });

  it('enforces amount uniqueness only among pending payments', () => {
    runMigrations(db);
    const insert = db.prepare(
      `INSERT INTO payments (id, amount, status, qris_string, created_at, expires_at, timeout)
       VALUES (?, ?, ?, 'q', 0, 1, 1)`,
    );

    insert.run('p1', 1000, 'pending');
    // A second pending row with the same amount must violate the partial index.
    expect(() => insert.run('p2', 1000, 'pending')).toThrow();

    // Once the first leaves 'pending', the amount becomes reusable.
    db.prepare("UPDATE payments SET status = 'paid' WHERE id = ?").run('p1');
    expect(() => insert.run('p3', 1000, 'pending')).not.toThrow();
  });

  it('enforces txId idempotency via settled_tx primary key', () => {
    runMigrations(db);
    const insert = db.prepare(
      'INSERT INTO settled_tx (tx_id, payment_id, settled_at) VALUES (?, ?, ?)',
    );
    insert.run('tx-1', 'p1', 0);
    expect(() => insert.run('tx-1', 'p2', 1)).toThrow();
  });
});
