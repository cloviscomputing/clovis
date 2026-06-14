import { createHash } from "node:crypto";
import { Ledger } from "../core/ledger.js";
import { redactToolPath } from "./filesystem.js";
import { safeJson } from "./json.js";
import type { ToolSpec } from "./tool-spec.js";

type Args = Record<string, any>;
type Row = Record<string, any>;
type LedgerSnapshot = Record<string, Row[]>;

export const MUTATION_AUDIT_TABLES = [
  "books", "assets", "accounts", "sources", "journals", "journal_lines", "prices",
  "annotations", "rules", "targets", "recurrences", "period_closes", "lots",
  "statement_plans", "statement_plan_rows"
] as const;

const GENERIC_PREVIEW_FILE_SIDE_EFFECT_TOOLS = new Set<string>(["backup_now"]);

export function stableJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (typeof input === "bigint") return input.toString();
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input as Row).sort(([left], [right]) => left.localeCompare(right)).map(([key, val]) => [key, normalize(val)]));
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function hasNativeDryRun(spec: Pick<ToolSpec, "definition">): boolean {
  return Boolean(spec.definition.parameters.some((parameter) => parameter[0] === "dry_run"));
}

function ledgerSnapshot(ledger: Ledger): LedgerSnapshot {
  return Object.fromEntries(MUTATION_AUDIT_TABLES.map((table) => [table, ledger.tableRows(table)]));
}

export function rowIdentity(table: string, row: Row): string {
  if (row.id != null) return String(row.id);
  if (table === "meta") return String(row.key);
  if (table === "migration_history") return String(row.version);
  return stableHash(row);
}

function snapshotDiff(before: LedgerSnapshot, after: LedgerSnapshot): Row[] {
  const diff: Row[] = [];
  for (const table of MUTATION_AUDIT_TABLES) {
    const beforeRows = new Map((before[table] ?? []).map((row) => [rowIdentity(table, row), row]));
    const afterRows = new Map((after[table] ?? []).map((row) => [rowIdentity(table, row), row]));
    const ids = [...new Set([...beforeRows.keys(), ...afterRows.keys()])].sort();
    for (const idValue of ids) {
      const beforeRow = beforeRows.get(idValue) ?? null;
      const afterRow = afterRows.get(idValue) ?? null;
      const beforeHash = beforeRow == null ? null : stableHash(beforeRow);
      const afterHash = afterRow == null ? null : stableHash(afterRow);
      if (beforeHash === afterHash) continue;
      diff.push({
        entity_type: table,
        entity_id: idValue,
        action: beforeRow == null ? "insert" : afterRow == null ? "delete" : "update",
        before: beforeRow,
        after: afterRow,
        before_hash: beforeHash,
        after_hash: afterHash
      });
    }
  }
  return diff;
}

function accountingBalances(snapshot: LedgerSnapshot, bookId: string): Map<string, Row> {
  const journals = new Map((snapshot.journals ?? []).map((row) => [String(row.id), row]));
  const balances = new Map<string, Row>();
  for (const line of snapshot.journal_lines ?? []) {
    const journal = journals.get(String(line.journal_id));
    if (!journal || String(journal.book_id) !== bookId || String(line.book_id) !== bookId || journal.finalized_at == null || journal.status === "void") continue;
    const key = [journal.book_id, journal.status, line.account_id, line.asset_id].map(String).join("|");
    const current = balances.get(key) ?? {
      book_id: String(journal.book_id),
      status: String(journal.status),
      account_id: String(line.account_id),
      asset_id: String(line.asset_id),
      quantity: 0n
    };
    current.quantity = BigInt(current.quantity) + BigInt(line.quantity as string | number | bigint | boolean);
    balances.set(key, current);
  }
  return balances;
}

function accountingDelta(before: LedgerSnapshot, after: LedgerSnapshot, bookId: string): Row[] {
  const beforeBalances = accountingBalances(before, bookId);
  const afterBalances = accountingBalances(after, bookId);
  const keys = [...new Set([...beforeBalances.keys(), ...afterBalances.keys()])].sort();
  return keys.flatMap((key) => {
    const beforeRow = beforeBalances.get(key);
    const afterRow = afterBalances.get(key);
    const quantity = BigInt(afterRow?.quantity ?? 0n) - BigInt(beforeRow?.quantity ?? 0n);
    if (quantity === 0n) return [];
    const row = afterRow ?? beforeRow!;
    return [{ status: row.status, account_id: row.account_id, asset_id: row.asset_id, quantity }];
  });
}

function affectedReportsFromDiff(diff: Row[], delta: Row[]): Row {
  const accounts = new Set<string>();
  for (const row of diff) {
    for (const source of [row.before, row.after]) {
      if (!source) continue;
      for (const key of ["account_id", "from_account_id", "to_account_id", "counterpart_account_id"]) {
        if ((source as Row)[key]) accounts.add(String((source as Row)[key]));
      }
    }
  }
  for (const row of delta) accounts.add(String(row.account_id));
  return {
    tables: [...new Set(diff.map((row) => row.entity_type))].sort(),
    budgets: [...accounts].sort(),
    balances: delta.length > 0,
    income_statement: delta.length > 0,
    cash_projection: delta.length > 0
  };
}

function stripOperationStorage(row: Row): Row {
  const { _rowid, input_json, preview_json, result_json, metadata_json, ...rest } = row;
  return rest;
}

function safeJsonValue(value: unknown): Row | null {
  if (value == null || value === "") return null;
  return safeJson(value);
}

export function operationRowPublic(row: Row): Row {
  const { before_json, after_json, metadata_json, ...rest } = row;
  return {
    ...rest,
    before: safeJsonValue(row.before_json),
    after: safeJsonValue(row.after_json),
    metadata: safeJson(row.metadata_json)
  };
}

export function operationPublic(ledger: Ledger, operation: Row): Row {
  const rows = ledger.listLedgerOperationRows(String(operation.id)).map(operationRowPublic);
  return {
    ...stripOperationStorage(operation),
    input: safeJson(operation.input_json),
    preview: safeJson(operation.preview_json),
    result: safeJson(operation.result_json),
    metadata: safeJson(operation.metadata_json),
    rows
  };
}

function stripPreviewOnlyOperationIds(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { operation_id, mutation_id, ledger_operation, ...rest } = value as Row;
  return rest;
}

export function createOperation(ledger: Ledger, input: Row, rows: Row[]): Row {
  const operation = ledger.createLedgerOperation({
    ...input,
    input_json: stableJson(input.input ?? {}),
    preview_json: stableJson(input.preview ?? {}),
    result_json: stableJson(input.result ?? {}),
    metadata_json: stableJson(input.metadata ?? {})
  }, rows.map((row, index) => ({
    ...row,
    row_index: row.row_index ?? index,
    before_json: row.before_json ?? (row.before == null ? null : stableJson(row.before)),
    after_json: row.after_json ?? (row.after == null ? null : stableJson(row.after)),
    metadata_json: row.metadata_json ?? stableJson(row.metadata ?? {})
  })));
  return operationPublic(ledger, operation);
}

export function mutationPreview(ledger: Ledger, spec: ToolSpec, args: Args): Row {
  if (spec.safety.readOnlyHint) throw new Error(`Tool '${spec.name}' is read-only`);
  if (GENERIC_PREVIEW_FILE_SIDE_EFFECT_TOOLS.has(spec.name)) {
    if (!hasNativeDryRun(spec)) throw new Error(`Tool '${spec.name}' has filesystem side effects and cannot be generically previewed`);
    const result = spec.handler(ledger, { ...args, dry_run: true });
    return {
      dry_run: true,
      tool_name: spec.name,
      apply_args: { ...args, dry_run: false },
      would_result: stripPreviewOnlyOperationIds(result),
      diff: [],
      accounting_delta: [],
      affected_reports: { budgets: [], balance_sheet: false, income_statement: false, cash_projection: false },
      ids_are_preview_only: false
    };
  }
  const applyArgs = { ...args };
  if (hasNativeDryRun(spec)) applyArgs.dry_run = false;
  if (spec.name === "repair_integrity") applyArgs.backup = false;
  const before = ledgerSnapshot(ledger);
  let result: unknown;
  let after: LedgerSnapshot = before;
  const rollback = { rollback: "clovis_mutation_preview" };
  try {
    ledger.runInTransaction(() => {
      result = spec.handler(ledger, applyArgs);
      after = ledgerSnapshot(ledger);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  const diff = snapshotDiff(before, after);
  const delta = accountingDelta(before, after, ledger.bookId);
  return {
    dry_run: true,
    tool_name: spec.name,
    apply_args: applyArgs,
    would_result: stripPreviewOnlyOperationIds(result),
    diff,
    accounting_delta: delta,
    affected_reports: affectedReportsFromDiff(diff, delta),
    ids_are_preview_only: true
  };
}

function attachOperationResult(result: unknown, operation: Row): Row {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const row = result as Row;
    return {
      ...row,
      mutation_id: row.mutation_id ?? operation.id,
      operation_id: row.operation_id ?? operation.id
    };
  }
  return { result, mutation_id: operation.id, operation_id: operation.id };
}

export function withMutationOverseer(ledger: Ledger, spec: ToolSpec, args: Args): unknown {
  if (spec.safety.readOnlyHint) return spec.handler(ledger, args);
  if (spec.name === "backup_now") return spec.handler(ledger, args);
  if (args.dry_run === true && !hasNativeDryRun(spec)) return mutationPreview(ledger, spec, args);

  const external: Row = {};
  let handlerArgs = args;
  if (spec.name === "repair_integrity" && args.dry_run === false && args.backup !== false) {
    external.backup = redactToolPath(ledger.path, ledger.backupNow().path);
    handlerArgs = { ...args, backup: false };
  }

  return ledger.runInTransaction(() => {
    const before = ledgerSnapshot(ledger);
    const result = spec.handler(ledger, handlerArgs);
    const resultRow = result && typeof result === "object" && !Array.isArray(result) ? { ...(result as Row), ...external } : result;
    const after = ledgerSnapshot(ledger);
    const diff = snapshotDiff(before, after);
    if (diff.length === 0 || (resultRow && typeof resultRow === "object" && !Array.isArray(resultRow) && ((resultRow as Row).operation_id || (resultRow as Row).mutation_id))) {
      return resultRow;
    }
    const delta = accountingDelta(before, after, ledger.bookId);
    const affected = affectedReportsFromDiff(diff, delta);
    const operation = createOperation(ledger, {
      tool_name: spec.name,
      operation_type: spec.name,
      input: handlerArgs,
      preview: {
        diff,
        accounting_delta: delta,
        affected_reports: affected
      },
      result: resultRow,
      metadata: {
        overseer: "mutation",
        reversible: true,
        generic_reversal: true,
        accounting_delta: delta,
        affected_reports: affected
      }
    }, diff);
    return attachOperationResult(resultRow, operation);
  });
}
