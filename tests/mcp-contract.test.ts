import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { callTool, TOOL_NAMES, type ToolName } from "../src/app/index.js";
import { Ledger } from "../src/core/index.js";
import { TOOL_SIGNATURES } from "../src/mcp/signatures.js";

type Args = Record<string, unknown>;

type TestContext = {
  ledger: Ledger;
  dir: string;
  db: string;
  accounts: Record<string, string>;
  assets: Record<string, string>;
  tx: Record<string, string>;
  batches: Record<string, string>;
  files: Record<string, string>;
  annotations: Record<string, string>;
  checkpoints: Record<string, string>;
  schedules: Record<string, string>;
};

type ContractCase = {
  mutation: "read" | "write" | "dry-run";
  args: (ctx: TestContext) => Args;
  setup?: (ctx: TestContext) => void;
  assert?: (result: any, ctx: TestContext) => void;
};

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function createContext(): TestContext {
  const previousDb = process.env.CLOVIS_DB;
  const previousRoot = process.env.CLOVIS_MCP_ALLOWED_ROOT;
  const dir = mkdtempSync(join(tmpdir(), "clovis-contract-"));
  const db = join(dir, "ledger.db");
  process.env.CLOVIS_DB = db;
  process.env.CLOVIS_MCP_ALLOWED_ROOT = dir;
  const ledger = new Ledger(db);
  cleanups.push(() => {
    ledger.close();
    if (previousDb == null) delete process.env.CLOVIS_DB; else process.env.CLOVIS_DB = previousDb;
    if (previousRoot == null) delete process.env.CLOVIS_MCP_ALLOWED_ROOT; else process.env.CLOVIS_MCP_ALLOWED_ROOT = previousRoot;
    rmSync(dir, { recursive: true, force: true });
  });

  ledger.initDefaults("personal");
  const accounts = Object.fromEntries(ledger.listAccounts().map((row) => [row.name, row.id]));
  accounts["Transfer Clearing"] = ledger.createAccount("Transfer Clearing", "equity");
  accounts.Brokerage = ledger.createAccount("Brokerage", "asset");
  accounts["Delete Me"] = ledger.createAccount("Delete Me", "expense");
  accounts["Merge Source"] = ledger.createAccount("Merge Source", "expense");
  accounts["Budget Copy Target"] = ledger.createAccount("Budget Copy Target", "expense");
  accounts["FX Clearing"] = ledger.createAccount("FX Clearing", "equity");

  const usd = ledger.getAssetBySymbol("USD")!.id;
  const eur = ledger.createAsset("EUR", "currency", 2, "Euro");
  const jpy = ledger.createAsset("JPY", "currency", 0, "Yen");
  const unused = ledger.createAsset("CAD", "currency", 2, "Canadian Dollar");
  ledger.createPrice(eur, usd, "1.10", "2026-06-01");
  ledger.createPrice(jpy, usd, "0.01", "2026-06-01");

  const tx = {
    pay: ledger.recordTransaction("2026-06-01", 100000n, accounts.Salary, accounts.Checking, usd, "June Pay", "posted").id,
    groceries: ledger.recordTransaction("2026-06-02", 2500n, accounts.Checking, accounts.Groceries, usd, "Market Groceries", "posted").id,
    pending: ledger.recordTransaction("2026-06-03", 1200n, accounts.Checking, accounts.Uncategorized, usd, "Coffee Pending", "pending").id,
    planned: ledger.recordTransaction("2026-06-09", 3300n, accounts.Checking, accounts.Rent, usd, "Planned Rent", "planned").id,
    transferA: ledger.recordTransaction("2026-06-04", 7500n, accounts.Checking, accounts["Transfer Clearing"], usd, "Transfer Out", "pending").id,
    transferB: ledger.recordTransaction("2026-06-04", 7500n, accounts["Transfer Clearing"], accounts.Savings, usd, "Transfer In", "pending").id,
    duplicateA: ledger.recordTransaction("2026-06-05", 999n, accounts.Checking, accounts.Uncategorized, usd, "Duplicate Pending", "pending").id,
    duplicateB: ledger.recordTransaction("2026-06-05", 999n, accounts.Checking, accounts.Uncategorized, usd, "Duplicate Pending", "pending").id,
    eurSeed: ledger.recordTransaction("2026-06-06", 10000n, accounts["Opening Balances"], accounts.Savings, eur, "EUR Seed", "posted").id
  };

  const statement = "date,amount,description,counterpart,kind\n2026-06-20,44.00,Statement Deposit,Opening Balances,income\n";
  const statementPath = join(dir, "statement.csv");
  writeFileSync(statementPath, statement, "utf8");

  return {
    ledger,
    dir,
    db,
    accounts,
    assets: { usd, eur, jpy, unused },
    tx,
    batches: {},
    files: { statement: "statement.csv" },
    annotations: {},
    checkpoints: {},
    schedules: {}
  };
}

function ensureBudget(ctx: TestContext): void {
  callTool("set_budget", { account: ctx.accounts.Groceries, amount: 500, year: 2026, month: 6 }, ctx.ledger);
}

function ensureGoal(ctx: TestContext): void {
  callTool("set_goal", { account: ctx.accounts.Savings, target: 1000, name: "Reserve" }, ctx.ledger);
}

function ensureRule(ctx: TestContext, pattern = "Coffee Pending"): void {
  ctx.ledger.createRule("match", ctx.accounts["Dining Out"], pattern);
}

function ensureTag(ctx: TestContext): void {
  ctx.annotations.tx = ctx.ledger.createAnnotation("tx", ctx.tx.pay, "memo", "tagged");
}

function ensureImportBatch(ctx: TestContext): void {
  if (ctx.batches.import) return;
  const result = callTool("import_transactions", {
    account_id: ctx.accounts.Checking,
    counterpart_id: ctx.accounts["Opening Balances"],
    transactions: [{ date: "2026-06-21", amount: 10, description: "Batch Import" }],
    status: "pending",
    batch_label: "Contract Batch"
  }, ctx.ledger) as any;
  ctx.batches.import = result.batch_id;
  ctx.tx.imported = result.transactions[0].id;
}

function ensureRecatBatch(ctx: TestContext): void {
  if (ctx.batches.recat) return;
  const result = callTool("recategorize_by_pattern", {
    pattern: "Market Groceries",
    new_account_id: ctx.accounts["Dining Out"],
    old_account_id: ctx.accounts.Groceries,
    status: "posted",
    dry_run: false
  }, ctx.ledger) as any;
  ctx.batches.recat = result.batch_id;
}

function ensureCheckpoint(ctx: TestContext): void {
  if (ctx.checkpoints.closed) return;
  ctx.checkpoints.closed = String(ctx.ledger.closePeriod("Contract close", "2026-05-31").id);
}

function ensureSchedule(ctx: TestContext): void {
  if (ctx.schedules.monthly) return;
  const result = callTool("create_scheduled_transaction", {
    date: "2026-06-01",
    amount: 15,
    from_account_id: ctx.accounts.Checking,
    to_account_id: ctx.accounts.Utilities,
    description: "Scheduled utility",
    frequency: "monthly"
  }, ctx.ledger) as any;
  ctx.schedules.monthly = result.id;
}

function expectObject(result: any): void {
  expect(result).toEqual(expect.any(Object));
  expect(Object.keys(result)).not.toHaveLength(0);
}

function expectArray(result: any): void {
  expect(Array.isArray(result)).toBe(true);
}

function ledgerFingerprint(ledger: Ledger): string {
  const tables = (ledger.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
  const rows = Object.fromEntries(tables.map((table) => [
    table,
    ledger.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
  ]));
  return JSON.stringify(rows, (_key, value) => typeof value === "bigint" ? value.toString() : value);
}

const CASES = {
  account_register: { mutation: "read", args: (ctx) => ({ account_id: ctx.accounts.Checking }), assert: expectObject },
  add_match_rule: { mutation: "write", args: (ctx) => ({ account_id: ctx.accounts.Groceries, pattern: "Market" }), assert: expectObject },
  add_match_rules: { mutation: "write", args: (ctx) => ({ rules: [{ account_id: ctx.accounts.Groceries, pattern: "Market" }] }), assert: (result) => expect(result.created).toBe(1) },
  age_of_money: { mutation: "read", args: () => ({ days: 30 }), assert: expectObject },
  apply_match_rules: { mutation: "dry-run", setup: ensureRule, args: (ctx) => ({ catch_all_account_id: ctx.accounts.Uncategorized }), assert: expectObject },
  apply_pattern: { mutation: "dry-run", args: (ctx) => ({ pattern: "Market", target_account: ctx.accounts["Dining Out"], source_account: ctx.accounts.Groceries }), assert: expectObject },
  apply_reconciliation_plan: { mutation: "dry-run", args: (ctx) => ({ file_path: ctx.files.statement, account_id: ctx.accounts.Checking, counterpart_account_id: ctx.accounts["Opening Balances"] }), assert: expectObject },
  apply_rollover: { mutation: "write", setup: ensureBudget, args: () => ({ year: 2026, month: 6 }), assert: expectObject },
  assert_balance: { mutation: "read", args: (ctx) => ({ account_id: ctx.accounts.Checking, expected: 913.02, date: "2026-06-30" }), assert: (result) => expect(result).toHaveProperty("matches") },
  assert_balances: { mutation: "read", args: (ctx) => ({ assertions: [{ account_id: ctx.accounts.Checking, expected: 913.02, date: "2026-06-30" }] }), assert: expectObject },
  audit_categorization: { mutation: "read", args: () => ({ status: "pending" }), assert: expectObject },
  backup_now: { mutation: "write", args: () => ({}), assert: (result) => expect(result.path).toContain("backups") },
  backup_status: { mutation: "read", setup: (ctx) => { callTool("backup_now", {}, ctx.ledger); }, args: () => ({}), assert: expectObject },
  balance_sheet: { mutation: "read", args: (ctx) => ({ date: "2026-06-30", quote_asset_id: ctx.assets.usd }), assert: expectObject },
  budget_rollover_preview: { mutation: "read", setup: ensureBudget, args: () => ({ year: 2026, month: 6 }), assert: expectObject },
  budget_status: { mutation: "read", setup: ensureBudget, args: (ctx) => ({ account: ctx.accounts.Groceries, year: 2026, month: 6 }), assert: expectObject },
  budget_summary: { mutation: "read", setup: ensureBudget, args: () => ({ year: 2026, month: 6 }), assert: expectObject },
  buy_security: { mutation: "write", args: (ctx) => ({ account_id: ctx.accounts.Brokerage, symbol: "AAPL", shares: 1.25, total_cost_cents: 12345, commission_cents: 55, date: "2026-06-10" }), assert: expectObject },
  cash_flow: { mutation: "read", args: (ctx) => ({ year: 2026, month: 6, quote_asset_id: ctx.assets.usd }), assert: expectObject },
  cash_projection: { mutation: "read", args: (ctx) => ({ year: 2026, month: 6, quote_asset_id: ctx.assets.usd }), assert: expectObject },
  close_period: { mutation: "write", args: () => ({ name: "May close", as_of: "2026-05-31" }), assert: expectObject },
  commit_batch: { mutation: "write", setup: ensureImportBatch, args: (ctx) => ({ batch_id: ctx.batches.import }), assert: (result) => expect(result.committed).toBeGreaterThan(0) },
  compare_scenarios: { mutation: "read", args: (ctx) => ({ asset_id: ctx.assets.usd }), assert: expectObject },
  consolidate_transfers: { mutation: "dry-run", args: (ctx) => ({ account_a: ctx.accounts.Checking, account_b: ctx.accounts.Savings }), assert: expectObject },
  copy_budgets: { mutation: "write", setup: ensureBudget, args: () => ({ from_year: 2026, from_month: 6, to_year: 2026, to_month: 7 }), assert: expectObject },
  count_transactions: { mutation: "read", args: () => ({ status: "posted" }), assert: expectObject },
  create_account: { mutation: "write", args: () => ({ name: "Coffee", type: "expense", code: "6180" }), assert: expectObject },
  create_accounts: { mutation: "write", args: () => ({ accounts: [{ name: "Office", type: "expense" }] }), assert: expectObject },
  create_asset: { mutation: "write", args: () => ({ symbol: "GBP", asset_type: "currency", decimals: 2, name: "Pound" }), assert: expectObject },
  create_branch: { mutation: "write", args: () => ({ name: "scenario" }), assert: expectObject },
  create_price: { mutation: "write", args: (ctx) => ({ asset_id: ctx.assets.eur, quote_id: ctx.assets.usd, rate: 1.2, time: "2026-06-15" }), assert: expectObject },
  create_scheduled_transaction: { mutation: "write", args: (ctx) => ({ date: "2026-06-01", amount: 25, from_account_id: ctx.accounts.Checking, to_account_id: ctx.accounts.Utilities, description: "Utility", frequency: "monthly" }), assert: expectObject },
  create_transaction: { mutation: "write", args: (ctx) => ({ date: "2026-06-11", amount: 12, from_account_id: ctx.accounts.Checking, to_account_id: ctx.accounts["Dining Out"], description: "Lunch", status: "posted" }), assert: expectObject },
  delete_account: { mutation: "write", args: (ctx) => ({ id: ctx.accounts["Delete Me"] }), assert: expectObject },
  delete_asset: { mutation: "write", args: (ctx) => ({ asset_id: ctx.assets.unused }), assert: expectObject },
  delete_budget: { mutation: "write", setup: ensureBudget, args: (ctx) => ({ account: ctx.accounts.Groceries, year: 2026, month: 6 }), assert: expectObject },
  delete_budgets: { mutation: "write", setup: ensureBudget, args: () => ({ year: 2026, month: 6 }), assert: expectObject },
  delete_goal: { mutation: "write", setup: ensureGoal, args: (ctx) => ({ account: ctx.accounts.Savings }), assert: expectObject },
  delete_match_rule: { mutation: "write", setup: ensureRule, args: (ctx) => ({ account_id: ctx.accounts["Dining Out"], pattern: "Coffee Pending" }), assert: expectObject },
  delete_match_rules: { mutation: "write", setup: ensureRule, args: (ctx) => ({ rules: [{ account_id: ctx.accounts["Dining Out"], pattern: "Coffee Pending" }] }), assert: expectObject },
  delete_tag: { mutation: "write", setup: ensureTag, args: (ctx) => ({ tag_id: ctx.annotations.tx }), assert: expectObject },
  delete_tags: { mutation: "dry-run", setup: ensureTag, args: (ctx) => ({ entity_type: "tx", entity_id: ctx.tx.pay, key: "memo" }), assert: expectObject },
  delete_transaction: { mutation: "write", args: (ctx) => ({ id: ctx.tx.pending }), assert: expectObject },
  detect_recurring: { mutation: "read", args: () => ({ min_occurrences: 1 }), assert: expectArray },
  discard_batch: { mutation: "dry-run", setup: ensureImportBatch, args: (ctx) => ({ batch_id: ctx.batches.import }), assert: expectObject },
  discard_branch: { mutation: "write", setup: (ctx) => { callTool("create_branch", { name: "scenario" }, ctx.ledger); }, args: () => ({ name: "scenario" }), assert: expectObject },
  export_ledger: { mutation: "read", args: () => ({}), assert: (result) => expect(String(result.data)).toContain("accounts") },
  export_transactions: { mutation: "read", args: () => ({}), assert: (result) => expect(String(result.csv)).toContain("date,description") },
  financial_overview: { mutation: "read", setup: ensureBudget, args: () => ({ year: 2026, month: 6 }), assert: expectObject },
  financial_picture: { mutation: "read", setup: ensureBudget, args: () => ({ year: 2026, month: 6 }), assert: expectObject },
  find_pending_duplicates: { mutation: "read", args: () => ({}), assert: (result) => expect(result.count).toBeGreaterThan(0) },
  flip_entries: { mutation: "write", args: (ctx) => ({ tx_ids: [ctx.tx.groceries] }), assert: expectObject },
  forecast: { mutation: "read", args: (ctx) => ({ account_id: ctx.accounts.Checking, as_of: "2026-06-30" }), assert: expectObject },
  forecast_month_end: { mutation: "read", setup: ensureBudget, args: () => ({ year: 2026, month: 6 }), assert: expectObject },
  fx_transfer: { mutation: "write", args: (ctx) => ({ from_account_id: ctx.accounts.Checking, to_account_id: ctx.accounts.Savings, from_amount: 10, to_amount: 9, from_asset_id: ctx.assets.usd, to_asset_id: ctx.assets.eur, fx_account_id: ctx.accounts["FX Clearing"], date: "2026-06-12", description: "FX move" }), assert: expectObject },
  get_account: { mutation: "read", args: (ctx) => ({ id: ctx.accounts.Checking }), assert: expectObject },
  get_account_by_name: { mutation: "read", args: () => ({ name: "Checking" }), assert: expectObject },
  get_asset_by_symbol: { mutation: "read", args: () => ({ symbol: "USD" }), assert: expectObject },
  get_balance: { mutation: "read", args: (ctx) => ({ account_id: ctx.accounts.Checking }), assert: expectObject },
  get_price: { mutation: "read", args: (ctx) => ({ asset_id: ctx.assets.eur, quote_id: ctx.assets.usd, as_of: "2026-06-30" }), assert: expectObject },
  get_transaction: { mutation: "read", args: (ctx) => ({ id: ctx.tx.pay }), assert: expectObject },
  goal_progress: { mutation: "read", setup: ensureGoal, args: (ctx) => ({ account: ctx.accounts.Savings }), assert: expectObject },
  holdings: { mutation: "read", setup: (ctx) => { callTool("buy_security", { account_id: ctx.accounts.Brokerage, symbol: "MSFT", shares: 2, total_cost_cents: 20000, date: "2026-06-10" }, ctx.ledger); }, args: () => ({ asset_type: "security" }), assert: expectArray },
  import_file: { mutation: "write", args: (ctx) => ({ file_path: ctx.files.statement, account_id: ctx.accounts.Checking, counterpart_account_id: ctx.accounts["Opening Balances"], status: "pending", counterpart_col: "counterpart", tag_cols: { kind: "kind" } }), assert: expectObject },
  import_ledger: { mutation: "write", args: (ctx) => ({ data: (callTool("export_ledger", {}, ctx.ledger) as any).data }), assert: expectObject },
  import_transactions: { mutation: "write", args: (ctx) => ({ account_id: ctx.accounts.Checking, counterpart_id: ctx.accounts["Opening Balances"], transactions: [{ date: "2026-06-22", amount: 5, description: "Inline import" }], status: "pending" }), assert: expectObject },
  income_statement: { mutation: "read", args: (ctx) => ({ year: 2026, month: 6, quote_asset_id: ctx.assets.usd }), assert: expectObject },
  init_defaults: { mutation: "write", args: () => ({ template: "personal" }), assert: expectObject },
  inspect_transaction: { mutation: "read", args: (ctx) => ({ tx_id: ctx.tx.pay }), assert: expectObject },
  integrity_check: { mutation: "read", args: () => ({}), assert: (result) => expect(result.ok).toBe(true) },
  invert_import: { mutation: "write", setup: ensureImportBatch, args: (ctx) => ({ batch_id: ctx.batches.import }), assert: expectObject },
  list_accounts: { mutation: "read", args: () => ({}), assert: expectArray },
  list_assets: { mutation: "read", args: () => ({}), assert: expectArray },
  list_backups: { mutation: "read", setup: (ctx) => { callTool("backup_now", {}, ctx.ledger); }, args: () => ({}), assert: expectArray },
  list_branches: { mutation: "read", setup: (ctx) => { callTool("create_branch", { name: "scenario" }, ctx.ledger); }, args: () => ({}), assert: expectArray },
  list_checkpoints: { mutation: "read", setup: ensureCheckpoint, args: () => ({}), assert: expectArray },
  list_entries: { mutation: "read", args: (ctx) => ({ tx_id: ctx.tx.pay }), assert: expectArray },
  list_entries_by_asset: { mutation: "read", args: (ctx) => ({ asset_id: ctx.assets.usd }), assert: expectObject },
  list_goals: { mutation: "read", setup: ensureGoal, args: () => ({}), assert: expectArray },
  list_import_batches: { mutation: "read", setup: ensureImportBatch, args: () => ({}), assert: expectArray },
  list_match_rules: { mutation: "read", setup: ensureRule, args: () => ({}), assert: expectArray },
  list_prices: { mutation: "read", args: () => ({}), assert: expectArray },
  list_scheduled: { mutation: "read", setup: ensureSchedule, args: () => ({}), assert: expectArray },
  list_tags: { mutation: "read", setup: ensureTag, args: (ctx) => ({ entity_type: "tx", entity_id: ctx.tx.pay }), assert: expectArray },
  list_transactions: { mutation: "read", args: () => ({ status: "posted", compact: false }), assert: expectObject },
  list_uncategorized: { mutation: "read", args: (ctx) => ({ catch_all_account_id: ctx.accounts.Uncategorized, status: "pending" }), assert: expectObject },
  list_unmatched_transfers: { mutation: "read", args: () => ({}), assert: expectArray },
  match_transfer_pairs: { mutation: "dry-run", args: (ctx) => ({ account_a: ctx.accounts.Checking, account_b: ctx.accounts.Savings, date_tolerance_days: 1 }), assert: expectObject },
  match_transfers: { mutation: "dry-run", args: (ctx) => ({ account_a: ctx.accounts.Checking, account_b: ctx.accounts.Savings, date_tolerance_days: 1 }), assert: expectObject },
  merge_accounts: { mutation: "write", args: (ctx) => ({ sources: [ctx.accounts["Merge Source"]], target: ctx.accounts.Groceries }), assert: expectObject },
  merge_branch: { mutation: "write", args: () => ({ source: "scenario" }), assert: expectObject },
  migrate_asset_entries: { mutation: "dry-run", args: (ctx) => ({ from_asset_id: ctx.assets.usd, to_asset_id: ctx.assets.unused }), assert: expectObject },
  move_transactions: { mutation: "dry-run", args: (ctx) => ({ from_account: ctx.accounts.Uncategorized, to_account: ctx.accounts.Groceries }), assert: expectObject },
  net_worth: { mutation: "read", args: (ctx) => ({ date: "2026-06-30", quote_asset_id: ctx.assets.usd }), assert: expectObject },
  pending_summary: { mutation: "read", args: () => ({ year: 2026, month: 6 }), assert: expectObject },
  plan_transaction: { mutation: "write", args: (ctx) => ({ date: "2026-06-30", amount: 75, from_account_id: ctx.accounts.Checking, to_account_id: ctx.accounts.Rent, description: "Future rent" }), assert: expectObject },
  post_journal_entry: { mutation: "write", args: (ctx) => ({ date: "2026-06-13", description: "Manual journal", legs: [{ account_id: ctx.accounts.Checking, amount: 10 }, { account_id: ctx.accounts["Opening Balances"], amount: -10 }] }), assert: expectObject },
  preview_commit: { mutation: "read", args: () => ({ as_of: "2026-06-30" }), assert: expectObject },
  preview_import: { mutation: "read", args: (ctx) => ({ file_path: ctx.files.statement, account_id: ctx.accounts.Checking, counterpart_account_id: ctx.accounts["Opening Balances"] }), assert: expectObject },
  process_scheduled: { mutation: "write", setup: ensureSchedule, args: () => ({ through_date: "2026-06-30" }), assert: expectObject },
  process_statement: { mutation: "dry-run", args: (ctx) => ({ file_path: ctx.files.statement, account_id: ctx.accounts.Checking, counterpart_account_id: ctx.accounts["Opening Balances"], expected_balance: null }), assert: expectObject },
  project_balances: { mutation: "read", setup: ensureGoal, args: (ctx) => ({ through: "2026-06-30", include_goals: true, quote_asset_id: ctx.assets.usd }), assert: expectObject },
  project_month_end: { mutation: "read", args: (ctx) => ({ year: 2026, month: 6, expected_inflows: [{ amount: 100 }], expected_outflows: [{ amount: 25 }], quote_asset_id: ctx.assets.usd }), assert: expectObject },
  recategorize_by_pattern: { mutation: "dry-run", args: (ctx) => ({ pattern: "Market", new_account_id: ctx.accounts["Dining Out"], old_account_id: ctx.accounts.Groceries, status: "posted" }), assert: expectObject },
  recategorize_by_patterns: { mutation: "dry-run", args: (ctx) => ({ rules: [{ pattern: "Market", new_account_id: ctx.accounts["Dining Out"] }], old_account_id: ctx.accounts.Groceries, status: "posted" }), assert: expectObject },
  recategorize_transaction: { mutation: "write", args: (ctx) => ({ tx_id: ctx.tx.groceries, old_account_id: ctx.accounts.Groceries, new_account_id: ctx.accounts["Dining Out"] }), assert: expectObject },
  recognize_gain_loss: { mutation: "write", args: (ctx) => ({ date: "2026-06-14", amount: 5, investment_account_id: ctx.accounts.Brokerage, description: "Mark gain" }), assert: expectObject },
  reconcile_diff: { mutation: "read", args: (ctx) => ({ account_id: ctx.accounts.Checking, date_from: "2026-06-01", date_to: "2026-06-30" }), assert: expectObject },
  reconcile_statement: { mutation: "read", args: (ctx) => ({ account_id: ctx.accounts.Checking, counterpart_id: ctx.accounts["Opening Balances"], transactions: [{ date: "2026-06-01", amount_cents: 100000, description: "June Pay" }] }), assert: expectObject },
  reconcile_statement_plan: { mutation: "read", args: (ctx) => ({ file_path: ctx.files.statement, account_id: ctx.accounts.Checking, counterpart_account_id: ctx.accounts["Opening Balances"] }), assert: expectObject },
  reconcile_to_balance: { mutation: "dry-run", args: (ctx) => ({ account_id: ctx.accounts.Checking, target_balance: 1000, offset_account_id: ctx.accounts["Opening Balances"], date: "2026-06-30", dry_run: true }), assert: expectObject },
  record_investment: { mutation: "write", args: (ctx) => ({ date: "2026-06-15", amount: 100, investment_account_id: ctx.accounts.Brokerage, source_account_id: ctx.accounts.Checking, description: "Investment transfer" }), assert: expectObject },
  record_opening_balance: { mutation: "write", args: (ctx) => ({ account_id: ctx.accounts.Brokerage, amount: 200, date: "2026-05-31", status: "posted" }), assert: expectObject },
  record_opening_balances: { mutation: "write", args: (ctx) => ({ balances: [{ account_id: ctx.accounts.Brokerage, amount: 200 }], date: "2026-05-31", status: "posted" }), assert: expectObject },
  record_pending_expenses: { mutation: "dry-run", args: (ctx) => ({ account_id: ctx.accounts["Credit Card"], transactions: [{ date: "2026-06-23", amount: 18, description: "Pending expense" }] }), assert: expectObject },
  reopen_period: { mutation: "write", setup: ensureCheckpoint, args: (ctx) => ({ checkpoint_id: ctx.checkpoints.closed }), assert: expectObject },
  repair_integrity: { mutation: "dry-run", args: () => ({}), assert: expectObject },
  rollback_import: { mutation: "write", setup: ensureImportBatch, args: (ctx) => ({ batch_id: ctx.batches.import }), assert: expectObject },
  rollback_recategorize: { mutation: "write", setup: ensureRecatBatch, args: (ctx) => ({ batch_id: ctx.batches.recat }), assert: expectObject },
  search_transactions: { mutation: "read", args: () => ({ query: "Pay", status: "posted" }), assert: expectObject },
  set_budget: { mutation: "write", args: (ctx) => ({ account: ctx.accounts.Groceries, amount: 500, year: 2026, month: 6 }), assert: expectObject },
  set_budgets: { mutation: "write", args: (ctx) => ({ budgets: [{ account: ctx.accounts.Groceries, amount: 500 }], year: 2026, month: 6 }), assert: expectObject },
  set_goal: { mutation: "write", args: (ctx) => ({ account: ctx.accounts.Savings, target: 1000, name: "Reserve" }), assert: expectObject },
  spending: { mutation: "read", args: (ctx) => ({ year: 2026, month: 6, quote_asset_id: ctx.assets.usd }), assert: expectObject },
  spending_rate: { mutation: "read", setup: ensureBudget, args: () => ({ year: 2026, month: 6 }), assert: expectArray },
  suggest_budgets: { mutation: "read", args: () => ({ months: 1, year: 2026, month: 6 }), assert: expectArray },
  top_descriptions: { mutation: "read", args: (ctx) => ({ account_id: ctx.accounts.Checking }), assert: expectArray },
  transfer: { mutation: "write", args: (ctx) => ({ from_account_id: ctx.accounts.Checking, to_account_id: ctx.accounts.Savings, amount: 25, date: "2026-06-16", description: "Move cash" }), assert: expectObject },
  trial_balance: { mutation: "read", args: () => ({}), assert: expectObject },
  unbudgeted_spending: { mutation: "read", setup: ensureBudget, args: () => ({ year: 2026, month: 6 }), assert: expectArray },
  update_account: { mutation: "write", args: (ctx) => ({ id: ctx.accounts["Delete Me"], name: "Delete Me Updated", code: "6999" }), assert: expectObject },
  update_asset: { mutation: "write", args: (ctx) => ({ asset_id: ctx.assets.unused, name: "Canadian Dollar Updated" }), assert: expectObject },
  void_by_filter: { mutation: "dry-run", args: () => ({ status: "pending", dry_run: true }), assert: expectObject }
} satisfies Record<ToolName, ContractCase>;

describe("MCP contract matrix", () => {
  it("has one explicit contract case for every MCP tool", () => {
    expect(Object.keys(TOOL_SIGNATURES).sort()).toEqual([...TOOL_NAMES].sort());
    expect(Object.keys(CASES).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it.each(TOOL_NAMES)("%s has contract behavior", (name) => {
    const ctx = createContext();
    const row = CASES[name];
    row.setup?.(ctx);
    const before = ledgerFingerprint(ctx.ledger);
    const result = callTool(name, row.args(ctx), ctx.ledger);
    const after = ledgerFingerprint(ctx.ledger);
    expect(result).not.toBeUndefined();
    row.assert?.(result, ctx);
    if (row.mutation === "read" || row.mutation === "dry-run") {
      expect(after).toBe(before);
    }
    expect(ctx.ledger.integrityCheck().ok).toBe(true);
  });
});
