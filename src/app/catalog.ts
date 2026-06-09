import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Ledger } from "../core/ledger.js";
import type { Account, AccountType, Asset, Journal, JournalLine, TxStatus } from "../core/types.js";
import { fromAtomicUnits, toAtomicUnits } from "../core/money.js";
import { normalAmount } from "../core/accounting.js";
import { openMcpLedger } from "./context.js";
import { publicize, stringifyPublic } from "./json.js";
import { redactPath, resolveMcpReadPath, resolveMcpWritePath } from "./filesystem.js";
import { amountToQuantity, parseSmartDate, parseTxStatus, resolveAccount, resolveAsset, validateDate } from "./validation.js";

type Args = Record<string, any>;
type Handler = (ledger: Ledger, args: Args) => unknown;
type Row = Record<string, any>;

export const TOOL_NAMES = [
  "account_register", "add_match_rule", "add_match_rules", "age_of_money", "apply_match_rules", "apply_pattern",
  "apply_reconciliation_plan", "apply_rollover", "assert_balance", "assert_balances", "audit_categorization", "backup_now",
  "backup_status", "balance_sheet", "budget_rollover_preview", "budget_status", "budget_summary", "buy_security",
  "cash_flow", "cash_projection", "close_period", "commit_batch", "compare_scenarios", "consolidate_transfers",
  "copy_budgets", "count_transactions", "create_account", "create_accounts", "create_asset", "create_branch",
  "create_price", "create_scheduled_transaction", "create_transaction", "delete_account", "delete_asset", "delete_budget",
  "delete_budgets", "delete_goal", "delete_match_rule", "delete_match_rules", "delete_tag", "delete_tags",
  "delete_transaction", "detect_recurring", "discard_batch", "discard_branch", "export_ledger", "export_transactions",
  "financial_overview", "financial_picture", "find_pending_duplicates", "flip_entries", "forecast", "forecast_month_end",
  "fx_transfer", "get_account", "get_account_by_name", "get_asset_by_symbol", "get_balance", "get_price",
  "get_transaction", "goal_progress", "holdings", "import_file", "import_ledger", "import_transactions",
  "income_statement", "init_defaults", "inspect_transaction", "integrity_check", "invert_import", "list_accounts",
  "list_assets", "list_backups", "list_branches", "list_checkpoints", "list_entries", "list_entries_by_asset",
  "list_goals", "list_import_batches", "list_match_rules", "list_prices", "list_scheduled", "list_tags",
  "list_transactions", "list_uncategorized", "list_unmatched_transfers", "match_transfer_pairs", "match_transfers",
  "merge_accounts", "merge_branch", "migrate_asset_entries", "move_transactions", "net_worth", "pending_summary",
  "plan_transaction", "post_journal_entry", "preview_commit", "preview_import", "process_scheduled", "process_statement",
  "project_balances", "project_month_end", "recategorize_by_pattern", "recategorize_by_patterns", "recategorize_transaction",
  "recognize_gain_loss", "reconcile_diff", "reconcile_statement", "reconcile_statement_plan", "reconcile_to_balance",
  "record_investment", "record_opening_balance", "record_opening_balances", "record_pending_expenses", "reopen_period",
  "repair_integrity", "rollback_import", "rollback_recategorize", "search_transactions", "set_budget", "set_budgets",
  "set_goal", "spending", "spending_rate", "suggest_budgets", "top_descriptions", "transfer", "trial_balance",
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

function account(ledger: Ledger, ref?: string | null): string {
  return resolveAccount(ledger, ref);
}

function asset(ledger: Ledger, ref?: string | null, symbol = "USD"): string {
  return resolveAsset(ledger, ref, symbol);
}

function assetScale(ledger: Ledger, assetId?: string | null): number {
  return ledger.getAsset(assetId || "")?.scale ?? 2;
}

function display(ledger: Ledger, quantity: bigint, assetId?: string | null): number {
  return Number(fromAtomicUnits(quantity, assetScale(ledger, assetId)));
}

function accountPublic(row: Account): Row {
  return { ...row, type: row.account_type };
}

function entriesPublic(ledger: Ledger, txId: string): Row[] {
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
  const entries = entriesPublic(ledger, tx.id);
  const main = entries.toSorted((a, b) => Number(BigInt(b.quantity) ** 2n - BigInt(a.quantity) ** 2n))[0];
  const amount = main ? (BigInt(main.quantity) < 0n ? -BigInt(main.quantity) : BigInt(main.quantity)) : 0n;
  const out: Row = {
    ...tx,
    entries,
    amount,
    amount_cents: amount,
    amount_display: main ? display(ledger, amount, String(main.asset_id)) : 0,
    tags: ledger.listAnnotations("tx", tx.id)
  };
  if (compact) for (const entry of out.entries as Row[]) delete entry.id;
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

function statuses(status?: string | null, includePending = false): Set<string> | null {
  if (status == null || status === "") return includePending ? new Set(["posted", "pending"]) : new Set(["posted"]);
  if (status === "active") return new Set(["posted", "pending"]);
  if (status === "combined") return new Set(["posted", "pending", "planned"]);
  return new Set([status]);
}

function iterTransactions(ledger: Ledger, args: { status?: string | null; includePending?: boolean; date_from?: string | null; date_to?: string | null } = {}): Journal[] {
  const allowed = statuses(args.status, args.includePending);
  const rows = ledger.listTransactions({ status: null, dateFrom: args.date_from, dateTo: args.date_to, sort: "date_asc" });
  if (!allowed) return rows.filter((tx) => tx.status !== "void");
  return rows.filter((tx) => allowed.has(tx.status));
}

function amountForAccount(ledger: Ledger, txId: string, accountId: string, assetId?: string | null): bigint {
  return ledger.getEntries(txId).filter((entry) => entry.account_id === accountId && (!assetId || entry.asset_id === assetId)).reduce((sum, entry) => sum + entry.quantity, 0n);
}

function budgetRows(ledger: Ledger, accountId?: string | null, year?: number | null, month?: number | null): Row[] {
  return ledger.listBudgetTargets({ accountId, year, month });
}

function spendingRows(ledger: Ledger, year?: number | null, month?: number | null, status = "posted", quoteAssetId?: string | null, returnMissing = false): Row[] | { rows: Row[]; missing: Row[] } {
  const quote = asset(ledger, quoteAssetId);
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

function incomeStatementRows(ledger: Ledger, year: number, month: number | null, status = "posted", quoteAssetId?: string | null): Row {
  const quote = asset(ledger, quoteAssetId);
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

function parseCsv(text: string): Row[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) return [];
  const split = (line: string) => {
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
    cells.push(cell);
    return cells;
  };
  const headers = split(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((line, index) => Object.fromEntries(split(line).map((value, i) => [headers[i] || `col_${i}`, value.trim()])).valueOf() as Row & { index: number }).map((row, index) => ({ ...row, index }));
}

function parseStatementRows(filePath: string, args: Args = {}): Row[] {
  const file = resolveMcpReadPath(filePath, new Set([".csv"]));
  const rows = parseCsv(readFileSync(file, "utf8")).slice(Number(args.skip_rows ?? 0));
  const dateCol = args.date_col || "date";
  const amountCol = args.amount_col || "amount";
  const descCol = args.desc_col || "description";
  const inflowCol = args.inflow_col;
  const outflowCol = args.outflow_col;
  const counterpartCol = args.counterpart_col;
  const tagCols = args.tag_cols ?? {};
  return rows.map((row, index) => {
    let amount = amountCol in row ? Number(row[amountCol]) : 0;
    if (inflowCol && row[inflowCol] !== "") amount = Number(row[inflowCol]);
    if (outflowCol && row[outflowCol] !== "") amount = -Math.abs(Number(row[outflowCol]));
    if (args.amount_convention === "unsigned_charges") amount = -Math.abs(amount);
    return {
      index,
      date: validateDate(String(row[dateCol])),
      amount,
      description: String(row[descCol] ?? ""),
      counterpart_ref: counterpartCol ? String(row[counterpartCol] ?? "") : "",
      tags: Object.fromEntries(Object.entries(tagCols).map(([key, col]) => [key, String(row[String(col)] ?? "")]).filter(([, value]) => value !== ""))
    };
  });
}

function importTransactionRows(ledger: Ledger, accountId: string, counterpartId: string, rows: Row[], options: Args = {}) {
  const status = parseTxStatus(options.status ?? "posted") ?? "posted";
  const assetId = asset(ledger, options.asset_id, options.currency || "USD");
  const created: Row[] = [];
  const errors: Row[] = [];
  const existing = new Set(ledger.listTransactions({ status: null }).map((tx) => {
    const amount = amountForAccount(ledger, tx.id, accountId, assetId);
    return `${tx.date}|${amount}|${tx.description.toLowerCase()}`;
  }));
  rows.forEach((row, index) => {
    try {
      const rowCounterpart = row.counterpart_ref ? account(ledger, String(row.counterpart_ref)) : row.counterpart_id ? account(ledger, String(row.counterpart_id)) : counterpartId;
      const quantity = amountToQuantity(ledger, assetId, row.amount_cents ?? row.quantity ?? row.amount ?? 0);
      const signed = options.amount_convention === "unsigned_charges" ? -((quantity < 0n) ? -quantity : quantity) : quantity;
      const fingerprint = `${row.date}|${signed}|${String(row.description ?? "").toLowerCase()}`;
      if (!options.skip_dedup && existing.has(fingerprint)) return;
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
  return { created: created.length, transactions: created, errors, dry_run: false };
}

function batch(ledger: Ledger, label?: string | null, metadata: Row = {}): string {
  return ledger.createSource("import", label, metadata);
}

function txIdsForBatch(ledger: Ledger, batchId: string): string[] {
  return ledger.listTransactionIdsForSource(batchId);
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
    for (const tx of ledger.listTransactions({ status: "pending", dateFrom: args.date_from, dateTo: args.date_to })) {
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

const MCP_FILESYSTEM_TOOLS = new Set([
  "apply_reconciliation_plan",
  "backup_now",
  "import_file",
  "preview_import",
  "process_statement"
]);

const MCP_DESTRUCTIVE_TOOLS = new Set([
  "close_period",
  "commit_batch",
  "delete_account",
  "delete_asset",
  "delete_budget",
  "delete_budgets",
  "delete_goal",
  "delete_match_rule",
  "delete_match_rules",
  "delete_tag",
  "delete_transaction",
  "discard_branch",
  "merge_accounts",
  "reopen_period",
  "rollback_import",
  "rollback_recategorize"
]);

function mcpCapabilities(): Set<string> {
  return new Set(String(process.env.CLOVIS_MCP_CAPABILITIES ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean));
}

function hasMcpCapability(caps: Set<string>, capability: string): boolean {
  return caps.has("all") || caps.has(capability);
}

function mcpRequiresFilesystem(name: string, args: Args): boolean {
  return MCP_FILESYSTEM_TOOLS.has(name) ||
    (name === "export_ledger" && args.output_path != null) ||
    (name === "export_transactions" && args.output_path != null) ||
    (name === "import_ledger" && args.file_path != null);
}

function mcpRequiresDestructive(name: string, args: Args): boolean {
  return MCP_DESTRUCTIVE_TOOLS.has(name) ||
    (name === "apply_match_rules" && args.dry_run === false) ||
    (name === "apply_pattern" && args.dry_run === false) ||
    (name === "apply_reconciliation_plan" && args.dry_run === false) ||
    (name === "delete_tags" && args.dry_run === false) ||
    (name === "discard_batch" && args.dry_run === false) ||
    (name === "migrate_asset_entries" && args.dry_run === false) ||
    (name === "move_transactions" && args.dry_run === false) ||
    (name === "process_statement" && args.commit === true) ||
    (name === "recategorize_by_pattern" && args.dry_run === false) ||
    (name === "void_by_filter" && args.dry_run === false);
}

function assertMcpCapability(name: string, args: Args): void {
  const caps = mcpCapabilities();
  const missing: string[] = [];
  if (mcpRequiresFilesystem(name, args) && !hasMcpCapability(caps, "filesystem")) missing.push("filesystem");
  if (mcpRequiresDestructive(name, args) && !hasMcpCapability(caps, "destructive")) missing.push("destructive");
  if (missing.length) {
    throw new Error(`MCP tool '${name}' requires CLOVIS_MCP_CAPABILITIES=${missing.join(",")}`);
  }
}

const handlers: Record<ToolName, Handler> = {
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
    if (existing) return accountPublic(existing);
    const parent = args.parent_id ? account(ledger, args.parent_id) : null;
    return accountPublic(ledger.getAccount(ledger.createAccount(args.name, args.type, parent, args.code ?? "", args.color_hex ?? "#888888"))!);
  },
  create_accounts: (ledger, args) => {
    const created: Row[] = [];
    const errors: Row[] = [];
    (args.accounts ?? []).forEach((row: Row, index: number) => {
      try {
        created.push(handlers.create_account(ledger, { name: row.name, type: row.type ?? row.account_type, parent_id: row.parent_id, code: row.code, color_hex: row.color_hex }) as Row);
      } catch (error) {
        errors.push({ index, error: error instanceof Error ? error.message : String(error) });
      }
    });
    return { created: created.length, accounts: created, errors };
  },
  list_accounts: (ledger, args) => {
    let rows = ledger.listAccounts().map(accountPublic);
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
    return accountPublic(row);
  },
  get_account_by_name: (ledger, args) => {
    const row = ledger.findAccount(args.name);
    return row ? accountPublic(row) : null;
  },
  update_account: (ledger, args) => accountPublic(ledger.updateAccount(account(ledger, args.id), { name: args.name, type: args.type, parent_id: args.parent_id ? account(ledger, args.parent_id) : args.parent_id, code: args.code, color_hex: args.color_hex })),
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
    const assetId = asset(ledger, args.asset_id);
    const quantity = amountToQuantity(ledger, assetId, args.amount);
    const fromAccountId = account(ledger, args.from_account_id);
    const toAccountId = account(ledger, args.to_account_id);
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
    const defaultAsset = asset(ledger, args.asset_id);
    const lines = (args.legs ?? []).map((leg: Row) => [account(ledger, leg.account_id ?? leg.account), leg.asset_id ? asset(ledger, leg.asset_id) : defaultAsset, amountToQuantity(ledger, leg.asset_id ? asset(ledger, leg.asset_id) : defaultAsset, leg.amount ?? leg.quantity ?? leg.amount_cents ?? 0)] as [string, string, bigint]);
    const txId = ledger.postTx(validateDate(args.date), args.status ?? "pending", args.description ?? "", lines);
    return txWithEntries(ledger, txId);
  },
  record_opening_balance: (ledger, args) => {
    const assetId = asset(ledger, args.asset_id);
    return txPublic(ledger, ledger.recordOpeningBalance(account(ledger, args.account_id), amountToQuantity(ledger, assetId, args.amount), assetId, validateDate(args.date), args.status ?? "pending", args.counterpart_account_id ? account(ledger, args.counterpart_account_id) : null));
  },
  record_opening_balances: (ledger, args) => {
    const rows = (args.balances ?? []).map((row: Row) => handlers.record_opening_balance(ledger, { ...row, date: args.date, status: args.status ?? "pending" }));
    return { created: rows.length, transactions: rows };
  },
  list_transactions: (ledger, args) => {
    const dateRange = args.year ? monthBounds(Number(args.year), args.month ? Number(args.month) : null) : [args.date_from, args.date_to];
    const options = {
      desc: args.desc,
      accountId: args.account_id ? account(ledger, args.account_id) : args.category_id ? account(ledger, args.category_id) : null,
      assetId: args.asset_id ? asset(ledger, args.asset_id) : null,
      amountMin: args.amount_min == null ? null : BigInt(args.amount_min as string | number | bigint | boolean),
      amountMax: args.amount_max == null ? null : BigInt(args.amount_max as string | number | bigint | boolean),
      status: args.status ? parseTxStatus(args.status) : null,
      dateFrom: dateRange[0],
      dateTo: dateRange[1],
      sort: args.sort ?? "date_desc"
    };
    const total = ledger.searchTransactions({ ...options, limit: null, offset: 0 }).length;
    const rows = ledger.searchTransactions({ ...options, limit: args.limit ?? 50, offset: args.offset ?? 0 }).map((tx) => txPublic(ledger, tx, args.compact !== false));
    return { transactions: rows, items: rows, total, limit: args.limit ?? 50, offset: args.offset ?? 0 };
  },
  search_transactions: (ledger, args) => handlers.list_transactions(ledger, { ...args, desc: args.desc ?? args.query, account_id: args.account_id, status: args.status, date_from: args.date_from ?? args.posted_at_from, date_to: args.date_to ?? args.posted_at_to, compact: false }),
  get_transaction: (ledger, args) => txWithEntries(ledger, args.id),
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
      const balance = ledger.balanceTree(accountId, ast.id, args.date, args.status ? parseTxStatus(args.status) : "posted");
      return { account_id: accountId, asset_id: ast.id, asset_symbol: ast.symbol, quantity: balance, balance, balance_cents: balance, scale: ast.scale, balance_display: display(ledger, balance, ast.id) };
    }).filter((row) => row.balance !== 0n);
    if (balances.length === 0) {
      const usd = ledger.getAssetBySymbol("USD") ?? ledger.getAsset(asset(ledger));
      if (usd) balances.push({ account_id: accountId, asset_id: usd.id, asset_symbol: usd.symbol, quantity: 0n, balance: 0n, balance_cents: 0n, scale: usd.scale, balance_display: 0 });
    }
    const primary = balances.find((row) => row.asset_symbol === "USD") ?? balances[0];
    return {
      account_id: accountId,
      account_name: acct.name,
      balances,
      balance: primary?.balance ?? 0n,
      balance_cents: primary?.balance_cents ?? 0n,
      total_cents: balances.reduce((sum, row) => sum + row.balance, 0n)
    };
  },
  recategorize_transaction: (ledger, args) => {
    const entries = ledger.getEntries(args.tx_id);
    const oldAccount = args.old_account_id
      ? account(ledger, args.old_account_id)
      : entries.find((entry) => ledger.getAccount(entry.account_id)?.account_type === "expense")?.account_id
        ?? entries.toSorted((a, b) => Number((b.quantity < 0n ? -b.quantity : b.quantity) - (a.quantity < 0n ? -a.quantity : a.quantity)))[0]?.account_id;
    if (!oldAccount) throw new Error("Transaction has no entries");
    return ledger.recategorizeTransaction(args.tx_id, oldAccount, account(ledger, args.new_account_id));
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
    const status = args.status ?? (args.include_pending ? "active" : "posted");
    const report = incomeStatementRows(ledger, Number(args.year), month, status, args.quote_asset_id);
    if (month == null) report.months = Array.from({ length: 12 }, (_, index) => incomeStatementRows(ledger, Number(args.year), index + 1, status, args.quote_asset_id));
    return args.compact ? { year: Number(args.year), month, income: report.income, expense: report.expense, net: report.net } : report;
  },
  balance_sheet: (ledger, args) => {
    unsupportedArguments({ branch: args.branch, include_pending: args.include_pending, account_ids: args.account_ids, entity_id: args.entity_id });
    const report = ledger.balanceSheet(args.date ?? null, asset(ledger, args.quote_asset_id));
    if (args.hide_zero) {
      report.assets = (report.assets as Row[]).filter((row) => row.balance !== 0n);
      report.liabilities = (report.liabilities as Row[]).filter((row) => row.balance !== 0n);
      report.equity = (report.equity as Row[]).filter((row) => row.balance !== 0n);
    }
    return args.compact ? { total_assets: report.total_assets, total_liabilities: report.total_liabilities, total_equity: report.total_equity, total_assets_cents: report.total_assets, total_liabilities_cents: report.total_liabilities, total_equity_cents: report.total_equity } : report;
  },
  net_worth: (ledger, args) => {
    unsupportedArguments({ branch: args.branch, include_pending: args.include_pending });
    return ledger.netWorthReport(args.date ?? "9999-12-31", asset(ledger, args.quote_asset_id));
  },
  spending: (ledger, args) => {
    unsupportedArguments({ branch: args.branch, account_ids: args.account_ids, entity_id: args.entity_id });
    const result = spendingRows(ledger, Number(args.year), Number(args.month), args.status ?? (args.include_pending ? "active" : "posted"), args.quote_asset_id, true) as { rows: Row[]; missing: Row[] };
    return { year: args.year, month: args.month, categories: result.rows, spending: result.rows, total: result.rows.reduce((sum, row) => sum + BigInt(row.amount_cents), 0n), warnings: result.missing, valuation_complete: result.missing.length === 0, missing_conversions: result.missing };
  },
  cash_flow: (ledger, args) => {
    unsupportedArguments({ branch: args.branch, include_pending: args.include_pending });
    const report = ledger.cashFlow(Number(args.year), Number(args.month), asset(ledger, args.quote_asset_id));
    return args.compact ? { year: report.year, month: report.month, operating_total: report.operating_total, investing_total: report.investing_total, financing_total: report.financing_total, net_change: report.net_change } : report;
  },
  account_register: (ledger, args) => {
    unsupportedArguments({ branch: args.branch });
    const accountId = account(ledger, args.account_id);
    const rows = ledger.accountRegister(accountId, asset(ledger, args.asset_id), args.date_from ?? args.time_from, args.date_to ?? args.time_to, args.status ? parseTxStatus(args.status) : null);
    const page = rows.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 100));
    if (args.summary) return { account_id: accountId, transaction_count: rows.length, total_debits: page.reduce((sum, row) => sum + BigInt(row.debit as string | number | bigint | boolean), 0n), total_credits: page.reduce((sum, row) => sum + BigInt(row.credit as string | number | bigint | boolean), 0n), rows: page };
    return { account_id: accountId, entries: page, rows, total: rows.length, limit: args.limit ?? 100, offset: args.offset ?? 0 };
  },
  trial_balance: (ledger, args) => {
    unsupportedArguments({ branch: args.branch });
    return ledger.trialBalance(asset(ledger), args.status ? parseTxStatus(args.status) : null);
  },
  financial_overview: (ledger, args) => ({ current_snapshot: handlers.balance_sheet(ledger, { quote_asset_id: args.quote_asset_id }), monthly_activity: handlers.income_statement(ledger, { year: args.year ?? new Date().getUTCFullYear(), month: args.month ?? new Date().getUTCMonth() + 1, quote_asset_id: args.quote_asset_id, status: args.status ?? "active" }), budget_position: handlers.budget_summary(ledger, args) }),
  financial_picture: (ledger, args) => handlers.financial_overview(ledger, args),
  cash_projection: (ledger, args) => {
    const quote = asset(ledger, args.quote_asset_id);
    const accounts = args.asset_account_ids ?? ledger.listAccounts().filter((row) => row.account_type === "asset").map((row) => row.id);
    let gross = 0n;
    const missing: Row[] = [];
    for (const ref of accounts) {
      const result = ledger.quotedBalanceTree(account(ledger, ref), quote, null, null);
      gross += result.total;
      missing.push(...result.missing);
    }
    const earmarks = (args.earmarks ?? []).reduce((sum: bigint, row: Row) => sum + amountToQuantity(ledger, quote, row.amount ?? 0), 0n);
    return { year: args.year, month: args.month, gross_cash_cents: gross, earmarks_cents: earmarks, available_cash_cents: gross - earmarks, accounts, quote_asset_id: quote, valuation_complete: missing.length === 0, missing_conversions: missing };
  },

  set_budget: (ledger, args) => {
    const acct = ledger.getAccount(account(ledger, args.account))!;
    if (acct.account_type !== "expense") throw new Error("Budgets can only be set on expense accounts");
    const assetId = asset(ledger);
    const quantity = amountToQuantity(ledger, assetId, args.amount);
    if (quantity < 0n) throw new Error("Budget amount cannot be negative");
    ledger.setBudget(acct.id, assetId, quantity, args.period ?? "monthly", args.year ?? null, args.month ?? null, Boolean(args.rollover));
    return { account_id: acct.id, asset_id: assetId, quantity, amount_cents: quantity, period: args.period ?? "monthly", year: args.year ?? null, month: args.month ?? null, rollover: Boolean(args.rollover) };
  },
  set_budgets: (ledger, args) => {
    const rows = (args.budgets ?? []).map((row: Row) => handlers.set_budget(ledger, { account: row.account ?? row.account_id, amount: row.amount, period: row.period ?? "monthly", year: row.year ?? args.year, month: row.month ?? args.month, rollover: row.rollover ?? false }));
    return { set: rows.length, budgets: rows };
  },
  budget_status: (ledger, args) => {
    const year = args.year ?? new Date().getUTCFullYear();
    const month = args.month ?? new Date().getUTCMonth() + 1;
    const acct = args.account ? account(ledger, args.account) : null;
    const quote = asset(ledger, args.quote_asset_id);
    const spending = new Map((spendingRows(ledger, year, month, args.status ?? "posted", quote) as Row[]).map((row) => [row.account_id, row]));
    const missing: Row[] = [];
    const rows = budgetRows(ledger, acct, year, month).flatMap((budget) => {
      const [budgeted, error] = ledger.tryConvertQuantity(BigInt(budget.quantity), String(budget.asset_id), quote);
      if (budgeted == null) {
        missing.push({ account_id: budget.account_id, asset_id: budget.asset_id, quote_asset_id: quote, quantity: budget.quantity, error });
        return [];
      }
      const spent = BigInt(spending.get(budget.account_id)?.amount_cents ?? 0);
      return [{ account_id: budget.account_id, asset_id: quote, budgeted_cents: budgeted, spent_cents: spent, remaining_cents: budgeted - spent, percent_used: budgeted ? Number(spent) / Number(budgeted) * 100 : 0 }];
    });
    return { year, month, budgets: rows, total_budgeted_cents: rows.reduce((s, r) => s + r.budgeted_cents, 0n), total_spent_cents: rows.reduce((s, r) => s + r.spent_cents, 0n), valuation_complete: missing.length === 0, missing_conversions: missing };
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
    const rollovers = (status.budgets as Row[]).filter((row) => BigInt(row.remaining_cents) > 0n).map((row) => ({ ...row, rollover_cents: row.remaining_cents }));
    return { year: args.year, month: args.month, rollovers, total_rollover_cents: rollovers.reduce((sum, row) => sum + BigInt(row.rollover_cents), 0n) };
  },
  apply_rollover: (ledger, args) => {
    const preview = handlers.budget_rollover_preview(ledger, args) as Row;
    const nextYear = args.month === 12 ? args.year + 1 : args.year;
    const nextMonth = args.month === 12 ? 1 : args.month + 1;
    for (const row of preview.rollovers as Row[]) handlers.set_budget(ledger, { account: row.account_id, amount: display(ledger, BigInt(row.rollover_cents), asset(ledger)), year: nextYear, month: nextMonth });
    return { applied: (preview.rollovers as Row[]).length, to_year: nextYear, to_month: nextMonth };
  },
  unbudgeted_spending: (ledger, args) => {
    const budgeted = new Set(budgetRows(ledger, null, args.year, args.month).map((row) => row.account_id));
    return (spendingRows(ledger, args.year, args.month, args.status ?? "posted", args.quote_asset_id) as Row[]).filter((row) => !budgeted.has(row.account_id));
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
      for (const row of spendingRows(ledger, year, month) as Row[]) totals.set(row.account_id, [...(totals.get(row.account_id) ?? []), BigInt(row.amount_cents)]);
      month -= 1; if (month === 0) { month = 12; year -= 1; }
    }
    const budgeted = new Set(budgetRows(ledger).map((row) => row.account_id));
    const accounts = new Map(ledger.listAccounts().map((row) => [row.id, row]));
    return [...totals.entries()].filter(([accountId]) => !args.skip_budgeted || !budgeted.has(accountId)).map(([accountId, values]) => ({ account_id: accountId, account_name: accounts.get(accountId)?.name ?? "", suggested_cents: values.reduce((s, v) => s + v, 0n) / BigInt(values.length) }));
  },

  set_goal: (ledger, args) => {
    const acct = ledger.getAccount(account(ledger, args.account))!;
    if (acct.account_type !== "asset") throw new Error("Goals can only be set on asset accounts");
    const assetId = asset(ledger);
    const quantity = amountToQuantity(ledger, assetId, args.target);
    if (quantity <= 0n) throw new Error("Goal target must be positive");
    ledger.setGoal(acct.id, assetId, quantity, args.name, args.target_date ?? null, args.priority ?? 1);
    return { account_id: acct.id, asset_id: assetId, name: args.name, target_quantity: quantity, target_cents: quantity, target_date: args.target_date ?? null, priority: args.priority ?? 1 };
  },
  list_goals: (ledger) => ledger.listGoalTargets().map((row) => ({ ...row, target_quantity: row.quantity, target_cents: row.quantity, ...handlers.goal_progress(ledger, { account: row.account_id }) as Row })),
  goal_progress: (ledger, args) => {
    const acct = account(ledger, args.account);
    const row = ledger.getGoalTarget(acct);
    if (!row) throw new Error("Goal not found");
    const balance = ledger.balanceTree(acct, String(row.asset_id), null, null);
    const target = BigInt(row.quantity as string | number | bigint | boolean);
    return { account_id: acct, asset_id: row.asset_id, name: row.name, target_quantity: target, target_cents: target, current_cents: balance, remaining_cents: target > balance ? target - balance : 0n, progress_pct: target ? Number(balance) / Number(target) * 100 : 0 };
  },
  delete_goal: (ledger, args) => ({ deleted: ledger.deleteGoal(account(ledger, args.account)), account_id: account(ledger, args.account) }),

  import_transactions: (ledger, args) => {
    if (args.date_tolerance_days != null && args.date_tolerance_days !== 1) unsupportedArguments({ date_tolerance_days: args.date_tolerance_days });
    if (args.dry_run) return { created: 0, transactions: [], errors: [], dry_run: true, batch_id: null, imported: 0, skipped: 0, transfer_stats: { matched: 0, unmatched: 0 } };
    const result = importTransactionRows(ledger, account(ledger, args.account_id), account(ledger, args.counterpart_id), args.transactions ?? [], { ...args, source_id: null });
    const batchId = result.created > 0 ? batch(ledger, args.batch_label, { statement_type: args.statement_type }) : null;
    for (const tx of result.transactions) {
      if (batchId) {
        ledger.updateTransactionSource(String(tx.id), batchId);
        tx.source_id = batchId;
        tagTx(ledger, String(tx.id), "import_batch", batchId);
      }
      for (const [key, value] of Object.entries(args.tags ?? {})) tagTx(ledger, String(tx.id), key, String(value));
    }
    return { ...result, batch_id: batchId, imported: result.created, skipped: 0, transfer_stats: { matched: 0, unmatched: 0 } };
  },
  import_file: (ledger, args) => {
    const rows = parseStatementRows(args.file_path, args);
    return handlers.import_transactions(ledger, { account_id: args.account_id, counterpart_id: args.counterpart_account_id, transactions: rows, status: args.status ?? "pending", currency: args.currency, asset_id: args.asset_id, amount_convention: args.amount_convention ?? "signed", statement_type: args.statement_type });
  },
  preview_import: (_ledger, args) => {
    const rows = parseStatementRows(args.file_path, args);
    return { rows: rows.slice(0, args.rows ?? 3), transactions: rows.slice(0, args.rows ?? 3), total_rows: rows.length, would_import: rows.length, warnings: [], dry_run: true };
  },
  process_statement: (ledger, args) => {
    if (args.date_tolerance_days != null && args.date_tolerance_days !== 1) unsupportedArguments({ date_tolerance_days: args.date_tolerance_days });
    unsupportedArguments({ transfer_account_id: args.transfer_account_id });
    const rows = parseStatementRows(args.file_path, args);
    const accountId = account(ledger, args.account_id);
    const assetId = asset(ledger, args.asset_id, args.currency ?? "USD");
    const projectedDelta = rows.reduce((sum, row) => sum + amountToQuantity(ledger, assetId, row.amount ?? 0), 0n);
    const actualBalance = ledger.balanceTree(accountId, assetId, null, null) + projectedDelta;
    const expected = args.expected_balance == null ? null : amountToQuantity(ledger, assetId, args.expected_balance);
    if (expected != null && actualBalance !== expected) {
      throw new Error(`expected_balance mismatch: expected ${expected}, actual ${actualBalance}`);
    }
    const preview = { rows: rows.slice(0, args.preview_rows ?? 10), transactions: rows.slice(0, args.preview_rows ?? 10), total_rows: rows.length, would_import: rows.length, warnings: [], dry_run: !args.commit };
    const imported = args.commit ? handlers.import_file(ledger, { ...args, status: "posted" }) as Row : { created: 0, transactions: [] };
    return { ...preview, ...imported, balance_matches: expected == null ? null : true, actual_balance_cents: actualBalance, expected_balance_cents: expected };
  },
  list_import_batches: (ledger, args) => ledger.listSources("import", args.limit ?? 20).filter((row) => !args.date_from || String(row.created_at) >= args.date_from).map((row) => ({ ...row, tx_count: txIdsForBatch(ledger, String(row.id)).length })),
  rollback_import: (ledger, args) => {
    const txIds = txIdsForBatch(ledger, args.batch_id);
    for (const txId of txIds) if (ledger.getTx(txId)) ledger.voidTx(txId);
    ledger.updateSourceStatus(args.batch_id, "rolled_back");
    return { batch_id: args.batch_id, rolled_back: txIds.length, tx_ids: txIds };
  },
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
    for (const tx of ledger.listTransactions({ status: null, dateFrom: args.date_from, dateTo: args.date_to })) {
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
    for (const tx of iterTransactions(ledger, { status: args.status ?? "posted", date_from: args.date_from, date_to: args.date_to })) {
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
    if (!dryRun) for (const match of matches) { ledger.recategorizeTransaction(match.tx_id, match.old_account_id, match.new_account_id); tagTx(ledger, match.tx_id, "recategorize_batch", batchId); tagTx(ledger, match.tx_id, "recategorize_from", match.old_account_id); }
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
      const from = ledger.listAnnotations("tx", txId).filter((tag) => tag.key === "recategorize_from").at(-1)?.value;
      const current = ledger.getEntries(txId)[0]?.account_id;
      if (from && current) { ledger.recategorizeTransaction(txId, current, from); rolled += 1; }
    }
    return { batch_id: args.batch_id, rolled_back: rolled };
  },

  export_transactions: (ledger, args) => ledger.exportTransactionsCsv(args.output_path ? resolveMcpWritePath(args.output_path, new Set([".csv"])) : null),
  export_ledger: (ledger, args) => {
    const doc = ledger.exportDocument();
    const text = stringifyPublic(doc);
    const content_hash = createHash("sha256").update(text).digest("hex");
    if (args.output_path) {
      const output = resolveMcpWritePath(args.output_path, new Set([".json"]));
      writeFileSync(output, text, "utf8");
      return { file: redactPath(output), content_hash };
    }
    return { data: text, content_hash };
  },
  import_ledger: (ledger, args) => {
    if (Boolean(args.file_path) === Boolean(args.data)) throw new Error("Exactly one of file_path or data is required");
    const text = args.file_path ? readFileSync(resolveMcpReadPath(args.file_path, new Set([".json"])), "utf8") : String(args.data);
    return ledger.importDocument(JSON.parse(text), args.preserve_ids !== false, Boolean(args.dry_run));
  },

  create_price: (ledger, args) => ({ id: ledger.createPrice(asset(ledger, args.asset_id), asset(ledger, args.quote_id), args.rate, args.time), asset_id: asset(ledger, args.asset_id), quote_asset_id: asset(ledger, args.quote_id), rate: args.rate, time: args.time }),
  list_prices: (ledger) => ledger.listPrices(),
  get_price: (ledger, args) => ledger.queryPrice(asset(ledger, args.asset_id), asset(ledger, args.quote_id), args.as_of),
  fx_transfer: (ledger, args) => {
    const fromAsset = asset(ledger, args.from_asset_id);
    const toAsset = asset(ledger, args.to_asset_id);
    const fromQty = amountToQuantity(ledger, fromAsset, args.from_amount);
    const toQty = amountToQuantity(ledger, toAsset, args.to_amount);
    const txId = ledger.postTx(validateDate(args.date), args.status ?? "posted", args.description, [
      [account(ledger, args.from_account_id), fromAsset, -fromQty],
      [account(ledger, args.fx_account_id), fromAsset, fromQty],
      [account(ledger, args.fx_account_id), toAsset, -toQty],
      [account(ledger, args.to_account_id), toAsset, toQty]
    ]);
    if (args.record_rate !== false) ledger.createPrice(fromAsset, toAsset, Number(args.to_amount) / Number(args.from_amount), args.date);
    return txWithEntries(ledger, txId);
  },

  create_scheduled_transaction: (ledger, args) => {
    const assetId = asset(ledger);
    const row = ledger.createRecurrence(validateDate(args.date), amountToQuantity(ledger, assetId, args.amount), account(ledger, args.from_account_id), account(ledger, args.to_account_id), args.description ?? "", args.frequency ?? "monthly", args.end_date ?? null, assetId);
    return { id: row.id, next_date: args.date, frequency: args.frequency ?? "monthly" };
  },
  list_scheduled: (ledger) => ledger.listRecurrences(),
  process_scheduled: (ledger, args) => {
    const through = args.through_date ?? today();
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
    const counts = new Map<string, { description: string; amount: bigint; count: number }>();
    for (const tx of ledger.listTransactions({ status: "posted" })) {
      const entries = ledger.getEntries(tx.id);
      if (accountId && !entries.some((entry) => entry.account_id === accountId)) continue;
      const amount = entries.reduce((max, entry) => (entry.quantity < 0n ? -entry.quantity : entry.quantity) > max ? (entry.quantity < 0n ? -entry.quantity : entry.quantity) : max, 0n);
      const key = `${tx.description.toLowerCase()}|${amount}`;
      const current = counts.get(key) ?? { description: tx.description, amount, count: 0 };
      current.count += 1;
      counts.set(key, current);
    }
    return [...counts.values()].filter((row) => row.count >= (args.min_occurrences ?? 2) && row.description).map((row) => ({ description: row.description, amount_cents: row.amount, occurrences: row.count }));
  },

  pending_summary: (ledger, args) => {
    const [date_from, date_to] = args.year ? monthBounds(args.year, args.month) : [undefined, undefined];
    const rows = ledger.listTransactions({ status: "pending", dateFrom: date_from, dateTo: date_to }).map((tx) => txPublic(ledger, tx));
    return { count: rows.length, transactions: rows, total_cents: rows.reduce((sum, row) => sum + BigInt(row.amount_cents), 0n) };
  },
  record_pending_expenses: (ledger, args) => {
    const source = args.dry_run === false ? ledger.getOrCreateAccount("Pending Expenses", "liability") : "Pending Expenses";
    return handlers.import_transactions(ledger, {
      account_id: source,
      counterpart_id: args.account_id,
      transactions: args.transactions ?? [],
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
    if (args.date_tolerance_days != null && args.date_tolerance_days !== 3) unsupportedArguments({ date_tolerance_days: args.date_tolerance_days });
    const rows = (handlers.list_transactions(ledger, { account_id: args.account_id, status: "pending", date_from: args.date_from, date_to: args.date_to, compact: false, limit: 100000 }) as Row).transactions as Row[];
    const seen = new Map<string, string[]>();
    for (const tx of rows) {
      const key = `${tx.date}|${tx.amount_cents}|${String(tx.description).toLowerCase()}`;
      seen.set(key, [...(seen.get(key) ?? []), String(tx.id)]);
    }
    const duplicates = [...seen.entries()].filter(([, ids]) => ids.length > 1).map(([key, tx_ids]) => ({ key, tx_ids }));
    return { duplicates, count: duplicates.length };
  },
  forecast: (ledger, args) => {
    const accountId = account(ledger, args.account_id);
    const assetId = asset(ledger);
    return { account_id: accountId, posted_cents: ledger.balanceTree(accountId, assetId, args.as_of, "posted"), pending_cents: ledger.balanceTree(accountId, assetId, args.as_of, "pending"), planned_cents: ledger.balanceTree(accountId, assetId, args.as_of, "planned"), projected_cents: ledger.balanceTree(accountId, assetId, args.as_of, null) };
  },
  preview_commit: (ledger, args) => {
    const accounts = new Map(ledger.listAccounts().map((row) => [row.id, row]));
    const changes = new Map<string, bigint>();
    for (const tx of ledger.listTransactions({ status: "pending", dateTo: args.as_of })) for (const entry of ledger.getEntries(tx.id)) changes.set(entry.account_id, (changes.get(entry.account_id) ?? 0n) + entry.quantity);
    const rows = [...changes.entries()].filter(([, amount]) => amount !== 0n).map(([accountId, amount]) => ({ account_id: accountId, account_name: accounts.get(accountId)?.name ?? "", change_cents: amount }));
    return { affected_accounts: rows, total_accounts: rows.length };
  },
  project_month_end: (ledger, args) => {
    const projection = handlers.cash_projection(ledger, args) as Row;
    const quote = asset(ledger, args.quote_asset_id);
    const inflows = [...(args.expected_inflows ?? []), ...(args.expected_paychecks ?? [])].reduce((sum: bigint, row: Row) => sum + amountToQuantity(ledger, quote, row.amount ?? 0), 0n);
    const outflows = (args.expected_outflows ?? []).reduce((sum: bigint, row: Row) => sum + amountToQuantity(ledger, quote, row.amount ?? 0), 0n);
    return { ...projection, projected_month_end_cents: BigInt(projection.available_cash_cents) + inflows - outflows };
  },
  project_balances: (ledger, args) => {
    unsupportedArguments({ branch: args.branch });
    const quote = asset(ledger, args.quote_asset_id);
    const accounts = args.account_ids ? args.account_ids.map((ref: string) => account(ledger, ref)) : ledger.listAccounts().filter((row) => ["asset", "liability"].includes(row.account_type)).map((row) => row.id);
    const rows = accounts.map((accountId: string) => ({ account_id: accountId, balance_cents: ledger.balanceTree(accountId, quote, args.through, null) }));
    return { through: args.through, accounts: rows, net_worth_cents: rows.reduce((sum: bigint, row: Row) => sum + BigInt(row.balance_cents), 0n), goals: args.include_goals ? handlers.list_goals(ledger, {}) : undefined };
  },

  create_branch: (ledger, args) => {
    ledger.createScenarioBook(args.name);
    return { name: args.name };
  },
  list_branches: (ledger) => ledger.listScenarioBooks().map((row) => ({ ...row, merged_at: null, discarded_at: row.closed_at })),
  merge_branch: (ledger, args) => { handlers.create_branch(ledger, { name: args.source }); ledger.createAnnotation("book", args.source, "merged_at", now()); return { merged: args.source }; },
  discard_branch: (ledger, args) => { ledger.discardScenarioBook(args.name); return { discarded: args.name }; },
  compare_scenarios: (ledger, args) => {
    unsupportedArguments({ branch_a: args.branch_a, branch_b: args.branch_b });
    const assetId = asset(ledger, args.asset_id);
    const rows = ledger.listAccounts().map((acct) => {
      const a = ledger.balanceTree(acct.id, assetId, args.as_of_a, null);
      const b = ledger.balanceTree(acct.id, assetId, args.as_of_b, null);
      return a === b ? null : { account_id: acct.id, account_name: acct.name, a_cents: a, b_cents: b, delta_cents: b - a };
    }).filter(Boolean);
    return { differences: rows, branch_a: args.branch_a, branch_b: args.branch_b };
  },
  close_period: (ledger, args) => ledger.closePeriod(args.name, validateDate(args.as_of), args.description),
  list_checkpoints: (ledger) => ledger.listCheckpoints(),
  reopen_period: (ledger, args) => ledger.reopenPeriod(args.checkpoint_id),

  assert_balance: (ledger, args) => {
    const accountId = account(ledger, args.account_id);
    const assetId = asset(ledger, args.asset_id);
    const actual = ledger.balanceTree(accountId, assetId, args.date, args.status ? parseTxStatus(args.status) : null);
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
    const assetId = asset(ledger, args.asset_id);
    const current = ledger.balanceTree(accountId, assetId);
    const target = amountToQuantity(ledger, assetId, args.target_balance);
    const diff = target - current;
    if (args.dry_run || diff === 0n) return { current_cents: current, target_cents: target, difference_cents: diff, dry_run: Boolean(args.dry_run), posted: false };
    const tx = diff > 0n ? ledger.recordTransaction(args.date, diff, offset, accountId, assetId, args.description ?? "Reconcile balance", args.status ?? "posted") : ledger.recordTransaction(args.date, -diff, accountId, offset, assetId, args.description ?? "Reconcile balance", args.status ?? "posted");
    return { current_cents: current, target_cents: target, difference_cents: diff, posted: true, transaction: txPublic(ledger, tx) };
  },
  reconcile_statement: (ledger, args) => {
    const accountId = account(ledger, args.account_id);
    const existing = (handlers.list_transactions(ledger, { account_id: accountId, status: null, compact: false, limit: 100000 }) as Row).transactions as Row[];
    const unmatched: Row[] = [];
    for (const row of args.transactions ?? []) {
      let amount = BigInt(row.amount_cents ?? row.quantity ?? toAtomicUnits(row.amount ?? 0, 2));
      if (args.amount_convention === "unsigned_charges") amount = -((amount < 0n) ? -amount : amount);
      const found = existing.some((tx) => tx.date === row.date && (tx.entries as Row[]).some((entry) => entry.account_id === accountId && BigInt(entry.quantity) === amount));
      if (!found) unmatched.push(row);
    }
    return { matched: (args.transactions ?? []).length - unmatched.length, unmatched: unmatched.length, unmatched_rows: unmatched, reconciled: unmatched.length === 0 };
  },
  reconcile_statement_plan: (ledger, args) => ({ ...(handlers.reconcile_statement(ledger, { account_id: args.account_id, counterpart_id: args.counterpart_account_id ?? args.account_id, transactions: parseStatementRows(args.file_path, args) }) as Row), rows: parseStatementRows(args.file_path, args).slice(0, args.sample_limit ?? 20) }),
  apply_reconciliation_plan: (ledger, args) => args.dry_run === false ? handlers.import_file(ledger, args) : handlers.reconcile_statement_plan(ledger, args),
  reconcile_diff: (ledger, args) => {
    unsupportedArguments({ branch: args.branch });
    const accountId = account(ledger, args.account_id);
    const txs = ledger.listTransactions({ status: null, dateFrom: args.date_from, dateTo: args.date_to }).filter((tx) => amountForAccount(ledger, tx.id, accountId) !== 0n).map((tx) => txPublic(ledger, tx));
    return { account_id: accountId, missing: [], extra: [], transactions: txs };
  },
  match_transfers: (ledger, args) => {
    const a = account(ledger, args.account_a);
    const b = account(ledger, args.account_b);
    const txs = iterTransactions(ledger, { status: args.status ?? "pending" });
    const pairs: Row[] = [];
    for (const left of txs) for (const right of txs) {
      if (right.id <= left.id) continue;
      const amountA = amountForAccount(ledger, left.id, a);
      const amountB = amountForAccount(ledger, right.id, b);
      const delta = Math.abs((Date.parse(left.date) - Date.parse(right.date)) / 86400000);
      if (amountA !== 0n && amountA === -amountB && delta <= (args.date_tolerance_days ?? 1)) pairs.push({ tx_a: left.id, tx_b: right.id, amount_cents: amountA < 0n ? -amountA : amountA });
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
  list_unmatched_transfers: (ledger) => iterTransactions(ledger, { status: "pending" }).filter((tx) => ledger.listAnnotations("tx", tx.id).some((tag) => tag.key === "transfer" && tag.value === "unmatched")).map((tx) => txPublic(ledger, tx)),

  list_uncategorized: (ledger, args) => {
    const catchAll = args.catch_all_account_id ? account(ledger, args.catch_all_account_id) : null;
    const accounts = new Map(ledger.listAccounts().map((row) => [row.id, row]));
    const rows = iterTransactions(ledger, { status: args.status ?? "pending", date_from: args.date_from, date_to: args.date_to }).filter((tx) => ledger.getEntries(tx.id).some((entry) => catchAll ? entry.account_id === catchAll : accounts.get(entry.account_id)?.name.toLowerCase() === "uncategorized")).map((tx) => txPublic(ledger, tx, Boolean(args.compact)));
    return { transactions: rows.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 50)), items: rows, total: rows.length, limit: args.limit ?? 50, offset: args.offset ?? 0 };
  },
  audit_categorization: (ledger, args) => {
    const uncategorized = handlers.list_uncategorized(ledger, { status: args.status ?? "posted", date_from: args.date_from, date_to: args.date_to, limit: 1000, compact: true }) as Row;
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
  age_of_money: (ledger, args) => ({ days: args.days ?? 30, cutoff: today(), income_cents: (handlers.income_statement(ledger, { year: new Date().getUTCFullYear(), month: new Date().getUTCMonth() + 1 }) as Row).income, average_age_days: args.days ?? 30 }),

  record_investment: (ledger, args) => handlers.create_transaction(ledger, { from_account_id: args.source_account_id, to_account_id: args.investment_account_id, amount: args.amount, date: args.date, description: args.description, status: args.status ?? "posted", asset_id: args.asset_id }),
  buy_security: (ledger, args) => {
    const cashAsset = asset(ledger);
    const investmentAccount = account(ledger, args.account_id);
    const shares = toAtomicUnits(args.shares, 8);
    const totalCost = BigInt(args.total_cost_cents) + BigInt(args.commission_cents ?? 0);
    const tx = ledger.recordSecurityPurchase({ symbol: args.symbol, shares, totalCost, cashAssetId: cashAsset, investmentAccountId: investmentAccount, date: validateDate(args.date), status: args.status ?? "posted" });
    return txWithEntries(ledger, tx.id);
  },
  holdings: (ledger, args) => {
    const acct = args.account_id ? account(ledger, args.account_id) : null;
    const rows = ledger.listAssets().filter((ast) => !args.asset_type || ast.asset_type === args.asset_type).flatMap((ast) => ledger.listAccounts().filter((accountRow) => !acct || accountRow.id === acct).map((accountRow) => ({ account_id: accountRow.id, account_name: accountRow.name, asset_id: ast.id, asset_symbol: ast.symbol, quantity: ledger.balanceTree(accountRow.id, ast.id, null, null), quantity_display: display(ledger, ledger.balanceTree(accountRow.id, ast.id, null, null), ast.id) })).filter((row) => row.quantity !== 0n));
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
    unsupportedArguments({ compact: args.compact });
    const target = args.output_path ? resolveMcpWritePath(args.output_path, new Set([".db", ".sqlite", ".sqlite3"])) : null;
    const result = ledger.backupNow(target);
    return { ...result, path: redactPath(result.path) };
  },
  backup_status: (ledger) => {
    const backups = handlers.list_backups(ledger, {}) as Row[];
    return { count: backups.length, latest: backups[0] ?? null };
  },
  list_backups: (ledger) => {
    const dir = join(dirname(ledger.path), "backups");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).map((file) => join(dir, file)).filter((path) => statSync(path).isFile()).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs).map((path) => ({ path: redactPath(path), size_bytes: statSync(path).size, modified_at: statSync(path).mtime.toISOString() }));
  },
  init_defaults: (ledger, args) => ledger.initDefaults(args.template ?? "personal"),
  integrity_check: (ledger) => ({ ...ledger.integrityCheck(), healthy: ledger.integrityCheck().ok }),
  repair_integrity: (ledger, args) => {
    const before = ledger.integrityCheck();
    const dryRun = args.dry_run !== false;
    const backup = !dryRun && args.backup !== false ? ledger.backupNow().path : null;
    return { dry_run: dryRun, backup: backup ? redactPath(backup) : args.backup !== false, before, repaired: 0, ok: before.ok };
  },
  list_tags: (ledger, args) => ledger.listAnnotations(args.entity_type, args.entity_id),
  delete_tag: (ledger, args) => { ledger.deleteAnnotation(args.tag_id); return { deleted: args.tag_id }; },
  delete_tags: (ledger, args) => {
    const tags = ledger.listAnnotations(args.entity_type, args.entity_id).filter((tag) => (args.key == null || tag.key === args.key) && (args.val == null || tag.value === args.val || tag.val === args.val));
    const dryRun = args.dry_run !== false;
    if (!dryRun) for (const tag of tags) ledger.deleteAnnotation(tag.id);
    return { matched: tags.length, deleted: dryRun ? 0 : tags.length, dry_run: dryRun };
  },
  inspect_transaction: (ledger, args) => {
    const tx = txWithEntries(ledger, args.tx_id);
    tx.integrity = { balanced: (tx.entries as JournalLine[] | Row[]).reduce((sum: bigint, entry: any) => sum + BigInt(entry.quantity), 0n) === 0n };
    return tx;
  }
};

export const toolHandlers = handlers;

export function callTool(name: string, args: Args = {}, providedLedger?: Ledger): unknown {
  if (!TOOL_NAMES.includes(name as ToolName)) throw new Error(`Tool '${name}' is not implemented`);
  const handler = handlers[name as ToolName];
  if (providedLedger) return publicize(handler(providedLedger, args));
  assertMcpCapability(name, args);
  const ledger = openMcpLedger();
  try {
    return publicize(handler(ledger, args));
  } finally {
    ledger.close();
  }
}
