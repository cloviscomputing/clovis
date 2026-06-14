import type { Ledger } from "../core/ledger.js";
import { safeJson } from "./json.js";
import {
  createOperation,
  MUTATION_AUDIT_TABLES,
  operationRowPublic,
  rowIdentity,
  stableHash
} from "./mutation-overseer.js";
import { validateDate } from "./validation.js";

type Row = Record<string, any>;

export type OperationReversalDeps = {
  txWithEntries: (txId: string) => Row;
  tagTx: (txId: string, key: string, value: string) => void;
};

const GENERIC_REVERSIBLE_TABLES = new Set<string>(MUTATION_AUDIT_TABLES);
const GENERIC_REVERSIBLE_ACTIONS = new Set<string>(["insert", "update", "delete"]);
const STATEMENT_AUDIT_TABLES = new Set<string>(["statement_plans", "statement_plan_rows"]);
const ACCOUNTING_ROW_TABLES = new Set<string>(["journals", "journal_lines"]);

const REVERSE_ROW_ORDER = new Map<string, number>([
  ["annotations", 10],
  ["statement_plan_rows", 20],
  ["lots", 30],
  ["journal_lines", 40],
  ["statement_plans", 50],
  ["journals", 60],
  ["targets", 70],
  ["recurrences", 70],
  ["prices", 70],
  ["rules", 70],
  ["sources", 80],
  ["accounts", 90],
  ["assets", 100],
  ["books", 110]
]);

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function jsonMentionsAnyId(value: unknown, ids: Set<string>): boolean {
  if (value == null) return false;
  if (typeof value === "string") return ids.has(value);
  if (typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => jsonMentionsAnyId(item, ids));
  return Object.values(value as Row).some((item) => jsonMentionsAnyId(item, ids));
}

function operationTouchedJournalIds(rows: Row[]): Set<string> {
  const ids = new Set<string>();
  for (const row of rows.map(operationRowPublic)) {
    if (["journals", "tx"].includes(String(row.entity_type))) ids.add(String(row.entity_id));
    if (row.correction_journal_id) ids.add(String(row.correction_journal_id));
    if (row.reverse_journal_id) ids.add(String(row.reverse_journal_id));
  }
  return ids;
}

function activeDependentOperations(ledger: Ledger, operation: Row, rows: Row[]): Row[] {
  const touched = operationTouchedJournalIds(rows);
  if (touched.size === 0) return [];
  const candidates = ledger.listLedgerOperations(null).filter((candidate) => (
    String(candidate.id) !== String(operation.id)
    && String(candidate.status) === "applied"
    && String(candidate.operation_type) !== "reverse_ledger_operation"
    && Number(candidate._rowid ?? 0) > Number(operation._rowid ?? 0)
  ));
  return candidates.filter((candidate) => ledger.listLedgerOperationRows(String(candidate.id)).some((row) => {
    const publicRow = operationRowPublic(row);
    return touched.has(String(publicRow.entity_id))
      || (publicRow.correction_journal_id && touched.has(String(publicRow.correction_journal_id)))
      || (publicRow.reverse_journal_id && touched.has(String(publicRow.reverse_journal_id)))
      || jsonMentionsAnyId(publicRow.before, touched)
      || jsonMentionsAnyId(publicRow.after, touched);
  })).map((candidate) => ({
    id: String(candidate.id),
    operation_type: String(candidate.operation_type),
    tool_name: String(candidate.tool_name),
    created_at: String(candidate.created_at)
  }));
}

function sortRowsForReverse(rows: Row[]): Row[] {
  return [...rows].sort((left, right) => {
    const leftRank = REVERSE_ROW_ORDER.get(String(left.entity_type)) ?? 100;
    const rightRank = REVERSE_ROW_ORDER.get(String(right.entity_type)) ?? 100;
    if (left.action === "delete" && right.action !== "delete") return 1;
    if (left.action !== "delete" && right.action === "delete") return -1;
    const direction = left.action === "delete" ? -1 : 1;
    return direction * (leftRank - rightRank);
  });
}

function createdScenarioBooks(rows: Row[]): Row[] {
  return rows.map(operationRowPublic).filter((row) => (
    row.entity_type === "books"
    && row.action === "insert"
    && String(row.after?.type ?? "") === "scenario"
    && row.after?.closed_at == null
  )).map((row) => row.after as Row);
}

function countByColumn(ledger: Ledger, table: string, column: string, value: unknown, bookId?: string | null, predicate?: (row: Row) => boolean): number {
  return ledger.tableRows(table).filter((row) => (
    String(row[column] ?? "") === String(value ?? "")
    && (bookId == null || String(row.book_id ?? "") === String(bookId))
    && (!predicate || predicate(row))
  )).length;
}

type ReferenceSpec = readonly [table: string, column: string, predicate?: (row: Row) => boolean];
const ACCOUNT_REFERENCES: ReferenceSpec[] = [
  ["accounts", "parent_id"], ["journal_lines", "account_id"], ["rules", "account_id"],
  ["targets", "account_id"], ["recurrences", "from_account_id"], ["recurrences", "to_account_id"],
  ["lots", "account_id"], ["statement_plans", "account_id"], ["annotations", "entity_id", (row) => row.entity_type === "account"]
];
const ASSET_REFERENCES: ReferenceSpec[] = [
  ["accounts", "default_asset_id"], ["journal_lines", "asset_id"], ["prices", "asset_id"], ["prices", "quote_asset_id"],
  ["targets", "asset_id"], ["recurrences", "asset_id"], ["lots", "asset_id"], ["lots", "cost_asset_id"], ["statement_plans", "asset_id"]
];
const SOURCE_REFERENCES: ReferenceSpec[] = [
  ["journals", "source_id"], ["statement_plans", "source_id"], ["annotations", "value", (row) => row.key === "import_batch"]
];

function countReferences(ledger: Ledger, specs: ReferenceSpec[], value: unknown, bookId?: string | null): number {
  return specs.reduce((sum, [table, column, predicate]) => sum + countByColumn(ledger, table, column, value, bookId, predicate), 0);
}

function currentAuditRow(ledger: Ledger, row: Row): Row | null {
  const table = String(row.entity_type);
  const idValue = String(row.entity_id);
  return ledger.tableRows(table).find((candidate) => rowIdentity(table, candidate) === idValue) ?? null;
}

function insertedAccountFallback(ledger: Ledger, row: Row, reason: string, force = false): Row | null {
  if (row.entity_type !== "accounts" || row.action !== "insert" || !row.after) return null;
  const accountRow = currentAuditRow(ledger, row) ?? row.after as Row;
  if (!force && countReferences(ledger, ACCOUNT_REFERENCES, accountRow.id, String(accountRow.book_id)) === 0) return null;
  return {
    ...row,
    action: "update",
    before: { ...accountRow, status: "inactive" },
    after: accountRow,
    after_hash: stableHash(accountRow),
    reason
  };
}

function insertedAssetHasReferences(ledger: Ledger, row: Row): boolean {
  if (row.entity_type !== "assets" || row.action !== "insert" || !row.after) return false;
  return countReferences(ledger, ASSET_REFERENCES, row.after.id) > 0;
}

function insertedSourceHasReferences(ledger: Ledger, row: Row): boolean {
  if (row.entity_type !== "sources" || row.action !== "insert" || !row.after) return false;
  return countReferences(ledger, SOURCE_REFERENCES, row.after.id, String(row.after.book_id)) > 0;
}

function insertedStatementPlanFallback(ledger: Ledger, row: Row): Row | null {
  if (row.entity_type !== "statement_plans" || row.action !== "insert" || !row.after) return null;
  const planRow = currentAuditRow(ledger, row);
  if (!planRow || planRow.status !== "planned") return null;
  return {
    ...row,
    action: "discard_statement_plan",
    before: { ...planRow, status: "discarded", discarded_at: now() },
    after: planRow,
    after_hash: stableHash(planRow),
    reason: "inserted statement plan is discarded by reversal instead of deleted"
  };
}

function skipReversal(skipped: Row[], row: Row, reason: string): void {
  skipped.push({ ...row, reason });
}

function reversalSummary(row: Row): Row {
  return { table: row.entity_type, action: row.action === "discard_statement_plan" ? "discard" : row.action, entity_id: row.entity_id, reason: row.reason };
}

function reverseAuditRows(rows: Row[], reverseIds: string[], afterFor: (row: Row, index: number) => Row, hashFor: (row: Row, index: number, after: Row) => string = (_row, _index, after) => stableHash(after)): Row[] {
  return rows.map((row, index) => {
    const after = afterFor(row, index);
    return {
      entity_type: String(row.entity_type),
      entity_id: String(row.entity_id),
      action: "reverse",
      before: operationRowPublic(row),
      after,
      before_hash: row.after_hash,
      after_hash: hashFor(row, index, after),
      correction_journal_id: row.correction_journal_id,
      reverse_journal_id: reverseIds[index] ?? null
    };
  });
}

function genericReversalRows(ledger: Ledger, rows: Row[], hasAccountingDelta: boolean, scenarioBookIdsToClose = new Set<string>()): { reversible: Row[]; skipped: Row[] } {
  const reversible: Row[] = [];
  const skipped: Row[] = [];
  const publicRows = rows.map(operationRowPublic);
  const skippedAccountingJournalIds = new Set(publicRows
    .filter((row) => hasAccountingDelta && row.entity_type === "journals")
    .map((row) => String(row.entity_id)));
  for (const row of publicRows) {
    const table = String(row.entity_type);
    const skip = (reason: string): void => skipReversal(skipped, row, reason);
    if (!GENERIC_REVERSIBLE_ACTIONS.has(String(row.action)) || !GENERIC_REVERSIBLE_TABLES.has(table)) {
      skip("no generic row reverser");
      continue;
    }
    const rowBookId = String(row.after?.book_id ?? row.before?.book_id ?? "");
    if ((table === "books" && scenarioBookIdsToClose.has(String(row.entity_id))) || scenarioBookIdsToClose.has(rowBookId)) {
      skip("scenario book is closed by reversal instead of deleting cloned audit rows");
      continue;
    }
    if (table === "statement_plans" && row.action === "insert") {
      const fallback = insertedStatementPlanFallback(ledger, row);
      if (fallback) {
        reversible.push(fallback);
        continue;
      }
    }
    if (STATEMENT_AUDIT_TABLES.has(table)) {
      skip("statement plans are immutable audit records");
      continue;
    }
    const current = currentAuditRow(ledger, row);
    if (row.action === "insert") {
      if (!current) { skip("inserted row is already absent"); continue; }
      if (row.after_hash && stableHash(current) !== row.after_hash) {
        if (table === "accounts") {
          const fallback = insertedAccountFallback(ledger, row, "inserted account changed after operation; reversal deactivates current account instead of deleting", true);
          if (fallback) {
            reversible.push(fallback);
            continue;
          }
        }
        skip("current row changed after operation; stale reversal skipped");
        continue;
      }
    }
    if (row.action === "update") {
      if (!current) { skip("updated row is already absent"); continue; }
      if (row.after_hash && stableHash(current) !== row.after_hash) {
        skip("current row changed after operation; stale reversal skipped");
        continue;
      }
    }
    if (row.action === "delete" && current) {
      skip("deleted row has been recreated; stale reversal skipped");
      continue;
    }
    if (hasAccountingDelta && ACCOUNTING_ROW_TABLES.has(table)) {
      skip("accounting reversal journal keeps original accounting rows referenced");
      continue;
    }
    if (hasAccountingDelta && table === "sources" && row.action === "insert") {
      skip("accounting reversal journal keeps imported source metadata referenced");
      continue;
    }
    if (!hasAccountingDelta && table === "accounts" && row.action === "insert") {
      const fallback = insertedAccountFallback(ledger, row, "inserted account is now referenced; reversal deactivates instead of deleting");
      if (fallback) {
        reversible.push(fallback);
        continue;
      }
    }
    if (!hasAccountingDelta && table === "assets" && insertedAssetHasReferences(ledger, row)) {
      skip("inserted asset is now referenced and cannot be deleted generically");
      continue;
    }
    if (!hasAccountingDelta && table === "sources" && insertedSourceHasReferences(ledger, row)) {
      skip("inserted source is now referenced and cannot be deleted generically");
      continue;
    }
    if (hasAccountingDelta && ["accounts", "assets"].includes(table)) {
      skip("accounting reversal journal keeps created accounts/assets referenced");
      continue;
    }
    if (
      hasAccountingDelta
      && table === "annotations"
      && row.action === "delete"
      && String(row.before?.entity_type ?? "") === "tx"
      && skippedAccountingJournalIds.has(String(row.before?.entity_id ?? ""))
    ) {
      skip("annotation target transaction remains deleted after accounting correction");
      continue;
    }
    reversible.push(row);
  }
  return { reversible: sortRowsForReverse(reversible), skipped };
}

function postAccountingDeltaReversal(ledger: Ledger, operationId: string, delta: Row[], date: string, deps: OperationReversalDeps): string[] {
  const byStatus = new Map<string, Array<[string, string, bigint]>>();
  for (const row of delta) {
    const quantity = -BigInt(row.quantity as string | number | bigint | boolean);
    if (quantity === 0n) continue;
    const status = String(row.status);
    byStatus.set(status, [...(byStatus.get(status) ?? []), [String(row.account_id), String(row.asset_id), quantity]]);
  }
  const reverseIds: string[] = [];
  for (const [status, lines] of [...byStatus.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (lines.length === 0) continue;
    const reverseId = ledger.postTx(date, status, `Reverse ledger operation ${operationId}`, lines);
    deps.tagTx(reverseId, "ledger_operation_kind", "reverse");
    reverseIds.push(reverseId);
  }
  return reverseIds;
}

function reverseInPlaceRecategorize(ledger: Ledger, operation: Row, rows: Row[], args: Row, deps: OperationReversalDeps): Row {
  const row = operationRowPublic(rows[0] ?? {});
  const preview = safeJson(operation.preview_json);
  const txId = String(preview.tx_id ?? row.entity_id ?? "");
  const oldAccount = String(preview.before_category?.account_id ?? "");
  const newAccount = String(preview.after_category?.account_id ?? "");
  if (!txId || !oldAccount || !newAccount) throw new Error("Ledger operation is missing recategorization reversal metadata");
  const current = deps.txWithEntries(txId);
  if (row.after_hash && stableHash(current) !== row.after_hash) throw new Error("Transaction changed after recategorization; stale reversal blocked");
  const diff = [{ tx_id: txId, from_account_id: newAccount, to_account_id: oldAccount }];
  if (args.dry_run !== false) return { dry_run: true, operation_id: operation.id, reverses_operation_id: operation.id, reversal_strategy: "recategorize_in_place", diff, reversible: true };

  let result: Row = {};
  let after: Row = {};
  const reverseOperation = ledger.runInTransaction(() => {
    result = ledger.recategorizeTransaction(txId, newAccount, oldAccount);
    after = deps.txWithEntries(txId);
    const reverseOp = createOperation(ledger, {
      tool_name: "reverse_ledger_operation",
      operation_type: "reverse_ledger_operation",
      reverses_operation_id: operation.id,
      input: { ...args, dry_run: false },
      preview: { reversal_strategy: "recategorize_in_place", rows: diff },
      result,
      metadata: { reversible: false }
    }, [{
      entity_type: "tx",
      entity_id: txId,
      action: "reverse",
      before: row,
      after: { transaction: after, result },
      before_hash: row.after_hash,
      after_hash: stableHash(after)
    }]);
    ledger.markLedgerOperationReversed(String(operation.id), String(reverseOp.id));
    return reverseOp;
  });
  return { dry_run: false, operation_id: reverseOperation.id, reversed_operation_id: operation.id, reversal_strategy: "recategorize_in_place", result };
}

export function reverseLedgerOperation(ledger: Ledger, args: Row, deps: OperationReversalDeps): Row {
  const operation = ledger.getLedgerOperation(String(args.operation_id));
  if (!operation) throw new Error(`Ledger operation '${String(args.operation_id)}' not found`);
  if (String(operation.status) === "reversed") throw new Error(`Ledger operation '${String(args.operation_id)}' is already reversed`);
  const rows = ledger.listLedgerOperationRows(String(operation.id));
  const metadata = safeJson(operation.metadata_json);
  const genericDelta = (metadata.accounting_delta ?? []) as Row[];
  const dependents = activeDependentOperations(ledger, operation, rows);
  if (dependents.length > 0) {
    const ids = dependents.map((row) => `${row.operation_type}:${row.id}`).join(", ");
    throw new Error(`Ledger operation has active dependent operations; reverse them first: ${ids}`);
  }

  if (String(operation.operation_type) !== "recategorize_transaction") {
    const date = args.date ? validateDate(String(args.date)) : today();
    const scenarioBooks = createdScenarioBooks(rows);
    const scenarioBookIds = new Set(scenarioBooks.map((row) => String(row.id)));
    const { reversible, skipped } = genericReversalRows(ledger, rows, genericDelta.length > 0, scenarioBookIds);
    const hasWork = genericDelta.length > 0 || scenarioBooks.length > 0 || reversible.length > 0;
    if (args.dry_run !== false) {
      return {
        dry_run: true,
        operation_id: operation.id,
        reverses_operation_id: operation.id,
        reversible: hasWork,
        blocked_reason: hasWork ? null : "operation has no reversible ledger changes",
        reversal_strategy: "generic_ledger_operation",
        accounting_delta: genericDelta,
        reverse_date: date,
        scenario_reversals: scenarioBooks.map((row) => ({ book_id: row.id, name: row.name, action: "close" })),
        row_reversals: reversible.map(reversalSummary),
        skipped_rows: skipped.map(reversalSummary)
      };
    }
    if (!hasWork) throw new Error("Ledger operation has no reversible ledger changes");
    const reverseIds: string[] = [];
    const reversedRows: Row[] = [];
    const closedScenarioBooks: Row[] = [];
    const reverseOperation = ledger.runInTransaction(() => {
      reverseIds.push(...postAccountingDeltaReversal(ledger, String(operation.id), genericDelta, date, deps));
      for (const row of scenarioBooks) {
        ledger.discardScenarioBook(String(row.id ?? row.name));
        closedScenarioBooks.push({ book_id: row.id, name: row.name, action: "closed" });
      }
      for (const row of reversible.filter((candidate) => candidate.action === "discard_statement_plan")) {
        ledger.discardStatementPlan(String(row.entity_id));
        reversedRows.push({ table: "statement_plans", action: "discard", entity_id: row.entity_id });
      }
      reversedRows.push(...ledger.reverseRows(reversible.filter((row) => row.action !== "discard_statement_plan").map((row) => ({
        table: String(row.entity_type),
        action: String(row.action),
        before: row.before,
        after: row.after
      }))));
      const reverseOp = createOperation(ledger, {
        tool_name: "reverse_ledger_operation",
        operation_type: "reverse_ledger_operation",
        reverses_operation_id: operation.id,
        input: { ...args, dry_run: false },
        preview: {
          reversal_strategy: "generic_ledger_operation",
          accounting_delta: genericDelta,
          scenario_reversals: scenarioBooks.map((row) => ({ book_id: row.id, name: row.name, action: "close" })),
          row_reversals: reversible,
          skipped_rows: skipped
        },
        result: { reverse_journal_ids: reverseIds, closed_scenario_books: closedScenarioBooks, reversed_rows: reversedRows, skipped_rows: skipped },
        metadata: { reversible: false, generic_reversal: true }
      }, reverseAuditRows(
        rows,
        reverseIds,
        (row) => ({ reversed: reversible.some((candidate) => candidate.id === row.id), skipped: skipped.some((candidate) => candidate.id === row.id) }),
        (row) => stableHash({ reverse_operation: true, operation_id: operation.id, row_id: row.id })
      ));
      ledger.markLedgerOperationReversed(String(operation.id), String(reverseOp.id));
      for (const reverseId of reverseIds) deps.tagTx(reverseId, "ledger_operation", String(reverseOp.id));
      return reverseOp;
    });
    return {
      dry_run: false,
      operation_id: reverseOperation.id,
      reversed_operation_id: operation.id,
      reverse_journal_ids: reverseIds,
      closed_scenario_books: closedScenarioBooks,
      reversed_rows: reversedRows,
      skipped_rows: skipped.map(reversalSummary)
    };
  }

  const correctionIds = rows.map((row) => row.correction_journal_id).filter(Boolean).map(String);
  if (correctionIds.length === 0 && metadata.mode === "in_place_non_posted") return reverseInPlaceRecategorize(ledger, operation, rows, args, deps);
  if (correctionIds.length === 0) throw new Error("Ledger operation has no correction journal to reverse");
  const reverseDate = args.date ? validateDate(String(args.date)) : null;
  const previewRows = correctionIds.map((correctionId) => {
    const correction = ledger.getTx(correctionId);
    if (!correction) throw new Error(`Correction journal '${correctionId}' not found`);
    const lines = ledger.getEntries(correctionId).map((entry) => [entry.account_id, entry.asset_id, -entry.quantity] as [string, string, bigint]);
    return { correction_id: correctionId, reverse_date: reverseDate ?? correction.date, reverse_lines: lines };
  });
  if (args.dry_run !== false) {
    return { dry_run: true, operation_id: operation.id, reverses_operation_id: operation.id, diff: previewRows, reversible: true };
  }
  const reverseIds: string[] = [];
  const reverseOperation = ledger.runInTransaction(() => {
    for (const row of previewRows) {
      const reverseId = ledger.postTx(String(row.reverse_date), "posted", `Reverse ledger operation ${String(operation.id)}`, row.reverse_lines);
      deps.tagTx(reverseId, "ledger_operation_kind", "reverse");
      reverseIds.push(reverseId);
    }
    const reverseOp = createOperation(ledger, {
      tool_name: "reverse_ledger_operation",
      operation_type: "reverse_ledger_operation",
      reverses_operation_id: operation.id,
      input: { ...args, dry_run: false },
      preview: { rows: previewRows },
      result: { reverse_journal_ids: reverseIds },
      metadata: { reversible: false }
    }, reverseAuditRows(rows, reverseIds, (_row, index) => ({ reverse_journal_id: reverseIds[index] ?? null })));
    ledger.markLedgerOperationReversed(String(operation.id), String(reverseOp.id));
    for (const reverseId of reverseIds) deps.tagTx(reverseId, "ledger_operation", String(reverseOp.id));
    return reverseOp;
  });
  return { dry_run: false, operation_id: reverseOperation.id, reversed_operation_id: operation.id, reverse_journal_ids: reverseIds };
}
