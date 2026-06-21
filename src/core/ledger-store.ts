import { mkdirSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { LedgerOptions, Row } from "./ledger-codec.js";
import { now } from "./ledger-codec.js";
import { migrateSchema } from "./migrations.js";
import { DEFAULT_BOOK_ID, DDL, SCHEMA_VERSION } from "./schema.js";

export class LedgerStore {
  readonly path: string;
  readonly bookId: string;
  readonly db: DatabaseSync;
  private transactionDepth = 0;

  constructor(path: string, options: LedgerOptions = {}) {
    let dbPath = path;
    if (path.endsWith(sep)) dbPath = join(path, "clovis.db");
    try {
      if (statSync(dbPath).isDirectory()) dbPath = join(dbPath, "clovis.db");
    } catch {
      // path does not exist yet
    }
    mkdirSync(dirname(dbPath), { recursive: true });
    this.path = dbPath;
    this.bookId = options.bookId || DEFAULT_BOOK_ID;
    this.db = new DatabaseSync(this.path, { readBigInts: true });
    this.db.exec("PRAGMA busy_timeout = 15000");
    this.configureJournalMode();
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.initialize();
  }

  close(): void {
    this.db.close();
  }

  initialize(): void {
    const currentVersion = this.detectSchemaVersion();
    let schemaApplied = false;
    if (currentVersion === 0) {
      this.db.exec(DDL);
      schemaApplied = true;
      this.db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
      this.db.prepare("INSERT OR IGNORE INTO migration_history(version, name, applied_at) VALUES (?, ?, ?)").run(SCHEMA_VERSION, "initial schema", now());
    } else if (currentVersion < SCHEMA_VERSION) {
      migrateSchema(this.db, currentVersion);
      this.db.exec(DDL);
      schemaApplied = true;
    } else if (currentVersion > SCHEMA_VERSION) {
      throw new Error(`Ledger schema version ${currentVersion} is newer than supported version ${SCHEMA_VERSION}`);
    }
    const hasDefaultBook = this.db.prepare("SELECT id FROM books WHERE id = ?").get(DEFAULT_BOOK_ID);
    if (!hasDefaultBook) {
      if (!schemaApplied) this.db.exec(DDL);
      this.db.prepare(
        "INSERT OR IGNORE INTO books(id, name, type, parent_id, created_at) VALUES (?, 'Actual', 'actual', NULL, ?)"
      ).run(DEFAULT_BOOK_ID, "1970-01-01T00:00:00Z");
    }
    if (this.bookId !== DEFAULT_BOOK_ID && !this.db.prepare("SELECT id FROM books WHERE id = ?").get(this.bookId)) {
      throw new Error(`Book ${this.bookId} not found`);
    }
  }

  private configureJournalMode(): void {
    const current = this.db.prepare("PRAGMA journal_mode").get() as Row | undefined;
    if (String(current?.journal_mode ?? "").toLowerCase() !== "wal") this.db.exec("PRAGMA journal_mode = WAL");
  }

  transaction<T>(fn: () => T): T {
    const outer = this.transactionDepth === 0;
    if (outer) this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth += 1;
    let result: T;
    try {
      result = fn();
    } catch (error) {
      this.transactionDepth -= 1;
      if (outer) this.db.exec("ROLLBACK");
      throw error;
    }
    this.transactionDepth -= 1;
    if (outer) this.db.exec("COMMIT");
    return result;
  }

  private detectSchemaVersion(): number {
    const meta = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get() as Row | undefined;
    if (!meta) return 0;
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as Row | undefined;
    return Number(row?.value ?? 1);
  }
}
