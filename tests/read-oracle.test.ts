import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { callTool, TOOL_NAMES, type ToolName } from "../src/app/index.js";
import { publicize } from "../src/app/json.js";
import { Ledger } from "../src/core/index.js";

type Row = Record<string, any>;

type OracleContext = {
  dir: string;
  db: string;
  ledger: Ledger;
  accounts: Record<string, string>;
  assets: Record<string, string>;
  tx: Record<string, string>;
  batchId: string;
  checkpointId: string;
  tagId: string;
};

type ReadCase = {
  name: ToolName;
  args: (ctx: OracleContext) => Record<string, unknown>;
  oracle: (result: any, ctx: OracleContext) => void;
  cli?: boolean;
};

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createOracleContext(): OracleContext {
  const dir = mkdtempSync(join(tmpdir(), "clovis-read-oracle-"));
  dirs.push(dir);
  const db = join(dir, "ledger.db");
  const ledger = new Ledger(db);

  const usd = ledger.createAsset("USD", "currency", 2, "US Dollar");
  const eur = ledger.createAsset("EUR", "currency", 2, "Euro");
  const jpy = ledger.createAsset("JPY", "currency", 0, "Yen");
  ledger.createPrice(eur, usd, "1.10", "2026-06-01");
  ledger.createPrice(jpy, usd, "0.01", "2026-06-01");

  const accounts = {
    Assets: ledger.createAccount("Assets", "asset"),
    Checking: "",
    Savings: "",
    Brokerage: "",
    Liabilities: ledger.createAccount("Liabilities", "liability"),
    "Credit Card": "",
    "Opening Balances": ledger.createAccount("Opening Balances", "equity"),
    "Transfer Clearing": ledger.createAccount("Transfer Clearing", "equity"),
    Salary: ledger.createAccount("Salary", "income"),
    Interest: ledger.createAccount("Interest", "income"),
    Food: ledger.createAccount("Food", "expense"),
    Groceries: "",
    "Dining Out": "",
    Rent: ledger.createAccount("Rent", "expense"),
    Utilities: ledger.createAccount("Utilities", "expense"),
    Uncategorized: ledger.createAccount("Uncategorized", "expense"),
    Fees: ledger.createAccount("Fees", "expense")
  };
  accounts.Checking = ledger.createAccount("Checking", "asset", accounts.Assets);
  accounts.Savings = ledger.createAccount("Savings", "asset", accounts.Assets);
  accounts.Brokerage = ledger.createAccount("Brokerage", "asset", accounts.Assets);
  accounts["Credit Card"] = ledger.createAccount("Credit Card", "liability", accounts.Liabilities);
  accounts.Groceries = ledger.createAccount("Groceries", "expense", accounts.Food);
  accounts["Dining Out"] = ledger.createAccount("Dining Out", "expense", accounts.Food);

  for (const accountId of Object.values(accounts)) ledger.createAnnotation("account", accountId, "default_asset", usd);

  const tx = {
    pay: ledger.recordTransaction("2026-06-01", 100000n, accounts.Salary, accounts.Checking, usd, "June Pay", "posted").id,
    groceries: ledger.recordTransaction("2026-06-02", 2500n, accounts.Checking, accounts.Groceries, usd, "Market Groceries", "posted").id,
    coffee: ledger.recordTransaction("2026-06-03", 1200n, accounts.Checking, accounts["Dining Out"], usd, "Coffee", "posted").id,
    cardDinner: ledger.recordTransaction("2026-06-04", 500n, accounts["Credit Card"], accounts["Dining Out"], usd, "Card Dinner", "posted").id,
    eurSeed: ledger.recordTransaction("2026-06-05", 10000n, accounts["Opening Balances"], accounts.Savings, eur, "EUR Seed", "posted").id,
    postedDuplicate: ledger.recordTransaction("2026-06-07", 999n, accounts.Checking, accounts.Uncategorized, usd, "Duplicate Pending", "posted").id,
    pendingCoffee: ledger.recordTransaction("2026-06-06", 800n, accounts.Checking, accounts.Uncategorized, usd, "Coffee Pending", "pending").id,
    duplicateA: ledger.recordTransaction("2026-06-07", 999n, accounts.Checking, accounts.Uncategorized, usd, "Duplicate Pending", "pending").id,
    duplicateB: ledger.recordTransaction("2026-06-07", 999n, accounts.Checking, accounts.Uncategorized, usd, "Duplicate Pending", "pending").id,
    transferOut: ledger.recordTransaction("2026-06-08", 7500n, accounts.Checking, accounts["Transfer Clearing"], usd, "Transfer Out", "pending").id,
    transferIn: ledger.recordTransaction("2026-06-08", 7500n, accounts["Transfer Clearing"], accounts.Savings, usd, "Transfer In", "pending").id,
    unmatched: ledger.recordTransaction("2026-06-09", 4200n, accounts.Checking, accounts["Transfer Clearing"], usd, "Unmatched Transfer", "pending").id,
    plannedPay: ledger.recordTransaction("2026-06-20", 50000n, accounts.Salary, accounts.Checking, usd, "Planned Pay", "planned").id,
    plannedRent: ledger.recordTransaction("2026-06-21", 30000n, accounts.Checking, accounts.Rent, usd, "Planned Rent", "planned").id
  };

  const batchId = ledger.createSource("import", "Oracle Batch", { source: "oracle" });
  tx.imported = ledger.recordTransaction("2026-06-10", 700n, accounts["Opening Balances"], accounts.Checking, usd, "Imported Pending", "pending", { sourceId: batchId }).id;
  ledger.createAnnotation("tx", tx.imported, "import_batch", batchId);
  const tagId = ledger.createAnnotation("tx", tx.pay, "memo", "tagged");
  ledger.createAnnotation("tx", tx.unmatched, "transfer", "unmatched");

  ledger.createRule("match", accounts["Dining Out"], "Coffee");
  ledger.setBudget(accounts.Food, usd, 70000n, "monthly", 2026, 6, false);
  ledger.setBudget(accounts.Groceries, usd, 50000n, "monthly", 2026, 6, false);
  ledger.setGoal(accounts.Savings, usd, 200000n, "Reserve", null, 1);
  ledger.createRecurrence("2026-06-01", 1500n, accounts.Checking, accounts.Utilities, "Scheduled utility", "monthly", null, usd);
  callTool("buy_security", { account_id: accounts.Brokerage, symbol: "MSFT", shares: 2, total_cost_cents: 20000, date: "2026-06-11", asset_id: usd }, ledger);
  ledger.db.prepare("INSERT INTO books(id, name, type, parent_id, created_at) VALUES ('scenario', 'scenario', 'scenario', ?, '2026-06-01T00:00:00Z')").run(ledger.bookId);
  const checkpointId = String(ledger.closePeriod("May close", "2026-05-31").id);
  callTool("backup_now", {}, ledger);

  writeFileSync(join(dir, "statement.csv"), "date,amount,description,counterpart,kind\n2026-06-12,44.00,Statement Deposit,Opening Balances,income\n", "utf8");

  return { dir, db, ledger, accounts, assets: { usd, eur, jpy }, tx, batchId, checkpointId, tagId };
}

function all(ctx: OracleContext, sql: string, ...params: unknown[]): Row[] {
  return ctx.ledger.db.prepare(sql).all(...params as any[]) as Row[];
}

function get(ctx: OracleContext, sql: string, ...params: unknown[]): Row {
  return ctx.ledger.db.prepare(sql).get(...params as any[]) as Row;
}

function sqlCount(ctx: OracleContext, sql: string, ...params: unknown[]): number {
  return Number(get(ctx, sql, ...params).count);
}

function statusClause(status: string | null): string {
  if (status == null) return "j.status != 'void'";
  if (status === "active") return "j.status IN ('posted', 'pending')";
  if (status === "combined") return "j.status IN ('posted', 'pending', 'planned')";
  return `j.status = '${status}'`;
}

function sameTypeDescendants(ctx: OracleContext, accountId: string): string[] {
  return all(ctx, `
    WITH RECURSIVE tree(id) AS (
      SELECT id FROM accounts WHERE id = ?
      UNION ALL
      SELECT a.id FROM accounts a JOIN tree t ON a.parent_id = t.id
    ), root(type) AS (SELECT type FROM accounts WHERE id = ?)
    SELECT a.id FROM accounts a JOIN tree t ON t.id = a.id JOIN root r ON a.type = r.type
    ORDER BY a.id
  `, accountId, accountId).map((row) => String(row.id));
}

function placeholders(values: unknown[]): string {
  return values.map(() => "?").join(",");
}

function rawBalance(ctx: OracleContext, accountId: string, assetId: string, status: string | null = "posted", asOf?: string | null, dateAfter?: string | null): bigint {
  const ids = sameTypeDescendants(ctx, accountId);
  const params: unknown[] = [...ids, assetId];
  let sql = `SELECT coalesce(sum(l.quantity), 0) AS total
    FROM journal_lines l JOIN journals j ON j.id = l.journal_id
    WHERE l.account_id IN (${placeholders(ids)}) AND l.asset_id = ? AND ${statusClause(status)}`;
  if (asOf) {
    sql += " AND j.date <= ?";
    params.push(asOf);
  }
  if (dateAfter) {
    sql += " AND j.date > ?";
    params.push(dateAfter);
  }
  return BigInt(get(ctx, sql, ...params).total ?? 0);
}

function roundRatio(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  let quotient = absolute / denominator;
  if ((absolute % denominator) * 2n >= denominator) quotient += 1n;
  return negative ? -quotient : quotient;
}

function converted(ctx: OracleContext, quantity: bigint, assetId: string, quoteId: string, asOf = "9999-12-31"): bigint | null {
  if (assetId === quoteId) return quantity;
  const asset = get(ctx, "SELECT scale FROM assets WHERE id = ?", assetId);
  const quote = get(ctx, "SELECT scale FROM assets WHERE id = ?", quoteId);
  const direct = get(ctx, "SELECT rate_value, rate_scale FROM prices WHERE asset_id = ? AND quote_asset_id = ? AND time <= ? ORDER BY time DESC, id DESC LIMIT 1", assetId, quoteId, asOf);
  if (direct) {
    return roundRatio(quantity * BigInt(direct.rate_value) * 10n ** BigInt(quote.scale), 10n ** BigInt(Number(asset.scale) + Number(direct.rate_scale)));
  }
  const inverse = get(ctx, "SELECT rate_value, rate_scale FROM prices WHERE asset_id = ? AND quote_asset_id = ? AND time <= ? ORDER BY time DESC, id DESC LIMIT 1", quoteId, assetId, asOf);
  if (inverse) {
    const forwardNumerator = BigInt(inverse.rate_value) * 10n ** BigInt(asset.scale);
    const forwardDenominator = 10n ** BigInt(Number(quote.scale) + Number(inverse.rate_scale));
    return roundRatio(quantity * forwardDenominator, forwardNumerator);
  }
  return null;
}

function quotedBalance(ctx: OracleContext, accountId: string, quoteId: string, status: string | null = "posted", asOf?: string | null, dateAfter?: string | null): { total: bigint; missing: number } {
  let total = 0n;
  let missing = 0;
  for (const asset of all(ctx, "SELECT id FROM assets ORDER BY symbol, id")) {
    const raw = rawBalance(ctx, accountId, String(asset.id), status, asOf, dateAfter);
    if (raw === 0n) continue;
    const value = converted(ctx, raw, String(asset.id), quoteId, asOf ?? "9999-12-31");
    if (value == null) missing += 1;
    else total += value;
  }
  return { total, missing };
}

function normalAmount(type: string, amount: bigint): bigint {
  return type === "asset" || type === "expense" ? amount : -amount;
}

function incomeExpense(ctx: OracleContext, status = "posted"): { income: bigint; expense: bigint } {
  const rows = all(ctx, `
    SELECT a.type, l.quantity, l.asset_id, j.date
    FROM journal_lines l JOIN journals j ON j.id = l.journal_id JOIN accounts a ON a.id = l.account_id
    WHERE ${statusClause(status)} AND j.date BETWEEN '2026-06-01' AND '2026-06-30' AND a.type IN ('income', 'expense')
  `);
  let income = 0n;
  let expense = 0n;
  for (const row of rows) {
    const value = converted(ctx, BigInt(row.quantity), String(row.asset_id), ctx.assets.usd, String(row.date));
    if (value == null) continue;
    if (row.type === "income") income += normalAmount("income", value);
    else expense += normalAmount("expense", value);
  }
  return { income, expense };
}

function expenseByAccount(ctx: OracleContext, status = "posted"): Map<string, bigint> {
  const rows = all(ctx, `
    SELECT a.id AS account_id, l.quantity, l.asset_id, j.date
    FROM journal_lines l JOIN journals j ON j.id = l.journal_id JOIN accounts a ON a.id = l.account_id
    WHERE ${statusClause(status)} AND j.date BETWEEN '2026-06-01' AND '2026-06-30' AND a.type = 'expense'
  `);
  const out = new Map<string, bigint>();
  for (const row of rows) {
    const value = converted(ctx, BigInt(row.quantity), String(row.asset_id), ctx.assets.usd, String(row.date));
    if (value == null) continue;
    out.set(String(row.account_id), (out.get(String(row.account_id)) ?? 0n) + value);
  }
  return out;
}

function ageOfMoneyOracle(ctx: OracleContext, days: number, quoteAssetId: string): { income: bigint; outflow: bigint; remaining: bigint } {
  const asOf = new Date().toISOString().slice(0, 10);
  const cutoff = new Date(`${asOf}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const dateFrom = cutoff.toISOString().slice(0, 10);
  const assetAccounts = new Set(all(ctx, "SELECT id FROM accounts WHERE type = 'asset'").map((row) => String(row.id)));
  const lots: Array<{ date: string; quantity: bigint }> = [];
  let income = 0n;
  let outflow = 0n;

  const txs = all(ctx, `
    SELECT id, date
    FROM journals
    WHERE status = 'posted' AND finalized_at IS NOT NULL AND date BETWEEN ? AND ?
    ORDER BY date, id
  `, dateFrom, asOf);

  for (const tx of txs) {
    let delta = 0n;
    for (const entry of all(ctx, "SELECT account_id, asset_id, quantity FROM journal_lines WHERE journal_id = ? ORDER BY line_no, id", tx.id)) {
      if (!assetAccounts.has(String(entry.account_id))) continue;
      const value = converted(ctx, BigInt(entry.quantity), String(entry.asset_id), quoteAssetId, String(tx.date));
      if (value != null) delta += value;
    }
    if (delta > 0n) {
      income += delta;
      lots.push({ date: String(tx.date), quantity: delta });
    } else if (delta < 0n) {
      let remaining = -delta;
      outflow += remaining;
      while (remaining > 0n && lots.length > 0) {
        const lot = lots[0];
        const used = lot.quantity < remaining ? lot.quantity : remaining;
        lot.quantity -= used;
        remaining -= used;
        if (lot.quantity === 0n) lots.shift();
      }
    }
  }

  return { income, outflow, remaining: lots.reduce((sum, lot) => sum + lot.quantity, 0n) };
}

function representativePendingTotal(ctx: OracleContext): bigint {
  return all(ctx, `
    SELECT j.id, max(abs(l.quantity)) AS amount
    FROM journals j JOIN journal_lines l ON l.journal_id = j.id
    WHERE j.status = 'pending' AND j.date BETWEEN '2026-06-01' AND '2026-06-30'
    GROUP BY j.id
  `).reduce((sum, row) => sum + BigInt(row.amount), 0n);
}

function dateDeltaDays(left: string, right: string): number {
  return Math.abs((Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`)) / 86400000);
}

function duplicateReviewGroups(ctx: OracleContext): Row[] {
  const txRows = (status: string) => all(ctx, `
    SELECT j.id, j.date, max(abs(l.quantity)) AS amount_cents, lower(j.description) AS description
    FROM journals j JOIN journal_lines l ON l.journal_id = j.id
    WHERE j.status = ?
    GROUP BY j.id
  `, status);
  const group = (rows: Row[]) => {
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      const key = `${row.amount_cents}|${row.description}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    return groups;
  };
  const pending = group(txRows("pending"));
  const posted = group(txRows("posted"));
  const duplicates: Row[] = [];
  for (const [key, rows] of pending) {
    if (rows.length > 1 && rows.some((left, index) => rows.slice(index + 1).some((right) => dateDeltaDays(String(left.date), String(right.date)) <= 3))) {
      duplicates.push({ type: "pending", key, tx_ids: rows.map((row) => row.id) });
    }
    const postedMatches = (posted.get(key) ?? []).filter((postedRow) => rows.some((pendingRow) => dateDeltaDays(String(pendingRow.date), String(postedRow.date)) <= 3));
    if (postedMatches.length > 0) {
      duplicates.push({ type: "posted", key, tx_ids: [...rows.map((row) => row.id), ...postedMatches.map((row) => row.id)] });
    }
  }
  return duplicates;
}

function rootAccounts(ctx: OracleContext, types: string[]): string[] {
  return all(ctx, `
    SELECT a.id
    FROM accounts a LEFT JOIN accounts p ON p.id = a.parent_id
    WHERE a.type IN (${placeholders(types)}) AND (a.parent_id IS NULL OR p.type != a.type)
    ORDER BY a.name
  `, ...types).map((row) => String(row.id));
}

function expectCliMatches(name: ToolName, args: Record<string, unknown>, appResult: any, ctx: OracleContext): void {
  const stdout = execFileSync(process.execPath, ["dist/cli/main.js", "--db", ctx.db, "--format", "json", "tool", name, "--json", JSON.stringify(args)], {
    cwd: process.cwd(),
    env: { ...process.env },
    encoding: "utf8"
  });
  const envelope = JSON.parse(stdout);
  expect(envelope.ok).toBe(true);
  expect(envelope.data).toEqual(publicize(appResult));
}

const READ_CASES: ReadCase[] = [
  {
    name: "account_balances",
    args: () => ({ account_type: "asset" }),
    oracle: (result, ctx) => {
      const checking = result.find((row: Row) => row.account_id === ctx.accounts.Checking && row.asset_id === ctx.assets.usd);
      expect(checking.posted_balance_cents).toBe(Number(rawBalance(ctx, ctx.accounts.Checking, ctx.assets.usd, "posted")));
      expect(checking.pending_balance_cents).toBe(Number(rawBalance(ctx, ctx.accounts.Checking, ctx.assets.usd, "pending")));
    }
  },
  {
    name: "account_register",
    args: (ctx) => ({ account_id: ctx.accounts.Checking }),
    oracle: (result, ctx) => {
      expect(result.total).toBe(sqlCount(ctx, "SELECT count(*) AS count FROM journal_lines WHERE account_id = ? AND asset_id = ?", ctx.accounts.Checking, ctx.assets.usd));
      expect(result.entries.at(-1).running_balance).toBe(Number(rawBalance(ctx, ctx.accounts.Checking, ctx.assets.usd, null)));
    }
  },
  {
    name: "age_of_money",
    args: (ctx) => ({ days: 30, quote_asset_id: ctx.assets.usd }),
    oracle: (result, ctx) => {
      const expected = ageOfMoneyOracle(ctx, 30, ctx.assets.usd);
      expect(result.income_cents).toBe(Number(expected.income));
      expect(result.outflow_cents).toBe(Number(expected.outflow));
      expect(result.remaining_cents).toBe(Number(expected.remaining));
      expect(result.average_age_days).not.toBe(30);
    }
  },
  {
    name: "assert_balance",
    args: (ctx) => ({ account_id: ctx.accounts.Checking, expected: Number(rawBalance(ctx, ctx.accounts.Checking, ctx.assets.usd, null)) / 100, asset_id: ctx.assets.usd }),
    oracle: (result, ctx) => {
      expect(result.matches).toBe(true);
      expect(result.actual_cents).toBe(Number(rawBalance(ctx, ctx.accounts.Checking, ctx.assets.usd, null)));
    }
  },
  {
    name: "assert_balances",
    args: (ctx) => ({ assertions: [{ account_id: ctx.accounts.Checking, expected: Number(rawBalance(ctx, ctx.accounts.Checking, ctx.assets.usd, null)) / 100, asset_id: ctx.assets.usd }] }),
    oracle: (result) => expect(result.matches).toBe(true)
  },
  {
    name: "audit_categorization",
    args: () => ({ status: "pending" }),
    oracle: (result, ctx) => expect(result.uncategorized.total).toBe(sqlCount(ctx, "SELECT count(DISTINCT j.id) AS count FROM journals j JOIN journal_lines l ON l.journal_id = j.id WHERE j.status = 'pending' AND l.account_id = ?", ctx.accounts.Uncategorized))
  },
  {
    name: "backup_status",
    args: () => ({}),
    oracle: (result, ctx) => expect(result.count).toBe(readdirSync(join(ctx.dir, "backups")).length)
  },
  {
    name: "balance_sheet",
    args: (ctx) => ({ date: "2026-06-30", quote_asset_id: ctx.assets.usd }),
    oracle: (result, ctx) => {
      const expectedAssets = rootAccounts(ctx, ["asset"]).reduce((sum, accountId) => sum + quotedBalance(ctx, accountId, ctx.assets.usd, "posted", "2026-06-30").total, 0n);
      const expectedLiabilities = rootAccounts(ctx, ["liability"]).reduce((sum, accountId) => sum + quotedBalance(ctx, accountId, ctx.assets.usd, "posted", "2026-06-30").total, 0n);
      expect(result.total_assets).toBe(Number(expectedAssets));
      expect(result.total_liabilities).toBe(Number(expectedLiabilities));
    }
  },
  {
    name: "budget_rollover_preview",
    args: (ctx) => ({ year: 2026, month: 6, quote_asset_id: ctx.assets.usd }),
    oracle: (result) => {
      if (result.valuation_complete === false) {
        expect(result.total_rollover_cents).toBe(0);
        expect(result.missing_conversions.length).toBeGreaterThan(0);
      } else {
        expect(result.total_rollover_cents).toBeGreaterThan(0);
      }
    }
  },
  {
    name: "budget_status",
    args: (ctx) => ({ account: ctx.accounts.Groceries, year: 2026, month: 6, quote_asset_id: ctx.assets.usd }),
    oracle: (result, ctx) => {
      expect(result.budgets[0].budgeted_cents).toBe(Number(get(ctx, "SELECT quantity FROM targets WHERE type = 'budget' AND account_id = ?", ctx.accounts.Groceries).quantity));
      expect(result.budgets[0].spent_cents).toBe(Number(expenseByAccount(ctx).get(ctx.accounts.Groceries) ?? 0n));
    }
  },
  {
    name: "budget_summary",
    args: (ctx) => ({ year: 2026, month: 6, quote_asset_id: ctx.assets.usd }),
    oracle: (result) => expect(result.total_remaining_cents).toBe(result.total_budgeted_cents - result.total_spent_cents)
  },
  {
    name: "cash_flow",
    args: (ctx) => ({ year: 2026, month: 6, quote_asset_id: ctx.assets.usd }),
    oracle: (result, ctx) => {
      const expected = incomeExpense(ctx);
      expect(result.operating_total).toBe(Number(expected.expense - expected.income));
    }
  },
  {
    name: "cash_projection",
    args: (ctx) => ({ year: 2026, month: 6, quote_asset_id: ctx.assets.usd }),
    oracle: (result, ctx) => {
      const expected = rootAccounts(ctx, ["asset"]).reduce((sum, accountId) => {
        return sum + quotedBalance(ctx, accountId, ctx.assets.usd, "posted", "2026-06-30").total;
      }, 0n);
      expect(result.gross_cash_cents).toBe(Number(expected));
      expect(result.include_pending).toBe(false);
      expect(result.include_planned).toBe(false);
      expect(result.audit_trail.line_items.length).toBeGreaterThan(0);
    }
  },
  {
    name: "cash_runway",
    args: (ctx) => ({ year: 2026, month: 6, quote_asset_id: ctx.assets.usd }),
    oracle: (result) => {
      expect(result.include_pending).toBe(false);
      expect(result.include_planned).toBe(false);
      expect(result.assumptions.conservative_default).toBe(true);
      expect(result.burn_models.map((row: Row) => row.model)).toEqual(expect.arrayContaining([
        "budget_burn",
        "trailing_3_month_actual",
        "trailing_6_month_actual",
        "fixed_obligation_burn",
        "discretionary_adjusted_burn"
      ]));
      expect(result.recommended_model).toBeTruthy();
    }
  },
  {
    name: "compare_scenarios",
    args: (ctx) => ({ asset_id: ctx.assets.usd }),
    oracle: (result) => expect(result.differences).toEqual([])
  },
  {
    name: "count_transactions",
    args: () => ({ status: "posted" }),
    oracle: (result, ctx) => expect(result.count).toBe(sqlCount(ctx, "SELECT count(*) AS count FROM journals WHERE status = 'posted'"))
  },
  {
    name: "detect_recurring",
    args: () => ({ min_occurrences: 1 }),
    oracle: (result, ctx) => expect(result).toContainEqual(expect.objectContaining({ description: get(ctx, "SELECT description FROM journals WHERE id = ?", ctx.tx.pay).description, amount_cents: 100000 }))
  },
  {
    name: "export_ledger",
    args: () => ({}),
    oracle: (result, ctx) => {
      const doc = JSON.parse(result.data);
      expect(doc.accounts).toHaveLength(sqlCount(ctx, "SELECT count(*) AS count FROM accounts"));
      expect(doc.assets).toHaveLength(sqlCount(ctx, "SELECT count(*) AS count FROM assets"));
    }
  },
  {
    name: "export_transactions",
    args: () => ({}),
    oracle: (result, ctx) => expect(result.exported).toBe(sqlCount(ctx, "SELECT count(*) AS count FROM journal_lines l JOIN journals j ON j.id = l.journal_id WHERE j.status != 'void'"))
  },
  {
    name: "file_access_status",
    args: () => ({}),
    oracle: (result, ctx) => {
      expect(result.mode).toBe("unrestricted");
      expect(result.path_policy).toContain("operating system permits");
      expect(result.ledger_dir).toBe(realpathSync(ctx.dir));
      expect(result.errors).toEqual([]);
      expect(result.configure.env).toContain("No Clovis path configuration");
    }
  },
  {
    name: "financial_overview",
    args: (ctx) => ({ year: 2026, month: 6, quote_asset_id: ctx.assets.usd }),
    oracle: (result, ctx) => expect(result.monthly_activity.income).toBe(Number(incomeExpense(ctx, "active").income))
  },
  {
    name: "financial_picture",
    args: (ctx) => ({ year: 2026, month: 6, quote_asset_id: ctx.assets.usd }),
    oracle: (result, ctx) => {
      expect(result.monthly_activity.income).toBe(Number(incomeExpense(ctx, "active").income));
      expect(result.include_planned).toBe(false);
      expect(result.cash_position.actual.include_planned).toBe(false);
    }
  },
  {
    name: "find_pending_duplicates",
    args: () => ({}),
    oracle: (result, ctx) => {
      const expected = duplicateReviewGroups(ctx);
      expect(result.count).toBe(expected.length);
      expect(result.duplicates).toEqual(expect.arrayContaining(expected.map((row) => expect.objectContaining({ type: row.type, key: row.key, tx_ids: expect.arrayContaining(row.tx_ids) }))));
    }
  },
  {
    name: "forecast",
    args: (ctx) => ({ account_id: ctx.accounts.Checking, asset_id: ctx.assets.usd, as_of: "2026-06-30" }),
    oracle: (result, ctx) => {
      expect(result.posted_cents).toBe(Number(rawBalance(ctx, ctx.accounts.Checking, ctx.assets.usd, "posted", "2026-06-30")));
      expect(result.projected_cents).toBe(Number(rawBalance(ctx, ctx.accounts.Checking, ctx.assets.usd, null, "2026-06-30")));
    }
  },
  {
    name: "forecast_month_end",
    args: (ctx) => ({ year: 2026, month: 6, quote_asset_id: ctx.assets.usd }),
    oracle: (result) => expect(result.overspend_risk).toEqual(result.categories.filter((row: Row) => row.remaining_cents < 0))
  },
  {
    name: "get_account",
    args: (ctx) => ({ id: ctx.accounts.Checking }),
    oracle: (result, ctx) => expect(result.name).toBe(get(ctx, "SELECT name FROM accounts WHERE id = ?", ctx.accounts.Checking).name)
  },
  {
    name: "get_account_by_name",
    args: () => ({ name: "Checking" }),
    oracle: (result, ctx) => expect(result.id).toBe(get(ctx, "SELECT id FROM accounts WHERE name = 'Checking'").id)
  },
  {
    name: "get_asset_by_symbol",
    args: () => ({ symbol: "USD" }),
    oracle: (result, ctx) => expect(result.id).toBe(get(ctx, "SELECT id FROM assets WHERE symbol = 'USD'").id)
  },
  {
    name: "get_balance",
    args: (ctx) => ({ account_id: ctx.accounts.Checking, asset_id: ctx.assets.usd }),
    oracle: (result, ctx) => expect(result.balance_cents).toBe(Number(rawBalance(ctx, ctx.accounts.Checking, ctx.assets.usd, "posted")))
  },
  {
    name: "get_price",
    args: (ctx) => ({ asset_id: ctx.assets.eur, quote_id: ctx.assets.usd, as_of: "2026-06-30" }),
    oracle: (result, ctx) => expect(result.rate_value).toBe(Number(get(ctx, "SELECT rate_value FROM prices WHERE asset_id = ? AND quote_asset_id = ?", ctx.assets.eur, ctx.assets.usd).rate_value))
  },
  {
    name: "get_transaction",
    args: (ctx) => ({ id: ctx.tx.pay }),
    oracle: (result, ctx) => expect(result.entries).toHaveLength(sqlCount(ctx, "SELECT count(*) AS count FROM journal_lines WHERE journal_id = ?", ctx.tx.pay))
  },
  {
    name: "goal_progress",
    args: (ctx) => ({ account: ctx.accounts.Savings }),
    oracle: (result, ctx) => {
      expect(result.found).toBe(true);
      expect(result.target_cents).toBe(Number(get(ctx, "SELECT quantity FROM targets WHERE type = 'goal' AND account_id = ?", ctx.accounts.Savings).quantity));
    }
  },
  {
    name: "holdings",
    args: () => ({ asset_type: "security" }),
    oracle: (result, ctx) => expect(result[0].quantity).toBe(Number(get(ctx, "SELECT sum(l.quantity) AS quantity FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.type = 'asset' AND l.asset_id = (SELECT id FROM assets WHERE symbol = 'MSFT')").quantity))
  },
  {
    name: "income_statement",
    args: (ctx) => ({ year: 2026, month: 6, quote_asset_id: ctx.assets.usd }),
    oracle: (result, ctx) => {
      const expected = incomeExpense(ctx);
      expect(result.income).toBe(Number(expected.income));
      expect(result.expense).toBe(Number(expected.expense));
    }
  },
  {
    name: "inspect_transaction",
    args: (ctx) => ({ tx_id: ctx.tx.pay }),
    oracle: (result, ctx) => expect(result.integrity.balanced).toBe(get(ctx, "SELECT sum(quantity) AS total FROM journal_lines WHERE journal_id = ?", ctx.tx.pay).total === 0n)
  },
  {
    name: "integrity_check",
    args: () => ({}),
    oracle: (result, ctx) => {
      const unbalanced = sqlCount(ctx, "SELECT count(*) AS count FROM (SELECT journal_id, asset_id FROM journal_lines GROUP BY journal_id, asset_id HAVING sum(quantity) != 0)");
      expect(result.ok).toBe(unbalanced === 0);
    }
  },
  {
    name: "list_accounts",
    args: () => ({}),
    oracle: (result, ctx) => expect(result).toHaveLength(sqlCount(ctx, "SELECT count(*) AS count FROM accounts"))
  },
  {
    name: "list_assets",
    args: () => ({}),
    oracle: (result, ctx) => expect(result).toHaveLength(sqlCount(ctx, "SELECT count(*) AS count FROM assets"))
  },
  {
    name: "list_backups",
    args: () => ({}),
    oracle: (result, ctx) => expect(result).toHaveLength(readdirSync(join(ctx.dir, "backups")).length)
  },
  {
    name: "list_branches",
    args: () => ({}),
    oracle: (result, ctx) => expect(result).toHaveLength(sqlCount(ctx, "SELECT count(*) AS count FROM books WHERE type = 'scenario'"))
  },
  {
    name: "list_checkpoints",
    args: () => ({}),
    oracle: (result, ctx) => expect(result[0].id).toBe(ctx.checkpointId)
  },
  {
    name: "list_entries",
    args: (ctx) => ({ tx_id: ctx.tx.pay }),
    oracle: (result, ctx) => expect(result).toHaveLength(sqlCount(ctx, "SELECT count(*) AS count FROM journal_lines WHERE journal_id = ?", ctx.tx.pay))
  },
  {
    name: "list_entries_by_asset",
    args: (ctx) => ({ asset_id: ctx.assets.usd }),
    oracle: (result, ctx) => expect(result.entries).toHaveLength(sqlCount(ctx, "SELECT count(*) AS count FROM journal_lines WHERE asset_id = ?", ctx.assets.usd))
  },
  {
    name: "list_goals",
    args: () => ({}),
    oracle: (result, ctx) => expect(result).toHaveLength(sqlCount(ctx, "SELECT count(*) AS count FROM targets WHERE type = 'goal'"))
  },
  {
    name: "list_import_batches",
    args: () => ({}),
    oracle: (result, ctx) => expect(result[0].tx_count).toBe(sqlCount(ctx, "SELECT count(*) AS count FROM journals WHERE source_id = ?", ctx.batchId))
  },
  {
    name: "list_match_rules",
    args: () => ({}),
    oracle: (result, ctx) => expect(result).toHaveLength(sqlCount(ctx, "SELECT count(*) AS count FROM rules WHERE type = 'match' AND status = 'active'"))
  },
  {
    name: "list_prices",
    args: () => ({}),
    oracle: (result, ctx) => expect(result).toHaveLength(sqlCount(ctx, "SELECT count(*) AS count FROM prices"))
  },
  {
    name: "list_scheduled",
    args: () => ({}),
    oracle: (result, ctx) => expect(result).toHaveLength(sqlCount(ctx, "SELECT count(*) AS count FROM recurrences"))
  },
  {
    name: "list_tags",
    args: (ctx) => ({ entity_type: "tx", entity_id: ctx.tx.pay }),
    oracle: (result, ctx) => expect(result[0].id).toBe(ctx.tagId)
  },
  {
    name: "list_transactions",
    args: () => ({ status: "posted", compact: false }),
    oracle: (result, ctx) => expect(result.total).toBe(sqlCount(ctx, "SELECT count(*) AS count FROM journals WHERE status = 'posted'"))
  },
  {
    name: "list_uncategorized",
    args: (ctx) => ({ catch_all_account_id: ctx.accounts.Uncategorized, status: "pending" }),
    oracle: (result, ctx) => expect(result.total).toBe(sqlCount(ctx, "SELECT count(DISTINCT j.id) AS count FROM journals j JOIN journal_lines l ON l.journal_id = j.id WHERE j.status = 'pending' AND l.account_id = ?", ctx.accounts.Uncategorized))
  },
  {
    name: "list_unmatched_transfers",
    args: () => ({}),
    oracle: (result, ctx) => expect(result).toHaveLength(sqlCount(ctx, "SELECT count(*) AS count FROM annotations WHERE entity_type = 'tx' AND key = 'transfer' AND value = 'unmatched'"))
  },
  {
    name: "net_worth",
    args: (ctx) => ({ date: "2026-06-30", quote_asset_id: ctx.assets.usd }),
    oracle: (result) => expect(result.net_worth).toBe(result.total_assets + result.total_liabilities)
  },
  {
    name: "operating_manual",
    args: () => ({ topic: "safety" }),
    oracle: (result) => {
      expect(result.name).toBe("Clovis Operating Manual");
      expect(result.topic).toBe("safety");
      expect(result.recommended_tools).toContain("tool_registry");
      expect(result.warnings.join(" ")).toContain("dry-run");
    }
  },
  {
    name: "pending_summary",
    args: () => ({ year: 2026, month: 6 }),
    oracle: (result, ctx) => {
      expect(result.count).toBe(sqlCount(ctx, "SELECT count(*) AS count FROM journals WHERE status = 'pending' AND date BETWEEN '2026-06-01' AND '2026-06-30'"));
      expect(result.total_cents).toBe(Number(representativePendingTotal(ctx)));
    }
  },
  {
    name: "preview_commit",
    args: () => ({ as_of: "2026-06-30" }),
    oracle: (result, ctx) => expect(result.total_accounts).toBe(sqlCount(ctx, "SELECT count(*) AS count FROM (SELECT l.account_id FROM journal_lines l JOIN journals j ON j.id = l.journal_id WHERE j.status = 'pending' AND j.date <= '2026-06-30' GROUP BY l.account_id HAVING sum(l.quantity) != 0)"))
  },
  {
    name: "preview_import",
    args: (ctx) => ({ file_path: "statement.csv", account_id: ctx.accounts.Checking, counterpart_account_id: ctx.accounts["Opening Balances"] }),
    oracle: (result) => expect(result.total_rows).toBe(1)
  },
  {
    name: "project_balances",
    args: (ctx) => ({ through: "2026-06-30", include_goals: true, quote_asset_id: ctx.assets.usd }),
    oracle: (result, ctx) => {
      const expected = rootAccounts(ctx, ["asset", "liability"]).reduce((sum, accountId) => sum + quotedBalance(ctx, accountId, ctx.assets.usd, null, "2026-06-30").total, 0n);
      expect(result.net_worth_cents).toBe(Number(expected));
      expect(result.goals).toHaveLength(1);
    }
  },
  {
    name: "project_month_end",
    args: (ctx) => ({ year: 2026, month: 6, account_ids: [ctx.accounts.Checking, ctx.accounts["Credit Card"]], expected_inflows: [{ amount: 100 }], expected_outflows: [{ amount: 25 }], quote_asset_id: ctx.assets.usd }),
    oracle: (result, ctx) => {
      expect(result.asset_account_ids).toEqual([ctx.accounts.Checking]);
      expect(result.liability_account_ids).toEqual([ctx.accounts["Credit Card"]]);
      expect(result.projected_month_end_cents).toBe(result.available_cash_cents + 7500);
    }
  },
  {
    name: "reconcile_diff",
    args: (ctx) => ({ account_id: ctx.accounts.Checking, date_from: "2026-06-01", date_to: "2026-06-30" }),
    oracle: (result, ctx) => expect(result.transactions).toHaveLength(sqlCount(ctx, "SELECT count(DISTINCT j.id) AS count FROM journals j JOIN journal_lines l ON l.journal_id = j.id WHERE j.date BETWEEN '2026-06-01' AND '2026-06-30' AND l.account_id = ?", ctx.accounts.Checking))
  },
  {
    name: "reconcile_statement",
    args: (ctx) => ({ account_id: ctx.accounts.Checking, counterpart_id: ctx.accounts["Opening Balances"], transactions: [{ date: "2026-06-01", amount_cents: 100000, description: "June Pay" }] }),
    oracle: (result) => expect(result.reconciled).toBe(true)
  },
  {
    name: "reconcile_statement_plan",
    args: (ctx) => ({ file_path: "statement.csv", account_id: ctx.accounts.Checking, counterpart_account_id: ctx.accounts["Opening Balances"] }),
    oracle: (result) => expect(result.rows).toHaveLength(1)
  },
  {
    name: "search_transactions",
    args: () => ({ query: "Pay", status: "posted" }),
    oracle: (result, ctx) => expect(result.total).toBe(sqlCount(ctx, "SELECT count(*) AS count FROM journals WHERE status = 'posted' AND lower(description) LIKE '%pay%'"))
  },
  {
    name: "spending",
    args: (ctx) => ({ year: 2026, month: 6, quote_asset_id: ctx.assets.usd }),
    oracle: (result, ctx) => expect(result.total).toBe(Number([...expenseByAccount(ctx).values()].reduce((sum, value) => sum + value, 0n)))
  },
  {
    name: "spending_rate",
    args: (ctx) => ({ year: 2026, month: 6, quote_asset_id: ctx.assets.usd }),
    oracle: (result, ctx) => expect(result.find((row: Row) => row.account_id === ctx.accounts.Groceries).spent_cents).toBe(Number(expenseByAccount(ctx).get(ctx.accounts.Groceries) ?? 0n))
  },
  {
    name: "suggest_budgets",
    args: (ctx) => ({ months: 1, year: 2026, month: 6, quote_asset_id: ctx.assets.usd }),
    oracle: (result, ctx) => expect(result.map((row: Row) => row.account_id)).not.toContain(ctx.accounts.Groceries)
  },
  {
    name: "top_descriptions",
    args: (ctx) => ({ account_id: ctx.accounts.Checking, status: "posted" }),
    oracle: (result, ctx) => {
      const counts = new Map<string, { count: number; amount: bigint }>();
      for (const row of all(ctx, `
        SELECT j.description, l.quantity
        FROM journals j JOIN journal_lines l ON l.journal_id = j.id
        WHERE j.status = 'posted' AND l.account_id = ?
        ORDER BY j.date, j.id
      `, ctx.accounts.Checking)) {
        const current = counts.get(String(row.description)) ?? { count: 0, amount: 0n };
        current.count += 1;
        current.amount += BigInt(row.quantity) < 0n ? -BigInt(row.quantity) : BigInt(row.quantity);
        counts.set(String(row.description), current);
      }
      const [description, top] = [...counts.entries()].sort((a, b) => b[1].count - a[1].count)[0];
      expect(result[0]).toMatchObject({ description, count: top.count, amount_cents: Number(top.amount) });
    }
  },
  {
    name: "tool_registry",
    args: () => ({}),
    oracle: (result) => {
      expect(result.count).toBe(TOOL_NAMES.length);
      expect(result.tools.find((tool: Row) => tool.name === "list_accounts").safety.readOnlyHint).toBe(true);
      expect(result.tools.find((tool: Row) => tool.name === "delete_transaction").safety.destructiveHint).toBe(true);
      expect(result.file_access.mode).toBe("unrestricted");
    },
    cli: false
  },
  {
    name: "trial_balance",
    args: (ctx) => ({ asset_id: ctx.assets.usd }),
    oracle: (result, ctx) => expect(result.total).toBe(Number(get(ctx, "SELECT coalesce(sum(l.quantity), 0) AS total FROM journal_lines l JOIN journals j ON j.id = l.journal_id WHERE j.status = 'posted' AND l.asset_id = ?", ctx.assets.usd).total))
  },
  {
    name: "unbudgeted_spending",
    args: (ctx) => ({ year: 2026, month: 6, quote_asset_id: ctx.assets.usd }),
    oracle: (result, ctx) => {
      const budgeted = new Set(all(ctx, "SELECT account_id FROM targets WHERE type = 'budget'").map((row) => String(row.account_id)));
      expect(result.map((row: Row) => row.account_id).sort()).toEqual([...expenseByAccount(ctx).keys()].filter((id) => !budgeted.has(id)).sort());
    }
  }
];

describe("read tool SQLite oracle audit", () => {
  it("has a raw SQLite oracle for every read-only tool", () => {
    const readNames = new Set(READ_CASES.map((row) => row.name));
    expect(readNames.size).toBe(READ_CASES.length);
    expect(readNames.size).toBe(70);
    for (const name of readNames) expect(TOOL_NAMES).toContain(name);
  });

  it("matches raw SQLite oracles and generic CLI output for every read-only tool", () => {
    const ctx = createOracleContext();
    try {
      for (const row of READ_CASES) {
        const args = row.args(ctx);
        const before = JSON.stringify(all(ctx, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((table) => all(ctx, `SELECT * FROM ${table.name} ORDER BY rowid`)), (_key, value) => typeof value === "bigint" ? value.toString() : value);
        const result = callTool(row.name, args, ctx.ledger);
        const after = JSON.stringify(all(ctx, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((table) => all(ctx, `SELECT * FROM ${table.name} ORDER BY rowid`)), (_key, value) => typeof value === "bigint" ? value.toString() : value);
        expect(after, `${row.name} mutated the ledger`).toBe(before);
        row.oracle(result, ctx);
        if (row.cli !== false) expectCliMatches(row.name, args, result, ctx);
      }
    } finally {
      ctx.ledger.close();
    }
  }, 30000);
});
