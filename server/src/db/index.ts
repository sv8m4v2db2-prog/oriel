import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { MIGRATIONS } from './migrations.js';
import { FEATURE_MIGRATIONS } from './features/index.js';

export type Param = string | number | bigint | boolean | null | undefined | Uint8Array;

function toSql(p: Param): SQLInputValue {
  if (p === undefined) return null;
  if (typeof p === 'boolean') return p ? 1 : 0;
  return p;
}

/**
 * Thin synchronous wrapper around node:sqlite with a statement cache, IMMEDIATE transactions
 * (re-entrant) and post-commit callbacks (used to publish real-time changes only once data is durable).
 */
export class Db {
  readonly raw: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private depth = 0;
  private afterCommitQueue: Array<() => void> = [];
  private closed = false;

  constructor(file: string) {
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA synchronous = NORMAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
  }

  private stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  get<T>(sql: string, ...params: Param[]): T | undefined {
    return this.stmt(sql).get(...params.map(toSql)) as T | undefined;
  }

  all<T>(sql: string, ...params: Param[]): T[] {
    return this.stmt(sql).all(...params.map(toSql)) as T[];
  }

  run(sql: string, ...params: Param[]): number {
    return Number(this.stmt(sql).run(...params.map(toSql)).changes);
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  get inTransaction(): boolean {
    return this.depth > 0;
  }

  /** Runs `fn` inside BEGIN IMMEDIATE … COMMIT (re-entrant). `fn` must be synchronous. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++;
      try {
        return fn();
      } finally {
        this.depth--;
      }
    }
    this.raw.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    let result: T;
    try {
      result = fn();
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        throw new Error('Db.tx callback must be synchronous');
      }
      this.raw.exec('COMMIT');
    } catch (err) {
      this.depth = 0;
      this.afterCommitQueue = [];
      try {
        this.raw.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw err;
    }
    this.depth = 0;
    const queue = this.afterCommitQueue;
    this.afterCommitQueue = [];
    for (const cb of queue) {
      try {
        cb();
      } catch (err) {
        console.error('[db] afterCommit callback failed', err);
      }
    }
    return result;
  }

  /** Runs `cb` once the current transaction commits (immediately when not in a transaction). */
  afterCommit(cb: () => void): void {
    if (this.depth > 0) this.afterCommitQueue.push(cb);
    else cb();
  }

  migrate(): void {
    this.raw.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    // Every step re-reads its state inside its own write transaction: another process opening the
    // same database at the same time may have applied it in the meantime (QA-INT-02).
    for (let done = false; !done; ) {
      done = this.tx(() => {
        const row = this.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'");
        const version = row ? Number(row.value) : 0;
        if (!(version < MIGRATIONS.length)) return true;
        this.raw.exec(MIGRATIONS[version]!);
        this.run(
          "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          String(version + 1),
        );
        return false;
      });
    }
    this.raw.exec('CREATE TABLE IF NOT EXISTS applied_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    const ids = new Set<string>();
    const applied = (id: string) => !!this.get('SELECT 1 AS x FROM applied_migrations WHERE id = ?', id);
    for (const m of FEATURE_MIGRATIONS) {
      if (ids.has(m.id)) throw new Error(`Duplicate feature migration id: ${m.id}`);
      ids.add(m.id);
      if (applied(m.id)) continue;
      this.tx(() => {
        if (applied(m.id)) return;
        this.raw.exec(m.sql);
        this.run('INSERT INTO applied_migrations (id, applied_at) VALUES (?, ?)', m.id, Date.now());
      });
    }
  }

  getMeta(key: string): string | null {
    return this.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    try {
      this.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* ignore */
    }
    this.raw.close();
  }
}

export function openDatabase(file: string): Db {
  const db = new Db(file);
  db.migrate();
  return db;
}
