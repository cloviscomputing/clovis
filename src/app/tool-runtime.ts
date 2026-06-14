import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import { Ledger } from "../core/ledger.js";
import type { Account, Journal, TxStatus } from "../core/types.js";
import { fromAtomicUnits } from "../core/money.js";
import { normalAmount } from "../core/accounting.js";
import {
  journalLegQuantity,
  nonNegativeMoneyAmount,
  positiveAtomicQuantity,
  positiveMoneyAmount,
  positiveShareQuantity,
  signedMoneyAmount,
  statementQuantity
} from "./amount-policy.js";
import { backupPreview, backupResultPublic, backupStatus, listBackupFiles, resolveBackupWritePath } from "./backup-filesystem.js";
import { safeJson, stringifyPublic } from "./json.js";
import { assertToolDataSize, fileAccessStatus, readToolTextFile, redactToolPath, resolveToolWritePath, writeToolTextFile } from "./filesystem.js";
import {
  createOperation,
  mutationPreview,
  operationPublic,
  stableHash
} from "./mutation-overseer.js";
import { reverseLedgerOperation as reverseLedgerOperationWithDeps } from "./operation-reversal.js";
import { operatingManual } from "./operating-manual.js";
import { createScenarioBranch, discardScenarioBranch, listScenarioBranches, resolveOpenScenarioBranch } from "./scenario-policy.js";
import { effectiveToolDefinition, normalizeToolInput, parameterAliasesForTool, STATUS_FILTER_VALUES, TOOL_SIGNATURES, type ToolSignatureName } from "./signatures.js";
import { publicPlanRows, statementPlanOutput } from "./statement-workflow.js";
import type { ToolHandler, ToolSpec } from "./tool-spec.js";
import { accountHandlers } from "./tools/accounts.js";
import { budgetHandlers } from "./tools/budgets.js";
import { maintenanceHandlers } from "./tools/maintenance.js";
import { reportHandlers } from "./tools/reports.js";
import { statementHandlers } from "./tools/statements.js";
import { transactionHandlers } from "./tools/transactions.js";
import {
  isBulkCategorizationCandidate,
  isImportDedupeCandidate,
  isProjectionPlannedTx,
  isRealizedPlannedLandedTx,
  isStatementMatchCandidate,
  txMatchesStatusFilter
} from "./transaction-lifecycle.js";
import { parseTxStatus, parseTxStatusFilter, resolveAccount, resolveAsset, validateDate } from "./validation.js";

// Shared command catalog for CLI and MCP. This layer translates user/tool
// arguments into Ledger calls and public JSON shapes; core owns durable state.
export type Args = Record<string, any>;
export type Handler = ToolHandler;
export type Row = Record<string, any>;

const MAX_IMPORT_ROWS = 10000;
const MAX_CSV_COLUMNS = 200;

export type ToolName = ToolSignatureName;

let installedToolSpecs: Record<string, ToolSpec> = {};

export function installToolSpecMap(specs: Record<string, ToolSpec>): void {
  installedToolSpecs = specs;
}

function toolNames(): ToolName[] {
  return Object.keys(installedToolSpecs) as ToolName[];
}

function toolSpec(name: ToolName): ToolSpec {
  const spec = installedToolSpecs[name];
  if (!spec) throw new Error(`Tool '${name}' is not implemented`);
  return spec;
}

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

function reportStatus(args: Args, fallback: TxStatus | "active" | "combined" | null): TxStatus | "active" | "combined" | null {
  if (args.status !== undefined && args.status !== "") return parseTxStatusFilter(args.status, fallback);
  if (args.include_pending === true) return "active";
  if (args.include_pending === false) return "posted";
  return fallback;
}

function iterTransactions(ledger: Ledger, args: { status?: string | null; includePending?: boolean; date_from?: string | null; date_to?: string | null } = {}): Journal[] {
  const status = parseTxStatusFilter(args.status, args.includePending ? "active" : null);
  const rows = ledger.listTransactions({ status: null, dateFrom: optionalDate(args.date_from), dateTo: optionalDate(args.date_to), sort: "date_asc" });
  return rows.filter((tx) => txMatchesStatusFilter(tx, status));
}

function amountForAccount(ledger: Ledger, txId: string, accountId: string, assetId?: string | null): bigint {
  return ledger.getEntries(txId).filter((entry) => entry.account_id === accountId && (!assetId || entry.asset_id === assetId)).reduce((sum, entry) => sum + entry.quantity, 0n);
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
  const { path: file, text } = readToolTextFile(ledger.path, filePath, new Set([".csv", ".qfx", ".ofx"]));
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
  return statementQuantity(ledger, assetId, row, amountConvention);
}

function importFingerprint(row: Row, signed: bigint): string {
  return `${row.date}|${signed}|${String(row.description ?? "").toLowerCase()}`;
}

function existingImportFingerprints(ledger: Ledger, accountId: string, assetId: string): Set<string> {
  return new Set(ledger.listTransactions({ status: null }).filter(isImportDedupeCandidate).map((tx) => {
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
    .filter(isStatementMatchCandidate)
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
  const planned = ledger.listTransactions({ status: null, dateFrom, dateTo, sort: "date_asc" })
    .filter(isProjectionPlannedTx)
    .filter((tx) => !explicitAccountIds || txTouchesAccountTree(ledger, tx.id, explicitAccountIds));
  const landed = ledger.listTransactions({ status: null, sort: "date_asc" })
    .filter(isRealizedPlannedLandedTx)
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
  for (const tx of ledger.listTransactions({ status: null, dateFrom, dateTo: asOf, sort: "date_asc" }).filter(isProjectionPlannedTx)) {
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

function userFacingLiabilityBalance(args: Args): boolean {
  const statementType = String(args.statement_type ?? "").toLowerCase().replace(/[\s_-]+/g, "");
  const balanceSign = String(args.balance_sign ?? args.balance_basis ?? "").toLowerCase().replace(/[\s_-]+/g, "");
  return ["creditcard", "cardstatement", "liabilitystatement"].includes(statementType) || ["statement", "userfacing", "positive"].includes(balanceSign);
}

function expectedStatementBalance(ledger: Ledger, accountId: string, assetId: string, args: Args): bigint | null {
  if (args.expected_balance == null) return null;
  let expected = signedMoneyAmount(ledger, assetId, args.expected_balance, "Expected balance");
  const accountRow = ledger.getAccount(accountId);
  if (accountRow?.account_type === "liability" && expected > 0n && userFacingLiabilityBalance(args)) expected = -expected;
  return expected;
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
  if (args.names == null) return { names: toolNames(), unknown_names: [] };
  const requested = Array.isArray(args.names)
    ? args.names.map((name) => String(name))
    : String(args.names).split(",").map((name) => name.trim()).filter(Boolean);
  const known = new Set<string>(toolNames());
  const unknown = requested.filter((name) => !known.has(name));
  return { names: requested.filter((name) => known.has(name)) as ToolName[], unknown_names: unknown };
}

function registrySafetyMatches(name: ToolName, args: Args): boolean {
  const safety = toolSpec(name).safety;
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
  const spec = toolSpec(name);
  const safety = spec.safety;
  const definition = effectiveToolDefinition(name);
  if (summary) {
    return {
      name,
      workflow: spec.workflow,
      mutation: spec.mutation,
      signature: TOOL_SIGNATURES[name],
      parameters: definition.parameters.map((parameter) => parameter[0]),
      aliases: parameterAliasesForTool(name),
      safety
    };
  }
  return {
    name,
    workflow: spec.workflow,
    mutation: spec.mutation,
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

const runtimeContext = {
  MAX_MATCH_INPUT_LENGTH,
  STATUS_FILTER_VALUES,
  account,
  accountAsset,
  accountDefaultAsset,
  accountPublic,
  addDays,
  ageOfMoney,
  amountForAccount,
  amountWithinTolerance,
  applyRecategorizeTransaction,
  applyStatementPlan,
  assertToolDataSize,
  asset,
  backupPreview,
  backupResultPublic,
  backupStatus,
  batch,
  budgetBurn,
  budgetRows,
  budgetSummary,
  buildStatementPlan,
  cashProjectionSummary,
  conversionSeverity,
  counterpartForRow,
  createHash,
  createScenarioBranch,
  dateDeltaDays,
  directedTxPublic,
  discardScenarioBranch,
  display,
  effectiveBudgetRows,
  entriesPublic,
  explicitAsset,
  fileAccessStatus,
  id,
  incomeStatementRows,
  importPreview,
  importTransactionRows,
  isBulkCategorizationCandidate,
  iterTransactions,
  journalLegQuantity,
  listBackupFiles,
  listScenarioBranches,
  monthBounds,
  mutationPreview,
  nonNegativeMoneyAmount,
  nonOverlappingAccounts,
  now,
  normalizeToolInput,
  operatingManual,
  operationPublic,
  optionalDate,
  parseStatementRows,
  parseTxStatus,
  parseTxStatusFilter,
  postedAtBound,
  positive,
  positiveAtomicQuantity,
  positiveMoneyAmount,
  positiveShareQuantity,
  previousDate,
  quotedPlannedUnrealized,
  readToolTextFile,
  realizedPlannedRows,
  recategorizePreview,
  recurringDateRange,
  redactToolPath,
  registryEntry,
  registryNames,
  registrySafetyMatches,
  reportAsset,
  reportStatus,
  resolveBackupWritePath,
  resolveOpenScenarioBranch,
  resolveToolWritePath,
  reverseLedgerOperationWithDeps,
  rootAccountIds,
  runwayMonths,
  safeJson,
  safeMatchRegex,
  scaleBigint,
  scopedExportDocument,
  scopedMissingConversions,
  selectBatchTransactions,
  setAccountDefaultAsset,
  signedMoneyAmount,
  signedStatementQuantity,
  spendableAssetAccountDefaults,
  spendingRows,
  splitProjectionAccounts,
  stringifyPublic,
  tagTx,
  today,
  toolNames,
  toolSpec,
  transactionAsset,
  transactionMagnitude,
  trailingSpend,
  trailingSummary,
  trailingWindowEnd,
  txIdsForBatch,
  txMatchesStatusFilter,
  txPublic,
  txWithEntries,
  unsupportedArguments,
  validateDate,
  verifyStatementPlan,
  writeToolTextFile
};

export type ToolRuntimeContext = typeof runtimeContext;
export type ToolHandlers = Record<ToolName, Handler>;

export const handlers: ToolHandlers = {} as ToolHandlers;

function registerHandlerGroup(groupName: string, group: Partial<ToolHandlers>): void {
  for (const [name, handler] of Object.entries(group)) {
    if (handlers[name as ToolName]) throw new Error(`Duplicate handler '${name}' in ${groupName}`);
    handlers[name as ToolName] = handler as Handler;
  }
}

registerHandlerGroup("accounts", accountHandlers(runtimeContext, handlers));
registerHandlerGroup("transactions", transactionHandlers(runtimeContext, handlers));
registerHandlerGroup("statements", statementHandlers(runtimeContext, handlers));
registerHandlerGroup("reports", reportHandlers(runtimeContext, handlers));
registerHandlerGroup("budgets", budgetHandlers(runtimeContext, handlers));
registerHandlerGroup("maintenance", maintenanceHandlers(runtimeContext, handlers));
