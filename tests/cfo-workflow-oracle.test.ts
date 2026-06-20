import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { callTool } from "../src/app/index.js";
import { Ledger } from "../src/core/index.js";

type Row = Record<string, any>;

type WorkflowContext = {
  dir: string;
  ledger: Ledger;
  assets: Record<string, string>;
  accounts: Record<string, string>;
};

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function createWorkflowContext(): WorkflowContext {
  const dir = mkdtempSync(join(tmpdir(), "clovis-cfo-workflow-"));
  const ledger = new Ledger(join(dir, "ledger.db"));
  cleanups.push(() => {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const assets = {
    usd: ledger.createAsset("USD", "currency", 2, "US Dollar"),
    jpy: ledger.createAsset("JPY", "currency", 0, "Yen")
  };
  const accounts = {
    Checking: ledger.createAccount("Checking", "asset"),
    "Credit Card": ledger.createAccount("Credit Card", "liability"),
    Equity: ledger.createAccount("Equity", "equity"),
    Uncategorized: ledger.createAccount("Uncategorized", "expense")
  };
  for (const accountId of Object.values(accounts)) ledger.createAnnotation("account", accountId, "default_asset", assets.usd);

  return { dir, ledger, assets, accounts };
}

function entries(ctx: WorkflowContext, txId: string): Row[] {
  return ctx.ledger.db.prepare("SELECT account_id, asset_id, quantity FROM journal_lines WHERE journal_id = ? ORDER BY line_no").all(txId) as Row[];
}

function txStatus(ctx: WorkflowContext, txId: string): string {
  return String((ctx.ledger.db.prepare("SELECT status FROM journals WHERE id = ?").get(txId) as Row).status);
}

describe("CFO workflow SQLite oracle audit", () => {
  it("records pending card expenses as card liability increases", () => {
    const ctx = createWorkflowContext();
    const { ledger, accounts, assets } = ctx;
    ledger.recordTransaction("2026-06-01", 10000n, accounts.Equity, accounts.Checking, assets.usd, "Opening cash", "posted");

    const result = callTool("record_pending_expenses", {
      account_id: accounts["Credit Card"],
      transactions: [{ date: "2026-06-10", amount: 18, description: "Pending card charge" }],
      dry_run: false,
      batch_label: "Synthetic pending card"
    }, ledger) as Row;

    expect(result.created).toBe(1);
    const txId = String(result.transactions[0].id);
    const pendingBucket = ledger.listAccounts().find((account) => account.name === "Pending Expenses");
    expect(pendingBucket?.account_type).toBe("expense");
    expect(entries(ctx, txId)).toEqual([
      { account_id: accounts["Credit Card"], asset_id: assets.usd, quantity: -1800n },
      { account_id: pendingBucket?.id, asset_id: assets.usd, quantity: 1800n }
    ]);
    expect(ledger.balanceTree(accounts["Credit Card"], assets.usd, null, "pending")).toBe(-1800n);

    const projection = callTool("cash_projection", {
      year: 2026,
      month: 6,
      asset_account_ids: [accounts.Checking],
      liability_account_ids: [accounts["Credit Card"]],
      include_pending: true,
      include_planned: false,
      quote_asset_id: assets.usd
    }, ledger) as Row;
    expect(projection.available_cash_cents).toBe(8200);
  });

  it("preserves pending expense categories from match rules and per-row counterparts", () => {
    const ctx = createWorkflowContext();
    const { ledger, accounts, assets } = ctx;
    const dining = ledger.createAccount("Dining", "expense");
    const shopping = ledger.createAccount("Shopping", "expense");
    for (const accountId of [dining, shopping]) ledger.createAnnotation("account", accountId, "default_asset", assets.usd);
    callTool("add_match_rule", { account_id: dining, pattern: "Coffee" }, ledger);

    const preview = callTool("record_pending_expenses", {
      account_id: accounts["Credit Card"],
      transactions: [
        { date: "2026-06-10", amount: 6.75, description: "Coffee House" },
        { date: "2026-06-11", amount: 22, description: "Book Store", counterpart_id: shopping }
      ]
    }, ledger) as Row;
    expect(preview).toMatchObject({ dry_run: true, would_create: 2, created: 0, would_create_account: null });
    expect(ledger.listAccounts().some((account) => account.name === "Pending Expenses")).toBe(false);

    const result = callTool("record_pending_expenses", {
      account_id: accounts["Credit Card"],
      transactions: [
        { date: "2026-06-10", amount: 6.75, description: "Coffee House" },
        { date: "2026-06-11", amount: 22, description: "Book Store", counterpart_id: shopping }
      ],
      dry_run: false
    }, ledger) as Row;
    expect(result.created).toBe(2);
    expect(entries(ctx, String(result.transactions[0].id)).some((entry) => entry.account_id === dining && entry.quantity === 675n)).toBe(true);
    expect(entries(ctx, String(result.transactions[1].id)).some((entry) => entry.account_id === shopping && entry.quantity === 2200n)).toBe(true);
    expect(ledger.listAccounts().some((account) => account.name === "Pending Expenses")).toBe(false);
  });

  it("processes statement expected balances from posted balance plus importable rows", () => {
    const ctx = createWorkflowContext();
    const { ledger, accounts, assets, dir } = ctx;
    ledger.recordTransaction("2026-06-01", 10000n, accounts.Equity, accounts.Checking, assets.usd, "Opening cash", "posted");
    ledger.recordTransaction("2026-06-02", 2500n, accounts.Equity, accounts.Checking, assets.usd, "Already imported", "posted");
    ledger.recordTransaction("2026-06-04", 1000n, accounts.Checking, accounts.Uncategorized, assets.usd, "Existing pending", "pending");
    writeFileSync(join(dir, "statement.csv"), "date,amount,description\n2026-06-02,25.00,Already imported\n2026-06-03,5.00,New deposit\n", "utf8");

    const result = callTool("process_statement", {
      file_path: "statement.csv",
      account_id: accounts.Checking,
      counterpart_account_id: accounts.Equity,
      expected_balance: 130,
      commit: true
    }, ledger) as Row;

    expect(result.would_import).toBe(1);
    expect(result.matched_existing).toBe(1);
    expect(result.new_rows).toBe(1);
    expect(result).not.toHaveProperty("skipped_duplicates");
    expect(result.created).toBe(1);
    expect(result.actual_balance_cents).toBe(13000);
    expect(ledger.balanceTree(accounts.Checking, assets.usd, null, "posted")).toBe(13000n);
    expect(ledger.balanceTree(accounts.Checking, assets.usd, null, "pending")).toBe(-1000n);
  });

  it("reconciles statement plans with explicit non-cent assets", () => {
    const ctx = createWorkflowContext();
    const { ledger, accounts, assets, dir } = ctx;
    ledger.recordTransaction("2026-06-05", 1234n, accounts.Equity, accounts.Checking, assets.jpy, "JPY deposit", "posted");
    writeFileSync(join(dir, "jpy.csv"), "date,amount,description\n2026-06-05,1234,JPY deposit\n", "utf8");

    const result = callTool("reconcile_statement_plan", {
      file_path: "jpy.csv",
      account_id: accounts.Checking,
      counterpart_account_id: accounts.Equity,
      asset_id: assets.jpy
    }, ledger) as Row;

    expect(result).toMatchObject({ reconciled: true, matched: 1, unmatched: 0 });
  });

  it("supports pending refresh and commit without touching posted history", () => {
    const ctx = createWorkflowContext();
    const { ledger, accounts, assets } = ctx;
    const posted = ledger.recordTransaction("2026-06-01", 500n, accounts["Credit Card"], accounts.Uncategorized, assets.usd, "Posted card charge", "posted");
    const stale = callTool("record_pending_expenses", {
      account_id: accounts["Credit Card"],
      transactions: [{ date: "2026-06-09", amount: 11, description: "Stale pending" }],
      dry_run: false,
      batch_label: "Stale pending"
    }, ledger) as Row;

    const preview = callTool("void_by_filter", { status: "pending", account_id: accounts["Credit Card"], dry_run: true }, ledger) as Row;
    expect(preview.matched).toBe(1);
    const voided = callTool("void_by_filter", { status: "pending", account_id: accounts["Credit Card"], dry_run: false }, ledger) as Row;
    expect(voided.voided).toBe(1);
    expect(txStatus(ctx, String(stale.transactions[0].id))).toBe("void");
    expect(txStatus(ctx, posted.id)).toBe("posted");

    const fresh = callTool("record_pending_expenses", {
      account_id: accounts["Credit Card"],
      transactions: [{ date: "2026-06-10", amount: 12, description: "Fresh pending" }],
      dry_run: false,
      batch_label: "Fresh pending"
    }, ledger) as Row;
    const committed = callTool("commit_batch", { batch_id: fresh.batch_id }, ledger) as Row;
    expect(committed).toMatchObject({ matched: 1, committed: 1, dry_run: false });
    expect(txStatus(ctx, String(fresh.transactions[0].id))).toBe("posted");
  });
});
