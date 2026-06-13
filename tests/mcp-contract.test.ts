import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { callTool, TOOL_NAMES, type ToolName } from "../src/app/index.js";
import { Ledger } from "../src/core/index.js";
import { TOOL_SIGNATURES } from "../src/mcp/signatures.js";

type Args = Record<string, unknown>;

// One contract case per MCP tool. This catches accidental surface drift even
// when a tool's implementation delegates to shared app/core code.
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
  expectLedgerChange?: boolean;
};

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function createContext(): TestContext {
  const previousDb = process.env.CLOVIS_DB;
  const dir = mkdtempSync(join(tmpdir(), "clovis-contract-"));
  const db = join(dir, "ledger.db");
  process.env.CLOVIS_DB = db;
  const ledger = new Ledger(db);
  cleanups.push(() => {
    ledger.close();
    if (previousDb == null) delete process.env.CLOVIS_DB; else process.env.CLOVIS_DB = previousDb;
    rmSync(dir, { recursive: true, force: true });
  });

  ledger.initDefaults("personal", ledger.createAsset("USD", "currency", 2, "US Dollar"));
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
  for (const accountId of Object.values(accounts)) ledger.createAnnotation("account", accountId, "default_asset", usd);
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

function ensureRealizedPlanned(ctx: TestContext): void {
  if (ctx.tx.realizedPlanned) return;
  ctx.tx.realizedPosted = ctx.ledger.recordTransaction("2026-06-09", 3300n, ctx.accounts.Checking, ctx.accounts.Rent, ctx.assets.usd, "Planned Rent", "posted").id;
  ctx.tx.realizedPlanned = ctx.ledger.recordTransaction("2026-06-10", 3300n, ctx.accounts.Checking, ctx.accounts.Rent, ctx.assets.usd, "Planned Rent", "planned").id;
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

function ensureLedgerOperation(ctx: TestContext): void {
  if (ctx.batches.ledgerOperation) return;
  const result = callTool("recategorize_transaction", {
    tx_id: ctx.tx.groceries,
    old_account_id: ctx.accounts.Groceries,
    new_account_id: ctx.accounts["Dining Out"],
    dry_run: false
  }, ctx.ledger) as any;
  ctx.batches.ledgerOperation = result.operation_id;
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

function parseCliToolOutput(stdout: string): any {
  const envelope = JSON.parse(stdout);
  expect(envelope.ok).toBe(true);
  return envelope.data;
}

function callCliTool(ctx: TestContext, name: ToolName, args: Args): any {
  const stdout = execFileSync(process.execPath, ["dist/cli/main.js", "--db", ctx.db, "--format", "json", "tool", name, "--json", JSON.stringify(args)], {
    cwd: process.cwd(),
    env: { ...process.env, CLOVIS_DB: ctx.db },
    encoding: "utf8",
    timeout: 30_000
  });
  return parseCliToolOutput(stdout);
}

async function withMcpClient(ctx: TestContext, fn: (client: Client) => Promise<void>): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/mcp/main.js"],
    cwd: process.cwd(),
    env: { ...process.env, CLOVIS_DB: ctx.db },
    stderr: "pipe"
  });
  const client = new Client({ name: "clovis-contract-test", version: "0.0.0" });
  try {
    await client.connect(transport);
    await fn(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function callMcpTool(ctx: TestContext, name: ToolName, args: Args): Promise<any> {
  let parsed: any;
  await withMcpClient(ctx, async (client) => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.type).toBe("text");
    expect((result as any).isError, content[0]?.text).not.toBe(true);
    parsed = JSON.parse(String(content[0]?.text ?? ""));
  });
  return parsed;
}

const CASES = {
  account_balances: { mutation: "read", args: () => ({ account_type: "asset" }), assert: expectArray },
  account_register: { mutation: "read", args: (ctx) => ({ account_id: ctx.accounts.Checking }), assert: expectObject },
  add_match_rule: { mutation: "write", args: (ctx) => ({ account_id: ctx.accounts.Groceries, pattern: "Market" }), assert: expectObject },
  add_match_rules: { mutation: "write", args: (ctx) => ({ rules: [{ account_id: ctx.accounts.Groceries, pattern: "Market" }] }), assert: (result) => expect(result.created).toBe(1) },
  age_of_money: { mutation: "read", args: (ctx) => ({ days: 30, quote_asset_id: ctx.assets.usd }), assert: expectObject },
  apply_match_rules: { mutation: "dry-run", setup: ensureRule, args: (ctx) => ({ catch_all_account_id: ctx.accounts.Uncategorized }), assert: expectObject },
  apply_pattern: { mutation: "dry-run", args: (ctx) => ({ pattern: "Market", target_account: ctx.accounts["Dining Out"], source_account: ctx.accounts.Groceries }), assert: expectObject },
  apply_reconciliation_plan: { mutation: "dry-run", args: (ctx) => ({ file_path: ctx.files.statement, account_id: ctx.accounts.Checking, counterpart_account_id: ctx.accounts["Opening Balances"] }), assert: expectObject },
  apply_rollover: { mutation: "write", setup: ensureBudget, args: (ctx) => ({ year: 2026, month: 6, quote_asset_id: ctx.assets.usd }), assert: expectObject },
  assert_balance: { mutation: "read", args: (ctx) => ({ account_id: ctx.accounts.Checking, expected: 913.02, date: "2026-06-30" }), assert: (result) => expect(result).toHaveProperty("matches") },
  assert_balances: { mutation: "read", args: (ctx) => ({ assertions: [{ account_id: ctx.accounts.Checking, expected: 913.02, date: "2026-06-30" }] }), assert: expectObject },
  audit_categorization: { mutation: "read", args: () => ({ status: "pending" }), assert: expectObject },
  backup_now: { mutation: "write", args: () => ({}), assert: (result) => expect(result.path).toContain("backups") },
  backup_status: { mutation: "read", setup: (ctx) => { callTool("backup_now", {}, ctx.ledger); }, args: () => ({}), assert: expectObject },
  balance_sheet: { mutation: "read", args: (ctx) => ({ date: "2026-06-30", quote_asset_id: ctx.assets.usd }), assert: expectObject },
  budget_rollover_preview: { mutation: "read", setup: ensureBudget, args: (ctx) => ({ year: 2026, month: 6, quote_asset_id: ctx.assets.usd }), assert: expectObject },
  budget_status: { mutation: "read", setup: ensureBudget, args: (ctx) => ({ account: ctx.accounts.Groceries, year: 2026, month: 6, quote_asset_id: ctx.assets.usd }), assert: expectObject },
  budget_summary: { mutation: "read", setup: ensureBudget, args: (ctx) => ({ year: 2026, month: 6, quote_asset_id: ctx.assets.usd }), assert: expectObject },
  buy_security: { mutation: "write", args: (ctx) => ({ account_id: ctx.accounts.Brokerage, symbol: "AAPL", shares: 1.25, total_cost_cents: 12345, commission_cents: 55, date: "2026-06-10" }), assert: expectObject },
  cash_flow: { mutation: "read", args: (ctx) => ({ year: 2026, month: 6, quote_asset_id: ctx.assets.usd }), assert: expectObject },
  cash_projection: { mutation: "read", args: (ctx) => ({ year: 2026, month: 6, quote_asset_id: ctx.assets.usd }), assert: expectObject },
  cash_runway: { mutation: "read", setup: ensureBudget, args: (ctx) => ({ year: 2026, month: 6, as_of: "2026-06-11", quote_asset_id: ctx.assets.usd }), assert: (result) => {
    expectObject(result);
    expect(result.burn_models).toBeDefined();
    expect(result.models).toBeUndefined();
  } },
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
  file_access_status: { mutation: "read", args: () => ({}), assert: (result, ctx) => {
    expect(result.mode).toBe("unrestricted");
    expect(result.path_policy).toContain("operating system permits");
    expect(result.ledger_dir).toBe(realpathSync(ctx.dir));
  } },
  financial_overview: { mutation: "read", setup: ensureBudget, args: (ctx) => ({ year: 2026, month: 6, quote_asset_id: ctx.assets.usd }), assert: expectObject },
  financial_picture: { mutation: "read", setup: ensureBudget, args: (ctx) => ({ year: 2026, month: 6, quote_asset_id: ctx.assets.usd }), assert: expectObject },
  find_pending_duplicates: { mutation: "read", args: () => ({}), assert: (result) => expect(result.count).toBeGreaterThan(0) },
  find_realized_planned: { mutation: "read", setup: ensureRealizedPlanned, args: (ctx) => ({ year: 2026, month: 6, account_id: ctx.accounts.Checking }), assert: (result) => expect(result.count).toBeGreaterThan(0) },
  flip_entries: { mutation: "write", args: (ctx) => ({ tx_ids: [ctx.tx.groceries] }), assert: expectObject },
  forecast: { mutation: "read", args: (ctx) => ({ account_id: ctx.accounts.Checking, as_of: "2026-06-30" }), assert: expectObject },
  forecast_month_end: { mutation: "read", setup: ensureBudget, args: (ctx) => ({ year: 2026, month: 6, quote_asset_id: ctx.assets.usd }), assert: expectObject },
  fx_transfer: { mutation: "write", args: (ctx) => ({ from_account_id: ctx.accounts.Checking, to_account_id: ctx.accounts.Savings, from_amount: 10, to_amount: 9, from_asset_id: ctx.assets.usd, to_asset_id: ctx.assets.eur, fx_account_id: ctx.accounts["FX Clearing"], date: "2026-06-12", description: "FX move" }), assert: expectObject },
  get_account: { mutation: "read", args: (ctx) => ({ id: ctx.accounts.Checking }), assert: expectObject },
  get_account_by_name: { mutation: "read", args: () => ({ name: "Checking" }), assert: expectObject },
  get_asset_by_symbol: { mutation: "read", args: () => ({ symbol: "USD" }), assert: expectObject },
  get_balance: { mutation: "read", args: (ctx) => ({ account_id: ctx.accounts.Checking }), assert: expectObject },
  get_ledger_operation: { mutation: "read", setup: ensureLedgerOperation, args: (ctx) => ({ operation_id: ctx.batches.ledgerOperation }), assert: expectObject },
  get_price: { mutation: "read", args: (ctx) => ({ asset_id: ctx.assets.eur, quote_id: ctx.assets.usd, as_of: "2026-06-30" }), assert: expectObject },
  get_transaction: { mutation: "read", args: (ctx) => ({ id: ctx.tx.pay }), assert: expectObject },
  goal_progress: { mutation: "read", setup: ensureGoal, args: (ctx) => ({ account: ctx.accounts.Savings }), assert: expectObject },
  holdings: { mutation: "read", setup: (ctx) => { callTool("buy_security", { account_id: ctx.accounts.Brokerage, symbol: "MSFT", shares: 2, total_cost_cents: 20000, date: "2026-06-10" }, ctx.ledger); }, args: () => ({ asset_type: "security" }), assert: expectArray },
  import_file: { mutation: "write", args: (ctx) => ({ file_path: ctx.files.statement, account_id: ctx.accounts.Checking, counterpart_account_id: ctx.accounts["Opening Balances"], status: "pending", counterpart_col: "counterpart", tag_cols: { kind: "kind" } }), assert: expectObject },
  import_ledger: {
    mutation: "write",
    args: (ctx) => {
      const doc = JSON.parse((callTool("export_ledger", {}, ctx.ledger) as any).data);
      doc.accounts = doc.accounts.map((account: any) => ({ ...account, name: `Imported ${account.name}` }));
      return { data: JSON.stringify(doc), preserve_ids: false };
    },
    assert: expectObject
  },
  import_transactions: { mutation: "write", args: (ctx) => ({ account_id: ctx.accounts.Checking, counterpart_id: ctx.accounts["Opening Balances"], transactions: [{ date: "2026-06-22", amount: 5, description: "Inline import" }], status: "pending" }), assert: expectObject },
  income_statement: { mutation: "read", args: (ctx) => ({ year: 2026, month: 6, quote_asset_id: ctx.assets.usd }), assert: expectObject },
  init_defaults: { mutation: "write", args: () => ({ template: "personal", currency: "USD" }), assert: expectObject },
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
  list_ledger_operations: { mutation: "read", setup: ensureLedgerOperation, args: () => ({}), assert: expectArray },
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
  operating_manual: { mutation: "read", args: () => ({ topic: "statement_import" }), assert: (result) => {
    expect(result.name).toBe("Clovis Operating Manual");
    expect(result.recommended_tools).toContain("preview_import");
  } },
  pending_summary: { mutation: "read", args: () => ({ year: 2026, month: 6 }), assert: expectObject },
  plan_transaction: { mutation: "write", args: (ctx) => ({ date: "2026-06-30", amount: 75, from_account_id: ctx.accounts.Checking, to_account_id: ctx.accounts.Rent, description: "Future rent" }), assert: expectObject },
  post_journal_entry: { mutation: "write", args: (ctx) => ({ date: "2026-06-13", description: "Manual journal", legs: [{ account_id: ctx.accounts.Checking, amount: 10 }, { account_id: ctx.accounts["Opening Balances"], amount: -10 }] }), assert: expectObject },
  preview_commit: { mutation: "read", args: () => ({ as_of: "2026-06-30" }), assert: expectObject },
  preview_import: { mutation: "read", args: (ctx) => ({ file_path: ctx.files.statement, account_id: ctx.accounts.Checking, counterpart_account_id: ctx.accounts["Opening Balances"] }), assert: expectObject },
  preview_mutation: { mutation: "read", args: () => ({ tool_name: "create_account", arguments: { name: "Preview Account", type: "expense" } }), assert: (result) => {
    expect(result.dry_run).toBe(true);
    expect(result.diff.some((row: any) => row.entity_type === "accounts" && row.action === "insert")).toBe(true);
  } },
  process_scheduled: { mutation: "write", setup: ensureSchedule, args: () => ({ through_date: "2026-06-30" }), assert: expectObject },
  process_statement: { mutation: "dry-run", args: (ctx) => ({ file_path: ctx.files.statement, account_id: ctx.accounts.Checking, counterpart_account_id: ctx.accounts["Opening Balances"], expected_balance: null }), assert: expectObject },
  project_balances: { mutation: "read", setup: ensureGoal, args: (ctx) => ({ through: "2026-06-30", include_goals: true, quote_asset_id: ctx.assets.usd }), assert: expectObject },
  project_month_end: { mutation: "read", args: (ctx) => ({ year: 2026, month: 6, asset_account_ids: [ctx.accounts.Checking], liability_account_ids: [ctx.accounts["Credit Card"]], expected_inflows: [{ amount: 100 }], expected_outflows: [{ amount: 25 }], quote_asset_id: ctx.assets.usd }), assert: (result, ctx) => {
    expect(result.asset_account_ids).toEqual([ctx.accounts.Checking]);
    expect(result.liability_account_ids).toEqual([ctx.accounts["Credit Card"]]);
  } },
  recategorize_by_pattern: { mutation: "dry-run", args: (ctx) => ({ pattern: "Market", new_account_id: ctx.accounts["Dining Out"], old_account_id: ctx.accounts.Groceries, status: "posted" }), assert: expectObject },
  recategorize_by_patterns: { mutation: "dry-run", args: (ctx) => ({ rules: [{ pattern: "Market", new_account_id: ctx.accounts["Dining Out"] }], old_account_id: ctx.accounts.Groceries, status: "posted" }), assert: expectObject },
  recategorize_transaction: { mutation: "dry-run", args: (ctx) => ({ tx_id: ctx.tx.groceries, old_account_id: ctx.accounts.Groceries, new_account_id: ctx.accounts["Dining Out"], dry_run: true }), assert: expectObject },
  recognize_gain_loss: { mutation: "write", args: (ctx) => ({ date: "2026-06-14", amount: 5, investment_account_id: ctx.accounts.Brokerage, description: "Mark gain", asset_id: ctx.assets.usd }), assert: expectObject },
  reconcile_diff: { mutation: "read", args: (ctx) => ({ account_id: ctx.accounts.Checking, date_from: "2026-06-01", date_to: "2026-06-30" }), assert: expectObject },
  reconcile_planned: { mutation: "dry-run", setup: ensureRealizedPlanned, args: (ctx) => ({ year: 2026, month: 6, account_id: ctx.accounts.Checking }), assert: (result) => expect(result.matched).toBeGreaterThan(0) },
  reconcile_statement: { mutation: "read", args: (ctx) => ({ account_id: ctx.accounts.Checking, counterpart_id: ctx.accounts["Opening Balances"], transactions: [{ date: "2026-06-01", amount_cents: 100000, description: "June Pay" }] }), assert: expectObject },
  reconcile_statement_plan: { mutation: "read", args: (ctx) => ({ file_path: ctx.files.statement, account_id: ctx.accounts.Checking, counterpart_account_id: ctx.accounts["Opening Balances"] }), assert: expectObject },
  reconcile_to_balance: { mutation: "dry-run", args: (ctx) => ({ account_id: ctx.accounts.Checking, target_balance: 1000, offset_account_id: ctx.accounts["Opening Balances"], date: "2026-06-30", dry_run: true }), assert: expectObject },
  refresh_statement: { mutation: "write", args: (ctx) => ({ action: "plan", file_path: ctx.files.statement, account_id: ctx.accounts.Checking, counterpart_account_id: ctx.accounts["Opening Balances"], status: "posted", dry_run: false }), assert: (result) => {
    expect(result.plan_id).toEqual(expect.stringMatching(/^stmtplan_/));
  } },
  record_investment: { mutation: "write", args: (ctx) => ({ date: "2026-06-15", amount: 100, investment_account_id: ctx.accounts.Brokerage, source_account_id: ctx.accounts.Checking, description: "Investment transfer" }), assert: expectObject },
  record_opening_balance: { mutation: "write", args: (ctx) => ({ account_id: ctx.accounts.Brokerage, amount: 200, date: "2026-05-31", status: "posted" }), assert: expectObject },
  record_opening_balances: { mutation: "write", args: (ctx) => ({ balances: [{ account_id: ctx.accounts.Brokerage, amount: 200 }], date: "2026-05-31", status: "posted" }), assert: expectObject },
  record_pending_expenses: { mutation: "dry-run", args: (ctx) => ({ account_id: ctx.accounts["Credit Card"], transactions: [{ date: "2026-06-23", amount: 18, description: "Pending expense" }] }), assert: expectObject },
  reopen_period: { mutation: "write", setup: ensureCheckpoint, args: (ctx) => ({ checkpoint_id: ctx.checkpoints.closed }), assert: expectObject },
  repair_integrity: { mutation: "dry-run", args: () => ({}), assert: expectObject },
  reverse_ledger_operation: { mutation: "dry-run", setup: ensureLedgerOperation, args: (ctx) => ({ operation_id: ctx.batches.ledgerOperation }), assert: expectObject },
  rollback_import: { mutation: "write", setup: ensureImportBatch, args: (ctx) => ({ batch_id: ctx.batches.import }), assert: expectObject },
  rollback_recategorize: { mutation: "write", setup: ensureRecatBatch, args: (ctx) => ({ batch_id: ctx.batches.recat }), assert: expectObject },
  search_transactions: { mutation: "read", args: () => ({ query: "Pay", status: "posted" }), assert: expectObject },
  set_budget: { mutation: "write", args: (ctx) => ({ account: ctx.accounts.Groceries, amount: 500, year: 2026, month: 6 }), assert: expectObject },
  set_budgets: { mutation: "write", args: (ctx) => ({ budgets: [{ account: ctx.accounts.Groceries, amount: 500 }], year: 2026, month: 6 }), assert: expectObject },
  set_goal: { mutation: "write", args: (ctx) => ({ account: ctx.accounts.Savings, target: 1000, name: "Reserve" }), assert: expectObject },
  spending: { mutation: "read", args: (ctx) => ({ year: 2026, month: 6, quote_asset_id: ctx.assets.usd }), assert: expectObject },
  spending_rate: { mutation: "read", setup: ensureBudget, args: (ctx) => ({ year: 2026, month: 6, quote_asset_id: ctx.assets.usd }), assert: expectArray },
  suggest_budgets: { mutation: "read", args: (ctx) => ({ months: 1, year: 2026, month: 6, quote_asset_id: ctx.assets.usd }), assert: expectArray },
  top_descriptions: { mutation: "read", args: (ctx) => ({ account_id: ctx.accounts.Checking }), assert: expectArray },
  tool_registry: { mutation: "read", args: () => ({}), assert: (result) => {
    expect(result.count).toBe(TOOL_NAMES.length);
    expect(result.tools.find((tool: any) => tool.name === "list_accounts").safety.readOnlyHint).toBe(true);
    expect(result.tools.find((tool: any) => tool.name === "delete_transaction").safety.destructiveHint).toBe(true);
    expect(result.file_access.mode).toBe("unrestricted");
  } },
  transfer: { mutation: "write", args: (ctx) => ({ from_account_id: ctx.accounts.Checking, to_account_id: ctx.accounts.Savings, amount: 25, date: "2026-06-16", description: "Move cash" }), assert: expectObject },
  trial_balance: { mutation: "read", args: (ctx) => ({ asset_id: ctx.assets.usd }), assert: expectObject },
  unbudgeted_spending: { mutation: "read", setup: ensureBudget, args: (ctx) => ({ year: 2026, month: 6, quote_asset_id: ctx.assets.usd }), assert: expectArray },
  update_account: { mutation: "write", args: (ctx) => ({ id: ctx.accounts["Delete Me"], name: "Delete Me Updated", code: "6999" }), assert: expectObject },
  update_asset: { mutation: "write", args: (ctx) => ({ asset_id: ctx.assets.unused, name: "Canadian Dollar Updated" }), assert: expectObject },
  void_by_filter: { mutation: "dry-run", args: () => ({ status: "pending", dry_run: true }), assert: expectObject }
} satisfies Record<ToolName, ContractCase>;

const APPLY_WRITE_CASES = {
  apply_match_rules: { mutation: "write", setup: ensureRule, args: (ctx) => ({ catch_all_account_id: ctx.accounts.Uncategorized, dry_run: false }), assert: (result) => expect(result.updated).toBeGreaterThan(0), expectLedgerChange: true },
  apply_pattern: { mutation: "write", args: (ctx) => ({ pattern: "Market", target_account: ctx.accounts["Dining Out"], source_account: ctx.accounts.Groceries, dry_run: false }), assert: (result) => expect(result.updated).toBeGreaterThan(0), expectLedgerChange: true },
  apply_reconciliation_plan: { mutation: "write", args: (ctx) => ({ file_path: ctx.files.statement, account_id: ctx.accounts.Checking, counterpart_account_id: ctx.accounts["Opening Balances"], dry_run: false }), assert: (result) => expect(result.created).toBeGreaterThan(0), expectLedgerChange: true },
  consolidate_transfers: { mutation: "write", args: (ctx) => ({ account_a: ctx.accounts.Checking, account_b: ctx.accounts.Savings, dry_run: false }), assert: (result) => expect(result.consolidated).toBeGreaterThan(0), expectLedgerChange: true },
  delete_tags: { mutation: "write", setup: ensureTag, args: (ctx) => ({ entity_type: "tx", entity_id: ctx.tx.pay, key: "memo", dry_run: false }), assert: (result) => expect(result.deleted).toBe(1), expectLedgerChange: true },
  discard_batch: { mutation: "write", setup: ensureImportBatch, args: (ctx) => ({ batch_id: ctx.batches.import, dry_run: false }), assert: (result) => expect(result.discarded).toBeGreaterThan(0), expectLedgerChange: true },
  match_transfer_pairs: { mutation: "write", args: (ctx) => ({ account_a: ctx.accounts.Checking, account_b: ctx.accounts.Savings, date_tolerance_days: 1, dry_run: false }), assert: (result) => expect(result.matched).toBeGreaterThan(0), expectLedgerChange: true },
  match_transfers: { mutation: "write", args: (ctx) => ({ account_a: ctx.accounts.Checking, account_b: ctx.accounts.Savings, date_tolerance_days: 1, dry_run: false }), assert: (result) => expect(result.matched).toBeGreaterThan(0), expectLedgerChange: true },
  migrate_asset_entries: { mutation: "write", args: (ctx) => ({ from_asset_id: ctx.assets.usd, to_asset_id: ctx.assets.unused, dry_run: false }), assert: (result) => expect(result.updated).toBeGreaterThan(0), expectLedgerChange: true },
  move_transactions: { mutation: "write", args: (ctx) => ({ from_account: ctx.accounts.Uncategorized, to_account: ctx.accounts.Groceries, dry_run: false }), assert: (result) => expect(result.moved).toBeGreaterThan(0), expectLedgerChange: true },
  process_statement: { mutation: "write", args: (ctx) => ({ file_path: ctx.files.statement, account_id: ctx.accounts.Checking, counterpart_account_id: ctx.accounts["Opening Balances"], expected_balance: null, commit: true }), assert: (result) => expect(result.created).toBeGreaterThan(0), expectLedgerChange: true },
  recategorize_by_pattern: { mutation: "write", args: (ctx) => ({ pattern: "Market", new_account_id: ctx.accounts["Dining Out"], old_account_id: ctx.accounts.Groceries, status: "posted", dry_run: false }), assert: (result) => expect(result.updated).toBeGreaterThan(0), expectLedgerChange: true },
  recategorize_by_patterns: { mutation: "write", args: (ctx) => ({ rules: [{ pattern: "Market", new_account_id: ctx.accounts["Dining Out"] }], old_account_id: ctx.accounts.Groceries, status: "posted", dry_run: false }), assert: (result) => expect(result.updated).toBeGreaterThan(0), expectLedgerChange: true },
  recategorize_transaction: { mutation: "write", args: (ctx) => ({ tx_id: ctx.tx.groceries, old_account_id: ctx.accounts.Groceries, new_account_id: ctx.accounts["Dining Out"], dry_run: false }), assert: (result) => expect(result.operation_id).toMatch(/^op_/), expectLedgerChange: true },
  reconcile_planned: { mutation: "write", setup: ensureRealizedPlanned, args: (ctx) => ({ year: 2026, month: 6, account_id: ctx.accounts.Checking, dry_run: false }), assert: (result) => expect(result.voided).toBeGreaterThan(0), expectLedgerChange: true },
  reconcile_to_balance: { mutation: "write", args: (ctx) => ({ account_id: ctx.accounts.Checking, target_balance: 1000, offset_account_id: ctx.accounts["Opening Balances"], date: "2026-06-30", dry_run: false }), assert: (result) => expect(result.posted).toBe(true), expectLedgerChange: true },
  record_pending_expenses: { mutation: "write", args: (ctx) => ({ account_id: ctx.accounts["Credit Card"], transactions: [{ date: "2026-06-23", amount: 18, description: "Pending expense" }], dry_run: false }), assert: (result) => expect(result.created).toBe(1), expectLedgerChange: true },
  repair_integrity: { mutation: "write", setup: (ctx) => { ctx.ledger.createAnnotation("tx", "tx_missing", "memo", "orphan"); }, args: () => ({ dry_run: false, backup: false }), assert: (result) => expect(result.repaired).toBeGreaterThan(0), expectLedgerChange: true },
  reverse_ledger_operation: { mutation: "write", setup: ensureLedgerOperation, args: (ctx) => ({ operation_id: ctx.batches.ledgerOperation, dry_run: false }), assert: (result) => expect(result.reverse_journal_ids.length).toBeGreaterThan(0), expectLedgerChange: true },
  void_by_filter: { mutation: "write", args: () => ({ status: "pending", dry_run: false }), assert: (result) => expect(result.voided).toBeGreaterThan(0), expectLedgerChange: true }
} satisfies Partial<Record<ToolName, ContractCase>>;

const WRITE_TOOL_NAMES = TOOL_NAMES.filter((name) => CASES[name].mutation !== "read");
const DRY_RUN_TOOL_NAMES = TOOL_NAMES.filter((name) => CASES[name].mutation === "dry-run");
const APPLY_WRITE_TOOL_NAMES = Object.keys(APPLY_WRITE_CASES) as ToolName[];
const LEDGER_APPLY_CASES = Object.fromEntries(TOOL_NAMES.flatMap((name) => {
  const row = APPLY_WRITE_CASES[name] ?? (CASES[name].mutation === "write" ? CASES[name] : null);
  return row ? [[name, row]] : [];
})) as Partial<Record<ToolName, ContractCase>>;
const LEDGER_APPLY_TOOL_NAMES = Object.keys(LEDGER_APPLY_CASES) as ToolName[];
const REVERSAL_PRIMITIVES = new Set<ToolName>(["reverse_ledger_operation"]);
const NON_LEDGER_MUTATORS = new Set<ToolName>(["backup_now"]);
const REVERSAL_RESTORES_PRIOR_INTEGRITY_ERRORS = new Set<ToolName>(["repair_integrity"]);

function prepareCase(name: ToolName, row: ContractCase): { ctx: TestContext; args: Args; before: string } {
  const ctx = createContext();
  row.setup?.(ctx);
  const before = ledgerFingerprint(ctx.ledger);
  return { ctx, args: row.args(ctx), before };
}

function assertCaseResult(name: ToolName, row: ContractCase, ctx: TestContext, result: any, before: string): void {
  expect(result, `${name} returned undefined`).not.toBeUndefined();
  row.assert?.(result, ctx);
  const after = ledgerFingerprint(ctx.ledger);
  if (row.mutation === "read" || row.mutation === "dry-run") expect(after, `${name} mutated the ledger`).toBe(before);
  if (row.expectLedgerChange) expect(after, `${name} did not mutate the ledger`).not.toBe(before);
  expect(ctx.ledger.integrityCheck().ok, `${name} left the ledger with integrity errors`).toBe(true);
}

function operationIds(ledger: Ledger): Set<string> {
  return new Set(ledger.listLedgerOperations(10000).map((row) => String(row.id)));
}

function newOperationId(result: any, before: Set<string>, ctx: TestContext): string | null {
  const direct = result && typeof result === "object" ? String(result.operation_id ?? result.mutation_id ?? "") : "";
  if (direct) return direct;
  const created = ctx.ledger.listLedgerOperations(10000).map((row) => String(row.id)).filter((id) => !before.has(id));
  return created.length === 1 ? created[0] : null;
}

describe("MCP contract matrix", () => {
  it("has one explicit contract case for every MCP tool", () => {
    expect(Object.keys(TOOL_SIGNATURES).sort()).toEqual([...TOOL_NAMES].sort());
    expect(Object.keys(CASES).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("has explicit write-mode cases for every dry-run mutator", () => {
    expect(APPLY_WRITE_TOOL_NAMES.sort()).toEqual(DRY_RUN_TOOL_NAMES.sort());
  });

  it.each(TOOL_NAMES)("%s has contract behavior", (name) => {
    const row = CASES[name];
    const { ctx, args, before } = prepareCase(name, row);
    assertCaseResult(name, row, ctx, callTool(name, args, ctx.ledger), before);
  });

  it("rejects invalid MCP tool arguments before dispatch", async () => {
    const ctx = createContext();
    await withMcpClient(ctx, async (client) => {
      for (const [name, args] of [
        ["list_transactions", { limit: 1, unexpected: "x" }],
        ["account_balances", { as_of: "2026-99-99" }]
      ] as const) {
        const result = await client.callTool({ name, arguments: args });
        const content = result.content as Array<{ type: string; text?: string }>;
        expect((result as any).isError).toBe(true);
        expect(content[0]?.text).toMatch(/Invalid arguments|Unrecognized key|valid YYYY-MM-DD/);
      }
    });
  });

  it("exposes MCP safety annotations through tool discovery", async () => {
    const ctx = createContext();
    await withMcpClient(ctx, async (client) => {
      const tools = await client.listTools();
      const byName = Object.fromEntries(tools.tools.map((tool: any) => [tool.name, tool]));
      expect(byName.list_accounts.annotations.readOnlyHint).toBe(true);
      expect(byName.list_accounts.annotations.destructiveHint).toBe(false);
      expect(byName.delete_transaction.annotations.destructiveHint).toBe(true);
      expect(byName.void_by_filter.annotations.destructiveHint).toBe(true);
      expect(byName.create_transaction.annotations.readOnlyHint).toBe(false);
      expect(byName.operating_manual.annotations.readOnlyHint).toBe(true);
    });
  });

  it("exposes operating manual instructions and MCP resources", async () => {
    const ctx = createContext();
    await withMcpClient(ctx, async (client) => {
      expect(client.getInstructions()).toContain("Use live Clovis data");
      const resources = await client.listResources();
      const byUri = Object.fromEntries(resources.resources.map((resource) => [resource.uri, resource]));
      expect(byUri["clovis://manual"].mimeType).toBe("text/markdown");
      expect(byUri["clovis://manual/statement-import"].title).toBe("Clovis Statement Import Manual");

      const full = await client.readResource({ uri: "clovis://manual" });
      const fullText = "text" in full.contents[0] ? full.contents[0].text : "";
      expect(fullText).toContain("Clovis Operating Manual");
      expect(fullText).toContain("QFX");

      const importGuide = await client.readResource({ uri: "clovis://manual/statement-import" });
      const importText = "text" in importGuide.contents[0] ? importGuide.contents[0].text : "";
      expect(importText).toContain("Statement Import");
      expect(importText).toContain("preview_import");
    });
  });

  it.each(WRITE_TOOL_NAMES)("%s write-capable tool runs through the CLI surface", (name) => {
    const row = CASES[name];
    const { ctx, args, before } = prepareCase(name, row);
    assertCaseResult(name, row, ctx, callCliTool(ctx, name, args), before);
  }, 120_000);

  it.each(WRITE_TOOL_NAMES)("%s write-capable tool runs through the MCP surface", async (name) => {
    const row = CASES[name];
    const { ctx, args, before } = prepareCase(name, row);
    assertCaseResult(name, row, ctx, await callMcpTool(ctx, name, args), before);
  }, 120_000);

  it.each(APPLY_WRITE_TOOL_NAMES)("%s explicit write mode mutates safely through direct, CLI, and MCP surfaces", async (name) => {
    for (const runner of [
      (ctx: TestContext, args: Args) => callTool(name, args, ctx.ledger),
      (ctx: TestContext, args: Args) => callCliTool(ctx, name, args),
      (ctx: TestContext, args: Args) => callMcpTool(ctx, name, args)
    ]) {
      const row = APPLY_WRITE_CASES[name]!;
      const { ctx, args, before } = prepareCase(name, row);
      assertCaseResult(name, row, ctx, await runner(ctx, args), before);
    }
  }, 120_000);

  it.each(LEDGER_APPLY_TOOL_NAMES)("%s applied ledger mutation is audited and reversible", (name) => {
    const row = LEDGER_APPLY_CASES[name]!;
    const { ctx, args, before } = prepareCase(name, row);
    const beforeOperations = operationIds(ctx.ledger);
    const result = callTool(name, args, ctx.ledger);
    expect(result, `${name} returned undefined`).not.toBeUndefined();
    row.assert?.(result, ctx);
    expect(ctx.ledger.integrityCheck().ok, `${name} failed integrity after apply`).toBe(true);

    const afterApply = ledgerFingerprint(ctx.ledger);
    if (afterApply === before) return;
    if (NON_LEDGER_MUTATORS.has(name)) return;

    const operationId = newOperationId(result, beforeOperations, ctx);
    expect(operationId, `${name} mutated the ledger without returning or recording a ledger operation`).toEqual(expect.stringMatching(/^op_/));
    const operation = callTool("get_ledger_operation", { operation_id: operationId }, ctx.ledger) as any;
    expect(operation.status, `${name} operation was not applied`).toBe("applied");
    expect(operation.operation_type, `${name} operation type mismatch`).toBe(name);
    expect(operation.rows.length, `${name} operation did not record row-level diff`).toBeGreaterThan(0);

    if (REVERSAL_PRIMITIVES.has(name)) return;
    const preview = callTool("reverse_ledger_operation", { operation_id: operationId, date: "2026-12-31" }, ctx.ledger) as any;
    expect(preview.dry_run, `${name} reversal did not preview by default`).toBe(true);
    expect(preview.reversible, `${name} reversal preview was not marked reversible`).toBe(true);
    const reverse = callTool("reverse_ledger_operation", { operation_id: operationId, dry_run: false, date: "2026-12-31" }, ctx.ledger) as any;
    expect(reverse.operation_id, `${name} reversal did not create a reversal operation`).toEqual(expect.stringMatching(/^op_/));
    const reversed = callTool("get_ledger_operation", { operation_id: operationId }, ctx.ledger) as any;
    expect(reversed.status, `${name} original operation was not marked reversed`).toBe("reversed");
    expect(reversed.reversed_by_operation_id, `${name} original operation lacks reversal link`).toBe(reverse.operation_id);
    if (!REVERSAL_RESTORES_PRIOR_INTEGRITY_ERRORS.has(name)) {
      expect(ctx.ledger.integrityCheck().ok, `${name} failed integrity after reversal`).toBe(true);
    }
  }, 120_000);
});
