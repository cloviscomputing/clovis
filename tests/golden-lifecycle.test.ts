import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { callTool } from "../src/app/index.js";
import { Ledger } from "../src/core/index.js";

type Row = Record<string, any>;

type GoldenContext = {
  dir: string;
  db: string;
  ledger: Ledger;
  assets: { cad: string };
  accounts: Record<string, string>;
};

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createGoldenContext(): GoldenContext {
  const dir = mkdtempSync(join(tmpdir(), "clovis-golden-"));
  dirs.push(dir);
  const db = join(dir, "ledger.db");
  const ledger = new Ledger(db);
  const cad = ledger.createAsset("CAD", "currency", 2, "Canadian Dollar");
  const expenses = ledger.createAccount("Expenses", "expense");
  const accounts = {
    Cash: ledger.createAccount("Cash", "asset"),
    Chequing: ledger.createAccount("RBC Chequing 1204", "asset"),
    Savings: ledger.createAccount("RBC Savings 1212", "asset"),
    Visa: ledger.createAccount("RBC Avion Visa 5870", "liability"),
    Investments: ledger.createAccount("RBC Direct Investing 8219", "asset"),
    Equity: ledger.createAccount("Opening Balances", "equity"),
    Internal: ledger.createAccount("Internal Transfers", "equity"),
    Salary: ledger.createAccount("Salary", "income"),
    Expenses: expenses,
    Groceries: ledger.createAccount("Groceries", "expense", expenses),
    Dining: ledger.createAccount("Dining Out", "expense", expenses),
    Shopping: ledger.createAccount("Shopping", "expense", expenses),
    Insurance: ledger.createAccount("Insurance", "expense", expenses),
    Uncategorized: ledger.createAccount("Uncategorized", "expense", expenses)
  };
  for (const accountId of Object.values(accounts)) ledger.updateAccount(accountId, { default_asset_id: cad });
  return { dir, db, ledger, assets: { cad }, accounts };
}

function qfx(path: string, rows: Array<{ date: string; amount: string; id: string; name: string; type?: string }>, balance: string, balanceDate = "2026-06-30"): string {
  const dateValue = (date: string): string => date.replaceAll("-", "") + "120000[-5:EST]";
  const body = rows.map((row) => [
    "<STMTTRN>",
    `<TRNTYPE>${row.type ?? (row.amount.startsWith("-") ? "DEBIT" : "CREDIT")}`,
    `<DTPOSTED>${dateValue(row.date)}`,
    `<TRNAMT>${row.amount}`,
    `<FITID>${row.id}`,
    `<NAME>${row.name}`,
    "</STMTTRN>"
  ].join("\n")).join("\n");
  const text = [
    "OFXHEADER:100",
    "DATA:OFXSGML",
    "<OFX>",
    "<BANKTRANLIST>",
    body,
    "</BANKTRANLIST>",
    "<LEDGERBAL>",
    `<BALAMT>${balance}`,
    `<DTASOF>${dateValue(balanceDate)}`,
    "</LEDGERBAL>",
    "</OFX>"
  ].join("\n");
  writeFileSync(path, text, "utf8");
  return path;
}

function activeJuneSnapshot(ctx: GoldenContext): Row {
  const { ledger, accounts, assets } = ctx;
  const statuses = ["posted", "pending", "void", "planned"];
  const counts = Object.fromEntries(statuses.map((status) => [status, ledger.listTransactions({ status: status as any, dateFrom: "2026-06-01", dateTo: "2026-06-30" }).length]));
  const balance = (accountId: string, status: string | null): number => Number(ledger.balanceTree(accountId, assets.cad, null, status as any));
  return {
    counts,
    balances: {
      chequing_posted: balance(accounts.Chequing, "posted"),
      savings_posted: balance(accounts.Savings, "posted"),
      visa_posted: balance(accounts.Visa, "posted"),
      visa_pending: balance(accounts.Visa, "pending"),
      visa_current: balance(accounts.Visa, "active"),
      cash_posted: balance(accounts.Cash, "posted"),
      investments_posted: balance(accounts.Investments, "posted")
    }
  };
}

function expectSnapshot(actual: Row, expected: Row): void {
  expect(actual.counts).toEqual(expected.counts);
  expect(actual.balances).toEqual(expected.balances);
}

function expectIntegrity(ledger: Ledger): void {
  expect(callTool("integrity_check", {}, ledger)).toMatchObject({ ok: true, healthy: true });
}

function seedLifecycleLedger(ctx: GoldenContext): void {
  const { ledger, accounts, assets } = ctx;
  ledger.recordTransaction("2026-06-01", 100000n, accounts.Equity, accounts.Chequing, assets.cad, "Opening cash", "posted", { externalId: "seed-cheq" });
  ledger.recordTransaction("2026-06-02", 25000n, accounts.Chequing, accounts.Groceries, assets.cad, "Market Groceries", "posted", { externalId: "cheq-market" });
  ledger.recordTransaction("2026-06-03", 50000n, accounts.Equity, accounts.Chequing, assets.cad, "Payroll", "posted", { externalId: "cheq-payroll" });
  ledger.recordTransaction("2026-06-04", 2850000n, accounts.Equity, accounts.Savings, assets.cad, "Savings balance", "posted", { externalId: "sav-open" });
  ledger.recordTransaction("2026-06-05", 142890n, accounts.Visa, accounts.Shopping, assets.cad, "Statement purchases", "posted", { externalId: "visa-posted" });
  ledger.recordTransaction("2026-06-06", 36800n, accounts.Chequing, accounts.Investments, assets.cad, "TFSA contribution", "posted");
  ledger.recordTransaction("2026-06-07", 5500n, accounts.Visa, accounts.Dining, assets.cad, "Pending cafe", "pending");
  ledger.recordTransaction("2026-06-08", 154116n, accounts.Internal, accounts.Visa, assets.cad, "Pending Visa payment", "pending");
  ledger.recordTransaction("2026-06-20", 120000n, accounts.Chequing, accounts.Uncategorized, assets.cad, "Planned rent", "planned");
}

function seedReimportLedger(ctx: GoldenContext): void {
  const { ledger, accounts, assets } = ctx;
  ledger.recordTransaction("2026-06-01", 100000n, accounts.Equity, accounts.Chequing, assets.cad, "Opening cash", "posted", { externalId: "cheq-open" });
  ledger.recordTransaction("2026-06-02", 25000n, accounts.Chequing, accounts.Groceries, assets.cad, "Market Groceries", "posted", { externalId: "cheq-market" });
  ledger.recordTransaction("2026-06-03", 50000n, accounts.Equity, accounts.Chequing, assets.cad, "Payroll", "posted", { externalId: "cheq-payroll" });
  ledger.recordTransaction("2026-06-04", 2850000n, accounts.Equity, accounts.Savings, assets.cad, "Savings balance", "posted", { externalId: "sav-open" });
  ledger.recordTransaction("2026-06-05", 25995n, accounts.Visa, accounts.Shopping, assets.cad, "CLEARLY ECOMM", "posted", { externalId: "visa-clearly" });
  ledger.recordTransaction("2026-06-06", 1129n, accounts.Visa, accounts.Shopping, assets.cad, "Amazon.ca Prime Member", "posted", { externalId: "visa-prime" });
  ledger.recordTransaction("2026-06-07", 154116n, accounts.Internal, accounts.Visa, assets.cad, "PAYMENT", "posted", { externalId: "visa-payment" });
}

function statementPaths(ctx: GoldenContext): Row {
  return {
    chequing: qfx(join(ctx.dir, "chequing.qfx"), [
      { date: "2026-06-01", amount: "1000.00", id: "cheq-open", name: "Opening cash" },
      { date: "2026-06-02", amount: "-250.00", id: "cheq-market", name: "Market Groceries" },
      { date: "2026-06-03", amount: "500.00", id: "cheq-payroll", name: "Payroll" }
    ], "1250.00", "2026-06-03"),
    savings: qfx(join(ctx.dir, "savings.qfx"), [
      { date: "2026-06-04", amount: "28500.00", id: "sav-open", name: "Savings balance" }
    ], "28500.00", "2026-06-04"),
    visa: qfx(join(ctx.dir, "visa.qfx"), [
      { date: "2026-06-05", amount: "-259.95", id: "visa-clearly", name: "CLEARLY ECOMM" },
      { date: "2026-06-06", amount: "-11.29", id: "visa-prime", name: "Amazon.ca Prime Member" },
      { date: "2026-06-07", amount: "143.16", id: "visa-payment", name: "PAYMENT", type: "CREDIT" }
    ], "128.08", "2026-06-07")
  };
}

function stageAndApplyStatement(ctx: GoldenContext, args: Row): Row {
  const plan = callTool("refresh_statement", { action: "plan", dry_run: false, sample_limit: 100, ...args }, ctx.ledger) as Row;
  const preview = callTool("refresh_statement", { action: "apply", plan_id: plan.plan_id, sample_limit: 100 }, ctx.ledger) as Row;
  expect(preview.dry_run).toBe(true);
  const applied = callTool("refresh_statement", { action: "apply", plan_id: plan.plan_id, dry_run: false, sample_limit: 100 }, ctx.ledger) as Row;
  expect(callTool("refresh_statement", { action: "verify", plan_id: plan.plan_id }, ctx.ledger)).toMatchObject({ verified: true, mismatches: [] });
  return { plan, applied };
}

describe("golden lifecycle", () => {
  it("soft-deletes June, reverses exactly, deletes again, and reimports generated QFX statements", () => {
    const ctx = createGoldenContext();
    try {
      seedLifecycleLedger(ctx);
      const original = activeJuneSnapshot(ctx);

      const deleted = callTool("void_by_filter", { date_from: "2026-06-01", date_to: "2026-06-30", status: "active", dry_run: false }, ctx.ledger) as Row;
      expect(deleted).toMatchObject({ matched: 8, voided: 8, dry_run: false });
      expect(activeJuneSnapshot(ctx).counts).toMatchObject({ posted: 0, pending: 0, planned: 1, void: 8 });

      const reversed = callTool("reverse_ledger_operation", { operation_id: deleted.operation_id, dry_run: false, date: "2026-06-14" }, ctx.ledger) as Row;
      expect(reversed.reversal_strategy).toBe("generic_ledger_operation_in_place");
      expectSnapshot(activeJuneSnapshot(ctx), original);

      const deletedAgain = callTool("void_by_filter", { date_from: "2026-06-01", date_to: "2026-06-30", status: "active", dry_run: false }, ctx.ledger) as Row;
      expect(deletedAgain).toMatchObject({ matched: 8, voided: 8, dry_run: false });
      expect(activeJuneSnapshot(ctx).counts).toMatchObject({ posted: 0, pending: 0, planned: 1, void: 8 });

      const paths = statementPaths(ctx);
      stageAndApplyStatement(ctx, { file_path: paths.chequing, account_id: ctx.accounts.Chequing, counterpart_account_id: ctx.accounts.Uncategorized, expected_balance: 1250 });
      stageAndApplyStatement(ctx, { file_path: paths.savings, account_id: ctx.accounts.Savings, counterpart_account_id: ctx.accounts.Uncategorized, expected_balance: 28500 });
      stageAndApplyStatement(ctx, { file_path: paths.visa, account_id: ctx.accounts.Visa, counterpart_account_id: ctx.accounts.Shopping, expected_balance: 128.08, statement_type: "credit_card" });

      expectSnapshot(activeJuneSnapshot(ctx), {
        counts: { posted: 7, pending: 0, void: 8, planned: 1 },
        balances: {
          chequing_posted: 125000,
          savings_posted: 2850000,
          visa_posted: -12808,
          visa_pending: 0,
          visa_current: -12808,
          cash_posted: 0,
          investments_posted: 0
        }
      });
      expectIntegrity(ctx.ledger);
    } finally {
      ctx.ledger.close();
    }
  });

  it("blocks unsafe hard delete before mutation and reports blockers", () => {
    const ctx = createGoldenContext();
    try {
      const paths = statementPaths(ctx);
      const { plan } = stageAndApplyStatement(ctx, { file_path: paths.visa, account_id: ctx.accounts.Visa, counterpart_account_id: ctx.accounts.Shopping, expected_balance: 128.08, statement_type: "credit_card" });
      const before = activeJuneSnapshot(ctx);

      const dryRun = callTool("void_by_filter", { date_from: "2026-06-01", date_to: "2026-06-30", status: "active", hard_delete: true, dry_run: true }, ctx.ledger) as Row;
      expect(dryRun).toMatchObject({ mode: "hard_delete", hard_delete_safe: false, dry_run: true });
      expect(dryRun.blockers.some((row: Row) => row.table === "statement_plan_rows")).toBe(true);
      expect(dryRun.tx_ids.length).toBeGreaterThan(0);

      expect(() => callTool("void_by_filter", { date_from: "2026-06-01", date_to: "2026-06-30", status: "active", hard_delete: true, dry_run: false }, ctx.ledger)).toThrow(/Hard delete blocked/);
      expectSnapshot(activeJuneSnapshot(ctx), before);
      expect(callTool("refresh_statement", { action: "verify", plan_id: plan.plan_id }, ctx.ledger)).toMatchObject({ verified: true, mismatches: [] });
      expectIntegrity(ctx.ledger);
    } finally {
      ctx.ledger.close();
    }
  });

  it("normalizes credit-card QFX balances and applies payments versus purchases correctly", () => {
    const ctx = createGoldenContext();
    try {
      const paths = statementPaths(ctx);
      const preview = callTool("preview_import", { file_path: paths.visa, account_id: ctx.accounts.Visa, counterpart_account_id: ctx.accounts.Shopping, rows: 10 }, ctx.ledger) as Row;
      expect(preview).toMatchObject({ statement_balance_cents: 12808, statement_balance_ledger_cents: -12808, balance_source: "qfx_ledger_balance" });

      const plan = callTool("refresh_statement", {
        action: "plan",
        file_path: paths.visa,
        account_id: ctx.accounts.Visa,
        counterpart_account_id: ctx.accounts.Shopping,
        expected_balance: 128.08,
        statement_type: "credit_card",
        dry_run: false,
        sample_limit: 100
      }, ctx.ledger) as Row;
      expect(plan).toMatchObject({ balance_matches: true, expected_balance_cents: -12808, planned_balance_cents: -12808, balance_sign: "user_facing_liability" });
      expect(plan.actions).toMatchObject({ new_posted: 3, ambiguous: 0 });

      const applied = callTool("refresh_statement", { action: "apply", plan_id: plan.plan_id, dry_run: false }, ctx.ledger) as Row;
      expect(applied).toMatchObject({ created: 3, balance_matches: true, actual_balance_cents: -12808 });
      expect(ctx.ledger.balanceTree(ctx.accounts.Visa, ctx.assets.cad, null, "posted")).toBe(-12808n);
      expectIntegrity(ctx.ledger);
    } finally {
      ctx.ledger.close();
    }
  });

  it("commits matched pending rows, voids stale pending rows, and posts true new rows", () => {
    const ctx = createGoldenContext();
    try {
      const { ledger, accounts, assets } = ctx;
      ledger.recordTransaction("2026-06-01", 20000n, accounts.Visa, accounts.Shopping, assets.cad, "Existing posted", "posted", { externalId: "card-existing" });
      const matched = ledger.recordTransaction("2026-06-02", 5500n, accounts.Visa, accounts.Dining, assets.cad, "Pending cafe", "pending");
      const stale = ledger.recordTransaction("2026-06-03", 3333n, accounts.Visa, accounts.Shopping, assets.cad, "Stale pending", "pending");
      const file = qfx(join(ctx.dir, "pending-refresh.qfx"), [
        { date: "2026-06-01", amount: "-200.00", id: "card-existing", name: "Existing posted" },
        { date: "2026-06-02", amount: "-55.00", id: "card-pending-cafe", name: "Pending cafe" },
        { date: "2026-06-04", amount: "-25.00", id: "card-new", name: "New charge" }
      ], "280.00", "2026-06-04");

      const plan = callTool("refresh_statement", {
        action: "plan",
        file_path: file,
        account_id: accounts.Visa,
        counterpart_account_id: accounts.Shopping,
        expected_balance: 280,
        statement_type: "credit_card",
        void_stale_pending: true,
        dry_run: false,
        sample_limit: 100
      }, ledger) as Row;
      expect(plan.actions).toMatchObject({ matched: 1, pending_to_commit: 1, new_posted: 1, stale_pending_to_void: 1, ambiguous: 0 });

      const applied = callTool("refresh_statement", { action: "apply", plan_id: plan.plan_id, dry_run: false, sample_limit: 100 }, ledger) as Row;
      expect(applied).toMatchObject({ created: 1, committed: 1, voided: 1, actual_balance_cents: -28000 });
      expect(ledger.getTx(matched.id)?.status).toBe("posted");
      expect(ledger.getTx(stale.id)?.status).toBe("void");
      expect(ledger.balanceTree(accounts.Visa, assets.cad, null, "posted")).toBe(-28000n);
      expect(ledger.balanceTree(accounts.Visa, assets.cad, null, "pending")).toBe(0n);
      expectIntegrity(ledger);
    } finally {
      ctx.ledger.close();
    }
  });

  it("surfaces ambiguous statement matches and refuses unsafe apply without mutation", () => {
    const ctx = createGoldenContext();
    try {
      const { ledger, accounts, assets } = ctx;
      ledger.recordTransaction("2026-06-10", 2399n, accounts.Visa, accounts.Shopping, assets.cad, "Uber Holdings Canada Inc.", "posted");
      ledger.recordTransaction("2026-06-11", 2399n, accounts.Visa, accounts.Shopping, assets.cad, "Uber Holdings Canada Inc.", "posted");
      const file = qfx(join(ctx.dir, "ambiguous.qfx"), [
        { date: "2026-06-10", amount: "-23.99", id: "ambiguous-uber", name: "Uber Holdings Canada Inc." }
      ], "47.98", "2026-06-11");
      const before = activeJuneSnapshot(ctx);

      const plan = callTool("refresh_statement", {
        action: "plan",
        file_path: file,
        account_id: accounts.Visa,
        counterpart_account_id: accounts.Shopping,
        statement_type: "credit_card",
        dry_run: false,
        include_details: true,
        sample_limit: 100
      }, ledger) as Row;
      expect(plan.actions).toMatchObject({ ambiguous: 1 });
      const ambiguous = plan.rows.find((row: Row) => row.action === "ambiguous");
      expect(ambiguous.metadata.candidates).toHaveLength(2);

      expect(() => callTool("refresh_statement", { action: "apply", plan_id: plan.plan_id, dry_run: false }, ledger)).toThrow(/ambiguous rows/);
      expectSnapshot(activeJuneSnapshot(ctx), before);
      expectIntegrity(ledger);
    } finally {
      ctx.ledger.close();
    }
  });

  it("roundtrips full exports and makes scoped export portability explicit", () => {
    const ctx = createGoldenContext();
    try {
      seedReimportLedger(ctx);
      const full = callTool("export_ledger", {}, ctx.ledger) as Row;
      const target = new Ledger(join(ctx.dir, "roundtrip.db"));
      try {
        const imported = callTool("import_ledger", { data: full.data, dry_run: false }, target) as Row;
        expect(imported.transactions).toBe(7);
        expect(callTool("integrity_check", {}, target)).toMatchObject({ ok: true, healthy: true });
      } finally {
        target.close();
      }

      const scoped = callTool("export_ledger", { account_ids: [ctx.accounts.Groceries], date_from: "2026-06-01", date_to: "2026-06-30" }, ctx.ledger) as Row;
      const scopedDoc = JSON.parse(String(scoped.data));
      expect(scopedDoc.scope).toMatchObject({ transaction_count: 1 });
      const scopedTarget = new Ledger(join(ctx.dir, "scoped.db"));
      try {
        const scopedImport = callTool("import_ledger", { data: scoped.data, dry_run: true }, scopedTarget) as Row;
        expect(scopedImport.valid).toBe(true);
        expect(scopedImport.errors).toEqual([]);
      } finally {
        scopedTarget.close();
      }
    } finally {
      ctx.ledger.close();
    }
  });

  it("keeps installed CLI lifecycle output parseable and bounded", () => {
    const ctx = createGoldenContext();
    try {
      const stdout = execFileSync(process.execPath, ["dist/cli/main.js", "--db", ctx.db, "--format", "json", "tool", "init_defaults", "--json", JSON.stringify({ template: "personal", currency: "CAD" })], {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 30_000
      });
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(Buffer.byteLength(stdout, "utf8")).toBeLessThan(16_000);
    } finally {
      ctx.ledger.close();
    }
  });

  it("serves a short lifecycle through MCP structured content", async () => {
    const ctx = createGoldenContext();
    try {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["dist/mcp/main.js"],
        cwd: process.cwd(),
        env: { ...process.env, CLOVIS_DB: ctx.db },
        stderr: "pipe"
      });
      const client = new Client({ name: "clovis-golden-lifecycle", version: "0.0.0" });
      try {
        await client.connect(transport);
        const init = await client.callTool({ name: "init_defaults", arguments: { template: "personal", currency: "CAD" } });
        const text = (init.content as Array<{ text?: string }>)[0]?.text ?? "";
        expect(JSON.parse(text)).toEqual((init as any).structuredContent);
        const tools = await client.listTools();
        expect(tools.tools.map((tool) => tool.name)).toContain("refresh_statement");
      } finally {
        await client.close().catch(() => undefined);
      }
    } finally {
      ctx.ledger.close();
    }
  }, 30_000);
});
