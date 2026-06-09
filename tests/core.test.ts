import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Ledger, debitCredit, normalAmount, normalSide, toAtomicUnits } from "../src/core/index.js";
import { callTool, TOOL_NAMES } from "../src/app/index.js";
import { toolHandlers } from "../src/app/catalog.js";
import { defaultDbPath, mcpDbPathFromEnv } from "../src/app/context.js";
import { TOOL_DEFINITIONS, TOOL_SIGNATURES } from "../src/mcp/signatures.js";
import { inputShapeFromDefinition } from "../src/mcp/tools.js";

const dirs: string[] = [];

function tempLedger(): Ledger {
  const dir = mkdtempSync(join(tmpdir(), "clovis-npm-"));
  dirs.push(dir);
  return new Ledger(join(dir, "ledger.db"));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ledger core", () => {
  it("matches accounting normal side semantics", () => {
    expect(normalSide("asset")).toBe("debit");
    expect(normalSide("expense")).toBe("debit");
    expect(normalSide("liability")).toBe("credit");
    expect(normalSide("equity")).toBe("credit");
    expect(normalSide("income")).toBe("credit");
    expect(normalAmount("asset", 5000n)).toBe(5000n);
    expect(normalAmount("expense", 1200n)).toBe(1200n);
    expect(normalAmount("liability", -1200n)).toBe(1200n);
    expect(normalAmount("equity", -5000n)).toBe(5000n);
    expect(normalAmount("income", -5000n)).toBe(5000n);
    expect(debitCredit(-1200n)).toEqual({ debit: 0n, credit: 1200n });
  });

  it("creates schema v1 and default book", () => {
    const ledger = tempLedger();
    try {
      const tables = new Set((ledger.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
      for (const table of ["books", "journals", "journal_lines", "annotations", "sources", "targets", "period_closes", "recurrences"]) {
        expect(tables.has(table)).toBe(true);
      }
      const columns = (table: string) => new Set((ledger.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
      expect(columns("journal_lines").has("quantity")).toBe(true);
      expect(columns("assets").has("scale")).toBe(true);
      expect(columns("prices").has("quote_asset_id")).toBe(true);
      expect(columns("targets").has("quantity")).toBe(true);
      expect(columns("recurrences").has("quantity")).toBe(true);
    } finally {
      ledger.close();
    }
  });

  it("posts balanced transactions and rejects imbalanced journals", () => {
    const ledger = tempLedger();
    try {
      const usd = ledger.createAsset("USD", "currency", 2);
      const checking = ledger.createAccount("Checking", "asset");
      const equity = ledger.createAccount("Equity", "equity");
      const tx = ledger.recordTransaction("2026-06-01", 2500n, equity, checking, usd, "Seed", "posted");
      expect(tx.entries.reduce((sum, entry) => sum + entry.quantity, 0n)).toBe(0n);
      expect(ledger.balance(checking, usd)).toBe(2500n);
      expect(() => ledger.postTx("2026-06-02", "posted", "bad", [[checking, usd, 1n]])).toThrow(/balance/);
    } finally {
      ledger.close();
    }
  });

  it("rejects invalid journals without writing", () => {
    const ledger = tempLedger();
    try {
      const usd = ledger.createAsset("USD", "currency", 2);
      const eur = ledger.createAsset("EUR", "currency", 2);
      const checking = ledger.createAccount("Checking", "asset");
      const salary = ledger.createAccount("Salary", "income");
      const suspense = ledger.createAccount("Suspense", "equity");
      const txCount = () => Number((ledger.db.prepare("SELECT count(*) AS c FROM journals").get() as any).c);
      const entryCount = () => Number((ledger.db.prepare("SELECT count(*) AS c FROM journal_lines").get() as any).c);

      expect(() => ledger.postTx("2026-06-01", "posted", "empty", [])).toThrow(/must have entries/);
      expect(txCount()).toBe(0);
      expect(entryCount()).toBe(0);

      expect(() => ledger.postTx("2026-06-01", "posted", "bad swap", [
        [checking, usd, 100n],
        [salary, usd, -100n],
        [checking, eur, 50n],
        [suspense, eur, -49n]
      ])).toThrow(/balance/);
      expect(txCount()).toBe(0);
      expect(entryCount()).toBe(0);

      expect(() => ledger.postTx("2026-06-01", "posted", "bad account", [
        [checking, usd, 100n],
        ["acct_missing", usd, -100n]
      ])).toThrow(/not found/);
      expect(txCount()).toBe(0);
      expect(entryCount()).toBe(0);
    } finally {
      ledger.close();
    }
  });

  it("annotates accounts and handles voided balances", () => {
    const ledger = tempLedger();
    try {
      const usd = ledger.createAsset("USD", "currency", 2);
      const checking = ledger.createAccount("Checking", "asset");
      const card = ledger.createAccount("Credit Card", "liability");
      const salary = ledger.createAccount("Salary", "income");
      const groceries = ledger.createAccount("Groceries", "expense");
      const rows = Object.fromEntries(ledger.listAccounts().map((row) => [row.id, row]));
      expect(rows[checking].normal_balance).toBe("debit");
      expect(rows[checking].statement).toBe("balance_sheet");
      expect(rows[card].normal_balance).toBe("credit");
      expect(rows[salary].statement).toBe("income_statement");
      expect(rows[groceries].normal_balance).toBe("debit");

      const tx = ledger.recordTransaction("2026-06-01", 5000n, salary, checking, usd, "paycheck", "posted");
      expect(ledger.balance(checking, usd)).toBe(5000n);
      ledger.voidTx(tx.id);
      expect(ledger.balance(checking, usd)).toBe(0n);
      expect(ledger.balance(checking, usd, null, null)).toBe(0n);
      expect(ledger.balance(checking, usd, null, "void")).toBe(5000n);
    } finally {
      ledger.close();
    }
  });

  it("uses asset scale for atomic quantities and price conversion", () => {
    const ledger = tempLedger();
    try {
      const usd = ledger.createAsset("USD", "currency", 2);
      const jpy = ledger.createAsset("JPY", "currency", 0);
      const checking = ledger.createAccount("Checking", "asset");
      const equity = ledger.createAccount("Equity", "equity");
      ledger.recordTransaction("2026-06-01", toAtomicUnits("1234", 0), equity, checking, jpy, "JPY seed", "posted");
      ledger.createPrice(jpy, usd, "0.01", "2026-06-01");
      expect(ledger.balance(checking, jpy)).toBe(1234n);
      expect(ledger.convertQuantity(1234n, jpy, usd, "2026-06-30")).toBe(1234n);
    } finally {
      ledger.close();
    }
  });

  it("converts decimal amounts exactly", () => {
    expect(toAtomicUnits("0.10", 2)).toBe(10n);
    expect(toAtomicUnits("0.105", 2)).toBe(11n);
    expect(toAtomicUnits("2.675", 2)).toBe(268n);
    expect(() => toAtomicUnits("NaN", 2)).toThrow(/Invalid decimal amount/);
  });

  it("reports accounting balances and current earnings correctly", () => {
    const ledger = tempLedger();
    try {
      const usd = ledger.createAsset("USD", "currency", 2);
      const checking = ledger.createAccount("Checking", "asset");
      const card = ledger.createAccount("Credit Card", "liability");
      const equity = ledger.createAccount("Owner Equity", "equity");
      const salary = ledger.createAccount("Salary", "income");
      const groceries = ledger.createAccount("Groceries", "expense");
      ledger.recordTransaction("2026-06-01", 10_000n, equity, checking, usd, "Opening", "posted");
      ledger.recordTransaction("2026-06-02", 5_000n, salary, checking, usd, "Pay", "posted");
      ledger.recordTransaction("2026-06-03", 1_200n, card, groceries, usd, "Card groceries", "posted");

      const cardBalance = ledger.accountingBalance(card, usd);
      expect(cardBalance.balance_cents).toBe(-1200n);
      expect(cardBalance.normal_balance_cents).toBe(1200n);
      expect(cardBalance.credit_cents).toBe(1200n);

      const statement = ledger.incomeStatement(2026, 6, usd);
      expect(statement.income).toBe(5000n);
      expect(statement.expense).toBe(1200n);
      expect(statement.net).toBe(3800n);

      const sheet = ledger.balanceSheet("2026-06-30", usd);
      expect(sheet.accounting_total_assets).toBe(15_000n);
      expect(sheet.accounting_total_liabilities).toBe(1_200n);
      expect(sheet.accounting_total_equity).toBe(10_000n);
      expect(sheet.accounting_current_earnings).toBe(3_800n);
      expect(sheet.accounting_equation_balanced).toBe(true);
    } finally {
      ledger.close();
    }
  });

  it("exposes balanced debit and credit totals in trial balance", () => {
    const ledger = tempLedger();
    try {
      const usd = ledger.createAsset("USD", "currency", 2);
      const checking = ledger.createAccount("Checking", "asset");
      const equity = ledger.createAccount("Owner Equity", "equity");
      ledger.recordTransaction("2026-06-01", 10000n, equity, checking, usd, "Opening", "posted");
      const trial = ledger.trialBalance(usd);
      expect(trial.total).toBe(0n);
      expect(trial.debit_total).toBe(10000n);
      expect(trial.credit_total).toBe(10000n);
      expect(trial.balanced).toBe(true);
    } finally {
      ledger.close();
    }
  });

  it("surfaces missing conversion paths in reports", () => {
    const ledger = tempLedger();
    try {
      const usd = ledger.createAsset("USD", "currency", 2);
      const jpy = ledger.createAsset("JPY", "currency", 0);
      const checking = ledger.createAccount("Checking", "asset");
      const equity = ledger.createAccount("Equity", "equity");
      ledger.recordTransaction("2026-06-01", 500n, equity, checking, jpy, "JPY seed", "posted");
      const sheet = ledger.balanceSheet("2026-06-30", usd);
      expect(sheet.valuation_complete).toBe(false);
      expect(sheet.missing_conversions.length).toBeGreaterThan(0);
    } finally {
      ledger.close();
    }
  });

  it("blocks closed periods and reopens them", () => {
    const ledger = tempLedger();
    try {
      const usd = ledger.createAsset("USD", "currency", 2);
      const checking = ledger.createAccount("Checking", "asset");
      const equity = ledger.createAccount("Equity", "equity");
      const close = ledger.closePeriod("May close", "2026-05-31");
      expect(() => ledger.recordTransaction("2026-05-15", 1000n, equity, checking, usd, "Backdated", "posted")).toThrow(/closed through 2026-05-31/);
      ledger.recordTransaction("2026-06-01", 1000n, equity, checking, usd, "Allowed", "posted");
      ledger.reopenPeriod(String(close.id));
      ledger.recordTransaction("2026-05-15", 1000n, equity, checking, usd, "Reopened", "posted");
      expect(ledger.balance(checking, usd, null, null)).toBe(2000n);
    } finally {
      ledger.close();
    }
  });

  it("rejects overflow without writing", () => {
    const ledger = tempLedger();
    try {
      const usd = ledger.createAsset("USD", "currency", 2);
      const checking = ledger.createAccount("Checking", "asset");
      const salary = ledger.createAccount("Salary", "income");
      expect(() => ledger.postTx("2026-06-01", "posted", "overflow", [[checking, usd, 2n ** 63n], [salary, usd, -(2n ** 63n)]])).toThrow(/outside SQLite integer range/);
      expect(ledger.listTransactions({ status: null })).toHaveLength(0);
      expect(ledger.getEntries("missing")).toHaveLength(0);
    } finally {
      ledger.close();
    }
  });
});

describe("app and package surface", () => {
  it("keeps every MCP tool name wired to a signature and handler", () => {
    expect(Object.keys(TOOL_SIGNATURES).sort()).toEqual([...TOOL_NAMES].sort());
    expect(TOOL_SIGNATURES.create_transaction).toBe("(date: string, amount: number, from_account_id: string, to_account_id: string, description: string, status?: string, asset_id?: string | null, branch?: string | null) => Record<string, unknown>");
    for (const name of TOOL_NAMES) expect(toolHandlers[name]).toBeTypeOf("function");
  });

  it("round-trips ledger export/import through public JSON", () => {
    const source = tempLedger();
    const target = tempLedger();
    const fresh = tempLedger();
    try {
      const init = callTool("init_defaults", { template: "personal", currency: "USD" }, source) as any;
      const accounts = callTool("list_accounts", {}, source) as any[];
      const checking = accounts.find((row) => row.name === "Checking").id;
      const equity = accounts.find((row) => row.name === "Opening Balances").id;
      const groceries = accounts.find((row) => row.name === "Groceries").id;
      const usd = (callTool("get_asset_by_symbol", { symbol: "USD" }, source) as any).id;
      callTool("create_transaction", { date: "2026-06-01", amount: 25, from_account_id: equity, to_account_id: checking, description: "Seed", status: "posted" }, source);
      callTool("create_price", { asset_id: usd, quote_id: usd, rate: "1.00", time: "2026-06-01" }, source);
      callTool("set_budget", { account: groceries, amount: 100, year: 2026, month: 6 }, source);
      callTool("set_goal", { account: checking, target: 500, name: "Emergency" }, source);
      const exported = callTool("export_ledger", {}, source) as any;
      const doc = JSON.parse(exported.data);
      const imported = callTool("import_ledger", { data: exported.data }, target) as any;
      expect(init.accounts_created).toBeGreaterThan(0);
      expect(imported.transactions).toBe(1);
      expect((callTool("integrity_check", {}, target) as any).ok).toBe(true);
      expect(target.listPrices()).toHaveLength(doc.prices.length);
      expect((target.db.prepare("SELECT quantity, period, year, month FROM targets WHERE type = 'budget'").get() as any)).toMatchObject({ quantity: 10000n, period: "monthly", year: 2026n, month: 6n });
      expect((target.db.prepare("SELECT quantity, name FROM targets WHERE type = 'goal'").get() as any)).toMatchObject({ quantity: 50000n, name: "Emergency" });

      const importedFresh = callTool("import_ledger", { data: exported.data, preserve_ids: false }, fresh) as any;
      expect(importedFresh.transactions).toBe(1);
      expect(new Set(fresh.listTransactions({ status: null }).map((tx) => tx.id))).not.toEqual(new Set(source.listTransactions({ status: null }).map((tx) => tx.id)));
    } finally {
      source.close();
      target.close();
      fresh.close();
    }
  });

  it("requires explicit setup currency and enforces account default assets", () => {
    const ledger = tempLedger();
    try {
      expect(() => callTool("init_defaults", { template: "personal" }, ledger)).toThrow(/currency or asset_id is required/);
      callTool("init_defaults", { template: "personal", currency: "CAD" }, ledger);
      const accounts = Object.fromEntries((callTool("list_accounts", {}, ledger) as any[]).map((row) => [row.name, row]));
      expect(accounts.Checking.default_asset_symbol).toBe("CAD");

      const usd = ledger.createAsset("USD", "currency", 2);
      const usdCash = callTool("create_account", { name: "USD Cash", type: "asset", default_asset_id: usd }, ledger) as any;
      expect(usdCash.default_asset_symbol).toBe("USD");
      expect(() => callTool("create_transaction", {
        date: "2026-06-01",
        amount: 1,
        from_account_id: accounts["Opening Balances"].id,
        to_account_id: usdCash.id,
        status: "posted"
      }, ledger)).toThrow(/different default_asset/);
    } finally {
      ledger.close();
    }
  });

  it("matches the app transaction and report flow", () => {
    const ledger = tempLedger();
    try {
      callTool("init_defaults", { template: "personal", currency: "USD" }, ledger);
      const accounts = Object.fromEntries((callTool("list_accounts", {}, ledger) as any[]).map((row) => [row.name, row.id]));
      const usd = (callTool("get_asset_by_symbol", { symbol: "USD" }, ledger) as any).id;
      const tx = callTool("create_transaction", {
        date: "2026-06-01",
        amount: 1000,
        from_account_id: accounts.Salary,
        to_account_id: accounts.Checking,
        description: "Paycheck",
        status: "posted"
      }, ledger) as any;

      expect(tx.amount).toBe(100000);
      expect(tx.from_account).toBe(accounts.Salary);
      expect(tx.to_account).toBe(accounts.Checking);
      expect(tx.entries.reduce((sum: number, entry: any) => sum + entry.qty_cents, 0)).toBe(0);

      const balance = callTool("get_balance", { account_id: accounts.Checking }, ledger) as any;
      expect(balance.balance_cents).toBe(100000);

      expect(() => callTool("income_statement", { year: 2026, month: 6 }, ledger)).toThrow(/quote_asset_id is required/);
      const statement = callTool("income_statement", { year: 2026, month: 6, quote_asset_id: usd }, ledger) as any;
      expect(statement.income).toBe(100000);
      expect(statement.net).toBe(100000);
    } finally {
      ledger.close();
    }
  });

  it("supports active report status and bounded transaction search", () => {
    const ledger = tempLedger();
    try {
      callTool("init_defaults", { template: "personal", currency: "USD" }, ledger);
      const accounts = Object.fromEntries((callTool("list_accounts", {}, ledger) as any[]).map((row) => [row.name, row.id]));
      const usd = (callTool("get_asset_by_symbol", { symbol: "USD" }, ledger) as any).id;
      callTool("create_transaction", { date: "2026-06-01", amount: 100, from_account_id: accounts.Salary, to_account_id: accounts.Checking, description: "Posted pay", status: "posted" }, ledger);
      callTool("create_transaction", { date: "2026-06-15", amount: 50, from_account_id: accounts.Salary, to_account_id: accounts.Checking, description: "Pending pay", status: "pending" }, ledger);

      expect((callTool("income_statement", { year: 2026, month: 6, quote_asset_id: usd }, ledger) as any).income).toBe(10000);
      expect((callTool("income_statement", { year: 2026, month: 6, include_pending: true, quote_asset_id: usd }, ledger) as any).income).toBe(15000);
      expect((callTool("income_statement", { year: 2026, month: 6, status: "active", quote_asset_id: usd }, ledger) as any).income).toBe(15000);
      expect((callTool("balance_sheet", { quote_asset_id: usd }, ledger) as any).total_assets).toBe(10000);
      expect((callTool("balance_sheet", { include_pending: true, quote_asset_id: usd }, ledger) as any).total_assets).toBe(10000);
      expect((callTool("balance_sheet", { status: "active", quote_asset_id: usd }, ledger) as any).total_assets).toBe(15000);
      expect((callTool("net_worth", { quote_asset_id: usd }, ledger) as any).net_worth).toBe(10000);
      expect((callTool("net_worth", { include_pending: true, quote_asset_id: usd }, ledger) as any).net_worth).toBe(10000);
      expect((callTool("net_worth", { status: "active", quote_asset_id: usd }, ledger) as any).net_worth).toBe(15000);
      expect((callTool("cash_flow", { year: 2026, month: 6, quote_asset_id: usd }, ledger) as any).operating_total).toBe(-10000);
      expect((callTool("cash_flow", { year: 2026, month: 6, include_pending: true, quote_asset_id: usd }, ledger) as any).operating_total).toBe(-10000);
      expect((callTool("cash_flow", { year: 2026, month: 6, status: "active", quote_asset_id: usd }, ledger) as any).operating_total).toBe(-15000);
      expect((callTool("cash_flow", { year: 2026, month: 6, quote_asset_id: usd }, ledger) as any).net_change).toBe(10000);

      const high = callTool("search_transactions", { amount_min: 7500, status: null }, ledger) as any;
      expect(high.total).toBe(1);
      expect(high.transactions[0].description).toBe("Posted pay");
      const low = callTool("search_transactions", { amount_max: 7500, status: null }, ledger) as any;
      expect(low.total).toBe(1);
      expect(low.transactions[0].description).toBe("Pending pay");
    } finally {
      ledger.close();
    }
  });

  it("rejects report and reconciliation scopes that are not implemented", () => {
    const ledger = tempLedger();
    try {
      callTool("init_defaults", { template: "personal", currency: "USD" }, ledger);
      const accounts = Object.fromEntries((callTool("list_accounts", {}, ledger) as any[]).map((row) => [row.name, row.id]));
      expect(() => callTool("income_statement", { year: 2026, month: 6, branch: "scenario" }, ledger)).toThrow(/branch/);
      expect(() => callTool("net_worth", { branch: "scenario" }, ledger)).toThrow(/branch/);
      expect(() => callTool("spending", { year: 2026, month: 6, branch: "scenario" }, ledger)).toThrow(/branch/);
      expect(() => callTool("cash_flow", { year: 2026, month: 6, branch: "scenario" }, ledger)).toThrow(/branch/);
      expect(() => callTool("account_register", { account_id: accounts.Checking, branch: "scenario" }, ledger)).toThrow(/branch/);
      expect(() => callTool("trial_balance", { branch: "scenario" }, ledger)).toThrow(/branch/);
      expect(() => callTool("project_balances", { through: "2026-06-30", branch: "scenario" }, ledger)).toThrow(/branch/);
      expect(() => callTool("reconcile_diff", { account_id: accounts.Checking, branch: "scenario" }, ledger)).toThrow(/branch/);
    } finally {
      ledger.close();
    }
  });

  it("resolves account names and preserves directed transaction return fields", () => {
    const ledger = tempLedger();
    try {
      callTool("init_defaults", { template: "personal", currency: "USD" }, ledger);
      const accounts = Object.fromEntries((callTool("list_accounts", {}, ledger) as any[]).map((row) => [row.name, row.id]));
      const usd = (callTool("get_asset_by_symbol", { symbol: "USD" }, ledger) as any).id;
      const tx = callTool("create_transaction", {
        date: "2026-06-01",
        amount: 50,
        from_account_id: "Salary",
        to_account_id: "Checking",
        description: "Named account refs",
        status: "posted"
      }, ledger) as any;

      expect(tx.from_account).toBe(accounts.Salary);
      expect(tx.to_account).toBe(accounts.Checking);
      const transfer = callTool("transfer", {
        date: "2026-06-02",
        amount: 10,
        from_account_id: "Checking",
        to_account_id: "Savings",
        description: "Move"
      }, ledger) as any;
      expect(transfer.tx).toBeTruthy();
      expect(transfer.from_account).toBe(accounts.Checking);
      expect(transfer.to_account).toBe(accounts.Savings);
    } finally {
      ledger.close();
    }
  });

  it("uses asset scales through the app surface", () => {
    const ledger = tempLedger();
    try {
      const jpy = ledger.createAsset("JPY", "currency", 0);
      const btc = ledger.createAsset("BTC", "currency", 8);
      const checking = ledger.createAccount("Checking", "asset");
      const equity = ledger.createAccount("Equity", "equity");
      const yen = callTool("create_transaction", { date: "2026-06-01", amount: 1234, from_account_id: equity, to_account_id: checking, description: "JPY opening", status: "posted", asset_id: jpy }, ledger) as any;
      const sats = callTool("create_transaction", { date: "2026-06-02", amount: "0.12345678", from_account_id: equity, to_account_id: checking, description: "BTC opening", status: "posted", asset_id: btc }, ledger) as any;

      expect(yen.amount).toBe(1234);
      expect(sats.amount).toBe(12345678);
      expect(ledger.balance(checking, jpy)).toBe(1234n);
      expect(ledger.balance(checking, btc)).toBe(12345678n);
    } finally {
      ledger.close();
    }
  });

  it("requires explicit quote assets for converted reports", () => {
    const ledger = tempLedger();
    try {
      const cad = ledger.createAsset("CAD", "currency", 2);
      const usd = ledger.createAsset("USD", "currency", 2);
      const checking = ledger.createAccount("Checking", "asset");
      const equity = ledger.createAccount("Equity", "equity");
      ledger.recordTransaction("2026-06-01", 1000n, equity, checking, cad, "CAD opening", "posted");

      expect(() => callTool("balance_sheet", {}, ledger)).toThrow(/quote_asset_id is required/);

      const usdSheet = callTool("balance_sheet", { quote_asset_id: usd }, ledger) as any;
      expect(usdSheet.quote_asset_id).toBe(usd);
      expect(usdSheet.total_assets).toBe(0);
      expect(usdSheet.valuation_complete).toBe(false);

      const cadSheet = callTool("balance_sheet", { quote_asset_id: cad }, ledger) as any;
      expect(cadSheet.quote_asset_id).toBe(cad);
      expect(cadSheet.total_assets).toBe(1000);
    } finally {
      ledger.close();
    }
  });

  it("converts non-quote assets with explicit prices through reports", () => {
    const ledger = tempLedger();
    try {
      const usd = ledger.createAsset("USD", "currency", 2);
      const jpy = ledger.createAsset("JPY", "currency", 0);
      const checking = ledger.createAccount("Checking", "asset");
      const salary = ledger.createAccount("Salary", "income");
      const food = ledger.createAccount("Food", "expense");
      ledger.recordTransaction("2026-06-01", 10000n, salary, checking, jpy, "Pay", "posted");
      ledger.recordTransaction("2026-06-02", 2500n, checking, food, jpy, "Lunch", "posted");
      callTool("create_price", { asset_id: jpy, quote_id: usd, rate: 0.01, time: "2026-06-01" }, ledger);

      const statement = callTool("income_statement", { year: 2026, month: 6, quote_asset_id: usd }, ledger) as any;
      const sheet = callTool("balance_sheet", { date: "2026-06-30", quote_asset_id: usd }, ledger) as any;
      expect(statement.income).toBe(10000);
      expect(statement.expense).toBe(2500);
      expect(statement.net).toBe(7500);
      expect(statement.valuation_complete).toBe(true);
      expect(sheet.total_assets).toBe(7500);
      expect(sheet.valuation_complete).toBe(true);
    } finally {
      ledger.close();
    }
  });

  it("covers restored MCP domains through the shared dispatcher", () => {
    const ledger = tempLedger();
    try {
      callTool("init_defaults", { template: "personal", currency: "USD" }, ledger);
      const accounts = Object.fromEntries((callTool("list_accounts", {}, ledger) as any[]).map((row) => [row.name, row.id]));
      const usd = (callTool("get_asset_by_symbol", { symbol: "USD" }, ledger) as any).id;
      const tx = callTool("create_transaction", {
        date: "2026-06-01",
        amount: 42,
        from_account_id: accounts.Checking,
        to_account_id: accounts.Groceries,
        description: "Market",
        status: "pending"
      }, ledger) as any;
      expect((callTool("commit_batch", { tx_ids: [tx.id] }, ledger) as any).committed).toBe(1);
      expect((callTool("list_transactions", { status: "posted" }, ledger) as any).total).toBe(1);

      callTool("set_budget", { account: accounts.Groceries, amount: 100, year: 2026, month: 6 }, ledger);
      const budget = callTool("budget_status", { account: accounts.Groceries, year: 2026, month: 6, quote_asset_id: usd }, ledger) as any;
      expect(budget.budgets[0].spent_cents).toBe(4200);

      const goal = callTool("set_goal", { account: accounts.Savings, target: 500, name: "Emergency" }, ledger) as any;
      expect(goal.target_cents).toBe(50000);
      expect(callTool("list_import_batches", {}, ledger)).toEqual([]);
    } finally {
      ledger.close();
    }
  });

  it("persists account metadata through shared app paths", () => {
    const ledger = tempLedger();
    try {
      const created = callTool("create_account", { name: "Checking", type: "asset", code: "1010", color_hex: "#123456" }, ledger) as any;
      expect((callTool("create_account", { name: "Checking", type: "asset" }, ledger) as any).id).toBe(created.id);
      expect(callTool("get_account", { id: created.id }, ledger)).toMatchObject({ code: "1010", color_hex: "#123456" });
      const updated = callTool("update_account", { id: created.id, type: "liability", code: "2010", color_hex: "#654321" }, ledger) as any;
      expect(callTool("get_account", { id: updated.id }, ledger)).toMatchObject({ account_type: "liability", code: "2010", color_hex: "#654321" });
      const parent = callTool("create_account", { name: "Expenses", type: "expense" }, ledger) as any;
      const child = callTool("create_account", { name: "Coffee", type: "expense", parent_id: "Expenses" }, ledger) as any;
      expect(child.parent_id).toBe(parent.id);
      const newParent = callTool("create_account", { name: "Daily Spend", type: "expense" }, ledger) as any;
      expect((callTool("update_account", { id: "Coffee", parent_id: "Daily Spend" }, ledger) as any).parent_id).toBe(newParent.id);
    } finally {
      ledger.close();
    }
  });

  it("requires an explicit database for MCP runtime opening", () => {
    const previousDb = process.env.CLOVIS_DB;
    try {
      delete process.env.CLOVIS_DB;
      expect(() => mcpDbPathFromEnv()).toThrow(/CLOVIS_DB must be set/);
    } finally {
      if (previousDb == null) delete process.env.CLOVIS_DB; else process.env.CLOVIS_DB = previousDb;
    }
  });

  it("uses the Clovis Computing default CLI database path", () => {
    expect(defaultDbPath()).toBe(join(homedir(), ".cloviscomputing", "clovis.db"));
  });

  it("rejects unsupported branch filters explicitly", () => {
    const ledger = tempLedger();
    try {
      ledger.createAsset("USD", "currency", 2);
      expect(() => callTool("balance_sheet", { branch: "scenario" }, ledger)).toThrow(/branch/);
      expect(() => callTool("compare_scenarios", { branch_a: "base", branch_b: "scenario" }, ledger)).toThrow(/branch_a, branch_b/);
    } finally {
      ledger.close();
    }
  });

  it("accepts branch tags on transaction creation without enabling branch reports", () => {
    const ledger = tempLedger();
    try {
      callTool("init_defaults", { template: "personal", currency: "USD" }, ledger);
      const accounts = Object.fromEntries((callTool("list_accounts", {}, ledger) as any[]).map((row) => [row.name, row.id]));
      const tx = callTool("plan_transaction", {
        date: "2026-06-10",
        amount: 20,
        from_account_id: "Checking",
        to_account_id: "Groceries",
        description: "Scenario groceries",
        branch: "what-if"
      }, ledger) as any;

      expect(tx.status).toBe("planned");
      expect(tx.tags).toContainEqual(expect.objectContaining({ key: "branch", value: "what-if" }));
      expect((callTool("list_branches", {}, ledger) as any[]).map((row) => row.name)).toContain("what-if");
      expect((callTool("get_balance", { account_id: accounts.Checking, status: "planned" }, ledger) as any).balance_cents).toBe(-2000);
    } finally {
      ledger.close();
    }
  });

  it("enforces statement expected balance before commit", () => {
    const ledger = tempLedger();
    try {
      const dir = mkdtempSync(join(tmpdir(), "clovis-statement-"));
      dirs.push(dir);
      const previousDb = process.env.CLOVIS_DB;
      const previousRoot = process.env.CLOVIS_MCP_ALLOWED_ROOT;
      process.env.CLOVIS_DB = join(dir, "ledger.db");
      process.env.CLOVIS_MCP_ALLOWED_ROOT = dir;
      try {
        const usd = ledger.createAsset("USD", "currency", 2);
        const checking = ledger.createAccount("Checking", "asset");
        const equity = ledger.createAccount("Equity", "equity");
        ledger.createAnnotation("account", checking, "default_asset", usd);
        ledger.createAnnotation("account", equity, "default_asset", usd);
        writeFileSync(join(dir, "statement.csv"), "date,amount,description\n2026-06-01,25.00,Deposit\n", "utf8");
        expect(() => callTool("process_statement", { file_path: "statement.csv", account_id: checking, counterpart_account_id: equity, expected_balance: 24.99, commit: true }, ledger)).toThrow(/expected_balance/);
        expect(ledger.balanceTree(checking, usd, null, null)).toBe(0n);
        const plan = callTool("apply_reconciliation_plan", { file_path: "statement.csv", account_id: checking, counterpart_account_id: equity }, ledger) as any;
        expect(plan.dry_run ?? true).toBe(true);
        expect(ledger.balanceTree(checking, usd, null, null)).toBe(0n);
        const result = callTool("process_statement", { file_path: "statement.csv", account_id: checking, counterpart_account_id: equity, expected_balance: 25.00, commit: true }, ledger) as any;
      expect(result.balance_matches).toBe(true);
      expect(result.actual_balance_cents).toBe(2500);
      expect(result.transactions[0].status).toBe("posted");
      } finally {
        if (previousDb == null) delete process.env.CLOVIS_DB; else process.env.CLOVIS_DB = previousDb;
        if (previousRoot == null) delete process.env.CLOVIS_MCP_ALLOWED_ROOT; else process.env.CLOVIS_MCP_ALLOWED_ROOT = previousRoot;
      }
    } finally {
      ledger.close();
    }
  });

  it("imports CSV row counterpart and tag columns", () => {
    const ledger = tempLedger();
    try {
      const dir = mkdtempSync(join(tmpdir(), "clovis-row-import-"));
      dirs.push(dir);
      const previousDb = process.env.CLOVIS_DB;
      const previousRoot = process.env.CLOVIS_MCP_ALLOWED_ROOT;
      process.env.CLOVIS_DB = join(dir, "ledger.db");
      process.env.CLOVIS_MCP_ALLOWED_ROOT = dir;
      try {
        const usd = ledger.createAsset("USD", "currency", 2);
        const checking = ledger.createAccount("Checking", "asset");
        const equity = ledger.createAccount("Equity", "equity");
        const dining = ledger.createAccount("Dining", "expense");
        for (const accountId of [checking, equity, dining]) ledger.createAnnotation("account", accountId, "default_asset", usd);
        writeFileSync(join(dir, "rows.csv"), "date,amount,description,counterpart,kind\n2026-06-01,-12.50,Coffee,Dining,meal\n", "utf8");

        const result = callTool("import_file", { file_path: "rows.csv", account_id: checking, counterpart_account_id: equity, counterpart_col: "counterpart", tag_cols: { kind: "kind" }, status: "posted" }, ledger) as any;
        expect(result.created).toBe(1);
        const tx = callTool("get_transaction", { id: result.transactions[0].id }, ledger) as any;
        expect(tx.entries.some((entry: any) => entry.account_id === dining)).toBe(true);
        expect(tx.tags).toContainEqual(expect.objectContaining({ key: "kind", value: "meal" }));
        expect(ledger.balance(checking, usd)).toBe(-1250n);
      } finally {
        if (previousDb == null) delete process.env.CLOVIS_DB; else process.env.CLOVIS_DB = previousDb;
        if (previousRoot == null) delete process.env.CLOVIS_MCP_ALLOWED_ROOT; else process.env.CLOVIS_MCP_ALLOWED_ROOT = previousRoot;
      }
    } finally {
      ledger.close();
    }
  });

  it("stores import batch provenance on journal source_id", () => {
    const ledger = tempLedger();
    try {
      const usd = ledger.createAsset("USD", "currency", 2);
      const checking = ledger.createAccount("Checking", "asset");
      const equity = ledger.createAccount("Equity", "equity");
      const result = callTool("import_transactions", {
        account_id: checking,
        counterpart_id: equity,
        asset_id: usd,
        batch_label: "June statement",
        transactions: [{ date: "2026-06-01", amount: 25, description: "Deposit" }]
      }, ledger) as any;
      expect(result.batch_id).toEqual(expect.stringMatching(/^batch_/));
      expect(ledger.getTx(result.transactions[0].id)?.source_id).toBe(result.batch_id);
      expect(callTool("list_import_batches", {}, ledger)).toContainEqual(expect.objectContaining({ id: result.batch_id, tx_count: 1 }));
    } finally {
      ledger.close();
    }
  });

  it("records security purchases as balanced multi-asset journals", () => {
    const ledger = tempLedger();
    try {
      callTool("init_defaults", { template: "personal", currency: "USD" }, ledger);
      const accounts = Object.fromEntries((callTool("list_accounts", {}, ledger) as any[]).map((row) => [row.name, row.id]));
      const usd = (callTool("get_asset_by_symbol", { symbol: "USD" }, ledger) as any).id;
      const tx = callTool("buy_security", { account_id: accounts.Checking, symbol: "AAPL", shares: "1.5", total_cost_cents: 12345, commission_cents: 55, date: "2026-06-01" }, ledger) as any;
      const sums = new Map<string, number>();
      for (const entry of tx.entries) sums.set(entry.asset_id, (sums.get(entry.asset_id) ?? 0) + entry.quantity);
      expect([...sums.values()]).toEqual([0, 0]);
      expect(ledger.balance(accounts.Checking, usd)).toBe(-12400n);

      const holdings = callTool("holdings", { asset_type: "security" }, ledger) as any[];
      expect(holdings).toContainEqual(expect.objectContaining({ account_name: "AAPL Holdings", asset_symbol: "AAPL", quantity: 150000000 }));
      const lot = ledger.db.prepare("SELECT quantity, cost_quantity FROM lots").get() as any;
      expect(lot).toMatchObject({ quantity: 150000000n, cost_quantity: 12400n });
    } finally {
      ledger.close();
    }
  });

  it("rolls back security purchase journals when lot recording fails", () => {
    const ledger = tempLedger();
    try {
      callTool("init_defaults", { template: "personal", currency: "USD" }, ledger);
      const accounts = Object.fromEntries((callTool("list_accounts", {}, ledger) as any[]).map((row) => [row.name, row.id]));
      (ledger as unknown as { db: { exec(sql: string): void } }).db.exec("CREATE TRIGGER fail_lots BEFORE INSERT ON lots BEGIN SELECT RAISE(ABORT, 'lot failure'); END;");
      expect(() => callTool("buy_security", { account_id: accounts.Checking, symbol: "AAPL", shares: "1.5", total_cost_cents: 12345, date: "2026-06-01" }, ledger)).toThrow(/lot failure/);
      expect(ledger.listTransactions({ status: null })).toHaveLength(0);
      expect(ledger.getAssetBySymbol("AAPL")).toBeNull();
      expect(ledger.listAccounts().map((account) => account.name)).not.toContain("AAPL Holdings");
      expect(ledger.listLots()).toHaveLength(0);
    } finally {
      ledger.close();
    }
  });

  it("blocks MCP file escapes and overwrites", () => {
    const ledger = tempLedger();
    try {
      const dir = mkdtempSync(join(tmpdir(), "clovis-files-"));
      dirs.push(dir);
      const previousDb = process.env.CLOVIS_DB;
      const previousRoot = process.env.CLOVIS_MCP_ALLOWED_ROOT;
      process.env.CLOVIS_DB = join(dir, "ledger.db");
      process.env.CLOVIS_MCP_ALLOWED_ROOT = dir;
      try {
        callTool("init_defaults", { template: "personal", currency: "USD" }, ledger);
        const result = callTool("export_ledger", { output_path: "snapshot.json" }, ledger) as any;
        expect(String(result.file).endsWith("snapshot.json")).toBe(true);
        expect(String(result.file)).not.toContain(dir);
        expect(() => callTool("export_ledger", { output_path: "snapshot.json" }, ledger)).toThrow(/already exists/);
        expect(() => callTool("export_ledger", { output_path: "../outside.json" }, ledger)).toThrow(/escapes/);
        const outside = mkdtempSync(join(tmpdir(), "clovis-outside-"));
        dirs.push(outside);
        writeFileSync(join(outside, "statement.csv"), "date,amount,description\n2026-06-01,1.00,Escape\n", "utf8");
        symlinkSync(join(outside, "statement.csv"), join(dir, "statement-link.csv"));
        symlinkSync(outside, join(dir, "outside-link"));
        expect(() => callTool("import_file", { file_path: "statement-link.csv", account_id: "Checking", counterpart_account_id: "Opening Balances" }, ledger)).toThrow(/escapes/);
        expect(() => callTool("export_ledger", { output_path: "outside-link/snapshot.json" }, ledger)).toThrow(/escapes/);
      } finally {
        if (previousDb == null) delete process.env.CLOVIS_DB; else process.env.CLOVIS_DB = previousDb;
        if (previousRoot == null) delete process.env.CLOVIS_MCP_ALLOWED_ROOT; else process.env.CLOVIS_MCP_ALLOWED_ROOT = previousRoot;
      }
    } finally {
      ledger.close();
    }
  });

  it("requires explicit MCP capabilities for filesystem and destructive tools", () => {
    const dir = mkdtempSync(join(tmpdir(), "clovis-mcp-cap-"));
    dirs.push(dir);
    const previousDb = process.env.CLOVIS_DB;
    const previousRoot = process.env.CLOVIS_MCP_ALLOWED_ROOT;
    const previousCaps = process.env.CLOVIS_MCP_CAPABILITIES;
    process.env.CLOVIS_DB = join(dir, "ledger.db");
    process.env.CLOVIS_MCP_ALLOWED_ROOT = dir;
    try {
      delete process.env.CLOVIS_MCP_CAPABILITIES;
      expect(() => callTool("backup_now", {})).toThrow(/filesystem/);
      expect(() => callTool("delete_account", { id: "missing" })).toThrow(/destructive/);
      process.env.CLOVIS_MCP_CAPABILITIES = "filesystem";
      const backup = callTool("backup_now", {}) as any;
      expect(String(backup.path)).toContain("backups");
      expect(String(backup.path)).not.toContain(dir);
      expect(() => callTool("delete_account", { id: "missing" })).toThrow(/destructive/);
    } finally {
      if (previousDb == null) delete process.env.CLOVIS_DB; else process.env.CLOVIS_DB = previousDb;
      if (previousRoot == null) delete process.env.CLOVIS_MCP_ALLOWED_ROOT; else process.env.CLOVIS_MCP_ALLOWED_ROOT = previousRoot;
      if (previousCaps == null) delete process.env.CLOVIS_MCP_CAPABILITIES; else process.env.CLOVIS_MCP_CAPABILITIES = previousCaps;
    }
  });

  it("honors dry-run defaults on mutating MCP tools", () => {
    const ledger = tempLedger();
    try {
      callTool("init_defaults", { template: "personal", currency: "USD" }, ledger);
      const accounts = Object.fromEntries((callTool("list_accounts", {}, ledger) as any[]).map((row) => [row.name, row.id]));
      const usd = (callTool("get_asset_by_symbol", { symbol: "USD" }, ledger) as any).id;
      const eur = ledger.createAsset("EUR", "currency", 2);
      const market = callTool("create_transaction", { date: "2026-06-01", amount: 10, from_account_id: "Checking", to_account_id: "Uncategorized", description: "Market", status: "posted" }, ledger) as any;

      const dryRecat = callTool("recategorize_by_pattern", { pattern: "Market", new_account_id: accounts.Groceries, status: "posted" }, ledger) as any;
      expect(dryRecat).toMatchObject({ matched: 1, updated: 0, dry_run: true });
      expect((callTool("get_transaction", { id: market.id }, ledger) as any).entries.some((entry: any) => entry.account_id === accounts.Uncategorized)).toBe(true);

      const realRecat = callTool("recategorize_by_pattern", { pattern: "Market", new_account_id: accounts.Groceries, status: "posted", dry_run: false }, ledger) as any;
      expect(realRecat).toMatchObject({ matched: 1, updated: 1, dry_run: false });
      expect((callTool("get_transaction", { id: market.id }, ledger) as any).entries.some((entry: any) => entry.account_id === accounts.Groceries)).toBe(true);

      const dryMigrate = callTool("migrate_asset_entries", { from_asset_id: usd, to_asset_id: eur }, ledger) as any;
      expect(dryMigrate).toMatchObject({ updated: 0, dry_run: true });
      expect(ledger.getEntries(market.id).some((entry) => entry.asset_id === usd)).toBe(true);

      const tagDry = callTool("delete_tags", { entity_type: "tx", entity_id: market.id, key: "recategorize_batch" }, ledger) as any;
      expect(tagDry).toMatchObject({ matched: 1, deleted: 0, dry_run: true });
      expect((callTool("list_tags", { entity_type: "tx", entity_id: market.id }, ledger) as any[]).some((tag) => tag.key === "recategorize_batch")).toBe(true);
      const tagDeleted = callTool("delete_tags", { entity_type: "tx", entity_id: market.id, key: "recategorize_batch", dry_run: false }, ledger) as any;
      expect(tagDeleted).toMatchObject({ matched: 1, deleted: 1, dry_run: false });

      const dryVoid = callTool("void_by_filter", { status: "posted", desc: "Market" }, ledger) as any;
      expect(dryVoid).toMatchObject({ matched: 1, voided: 0, dry_run: true });
      expect((callTool("get_transaction", { id: market.id }, ledger) as any).status).toBe("posted");
      const realVoid = callTool("void_by_filter", { status: "posted", desc: "Market", dry_run: false }, ledger) as any;
      expect(realVoid).toMatchObject({ matched: 1, voided: 1, dry_run: false });
      expect((callTool("get_transaction", { id: market.id }, ledger) as any).status).toBe("void");
    } finally {
      ledger.close();
    }
  });

  it("matches the CLI JSON envelope on built output", () => {
    const dir = mkdtempSync(join(tmpdir(), "clovis-cli-"));
    dirs.push(dir);
    const db = join(dir, "ledger.db");
    const init = JSON.parse(execFileSync(process.execPath, ["dist/cli/main.js", "--db", db, "--format", "json", "init", "--currency", "USD"], { cwd: process.cwd(), encoding: "utf8" }));
    expect(init.ok).toBe(true);
    const accounts = JSON.parse(execFileSync(process.execPath, ["dist/cli/main.js", "--db", db, "--format", "json", "account", "list"], { cwd: process.cwd(), encoding: "utf8" }));
    expect(accounts.ok).toBe(true);
    expect(accounts.count).toBe(12);
    expect(accounts.data.some((row: any) => row.name === "Checking")).toBe(true);
  });

  it("matches the CLI transaction and report flow on built output", () => {
    const dir = mkdtempSync(join(tmpdir(), "clovis-cli-flow-"));
    dirs.push(dir);
    const db = join(dir, "ledger.db");
    const run = (...args: string[]) => JSON.parse(execFileSync(process.execPath, ["dist/cli/main.js", "--db", db, "--format", "json", ...args], { cwd: process.cwd(), encoding: "utf8" }));
    run("init", "--currency", "USD");
    const accounts = run("account", "list").data;
    const accountId = (name: string) => accounts.find((row: any) => row.name === name).id;
    const checking = accountId("Checking");
    const paycheck = run("txn", "add", "--date", "2026-06-01", "--amount", "3000", "--desc", "June paycheck", "--from", accountId("Salary"), "--to", checking, "--status", "posted");
    expect(paycheck.data.amount).toBe(300000);
    run("txn", "add", "--date", "2026-06-03", "--amount", "120", "--desc", "Groceries", "--from", checking, "--to", accountId("Groceries"), "--status", "posted");

    const statement = run("report", "income-statement", "--year", "2026", "--month", "6", "--quote", "USD");
    expect(statement.data.income).toBe(300000);
    expect(statement.data.expense).toBe(12000);
    expect(statement.data.net).toBe(288000);
    expect(run("balance", checking).data.balance).toBe(288000);
  });

  it("posts opening balances through the CLI", () => {
    const dir = mkdtempSync(join(tmpdir(), "clovis-cli-opening-"));
    dirs.push(dir);
    const db = join(dir, "ledger.db");
    const run = (...args: string[]) => JSON.parse(execFileSync(process.execPath, ["dist/cli/main.js", "--db", db, "--format", "json", ...args], { cwd: process.cwd(), encoding: "utf8" }));
    run("init", "--currency", "USD");
    const accounts = run("account", "list").data;
    const checking = accounts.find((row: any) => row.name === "Checking").id;
    const result = run("txn", "opening-balance", "--account", checking, "--amount", "125", "--date", "2026-05-31", "--status", "posted");
    expect(result.data.amount).toBe(12500);
    expect(run("balance", checking).data.balance).toBe(12500);
  });

  it("validates ledger imports before writing", () => {
    const source = tempLedger();
    try {
      callTool("init_defaults", { template: "personal", currency: "USD" }, source);
      const accounts = callTool("list_accounts", {}, source) as any[];
      const checking = accounts.find((row) => row.name === "Checking").id;
      const equity = accounts.find((row) => row.name === "Opening Balances").id;
      callTool("create_asset", { symbol: "EUR", asset_type: "currency", decimals: 2 }, source);
      callTool("create_transaction", { date: "2026-06-01", amount: 25, from_account_id: equity, to_account_id: checking, description: "Seed", status: "posted" }, source);
      const exported = callTool("export_ledger", {}, source) as any;
      const baseDoc = JSON.parse(exported.data);
      const cases: Array<[string, (doc: any) => void, RegExp]> = [
        ["invalid asset type", (doc) => { doc.assets[0].type = "fiat"; }, /Invalid asset type/],
        ["invalid account type", (doc) => { doc.accounts[0].type = "cash"; }, /Invalid account type/],
        ["duplicate id", (doc) => { doc.assets[1].id = doc.assets[0].id; }, /duplicates/],
        ["bad date", (doc) => { doc.transactions[0].date = "2026-99-99"; }, /date/],
        ["missing foreign key", (doc) => { doc.transactions[0].entries[0].account_id = "acct_missing"; }, /unknown account/]
      ];

      for (const [, mutate, message] of cases) {
        const target = tempLedger();
        try {
          const doc = JSON.parse(JSON.stringify(baseDoc));
          mutate(doc);
          const dryRun = callTool("import_ledger", { data: JSON.stringify(doc), dry_run: true }, target) as any;
          expect(dryRun.valid).toBe(false);
          expect(dryRun.errors.join("\n")).toMatch(message);
          expect(() => callTool("import_ledger", { data: JSON.stringify(doc) }, target)).toThrow(/Ledger import validation failed/);
          expect(callTool("list_transactions", { status: null }, target)).toMatchObject({ transactions: [] });
        } finally {
          target.close();
        }
      }
    } finally {
      source.close();
    }
  });

  it("does not create empty import batches when all rows fail", () => {
    const ledger = tempLedger();
    try {
      callTool("init_defaults", { template: "personal", currency: "USD" }, ledger);
      const accounts = callTool("list_accounts", {}, ledger) as any[];
      const checking = accounts.find((row) => row.name === "Checking").id;
      const equity = accounts.find((row) => row.name === "Opening Balances").id;
      callTool("close_period", { name: "Closed May", as_of: "2026-05-31" }, ledger);
      const result = callTool("import_transactions", {
        account_id: checking,
        counterpart_id: equity,
        transactions: [{ date: "2026-05-15", amount: 10, description: "Closed import" }],
        batch_label: "Should not persist"
      }, ledger) as any;
      expect(result.created).toBe(0);
      expect(result.batch_id).toBeNull();
      expect(result.errors).toHaveLength(1);
      expect(callTool("list_import_batches", {}, ledger)).toEqual([]);
    } finally {
      ledger.close();
    }
  });

  it("rejects complex recategorization regex patterns", () => {
    const ledger = tempLedger();
    try {
      callTool("init_defaults", { template: "personal", currency: "USD" }, ledger);
      const accounts = callTool("list_accounts", {}, ledger) as any[];
      const checking = accounts.find((row) => row.name === "Checking").id;
      const uncategorized = accounts.find((row) => row.name === "Uncategorized").id;
      callTool("create_transaction", { date: "2026-06-01", amount: 10, from_account_id: checking, to_account_id: uncategorized, description: "a".repeat(1000), status: "posted" }, ledger);
      const started = Date.now();
      expect(() => callTool("recategorize_by_pattern", { pattern: "^(a+)+$", new_account_id: uncategorized, dry_run: true }, ledger)).toThrow(/too complex/);
      expect(Date.now() - started).toBeLessThan(100);
    } finally {
      ledger.close();
    }
  });

  it("applies MCP input bounds from tool definitions", () => {
    const listTransactions = inputShapeFromDefinition(TOOL_DEFINITIONS.list_transactions);
    expect(() => listTransactions.limit.parse(-1)).toThrow();
    expect(() => listTransactions.limit.parse(1001)).toThrow();
    expect(listTransactions.limit.parse(50)).toBe(50);

    const spending = inputShapeFromDefinition(TOOL_DEFINITIONS.spending);
    expect(() => spending.month.parse(99)).toThrow();
    expect(spending.month.parse(12)).toBe(12);

    const createTransaction = inputShapeFromDefinition(TOOL_DEFINITIONS.create_transaction);
    expect(() => createTransaction.date.parse("today")).toThrow();
    expect(createTransaction.date.parse("2026-06-01")).toBe("2026-06-01");
  });
});
