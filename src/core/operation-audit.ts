import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

type Row = Record<string, unknown>;

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function sqlIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error("Invalid SQL identifier");
  return value;
}

export function jsonText(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
}

function sqlValue(value: unknown): SQLInputValue {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return jsonText(value);
}

function primaryKey(table: string): string {
  return table === "meta" ? "key" : table === "migration_history" ? "version" : "id";
}

function tableColumns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${sqlIdentifier(table)})`).all() as Row[]).map((row) => String(row.name));
}

export function insertLedgerOperation(db: DatabaseSync, bookId: string, input: Row, rows: Row[]): string {
  const operationId = String(input.id ?? id("op"));
  const createdAt = String(input.created_at ?? now());
  db.prepare(`
    INSERT INTO ledger_operations(
      id, book_id, tool_name, operation_type, status, created_at, reversed_at,
      reversed_by_operation_id, reverses_operation_id, input_json, preview_json, result_json, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    operationId,
    bookId,
    String(input.tool_name ?? ""),
    String(input.operation_type ?? ""),
    String(input.status ?? "applied"),
    createdAt,
    input.reversed_at == null ? null : String(input.reversed_at),
    input.reversed_by_operation_id == null ? null : String(input.reversed_by_operation_id),
    input.reverses_operation_id == null ? null : String(input.reverses_operation_id),
    String(input.input_json ?? jsonText(input.input ?? {})),
    String(input.preview_json ?? jsonText(input.preview ?? {})),
    String(input.result_json ?? jsonText(input.result ?? {})),
    String(input.metadata_json ?? jsonText(input.metadata ?? {}))
  );
  rows.forEach((row, index) => {
    db.prepare(`
      INSERT INTO ledger_operation_rows(
        id, book_id, operation_id, row_index, entity_type, entity_id, action,
        before_hash, after_hash, before_json, after_json, correction_journal_id,
        reverse_journal_id, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(row.id ?? id("oprow")),
      bookId,
      operationId,
      Number(row.row_index ?? index),
      String(row.entity_type),
      String(row.entity_id),
      String(row.action),
      row.before_hash == null ? null : String(row.before_hash),
      row.after_hash == null ? null : String(row.after_hash),
      row.before_json == null ? null : String(row.before_json),
      row.after_json == null ? null : String(row.after_json),
      row.correction_journal_id == null ? null : String(row.correction_journal_id),
      row.reverse_journal_id == null ? null : String(row.reverse_journal_id),
      String(row.metadata_json ?? jsonText(row.metadata ?? {}))
    );
  });
  return operationId;
}

export function getLedgerOperationRow(db: DatabaseSync, bookId: string, operationId: string): Row | null {
  return (db.prepare("SELECT rowid AS _rowid, * FROM ledger_operations WHERE book_id = ? AND id = ?").get(bookId, operationId) as Row | undefined) ?? null;
}

export function listLedgerOperationRows(db: DatabaseSync, bookId: string, operationId: string): Row[] {
  return db.prepare("SELECT * FROM ledger_operation_rows WHERE book_id = ? AND operation_id = ? ORDER BY row_index, id").all(bookId, operationId) as Row[];
}

export function listLedgerOperationRowsByBook(db: DatabaseSync, bookId: string, limit: number | null = 50): Row[] {
  let sql = "SELECT rowid AS _rowid, * FROM ledger_operations WHERE book_id = ? ORDER BY rowid DESC";
  const params: SQLInputValue[] = [bookId];
  if (limit != null) {
    sql += " LIMIT ?";
    params.push(limit);
  }
  return db.prepare(sql).all(...params) as Row[];
}

export function markLedgerOperationReversedRow(db: DatabaseSync, bookId: string, operationId: string, reversedByOperationId: string): Row {
  const result = db.prepare("UPDATE ledger_operations SET status = 'reversed', reversed_at = ?, reversed_by_operation_id = ? WHERE book_id = ? AND id = ?").run(
    now(),
    reversedByOperationId,
    bookId,
    operationId
  );
  if (Number(result.changes) !== 1) throw new Error(`Ledger operation ${operationId} was not marked reversed`);
  return getLedgerOperationRow(db, bookId, operationId)!;
}

export function reverseAuditRows(db: DatabaseSync, rows: Array<{ table: string; action: string; before?: Row | null; after?: Row | null }>): Row[] {
  const whereByPrimaryKey = (table: string, row: Row): { sql: string; params: SQLInputValue[] } => {
    const pk = primaryKey(table);
    if (row[pk] == null) throw new Error(`Cannot reverse ${table} row without ${pk}`);
    const params: SQLInputValue[] = [sqlValue(row[pk])];
    let sql = `${sqlIdentifier(pk)} = ?`;
    if (row.book_id != null) {
      sql += " AND book_id = ?";
      params.push(sqlValue(row.book_id));
    }
    return { sql, params };
  };
  const runOne = (sql: string, params: SQLInputValue[], message: string): void => {
    const result = db.prepare(sql).run(...params);
    if (Number(result.changes) !== 1) throw new Error(message);
  };
  const insertRow = (table: string, row: Row): void => {
    const columns = tableColumns(db, table).filter((column) => Object.prototype.hasOwnProperty.call(row, column));
    const placeholders = columns.map(() => "?").join(", ");
    runOne(`INSERT INTO ${sqlIdentifier(table)}(${columns.map(sqlIdentifier).join(", ")}) VALUES (${placeholders})`, columns.map((column) => sqlValue(row[column])), `Failed to restore ${table} row`);
  };
  const updateRow = (table: string, row: Row): void => {
    const pk = primaryKey(table);
    const columns = tableColumns(db, table).filter((column) => column !== pk && Object.prototype.hasOwnProperty.call(row, column));
    const assignments = columns.map((column) => `${sqlIdentifier(column)} = ?`).join(", ");
    const where = whereByPrimaryKey(table, row);
    runOne(`UPDATE ${sqlIdentifier(table)} SET ${assignments} WHERE ${where.sql}`, [...columns.map((column) => sqlValue(row[column])), ...where.params], `Failed to restore ${table} row`);
  };
  const deleteRow = (table: string, row: Row): void => {
    const where = whereByPrimaryKey(table, row);
    runOne(`DELETE FROM ${sqlIdentifier(table)} WHERE ${where.sql}`, where.params, `Failed to remove inserted ${table} row`);
  };

  const reversed: Row[] = [];
  for (const row of rows) {
    const table = sqlIdentifier(row.table);
    if (row.action === "insert") {
      if (!row.after) throw new Error(`Cannot reverse ${table} insert without after row`);
      deleteRow(table, row.after);
    } else if (row.action === "delete") {
      if (!row.before) throw new Error(`Cannot reverse ${table} delete without before row`);
      insertRow(table, row.before);
    } else if (row.action === "update") {
      if (!row.before) throw new Error(`Cannot reverse ${table} update without before row`);
      updateRow(table, row.before);
    } else {
      throw new Error(`Unsupported row reversal action: ${row.action}`);
    }
    reversed.push({ table, action: row.action, entity_id: row.after?.id ?? row.before?.id ?? null });
  }
  return reversed;
}
