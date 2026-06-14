import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { Ledger } from "../core/ledger.js";
import type { Account, AccountType, Asset, Journal, JournalLine, TxStatus } from "../core/types.js";
import { fromAtomicUnits, toAtomicUnits } from "../core/money.js";
import { normalAmount } from "../core/accounting.js";
import { openMcpLedger } from "./context.js";
import { publicize, stringifyPublic } from "./json.js";
import { assertToolDataSize, fileAccessStatus, redactToolPath, resolveToolReadPath, resolveToolWritePath } from "./filesystem.js";
import { operatingManual } from "./operating-manual.js";
import { effectiveToolDefinition, normalizeToolInput, parameterAliasesForTool, STATUS_FILTER_VALUES, TOOL_DEFINITIONS, TOOL_SIGNATURES, toolSafety } from "./signatures.js";
import { amountToQuantity, parseSmartDate, parseTxStatus, parseTxStatusFilter, resolveAccount, resolveAsset, validateDate } from "./validation.js";

// Shared command catalog for CLI and MCP. This layer translates user/tool
// arguments into Ledger calls and public JSON shapes; core owns durable state.
type Args = Record<string, any>;
type Handler = (ledger: Ledger, args: Args) => unknown;
type Row = Record<string, any>;

const MAX_IMPORT_ROWS = 10000;
const MAX_CSV_COLUMNS = 200;

export const TOOL_NAMES = [
  "account_balances", "account_register", "add_match_rule", "add_match_rules", "age_of_money", "apply_match_rules", "apply_pattern",
  "apply_reconciliation_plan", "apply_rollover", "assert_balance", "assert_balances", "audit_categorization", "backup_now",
  "backup_status", "balance_sheet", "budget_rollover_preview", "budget_status", "budget_summary", "buy_security",
  "cash_flow", "cash_projection", "cash_runway", "close_period", "commit_batch", "compare_scenarios", "consolidate_transfers",
  "copy_budgets", "count_transactions", "create_account", "create_accounts", "create_asset", "create_branch",
  "create_price", "create_scheduled_transaction", "create_transaction", "delete_account", "delete_asset", "delete_budget",
  "delete_budgets", "delete_goal", "delete_match_rule", "delete_match_rules", "delete_tag", "delete_tags",
  "delete_transaction", "detect_recurring", "discard_batch", "discard_branch", "export_ledger", "export_transactions", "file_access_status",
  "financial_overview", "financial_picture", "find_pending_duplicates", "find_realized_planned", "flip_entries", "forecast", "forecast_month_end",
  "fx_transfer", "get_account", "get_account_by_name", "get_asset_by_symbol", "get_balance", "get_ledger_operation", "get_price",
  "get_transaction", "goal_progress", "holdings", "import_file", "import_ledger", "import_transactions",
  "income_statement", "init_defaults", "inspect_transaction", "integrity_check", "invert_import", "list_accounts",
  "list_assets", "list_backups", "list_branches", "list_checkpoints", "list_entries", "list_entries_by_asset",
  "list_goals", "list_import_batches", "list_ledger_operations", "list_match_rules", "list_prices", "list_scheduled", "list_tags",
  "list_transactions", "list_uncategorized", "list_unmatched_transfers", "match_transfer_pairs", "match_transfers",
  "merge_accounts", "merge_branch", "migrate_asset_entries", "move_transactions", "net_worth", "operating_manual", "pending_summary",
  "plan_transaction", "post_journal_entry", "preview_commit", "preview_import", "process_scheduled", "process_statement",
  "preview_mutation", "project_balances", "project_month_end", "recategorize_by_pattern", "recategorize_by_patterns", "recategorize_transaction",
  "recognize_gain_loss", "reconcile_diff", "reconcile_planned", "reconcile_statement", "reconcile_statement_plan", "reconcile_to_balance", "refresh_statement",
  "record_investment", "record_opening_balance", "record_opening_balances", "record_pending_expenses", "reopen_period",
  "repair_integrity", "reverse_ledger_operation", "rollback_import", "rollback_recategorize", "search_transactions", "set_budget", "set_budgets",
  "set_goal", "spending", "spending_rate", "suggest_budgets", "top_descriptions", "tool_registry", "transfer", "trial_balance",
  "unbudgeted_spending", "update_account", "update_asset", "void_by_filter"
] as const;

export type ToolName = typeof TOOL_NAMES[number];

function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function monthBounds(year?: number | null, month?: number | null): [string, string] {
  const base = new Date();
  const y = year ?? base.getUTCFullYear();
  const m = month ?? base.getUTCMonth() + 1;
  const start = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-01`;
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return [start, end];
}

function previousDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

function monthEnd(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function dateDeltaDays(left: string, right: string): number {
  return Math.abs((Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`)) / 86400000);
}

function optionalDate(value: unknown): string | null {
  if (value == null || value === "") return null;
  return validateDate(String(value));
}

function postedAtBound(value: unknown, side: "from" | "to"): string | null {
  if (value == null || value === "") return null;
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return side === "from" ? `${text}T00:00:00Z` : `${text}T23:59:59Z`;
  return text;
}

function account(ledger: Ledger, ref?: string | null): string {
  return resolveAccount(ledger, ref);
}

function asset(ledger: Ledger, ref?: string | null, symbol?: string | null): string {
  return resolveAsset(ledger, ref, symbol);
}

function explicitAsset(ledger: Ledger, ref?: string | null, label = "asset_id"): string {
  // Currency is never guessed. Callers must provide an asset explicitly or use
  // an account default that has already been recorded on the ledger.
  if (!ref) throw new Error(`${label} is required; Clovis does not infer a default currency`);
  return resolveAsset(ledger, ref);
}

function reportAsset(ledger: Ledger, ref?: string | null): string {
  return explicitAsset(ledger, ref, "quote_asset_id");
}

function accountDefaultAsset(ledger: Ledger, accountId: string): string | null {
  const account = ledger.getAccount(accountId);
  if (account?.default_asset_id) {
    if (!ledger.getAsset(account.default_asset_id)) throw new Error(`Account '${accountId}' has invalid default_asset '${account.default_asset_id}'`);
    return account.default_asset_id;
  }
  const tags = ledger.listAnnotations("account", accountId).filter((tag) => tag.key === "default_asset");
  const value = tags.at(-1)?.value ?? null;
  if (!value) return null;
  if (!ledger.getAsset(value)) throw new Error(`Account '${accountId}' has invalid default_asset '${value}'`);
  return value;
}

function setAccountDefaultAsset(ledger: Ledger, accountId: string, assetId?: string | null): void {
  ledger.updateAccount(accountId, { default_asset_id: assetId ? explicitAsset(ledger, assetId) : null });
  for (const tag of ledger.listAnnotations("account", accountId).filter((row) => row.key === "default_asset")) ledger.deleteAnnotation(tag.id);
}

function accountAsset(ledger: Ledger, accountId: string, label = "asset_id"): string {
  const assetId = accountDefaultAsset(ledger, accountId);
  if (assetId) return assetId;
  throw new Error(`${label} is required because account '${accountId}' has no default_asset`);
}

function transactionAsset(ledger: Ledger, fromAccountId: string, toAccountId: string, explicit?: string | null): string {
  if (explicit) return resolveAsset(ledger, explicit);
  const fromAsset = accountDefaultAsset(ledger, fromAccountId);
  const toAsset = accountDefaultAsset(ledger, toAccountId);
  if (!fromAsset || !toAsset) throw new Error("asset_id is required unless both accounts have default_asset set");
  if (fromAsset !== toAsset) throw new Error("asset_id is required for accounts with different default_asset values; use fx_transfer for cross-currency movement");
  return fromAsset;
}

function rootAccountIds(ledger: Ledger, types: string[]): string[] {
  const accounts = ledger.listAccounts();
  const byId = new Map(accounts.map((row) => [row.id, row]));
  return accounts
    .filter((row) => types.includes(row.account_type))
    .filter((row) => !row.parent_id || byId.get(row.parent_id)?.account_type !== row.account_type)
    .map((row) => row.id);
}

function nonOverlappingAccounts(ledger: Ledger, refs: string[], allowedTypes?: string[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const accountId = account(ledger, ref);
    const row = ledger.getAccount(accountId);
    if (!row) throw new Error(`Account '${accountId}' not found`);
    if (allowedTypes && !allowedTypes.includes(row.account_type)) {
      throw new Error(`Account '${row.name}' must be ${allowedTypes.join(" or ")}`);
    }
    if (!seen.has(accountId)) {
      ids.push(accountId);
      seen.add(accountId);
    }
  }
  return ids.filter((accountId) => {
    const row = ledger.getAccount(accountId);
    return !ids.some((otherId) => {
      if (otherId === accountId) return false;
      const other = ledger.getAccount(otherId);
      return other?.account_type === row?.account_type && ledger.descendants(otherId).has(accountId);
    });
  });
}

function splitProjectionAccounts(ledger: Ledger, args: Args): { asset_account_ids?: string[]; liability_account_ids?: string[] } {
  let assetRefs = args.asset_account_ids == null ? null : [...args.asset_account_ids as string[]];
  let liabilityRefs = args.liability_account_ids == null ? null : [...args.liability_account_ids as string[]];
  for (const ref of args.account_ids ?? []) {
    const accountId = account(ledger, ref);
    const row = ledger.getAccount(accountId);
    if (!row) throw new Error(`Account '${accountId}' not found`);
    if (row.account_type === "asset") {
      assetRefs ??= [];
      assetRefs.push(accountId);
    } else if (row.account_type === "liability") {
      liabilityRefs ??= [];
      liabilityRefs.push(accountId);
    } else {
      throw new Error(`Account '${row.name}' must be asset or liability`);
    }
  }
  return {
    asset_account_ids: assetRefs ?? undefined,
    liability_account_ids: liabilityRefs ?? undefined
  };
}

function assetScale(ledger: Ledger, assetId?: string | null): number {
  return ledger.getAsset(assetId || "")?.scale ?? 2;
}

function display(ledger: Ledger, quantity: bigint, assetId?: string | null): number {
  return Number(fromAtomicUnits(quantity, assetScale(ledger, assetId)));
}

function accountPublic(row: Account, ledger?: Ledger): Row {
  // Account rows carry default_asset_id directly; annotations remain readable
  // for old databases imported before schema v2.
  const defaultAssetId = ledger ? accountDefaultAsset(ledger, row.id) : null;
  const defaultAsset = defaultAssetId ? ledger?.getAsset(defaultAssetId) : null;
  return { ...row, type: row.account_type, default_asset_id: defaultAssetId, default_asset_symbol: defaultAsset?.symbol ?? null };
}

function entriesPublic(ledger: Ledger, txId: string): Row[] {
  // Journal lines carry signed atomic quantities. Public entries add account,
  // asset, and display context without changing the underlying sign convention.
  const accounts = new Map(ledger.listAccounts().map((row) => [row.id, row]));
  const assets = new Map(ledger.listAssets().map((row) => [row.id, row]));
  return ledger.getEntries(txId).map((entry) => {
    const acct = accounts.get(entry.account_id);
    const ast = assets.get(entry.asset_id);
    return {
      ...entry,
      account_name: acct?.name ?? "",
      account_type: acct?.account_type ?? "",
      asset_symbol: ast?.symbol ?? "",
      amount_cents: entry.quantity,
      scale: ast?.scale ?? 2,
      amount_display: display(ledger, entry.quantity, entry.asset_id)
    };
  });
}

function txPublic(ledger: Ledger, tx: Journal, compact = false): Row {
  // Representative transaction amounts are derived from the largest line. The
  // full entries array remains authoritative for multi-leg or multi-asset work.
  const entries = entriesPublic(ledger, tx.id);
  const main = entries.toSorted((a, b) => Number(BigInt(b.quantity) ** 2n - BigInt(a.quantity) ** 2n))[0];
  const amount = main ? (BigInt(main.quantity) < 0n ? -BigInt(main.quantity) : BigInt(main.quantity)) : 0n;
  const tags = ledger.listAnnotations("tx", tx.id);
  if (compact) {
    const { entries: _entries, tags: _tags, ...header } = tx as Row;
    void _entries;
    void _tags;
    return {
      ...header,
      amount,
      amount_cents: amount,
      amount_display: main ? display(ledger, amount, String(main.asset_id)) : 0,
      entry_count: entries.length,
      tag_count: tags.length,
      account_ids: [...new Set(entries.map((entry) => String(entry.account_id)))],
      asset_ids: [...new Set(entries.map((entry) => String(entry.asset_id)))]
    };
  }
  const out: Row = {
    ...tx,
    entries,
    amount,
    amount_cents: amount,
    amount_display: main ? display(ledger, amount, String(main.asset_id)) : 0,
    tags
  };
  return out;
}

function txWithEntries(ledger: Ledger, txId: string): Row {
  const tx = ledger.getTx(txId);
  if (!tx) throw new Error(`Transaction '${txId}' not found`);
  return txPublic(ledger, tx);
}

function directedTxPublic(ledger: Ledger, tx: Journal, fromAccountId: string, toAccountId: string): Row {
  return {
    ...txPublic(ledger, tx),
    from_account: fromAccountId,
    to_account: toAccountId
  };
}

function statuses(status?: unknown, includePending = false): Set<string> | null {
  const normalized = parseTxStatusFilter(status, includePending ? "active" : null);
  if (normalized == null) return null;
  if (normalized === "active") return new Set(["posted", "pending"]);
  if (normalized === "combined") return new Set(["posted", "pending", "planned"]);
  return new Set([normalized]);
}

function reportStatus(args: Args, fallback: TxStatus | "active" | "combined" | null): TxStatus | "active" | "combined" | null {
  if (args.status !== undefined && args.status !== "") return parseTxStatusFilter(args.status, fallback);
  if (args.include_pending === true) return "active";
  if (args.include_pending === false) return "posted";
  return fallback;
}

function iterTransactions(ledger: Ledger, args: { status?: string | null; includePending?: boolean; date_from?: string | null; date_to?: string | null } = {}): Journal[] {
  const allowed = statuses(args.status, args.includePending);
  const rows = ledger.listTransactions({ status: null, dateFrom: optionalDate(args.date_from), dateTo: optionalDate(args.date_to), sort: "date_asc" });
  if (!allowed) return rows.filter((tx) => tx.status !== "void");
  return rows.filter((tx) => allowed.has(tx.status));
}

function amountForAccount(ledger: Ledger, txId: string, accountId: string, assetId?: string | null): bigint {
  return ledger.getEntries(txId).filter((entry) => entry.account_id === accountId && (!assetId || entry.asset_id === assetId)).reduce((sum, entry) => sum + entry.quantity, 0n);
}

function stableJson(value: unknown): string {
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

function stableHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

const MUTATION_AUDIT_TABLES = [
  "books", "assets", "accounts", "sources", "journals", "journal_lines", "prices",
  "annotations", "rules", "targets", "recurrences", "period_closes", "lots",
  "statement_plans", "statement_plan_rows"
] as const;

const GENERIC_PREVIEW_FILE_SIDE_EFFECT_TOOLS = new Set<string>(["backup_now"]);
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

type LedgerSnapshot = Record<string, Row[]>;

function hasNativeDryRun(name: string): boolean {
  return Boolean(TOOL_DEFINITIONS[name as keyof typeof TOOL_DEFINITIONS]?.parameters.some((parameter) => parameter[0] === "dry_run"));
}

function ledgerSnapshot(ledger: Ledger): LedgerSnapshot {
  return Object.fromEntries(MUTATION_AUDIT_TABLES.map((table) => [table, ledger.tableRows(table)]));
}

function rowIdentity(table: string, row: Row): string {
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

function operationRowPublic(row: Row): Row {
  const { before_json, after_json, metadata_json, ...rest } = row;
  return {
    ...rest,
    before: safeJsonValue(row.before_json),
    after: safeJsonValue(row.after_json),
    metadata: safeJson(row.metadata_json)
  };
}

function operationPublic(ledger: Ledger, operation: Row): Row {
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

function stripPreviewOnlyOperationIds(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { operation_id, mutation_id, ledger_operation, ...rest } = value as Row;
  return rest;
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

function postAccountingDeltaReversal(ledger: Ledger, operationId: string, delta: Row[], date: string): string[] {
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
    tagTx(ledger, reverseId, "ledger_operation_kind", "reverse");
    reverseIds.push(reverseId);
  }
  return reverseIds;
}

function mutationPreview(ledger: Ledger, name: ToolName, args: Args): Row {
  if (toolSafety(name).readOnlyHint) throw new Error(`Tool '${name}' is read-only`);
  if (GENERIC_PREVIEW_FILE_SIDE_EFFECT_TOOLS.has(name)) {
    if (!hasNativeDryRun(name)) throw new Error(`Tool '${name}' has filesystem side effects and cannot be generically previewed`);
    const result = handlers[name](ledger, { ...args, dry_run: true });
    return {
      dry_run: true,
      tool_name: name,
      apply_args: { ...args, dry_run: false },
      would_result: stripPreviewOnlyOperationIds(result),
      diff: [],
      accounting_delta: [],
      affected_reports: { budgets: [], balance_sheet: false, income_statement: false, cash_projection: false },
      ids_are_preview_only: false
    };
  }
  const applyArgs = { ...args };
  if (hasNativeDryRun(name)) applyArgs.dry_run = false;
  if (name === "repair_integrity") applyArgs.backup = false;
  const before = ledgerSnapshot(ledger);
  let result: unknown;
  let after: LedgerSnapshot = before;
  const rollback = { rollback: "clovis_mutation_preview" };
  try {
    ledger.runInTransaction(() => {
      result = handlers[name](ledger, applyArgs);
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
    tool_name: name,
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

function withMutationOverseer(ledger: Ledger, name: ToolName, args: Args): unknown {
  const safety = toolSafety(name);
  if (safety.readOnlyHint) return handlers[name](ledger, args);
  if (name === "backup_now") return handlers[name](ledger, args);
  if (args.dry_run === true && !hasNativeDryRun(name)) return mutationPreview(ledger, name, args);

  const external: Row = {};
  let handlerArgs = args;
  if (name === "repair_integrity" && args.dry_run === false && args.backup !== false) {
    external.backup = redactToolPath(ledger.path, ledger.backupNow().path);
    handlerArgs = { ...args, backup: false };
  }

  return ledger.runInTransaction(() => {
    const before = ledgerSnapshot(ledger);
    const result = handlers[name](ledger, handlerArgs);
    const resultRow = result && typeof result === "object" && !Array.isArray(result) ? { ...(result as Row), ...external } : result;
    const after = ledgerSnapshot(ledger);
    const diff = snapshotDiff(before, after);
    if (diff.length === 0 || (resultRow && typeof resultRow === "object" && !Array.isArray(resultRow) && ((resultRow as Row).operation_id || (resultRow as Row).mutation_id))) {
      return resultRow;
    }
    const delta = accountingDelta(before, after, ledger.bookId);
    const affected = affectedReportsFromDiff(diff, delta);
    const operation = createOperation(ledger, {
      tool_name: name,
      operation_type: name,
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

function recategorizePreview(ledger: Ledger, args: Args): Row {
  const tx = ledger.getTx(String(args.tx_id));
  if (!tx) throw new Error(`Transaction '${String(args.tx_id)}' not found`);
  if (tx.status === "void") throw new Error("Cannot recategorize a void transaction");
  if (ledger.listLots().some((lot) => lot.opened_journal_id === tx.id || lot.closed_journal_id === tx.id)) {
    throw new Error("Transaction has linked investment lots; use an investment reversal workflow");
  }
  const entries = ledger.getEntries(tx.id);
  const oldAccount = args.old_account_id
    ? account(ledger, args.old_account_id)
    : entries.find((entry) => ledger.getAccount(entry.account_id)?.account_type === "expense")?.account_id
      ?? entries.toSorted((a, b) => Number((b.quantity < 0n ? -b.quantity : b.quantity) - (a.quantity < 0n ? -a.quantity : a.quantity)))[0]?.account_id;
  if (!oldAccount) throw new Error("Transaction has no entries");
  const newAccount = account(ledger, args.new_account_id);
  const changedEntries = entries.filter((entry) => entry.account_id === oldAccount);
  if (changedEntries.length === 0) throw new Error(`Account ${oldAccount} is not on transaction ${tx.id}`);
  const oldRow = ledger.getAccount(oldAccount);
  const newRow = ledger.getAccount(newAccount);
  if (!newRow) throw new Error(`Account ${newAccount} not found`);
  const correctionDate = validateDate(String(args.correction_date ?? args.date ?? tx.date));
  const correctionLines = changedEntries.flatMap((entry) => [
    { account_id: oldAccount, asset_id: entry.asset_id, quantity: -entry.quantity },
    { account_id: newAccount, asset_id: entry.asset_id, quantity: entry.quantity }
  ]);
  const before = txWithEntries(ledger, tx.id);
  const after = {
    transaction_id: tx.id,
    original_transaction_status: tx.status,
    correction_date: correctionDate,
    correction_lines: correctionLines,
    old_account_id: oldAccount,
    old_account_name: oldRow?.name ?? "",
    new_account_id: newAccount,
    new_account_name: newRow.name
  };
  return {
    dry_run: true,
    tool: "recategorize_transaction",
    reversible: true,
    tx_id: tx.id,
    before_category: { account_id: oldAccount, account_name: oldRow?.name ?? "" },
    after_category: { account_id: newAccount, account_name: newRow.name },
    diff: [{
      entity_type: "tx",
      entity_id: tx.id,
      action: tx.status === "posted" ? "correction" : "update",
      before,
      after,
      before_hash: stableHash(before),
      after_hash: stableHash(after)
    }],
    affected_reports: {
      budgets: [...new Set([oldAccount, newAccount])],
      income_statement: true,
      cash_projection: false
    }
  };
}

function createOperation(ledger: Ledger, input: Row, rows: Row[]): Row {
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

function applyRecategorizeTransaction(ledger: Ledger, args: Args): Row {
  const preview = recategorizePreview(ledger, args);
  const tx = ledger.getTx(String(preview.tx_id))!;
  if (tx.status !== "posted") {
    const diff = preview.diff[0] as Row;
    const result = ledger.recategorizeTransaction(tx.id, String(preview.before_category.account_id), String(preview.after_category.account_id));
    const operation = createOperation(ledger, {
      tool_name: "recategorize_transaction",
      operation_type: "recategorize_transaction",
      input: { ...args, dry_run: false },
      preview,
      result,
      metadata: { reversible: true, mode: "in_place_non_posted" }
    }, [{
      entity_type: "tx",
      entity_id: tx.id,
      action: "update",
      before: diff.before,
      after: txWithEntries(ledger, tx.id),
      before_hash: diff.before_hash,
      after_hash: stableHash(txWithEntries(ledger, tx.id))
    }]);
    return { ...result, operation_id: operation.id, dry_run: false };
  }

  const correctionLines = (preview.diff[0] as Row).after.correction_lines as Row[];
  const correctionId = ledger.postTx(String((preview.diff[0] as Row).after.correction_date), "posted", `Correction: recategorize ${tx.description}`, correctionLines.map((line) => [
    String(line.account_id),
    String(line.asset_id),
    BigInt(line.quantity as string | number | bigint | boolean)
  ]));
  tagTx(ledger, correctionId, "ledger_operation_kind", "recategorize_transaction");
  const correction = txWithEntries(ledger, correctionId);
  const operation = createOperation(ledger, {
    tool_name: "recategorize_transaction",
    operation_type: "recategorize_transaction",
    input: { ...args, dry_run: false },
    preview,
    result: { correction_journal_id: correctionId },
    metadata: { reversible: true, mode: "append_only_correction" }
  }, [{
    entity_type: "tx",
    entity_id: tx.id,
    action: "correction",
    before: (preview.diff[0] as Row).before,
    after: { ...(preview.diff[0] as Row).after, correction },
    before_hash: (preview.diff[0] as Row).before_hash,
    after_hash: stableHash({ ...(preview.diff[0] as Row).after, correction }),
    correction_journal_id: correctionId
  }]);
  tagTx(ledger, correctionId, "ledger_operation", String(operation.id));
  return {
    tx_id: tx.id,
    from_account_id: preview.before_category.account_id,
    to_account_id: preview.after_category.account_id,
    correction_journal_id: correctionId,
    operation_id: operation.id,
    dry_run: false
  };
}

function reverseInPlaceRecategorize(ledger: Ledger, operation: Row, rows: Row[], args: Args): Row {
  const row = operationRowPublic(rows[0] ?? {});
  const preview = safeJson(operation.preview_json);
  const txId = String(preview.tx_id ?? row.entity_id ?? "");
  const oldAccount = String(preview.before_category?.account_id ?? "");
  const newAccount = String(preview.after_category?.account_id ?? "");
  if (!txId || !oldAccount || !newAccount) throw new Error("Ledger operation is missing recategorization reversal metadata");
  const current = txWithEntries(ledger, txId);
  if (row.after_hash && stableHash(current) !== row.after_hash) throw new Error("Transaction changed after recategorization; stale reversal blocked");
  const diff = [{ tx_id: txId, from_account_id: newAccount, to_account_id: oldAccount }];
  if (args.dry_run !== false) return { dry_run: true, operation_id: operation.id, reverses_operation_id: operation.id, reversal_strategy: "recategorize_in_place", diff, reversible: true };

  let result: Row = {};
  let after: Row = {};
  const reverseOperation = ledger.runInTransaction(() => {
    result = ledger.recategorizeTransaction(txId, newAccount, oldAccount);
    after = txWithEntries(ledger, txId);
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

function reverseLedgerOperation(ledger: Ledger, args: Args): Row {
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
      reverseIds.push(...postAccountingDeltaReversal(ledger, String(operation.id), genericDelta, date));
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
      for (const reverseId of reverseIds) tagTx(ledger, reverseId, "ledger_operation", String(reverseOp.id));
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
  if (correctionIds.length === 0 && metadata.mode === "in_place_non_posted") return reverseInPlaceRecategorize(ledger, operation, rows, args);
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
      tagTx(ledger, reverseId, "ledger_operation_kind", "reverse");
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
    for (const reverseId of reverseIds) tagTx(ledger, reverseId, "ledger_operation", String(reverseOp.id));
    return reverseOp;
  });
  return { dry_run: false, operation_id: reverseOperation.id, reversed_operation_id: operation.id, reverse_journal_ids: reverseIds };
}

function budgetRows(ledger: Ledger, accountId?: string | null, year?: number | null, month?: number | null): Row[] {
  return ledger.listBudgetTargets({ accountId, year, month });
}

function budgetSpecificity(row: Row): number {
  return (row.period === "monthly" ? 100 : 50) + (row.year == null ? 0 : 10) + (row.month == null ? 0 : 5);
}

function effectiveBudgetRows(ledger: Ledger, accountId?: string | null, year?: number | null, month?: number | null): { rows: Row[]; shadowed: Row[] } {
  const selected = new Map<string, Row>();
  const shadowed: Row[] = [];
  for (const row of budgetRows(ledger, accountId, year, month)) {
    const key = `${row.account_id}|${row.asset_id}`;
    const current = selected.get(key);
    if (!current) {
      selected.set(key, row);
      continue;
    }
    if (budgetSpecificity(row) >= budgetSpecificity(current)) {
      shadowed.push(current);
      selected.set(key, row);
    } else {
      shadowed.push(row);
    }
  }
  return { rows: [...selected.values()], shadowed };
}

function spendingRows(ledger: Ledger, year?: number | null, month?: number | null, status: TxStatus | "active" | "combined" | null = "posted", quoteAssetId?: string | null, returnMissing = false): Row[] | { rows: Row[]; missing: Row[] } {
  const quote = reportAsset(ledger, quoteAssetId);
  const [date_from, date_to] = monthBounds(year, month);
  const accounts = new Map(ledger.listAccounts().map((row) => [row.id, row]));
  const totals = new Map<string, bigint>();
  const missing: Row[] = [];
  for (const tx of iterTransactions(ledger, { status, date_from, date_to })) {
    for (const entry of ledger.getEntries(tx.id)) {
      const acct = accounts.get(entry.account_id);
      if (!acct || acct.account_type !== "expense") continue;
      const [converted, error] = ledger.tryConvertQuantity(entry.quantity, entry.asset_id, quote, tx.date);
      if (converted == null) {
        missing.push({ tx_id: tx.id, account_id: entry.account_id, asset_id: entry.asset_id, quote_asset_id: quote, quantity: entry.quantity, error });
        continue;
      }
      totals.set(entry.account_id, (totals.get(entry.account_id) ?? 0n) + converted);
    }
  }
  const rows = [...totals.entries()]
    .filter(([, amount]) => amount !== 0n)
    .sort((a, b) => Number(b[1] - a[1]))
    .map(([accountId, amount]) => ({
      account_id: accountId,
      account_name: accounts.get(accountId)?.name ?? "",
      asset_id: quote,
      amount,
      amount_cents: amount,
      quantity: amount,
      scale: assetScale(ledger, quote),
      amount_display: display(ledger, amount, quote)
    }));
  return returnMissing ? { rows, missing } : rows;
}

function incomeStatementRows(ledger: Ledger, year: number, month: number | null, status: TxStatus | "active" | "combined" | null = "posted", quoteAssetId?: string | null): Row {
  const quote = reportAsset(ledger, quoteAssetId);
  const [date_from, date_to] = monthBounds(year, month);
  const accounts = new Map(ledger.listAccounts().map((row) => [row.id, row]));
  const income = new Map<string, Row>();
  const expense = new Map<string, Row>();
  const missing: Row[] = [];
  for (const tx of iterTransactions(ledger, { status, date_from, date_to })) {
    for (const entry of ledger.getEntries(tx.id)) {
      const acct = accounts.get(entry.account_id);
      if (!acct || !["income", "expense"].includes(acct.account_type)) continue;
      const [converted, error] = ledger.tryConvertQuantity(entry.quantity, entry.asset_id, quote, tx.date);
      if (converted == null) {
        missing.push({ tx_id: tx.id, account_id: entry.account_id, asset_id: entry.asset_id, quote_asset_id: quote, quantity: entry.quantity, error });
        continue;
      }
      const target = acct.account_type === "income" ? income : expense;
      const current = target.get(acct.id) ?? { account_id: acct.id, account_name: acct.name, account_type: acct.account_type, normal_balance: acct.normal_balance, amount: 0n };
      current.amount = BigInt(current.amount) + normalAmount(acct.account_type, converted);
      target.set(acct.id, current);
    }
  }
  const scale = assetScale(ledger, quote);
  const normalize = (rows: Row[]) => rows.map((row) => ({
    ...row,
    amount: row.amount,
    amount_cents: row.amount,
    quantity: row.amount,
    scale,
    asset_id: quote,
    amount_display: display(ledger, BigInt(row.amount), quote)
  }));
  const incomeRows = normalize([...income.values()].sort((a, b) => String(a.account_name).localeCompare(String(b.account_name))));
  const expenseRows = normalize([...expense.values()].sort((a, b) => Number(BigInt(b.amount) - BigInt(a.amount))));
  const incomeTotal = incomeRows.reduce((sum, row) => sum + BigInt(row.amount), 0n);
  const expenseTotal = expenseRows.reduce((sum, row) => sum + BigInt(row.amount), 0n);
  return {
    year,
    month,
    income: incomeTotal,
    expense: expenseTotal,
    net: incomeTotal - expenseTotal,
    income_by_account: incomeRows,
    expense_by_account: expenseRows,
    quote_asset_id: quote,
    scale,
    valuation_complete: missing.length === 0,
    missing_conversions: missing
  };
}

function conversionSeverity(missing: Row[], options: { recommendedModel?: string | null } = {}): Row {
  if (missing.length === 0) {
    return {
      severity: "none",
      materiality: "none",
      missing_count: 0,
      message: "All requested balances converted into the report currency."
    };
  }
  const affectedSections = uniqueStrings(missing.flatMap((row) => row.affected_sections ?? []));
  const affectedModels = uniqueStrings(missing.flatMap((row) => row.affected_models ?? []));
  const recommendedModel = options.recommendedModel ?? null;
  const recommendedModelAffected = recommendedModel ? affectedModels.includes(recommendedModel) : null;
  return {
    severity: recommendedModelAffected === false && affectedModels.length > 0 ? "warning" : "unknown",
    materiality: "unknown",
    materiality_basis: "missing_price",
    missing_count: missing.length,
    affected_sections: affectedSections,
    affected_models: affectedModels,
    recommended_model: recommendedModel,
    recommended_model_affected: recommendedModelAffected,
    message: recommendedModelAffected === false
      ? "One or more balances could not be converted, but the recommended runway model is not directly affected."
      : "One or more balances could not be converted into the report currency, so materiality cannot be calculated safely."
  };
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.flatMap((value) => Array.isArray(value) ? value : [value]).map((value) => String(value ?? "")).filter(Boolean))];
}

function missingConversionKey(row: Row): string {
  return [
    row.tx_id ?? "",
    row.account_id ?? "",
    row.asset_id ?? "",
    row.quote_asset_id ?? "",
    String(row.quantity ?? ""),
    row.error ?? ""
  ].join("|");
}

function enrichMissingConversion(ledger: Ledger, row: Row): Row {
  const accountRow = row.account_id ? ledger.getAccount(String(row.account_id)) : null;
  const assetRow = row.asset_id ? ledger.getAsset(String(row.asset_id)) : null;
  const quoteRow = row.quote_asset_id ? ledger.getAsset(String(row.quote_asset_id)) : null;
  const quantity = row.quantity == null ? null : BigInt(row.quantity);
  return {
    ...row,
    account_name: accountRow?.name ?? null,
    account_type: accountRow?.account_type ?? null,
    asset_symbol: assetRow?.symbol ?? null,
    quote_asset_symbol: quoteRow?.symbol ?? null,
    quantity_display: quantity == null || !row.asset_id ? null : display(ledger, quantity, String(row.asset_id)),
    absolute_quantity_display: quantity == null || !row.asset_id ? null : display(ledger, quantity < 0n ? -quantity : quantity, String(row.asset_id)),
    materiality: "unknown",
    materiality_basis: "missing_price"
  };
}

function scopedMissingConversions(ledger: Ledger, sources: Array<{ rows?: Row[] | null; section: string; affectedModels?: string[] }>): Row[] {
  const byKey = new Map<string, Row>();
  for (const source of sources) {
    for (const row of source.rows ?? []) {
      const key = missingConversionKey(row);
      const current = byKey.get(key) ?? enrichMissingConversion(ledger, row);
      current.affected_sections = uniqueStrings([...(current.affected_sections ?? []), source.section]);
      current.affected_models = uniqueStrings([...(current.affected_models ?? []), ...(source.affectedModels ?? [])]);
      byKey.set(key, current);
    }
  }
  return [...byKey.values()];
}

function dedupeMissingConversions(rows: Row[]): Row[] {
  const seen = new Set<string>();
  const deduped: Row[] = [];
  for (const row of rows) {
    const key = missingConversionKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

function runwayMonths(cash: bigint, monthlyBurn: bigint): number | null {
  if (monthlyBurn <= 0n) return null;
  return Math.round((Number(cash) / Number(monthlyBurn)) * 100) / 100;
}

function fixedBudgetAccount(accountName: string): boolean {
  return /\b(rent|mortgage|utilities?|insurance|loan|debt|phone|internet|subscription|tax|property tax|childcare|daycare|tuition)\b/i.test(accountName);
}

function spendableAssetAccountDefaults(ledger: Ledger): { selected: string[]; excluded: string[]; rule: string } {
  const roots = rootAccountIds(ledger, ["asset"]);
  const assetAccounts = ledger.listAccounts().filter((row) => row.account_type === "asset");
  const accountMap = new Map(assetAccounts.map((row) => [row.id, row]));
  const accountName = (accountId: string) => ledger.getAccount(accountId)?.name ?? "";
  const illiquid = /\b(brokerage|investment|investing|security|securities|stock|stocks|crypto|coinbase|retirement|tfsa|rrsp|rsp|401k|ira|roth|pension|property|real estate|vehicle)\b/i;
  const cashLike = /\b(cash|checking|chequing|savings?|bank|operating|wallet)\b/i;
  const hasIlliquidName = (accountId: string): boolean => {
    let current: string | null | undefined = accountId;
    while (current) {
      if (illiquid.test(accountName(current))) return true;
      current = accountMap.get(current)?.parent_id ?? null;
    }
    return false;
  };
  const selectedAncestors = (selectedIds: string[]): Set<string> => {
    const ancestors = new Set<string>();
    for (const selected of selectedIds) {
      let current = accountMap.get(selected)?.parent_id ?? null;
      while (current) {
        ancestors.add(current);
        current = accountMap.get(current)?.parent_id ?? null;
      }
    }
    return ancestors;
  };
  const liquid = assetAccounts.filter((row) => cashLike.test(row.name) && !hasIlliquidName(row.id)).map((row) => row.id);
  const selected = nonOverlappingAccounts(ledger, liquid.length > 0 ? liquid : roots.filter((accountId) => !hasIlliquidName(accountId)), ["asset"]);
  const covered = new Set(selected);
  for (const selectedId of selected) for (const child of ledger.descendants(selectedId)) covered.add(child);
  const ancestors = selectedAncestors(selected);
  return {
    selected,
    excluded: assetAccounts.map((row) => row.id).filter((accountId) => !covered.has(accountId) && !ancestors.has(accountId)),
    rule: liquid.length > 0
      ? "cash-like asset accounts, excluding obvious investment and illiquid account names"
      : "root asset accounts excluding obvious investment and illiquid account names"
  };
}

function trailingWindowEnd(year: number, month: number, asOf: string, includePartialMonth: boolean): Row {
  if (includePartialMonth || monthEnd(year, month) < asOf) {
    return { year, month, basis: includePartialMonth ? "requested_month_including_partial" : "requested_month_complete", excluded_partial_month: null };
  }
  const previous = addMonths(year, month, -1);
  return {
    ...previous,
    basis: "last_complete_months",
    excluded_partial_month: { year, month, as_of: asOf }
  };
}

function trailingSpend(ledger: Ledger, year: number, month: number, months: number, quote: string, includeSources = false): Row {
  const monthRows: Row[] = [];
  const missing: Row[] = [];
  for (let offset = months - 1; offset >= 0; offset -= 1) {
    const period = addMonths(year, month, -offset);
    const result = spendingRows(ledger, period.year, period.month, "posted", quote, true) as { rows: Row[]; missing: Row[] };
    const total = result.rows.reduce((sum, row) => sum + BigInt(row.amount_cents), 0n);
    monthRows.push({ year: period.year, month: period.month, spending_cents: total, ...(includeSources ? { categories: result.rows } : {}) });
    missing.push(...result.missing);
  }
  const total = monthRows.reduce((sum, row) => sum + BigInt(row.spending_cents), 0n);
  return {
    months,
    total_cents: total,
    monthly_burn_cents: total / BigInt(months),
    month_rows: monthRows,
    missing_conversions: missing
  };
}

function trailingSummary(row: Row): Row {
  return {
    months: row.months,
    total_cents: row.total_cents,
    monthly_burn_cents: row.monthly_burn_cents,
    month_rows: row.month_rows,
    missing_conversion_count: (row.missing_conversions as Row[] ?? []).length
  };
}

function budgetSummary(row: Row): Row {
  return {
    total_budgeted_cents: row.total_budgeted_cents ?? 0n,
    total_spent_cents: row.total_spent_cents ?? 0n,
    total_remaining_cents: row.total_remaining_cents ?? 0n,
    budget_count: (row.budgets as Row[] ?? []).length,
    valuation_complete: row.valuation_complete,
    missing_conversion_count: (row.missing_conversions as Row[] ?? []).length
  };
}

function cashProjectionSummary(row: Row): Row {
  return {
    basis: row.basis,
    actual_available_cash_cents: row.actual_available_cash_cents,
    available_cash_cents: row.available_cash_cents,
    pending_available_delta_cents: row.pending_available_delta_cents,
    planned_available_delta_cents: row.planned_available_delta_cents,
    earmarks_cents: row.earmarks_cents,
    liability_effect_cents: row.liability_effect_cents,
    remaining_budget_cents: row.remaining_budget_cents,
    planned_income_cents: row.planned_income_cents,
    realized_planned_count: row.realized_planned_count,
    warnings: row.warnings,
    valuation_complete: row.valuation_complete,
    missing_conversion_count: (row.missing_conversions as Row[] ?? []).length
  };
}

function positive(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

function budgetBurn(ledger: Ledger, year: number, month: number, quote: string, includePending: boolean): Row {
  const budget = handlers.budget_summary(ledger, { year, month, quote_asset_id: quote, include_pending: includePending }) as Row;
  const budgets = (budget.budgets as Row[]) ?? [];
  const fixedRows = budgets.filter((row) => fixedBudgetAccount(String(row.account_name ?? ledger.getAccount(String(row.account_id))?.name ?? "")));
  const fixed = fixedRows.reduce((sum, row) => sum + BigInt(row.budgeted_cents), 0n);
  return {
    budget,
    monthly_burn_cents: BigInt(budget.total_budgeted_cents ?? 0),
    fixed_budget_cents: fixed,
    discretionary_budget_cents: BigInt(budget.total_budgeted_cents ?? 0) - fixed,
    fixed_budget_rows: fixedRows
  };
}

function scaleBigint(value: bigint, multiplier: number): bigint {
  return value * BigInt(Math.round(multiplier * 10000)) / 10000n;
}

function parseCsv(text: string): Row[] {
  // Statement imports use a bounded CSV parser instead of accepting arbitrary
  // file sizes or column counts through MCP.
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) return [];
  const split = (line: string, lineNumber: number) => {
    const cells: string[] = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quoted && ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = !quoted;
      else if (ch === "," && !quoted) {
        cells.push(cell);
        cell = "";
      } else cell += ch;
    }
    if (quoted) throw new Error(`Invalid CSV quote on line ${lineNumber}`);
    cells.push(cell);
    if (cells.length > MAX_CSV_COLUMNS) throw new Error(`CSV has too many columns; maximum is ${MAX_CSV_COLUMNS}`);
    return cells;
  };
  const headers = split(lines[0], 1).map((h) => h.trim());
  if (headers.length > MAX_CSV_COLUMNS) throw new Error(`CSV has too many columns; maximum is ${MAX_CSV_COLUMNS}`);
  const rows = lines.slice(1);
  if (rows.length > MAX_IMPORT_ROWS) throw new Error(`CSV has too many rows; maximum is ${MAX_IMPORT_ROWS}`);
  return rows.map((line, index) => Object.fromEntries(split(line, index + 2).map((value, i) => [headers[i] || `col_${i}`, value.trim()])).valueOf() as Row & { index: number }).map((row, index) => ({ ...row, index }));
}

function trimCsvWrapperRows(text: string, skipRows: number, skipFooterRows: number): string {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  while (lines.length > 0 && String(lines.at(-1) ?? "").trim() === "") lines.pop();
  const start = Math.max(0, skipRows);
  const end = skipFooterRows > 0 ? Math.max(start, lines.length - skipFooterRows) : lines.length;
  return lines.slice(start, end).join("\n");
}

const MONTHS = new Map([
  ["january", 1], ["jan", 1],
  ["february", 2], ["feb", 2],
  ["march", 3], ["mar", 3],
  ["april", 4], ["apr", 4],
  ["may", 5],
  ["june", 6], ["jun", 6],
  ["july", 7], ["jul", 7],
  ["august", 8], ["aug", 8],
  ["september", 9], ["sep", 9], ["sept", 9],
  ["october", 10], ["oct", 10],
  ["november", 11], ["nov", 11],
  ["december", 12], ["dec", 12]
]);

function normalizedDate(year: number, month: number, day: number): string {
  return validateDate(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
}

function parseImportDate(value: string, format: unknown, rowIndex: number): string {
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return validateDate(text);
  const mode = String(format ?? "auto").toLowerCase();
  const monthName = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(text);
  if (monthName) {
    const month = MONTHS.get(monthName[1].toLowerCase());
    if (!month) throw new Error(`Invalid date on row ${rowIndex}: ${value}`);
    return normalizedDate(Number(monthName[3]), month, Number(monthName[2]));
  }
  const numeric = /^(\d{1,4})[/-](\d{1,2})[/-](\d{1,4})$/.exec(text);
  if (!numeric) throw new Error(`Invalid date on row ${rowIndex}: ${value}`);
  const first = Number(numeric[1]);
  const second = Number(numeric[2]);
  const third = Number(numeric[3]);
  if (numeric[1].length === 4) return normalizedDate(first, second, third);
  if (numeric[3].length !== 4) throw new Error(`Invalid date on row ${rowIndex}: ${value}`);
  if (mode === "mdy") return normalizedDate(third, first, second);
  if (mode === "dmy") return normalizedDate(third, second, first);
  if (mode === "iso") throw new Error(`date must be YYYY-MM-DD on row ${rowIndex}`);
  if (mode !== "auto") throw new Error("date_format must be auto, iso, mdy, or dmy");
  if (first > 12 && second <= 12) return normalizedDate(third, second, first);
  if (second > 12 && first <= 12) return normalizedDate(third, first, second);
  throw new Error(`Ambiguous date on row ${rowIndex}: ${value}; pass date_format mdy or dmy`);
}

function qfxTag(block: string, tag: string): string {
  const paired = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i").exec(block)?.[1];
  if (paired != null) return paired.trim();
  return new RegExp(`<${tag}>([^<\\r\\n]*)`, "i").exec(block)?.[1]?.trim() ?? "";
}

function qfxDate(value: string, index: number): string {
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(value);
  if (!match) throw new Error(`Invalid QFX date on row ${index}`);
  return validateDate(`${match[1]}-${match[2]}-${match[3]}`);
}

function parseQfx(text: string): Row[] {
  const blocks = [...text.matchAll(/<STMTTRN>([\s\S]*?)(?:<\/STMTTRN>|(?=<STMTTRN>)|<\/BANKTRANLIST>|<\/CCSTMTRS>|$)/gi)].map((match) => match[1]);
  if (blocks.length > MAX_IMPORT_ROWS) throw new Error(`QFX has too many rows; maximum is ${MAX_IMPORT_ROWS}`);
  return blocks.map((block, index) => {
    const amount = Number(qfxTag(block, "TRNAMT"));
    if (!Number.isFinite(amount)) throw new Error(`Invalid QFX amount on row ${index}`);
    const name = qfxTag(block, "NAME");
    const memo = qfxTag(block, "MEMO");
    return {
      index,
      date: qfxDate(qfxTag(block, "DTPOSTED") || qfxTag(block, "DTUSER"), index),
      amount,
      description: name || memo || qfxTag(block, "FITID"),
      external_id: qfxTag(block, "FITID") || null,
      tags: Object.fromEntries([
        ["qfx_fitid", qfxTag(block, "FITID")],
        ["qfx_type", qfxTag(block, "TRNTYPE")]
      ].filter(([, value]) => value !== ""))
    };
  });
}

function parseStatementFile(ledger: Ledger, filePath: string, args: Args = {}): { rows: Row[]; file_name: string; file_sha256: string } {
  const file = resolveToolReadPath(ledger.path, filePath, new Set([".csv", ".qfx", ".ofx"]));
  const text = readFileSync(file, "utf8");
  const extension = extname(file).toLowerCase();
  const statementType = String(args.statement_type ?? "").toLowerCase();
  if (extension === ".qfx" || extension === ".ofx" || statementType === "qfx" || statementType === "ofx") {
    return { rows: parseQfx(text), file_name: basename(file), file_sha256: createHash("sha256").update(text).digest("hex") };
  }
  const rows = parseCsv(trimCsvWrapperRows(text, Number(args.skip_rows ?? 0), Number(args.skip_footer_rows ?? 0)));
  const dateCol = args.date_col || "date";
  const amountCol = args.amount_col || "amount";
  const descCol = args.desc_col || "description";
  const inflowCol = args.inflow_col;
  const outflowCol = args.outflow_col;
  const counterpartCol = args.counterpart_col;
  const tagCols = args.tag_cols ?? {};
  return { rows: rows.map((row, index) => {
    let amount = amountCol in row ? Number(row[amountCol]) : 0;
    if (inflowCol && row[inflowCol] !== "") amount = Number(row[inflowCol]);
    if (outflowCol && row[outflowCol] !== "") amount = -Math.abs(Number(row[outflowCol]));
    if (args.amount_convention === "unsigned_charges") amount = -Math.abs(amount);
    if (!Number.isFinite(amount)) throw new Error(`Invalid amount on row ${index}`);
    return {
      index,
      date: parseImportDate(String(row[dateCol]), args.date_format, index),
      amount,
      description: String(row[descCol] ?? ""),
      counterpart_ref: counterpartCol ? String(row[counterpartCol] ?? "") : "",
      tags: Object.fromEntries(Object.entries(tagCols).map(([key, col]) => [key, String(row[String(col)] ?? "")]).filter(([, value]) => value !== ""))
    };
  }), file_name: basename(file), file_sha256: createHash("sha256").update(text).digest("hex") };
}

function parseStatementRows(ledger: Ledger, filePath: string, args: Args = {}): Row[] {
  return parseStatementFile(ledger, filePath, args).rows;
}

function selectStatementRows(rows: Row[], args: Args = {}): Row[] {
  if (!Array.isArray(args.row_indexes)) return rows;
  const selected = new Set(args.row_indexes.map((index) => Number(index)));
  return rows.filter((row) => selected.has(Number(row.index)));
}

function importTransactionRows(ledger: Ledger, accountId: string, counterpartId: string, rows: Row[], options: Args = {}) {
  // Statement amounts are signed relative to the statement account: positive
  // amounts debit the account, negative amounts credit it.
  const status = parseTxStatus(options.status ?? "pending") ?? "pending";
  const assetId = options.asset_id ? explicitAsset(ledger, options.asset_id) : options.currency ? asset(ledger, null, options.currency) : accountAsset(ledger, accountId);
  const created: Row[] = [];
  const errors: Row[] = [];
  let skipped = 0;
  const existing = existingImportFingerprints(ledger, accountId, assetId);
  rows.forEach((row, index) => {
    try {
      const rowCounterpart = row.counterpart_ref ? account(ledger, String(row.counterpart_ref)) : row.counterpart_id ? account(ledger, String(row.counterpart_id)) : counterpartId;
      const signed = signedStatementQuantity(ledger, assetId, row, options.amount_convention);
      const fingerprint = importFingerprint(row, signed);
      if (!options.skip_dedup && existing.has(fingerprint)) { skipped += 1; return; }
      const postOptions = {
        sourceId: options.source_id ? String(options.source_id) : null,
        externalId: row.external_id ? String(row.external_id) : null
      };
      const tx = signed >= 0n
        ? ledger.recordTransaction(String(row.date), signed, rowCounterpart, accountId, assetId, String(row.description ?? ""), status, postOptions)
        : ledger.recordTransaction(String(row.date), -signed, accountId, rowCounterpart, assetId, String(row.description ?? ""), status, postOptions);
      for (const [key, value] of Object.entries(row.tags ?? {})) tagTx(ledger, tx.id, key, String(value));
      created.push(txPublic(ledger, tx));
      existing.add(fingerprint);
    } catch (error) {
      errors.push({ index, error: error instanceof Error ? error.message : String(error) });
    }
  });
  return { created: created.length, transactions: created, errors, skipped, dry_run: false };
}

function signedStatementQuantity(ledger: Ledger, assetId: string, row: Row, amountConvention?: unknown): bigint {
  const quantity = row.amount_cents != null || row.quantity != null
    ? BigInt(row.amount_cents ?? row.quantity)
    : amountToQuantity(ledger, assetId, row.amount ?? 0);
  return amountConvention === "unsigned_charges" ? -((quantity < 0n) ? -quantity : quantity) : quantity;
}

function journalLegQuantity(ledger: Ledger, assetId: string, leg: Row): bigint {
  if (leg.amount != null) return amountToQuantity(ledger, assetId, leg.amount);
  if (leg.amount_cents != null) return BigInt(leg.amount_cents as string | number | bigint | boolean);
  if (leg.quantity != null) return BigInt(leg.quantity as string | number | bigint | boolean);
  if (leg.qty_cents != null) return BigInt(leg.qty_cents as string | number | bigint | boolean);
  if (leg.qty != null) return BigInt(leg.qty as string | number | bigint | boolean);
  return 0n;
}

function importFingerprint(row: Row, signed: bigint): string {
  return `${row.date}|${signed}|${String(row.description ?? "").toLowerCase()}`;
}

function existingImportFingerprints(ledger: Ledger, accountId: string, assetId: string): Set<string> {
  return new Set(ledger.listTransactions({ status: "active" }).map((tx) => {
    const amount = amountForAccount(ledger, tx.id, accountId, assetId);
    return importFingerprint(tx, amount);
  }));
}

function importableStatementDelta(ledger: Ledger, accountId: string, assetId: string, rows: Row[], options: Args = {}): { rows: Row[]; delta: bigint } {
  const existing = existingImportFingerprints(ledger, accountId, assetId);
  let delta = 0n;
  const importable: Row[] = [];
  for (const row of rows) {
    const signed = signedStatementQuantity(ledger, assetId, row, options.amount_convention);
    const fingerprint = importFingerprint(row, signed);
    if (!options.skip_dedup && existing.has(fingerprint)) continue;
    existing.add(fingerprint);
    delta += signed;
    importable.push(row);
  }
  return { rows: importable, delta };
}

function safeJson(value: unknown): Row {
  if (value == null || value === "") return {};
  if (typeof value === "object") return value as Row;
  try {
    const parsed = JSON.parse(String(value));
    return typeof parsed === "object" && parsed != null ? parsed as Row : {};
  } catch {
    return {};
  }
}

function statementRowHash(row: Row, quantity: bigint): string {
  return createHash("sha256").update(JSON.stringify({
    index: row.index ?? row.row_index ?? null,
    date: row.date,
    quantity: quantity.toString(),
    description: String(row.description ?? "").trim(),
    external_id: row.external_id ?? null
  })).digest("hex");
}

function signedRowEntries(ledger: Ledger, accountId: string, counterpartId: string, assetId: string, row: Row, status: string, amountConvention?: unknown): Row {
  const signed = signedStatementQuantity(ledger, assetId, row, amountConvention);
  const abs = signed < 0n ? -signed : signed;
  const fromAccountId = signed >= 0n ? counterpartId : accountId;
  const toAccountId = signed >= 0n ? accountId : counterpartId;
  return {
    id: null,
    date: row.date,
    status,
    description: String(row.description ?? ""),
    external_id: row.external_id ?? null,
    amount_cents: abs,
    quantity: signed,
    entries: [
      { account_id: fromAccountId, asset_id: assetId, quantity: -abs, amount_cents: -abs },
      { account_id: toAccountId, asset_id: assetId, quantity: abs, amount_cents: abs }
    ],
    tags: Object.entries(row.tags ?? {}).map(([key, value]) => ({ key, value }))
  };
}

function counterpartForRow(ledger: Ledger, row: Row, fallback?: string | null): string | null {
  if (row.counterpart_ref) return account(ledger, String(row.counterpart_ref));
  if (row.counterpart_id) return account(ledger, String(row.counterpart_id));
  const matched = ledger.autoCategorize(String(row.description ?? ""));
  if (matched) return matched;
  return fallback ?? null;
}

function importPreview(ledger: Ledger, accountId: string, counterpartId: string | null, rows: Row[], options: Args = {}): Row {
  const status = parseTxStatus(options.status ?? "pending") ?? "pending";
  const assetId = options.asset_id ? explicitAsset(ledger, options.asset_id) : options.currency ? asset(ledger, null, options.currency) : accountAsset(ledger, accountId);
  const existing = existingImportFingerprints(ledger, accountId, assetId);
  const transactions: Row[] = [];
  const duplicates: Row[] = [];
  const errors: Row[] = [];
  let balanceImpact = 0n;
  rows.forEach((row, index) => {
    try {
      const rowCounterpart = counterpartForRow(ledger, row, counterpartId);
      if (!rowCounterpart) throw new Error("counterpart_id is required");
      const signed = signedStatementQuantity(ledger, assetId, row, options.amount_convention);
      const fingerprint = importFingerprint(row, signed);
      if (!options.skip_dedup && existing.has(fingerprint)) {
        duplicates.push({ index, row_index: row.index ?? index, fingerprint, date: row.date, quantity: signed, description: row.description });
        return;
      }
      existing.add(fingerprint);
      balanceImpact += signed;
      transactions.push({
        ...signedRowEntries(ledger, accountId, rowCounterpart, assetId, row, status, options.amount_convention),
        row_index: row.index ?? index,
        counterpart_account_id: rowCounterpart,
        would_create: true
      });
    } catch (error) {
      errors.push({ index, row_index: row.index ?? index, error: error instanceof Error ? error.message : String(error) });
    }
  });
  return {
    created: 0,
    imported: 0,
    skipped: duplicates.length,
    would_create: transactions.length,
    transactions,
    duplicates,
    errors,
    dry_run: true,
    batch_id: null,
    batch_label: options.batch_label ?? null,
    balance_impact_cents: balanceImpact,
    transfer_stats: { matched: 0, unmatched: 0 }
  };
}

function statementCandidates(ledger: Ledger, accountId: string, assetId: string, row: Row, quantity: bigint, tolerance: number): Journal[] {
  const rows = ledger.listTransactions({ status: null })
    .filter((tx) => tx.status !== "void" && ["posted", "pending"].includes(tx.status))
    .filter((tx) => amountForAccount(ledger, tx.id, accountId, assetId) === quantity);
  if (row.external_id) {
    const external = rows.filter((tx) => tx.external_id === String(row.external_id));
    if (external.length > 0) return external;
  }
  const dated = rows.filter((tx) => dateDeltaDays(tx.date, String(row.date)) <= tolerance);
  if (dated.length <= 1) return dated;
  const description = String(row.description ?? "").trim().toLowerCase();
  const sameDescription = dated.filter((tx) => tx.description.trim().toLowerCase() === description);
  return sameDescription.length === 1 ? sameDescription : dated;
}

function statementCandidateSummary(ledger: Ledger, accountId: string, assetId: string, row: Row, quantity: bigint, tolerance: number, tx: Journal): Row {
  const matchedQuantity = amountForAccount(ledger, tx.id, accountId, assetId);
  const date_delta_days = dateDeltaDays(tx.date, String(row.date));
  const sameDescription = tx.description.trim().toLowerCase() === String(row.description ?? "").trim().toLowerCase();
  const externalMatch = row.external_id != null && row.external_id !== "" && tx.external_id === String(row.external_id);
  const reasons = [
    matchedQuantity === quantity ? "amount" : null,
    date_delta_days <= tolerance ? "date_tolerance" : null,
    sameDescription ? "description" : null,
    externalMatch ? "external_id" : null
  ].filter(Boolean);
  const score = (matchedQuantity === quantity ? 60 : 0) + (date_delta_days <= tolerance ? 20 : 0) + (sameDescription ? 15 : 0) + (externalMatch ? 25 : 0);
  return {
    journal_id: tx.id,
    date: tx.date,
    description: tx.description,
    status: tx.status,
    external_id: tx.external_id ?? null,
    amount_cents: matchedQuantity,
    date_delta_days,
    score,
    reasons
  };
}

function normalizedDescription(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function compatibleDescription(left: unknown, right: unknown): boolean {
  const a = normalizedDescription(left);
  const b = normalizedDescription(right);
  if (!a || !b) return true;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const aTokens = new Set(a.split(" ").filter((token) => token.length >= 3));
  const bTokens = b.split(" ").filter((token) => token.length >= 3);
  if (aTokens.size === 0 || bTokens.length === 0) return false;
  const overlap = bTokens.filter((token) => aTokens.has(token)).length;
  return overlap >= Math.min(2, aTokens.size, bTokens.length);
}

function txTouchesAccountTree(ledger: Ledger, txId: string, accountIds: Set<string>): boolean {
  return ledger.getEntries(txId).some((entry) => accountIds.has(entry.account_id));
}

function realizedPlannedRows(ledger: Ledger, args: Args = {}): Row[] {
  const tolerance = Number(args.date_tolerance_days ?? 3);
  const [monthStart, monthFinish] = args.year == null ? [null, null] : monthBounds(Number(args.year), args.month == null ? null : Number(args.month));
  const dateFrom = optionalDate(args.date_from) ?? monthStart;
  const dateTo = optionalDate(args.date_to) ?? monthFinish;
  const explicitAccountIds = args.account_ids
    ? new Set((args.account_ids as string[]).flatMap((ref) => [...ledger.descendants(account(ledger, ref))]))
    : args.account_id
      ? ledger.descendants(account(ledger, args.account_id))
      : null;
  const assetId = args.asset_id ? explicitAsset(ledger, args.asset_id) : null;
  const planned = ledger.listTransactions({ status: "planned", dateFrom, dateTo, sort: "date_asc" })
    .filter((tx) => !explicitAccountIds || txTouchesAccountTree(ledger, tx.id, explicitAccountIds));
  const landed = ledger.listTransactions({ status: "active", sort: "date_asc" })
    .filter((tx) => tx.status === "posted" || tx.status === "pending")
    .filter((tx) => !explicitAccountIds || txTouchesAccountTree(ledger, tx.id, explicitAccountIds));
  const rows: Row[] = [];
  for (const plannedTx of planned) {
    const plannedEntries = ledger.getEntries(plannedTx.id)
      .filter((entry) => (!explicitAccountIds || explicitAccountIds.has(entry.account_id)) && (!assetId || entry.asset_id === assetId));
    if (plannedEntries.length === 0) continue;
    const candidates: Row[] = [];
    for (const landedTx of landed) {
      if (landedTx.id === plannedTx.id) continue;
      if (dateDeltaDays(plannedTx.date, landedTx.date) > tolerance) continue;
      if (!compatibleDescription(plannedTx.description, landedTx.description)) continue;
      for (const plannedEntry of plannedEntries) {
        const landedQuantity = amountForAccount(ledger, landedTx.id, plannedEntry.account_id, plannedEntry.asset_id);
        if (landedQuantity !== plannedEntry.quantity) continue;
        candidates.push({
          journal_id: landedTx.id,
          tx_id: landedTx.id,
          date: landedTx.date,
          description: landedTx.description,
          status: landedTx.status,
          account_id: plannedEntry.account_id,
          asset_id: plannedEntry.asset_id,
          amount_cents: landedQuantity,
          date_delta_days: dateDeltaDays(plannedTx.date, landedTx.date),
          reasons: ["account", "amount", "date_tolerance", "description"]
        });
      }
    }
    if (candidates.length === 0) continue;
    const uniqueCandidates = [...new Map(candidates.map((candidate) => [candidate.journal_id, candidate])).values()];
    const primary = uniqueCandidates[0];
    rows.push({
      planned_tx_id: plannedTx.id,
      tx_id: plannedTx.id,
      date: plannedTx.date,
      description: plannedTx.description,
      status: plannedTx.status,
      matched_tx_id: primary.journal_id,
      matched_status: primary.status,
      matched_date: primary.date,
      matched_description: primary.description,
      account_id: primary.account_id,
      asset_id: primary.asset_id,
      amount_cents: primary.amount_cents,
      candidates: uniqueCandidates,
      ambiguous: uniqueCandidates.length > 1
    });
  }
  return rows;
}

function quotedPlannedUnrealized(ledger: Ledger, accountId: string, quote: string, asOf: string, dateFrom: string | null, realizedIds: Set<string>, missing: Row[]): bigint {
  const rootType = ledger.getAccount(accountId)?.account_type;
  const accountIds = new Set([...ledger.descendants(accountId)].filter((id) => ledger.getAccount(id)?.account_type === rootType));
  let total = 0n;
  for (const tx of ledger.listTransactions({ status: "planned", dateFrom, dateTo: asOf, sort: "date_asc" })) {
    if (realizedIds.has(tx.id)) continue;
    for (const entry of ledger.getEntries(tx.id).filter((line) => accountIds.has(line.account_id))) {
      const [converted, error] = ledger.tryConvertQuantity(entry.quantity, entry.asset_id, quote, tx.date);
      if (converted == null) missing.push({ tx_id: tx.id, account_id: entry.account_id, asset_id: entry.asset_id, quote_asset_id: quote, quantity: entry.quantity, error });
      else total += converted;
    }
  }
  return total;
}

function planRow(row: Row, action: string, quantity: bigint, counterpartId: string | null, reason: string, matchedId?: string | null, extraMetadata: Row = {}): Row {
  return {
    row_index: Number(row.index ?? row.row_index ?? 0),
    date: row.date,
    quantity,
    description: String(row.description ?? ""),
    external_id: row.external_id ?? null,
    row_hash: statementRowHash(row, quantity),
    action,
    matched_journal_id: matchedId ?? null,
    counterpart_account_id: counterpartId,
    reason,
    metadata: {
      amount: row.amount ?? null,
      tags: row.tags ?? {},
      source_row: row,
      ...extraMetadata
    }
  };
}

function planRowsByAction(rows: Row[]): Record<string, Row[]> {
  const grouped: Record<string, Row[]> = {};
  for (const row of rows) {
    const action = String(row.action);
    grouped[action] = [...(grouped[action] ?? []), row];
  }
  return grouped;
}

function publicPlanRows(rows: Row[]): Row[] {
  return rows.map((row) => {
    const metadata = safeJson(row.metadata_json ?? row.metadata);
    const sourceRow = safeJson(metadata.source_row);
    const quantity = BigInt(row.quantity as string | number | bigint | boolean);
    return {
      ...row,
      metadata,
      quantity,
      amount_cents: quantity,
      amount: sourceRow.amount ?? metadata.amount ?? null,
      candidates: metadata.candidates ?? []
    };
  });
}

function userFacingLiabilityBalance(args: Args): boolean {
  const statementType = String(args.statement_type ?? "").toLowerCase().replace(/[\s_-]+/g, "");
  const balanceSign = String(args.balance_sign ?? args.balance_basis ?? "").toLowerCase().replace(/[\s_-]+/g, "");
  return ["creditcard", "cardstatement", "liabilitystatement"].includes(statementType) || ["statement", "userfacing", "positive"].includes(balanceSign);
}

function expectedStatementBalance(ledger: Ledger, accountId: string, assetId: string, args: Args): bigint | null {
  if (args.expected_balance == null) return null;
  let expected = amountToQuantity(ledger, assetId, args.expected_balance);
  const accountRow = ledger.getAccount(accountId);
  if (accountRow?.account_type === "liability" && expected > 0n && userFacingLiabilityBalance(args)) expected = -expected;
  return expected;
}

function statementPlanOutput(plan: Row | null, rows: Row[], extra: Row = {}): Row {
  const publicRows = publicPlanRows(rows);
  const grouped = planRowsByAction(publicRows);
  const summary = Object.fromEntries(["matched", "pending_to_commit", "new_posted", "new_pending", "stale_pending_to_void", "ambiguous", "ignored"].map((action) => [action, grouped[action]?.length ?? 0]));
  const realizedPlannedRows = (extra.realized_planned_rows as Row[] | undefined) ?? [];
  const warnings = [
    ...(summary.ambiguous > 0 ? ["ambiguous rows require manual review"] : []),
    ...(realizedPlannedRows.length > 0 ? ["realized planned rows should be reconciled or voided before planned projections"] : [])
  ];
  return {
    plan_id: plan?.id ?? null,
    status: plan?.status ?? "preview",
    account_id: plan?.account_id ?? extra.account_id,
    asset_id: plan?.asset_id ?? extra.asset_id,
    expected_balance_cents: plan?.expected_balance ?? extra.expected_balance_cents ?? null,
    planned_balance_cents: plan?.planned_balance ?? extra.planned_balance_cents ?? null,
    applied_balance_cents: plan?.applied_balance ?? null,
    balance_matches: extra.balance_matches ?? null,
    balance_sign: extra.balance_sign ?? null,
    rows: publicRows.slice(0, extra.sample_limit ?? 20),
    total_rows: publicRows.length,
    actions: summary,
    matched: summary.matched,
    unmatched: summary.new_posted + summary.new_pending + summary.pending_to_commit + summary.stale_pending_to_void + summary.ambiguous,
    reconciled: summary.new_posted + summary.new_pending + summary.pending_to_commit + summary.stale_pending_to_void + summary.ambiguous === 0,
    matched_rows: grouped.matched ?? [],
    pending_to_commit: grouped.pending_to_commit ?? [],
    stale_pending_to_void: grouped.stale_pending_to_void ?? [],
    new_posted: grouped.new_posted ?? [],
    new_pending: grouped.new_pending ?? [],
    ambiguous: grouped.ambiguous ?? [],
    ignored: grouped.ignored ?? [],
    realized_planned_rows: realizedPlannedRows,
    realized_planned_count: realizedPlannedRows.length,
    warnings,
    dry_run: extra.dry_run ?? true,
    ...extra
  };
}

function buildStatementPlan(ledger: Ledger, args: Args, options: { persist?: boolean; targetStatus?: TxStatus | string; rows?: Row[]; file?: Row } = {}): Row {
  const statementFile = options.file ?? (args.file_path ? parseStatementFile(ledger, args.file_path, args) : { rows: args.transactions ?? [], file_name: "", file_sha256: "" });
  const selectedRows = selectStatementRows(options.rows ?? statementFile.rows, args);
  const accountId = account(ledger, args.account_id);
  const assetId = args.asset_id ? explicitAsset(ledger, args.asset_id) : args.currency ? asset(ledger, null, args.currency) : accountAsset(ledger, accountId);
  const targetStatus = parseTxStatus(String(options.targetStatus ?? args.status ?? "posted")) ?? "posted";
  const counterpartId = args.counterpart_account_id || args.counterpart_id ? account(ledger, args.counterpart_account_id ?? args.counterpart_id) : null;
  const tolerance = Number(args.date_tolerance_days ?? 3);
  const planRows: Row[] = [];
  let plannedDelta = 0n;

  for (const row of selectedRows) {
    const quantity = signedStatementQuantity(ledger, assetId, row, args.amount_convention);
    const rowCounterpart = counterpartForRow(ledger, row, counterpartId);
    const candidates = statementCandidates(ledger, accountId, assetId, row, quantity, tolerance);
    if (candidates.length === 1) {
      const matched = candidates[0];
      if (matched.status === "pending" && targetStatus === "posted") {
        planRows.push(planRow(row, "pending_to_commit", quantity, rowCounterpart, "matched pending transaction", matched.id));
        plannedDelta += quantity;
      } else {
        planRows.push(planRow(row, "matched", quantity, rowCounterpart, "matched existing transaction", matched.id));
      }
    } else if (candidates.length > 1) {
      planRows.push(planRow(row, "ambiguous", quantity, rowCounterpart, "multiple matching transactions", null, {
        candidates: candidates.map((tx) => statementCandidateSummary(ledger, accountId, assetId, row, quantity, tolerance, tx))
      }));
    } else if (!rowCounterpart) {
      planRows.push(planRow(row, "ambiguous", quantity, null, "counterpart account could not be resolved", null));
    } else if (targetStatus === "pending") {
      planRows.push(planRow(row, "new_pending", quantity, rowCounterpart, "new pending transaction", null));
      plannedDelta += quantity;
    } else {
      planRows.push(planRow(row, "new_posted", quantity, rowCounterpart, "new posted transaction", null));
      plannedDelta += quantity;
    }
  }

  const usedPending = new Set(planRows.filter((row) => row.action === "pending_to_commit").map((row) => String(row.matched_journal_id)));
  const syntheticStart = selectedRows.reduce((max, row) => Math.max(max, Number(row.index ?? 0)), -1) + 1;
  for (const [offset, row] of ((args.pending_transactions ?? []) as Row[]).entries()) {
    const pendingRow = { ...row, index: syntheticStart + offset, date: parseImportDate(String(row.date), args.date_format, syntheticStart + offset) };
    const quantity = signedStatementQuantity(ledger, assetId, pendingRow, "unsigned_charges");
    const pendingFallback = args.counterpart_id || args.counterpart_account_id
      ? account(ledger, args.counterpart_id ?? args.counterpart_account_id)
      : ledger.findAccount("Pending Expenses")?.id ?? null;
    const rowCounterpart = counterpartForRow(ledger, pendingRow, pendingFallback);
    planRows.push(planRow(pendingRow, rowCounterpart ? "new_pending" : "ambiguous", quantity, rowCounterpart, rowCounterpart ? "new pending transaction" : "counterpart account could not be resolved", null));
    if (targetStatus === "pending" && rowCounterpart) plannedDelta += quantity;
  }

  if (args.void_stale_pending === true) {
    const dateValues = selectedRows.map((row) => String(row.date)).sort();
    const dateFrom = args.date_from ?? dateValues[0] ?? null;
    const dateTo = args.date_to ?? dateValues.at(-1) ?? null;
    let staleIndex = syntheticStart + ((args.pending_transactions ?? []) as Row[]).length;
    for (const tx of ledger.listTransactions({ status: "pending", dateFrom, dateTo })) {
      if (usedPending.has(tx.id)) continue;
      const quantity = amountForAccount(ledger, tx.id, accountId, assetId);
      if (quantity === 0n) continue;
      planRows.push(planRow({ index: staleIndex++, date: tx.date, description: tx.description, external_id: tx.external_id }, "stale_pending_to_void", quantity, null, "pending transaction not present in refreshed statement", tx.id));
    }
  }

  const selectedDates = selectedRows.map((row) => String(row.date)).sort();
  const realizedDateFrom = args.date_from ?? (selectedDates[0] ? addDays(selectedDates[0], -tolerance) : null);
  const realizedDateTo = args.date_to ?? (selectedDates.at(-1) ? addDays(String(selectedDates.at(-1)), tolerance) : null);
  const realizedPlanned = realizedPlannedRows(ledger, {
    account_id: accountId,
    asset_id: assetId,
    date_from: realizedDateFrom,
    date_to: realizedDateTo,
    date_tolerance_days: tolerance
  });
  const baseStatus = targetStatus === "pending" ? "pending" : "posted";
  const plannedBalance = ledger.balanceTree(accountId, assetId, null, baseStatus) + plannedDelta;
  const expected = expectedStatementBalance(ledger, accountId, assetId, args);
  const balanceMatches = expected == null ? null : expected === plannedBalance;
  if (expected != null && !balanceMatches && args.require_balance_match !== false) throw new Error(`expected_balance mismatch: expected ${expected}, actual ${plannedBalance}`);
  const metadata = {
    target_status: targetStatus,
    amount_convention: args.amount_convention ?? "signed",
    date_tolerance_days: tolerance,
    void_stale_pending: args.void_stale_pending === true,
    statement_type: args.statement_type ?? null
  };
  const persisted = options.persist ? ledger.createStatementPlan({
    account_id: accountId,
    asset_id: assetId,
    statement_kind: args.statement_type ?? "statement",
    file_name: statementFile.file_name,
    file_sha256: statementFile.file_sha256,
    expected_balance: expected,
    planned_balance: plannedBalance,
    metadata
  }, planRows) : null;
  const persistedRows = persisted ? ledger.listStatementPlanRows(String(persisted.id)) : planRows;
  return statementPlanOutput(persisted, persistedRows, {
    account_id: accountId,
    asset_id: assetId,
    expected_balance_cents: expected,
    planned_balance_cents: plannedBalance,
    balance_matches: balanceMatches,
    balance_sign: userFacingLiabilityBalance(args) ? "user_facing_liability" : "ledger",
    sample_limit: args.sample_limit ?? args.preview_rows ?? 20,
    dry_run: !options.persist,
    realized_planned_rows: realizedPlanned,
    metadata
  });
}

function applyStatementPlan(ledger: Ledger, planId: string, args: Args = {}): Row {
  const plan = ledger.getStatementPlan(planId);
  if (!plan) throw new Error(`Statement plan '${planId}' not found`);
  if (String(plan.status) !== "planned") throw new Error(`Statement plan '${planId}' is ${String(plan.status)}`);
  const rows = publicPlanRows(ledger.listStatementPlanRows(planId));
  if (rows.some((row) => row.action === "ambiguous")) throw new Error("Statement plan has ambiguous rows; resolve them before applying");
  const accountId = String(plan.account_id);
  const assetId = String(plan.asset_id);
  const metadata = safeJson(plan.metadata_json);
  const targetStatus = String(metadata.target_status ?? "posted");
  const effectiveRows = rows.filter((row) => ["pending_to_commit", "new_posted", "new_pending", "stale_pending_to_void"].includes(String(row.action)));
  if (args.dry_run !== false) {
    return statementPlanOutput(plan, rows, { dry_run: true, would_apply: effectiveRows.length, sample_limit: args.sample_limit ?? 20 });
  }
  let created = 0;
  let committed = 0;
  let voided = 0;
  const createdTransactions: Row[] = [];
  const sourceId = ledger.runInTransaction(() => {
    const batchId = batch(ledger, args.batch_label ?? `Statement plan ${planId}`, { statement_plan_id: planId, statement_type: plan.statement_kind }, targetStatus === "posted" ? "posted_import" : "pending_import");
    for (const row of rows) {
      if (row.action === "matched" || row.action === "ignored") continue;
      if (row.action === "pending_to_commit") {
        const tx = ledger.getTx(String(row.matched_journal_id));
        if (!tx || tx.status !== "pending") throw new Error(`Matched pending transaction '${String(row.matched_journal_id)}' changed before apply`);
        if (amountForAccount(ledger, tx.id, accountId, assetId) !== BigInt(row.quantity)) throw new Error(`Matched pending transaction '${tx.id}' amount changed before apply`);
        ledger.updateTxStatus(tx.id, "posted");
        ledger.updateTransactionSource(tx.id, batchId);
        tagTx(ledger, tx.id, "statement_plan", planId);
        committed += 1;
      } else if (row.action === "stale_pending_to_void") {
        const tx = ledger.getTx(String(row.matched_journal_id));
        if (!tx || tx.status !== "pending") throw new Error(`Stale pending transaction '${String(row.matched_journal_id)}' changed before apply`);
        ledger.voidTx(tx.id);
        tagTx(ledger, tx.id, "statement_plan", planId);
        voided += 1;
      } else if (row.action === "new_posted" || row.action === "new_pending") {
        const counterpartId = row.counterpart_account_id ? String(row.counterpart_account_id) : null;
        if (!counterpartId) throw new Error(`Plan row ${String(row.id)} has no counterpart account`);
        const status = row.action === "new_posted" ? "posted" : "pending";
        const quantity = BigInt(row.quantity);
        const tx = quantity >= 0n
          ? ledger.recordTransaction(String(row.date), quantity, counterpartId, accountId, assetId, String(row.description ?? ""), status, { sourceId: batchId, externalId: row.external_id ? String(row.external_id) : null })
          : ledger.recordTransaction(String(row.date), -quantity, accountId, counterpartId, assetId, String(row.description ?? ""), status, { sourceId: batchId, externalId: row.external_id ? String(row.external_id) : null });
        ledger.setStatementPlanRowCreatedJournal(String(row.id), tx.id);
        tagTx(ledger, tx.id, "import_batch", batchId);
        tagTx(ledger, tx.id, "statement_plan", planId);
        for (const [key, value] of Object.entries(safeJson(row.metadata).tags ?? {})) tagTx(ledger, tx.id, key, String(value));
        createdTransactions.push(txPublic(ledger, ledger.getTx(tx.id)!));
        created += 1;
      }
    }
    ledger.markStatementPlanApplied(planId, batchId, ledger.balanceTree(accountId, assetId, null, targetStatus === "pending" ? "pending" : "posted"));
    return batchId;
  });
  const appliedPlan = ledger.getStatementPlan(planId)!;
  const appliedRows = ledger.listStatementPlanRows(planId);
  return {
    ...statementPlanOutput(appliedPlan, appliedRows, { dry_run: false }),
    batch_id: sourceId,
    created,
    committed,
    voided,
    skipped: appliedRows.filter((row) => row.action === "matched").length,
    imported: created,
    transactions: createdTransactions,
    balance_matches: appliedPlan.expected_balance == null ? null : BigInt(appliedPlan.expected_balance as string | number | bigint | boolean) === BigInt(appliedPlan.applied_balance as string | number | bigint | boolean),
    actual_balance_cents: appliedPlan.applied_balance
  };
}

function verifyStatementPlan(ledger: Ledger, planId: string): Row {
  const plan = ledger.getStatementPlan(planId);
  if (!plan) throw new Error(`Statement plan '${planId}' not found`);
  const rows = publicPlanRows(ledger.listStatementPlanRows(planId));
  const mismatches: Row[] = [];
  for (const row of rows) {
    const txId = row.created_journal_id ?? row.matched_journal_id;
    if (!txId || ["new_posted", "new_pending", "pending_to_commit", "stale_pending_to_void", "matched"].includes(String(row.action)) === false) continue;
    const tx = ledger.getTx(String(txId));
    if (!tx) mismatches.push({ row_id: row.id, tx_id: txId, error: "transaction missing" });
    else if (row.action === "stale_pending_to_void" && tx.status !== "void") mismatches.push({ row_id: row.id, tx_id: txId, error: `expected void, got ${tx.status}` });
    else if (row.action === "pending_to_commit" && tx.status !== "posted") mismatches.push({ row_id: row.id, tx_id: txId, error: `expected posted, got ${tx.status}` });
    else if (row.action === "new_posted" && tx.status !== "posted") mismatches.push({ row_id: row.id, tx_id: txId, error: `expected posted, got ${tx.status}` });
    else if (row.action === "new_pending" && tx.status !== "pending") mismatches.push({ row_id: row.id, tx_id: txId, error: `expected pending, got ${tx.status}` });
    else if (row.action !== "stale_pending_to_void" && amountForAccount(ledger, tx.id, String(plan.account_id), String(plan.asset_id)) !== BigInt(row.quantity)) mismatches.push({ row_id: row.id, tx_id: txId, error: "quantity changed" });
  }
  return { ...statementPlanOutput(plan, rows, { dry_run: false }), verified: mismatches.length === 0, mismatches };
}

function transactionMagnitude(ledger: Ledger, txId: string, accountId?: string | null): bigint {
  return ledger.getEntries(txId)
    .filter((entry) => !accountId || entry.account_id === accountId)
    .reduce((max, entry) => {
      const amount = entry.quantity < 0n ? -entry.quantity : entry.quantity;
      return amount > max ? amount : max;
    }, 0n);
}

function amountWithinTolerance(left: bigint, right: bigint, tolerancePct: number): boolean {
  if (left === right) return true;
  const base = left > right ? left : right;
  if (base === 0n) return left === right;
  return Number((left > right ? left - right : right - left) * 10000n / base) <= tolerancePct * 100;
}

function recurringDateRange(args: Args): [string | null, string | null] {
  if (args.year != null) return monthBounds(Number(args.year), args.month == null ? null : Number(args.month));
  const end = new Date(`${today()}T00:00:00Z`);
  const start = new Date(end);
  start.setUTCMonth(start.getUTCMonth() - Number(args.months ?? 6));
  start.setUTCDate(start.getUTCDate() + 1);
  return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)];
}

function registryNames(args: Args): { names: ToolName[]; unknown_names: string[] } {
  if (args.names == null) return { names: [...TOOL_NAMES], unknown_names: [] };
  const requested = Array.isArray(args.names)
    ? args.names.map((name) => String(name))
    : String(args.names).split(",").map((name) => name.trim()).filter(Boolean);
  const known = new Set<string>(TOOL_NAMES);
  const unknown = requested.filter((name) => !known.has(name));
  return { names: requested.filter((name) => known.has(name)) as ToolName[], unknown_names: unknown };
}

function registrySafetyMatches(name: ToolName, args: Args): boolean {
  const safety = toolSafety(name);
  const filter = args.safety_filter;
  if (filter == null) return true;
  if (typeof filter === "string") {
    const value = filter.toLowerCase().replace(/[\s_-]+/g, "");
    if (["readonly", "read"].includes(value)) return safety.readOnlyHint;
    if (["write", "mutating"].includes(value)) return !safety.readOnlyHint;
    if (value === "destructive") return safety.destructiveHint;
    if (["dryrun", "dryruncapable"].includes(value)) return safety.supportsDryRun;
    if (value === "defaultdryrun") return safety.defaultDryRun;
    if (value === "idempotent") return safety.idempotentHint;
    if (value === "safe") return safety.readOnlyHint || safety.defaultDryRun;
    throw new Error(`Unknown safety_filter: ${filter}`);
  }
  if (typeof filter !== "object") throw new Error("safety_filter must be a string or object");
  for (const [key, expected] of Object.entries(filter)) {
    if (key in safety && (safety as Row)[key] !== expected) return false;
  }
  return true;
}

function registryEntry(name: ToolName, summary: boolean): Row {
  const safety = toolSafety(name);
  const definition = effectiveToolDefinition(name);
  if (summary) {
    return {
      name,
      signature: TOOL_SIGNATURES[name],
      parameters: definition.parameters.map((parameter) => parameter[0]),
      aliases: parameterAliasesForTool(name),
      safety
    };
  }
  return {
    name,
    signature: TOOL_SIGNATURES[name],
    definition,
    aliases: parameterAliasesForTool(name),
    safety
  };
}

function scopedExportDocument(ledger: Ledger, args: Args): Row {
  const doc = ledger.exportDocument() as Row;
  const accountIds = args.account_ids
    ? new Set((args.account_ids as string[]).flatMap((ref) => [...ledger.descendants(account(ledger, ref))]))
    : null;
  const entityId = args.entity_id ? String(args.entity_id) : null;
  const dateFrom = optionalDate(args.date_from);
  const dateTo = optionalDate(args.date_to);
  const hasScope = Boolean(accountIds?.size || entityId || dateFrom || dateTo);
  if (!hasScope) return doc;

  const transactions = ((doc.transactions as Row[]) ?? []).filter((tx) => {
    if (dateFrom && String(tx.date) < dateFrom) return false;
    if (dateTo && String(tx.date) > dateTo) return false;
    const entries = (tx.entries as Row[]) ?? [];
    const tags = (tx.tags as Row[]) ?? [];
    if (accountIds && !entries.some((entry) => accountIds.has(String(entry.account_id)))) return false;
    if (entityId) {
      const matchesEntity = tx.id === entityId
        || tx.source_id === entityId
        || entries.some((entry) => entry.account_id === entityId || entry.asset_id === entityId)
        || tags.some((tag) => tag.id === entityId || tag.entity_id === entityId || tag.value === entityId || tag.val === entityId);
      if (!matchesEntity) return false;
    }
    return true;
  });

  const txIds = new Set(transactions.map((tx) => String(tx.id)));
  const sourceIds = new Set(transactions.map((tx) => tx.source_id).filter(Boolean).map(String));
  const usedAccountIds = new Set<string>(accountIds ?? []);
  for (const tx of transactions) for (const entry of (tx.entries as Row[]) ?? []) usedAccountIds.add(String(entry.account_id));
  const accountScoped = (row: Row): boolean => usedAccountIds.size === 0 || usedAccountIds.has(String(row.account_id));

  return {
    ...doc,
    scope: {
      entity_id: entityId,
      date_from: dateFrom,
      date_to: dateTo,
      account_ids: accountIds ? [...accountIds] : null,
      transaction_count: transactions.length
    },
    accounts: usedAccountIds.size ? (doc.accounts as Row[]).filter((row) => usedAccountIds.has(String(row.id))) : doc.accounts,
    sources: (doc.sources as Row[]).filter((row) => sourceIds.has(String(row.id)) || row.id === entityId),
    transactions,
    account_tags: ((doc.account_tags as Row[]) ?? []).filter((row) => usedAccountIds.size === 0 || usedAccountIds.has(String(row.entity_id))),
    budgets: ((doc.budgets as Row[]) ?? []).filter(accountScoped),
    goals: ((doc.goals as Row[]) ?? []).filter(accountScoped),
    lots: ((doc.lots as Row[]) ?? []).filter((row) => accountScoped(row) || txIds.has(String(row.opened_journal_id)) || txIds.has(String(row.closed_journal_id))),
    scheduled_transactions: ((doc.scheduled_transactions as Row[]) ?? []).filter((row) => {
      if (usedAccountIds.size === 0) return true;
      return usedAccountIds.has(String(row.from_account_id)) || usedAccountIds.has(String(row.to_account_id));
    })
  };
}

function ageOfMoney(ledger: Ledger, args: Args): Row {
  const quote = reportAsset(ledger, args.quote_asset_id);
  const asOf = today();
  const cutoffDate = new Date(`${asOf}T00:00:00Z`);
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - Number(args.days ?? 30));
  const dateFrom = cutoffDate.toISOString().slice(0, 10);
  const assetAccounts = new Set(ledger.listAccounts().filter((row) => row.account_type === "asset").map((row) => row.id));
  const lots: Array<{ date: string; quantity: bigint }> = [];
  const missing: Row[] = [];
  let income = 0n;
  let outflow = 0n;

  for (const tx of ledger.listTransactions({ status: "posted", dateFrom, dateTo: asOf, sort: "date_asc" })) {
    let delta = 0n;
    for (const entry of ledger.getEntries(tx.id).filter((line) => assetAccounts.has(line.account_id))) {
      const [converted, error] = ledger.tryConvertQuantity(entry.quantity, entry.asset_id, quote, tx.date);
      if (converted == null) {
        missing.push({ tx_id: tx.id, account_id: entry.account_id, asset_id: entry.asset_id, quote_asset_id: quote, quantity: entry.quantity, error });
        continue;
      }
      delta += converted;
    }
    if (delta > 0n) {
      income += delta;
      lots.push({ date: tx.date, quantity: delta });
      continue;
    }
    if (delta < 0n) {
      let remaining = -delta;
      outflow += remaining;
      while (remaining > 0n && lots.length) {
        const lot = lots[0];
        const used = lot.quantity < remaining ? lot.quantity : remaining;
        lot.quantity -= used;
        remaining -= used;
        if (lot.quantity === 0n) lots.shift();
      }
    }
  }

  const remaining = lots.reduce((sum, lot) => sum + lot.quantity, 0n);
  const weightedDays = lots.reduce((sum, lot) => {
    const age = Math.max(0, Math.floor((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${lot.date}T00:00:00Z`)) / 86400000));
    return sum + Number(lot.quantity) * age;
  }, 0);

  return {
    days: args.days ?? 30,
    date_from: dateFrom,
    as_of: asOf,
    quote_asset_id: quote,
    income_cents: income,
    outflow_cents: outflow,
    remaining_cents: remaining,
    average_age_days: remaining === 0n ? 0 : weightedDays / Number(remaining),
    valuation_complete: missing.length === 0,
    missing_conversions: missing
  };
}

function batch(ledger: Ledger, label?: string | null, metadata: Row = {}, status = "open"): string {
  return ledger.createSource("import", label, metadata, status);
}

function txIdsForBatch(ledger: Ledger, batchId: string): string[] {
  return [...new Set([
    ...ledger.listTransactionIdsForSource(batchId),
    ...ledger.listAnnotationEntityIds("tx", "import_batch", batchId)
  ])].sort();
}

function tagTx(ledger: Ledger, txId: string, key: string, value: string): void {
  if (!ledger.listAnnotations("tx", txId).some((tag) => tag.key === key && (tag.val === value || tag.value === value))) {
    ledger.createAnnotation("tx", txId, key, value);
  }
}

function selectBatchTransactions(ledger: Ledger, args: Args): string[] {
  const selected = new Set<string>(args.tx_ids ?? []);
  if (args.batch_id) for (const txId of txIdsForBatch(ledger, args.batch_id)) selected.add(txId);
  const acct = args.account_id ? account(ledger, args.account_id) : null;
  if (selected.size === 0) {
    for (const tx of ledger.listTransactions({ status: "pending", dateFrom: optionalDate(args.date_from), dateTo: optionalDate(args.date_to) })) {
      if (acct && !ledger.getEntries(tx.id).some((entry) => entry.account_id === acct)) continue;
      selected.add(tx.id);
    }
  }
  return [...selected].sort();
}

function unsupportedArguments(values: Args): void {
  const names = Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== false && value !== "" && !(Array.isArray(value) && value.length === 0)).map(([key]) => key);
  if (names.length) throw new Error(`Unsupported MCP parameter(s): ${names.join(", ")}`);
}

const MAX_MATCH_PATTERN_LENGTH = 200;
const MAX_MATCH_INPUT_LENGTH = 2048;
const NESTED_QUANTIFIER_PATTERN = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,?\d*\})/;

function safeMatchRegex(pattern: unknown): RegExp {
  // Regex rules are user-provided and can run across many rows, so they are
  // length-bounded and reject obvious catastrophic-backtracking shapes.
  const value = String(pattern ?? "");
  if (!value) throw new Error("pattern is required");
  if (value.length > MAX_MATCH_PATTERN_LENGTH) throw new Error(`pattern must be ${MAX_MATCH_PATTERN_LENGTH} characters or fewer`);
  if (NESTED_QUANTIFIER_PATTERN.test(value)) throw new Error("pattern is too complex");
  try {
    return new RegExp(value, "i");
  } catch (error) {
    throw new Error(`Invalid pattern: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export type ToolCapability = never;

export function requiredToolCapabilities(name: string, args: Args = {}): ToolCapability[] {
  void name;
  void args;
  const capabilities: ToolCapability[] = [];
  return capabilities;
}

export function assertToolCapabilities(name: string, args: Args, granted: Set<ToolCapability | "all">, surface: "CLI" | "MCP"): void {
  void name;
  void args;
  void granted;
  void surface;
}

function assertMcpCapability(name: string, args: Args): void {
  // MCP is a trusted local control plane; tool annotations and dry-run previews
  // guide callers, while hard boundaries belong to the host environment.
  void name;
  void args;
}

const handlers: Record<ToolName, Handler> = {
  // One handler per public tool. Handlers may compose other handlers, but
  // durable writes still flow through Ledger methods.
  create_asset: (ledger, args) => {
    const assetId = ledger.createAsset(args.symbol, args.asset_type ?? "currency", Number(args.decimals ?? args.scale ?? 2), args.name ?? "");
    return { ...ledger.getAsset(assetId)!, warning: ledger.getAssetBySymbol(args.symbol) ? undefined : undefined };
  },
  list_assets: (ledger, args) => ledger.listAssets().filter((row) => !args.asset_type || row.asset_type === args.asset_type),
  get_asset_by_symbol: (ledger, args) => ledger.getAssetBySymbol(args.symbol),
  update_asset: (ledger, args) => ledger.updateAsset(asset(ledger, args.asset_id), { symbol: args.symbol, name: args.name }),
  delete_asset: (ledger, args) => {
    const assetId = asset(ledger, args.asset_id);
    ledger.deleteAsset(assetId, Boolean(args.force));
    return { deleted: assetId };
  },
  migrate_asset_entries: (ledger, args) => {
    const fromId = asset(ledger, args.from_asset_id);
    const toId = asset(ledger, args.to_asset_id);
    const count = ledger.countEntriesByAsset(fromId);
    if (args.dry_run === false) return { from_asset_id: fromId, to_asset_id: toId, matched: ledger.migrateAssetEntries(fromId, toId), updated: count, dry_run: false };
    return { from_asset_id: fromId, to_asset_id: toId, matched: count, updated: 0, dry_run: true };
  },

  create_account: (ledger, args) => {
    const existing = ledger.findAccount(args.name);
    if (existing) {
      if ("default_asset_id" in args || "asset_id" in args) setAccountDefaultAsset(ledger, existing.id, args.default_asset_id ?? args.asset_id ?? null);
      return accountPublic(existing, ledger);
    }
    const parent = args.parent_id ? account(ledger, args.parent_id) : null;
    const accountId = ledger.createAccount(args.name, args.type, parent, args.code ?? "", args.color_hex ?? "#888888");
    setAccountDefaultAsset(ledger, accountId, args.default_asset_id ?? args.asset_id ?? null);
    return accountPublic(ledger.getAccount(accountId)!, ledger);
  },
  create_accounts: (ledger, args) => {
    const created: Row[] = [];
    const errors: Row[] = [];
    (args.accounts ?? []).forEach((row: Row, index: number) => {
      try {
        created.push(handlers.create_account(ledger, { name: row.name, type: row.type ?? row.account_type, parent_id: row.parent_id, code: row.code, color_hex: row.color_hex, default_asset_id: row.default_asset_id ?? row.asset_id }) as Row);
      } catch (error) {
        errors.push({ index, error: error instanceof Error ? error.message : String(error) });
      }
    });
    return { created: created.length, accounts: created, errors };
  },
  list_accounts: (ledger, args) => {
    let rows = ledger.listAccounts().map((row) => accountPublic(row, ledger));
    if (args.type) rows = rows.filter((row) => row.account_type === args.type);
    if (args.parent_id) {
      const parent = account(ledger, args.parent_id);
      rows = rows.filter((row) => row.parent_id === parent);
    }
    if (args.include_counts) {
      rows = rows.map((row) => ({
        ...row,
        transaction_count: ledger.countTransactionsByAccount(row.id)
      }));
    }
    if (args.tree) {
      const byParent = new Map<string | null, Row[]>();
      for (const row of rows) byParent.set(row.parent_id ?? null, [...(byParent.get(row.parent_id ?? null) ?? []), row]);
      const attach = (row: Row): Row => ({ ...row, children: (byParent.get(row.id) ?? []).map(attach) });
      return (byParent.get(null) ?? []).map(attach);
    }
    return rows;
  },
  get_account: (ledger, args) => {
    const row = ledger.getAccount(args.id);
    if (!row) throw new Error(`Account '${args.id}' not found`);
    return accountPublic(row, ledger);
  },
  get_account_by_name: (ledger, args) => {
    const row = ledger.findAccount(args.name);
    return row ? accountPublic(row, ledger) : null;
  },
  update_account: (ledger, args) => {
    const accountId = account(ledger, args.id);
    const updated = ledger.updateAccount(accountId, { name: args.name, type: args.type, parent_id: args.parent_id ? account(ledger, args.parent_id) : args.parent_id, code: args.code, color_hex: args.color_hex });
    if ("default_asset_id" in args || "asset_id" in args) setAccountDefaultAsset(ledger, accountId, args.default_asset_id ?? args.asset_id ?? null);
    return accountPublic(updated, ledger);
  },
  delete_account: (ledger, args) => {
    const accountId = account(ledger, args.id);
    ledger.deleteAccount(accountId);
    return { deleted: accountId };
  },
  merge_accounts: (ledger, args) => {
    const target = account(ledger, args.target);
    let moved = 0;
    for (const source of args.sources ?? []) {
      const sourceId = account(ledger, source);
      moved += ledger.moveEntriesBetweenAccounts(sourceId, target);
      if (args.delete_sources !== false) {
        try { ledger.deleteAccount(sourceId); } catch { /* source may still have children */ }
      }
    }
    return { target, sources: args.sources ?? [], moved };
  },

  create_transaction: (ledger, args) => {
    const fromAccountId = account(ledger, args.from_account_id);
    const toAccountId = account(ledger, args.to_account_id);
    const assetId = transactionAsset(ledger, fromAccountId, toAccountId, args.asset_id);
    const quantity = amountToQuantity(ledger, assetId, args.amount);
    const tx = ledger.recordTransaction(validateDate(args.date), quantity, fromAccountId, toAccountId, assetId, args.description ?? "", args.status ?? "pending");
    if (args.branch) {
      handlers.create_branch(ledger, { name: args.branch });
      tagTx(ledger, tx.id, "branch", String(args.branch));
    }
    return directedTxPublic(ledger, tx, fromAccountId, toAccountId);
  },
  transfer: (ledger, args) => {
    const tx = handlers.create_transaction(ledger, { ...args, status: args.status ?? "posted", from_account_id: args.from_account_id, to_account_id: args.to_account_id }) as Row;
    return {
      tx,
      entries: tx.entries,
      amount: tx.amount,
      amount_cents: tx.amount_cents,
      from_account: tx.from_account,
      to_account: tx.to_account
    };
  },
  plan_transaction: (ledger, args) => handlers.create_transaction(ledger, { ...args, status: "planned" }),
  post_journal_entry: (ledger, args) => {
    const defaultAsset = args.asset_id ? explicitAsset(ledger, args.asset_id) : null;
    const lines = (args.legs ?? []).map((leg: Row) => {
      const accountId = account(ledger, leg.account_id ?? leg.account);
      const assetId = leg.asset_id ? explicitAsset(ledger, leg.asset_id) : defaultAsset ?? accountAsset(ledger, accountId, "leg.asset_id");
      return [accountId, assetId, journalLegQuantity(ledger, assetId, leg)] as [string, string, bigint];
    });
    const txId = ledger.postTx(validateDate(args.date), args.status ?? "pending", args.description ?? "", lines);
    return txWithEntries(ledger, txId);
  },
  record_opening_balance: (ledger, args) => {
    const accountId = account(ledger, args.account_id);
    const assetId = args.asset_id ? explicitAsset(ledger, args.asset_id) : accountAsset(ledger, accountId);
    return txPublic(ledger, ledger.recordOpeningBalance(accountId, amountToQuantity(ledger, assetId, args.amount), assetId, validateDate(args.date), args.status ?? "pending", args.counterpart_account_id ? account(ledger, args.counterpart_account_id) : null));
  },
  record_opening_balances: (ledger, args) => {
    const rows = (args.balances ?? []).map((row: Row) => handlers.record_opening_balance(ledger, { ...row, date: args.date, status: args.status ?? "pending" }));
    return { created: rows.length, transactions: rows };
  },
  list_transactions: (ledger, args) => {
    const dateRange = args.year ? monthBounds(Number(args.year), args.month ? Number(args.month) : null) : [optionalDate(args.date_from), optionalDate(args.date_to)];
    const options = {
      desc: args.desc,
      accountId: args.account_id ? account(ledger, args.account_id) : args.category_id ? account(ledger, args.category_id) : null,
      assetId: args.asset_id ? asset(ledger, args.asset_id) : null,
      amountMin: args.amount_min == null ? null : BigInt(args.amount_min as string | number | bigint | boolean),
      amountMax: args.amount_max == null ? null : BigInt(args.amount_max as string | number | bigint | boolean),
      status: parseTxStatusFilter(args.status),
      dateFrom: dateRange[0],
      dateTo: dateRange[1],
      sort: args.sort ?? "date_desc"
    };
    const total = ledger.searchTransactions({ ...options, limit: null, offset: 0 }).length;
    const rows = ledger.searchTransactions({ ...options, limit: args.limit ?? 50, offset: args.offset ?? 0 }).map((tx) => txPublic(ledger, tx, args.compact !== false));
    return { transactions: rows, items: rows, total, limit: args.limit ?? 50, offset: args.offset ?? 0 };
  },
  search_transactions: (ledger, args) => {
    const dateRange = args.year ? monthBounds(Number(args.year), args.month ? Number(args.month) : null) : [optionalDate(args.date_from), optionalDate(args.date_to)];
    const options = {
      desc: args.desc ?? args.query,
      accountId: args.account_id ? account(ledger, args.account_id) : args.category_id ? account(ledger, args.category_id) : null,
      assetId: args.asset_id ? asset(ledger, args.asset_id) : null,
      amountMin: args.amount_min == null ? null : BigInt(args.amount_min as string | number | bigint | boolean),
      amountMax: args.amount_max == null ? null : BigInt(args.amount_max as string | number | bigint | boolean),
      status: parseTxStatusFilter(args.status),
      dateFrom: dateRange[0],
      dateTo: dateRange[1],
      postedAtFrom: postedAtBound(args.posted_at_from, "from"),
      postedAtTo: postedAtBound(args.posted_at_to, "to"),
      sort: args.sort ?? "date_desc"
    };
    const total = ledger.searchTransactions({ ...options, limit: null, offset: 0 }).length;
    const rows = ledger.searchTransactions({ ...options, limit: args.limit ?? 50, offset: args.offset ?? 0 }).map((tx) => txPublic(ledger, tx, false));
    return { transactions: rows, items: rows, total, limit: args.limit ?? 50, offset: args.offset ?? 0 };
  },
  get_transaction: (ledger, args) => txWithEntries(ledger, args.id),
  list_ledger_operations: (ledger, args) => ledger.listLedgerOperations(args.limit ?? 50).map((row) => operationPublic(ledger, row)),
  get_ledger_operation: (ledger, args) => {
    const operation = ledger.getLedgerOperation(String(args.operation_id));
    if (!operation) throw new Error(`Ledger operation '${String(args.operation_id)}' not found`);
    return operationPublic(ledger, operation);
  },
  delete_transaction: (ledger, args) => {
    if (args.hard_delete) ledger.deleteTx(args.id);
    else ledger.voidTx(args.id);
    return { deleted: args.id, hard_delete: Boolean(args.hard_delete) };
  },
  list_entries: (ledger, args) => {
    if (!ledger.getTx(args.tx_id)) throw new Error(`Transaction '${args.tx_id}' not found`);
    return entriesPublic(ledger, args.tx_id);
  },
  list_entries_by_asset: (ledger, args) => {
    const assetId = asset(ledger, args.asset_id);
    const rows = ledger.listEntriesByAsset(assetId, args.limit ?? 100, args.offset ?? 0);
    const entries = rows.map((row) => ({ ...row, tx_id: row.journal_id, qty_cents: row.quantity }));
    return { entries, items: entries, limit: args.limit ?? 100, offset: args.offset ?? 0 };
  },
  get_balance: (ledger, args) => {
    const accountId = account(ledger, args.account_id);
    const acct = ledger.getAccount(accountId)!;
    const balances = ledger.listAssets().map((ast) => {
      const balance = ledger.balanceTree(accountId, ast.id, optionalDate(args.date), parseTxStatusFilter(args.status, "posted"));
      return { account_id: accountId, asset_id: ast.id, asset_symbol: ast.symbol, quantity: balance, balance, balance_cents: balance, scale: ast.scale, balance_display: display(ledger, balance, ast.id) };
    }).filter((row) => row.balance !== 0n);
    if (balances.length === 0) {
      const defaultAssetId = accountDefaultAsset(ledger, accountId);
      const defaultAsset = defaultAssetId ? ledger.getAsset(defaultAssetId) : null;
      if (defaultAsset) balances.push({ account_id: accountId, asset_id: defaultAsset.id, asset_symbol: defaultAsset.symbol, quantity: 0n, balance: 0n, balance_cents: 0n, scale: defaultAsset.scale, balance_display: 0 });
    }
    const defaultAssetId = accountDefaultAsset(ledger, accountId);
    const primary = balances.find((row) => row.asset_id === defaultAssetId) ?? balances[0];
    return {
      account_id: accountId,
      account_name: acct.name,
      balances,
      balance: primary?.balance ?? 0n,
      balance_cents: primary?.balance_cents ?? 0n,
      total_cents: balances.reduce((sum, row) => sum + row.balance, 0n)
    };
  },
  account_balances: (ledger, args) => ledger.accountBalances({
    accountType: args.account_type ?? null,
    assetId: args.asset_id ? asset(ledger, args.asset_id) : null,
    asOf: args.as_of ? validateDate(args.as_of) : null,
    rollup: Boolean(args.rollup),
    hideZero: args.hide_zero !== false
  }),
  recategorize_transaction: (ledger, args) => {
    const preview = recategorizePreview(ledger, args);
    return args.dry_run === true ? preview : applyRecategorizeTransaction(ledger, args);
  },
  flip_entries: (ledger, args) => {
    if (!args.tx_ids?.length) throw new Error("tx_ids is required");
    for (const txId of args.tx_ids) if (!ledger.getTx(txId)) throw new Error(`Transaction '${txId}' not found`);
    const flipped = ledger.flipEntries(args.tx_ids);
    return { flipped: flipped.length, tx_ids: flipped };
  },
  void_by_filter: (ledger, args) => {
    const matches = (handlers.list_transactions(ledger, { ...args, compact: true, limit: 100000 }) as Row).transactions as Row[];
    const dryRun = args.dry_run !== false;
    if (!dryRun) for (const tx of matches) args.hard_delete ? ledger.deleteTx(String(tx.id)) : ledger.voidTx(String(tx.id));
    return { matched: matches.length, voided: dryRun ? 0 : matches.length, tx_ids: matches.map((tx) => tx.id), dry_run: dryRun };
  },
  move_transactions: (ledger, args) => {
    const source = account(ledger, args.from_account);
    const target = account(ledger, args.to_account);
    const count = ledger.countEntriesByAccount(source);
    return args.dry_run === false ? { matched: count, moved: ledger.moveEntriesBetweenAccounts(source, target), dry_run: false } : { matched: count, moved: 0, dry_run: true };
  },

  income_statement: (ledger, args) => {
    unsupportedArguments({ branch: args.branch, account_ids: args.account_ids, entity_id: args.entity_id });
    const month = args.month == null ? null : Number(args.month);
    const status = reportStatus(args, args.include_pending ? "active" : "posted");
    const report = incomeStatementRows(ledger, Number(args.year), month, status, args.quote_asset_id);
    if (month == null) report.months = Array.from({ length: 12 }, (_, index) => incomeStatementRows(ledger, Number(args.year), index + 1, status, args.quote_asset_id));
    return args.compact ? { year: Number(args.year), month, income: report.income, expense: report.expense, net: report.net } : report;
  },
  balance_sheet: (ledger, args) => {
    unsupportedArguments({ branch: args.branch, account_ids: args.account_ids, entity_id: args.entity_id });
    const status = reportStatus(args, "posted");
    const report = ledger.balanceSheet(optionalDate(args.date), reportAsset(ledger, args.quote_asset_id), status);
    if (args.hide_zero) {
      report.assets = (report.assets as Row[]).filter((row) => row.balance !== 0n);
      report.liabilities = (report.liabilities as Row[]).filter((row) => row.balance !== 0n);
      report.equity = (report.equity as Row[]).filter((row) => row.balance !== 0n);
    }
    return args.compact ? { total_assets: report.total_assets, total_liabilities: report.total_liabilities, total_equity: report.total_equity, total_assets_cents: report.total_assets, total_liabilities_cents: report.total_liabilities, total_equity_cents: report.total_equity } : report;
  },
  net_worth: (ledger, args) => {
    unsupportedArguments({ branch: args.branch });
    const status = reportStatus(args, "posted");
    return ledger.netWorthReport(args.date ? validateDate(String(args.date)) : "9999-12-31", reportAsset(ledger, args.quote_asset_id), status);
  },
  spending: (ledger, args) => {
    unsupportedArguments({ branch: args.branch, account_ids: args.account_ids, entity_id: args.entity_id });
    const result = spendingRows(ledger, Number(args.year), Number(args.month), reportStatus(args, args.include_pending ? "active" : "posted"), args.quote_asset_id, true) as { rows: Row[]; missing: Row[] };
    return { year: args.year, month: args.month, categories: result.rows, spending: result.rows, total: result.rows.reduce((sum, row) => sum + BigInt(row.amount_cents), 0n), warnings: result.missing, valuation_complete: result.missing.length === 0, missing_conversions: result.missing };
  },
  cash_flow: (ledger, args) => {
    unsupportedArguments({ branch: args.branch });
    const status = reportStatus(args, "posted");
    const report = ledger.cashFlow(Number(args.year), Number(args.month), reportAsset(ledger, args.quote_asset_id), status);
    return args.compact ? { year: report.year, month: report.month, operating_total: report.operating_total, investing_total: report.investing_total, financing_total: report.financing_total, net_change: report.net_change } : report;
  },
  account_register: (ledger, args) => {
    unsupportedArguments({ branch: args.branch });
    const accountId = account(ledger, args.account_id);
    const assetId = args.asset_id ? explicitAsset(ledger, args.asset_id) : accountAsset(ledger, accountId);
    const rows = ledger.accountRegister(accountId, assetId, optionalDate(args.date_from ?? args.time_from), optionalDate(args.date_to ?? args.time_to), parseTxStatusFilter(args.status));
    const page = rows.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 100));
    if (args.summary) return { account_id: accountId, transaction_count: rows.length, total_debits: page.reduce((sum, row) => sum + BigInt(row.debit as string | number | bigint | boolean), 0n), total_credits: page.reduce((sum, row) => sum + BigInt(row.credit as string | number | bigint | boolean), 0n), rows: page };
    return { account_id: accountId, entries: page, rows, total: rows.length, limit: args.limit ?? 100, offset: args.offset ?? 0 };
  },
  trial_balance: (ledger, args) => {
    unsupportedArguments({ branch: args.branch });
    return ledger.trialBalance(explicitAsset(ledger, args.asset_id, "asset_id"), parseTxStatusFilter(args.status, "posted"));
  },
  financial_overview: (ledger, args) => {
    const status = reportStatus(args, "active");
    return {
      current_snapshot: handlers.balance_sheet(ledger, { quote_asset_id: args.quote_asset_id, status }),
      monthly_activity: handlers.income_statement(ledger, { year: args.year ?? new Date().getUTCFullYear(), month: args.month ?? new Date().getUTCMonth() + 1, quote_asset_id: args.quote_asset_id, status }),
      budget_position: handlers.budget_summary(ledger, { ...args, status })
    };
  },
  financial_picture: (ledger, args) => {
    const fallbackIncludesPending = args.include_pending !== false;
    const fallbackIncludesPlanned = args.include_planned === true;
    const status = reportStatus(args, fallbackIncludesPlanned ? "combined" : fallbackIncludesPending ? "active" : "posted");
    const includePending = status == null || status === "active" || status === "combined" || status === "pending";
    const includePlanned = status == null || status === "combined" || status === "planned";
    const warnings: Row[] = [];
    if (args.status !== undefined && args.status !== "") {
      if (args.include_pending !== undefined && Boolean(args.include_pending) !== includePending) {
        warnings.push({
          code: "status_overrides_include_pending",
          message: `Explicit status '${String(args.status)}' overrides include_pending:${Boolean(args.include_pending)}; resolved include_pending:${includePending}.`
        });
      }
      if (args.include_planned !== undefined && Boolean(args.include_planned) !== includePlanned) {
        warnings.push({
          code: "status_overrides_include_planned",
          message: `Explicit status '${String(args.status)}' overrides include_planned:${Boolean(args.include_planned)}; resolved include_planned:${includePlanned}.`
        });
      }
    }
    const overview = handlers.financial_overview(ledger, { ...args, status }) as Row;
    const year = args.year ?? new Date().getUTCFullYear();
    const month = args.month ?? new Date().getUTCMonth() + 1;
    const actualCash = handlers.cash_projection(ledger, { year, month, quote_asset_id: args.quote_asset_id, include_pending: false, include_planned: false }) as Row;
    const projectedCash = handlers.cash_projection(ledger, { year, month, quote_asset_id: args.quote_asset_id, include_pending: includePending, include_planned: includePlanned }) as Row;
    const currentSnapshot = overview.current_snapshot as Row;
    if (currentSnapshot.as_of === "9999-12-31") {
      delete currentSnapshot.as_of;
      currentSnapshot.as_of_basis = "current_open_ended";
      currentSnapshot.as_of_description = "Open-ended current snapshot; no calendar cutoff was applied.";
    }
    return {
      ...overview,
      current_snapshot: currentSnapshot,
      basis: includePlanned ? "planned_projection" : includePending ? "current_active" : "current_actual",
      report_status: status,
      include_pending: includePending,
      include_planned: includePlanned,
      actual_cash_cents: actualCash.available_cash_cents,
      planned_cash_cents: projectedCash.planned_cash_cents,
      projected_cash_cents: projectedCash.available_cash_cents,
      cash_position: {
        actual: actualCash,
        selected: projectedCash
      },
      warnings,
      conversion_warning: projectedCash.conversion_warning
    };
  },
  cash_projection: (ledger, args) => {
    const quote = reportAsset(ledger, args.quote_asset_id);
    const [periodStart, asOf] = monthBounds(args.year, args.month);
    const plannedAfter = previousDate(periodStart);
    const assetAccounts = nonOverlappingAccounts(ledger, args.asset_account_ids ?? rootAccountIds(ledger, ["asset"]), ["asset"]);
    const liabilityAccounts = nonOverlappingAccounts(ledger, args.liability_account_ids ?? [], ["liability"]);
    const missing: Row[] = [];
    const projectionAccountIds = [...assetAccounts, ...liabilityAccounts];
    const realizedPlanned = args.include_planned === true ? realizedPlannedRows(ledger, {
      year: args.year,
      month: args.month,
      date_from: periodStart,
      date_to: asOf,
      account_ids: projectionAccountIds,
      date_tolerance_days: args.planned_match_tolerance_days ?? args.date_tolerance_days ?? 3
    }) : [];
    const realizedPlannedIds = new Set(realizedPlanned.map((row) => String(row.planned_tx_id)));

    const quoted = (accountId: string, status: TxStatus | string, dateFrom?: string | null): bigint => {
      const result = ledger.quotedBalanceTree(accountId, quote, asOf, status, dateFrom);
      missing.push(...result.missing);
      return result.total;
    };

    const accountBreakdown = assetAccounts.map((ref: string) => {
      const accountId = account(ledger, ref);
      const accountRow = ledger.getAccount(accountId);
      const posted = quoted(accountId, "posted");
      const pending = args.include_pending === true ? quoted(accountId, "pending") : 0n;
      const planned = args.include_planned === true ? quotedPlannedUnrealized(ledger, accountId, quote, asOf, plannedAfter, realizedPlannedIds, missing) : 0n;
      return { account_id: accountId, account_name: accountRow?.name ?? "", posted_cash_cents: posted, pending_cash_cents: pending, planned_cash_cents: planned, included_cash_cents: posted + pending + planned };
    });
    const liabilityBreakdown = liabilityAccounts.map((ref: string) => {
      const accountId = account(ledger, ref);
      const accountRow = ledger.getAccount(accountId);
      const posted = quoted(accountId, "posted");
      const pending = args.include_pending === true ? quoted(accountId, "pending") : 0n;
      const planned = args.include_planned === true ? quotedPlannedUnrealized(ledger, accountId, quote, asOf, plannedAfter, realizedPlannedIds, missing) : 0n;
      const effect = posted + pending + planned;
      return { account_id: accountId, account_name: accountRow?.name ?? "", posted_liability_effect_cents: posted, pending_liability_effect_cents: pending, planned_liability_effect_cents: planned, included_liability_effect_cents: effect, included_liability_balance_cents: -effect };
    });

    const postedCash = accountBreakdown.reduce((sum: bigint, row: Row) => sum + BigInt(row.posted_cash_cents), 0n);
    const pendingCash = accountBreakdown.reduce((sum: bigint, row: Row) => sum + BigInt(row.pending_cash_cents), 0n);
    const plannedCash = accountBreakdown.reduce((sum: bigint, row: Row) => sum + BigInt(row.planned_cash_cents), 0n);
    const gross = postedCash + pendingCash + plannedCash;
    const postedLiabilities = liabilityBreakdown.reduce((sum: bigint, row: Row) => sum + BigInt(row.posted_liability_effect_cents), 0n);
    const pendingLiabilities = liabilityBreakdown.reduce((sum: bigint, row: Row) => sum + BigInt(row.pending_liability_effect_cents), 0n);
    const plannedLiabilities = liabilityBreakdown.reduce((sum: bigint, row: Row) => sum + BigInt(row.planned_liability_effect_cents), 0n);
    const liabilityEffect = postedLiabilities + pendingLiabilities + plannedLiabilities;
    const earmarkItems = (args.earmarks ?? []).map((row: Row, index: number) => ({ name: row.name ?? row.label ?? `Earmark ${index + 1}`, amount_cents: amountToQuantity(ledger, quote, row.amount ?? 0) }));
    const earmarks = earmarkItems.reduce((sum: bigint, row: Row) => sum + BigInt(row.amount_cents), 0n);
    const budget = args.year == null || args.month == null ? null : handlers.budget_summary(ledger, { year: args.year, month: args.month, quote_asset_id: quote, include_pending: args.include_pending === true }) as Row;
    const plannedIncome = args.include_planned === true ? positive(plannedCash) : 0n;
    const available = gross + liabilityEffect - earmarks;
    const auditLineItems = [
      { type: "starting_cash", label: "Posted cash", amount_cents: postedCash },
      { type: "pending_cash", label: "Pending asset-account cash", amount_cents: pendingCash, included: args.include_pending === true },
      { type: "planned_cash", label: "Planned asset-account cash", amount_cents: plannedCash, included: args.include_planned === true },
      { type: "posted_liabilities", label: "Posted liability effect", amount_cents: postedLiabilities },
      { type: "pending_liabilities", label: "Pending liability effect", amount_cents: pendingLiabilities, included: args.include_pending === true },
      { type: "planned_liabilities", label: "Planned liability effect", amount_cents: plannedLiabilities, included: args.include_planned === true },
      ...earmarkItems.map((row: Row) => ({ type: "earmark", label: row.name, amount_cents: -BigInt(row.amount_cents) })),
      { type: "remaining_budget", label: "Remaining budget", amount_cents: budget?.total_remaining_cents ?? null, included: false },
      { type: "planned_income", label: "Planned income", amount_cents: plannedIncome, included: args.include_planned === true }
    ];
    return {
      year: args.year,
      month: args.month,
      as_of: asOf,
      planned_date_from: periodStart,
      basis: args.include_planned === true ? "projection" : args.include_pending === true ? "actual_plus_pending" : "actual",
      gross_cash_cents: gross,
      actual_cash_cents: postedCash,
      posted_cash_cents: postedCash,
      pending_cash_cents: pendingCash,
      planned_cash_cents: plannedCash,
      liability_effect_cents: liabilityEffect,
      liability_balance_cents: -liabilityEffect,
      posted_liability_effect_cents: postedLiabilities,
      pending_liability_effect_cents: pendingLiabilities,
      planned_liability_effect_cents: plannedLiabilities,
      earmarks_cents: earmarks,
      available_cash_cents: available,
      actual_available_cash_cents: postedCash + postedLiabilities - earmarks,
      pending_available_delta_cents: pendingCash + pendingLiabilities,
      planned_available_delta_cents: plannedCash + plannedLiabilities,
      remaining_budget_cents: budget?.total_remaining_cents ?? null,
      planned_income_cents: plannedIncome,
      accounts: assetAccounts,
      asset_account_ids: assetAccounts,
      liability_account_ids: liabilityAccounts,
      account_breakdown: accountBreakdown,
      liability_breakdown: liabilityBreakdown,
      earmarks: earmarkItems,
      audit_trail: {
        line_items: auditLineItems,
        asset_accounts: accountBreakdown,
        liabilities: liabilityBreakdown,
        earmarks: earmarkItems,
        remaining_budget: budget,
        planned_income_cents: plannedIncome,
        realized_planned_rows: realizedPlanned
      },
      realized_planned_rows: realizedPlanned,
      realized_planned_count: realizedPlanned.length,
      warnings: realizedPlanned.length > 0 ? ["excluded realized planned rows from planned projection; run reconcile_planned to void or review them"] : [],
      quote_asset_id: quote,
      include_pending: args.include_pending === true,
      include_planned: args.include_planned === true,
      valuation_complete: missing.length === 0,
      missing_conversions: missing,
      conversion_warning: conversionSeverity(missing)
    };
  },

  cash_runway: (ledger, args) => {
    const quote = reportAsset(ledger, args.quote_asset_id);
    const nowDate = new Date();
    const year = Number(args.year ?? nowDate.getUTCFullYear());
    const month = Number(args.month ?? nowDate.getUTCMonth() + 1);
    const asOf = args.as_of ? validateDate(String(args.as_of)) : today();
    const includePending = args.include_pending === true;
    const includePlanned = args.include_planned === true;
    const includeSources = args.include_sources === true && args.summary !== true;
    const shortMonths = Number(args.trailing_months_short ?? 3);
    const longMonths = Number(args.trailing_months_long ?? 6);
    if (!Number.isInteger(shortMonths) || shortMonths < 1) throw new Error("trailing_months_short must be a positive integer");
    if (!Number.isInteger(longMonths) || longMonths < 1) throw new Error("trailing_months_long must be a positive integer");
    const discretionaryMultiplier = args.discretionary_multiplier == null ? 0.5 : Number(args.discretionary_multiplier);
    if (!Number.isFinite(discretionaryMultiplier) || discretionaryMultiplier < 0 || discretionaryMultiplier > 1) throw new Error("discretionary_multiplier must be between 0 and 1");

    const defaultAssets = spendableAssetAccountDefaults(ledger);
    const assetAccounts = nonOverlappingAccounts(ledger, args.asset_account_ids ?? defaultAssets.selected, ["asset"]);
    const liabilityAccounts = nonOverlappingAccounts(ledger, args.liability_account_ids ?? rootAccountIds(ledger, ["liability"]), ["liability"]);
    const projection = handlers.cash_projection(ledger, {
      year,
      month,
      asset_account_ids: assetAccounts,
      liability_account_ids: liabilityAccounts,
      earmarks: args.earmarks ?? null,
      include_pending: includePending,
      include_planned: includePlanned,
      quote_asset_id: quote
    }) as Row;
    const budget = budgetBurn(ledger, year, month, quote, includePending);
    const trailingEnd = trailingWindowEnd(year, month, asOf, args.include_partial_month === true);
    const trailingShort = trailingSpend(ledger, Number(trailingEnd.year), Number(trailingEnd.month), shortMonths, quote, includeSources);
    const trailingLong = trailingSpend(ledger, Number(trailingEnd.year), Number(trailingEnd.month), longMonths, quote, includeSources);
    const currentMonthBudgetReserve = args.reserve_remaining_budget === false ? 0n : positive(BigInt((budget.budget as Row).total_remaining_cents ?? 0));
    const available = BigInt(projection.available_cash_cents);
    const runwayCash = positive(available - currentMonthBudgetReserve);
    const fixedBurn = BigInt(budget.fixed_budget_cents);
    const discretionaryBurn = BigInt(budget.discretionary_budget_cents);
    const discretionaryAdjusted = fixedBurn + scaleBigint(discretionaryBurn, discretionaryMultiplier);
    const shortModelName = `trailing_${shortMonths}_month_actual`;
    const longModelName = `trailing_${longMonths}_month_actual`;
    const budgetModelNames = ["budget_burn", "fixed_obligation_burn", "discretionary_adjusted_burn"];
    const burnModelNames = [...budgetModelNames.slice(0, 1), shortModelName, longModelName, ...budgetModelNames.slice(1)];
    const projectionMissing = projection.missing_conversions as Row[];
    const budgetMissing = ((budget.budget as Row).missing_conversions ?? []) as Row[];
    const shortMissing = trailingShort.missing_conversions as Row[];
    const longMissing = trailingLong.missing_conversions as Row[];
    const missing = scopedMissingConversions(ledger, [
      { section: "cash_projection", affectedModels: burnModelNames, rows: projectionMissing },
      { section: "budget", affectedModels: budgetModelNames, rows: budgetMissing },
      { section: "trailing_actuals.short", affectedModels: [shortModelName], rows: shortMissing },
      { section: "trailing_actuals.long", affectedModels: [longModelName], rows: longMissing }
    ]);
    const missingForModel = (name: string) => missing.filter((row) => ((row.affected_models as string[] | undefined) ?? []).includes(name));
    const withSource = (source: Row, sourceSummary: Row) => includeSources ? { source } : { source_summary: sourceSummary };
    const model = (name: string, label: string, monthlyBurn: bigint, source: Row, sourceSummary: Row) => {
      const modelMissing = missingForModel(name);
      return {
        model: name,
        label,
        monthly_burn_cents: monthlyBurn,
        runway_months: runwayMonths(runwayCash, monthlyBurn),
        valuation_complete: modelMissing.length === 0,
        missing_conversion_count: modelMissing.length,
        ...(includeSources && modelMissing.length > 0 ? { missing_conversions: modelMissing } : {}),
        ...withSource(source, sourceSummary)
      };
    };
    const burnModels = [
      model("budget_burn", "Budget burn", BigInt(budget.monthly_burn_cents), budget.budget as Row, budgetSummary(budget.budget as Row)),
      model(shortModelName, `Trailing ${shortMonths}-month actual burn`, BigInt(trailingShort.monthly_burn_cents), trailingShort, trailingSummary(trailingShort)),
      model(longModelName, `Trailing ${longMonths}-month actual burn`, BigInt(trailingLong.monthly_burn_cents), trailingLong, trailingSummary(trailingLong)),
      model("fixed_obligation_burn", "Fixed-obligation burn", fixedBurn, { fixed_budget_rows: budget.fixed_budget_rows }, { fixed_budget_count: (budget.fixed_budget_rows as Row[]).length, fixed_budget_cents: fixedBurn }),
      model("discretionary_adjusted_burn", "Fixed plus reduced discretionary burn", discretionaryAdjusted, {
        fixed_budget_cents: fixedBurn,
        discretionary_budget_cents: discretionaryBurn,
        discretionary_multiplier: discretionaryMultiplier
      }, {
        fixed_budget_cents: fixedBurn,
        discretionary_budget_cents: discretionaryBurn,
        discretionary_multiplier: discretionaryMultiplier
      })
    ];
    const recommended = burnModels.find((row) => row.model === `trailing_${shortMonths}_month_actual` && row.runway_months != null)
      ?? burnModels.find((row) => row.model === "budget_burn" && row.runway_months != null)
      ?? burnModels.find((row) => row.runway_months != null)
      ?? burnModels[0];
    return {
      year,
      month,
      as_of: asOf,
      quote_asset_id: quote,
      basis: includePlanned ? "projection" : includePending ? "actual_plus_pending" : "conservative_actual",
      summary: args.summary === true,
      include_sources: includeSources,
      include_pending: includePending,
      include_planned: includePlanned,
      actual_cash_cents: projection.actual_available_cash_cents,
      available_cash_cents: available,
      current_month_budget_reserve_cents: currentMonthBudgetReserve,
      spendable_cash_cents: runwayCash,
      runway_cash_cents: runwayCash,
      planned_cash_cents: projection.planned_cash_cents,
      pending_cash_delta_cents: projection.pending_available_delta_cents,
      earmarks_cents: projection.earmarks_cents,
      liability_effect_cents: projection.liability_effect_cents,
      asset_account_ids: assetAccounts,
      liability_account_ids: liabilityAccounts,
      excluded_asset_account_ids: args.asset_account_ids ? [] : defaultAssets.excluded,
      account_selection_rule: args.asset_account_ids ? "explicit asset_account_ids" : defaultAssets.rule,
      assumptions: {
        conservative_default: true,
        planned_cash_excluded_unless_requested: true,
        pending_cash_excluded_unless_requested: true,
        investments_excluded_by_default_when_named_as_investment_accounts: true,
        current_month_budget_reserved_by_default: args.reserve_remaining_budget !== false,
        partial_month_excluded_from_trailing_actuals_by_default: args.include_partial_month !== true,
        trailing_months_short: shortMonths,
        trailing_months_long: longMonths,
        trailing_window_basis: trailingEnd.basis,
        trailing_window_end_year: trailingEnd.year,
        trailing_window_end_month: trailingEnd.month,
        discretionary_multiplier: discretionaryMultiplier
      },
      trailing_window: trailingEnd,
      recommended_model: recommended.model,
      runway_months: recommended.runway_months,
      burn_models: burnModels,
      cash_projection: includeSources ? projection : cashProjectionSummary(projection),
      budget: includeSources ? budget.budget : budgetSummary(budget.budget as Row),
      trailing_actuals: {
        short: includeSources ? trailingShort : trailingSummary(trailingShort),
        long: includeSources ? trailingLong : trailingSummary(trailingLong)
      },
      valuation_complete: missing.length === 0,
      missing_conversions: missing,
      conversion_warning: conversionSeverity(missing, { recommendedModel: String(recommended.model) })
    };
  },

  set_budget: (ledger, args) => {
    const acct = ledger.getAccount(account(ledger, args.account))!;
    if (acct.account_type !== "expense") throw new Error("Budgets can only be set on expense accounts");
    const assetId = args.asset_id ? explicitAsset(ledger, args.asset_id) : accountAsset(ledger, acct.id);
    const quantity = amountToQuantity(ledger, assetId, args.amount);
    if (quantity < 0n) throw new Error("Budget amount cannot be negative");
    ledger.setBudget(acct.id, assetId, quantity, args.period ?? "monthly", args.year ?? null, args.month ?? null, Boolean(args.rollover));
    return { account_id: acct.id, asset_id: assetId, quantity, amount_cents: quantity, period: args.period ?? "monthly", year: args.year ?? null, month: args.month ?? null, rollover: Boolean(args.rollover) };
  },
  set_budgets: (ledger, args) => {
    const rows = (args.budgets ?? []).map((row: Row) => handlers.set_budget(ledger, { account: row.account ?? row.account_id, amount: row.amount, asset_id: row.asset_id, period: row.period ?? "monthly", year: row.year ?? args.year, month: row.month ?? args.month, rollover: row.rollover ?? false }));
    return { set: rows.length, budgets: rows };
  },
  budget_status: (ledger, args) => {
    const year = args.year ?? new Date().getUTCFullYear();
    const month = args.month ?? new Date().getUTCMonth() + 1;
    const acct = args.account ? account(ledger, args.account) : null;
    const quote = reportAsset(ledger, args.quote_asset_id);
    const spendingResult = spendingRows(ledger, year, month, reportStatus(args, "posted"), quote, true) as { rows: Row[]; missing: Row[] };
    const spending = new Map(spendingResult.rows.map((row) => [row.account_id, row]));
    const missing: Row[] = [...spendingResult.missing];
    const effective = effectiveBudgetRows(ledger, acct, year, month);
    const spendingAccountIdsForBudget = (accountId: string): string[] => {
      if (!args.rollup) return spending.has(accountId) ? [accountId] : [];
      const budgetAccount = ledger.getAccount(accountId);
      if (!budgetAccount) return [];
      return [...ledger.descendants(accountId)]
        .filter((id) => ledger.getAccount(id)?.account_type === budgetAccount.account_type && spending.has(id));
    };
    const spentForBudget = (accountId: string): bigint => {
      if (!args.rollup) return BigInt(spending.get(accountId)?.amount_cents ?? 0);
      return spendingAccountIdsForBudget(accountId)
        .reduce((sum, id) => sum + BigInt(spending.get(id)?.amount_cents ?? 0), 0n);
    };
    const rows = effective.rows.flatMap((budget) => {
      const [budgeted, error] = ledger.tryConvertQuantity(BigInt(budget.quantity), String(budget.asset_id), quote);
      if (budgeted == null) {
        missing.push({ account_id: budget.account_id, asset_id: budget.asset_id, quote_asset_id: quote, quantity: budget.quantity, error });
        return [];
      }
      const spent = spentForBudget(String(budget.account_id));
      return [{ account_id: budget.account_id, account_name: ledger.getAccount(String(budget.account_id))?.name ?? "", asset_id: quote, source_budget_id: budget.id, budgeted_cents: budgeted, spent_cents: spent, remaining_cents: budgeted - spent, percent_used: budgeted ? Number(spent) / Number(budgeted) * 100 : 0 }];
    });
    const coveredSpendingAccountIds = new Set(rows.flatMap((row) => spendingAccountIdsForBudget(String(row.account_id))));
    const totalBudgeted = rows.reduce((s, r) => s + r.budgeted_cents, 0n);
    const totalSpent = [...coveredSpendingAccountIds].reduce((sum, id) => sum + BigInt(spending.get(id)?.amount_cents ?? 0), 0n);
    return {
      year,
      month,
      budgets: rows,
      total_budgeted_cents: totalBudgeted,
      total_spent_cents: totalSpent,
      total_remaining_cents: totalBudgeted - totalSpent,
      shadowed_budget_count: effective.shadowed.length,
      shadowed_budgets: effective.shadowed.map((row) => ({ id: row.id, account_id: row.account_id, asset_id: row.asset_id, quantity: row.quantity, period: row.period, year: row.year, month: row.month })),
      valuation_complete: missing.length === 0,
      missing_conversions: missing
    };
  },
  budget_summary: (ledger, args) => {
    const status = handlers.budget_status(ledger, args) as Row;
    status.total_remaining_cents = BigInt(status.total_budgeted_cents) - BigInt(status.total_spent_cents);
    return status;
  },
  delete_budget: (ledger, args) => {
    const accountId = account(ledger, args.account);
    return { deleted: ledger.deleteBudget(accountId, args.year, args.month), account_id: accountId };
  },
  delete_budgets: (ledger, args) => args.accounts ? { deleted: (args.accounts as string[]).reduce((sum, acct) => sum + Number((handlers.delete_budget(ledger, { account: acct, year: args.year, month: args.month }) as Row).deleted), 0) } : { deleted: ledger.deleteAllBudgets() },
  copy_budgets: (ledger, args) => {
    let copied = 0;
    for (const row of budgetRows(ledger, null, args.from_year, args.from_month)) {
      handlers.set_budget(ledger, { account: row.account_id, amount: display(ledger, BigInt(row.quantity), row.asset_id), period: row.period, year: args.to_year, month: args.to_month, rollover: Boolean(row.rollover_rule) });
      copied += 1;
    }
    return { copied };
  },
  budget_rollover_preview: (ledger, args) => {
    const status = handlers.budget_status(ledger, args) as Row;
    if (status.valuation_complete === false) return { year: args.year, month: args.month, rollovers: [], total_rollover_cents: 0n, valuation_complete: false, missing_conversions: status.missing_conversions };
    const rollovers = (status.budgets as Row[]).filter((row) => BigInt(row.remaining_cents) > 0n).map((row) => ({ ...row, rollover_cents: row.remaining_cents }));
    return { year: args.year, month: args.month, rollovers, total_rollover_cents: rollovers.reduce((sum, row) => sum + BigInt(row.rollover_cents), 0n), valuation_complete: true, missing_conversions: [] };
  },
  apply_rollover: (ledger, args) => {
    const preview = handlers.budget_rollover_preview(ledger, args) as Row;
    const nextYear = args.month === 12 ? args.year + 1 : args.year;
    const nextMonth = args.month === 12 ? 1 : args.month + 1;
    for (const row of preview.rollovers as Row[]) handlers.set_budget(ledger, { account: row.account_id, amount: display(ledger, BigInt(row.rollover_cents), row.asset_id), asset_id: row.asset_id, year: nextYear, month: nextMonth });
    return { applied: (preview.rollovers as Row[]).length, to_year: nextYear, to_month: nextMonth };
  },
  unbudgeted_spending: (ledger, args) => {
    const budgeted = new Set(effectiveBudgetRows(ledger, null, args.year, args.month).rows.map((row) => row.account_id));
    return (spendingRows(ledger, args.year, args.month, reportStatus(args, "posted"), args.quote_asset_id) as Row[]).filter((row) => !budgeted.has(row.account_id));
  },
  spending_rate: (ledger, args) => {
    const report = handlers.budget_status(ledger, args) as Row;
    const nowDate = new Date();
    const daysTotal = new Date(Date.UTC(args.year ?? nowDate.getUTCFullYear(), args.month ?? nowDate.getUTCMonth() + 1, 0)).getUTCDate();
    const daysElapsed = (args.year ?? nowDate.getUTCFullYear()) === nowDate.getUTCFullYear() && (args.month ?? nowDate.getUTCMonth() + 1) === nowDate.getUTCMonth() + 1 ? nowDate.getUTCDate() : daysTotal;
    return (report.budgets as Row[]).map((row) => ({ ...row, pace_cents: BigInt(row.budgeted_cents) * BigInt(daysElapsed) / BigInt(daysTotal), pace: BigInt(row.spent_cents) > BigInt(row.budgeted_cents) * BigInt(daysElapsed) / BigInt(daysTotal) ? "over" : "on_track" }));
  },
  forecast_month_end: (ledger, args) => ({ categories: handlers.spending_rate(ledger, args), overspend_risk: (handlers.spending_rate(ledger, args) as Row[]).filter((row) => BigInt(row.remaining_cents) < 0n) }),
  suggest_budgets: (ledger, args) => {
    const totals = new Map<string, bigint[]>();
    const nowDate = new Date();
    let year = args.year ?? nowDate.getUTCFullYear();
    let month = args.month ?? nowDate.getUTCMonth() + 1;
    for (let i = 0; i < (args.months ?? 3); i += 1) {
      for (const row of spendingRows(ledger, year, month, "posted", args.quote_asset_id) as Row[]) totals.set(row.account_id, [...(totals.get(row.account_id) ?? []), BigInt(row.amount_cents)]);
      month -= 1; if (month === 0) { month = 12; year -= 1; }
    }
    const budgeted = new Set(budgetRows(ledger).map((row) => row.account_id));
    const accounts = new Map(ledger.listAccounts().map((row) => [row.id, row]));
    const skipBudgeted = args.skip_budgeted !== false;
    return [...totals.entries()].filter(([accountId]) => !skipBudgeted || !budgeted.has(accountId)).map(([accountId, values]) => ({ account_id: accountId, account_name: accounts.get(accountId)?.name ?? "", suggested_cents: values.reduce((s, v) => s + v, 0n) / BigInt(values.length) }));
  },

  set_goal: (ledger, args) => {
    const acct = ledger.getAccount(account(ledger, args.account))!;
    if (acct.account_type !== "asset") throw new Error("Goals can only be set on asset accounts");
    const assetId = args.asset_id ? explicitAsset(ledger, args.asset_id) : accountAsset(ledger, acct.id);
    const quantity = amountToQuantity(ledger, assetId, args.target);
    if (quantity <= 0n) throw new Error("Goal target must be positive");
    ledger.setGoal(acct.id, assetId, quantity, args.name, args.target_date ?? null, args.priority ?? 1);
    return { account_id: acct.id, asset_id: assetId, name: args.name, target_quantity: quantity, target_cents: quantity, target_date: args.target_date ?? null, priority: args.priority ?? 1 };
  },
  list_goals: (ledger) => ledger.listGoalTargets().map((row) => ({ ...row, target_quantity: row.quantity, target_cents: row.quantity, ...handlers.goal_progress(ledger, { account: row.account_id }) as Row })),
  goal_progress: (ledger, args) => {
    const acct = account(ledger, args.account);
    const accountRow = ledger.getAccount(acct)!;
    const row = ledger.getGoalTarget(acct);
    if (!row) {
      return {
        found: false,
        account_id: acct,
        account_name: accountRow.name,
        goal: null,
        asset_id: null,
        name: null,
        target_quantity: null,
        target_cents: null,
        current_cents: null,
        remaining_cents: null,
        progress_pct: null
      };
    }
    const balance = ledger.balanceTree(acct, String(row.asset_id), null, null);
    const target = BigInt(row.quantity as string | number | bigint | boolean);
    return {
      found: true,
      account_id: acct,
      account_name: accountRow.name,
      goal: row,
      asset_id: row.asset_id,
      name: row.name,
      target_quantity: target,
      target_cents: target,
      current_cents: balance,
      remaining_cents: target > balance ? target - balance : 0n,
      progress_pct: target ? Number(balance) / Number(target) * 100 : 0
    };
  },
  delete_goal: (ledger, args) => ({ deleted: ledger.deleteGoal(account(ledger, args.account)), account_id: account(ledger, args.account) }),

  import_transactions: (ledger, args) => {
    if (args.date_tolerance_days != null && args.date_tolerance_days !== 1) unsupportedArguments({ date_tolerance_days: args.date_tolerance_days });
    if (args.dry_run) return importPreview(ledger, account(ledger, args.account_id), account(ledger, args.counterpart_id), args.transactions ?? [], args);
    const result = importTransactionRows(ledger, account(ledger, args.account_id), account(ledger, args.counterpart_id), args.transactions ?? [], { ...args, source_id: null });
    const status = parseTxStatus(args.status ?? "pending") ?? "pending";
    const batchStatus = status === "posted" ? "posted_import" : status === "pending" ? "pending_import" : `${status}_import`;
    const batchId = result.created > 0 ? batch(ledger, args.batch_label, { statement_type: args.statement_type }, batchStatus) : null;
    for (const tx of result.transactions) {
      if (batchId) {
        ledger.updateTransactionSource(String(tx.id), batchId);
        tx.source_id = batchId;
        tagTx(ledger, String(tx.id), "import_batch", batchId);
      }
      for (const [key, value] of Object.entries(args.tags ?? {})) tagTx(ledger, String(tx.id), key, String(value));
    }
    const transactions = result.transactions.map((tx) => txPublic(ledger, ledger.getTx(String(tx.id))!));
    return { ...result, transactions, batch_id: batchId, imported: result.created, skipped: result.skipped, transfer_stats: { matched: 0, unmatched: 0 } };
  },
  import_file: (ledger, args) => {
    const rows = parseStatementRows(ledger, args.file_path, args);
    return handlers.import_transactions(ledger, { account_id: args.account_id, counterpart_id: args.counterpart_account_id, transactions: rows, status: args.status ?? "pending", currency: args.currency, asset_id: args.asset_id, amount_convention: args.amount_convention ?? "signed", statement_type: args.statement_type });
  },
  preview_import: (_ledger, args) => {
    const rows = parseStatementRows(_ledger, args.file_path, args);
    return { rows: rows.slice(0, args.rows ?? 3), transactions: rows.slice(0, args.rows ?? 3), total_rows: rows.length, would_import: rows.length, warnings: [], dry_run: true };
  },
  preview_mutation: (ledger, args) => {
    const target = String(args.tool_name);
    if (!TOOL_NAMES.includes(target as ToolName)) throw new Error(`Tool '${target}' is not implemented`);
    if (target === "preview_mutation") throw new Error("preview_mutation cannot preview itself");
    const targetArgs = normalizeToolInput(target, safeJson(args.arguments ?? {}));
    return mutationPreview(ledger, target as ToolName, targetArgs);
  },
  process_statement: (ledger, args) => {
    unsupportedArguments({ transfer_account_id: args.transfer_account_id });
    const plan = buildStatementPlan(ledger, { ...args, status: "posted" }, { persist: Boolean(args.commit), targetStatus: "posted" });
    const actions = plan.actions ?? {};
    const newRows = (actions.new_posted ?? 0) + (actions.new_pending ?? 0);
    const wouldApply = newRows + (actions.pending_to_commit ?? 0) + (actions.stale_pending_to_void ?? 0);
    const preview = {
      ...plan,
      transactions: [...(plan.new_posted ?? []), ...(plan.pending_to_commit ?? [])].slice(0, args.preview_rows ?? 10),
      matched_existing: actions.matched ?? 0,
      pending_to_commit_count: actions.pending_to_commit ?? 0,
      stale_pending_to_void_count: actions.stale_pending_to_void ?? 0,
      new_rows: newRows,
      ambiguous_count: actions.ambiguous ?? 0,
      ignored_count: actions.ignored ?? 0,
      would_import: newRows,
      would_apply: wouldApply,
      dry_run: !args.commit
    };
    return args.commit ? { ...preview, ...applyStatementPlan(ledger, String(plan.plan_id), { dry_run: false, batch_label: args.batch_label }) } : { ...preview, created: 0 };
  },
  list_import_batches: (ledger, args) => {
    const rows = new Map<string, Row>();
    for (const row of ledger.listSources("import", args.limit ?? 1000)) {
      rows.set(String(row.id), { ...row, id: String(row.id), batch_id: String(row.id), origin: "source", tx_count: txIdsForBatch(ledger, String(row.id)).length });
    }
    for (const tag of ledger.listAnnotationValues("tx", "import_batch")) {
      const batchId = String(tag.value);
      const existing = rows.get(batchId);
      rows.set(batchId, {
        ...existing,
        id: batchId,
        batch_id: batchId,
        type: existing?.type ?? "import",
        label: existing?.label ?? batchId,
        status: existing?.status ?? "tagged",
        created_at: existing?.created_at ?? tag.first_seen_at ?? "",
        origin: existing ? "source+tag" : "tag",
        tx_count: txIdsForBatch(ledger, batchId).length
      });
    }
    return [...rows.values()]
      .filter((row) => !args.date_from || !row.created_at || String(row.created_at) >= args.date_from)
      .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))
      .slice(0, args.limit ?? 20);
  },
  rollback_import: (ledger, args) => {
    const txIds = txIdsForBatch(ledger, args.batch_id);
    for (const txId of txIds) if (ledger.getTx(txId)) ledger.voidTx(txId);
    ledger.updateSourceStatus(args.batch_id, "rolled_back");
    return { batch_id: args.batch_id, rolled_back: txIds.length, tx_ids: txIds };
  },
  reverse_ledger_operation: (ledger, args) => reverseLedgerOperation(ledger, args),
  commit_batch: (ledger, args) => {
    const selected = selectBatchTransactions(ledger, args);
    if (!args.dry_run) {
      for (const txId of selected) if (ledger.getTx(txId)?.status === "pending") ledger.updateTxStatus(txId, "posted");
      if (args.batch_id) ledger.updateSourceStatus(args.batch_id, "committed");
    }
    return { matched: selected.length, committed: args.dry_run ? 0 : selected.length, tx_ids: selected, dry_run: Boolean(args.dry_run) };
  },
  discard_batch: (ledger, args) => {
    const selected = selectBatchTransactions(ledger, args);
    if (args.dry_run === false) {
      for (const txId of selected) ledger.deleteTx(txId);
      if (args.batch_id) ledger.updateSourceStatus(args.batch_id, "discarded");
    }
    return { matched: selected.length, discarded: args.dry_run === false ? selected.length : 0, tx_ids: selected, dry_run: args.dry_run !== false };
  },
  invert_import: (ledger, args) => handlers.flip_entries(ledger, { tx_ids: txIdsForBatch(ledger, args.batch_id) }),

  add_match_rule: (ledger, args) => ({ id: ledger.createRule("match", account(ledger, args.account_id), args.pattern), account_id: account(ledger, args.account_id), pattern: args.pattern }),
  add_match_rules: (ledger, args) => {
    const rules: Row[] = [];
    const errors: Row[] = [];
    (args.rules ?? []).forEach((row: Row, index: number) => {
      try {
        rules.push(handlers.add_match_rule(ledger, { account_id: row.account_id ?? row.account, pattern: row.pattern }) as Row);
      } catch (error) {
        errors.push({ index, error: error instanceof Error ? error.message : String(error) });
      }
    });
    return { created: rules.length, rules, errors };
  },
  list_match_rules: (ledger) => ledger.listRules("match"),
  delete_match_rule: (ledger, args) => ({ deleted: ledger.deleteRule(account(ledger, args.account_id), args.pattern), account_id: account(ledger, args.account_id), pattern: args.pattern }),
  delete_match_rules: (ledger, args) => ({ deleted: (args.rules ?? []).reduce((sum: number, row: Row) => sum + Number((handlers.delete_match_rule(ledger, { account_id: row.account_id ?? row.account, pattern: row.pattern }) as Row).deleted), 0), errors: [] }),
  apply_match_rules: (ledger, args) => {
    const catchAll = account(ledger, args.catch_all_account_id);
    const changed: Row[] = [];
    const dryRun = args.dry_run !== false;
    for (const tx of ledger.listTransactions({ status: null, dateFrom: optionalDate(args.date_from), dateTo: optionalDate(args.date_to) })) {
      const match = ledger.autoCategorize(tx.description);
      if (!match) continue;
      if (ledger.getEntries(tx.id).some((entry) => entry.account_id === catchAll)) {
        changed.push({ tx_id: tx.id, new_account_id: match });
        if (!dryRun) ledger.recategorizeTransaction(tx.id, catchAll, match);
      }
    }
    return { matched: changed.length, updated: dryRun ? 0 : changed.length, transactions: changed, dry_run: dryRun };
  },
  apply_pattern: (ledger, args) => {
    unsupportedArguments({ force: args.force });
    return handlers.recategorize_by_pattern(ledger, { pattern: args.pattern, new_account_id: args.target_account, old_account_id: args.source_account, date_from: args.date_from, date_to: args.date_to, dry_run: args.dry_run, persist_rule: args.persist_rule });
  },
  recategorize_by_pattern: (ledger, args) => {
    const newAccount = account(ledger, args.new_account_id);
    const oldAccount = args.old_account_id ? account(ledger, args.old_account_id) : null;
    const dryRun = args.dry_run !== false;
    const matches: Row[] = [];
    const regex = safeMatchRegex(args.pattern);
    for (const tx of iterTransactions(ledger, { status: reportStatus(args, "posted"), date_from: args.date_from, date_to: args.date_to })) {
      if (!regex.test(tx.description.slice(0, MAX_MATCH_INPUT_LENGTH))) continue;
      const entries = ledger.getEntries(tx.id);
      const magnitudes = entries.map((entry) => entry.quantity < 0n ? -entry.quantity : entry.quantity);
      if (args.amount_min != null && (magnitudes.length === 0 || magnitudes.every((amount) => amount < BigInt(args.amount_min as string | number | bigint | boolean)))) continue;
      if (args.amount_max != null && (magnitudes.length === 0 || magnitudes.every((amount) => amount > BigInt(args.amount_max as string | number | bigint | boolean)))) continue;
      const selectedOld = oldAccount ?? entries.find((entry) => ledger.getAccount(entry.account_id)?.account_type === "expense")?.account_id ?? entries[0]?.account_id;
      if (!selectedOld) continue;
      matches.push({ tx_id: tx.id, old_account_id: selectedOld, new_account_id: newAccount, description: tx.description });
    }
    const batchId = id("recat");
    if (!dryRun) for (const match of matches) { ledger.recategorizeTransaction(match.tx_id, match.old_account_id, match.new_account_id); tagTx(ledger, match.tx_id, "recategorize_batch", batchId); tagTx(ledger, match.tx_id, "recategorize_from", match.old_account_id); tagTx(ledger, match.tx_id, "recategorize_to", match.new_account_id); }
    if (args.persist_rule && !dryRun) ledger.createRule("match", newAccount, args.pattern);
    return { matched: matches.length, updated: dryRun ? 0 : matches.length, transactions: args.verbose || dryRun ? matches : [], batch_id: batchId, dry_run: dryRun };
  },
  recategorize_by_patterns: (ledger, args) => {
    const results = (args.rules ?? []).map((rule: Row) => handlers.recategorize_by_pattern(ledger, { ...args, pattern: rule.pattern, new_account_id: rule.new_account_id ?? rule.target_account, persist_rule: args.persist_rules }));
    return { rules: results.length, matched: results.reduce((s: number, r: any) => s + r.matched, 0), updated: results.reduce((s: number, r: any) => s + r.updated, 0), results, dry_run: args.dry_run !== false };
  },
  rollback_recategorize: (ledger, args) => {
    const rows = ledger.listAnnotationEntityIds("tx", "recategorize_batch", args.batch_id).map((entity_id) => ({ entity_id }));
    let rolled = 0;
    for (const row of rows) {
      const txId = String(row.entity_id);
      const tags = ledger.listAnnotations("tx", txId);
      const from = tags.filter((tag) => tag.key === "recategorize_from").at(-1)?.value;
      const taggedTo = tags.filter((tag) => tag.key === "recategorize_to").at(-1)?.value;
      const entries = ledger.getEntries(txId);
      const fromAccountType = from ? ledger.getAccount(from)?.account_type : null;
      const sameTypeAccounts = [...new Set(entries
        .filter((entry) => entry.account_id !== from && (!fromAccountType || ledger.getAccount(entry.account_id)?.account_type === fromAccountType))
        .map((entry) => entry.account_id))];
      const current = taggedTo && entries.some((entry) => entry.account_id === taggedTo) ? taggedTo : sameTypeAccounts.length === 1 ? sameTypeAccounts[0] : null;
      if (from && current && current !== from) { ledger.recategorizeTransaction(txId, current, from); rolled += 1; }
    }
    return { batch_id: args.batch_id, rolled_back: rolled };
  },

  export_transactions: (ledger, args) => ledger.exportTransactionsCsv(
    args.output_path ? resolveToolWritePath(ledger.path, args.output_path, new Set([".csv"])) : null,
    {
      accountId: args.account_id ? account(ledger, args.account_id) : null,
      dateFrom: optionalDate(args.date_from),
      dateTo: optionalDate(args.date_to),
      status: parseTxStatusFilter(args.status)
    }
  ),
  file_access_status: (ledger) => fileAccessStatus(ledger.path),
  export_ledger: (ledger, args) => {
    const doc = scopedExportDocument(ledger, args);
    const text = stringifyPublic(doc);
    const content_hash = createHash("sha256").update(text).digest("hex");
    if (args.output_path) {
      const output = resolveToolWritePath(ledger.path, args.output_path, new Set([".json"]));
      writeFileSync(output, text, "utf8");
      return { file: redactToolPath(ledger.path, output), content_hash };
    }
    return { data: text, content_hash };
  },
  import_ledger: (ledger, args) => {
    if (Boolean(args.file_path) === Boolean(args.data)) throw new Error("Exactly one of file_path or data is required");
    const text = args.file_path ? readFileSync(resolveToolReadPath(ledger.path, args.file_path, new Set([".json"])), "utf8") : String(args.data);
    assertToolDataSize(text);
    return ledger.importDocument(JSON.parse(text), args.preserve_ids !== false, Boolean(args.dry_run));
  },

  create_price: (ledger, args) => ({ id: ledger.createPrice(asset(ledger, args.asset_id), asset(ledger, args.quote_id), args.rate, args.time), asset_id: asset(ledger, args.asset_id), quote_asset_id: asset(ledger, args.quote_id), rate: args.rate, time: args.time }),
  list_prices: (ledger) => ledger.listPrices(),
  get_price: (ledger, args) => ledger.queryPrice(asset(ledger, args.asset_id), asset(ledger, args.quote_id), optionalDate(args.as_of) ?? "9999-12-31"),
  fx_transfer: (ledger, args) => {
    const fromAsset = asset(ledger, args.from_asset_id);
    const toAsset = asset(ledger, args.to_asset_id);
    const fromQty = amountToQuantity(ledger, fromAsset, args.from_amount);
    const toQty = amountToQuantity(ledger, toAsset, args.to_amount);
    if (fromQty <= 0n || toQty <= 0n) throw new Error("FX transfer amounts must be positive");
    const txDate = validateDate(args.date);
    const txId = ledger.postTx(txDate, args.status ?? "posted", args.description, [
      [account(ledger, args.from_account_id), fromAsset, -fromQty],
      [account(ledger, args.fx_account_id), fromAsset, fromQty],
      [account(ledger, args.fx_account_id), toAsset, -toQty],
      [account(ledger, args.to_account_id), toAsset, toQty]
    ]);
    if (args.record_rate !== false) ledger.createPrice(fromAsset, toAsset, Number(args.to_amount) / Number(args.from_amount), txDate);
    return txWithEntries(ledger, txId);
  },

  create_scheduled_transaction: (ledger, args) => {
    const fromAccountId = account(ledger, args.from_account_id);
    const toAccountId = account(ledger, args.to_account_id);
    const assetId = transactionAsset(ledger, fromAccountId, toAccountId, args.asset_id);
    const row = ledger.createRecurrence(validateDate(args.date), amountToQuantity(ledger, assetId, args.amount), fromAccountId, toAccountId, args.description ?? "", args.frequency ?? "monthly", args.end_date ? validateDate(String(args.end_date)) : null, assetId);
    return { id: row.id, next_date: args.date, frequency: args.frequency ?? "monthly" };
  },
  list_scheduled: (ledger) => ledger.listRecurrences(),
  process_scheduled: (ledger, args) => {
    const through = args.through_date ? validateDate(String(args.through_date)) : today();
    const posted: string[] = [];
    for (const row of handlers.list_scheduled(ledger, {}) as Row[]) {
      if (row.status !== "active" || row.next_date > through) continue;
      const tx = ledger.recordTransaction(row.next_date, BigInt(row.quantity), row.from_account_id, row.to_account_id, row.asset_id, row.description, "posted");
      posted.push(tx.id);
      const next = new Date(`${row.next_date}T00:00:00Z`);
      if (row.frequency === "daily") next.setUTCDate(next.getUTCDate() + 1);
      else if (row.frequency === "weekly") next.setUTCDate(next.getUTCDate() + 7);
      else if (row.frequency === "yearly") next.setUTCFullYear(next.getUTCFullYear() + 1);
      else next.setUTCMonth(next.getUTCMonth() + 1);
      ledger.updateRecurrenceNextDate(String(row.id), next.toISOString().slice(0, 10));
    }
    return { posted: posted.length, tx_ids: posted };
  },
  detect_recurring: (ledger, args) => {
    const accountId = args.account_id ? account(ledger, args.account_id) : null;
    const [dateFrom, dateTo] = recurringDateRange(args);
    const tolerancePct = Number(args.amount_tolerance_pct ?? 5);
    const groups: Array<{ description: string; amount: bigint; occurrences: number; dates: string[]; tx_ids: string[] }> = [];
    for (const tx of ledger.listTransactions({ status: "posted", dateFrom, dateTo, sort: "date_asc" })) {
      if (!tx.description) continue;
      if (accountId && !ledger.getEntries(tx.id).some((entry) => entry.account_id === accountId)) continue;
      const amount = transactionMagnitude(ledger, tx.id, accountId);
      const descriptionKey = tx.description.trim().toLowerCase();
      const group = groups.find((row) => row.description.trim().toLowerCase() === descriptionKey && amountWithinTolerance(row.amount, amount, tolerancePct));
      if (group) {
        group.occurrences += 1;
        group.dates.push(tx.date);
        group.tx_ids.push(tx.id);
      } else {
        groups.push({ description: tx.description, amount, occurrences: 1, dates: [tx.date], tx_ids: [tx.id] });
      }
    }
    return groups
      .filter((row) => row.occurrences >= (args.min_occurrences ?? 2))
      .map((row) => ({ ...row, amount_cents: row.amount, first_date: row.dates[0], last_date: row.dates.at(-1), months: args.months ?? 6, date_from: dateFrom, date_to: dateTo }));
  },

  pending_summary: (ledger, args) => {
    const [date_from, date_to] = args.year ? monthBounds(args.year, args.month) : [undefined, undefined];
    const rows = ledger.listTransactions({ status: "pending", dateFrom: date_from, dateTo: date_to }).map((tx) => txPublic(ledger, tx));
    return { count: rows.length, transactions: rows, total_cents: rows.reduce((sum, row) => sum + BigInt(row.amount_cents), 0n) };
  },
  operating_manual: (_ledger, args) => operatingManual(args.topic),
  record_pending_expenses: (ledger, args) => {
    const accountId = account(ledger, args.account_id);
    const explicitFallback = args.counterpart_id ? account(ledger, args.counterpart_id) : null;
    const rows = (args.transactions ?? []).map((row: Row) => {
      const matched = counterpartForRow(ledger, row, explicitFallback);
      return matched ? { ...row, counterpart_id: matched } : row;
    });
    const hasUnresolved = rows.some((row: Row) => !row.counterpart_id);
    if (args.dry_run !== false) {
      const previewFallback = hasUnresolved ? ledger.findAccount("Pending Expenses")?.id ?? "__pending_expenses__" : explicitFallback ?? null;
      const previewRows = hasUnresolved ? rows.map((row: Row) => row.counterpart_id ? row : { ...row, counterpart_id: previewFallback }) : rows;
      const preview = importPreview(ledger, accountId, previewFallback, previewRows, { ...args, status: "pending", amount_convention: "unsigned_charges" });
      const usesSyntheticFallback = (preview.transactions as Row[]).some((tx) => (tx.entries as Row[]).some((entry) => entry.account_id === "__pending_expenses__"));
      return {
        ...preview,
        would_create_account: usesSyntheticFallback ? "Pending Expenses" : null
      };
    }
    const fallback = hasUnresolved ? ledger.getOrCreateAccount("Pending Expenses", "expense") : explicitFallback ?? String(rows.find((row: Row) => row.counterpart_id)?.counterpart_id ?? "");
    if (!fallback && rows.length === 0) return { created: 0, transactions: [], errors: [], skipped: 0, dry_run: false, batch_id: null, imported: 0, transfer_stats: { matched: 0, unmatched: 0 } };
    const importRows = rows.map((row: Row) => row.counterpart_id ? row : { ...row, counterpart_id: fallback });
    return handlers.import_transactions(ledger, {
      account_id: args.account_id,
      counterpart_id: fallback,
      transactions: importRows,
      status: "pending",
      dry_run: args.dry_run !== false,
      batch_label: args.batch_label,
      tags: args.tags,
      amount_convention: "unsigned_charges",
      asset_id: args.asset_id,
      skip_dedup: args.skip_dedup
    });
  },
  find_pending_duplicates: (ledger, args) => {
    const tolerance = Number(args.date_tolerance_days ?? 3);
    const pending = (handlers.list_transactions(ledger, { account_id: args.account_id, status: "pending", date_from: args.date_from, date_to: args.date_to, compact: false, limit: 100000 }) as Row).transactions as Row[];
    const posted = (handlers.list_transactions(ledger, { account_id: args.account_id, status: "posted", compact: false, limit: 100000 }) as Row).transactions as Row[];
    const byAmountDescription = (rows: Row[]) => {
      const groups = new Map<string, Row[]>();
      for (const tx of rows) {
        const key = `${tx.amount_cents}|${String(tx.description).toLowerCase()}`;
        groups.set(key, [...(groups.get(key) ?? []), tx]);
      }
      return groups;
    };
    const pendingGroups = byAmountDescription(pending);
    const postedGroups = byAmountDescription(posted);
    const duplicates: Row[] = [];
    for (const [key, rows] of pendingGroups) {
      if (rows.length > 1 && rows.some((left, index) => rows.slice(index + 1).some((right) => dateDeltaDays(String(left.date), String(right.date)) <= tolerance))) {
        duplicates.push({ type: "pending", key, tx_ids: rows.map((tx) => tx.id) });
      }
      const postedMatches = (postedGroups.get(key) ?? []).filter((postedTx) => rows.some((pendingTx) => dateDeltaDays(String(pendingTx.date), String(postedTx.date)) <= tolerance));
      if (postedMatches.length > 0) {
        duplicates.push({
          type: "posted",
          key,
          pending_tx_ids: rows.map((tx) => tx.id),
          posted_tx_ids: postedMatches.map((tx) => tx.id),
          tx_ids: [...rows.map((tx) => tx.id), ...postedMatches.map((tx) => tx.id)]
        });
      }
    }
    return { duplicates, count: duplicates.length };
  },
  find_realized_planned: (ledger, args) => {
    const rows = realizedPlannedRows(ledger, args);
    return {
      realized_planned_rows: rows,
      count: rows.length,
      matched: rows.length,
      ambiguous_count: rows.filter((row) => row.ambiguous).length,
      dry_run: true
    };
  },
  reconcile_planned: (ledger, args) => {
    const rows = realizedPlannedRows(ledger, args);
    const dryRun = args.dry_run !== false;
    const ambiguous = rows.filter((row) => row.ambiguous);
    if (!dryRun && ambiguous.length > 0) throw new Error("reconcile_planned found ambiguous matches; review realized_planned_rows before voiding planned rows");
    if (!dryRun) {
      for (const row of rows) {
        const tx = ledger.getTx(String(row.planned_tx_id));
        if (tx?.status === "planned") ledger.voidTx(tx.id);
      }
    }
    return {
      realized_planned_rows: rows,
      matched: rows.length,
      ambiguous_count: ambiguous.length,
      voided: dryRun ? 0 : rows.length,
      tx_ids: rows.map((row) => row.planned_tx_id),
      dry_run: dryRun
    };
  },
  forecast: (ledger, args) => {
    const accountId = account(ledger, args.account_id);
    const assetId = args.asset_id ? explicitAsset(ledger, args.asset_id) : accountAsset(ledger, accountId);
    const asOf = optionalDate(args.as_of);
    return { account_id: accountId, posted_cents: ledger.balanceTree(accountId, assetId, asOf, "posted"), pending_cents: ledger.balanceTree(accountId, assetId, asOf, "pending"), planned_cents: ledger.balanceTree(accountId, assetId, asOf, "planned"), projected_cents: ledger.balanceTree(accountId, assetId, asOf, null) };
  },
  preview_commit: (ledger, args) => {
    const accounts = new Map(ledger.listAccounts().map((row) => [row.id, row]));
    const changes = new Map<string, bigint>();
    for (const tx of ledger.listTransactions({ status: "pending", dateTo: optionalDate(args.as_of) })) for (const entry of ledger.getEntries(tx.id)) changes.set(entry.account_id, (changes.get(entry.account_id) ?? 0n) + entry.quantity);
    const rows = [...changes.entries()].filter(([, amount]) => amount !== 0n).map(([accountId, amount]) => ({ account_id: accountId, account_name: accounts.get(accountId)?.name ?? "", change_cents: amount }));
    return { affected_accounts: rows, total_accounts: rows.length };
  },
  project_month_end: (ledger, args) => {
    const projectionAccounts = splitProjectionAccounts(ledger, args);
    const projection = handlers.cash_projection(ledger, {
      ...args,
      include_pending: args.include_pending ?? true,
      include_planned: args.include_planned ?? true,
      ...projectionAccounts
    }) as Row;
    const quote = reportAsset(ledger, args.quote_asset_id);
    const inflows = [...(args.expected_inflows ?? []), ...(args.expected_paychecks ?? [])].reduce((sum: bigint, row: Row) => sum + amountToQuantity(ledger, quote, row.amount ?? 0), 0n);
    const outflows = (args.expected_outflows ?? []).reduce((sum: bigint, row: Row) => sum + amountToQuantity(ledger, quote, row.amount ?? 0), 0n);
    return { ...projection, projected_month_end_cents: BigInt(projection.available_cash_cents) + inflows - outflows };
  },
  project_balances: (ledger, args) => {
    unsupportedArguments({ branch: args.branch });
    const quote = reportAsset(ledger, args.quote_asset_id);
    const accounts = nonOverlappingAccounts(ledger, args.account_ids ?? rootAccountIds(ledger, ["asset", "liability"]));
    const missing: Row[] = [];
    const rows = accounts.map((accountId: string) => {
      const result = ledger.quotedBalanceTree(accountId, quote, validateDate(String(args.through)), null);
      missing.push(...result.missing);
      return { account_id: accountId, balance_cents: result.total };
    });
    return {
      through: args.through,
      accounts: rows,
      net_worth_cents: rows.reduce((sum: bigint, row: Row) => sum + BigInt(row.balance_cents), 0n),
      quote_asset_id: quote,
      valuation_complete: missing.length === 0,
      missing_conversions: missing,
      goals: args.include_goals ? handlers.list_goals(ledger, {}) : undefined
    };
  },

  create_branch: (ledger, args) => {
    const branch = ledger.createScenarioBook(args.name);
    return { id: branch.id, name: branch.name, discarded_at: branch.closed_at ?? null };
  },
  list_branches: (ledger) => ledger.listScenarioBooks().map((row) => ({ ...row, merged_at: null, discarded_at: row.closed_at })),
  merge_branch: (ledger, args) => {
    const branch = ledger.getScenarioBook(String(args.source));
    if (!branch) throw new Error(`Scenario '${String(args.source)}' not found`);
    if (branch.closed_at != null) throw new Error(`Scenario '${String(args.source)}' is discarded`);
    ledger.createAnnotation("book", String(branch.id), "merged_at", now());
    return { merged: branch.id, name: branch.name };
  },
  discard_branch: (ledger, args) => {
    const branch = ledger.getScenarioBook(String(args.name));
    if (!branch) throw new Error(`Scenario '${String(args.name)}' not found`);
    const discarded = ledger.discardScenarioBook(String(args.name));
    return { discarded: branch.id, name: branch.name, updated: discarded };
  },
  compare_scenarios: (ledger, args) => {
    const assetId = asset(ledger, args.asset_id);
    const rows = ledger.listAccounts().map((acct) => {
      const a = ledger.balanceTree(acct.id, assetId, optionalDate(args.as_of_a), null);
      const b = ledger.balanceTree(acct.id, assetId, optionalDate(args.as_of_b), null);
      return a === b ? null : { account_id: acct.id, account_name: acct.name, a_cents: a, b_cents: b, delta_cents: b - a };
    }).filter(Boolean);
    return { differences: rows, as_of_a: args.as_of_a ?? null, as_of_b: args.as_of_b ?? null };
  },
  close_period: (ledger, args) => ledger.closePeriod(args.name, validateDate(args.as_of), args.description),
  list_checkpoints: (ledger) => ledger.listCheckpoints(),
  reopen_period: (ledger, args) => ledger.reopenPeriod(args.checkpoint_id),

  assert_balance: (ledger, args) => {
    const accountId = account(ledger, args.account_id);
    const assetId = args.asset_id ? explicitAsset(ledger, args.asset_id) : accountAsset(ledger, accountId);
    const actual = ledger.balanceTree(accountId, assetId, optionalDate(args.date), parseTxStatusFilter(args.status));
    const expected = amountToQuantity(ledger, assetId, args.expected);
    return { account_id: accountId, expected_cents: expected, actual_cents: actual, matches: actual === expected, difference_cents: actual - expected, date: args.date ?? null };
  },
  assert_balances: (ledger, args) => {
    const results = (args.assertions ?? []).map((row: Row) => handlers.assert_balance(ledger, { account_id: row.account_id ?? row.account, expected: row.expected, date: row.date, asset_id: row.asset_id, status: args.status }));
    return { matches: results.every((row: any) => row.matches), results };
  },
  reconcile_to_balance: (ledger, args) => {
    const accountId = account(ledger, args.account_id);
    const offset = account(ledger, args.offset_account_id);
    const assetId = args.asset_id ? explicitAsset(ledger, args.asset_id) : accountAsset(ledger, accountId);
    const current = ledger.balanceTree(accountId, assetId);
    const target = amountToQuantity(ledger, assetId, args.target_balance);
    const diff = target - current;
    if (args.dry_run || diff === 0n) return { current_cents: current, target_cents: target, difference_cents: diff, dry_run: Boolean(args.dry_run), posted: false };
    const date = validateDate(args.date);
    const tx = diff > 0n ? ledger.recordTransaction(date, diff, offset, accountId, assetId, args.description ?? "Reconcile balance", args.status ?? "posted") : ledger.recordTransaction(date, -diff, accountId, offset, assetId, args.description ?? "Reconcile balance", args.status ?? "posted");
    return { current_cents: current, target_cents: target, difference_cents: diff, posted: true, transaction: txPublic(ledger, tx) };
  },
  reconcile_statement: (ledger, args) => {
    const accountId = account(ledger, args.account_id);
    const assetId = args.asset_id ? explicitAsset(ledger, args.asset_id) : args.currency ? asset(ledger, null, args.currency) : accountAsset(ledger, accountId);
    const existing = (handlers.list_transactions(ledger, { account_id: accountId, status: null, compact: false, limit: 100000 }) as Row).transactions as Row[];
    const unmatched: Row[] = [];
    const tolerance = Number(args.date_tolerance_days ?? 0);
    for (const row of args.transactions ?? []) {
      const amount = signedStatementQuantity(ledger, assetId, row, args.amount_convention);
      const found = existing.some((tx) => dateDeltaDays(String(tx.date), String(row.date)) <= tolerance && (tx.entries as Row[]).some((entry) => entry.account_id === accountId && entry.asset_id === assetId && BigInt(entry.quantity) === amount));
      if (!found) unmatched.push(row);
    }
    return { matched: (args.transactions ?? []).length - unmatched.length, unmatched: unmatched.length, unmatched_rows: unmatched, reconciled: unmatched.length === 0 };
  },
  reconcile_statement_plan: (ledger, args) => {
    return buildStatementPlan(ledger, { ...args, status: "posted" }, { persist: false, targetStatus: "posted" });
  },
  apply_reconciliation_plan: (ledger, args) => {
    const targetStatus = args.status ?? "pending";
    if (args.plan_id) return applyStatementPlan(ledger, args.plan_id, args);
    const plan = buildStatementPlan(ledger, { ...args, status: targetStatus }, { persist: args.dry_run === false, targetStatus });
    return args.dry_run === false ? applyStatementPlan(ledger, String(plan.plan_id), args) : plan;
  },
  refresh_statement: (ledger, args) => {
    const action = String(args.action ?? "plan");
    if (action === "plan") return buildStatementPlan(ledger, { ...args, status: args.status ?? "posted" }, { persist: args.dry_run === false, targetStatus: args.status ?? "posted" });
    if (action === "apply") return applyStatementPlan(ledger, args.plan_id, args);
    if (action === "verify") return verifyStatementPlan(ledger, args.plan_id);
    if (action === "discard") {
      const plan = ledger.getStatementPlan(args.plan_id);
      if (!plan) throw new Error(`Statement plan '${String(args.plan_id)}' not found`);
      if (args.dry_run !== false) return { dry_run: true, would_discard: true, plan_id: args.plan_id, status: plan.status };
      return { ...ledger.discardStatementPlan(args.plan_id), dry_run: false, discarded: true };
    }
    throw new Error("action must be plan, apply, verify, or discard");
  },
  reconcile_diff: (ledger, args) => {
    unsupportedArguments({ branch: args.branch });
    const accountId = account(ledger, args.account_id);
    const txs = ledger.listTransactions({ status: null, dateFrom: optionalDate(args.date_from), dateTo: optionalDate(args.date_to) }).filter((tx) => amountForAccount(ledger, tx.id, accountId) !== 0n).map((tx) => txPublic(ledger, tx));
    return { account_id: accountId, missing: [], extra: [], transactions: txs };
  },
  match_transfers: (ledger, args) => {
    const a = account(ledger, args.account_a);
    const b = account(ledger, args.account_b);
    const txs = iterTransactions(ledger, { status: reportStatus(args, "pending") });
    const pairs: Row[] = [];
    const maybeAddPair = (txA: Journal, txB: Journal) => {
      const amountA = amountForAccount(ledger, txA.id, a);
      const amountB = amountForAccount(ledger, txB.id, b);
      const delta = dateDeltaDays(txA.date, txB.date);
      if (amountA !== 0n && amountA === -amountB && delta <= (args.date_tolerance_days ?? 1)) pairs.push({ tx_a: txA.id, tx_b: txB.id, amount_cents: amountA < 0n ? -amountA : amountA });
    };
    for (let leftIndex = 0; leftIndex < txs.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < txs.length; rightIndex += 1) {
        maybeAddPair(txs[leftIndex], txs[rightIndex]);
        maybeAddPair(txs[rightIndex], txs[leftIndex]);
      }
    }
    const dryRun = args.dry_run !== false;
    if (!dryRun) for (const pair of pairs) { tagTx(ledger, pair.tx_a, "transfer", "matched"); tagTx(ledger, pair.tx_b, "transfer", "matched"); }
    return { matched: pairs.length, pairs, dry_run: dryRun };
  },
  match_transfer_pairs: (ledger, args) => args.account_a && args.account_b ? handlers.match_transfers(ledger, { ...args, status: "pending" }) : { matched: 0, pairs: [], dry_run: args.dry_run !== false },
  consolidate_transfers: (ledger, args) => {
    const result = handlers.match_transfers(ledger, { ...args, dry_run: true, status: "pending" }) as Row;
    const dryRun = args.dry_run !== false;
    if (!dryRun) for (const pair of result.pairs as Row[]) { tagTx(ledger, pair.tx_a, "transfer", "consolidated"); ledger.voidTx(pair.tx_b); }
    return { ...result, consolidated: dryRun ? 0 : (result.pairs as Row[]).length, dry_run: dryRun };
  },
  list_unmatched_transfers: (ledger, args) => {
    const tolerance = Number(args.date_tolerance_days ?? 3);
    const pending = iterTransactions(ledger, { status: "pending" });
    const tagged = pending.filter((tx) => ledger.listAnnotations("tx", tx.id).some((tag) => tag.key === "transfer" && tag.value === "unmatched"));
    return tagged.filter((tx) => !pending.some((other) => {
      if (other.id === tx.id) return false;
      if (dateDeltaDays(tx.date, other.date) > tolerance) return false;
      const txEntries = ledger.getEntries(tx.id);
      const otherEntries = ledger.getEntries(other.id);
      return txEntries.some((left) => otherEntries.some((right) => left.asset_id === right.asset_id && left.quantity === -right.quantity));
    })).map((tx) => txPublic(ledger, tx));
  },

  list_uncategorized: (ledger, args) => {
    const catchAll = args.catch_all_account_id ? account(ledger, args.catch_all_account_id) : null;
    const accounts = new Map(ledger.listAccounts().map((row) => [row.id, row]));
    const rows = iterTransactions(ledger, { status: reportStatus(args, "pending"), date_from: args.date_from, date_to: args.date_to }).filter((tx) => ledger.getEntries(tx.id).some((entry) => catchAll ? entry.account_id === catchAll : accounts.get(entry.account_id)?.name.toLowerCase() === "uncategorized")).map((tx) => txPublic(ledger, tx, Boolean(args.compact)));
    return { transactions: rows.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 50)), items: rows, total: rows.length, limit: args.limit ?? 50, offset: args.offset ?? 0 };
  },
  audit_categorization: (ledger, args) => {
    const uncategorized = handlers.list_uncategorized(ledger, { status: reportStatus(args, "posted"), date_from: args.date_from, date_to: args.date_to, limit: 1000, compact: true }) as Row;
    const counts = new Map<string, number>();
    for (const tx of uncategorized.transactions as Row[]) counts.set(String(tx.description), (counts.get(String(tx.description)) ?? 0) + 1);
    return { mode: args.mode ?? "budget", uncategorized, frequent_descriptions: [...counts.entries()].filter(([, count]) => count >= (args.min_occurrences ?? 2)).map(([description, count]) => ({ description, count })) };
  },
  top_descriptions: (ledger, args) => {
    const accountId = account(ledger, args.account_id);
    const counts = new Map<string, { count: number; amount: bigint }>();
    for (const tx of iterTransactions(ledger, { status: args.status })) {
      const amount = amountForAccount(ledger, tx.id, accountId);
      if (amount === 0n) continue;
      const current = counts.get(tx.description) ?? { count: 0, amount: 0n };
      current.count += 1; current.amount += amount < 0n ? -amount : amount; counts.set(tx.description, current);
    }
    return [...counts.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, args.limit ?? 50).map(([description, row]) => ({ description, count: row.count, amount_cents: row.amount }));
  },
  count_transactions: (ledger, args) => {
    let rows = iterTransactions(ledger, { status: args.status, date_from: args.date_from, date_to: args.date_to });
    if (args.account_id) rows = rows.filter((tx) => amountForAccount(ledger, tx.id, account(ledger, args.account_id)) !== 0n);
    return { count: rows.length, by_status: Object.fromEntries([...new Set(rows.map((tx) => tx.status))].map((status) => [status, rows.filter((tx) => tx.status === status).length])) };
  },
  age_of_money: (ledger, args) => ageOfMoney(ledger, args),

  record_investment: (ledger, args) => handlers.create_transaction(ledger, { from_account_id: args.source_account_id, to_account_id: args.investment_account_id, amount: args.amount, date: args.date, description: args.description, status: args.status ?? "posted", asset_id: args.asset_id }),
  buy_security: (ledger, args) => {
    const investmentAccount = account(ledger, args.account_id);
    const cashAsset = args.asset_id ? explicitAsset(ledger, args.asset_id) : accountAsset(ledger, investmentAccount);
    const shares = toAtomicUnits(args.shares, 8);
    const totalCost = BigInt(args.total_cost_cents) + BigInt(args.commission_cents ?? 0);
    const tx = ledger.recordSecurityPurchase({ symbol: args.symbol, shares, totalCost, cashAssetId: cashAsset, investmentAccountId: investmentAccount, date: validateDate(args.date), status: args.status ?? "posted" });
    return txWithEntries(ledger, tx.id);
  },
  holdings: (ledger, args) => {
    const acct = args.account_id ? account(ledger, args.account_id) : null;
    const rows = ledger.listAssets().filter((ast) => !args.asset_type || ast.asset_type === args.asset_type).flatMap((ast) => ledger.listAccounts()
      .filter((accountRow) => accountRow.account_type === "asset")
      .filter((accountRow) => !acct || accountRow.id === acct)
      .map((accountRow) => {
        const quantity = ledger.balanceTree(accountRow.id, ast.id, null, null);
        return { account_id: accountRow.id, account_name: accountRow.name, asset_id: ast.id, asset_symbol: ast.symbol, quantity, quantity_display: display(ledger, quantity, ast.id) };
      })
    ).filter((row) => row.quantity !== 0n);
    return rows;
  },
  recognize_gain_loss: (ledger, args) => {
    const gainLoss = args.gain_loss_account_id ? account(ledger, args.gain_loss_account_id) : ledger.getOrCreateAccount("Investment Gain/Loss", "income");
    const assetId = asset(ledger, args.asset_id);
    const amount = amountToQuantity(ledger, assetId, args.amount);
    return amount >= 0n
      ? handlers.create_transaction(ledger, { date: args.date, amount: args.amount, from_account_id: gainLoss, to_account_id: args.investment_account_id, description: args.description, status: args.status ?? "posted", asset_id: assetId })
      : handlers.create_transaction(ledger, { date: args.date, amount: display(ledger, -amount, assetId), from_account_id: args.investment_account_id, to_account_id: gainLoss, description: args.description, status: args.status ?? "posted", asset_id: assetId });
  },

  backup_now: (ledger, args) => {
    const target = args.output_path ? resolveToolWritePath(ledger.path, args.output_path, new Set([".db", ".sqlite", ".sqlite3"])) : null;
    if (args.dry_run === true) {
      const previewTarget = target ?? join(dirname(ledger.path), "backups", `${now().replaceAll(":", "-")}.db`);
      return {
        dry_run: true,
        would_backup: true,
        path: target ? previewTarget : redactToolPath(ledger.path, previewTarget),
        compact: args.compact !== false
      };
    }
    const result = ledger.backupNow(target);
    return { ...result, path: target ? result.path : redactToolPath(ledger.path, result.path), compact: args.compact !== false };
  },
  backup_status: (ledger) => {
    const backups = handlers.list_backups(ledger, {}) as Row[];
    return { count: backups.length, latest: backups[0] ?? null };
  },
  list_backups: (ledger) => {
    const dir = join(dirname(ledger.path), "backups");
    if (!existsSync(dir)) return [];
    const backups = new Map<string, { path: string; sidecars: Row[] }>();
    const sidecars: Array<{ parent: string; row: Row }> = [];
    for (const file of readdirSync(dir)) {
      const path = join(dir, file);
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      const sidecar = file.match(/^(.+\.(?:db|sqlite|sqlite3))-(wal|shm)$/);
      if (sidecar) {
        sidecars.push({
          parent: join(dir, sidecar[1]),
          row: {
            type: sidecar[2],
            path: redactToolPath(ledger.path, path),
            size_bytes: stat.size,
            modified_at: stat.mtime.toISOString()
          }
        });
        continue;
      }
      if (![".db", ".sqlite", ".sqlite3"].includes(extname(file))) continue;
      backups.set(path, { path, sidecars: [] });
    }
    for (const sidecar of sidecars) backups.get(sidecar.parent)?.sidecars.push(sidecar.row);
    return [...backups.values()]
      .sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs)
      .map((backup) => {
        const stat = statSync(backup.path);
        return {
          path: redactToolPath(ledger.path, backup.path),
          size_bytes: stat.size,
          modified_at: stat.mtime.toISOString(),
          sidecars: backup.sidecars.sort((a, b) => String(a.type).localeCompare(String(b.type)))
        };
      });
  },
  init_defaults: (ledger, args) => {
    const assetId = args.asset_id ? explicitAsset(ledger, args.asset_id) : args.currency ? asset(ledger, null, args.currency) : null;
    if (!assetId) throw new Error("currency or asset_id is required for init_defaults");
    return ledger.initDefaults(args.template ?? "personal", assetId);
  },
  integrity_check: (ledger) => ({ ...ledger.integrityCheck(), healthy: ledger.integrityCheck().ok }),
  repair_integrity: (ledger, args) => {
    const before = ledger.integrityCheck();
    const dryRun = args.dry_run !== false;
    const backup = !dryRun && args.backup !== false ? ledger.backupNow().path : null;
    const repairable = [
      ...((before as Row).orphan_annotations ?? []) as Row[],
      ...((before as Row).invalid_default_assets ?? []) as Row[]
    ];
    const ids = [...new Set(repairable.map((row) => String(row.id)).filter(Boolean))];
    if (!dryRun) for (const id of ids) ledger.deleteAnnotation(id);
    const after = dryRun ? before : ledger.integrityCheck();
    return { dry_run: dryRun, backup: backup ? redactToolPath(ledger.path, backup) : args.backup !== false, before, repaired: dryRun ? 0 : ids.length, after, ok: (after as Row).ok };
  },
  list_tags: (ledger, args) => ledger.listAnnotations(args.entity_type, args.entity_id),
  delete_tag: (ledger, args) => { ledger.deleteAnnotation(args.tag_id); return { deleted: args.tag_id }; },
  delete_tags: (ledger, args) => {
    const tags = ledger.listAnnotations(args.entity_type, args.entity_id).filter((tag) => (args.key == null || tag.key === args.key) && (args.val == null || tag.value === args.val || tag.val === args.val));
    const dryRun = args.dry_run !== false;
    if (!dryRun) for (const tag of tags) ledger.deleteAnnotation(tag.id);
    return { matched: tags.length, deleted: dryRun ? 0 : tags.length, dry_run: dryRun };
  },
  tool_registry: (ledger, args) => {
    const selection = registryNames(args);
    const names = selection.names.filter((name) => registrySafetyMatches(name, args));
    const summary = args.summary === true;
    return {
      version: 1,
      count: TOOL_NAMES.length,
      returned_count: names.length,
      unknown_names: selection.unknown_names,
      summary,
      file_access: fileAccessStatus(ledger.path),
      status_filter: {
        accepted_values: STATUS_FILTER_VALUES,
        all: "all non-void transactions",
        "null": "same as all for read/filter status",
        active: "posted + pending",
        combined: "posted + pending + planned",
        creation_status_values: ["posted", "pending", "planned", "void"]
      },
      asset_references: {
        asset_id: "asset id or symbol",
        quote_asset_id: "asset id or symbol; aliases currency, quote, and quote_id are accepted when the tool does not already define those parameters"
      },
      filters: {
        names: args.names ?? null,
        safety_filter: args.safety_filter ?? null,
        unknown_names: selection.unknown_names
      },
      tools: names.map((name) => registryEntry(name, summary))
    };
  },
  inspect_transaction: (ledger, args) => {
    const tx = txWithEntries(ledger, args.tx_id);
    tx.integrity = { balanced: (tx.entries as JournalLine[] | Row[]).reduce((sum: bigint, entry: any) => sum + BigInt(entry.quantity), 0n) === 0n };
    return tx;
  }
};

export const toolHandlers = handlers;

export function callTool(name: string, args: Args = {}, providedLedger?: Ledger): unknown {
  // Tests and CLI pass a ledger explicitly. MCP opens from env and checks
  // capabilities before any disk access.
  if (!TOOL_NAMES.includes(name as ToolName)) throw new Error(`Tool '${name}' is not implemented`);
  const handler = handlers[name as ToolName];
  const normalizedArgs = normalizeToolInput(name, args);
  if (providedLedger) return publicize(withMutationOverseer(providedLedger, name as ToolName, normalizedArgs));
  assertMcpCapability(name, normalizedArgs);
  const ledger = openMcpLedger();
  try {
    return publicize(withMutationOverseer(ledger, name as ToolName, normalizedArgs));
  } finally {
    ledger.close();
  }
}
