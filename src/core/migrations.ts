import type { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION } from "./schema.js";

type Row = Record<string, unknown>;

function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).some((row) => String(row.name) === column);
}

function migrateToV2(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS migration_history(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  if (!hasColumn(db, "accounts", "default_asset_id")) db.exec("ALTER TABLE accounts ADD COLUMN default_asset_id TEXT REFERENCES assets(id)");
  if (!hasColumn(db, "journals", "finalized_at")) db.exec("ALTER TABLE journals ADD COLUMN finalized_at TEXT");
  db.exec(`
    UPDATE accounts
    SET default_asset_id = (
      SELECT value FROM annotations
      WHERE annotations.book_id = accounts.book_id
        AND annotations.entity_type = 'account'
        AND annotations.entity_id = accounts.id
        AND annotations.key = 'default_asset'
      ORDER BY annotations.rowid DESC
      LIMIT 1
    )
    WHERE default_asset_id IS NULL
  `);
  db.exec("UPDATE journals SET finalized_at = posted_at WHERE finalized_at IS NULL");
  db.prepare("INSERT OR IGNORE INTO migration_history(version, name, applied_at) VALUES (2, 'add finalized journals and account default assets', ?)").run(now());
}

function migrateToV3(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS migration_history(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  db.prepare("INSERT OR IGNORE INTO migration_history(version, name, applied_at) VALUES (3, 'add statement import plans', ?)").run(now());
}

function migrateToV4(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS migration_history(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  db.prepare("INSERT OR IGNORE INTO migration_history(version, name, applied_at) VALUES (4, 'add ledger operation audit records', ?)").run(now());
}

export function migrateSchema(db: DatabaseSync, currentVersion: number): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (currentVersion < 2) migrateToV2(db);
    if (currentVersion < 3) migrateToV3(db);
    if (currentVersion < 4) migrateToV4(db);
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
