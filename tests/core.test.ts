import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { Ledger, debitCredit, normalAmount, normalSide, toAtomicUnits } from "../src/core/index.js";
import { callTool, TOOL_NAMES } from "../src/app/index.js";
import { toolHandlers } from "../src/app/catalog.js";
import { defaultDbPath, mcpDbPathFromEnv } from "../src/app/context.js";
import { TOOL_DEFINITIONS, TOOL_SIGNATURES } from "../src/app/signatures.js";
import { inputShapeFromDefinition, inputSchemaFromDefinition } from "../src/mcp/tools.js";

// Core tests are invariant-oriented: schema shape, balancing, currency scale,
// reports, imports, and public command behavior all meet here.
const dirs: string[] = [];
const execFileAsync = promisify(execFile);

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

  it("creates schema v4 and default book", () => {
    const ledger = tempLedger();
    try {
      const tables = new Set((ledger.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
      for (const table of ["books", "journals", "journal_lines", "annotations", "sources", "targets", "period_closes", "recurrences", "migration_history", "statement_plans", "statement_plan_rows", "ledger_operations", "ledger_operation_rows"]) {
        expect(tables.has(table)).toBe(true);
      }
      const columns = (table: string) => new Set((ledger.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
      expect((ledger.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as any).value).toBe("4");
      expect(columns("journal_lines").has("quantity")).toBe(true);
      expect(columns("journal_lines").has("book_id")).toBe(true);
      expect(columns("journals").has("finalized_at")).toBe(true);
      expect(columns("accounts").has("default_asset_id")).toBe(true);
      expect(columns("assets").has("scale")).toBe(true);
      expect(columns("prices").has("quote_asset_id")).toBe(true);
      expect(columns("sources").has("book_id")).toBe(true);
      expect(columns("annotations").has("book_id")).toBe(true);
      expect(columns("targets").has("quantity")).toBe(true);
      expect(columns("recurrences").has("quantity")).toBe(true);
      expect(columns("lots").has("opened_journal_id")).toBe(true);
      expect(columns("lots").has("status")).toBe(true);
      expect(columns("ledger_operations").has("operation_type")).toBe(true);
      expect(columns("ledger_operation_rows").has("correction_journal_id")).toBe(true);
      expect(columns("statement_plans").has("planned_balance")).toBe(true);
      expect(columns("statement_plan_rows").has("row_hash")).toBe(true);
    } finally {
      ledger.close();
    }
  });

  it("lets direct SQL stage draft journals and finalizes them under SQLite invariants", () => {
    const ledger = tempLedger();
    try {
      const usd = ledger.createAsset("USD", "currency", 2);
      const checking = ledger.createAccount("Checking", "asset");
      const equity = ledger.createAccount("Equity", "equity");

      expect(() => ledger.db.prepare(
        "INSERT INTO journals(id, book_id, date, posted_at, finalized_at, status, description) VALUES ('tx_bad_insert', ?, '2026-06-01', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z', 'posted', 'bad')"
      ).run(ledger.bookId)).toThrow(/draft/);

      ledger.db.prepare("INSERT INTO journals(id, book_id, date, posted_at, status, description) VALUES ('tx_sql', ?, '2026-06-01', '2026-06-01T00:00:00Z', 'posted', 'direct sql')").run(ledger.bookId);
      ledger.db.prepare("INSERT INTO journal_lines(id, book_id, journal_id, line_no, account_id, asset_id, quantity) VALUES ('line_sql_1', ?, 'tx_sql', 1, ?, ?, 100)").run(ledger.bookId, checking, usd);
      ledger.db.prepare("INSERT INTO journal_lines(id, book_id, journal_id, line_no, account_id, asset_id, quantity) VALUES ('line_sql_2', ?, 'tx_sql', 2, ?, ?, -100)").run(ledger.bookId, equity, usd);

      expect(ledger.listTransactions({ status: null }).map((tx) => tx.id)).not.toContain("tx_sql");
      ledger.db.prepare("UPDATE journals SET finalized_at = '2026-06-01T00:00:01Z' WHERE book_id = ? AND id = 'tx_sql'").run(ledger.bookId);
      expect(ledger.listTransactions({ status: null }).map((tx) => tx.id)).toContain("tx_sql");
      expect(ledger.balance(checking, usd)).toBe(100n);

      expect(() => ledger.db.prepare("UPDATE journal_lines SET quantity = 200 WHERE id = 'line_sql_1'").run()).toThrow(/finalized/);
      expect(() => ledger.db.prepare("DELETE FROM journal_lines WHERE id = 'line_sql_1'").run()).toThrow(/finalized/);
      expect(() => ledger.db.prepare("INSERT INTO journal_lines(id, book_id, journal_id, line_no, account_id, asset_id, quantity) VALUES ('line_sql_3', ?, 'tx_sql', 3, ?, ?, 0)").run(ledger.bookId, checking, usd)).toThrow(/finalized/);

      ledger.db.prepare("INSERT INTO journals(id, book_id, date, posted_at, status, description) VALUES ('tx_unbalanced', ?, '2026-06-02', '2026-06-02T00:00:00Z', 'posted', 'bad')").run(ledger.bookId);
      ledger.db.prepare("INSERT INTO journal_lines(id, book_id, journal_id, line_no, account_id, asset_id, quantity) VALUES ('line_bad_1', ?, 'tx_unbalanced', 1, ?, ?, 1)").run(ledger.bookId, checking, usd);
      expect(() => ledger.db.prepare("UPDATE journals SET finalized_at = '2026-06-02T00:00:01Z' WHERE book_id = ? AND id = 'tx_unbalanced'").run(ledger.bookId)).toThrow(/balance/);
    } finally {
      ledger.close();
    }
  });

  it("enforces closed periods in direct SQL finalization and reopening", () => {
    const ledger = tempLedger();
    try {
      const usd = ledger.createAsset("USD", "currency", 2);
      const checking = ledger.createAccount("Checking", "asset");
      const equity = ledger.createAccount("Equity", "equity");
      const posted = ledger.recordTransaction("2026-06-01", 100n, equity, checking, usd, "Posted before close", "posted");
      ledger.closePeriod("June close", "2026-06-30");

      ledger.db.prepare("INSERT INTO journals(id, book_id, date, posted_at, status, description) VALUES ('tx_closed_sql', ?, '2026-06-15', '2026-06-15T00:00:00Z', 'posted', 'closed draft')").run(ledger.bookId);
      ledger.db.prepare("INSERT INTO journal_lines(id, book_id, journal_id, line_no, account_id, asset_id, quantity) VALUES ('line_closed_1', ?, 'tx_closed_sql', 1, ?, ?, 50)").run(ledger.bookId, checking, usd);
      ledger.db.prepare("INSERT INTO journal_lines(id, book_id, journal_id, line_no, account_id, asset_id, quantity) VALUES ('line_closed_2', ?, 'tx_closed_sql', 2, ?, ?, -50)").run(ledger.bookId, equity, usd);

      expect(() => ledger.db.prepare("UPDATE journals SET finalized_at = '2026-06-15T00:00:01Z' WHERE book_id = ? AND id = 'tx_closed_sql'").run(ledger.bookId)).toThrow(/closed period/);
      expect(() => ledger.db.prepare("UPDATE journals SET finalized_at = NULL WHERE book_id = ? AND id = ?").run(ledger.bookId, posted.id)).toThrow(/closed period/);
      expect(ledger.listTransactions({ status: null }).map((tx) => tx.id)).not.toContain("tx_closed_sql");
      expect(ledger.getTx(posted.id)?.status).toBe("posted");
    } finally {
      ledger.close();
    }
  });

  it("migrates a fully populated schema v1 ledger to v2 without losing data", () => {
    const dir = mkdtempSync(join(tmpdir(), "clovis-npm-v1-"));
    dirs.push(dir);
    const dbPath = join(dir, "legacy.db");
    const db = new DatabaseSync(dbPath, { readBigInts: true });
    try {
      db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO meta(key, value) VALUES ('schema_version', '1');
        CREATE TABLE books(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, type TEXT NOT NULL, parent_id TEXT, created_at TEXT NOT NULL, closed_at TEXT);
        INSERT INTO books(id, name, type, parent_id, created_at) VALUES ('book_default', 'Actual', 'actual', NULL, '1970-01-01T00:00:00Z');
        CREATE TABLE assets(id TEXT PRIMARY KEY, symbol TEXT NOT NULL UNIQUE, type TEXT NOT NULL, scale INTEGER NOT NULL, name TEXT NOT NULL DEFAULT '');
        INSERT INTO assets(id, symbol, type, scale, name) VALUES ('asset_usd', 'USD', 'currency', 2, 'US Dollar');
        INSERT INTO assets(id, symbol, type, scale, name) VALUES ('asset_aapl', 'AAPL', 'security', 8, 'AAPL');
        CREATE TABLE accounts(id TEXT PRIMARY KEY, book_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, parent_id TEXT, code TEXT NOT NULL DEFAULT '', color_hex TEXT NOT NULL DEFAULT '#888888', status TEXT NOT NULL DEFAULT 'active', UNIQUE(id, book_id), UNIQUE(book_id, name));
        INSERT INTO accounts(id, book_id, name, type) VALUES
          ('acct_checking', 'book_default', 'Checking', 'asset'),
          ('acct_equity', 'book_default', 'Equity', 'equity'),
          ('acct_holding', 'book_default', 'AAPL Holdings', 'asset'),
          ('acct_cost', 'book_default', 'Investment Cost', 'expense');
        CREATE TABLE annotations(id TEXT PRIMARY KEY, book_id TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL);
        INSERT INTO annotations(id, book_id, entity_type, entity_id, key, value) VALUES ('ann_default', 'book_default', 'account', 'acct_checking', 'default_asset', 'asset_usd');
        CREATE TABLE sources(id TEXT PRIMARY KEY, book_id TEXT NOT NULL, type TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', UNIQUE(id, book_id));
        INSERT INTO sources(id, book_id, type, label, status, created_at, metadata_json) VALUES ('batch_legacy', 'book_default', 'import', 'Legacy batch', 'open', '2026-06-01T00:00:00Z', '{"fixture":true}');
        CREATE TABLE journals(id TEXT PRIMARY KEY, book_id TEXT NOT NULL, source_id TEXT, date TEXT NOT NULL, posted_at TEXT NOT NULL, status TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', external_id TEXT, UNIQUE(id, book_id));
        INSERT INTO journals(id, book_id, source_id, date, posted_at, status, description) VALUES
          ('tx_legacy', 'book_default', 'batch_legacy', '2026-06-01', '2026-06-01T00:00:00Z', 'posted', 'legacy'),
          ('tx_buy', 'book_default', NULL, '2026-06-02', '2026-06-02T00:00:00Z', 'posted', 'Buy AAPL');
        CREATE TABLE journal_lines(id TEXT PRIMARY KEY, book_id TEXT NOT NULL, journal_id TEXT NOT NULL, line_no INTEGER NOT NULL, account_id TEXT NOT NULL, asset_id TEXT NOT NULL, quantity INTEGER NOT NULL, memo TEXT NOT NULL DEFAULT '', UNIQUE(journal_id, line_no));
        INSERT INTO journal_lines(id, book_id, journal_id, line_no, account_id, asset_id, quantity) VALUES
          ('line_1', 'book_default', 'tx_legacy', 1, 'acct_checking', 'asset_usd', 500),
          ('line_2', 'book_default', 'tx_legacy', 2, 'acct_equity', 'asset_usd', -500),
          ('line_3', 'book_default', 'tx_buy', 1, 'acct_checking', 'asset_usd', -1000),
          ('line_4', 'book_default', 'tx_buy', 2, 'acct_cost', 'asset_usd', 1000),
          ('line_5', 'book_default', 'tx_buy', 3, 'acct_cost', 'asset_aapl', -100000000),
          ('line_6', 'book_default', 'tx_buy', 4, 'acct_holding', 'asset_aapl', 100000000);
        CREATE TABLE prices(id TEXT PRIMARY KEY, book_id TEXT NOT NULL, asset_id TEXT NOT NULL, quote_asset_id TEXT NOT NULL, rate_value INTEGER NOT NULL, rate_scale INTEGER NOT NULL, time TEXT NOT NULL, UNIQUE(id, book_id));
        INSERT INTO prices(id, book_id, asset_id, quote_asset_id, rate_value, rate_scale, time) VALUES ('price_legacy', 'book_default', 'asset_aapl', 'asset_usd', 1000, 2, '2026-06-02');
        CREATE TABLE rules(id TEXT PRIMARY KEY, book_id TEXT NOT NULL, type TEXT NOT NULL, account_id TEXT, pattern TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 100, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, UNIQUE(id, book_id));
        INSERT INTO rules(id, book_id, type, account_id, pattern, created_at) VALUES ('rule_legacy', 'book_default', 'match', 'acct_cost', 'AAPL', '2026-06-01T00:00:00Z');
        CREATE TABLE targets(id TEXT PRIMARY KEY, book_id TEXT NOT NULL, type TEXT NOT NULL, account_id TEXT NOT NULL, asset_id TEXT NOT NULL, quantity INTEGER NOT NULL, period TEXT, year INTEGER, month INTEGER, rollover_rule TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', target_date TEXT, priority INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'active', UNIQUE(id, book_id));
        INSERT INTO targets(id, book_id, type, account_id, asset_id, quantity, period, year, month, rollover_rule, name, target_date, priority) VALUES
          ('budget_legacy', 'book_default', 'budget', 'acct_cost', 'asset_usd', 1000, 'monthly', 2026, 6, '', '', NULL, 1),
          ('goal_legacy', 'book_default', 'goal', 'acct_checking', 'asset_usd', 2000, NULL, NULL, NULL, '', 'Reserve', NULL, 1);
        CREATE TABLE recurrences(id TEXT PRIMARY KEY, book_id TEXT NOT NULL, next_date TEXT NOT NULL, quantity INTEGER NOT NULL, from_account_id TEXT NOT NULL, to_account_id TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', frequency TEXT NOT NULL, end_date TEXT, asset_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', UNIQUE(id, book_id));
        INSERT INTO recurrences(id, book_id, next_date, quantity, from_account_id, to_account_id, description, frequency, end_date, asset_id, status) VALUES ('sched_legacy', 'book_default', '2026-07-01', 100, 'acct_equity', 'acct_checking', 'Legacy scheduled', 'monthly', NULL, 'asset_usd', 'active');
        CREATE TABLE period_closes(id TEXT PRIMARY KEY, book_id TEXT NOT NULL, name TEXT NOT NULL, as_of TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL, reopened_at TEXT, UNIQUE(id, book_id));
        INSERT INTO period_closes(id, book_id, name, as_of, description, created_at, reopened_at) VALUES ('period_legacy', 'book_default', 'May close', '2026-05-31', NULL, '2026-06-01T00:00:00Z', NULL);
        CREATE TABLE lots(id TEXT PRIMARY KEY, book_id TEXT NOT NULL, account_id TEXT NOT NULL, asset_id TEXT NOT NULL, quantity INTEGER NOT NULL, cost_asset_id TEXT NOT NULL, cost_quantity INTEGER NOT NULL, opened_journal_id TEXT NOT NULL, closed_journal_id TEXT, opened_at TEXT NOT NULL, closed_at TEXT, status TEXT NOT NULL DEFAULT 'open', metadata_json TEXT NOT NULL DEFAULT '{}', UNIQUE(id, book_id));
        INSERT INTO lots(id, book_id, account_id, asset_id, quantity, cost_asset_id, cost_quantity, opened_journal_id, opened_at, status) VALUES ('lot_legacy', 'book_default', 'acct_holding', 'asset_aapl', 100000000, 'asset_usd', 1000, 'tx_buy', '2026-06-02', 'open');
      `);
    } finally {
      db.close();
    }

    const ledger = new Ledger(dbPath);
    try {
      expect((ledger.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as any).value).toBe("4");
      expect(ledger.getAccount("acct_checking")?.default_asset_id).toBe("asset_usd");
      expect((ledger.db.prepare("SELECT finalized_at FROM journals WHERE id = 'tx_legacy'").get() as any).finalized_at).toBe("2026-06-01T00:00:00Z");
      expect(ledger.listTransactions({ status: null }).map((tx) => tx.id)).toContain("tx_legacy");
      expect((ledger.db.prepare("SELECT count(*) AS c FROM migration_history WHERE version = 2").get() as any).c).toBe(1n);
      expect((ledger.db.prepare("SELECT count(*) AS c FROM migration_history WHERE version = 3").get() as any).c).toBe(1n);
      expect((ledger.db.prepare("SELECT count(*) AS c FROM migration_history WHERE version = 4").get() as any).c).toBe(1n);
      expect(ledger.listSources("import", null)).toHaveLength(1);
      expect(ledger.listPrices()).toHaveLength(1);
      expect(ledger.listRules("match")).toHaveLength(1);
      expect(ledger.listBudgetTargets()).toHaveLength(1);
      expect(ledger.listGoalTargets()).toHaveLength(1);
      expect(ledger.listRecurrences()).toHaveLength(1);
      expect(ledger.listCheckpoints()).toHaveLength(1);
      expect(ledger.listLots()).toHaveLength(1);
      expect(ledger.integrityCheck().ok).toBe(true);
    } finally {
      ledger.close();
    }
  });

  it("clones scenario books into isolated active books with remapped graph data", () => {
    const ledger = tempLedger();
    try {
      const usd = ledger.createAsset("USD", "currency", 2);
      const cad = ledger.createAsset("CAD", "currency", 2);
      const checking = ledger.createAccount("Checking", "asset");
      const brokerage = ledger.createAccount("Brokerage", "asset");
      const equity = ledger.createAccount("Equity", "equity");
      const groceries = ledger.createAccount("Groceries", "expense");
      ledger.updateAccount(checking, { default_asset_id: usd });
      const sourceId = ledger.createSource("import", "Scenario source", { fixture: true });
      const seed = ledger.recordTransaction("2026-06-01", 1000n, equity, checking, usd, "Seed", "posted", { sourceId });
      ledger.createAnnotation("tx", seed.id, "memo", "seed memo");
      const ruleId = ledger.createRule("match", groceries, "Market");
      const budget = ledger.setBudget(groceries, usd, 500n, "monthly", 2026, 6, false);
      const goal = ledger.setGoal(checking, usd, 2500n, "Reserve", null, 1);
      const recurrence = ledger.createRecurrence("2026-07-01", 100n, checking, groceries, "Scheduled groceries", "monthly", null, usd);
      const priceId = ledger.createPrice(usd, cad, "1.25", "2026-06-01");
      const close = ledger.closePeriod("Prior close", "2026-05-31");
      const buy = ledger.recordSecurityPurchase({ symbol: "AAPL", shares: 150000000n, totalCost: 12345n, cashAssetId: usd, investmentAccountId: brokerage, date: "2026-06-02" });
      const originalLot = ledger.listLots()[0];

      const scenario = ledger.createScenarioBook("what-if");
      const scenarioLedger = new Ledger(ledger.path, { bookId: String(scenario.id) });
      try {
        const scenarioChecking = scenarioLedger.findAccount("Checking")!;
        const scenarioBrokerage = scenarioLedger.findAccount("Brokerage")!;
        const scenarioEquity = scenarioLedger.findAccount("Equity")!;
        const scenarioGroceries = scenarioLedger.findAccount("Groceries")!;
        const scenarioHolding = scenarioLedger.findAccount("AAPL Holdings")!;
        expect(scenarioChecking.id).not.toBe(checking);
        expect(scenarioBrokerage.id).not.toBe(brokerage);
        expect(scenarioChecking.default_asset_id).toBe(usd);
        expect(scenarioLedger.balance(scenarioChecking.id, usd)).toBe(1000n);

        const scenarioSource = scenarioLedger.listSources("import", null)[0];
        expect(scenarioSource.id).not.toBe(sourceId);
        expect(scenarioSource.label).toBe("Scenario source");

        const scenarioTxs = scenarioLedger.listTransactions({ status: null });
        const scenarioSeed = scenarioTxs.find((tx) => tx.description === "Seed")!;
        const scenarioBuy = scenarioTxs.find((tx) => tx.description === "Buy AAPL")!;
        expect(scenarioSeed.id).not.toBe(seed.id);
        expect(scenarioSeed.source_id).toBe(scenarioSource.id);
        expect(scenarioLedger.listAnnotations("tx", scenarioSeed.id)).toContainEqual(expect.objectContaining({ key: "memo", value: "seed memo" }));
        expect(scenarioBuy.id).not.toBe(buy.id);

        const scenarioRule = scenarioLedger.listRules("match")[0];
        expect(scenarioRule.id).not.toBe(ruleId);
        expect(scenarioRule.account_id).toBe(scenarioGroceries.id);
        expect(scenarioRule.pattern).toBe("Market");

        const scenarioBudget = scenarioLedger.listBudgetTargets({ accountId: scenarioGroceries.id })[0];
        expect(scenarioBudget.id).not.toBe(budget.id);
        expect(scenarioBudget.quantity).toBe(500n);
        expect(scenarioBudget.asset_id).toBe(usd);

        const scenarioGoal = scenarioLedger.getGoalTarget(scenarioChecking.id)!;
        expect(scenarioGoal.id).not.toBe(goal.id);
        expect(scenarioGoal.quantity).toBe(2500n);

        const scenarioRecurrence = scenarioLedger.listRecurrences()[0];
        expect(scenarioRecurrence.id).not.toBe(recurrence.id);
        expect(scenarioRecurrence.from_account_id).toBe(scenarioChecking.id);
        expect(scenarioRecurrence.to_account_id).toBe(scenarioGroceries.id);

        const scenarioPrice = scenarioLedger.listPrices()[0];
        expect(scenarioPrice.id).not.toBe(priceId);
        expect(scenarioPrice.asset_id).toBe(usd);
        expect(scenarioPrice.quote_asset_id).toBe(cad);

        const scenarioClose = scenarioLedger.listCheckpoints()[0];
        expect(scenarioClose.id).not.toBe(close.id);
        expect(scenarioClose.name).toBe("Prior close");

        const scenarioLot = scenarioLedger.listLots()[0];
        expect(scenarioLot.id).not.toBe(originalLot.id);
        expect(scenarioLot.account_id).toBe(scenarioHolding.id);
        expect(scenarioLot.opened_journal_id).toBe(scenarioBuy.id);
        expect(scenarioLot.asset_id).toBe(originalLot.asset_id);

        scenarioLedger.recordTransaction("2026-06-02", 250n, scenarioEquity.id, scenarioChecking.id, usd, "Scenario seed", "posted");
        expect(scenarioLedger.balance(scenarioChecking.id, usd)).toBe(1250n);
        expect(ledger.balance(checking, usd)).toBe(1000n);
        expect(ledger.balance(brokerage, usd)).toBe(-12345n);
        expect(scenarioLedger.balance(scenarioBrokerage.id, usd)).toBe(-12345n);
      } finally {
        scenarioLedger.close();
      }
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

  it("rejects account parent cycles before reports can lose balances", () => {
    const ledger = tempLedger();
    try {
      const usd = ledger.createAsset("USD", "currency", 2);
      const parent = ledger.createAccount("Parent", "asset");
      const child = ledger.createAccount("Child", "asset", parent);
      const equity = ledger.createAccount("Equity", "equity");
      ledger.recordTransaction("2026-06-01", 100n, equity, child, usd, "Seed", "posted");

      expect(() => ledger.updateAccount(parent, { parent_id: parent })).toThrow(/own parent/);
      expect(() => ledger.updateAccount(parent, { parent_id: child })).toThrow(/cycle/);
      expect(ledger.balanceSheet("2026-06-30", usd).total_assets).toBe(100n);

      const doc = {
        format: "clovis-ledger-v1",
        assets: [{ id: "asset_usd", symbol: "USD", type: "currency", scale: 2 }],
        accounts: [
          { id: "acct_a", name: "A", type: "asset", parent_id: "acct_b" },
          { id: "acct_b", name: "B", type: "asset", parent_id: "acct_a" }
        ]
      };
      const target = tempLedger();
      try {
        const dryRun = target.importDocument(doc, true, true);
        expect(dryRun.valid).toBe(false);
        expect(dryRun.errors.join("\n")).toMatch(/cycle/);
      } finally {
        target.close();
      }
    } finally {
      ledger.close();
    }
  });

  it("rejects invalid persisted scalar values through core write paths", () => {
    const ledger = tempLedger();
    try {
      const usd = ledger.createAsset("USD", "currency", 2);
      const checking = ledger.createAccount("Checking", "asset");
      const equity = ledger.createAccount("Equity", "equity");
      const food = ledger.createAccount("Food", "expense");

      expect(() => ledger.createAsset("WEIRD", "currency", 2.5)).toThrow(/scale/);
      expect(() => ledger.createPrice(usd, usd, "0", "2026-06-01")).toThrow(/positive/);
      expect(() => ledger.createPrice(usd, usd, "-1.00", "2026-06-01")).toThrow(/positive/);
      expect(() => ledger.setBudget(food, usd, 100n, "monthly", 2026, 13)).toThrow(/month/);
      expect(() => ledger.setGoal(checking, usd, 100n, "Bad date", "2026-99-99")).toThrow(/date/);
      expect(() => ledger.createRecurrence("2026-06-01", 100n, equity, checking, "Bad", "nonsense", null, usd)).toThrow(/frequency/);
      expect(() => ledger.createRecurrence("2026-06-01", 0n, equity, checking, "Bad", "monthly", null, usd)).toThrow(/positive/);
      expect(() => ledger.recordTransaction("2026-06-01", 0n, equity, checking, usd, "Bad", "posted")).toThrow(/positive/);
      expect(() => ledger.recordTransaction("2026-06-01", -100n, equity, checking, usd, "Bad", "posted")).toThrow(/positive/);
    } finally {
      ledger.close();
    }
  });
});

describe("app and package surface", () => {
  it("keeps every MCP tool name wired to a signature and handler", () => {
    expect(Object.keys(TOOL_SIGNATURES).sort()).toEqual([...TOOL_NAMES].sort());
    expect(TOOL_SIGNATURES.create_transaction).toBe("(date: string, amount: number, from_account_id: string, to_account_id: string, description: string, status?: string, asset_id?: string | null, branch?: string | null, dry_run?: boolean) => Record<string, unknown>");
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
      const brokerage = (callTool("create_account", { name: "Brokerage", type: "asset", default_asset_id: usd }, source) as any).id;
      callTool("create_transaction", { date: "2026-06-01", amount: 25, from_account_id: equity, to_account_id: checking, description: "Seed", status: "posted" }, source);
      callTool("create_price", { asset_id: usd, quote_id: usd, rate: "1.00", time: "2026-06-01" }, source);
      callTool("set_budget", { account: groceries, amount: 100, year: 2026, month: 6 }, source);
      callTool("set_goal", { account: checking, target: 500, name: "Emergency" }, source);
      callTool("create_scheduled_transaction", { date: "2026-06-15", amount: 5, from_account_id: checking, to_account_id: groceries, description: "Planned groceries", frequency: "monthly" }, source);
      callTool("buy_security", { account_id: brokerage, symbol: "AAPL", shares: "1.5", total_cost_cents: 12345, date: "2026-06-02" }, source);
      const exported = callTool("export_ledger", {}, source) as any;
      const doc = JSON.parse(exported.data);
      const imported = callTool("import_ledger", { data: exported.data }, target) as any;
      expect(init.accounts_created).toBeGreaterThan(0);
      expect(imported.transactions).toBe(doc.transactions.length);
      expect((callTool("integrity_check", {}, target) as any).ok).toBe(true);
      expect(target.listPrices()).toHaveLength(doc.prices.length);
      expect(target.listLots()).toHaveLength(doc.lots.length);
      expect(target.listRecurrences()).toHaveLength(doc.scheduled_transactions.length);
      expect(String(target.listLots()[0].opened_journal_id)).toEqual(expect.stringMatching(/^tx_/));
      expect((target.db.prepare("SELECT quantity, period, year, month FROM targets WHERE type = 'budget'").get() as any)).toMatchObject({ quantity: 10000n, period: "monthly", year: 2026n, month: 6n });
      expect((target.db.prepare("SELECT quantity, name FROM targets WHERE type = 'goal'").get() as any)).toMatchObject({ quantity: 50000n, name: "Emergency" });

      const importedFresh = callTool("import_ledger", { data: exported.data, preserve_ids: false }, fresh) as any;
      expect(importedFresh.transactions).toBe(doc.transactions.length);
      expect((callTool("integrity_check", {}, fresh) as any).ok).toBe(true);
      expect(new Set(fresh.listTransactions({ status: null }).map((tx) => tx.id))).not.toEqual(new Set(source.listTransactions({ status: null }).map((tx) => tx.id)));
    } finally {
      source.close();
      target.close();
      fresh.close();
    }
  });

  it("remaps rollback metadata when importing with fresh ids", () => {
    const importSource = tempLedger();
    const recatSource = tempLedger();
    const importTarget = tempLedger();
    const recatTarget = tempLedger();
    try {
      const usd = importSource.createAsset("USD", "currency", 2);
      const checking = importSource.createAccount("Checking", "asset");
      const equity = importSource.createAccount("Equity", "equity");
      const imported = callTool("import_transactions", {
        account_id: checking,
        counterpart_id: equity,
        asset_id: usd,
        batch_label: "Imported statement",
        transactions: [{ date: "2026-06-01", amount: 25, description: "Deposit" }]
      }, importSource) as any;
      const importSnapshot = callTool("export_ledger", {}, importSource) as any;
      callTool("import_ledger", { data: importSnapshot.data, preserve_ids: false }, importTarget);
      const importedTx = importTarget.listTransactions({ status: null })[0];
      const newBatchId = importTarget.getTx(importedTx.id)?.source_id;
      expect(newBatchId).toBeTruthy();
      expect(newBatchId).not.toBe(imported.batch_id);
      expect(importTarget.listAnnotations("tx", importedTx.id)).toContainEqual(expect.objectContaining({ key: "import_batch", value: newBatchId }));
      const staleRollback = callTool("rollback_import", { batch_id: imported.batch_id }, importTarget) as any;
      expect(staleRollback.rolled_back).toBe(0);
      expect(importTarget.getTx(importedTx.id)?.status).toBe("pending");

      const recatUsd = recatSource.createAsset("USD", "currency", 2);
      const sourceChecking = recatSource.createAccount("Checking", "asset");
      const oldExpense = recatSource.createAccount("Old Expense", "expense");
      const newExpense = recatSource.createAccount("New Expense", "expense");
      recatSource.recordTransaction("2026-06-02", 1500n, sourceChecking, oldExpense, recatUsd, "Market", "posted");
      const recat = callTool("recategorize_by_pattern", { pattern: "Market", new_account_id: newExpense, old_account_id: oldExpense, status: "posted", dry_run: false }, recatSource) as any;
      const recatSnapshot = callTool("export_ledger", {}, recatSource) as any;
      callTool("import_ledger", { data: recatSnapshot.data, preserve_ids: false }, recatTarget);
      const targetAccounts = Object.fromEntries(recatTarget.listAccounts().map((row) => [row.name, row.id]));
      const targetTx = recatTarget.listTransactions({ status: null })[0];
      expect(recatTarget.getEntries(targetTx.id)).toContainEqual(expect.objectContaining({ account_id: targetAccounts["New Expense"], quantity: 1500n }));

      const rollback = callTool("rollback_recategorize", { batch_id: recat.batch_id }, recatTarget) as any;
      expect(rollback.rolled_back).toBe(1);
      expect(recatTarget.getEntries(targetTx.id)).toContainEqual(expect.objectContaining({ account_id: targetAccounts["Old Expense"], quantity: 1500n }));
    } finally {
      importSource.close();
      recatSource.close();
      importTarget.close();
      recatTarget.close();
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

  it("projects explicit native account balances through the app surface", () => {
    const ledger = tempLedger();
    try {
      callTool("init_defaults", { template: "personal", currency: "USD" }, ledger);
      const accounts = Object.fromEntries((callTool("list_accounts", {}, ledger) as any[]).map((row) => [row.name, row.id]));
      const usd = (callTool("get_asset_by_symbol", { symbol: "USD" }, ledger) as any).id;
      const cad = (callTool("create_asset", { symbol: "CAD", asset_type: "currency", decimals: 2 }, ledger) as any).id;
      const cadCash = (callTool("create_account", { name: "CAD Cash", type: "asset", default_asset_id: cad }, ledger) as any).id;
      const cadEquity = (callTool("create_account", { name: "CAD Equity", type: "equity", default_asset_id: cad }, ledger) as any).id;
      const wallet = (callTool("create_account", { name: "Wallet", type: "asset", default_asset_id: usd }, ledger) as any).id;
      const pocket = (callTool("create_account", { name: "Pocket Cash", type: "asset", parent_id: wallet, default_asset_id: usd }, ledger) as any).id;

      callTool("create_transaction", { date: "2026-06-01", amount: 2000, from_account_id: accounts.Salary, to_account_id: accounts.Checking, description: "Posted pay", status: "posted" }, ledger);
      callTool("create_transaction", { date: "2026-06-02", amount: 50, from_account_id: accounts.Salary, to_account_id: accounts.Checking, description: "Pending pay", status: "pending" }, ledger);
      callTool("create_transaction", { date: "2026-06-03", amount: 100, from_account_id: cadEquity, to_account_id: cadCash, description: "CAD seed", status: "posted" }, ledger);
      callTool("create_transaction", { date: "2026-06-04", amount: 25, from_account_id: cadEquity, to_account_id: cadCash, description: "CAD pending", status: "pending" }, ledger);
      callTool("create_transaction", { date: "2026-06-05", amount: 3, from_account_id: accounts.Salary, to_account_id: pocket, description: "Pocket cash", status: "posted" }, ledger);

      const rows = callTool("account_balances", { account_type: "asset" }, ledger) as any[];
      const checkingUsd = rows.find((row) => row.account_id === accounts.Checking && row.asset_symbol === "USD");
      const cadCashCad = rows.find((row) => row.account_id === cadCash && row.asset_symbol === "CAD");
      expect(checkingUsd).toMatchObject({ default_asset_symbol: "USD", posted_balance_cents: 200000, pending_balance_cents: 5000, current_balance_cents: 205000, current_display: 2050 });
      expect(cadCashCad).toMatchObject({ default_asset_symbol: "CAD", posted_balance_cents: 10000, pending_balance_cents: 2500, current_balance_cents: 12500, current_display: 125 });
      expect(rows.find((row) => row.account_id === accounts.Checking && row.asset_symbol === "CAD")).toBeUndefined();
      expect(rows.find((row) => row.account_id === cadCash && row.asset_symbol === "USD")).toBeUndefined();

      const cadRows = callTool("account_balances", { account_type: "asset", asset_id: "CAD" }, ledger) as any[];
      expect(cadRows.map((row) => row.asset_symbol)).toEqual(["CAD"]);
      expect(cadRows[0].account_id).toBe(cadCash);

      const rollupRows = callTool("account_balances", { account_type: "asset", rollup: true }, ledger) as any[];
      expect(rollupRows.find((row) => row.account_id === wallet && row.asset_symbol === "USD")).toMatchObject({ current_balance_cents: 300, rollup: true });
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
      expect((callTool("balance_sheet", { include_pending: true, quote_asset_id: usd }, ledger) as any).total_assets).toBe(15000);
      expect((callTool("balance_sheet", { status: "active", quote_asset_id: usd }, ledger) as any).total_assets).toBe(15000);
      expect((callTool("net_worth", { quote_asset_id: usd }, ledger) as any).net_worth).toBe(10000);
      expect((callTool("net_worth", { include_pending: true, quote_asset_id: usd }, ledger) as any).net_worth).toBe(15000);
      expect((callTool("net_worth", { status: "active", quote_asset_id: usd }, ledger) as any).net_worth).toBe(15000);
      expect((callTool("cash_flow", { year: 2026, month: 6, quote_asset_id: usd }, ledger) as any).operating_total).toBe(-10000);
      expect((callTool("cash_flow", { year: 2026, month: 6, include_pending: true, quote_asset_id: usd }, ledger) as any).operating_total).toBe(-15000);
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

  it("treats status all as visible non-void transactions across read filters", () => {
    const ledger = tempLedger();
    try {
      callTool("init_defaults", { template: "personal", currency: "USD" }, ledger);
      const accounts = Object.fromEntries((callTool("list_accounts", {}, ledger) as any[]).map((row) => [row.name, row.id]));
      const usd = (callTool("get_asset_by_symbol", { symbol: "USD" }, ledger) as any).id;
      const posted = callTool("create_transaction", { date: "2026-06-01", amount: 100, from_account_id: accounts.Salary, to_account_id: accounts.Checking, description: "Posted", status: "posted" }, ledger) as any;
      callTool("create_transaction", { date: "2026-06-02", amount: 50, from_account_id: accounts.Salary, to_account_id: accounts.Checking, description: "Pending", status: "pending" }, ledger);
      callTool("plan_transaction", { date: "2026-06-03", amount: 25, from_account_id: accounts.Salary, to_account_id: accounts.Checking, description: "Planned" }, ledger);
      const voided = callTool("create_transaction", { date: "2026-06-04", amount: 10, from_account_id: accounts.Salary, to_account_id: accounts.Checking, description: "Voided", status: "posted" }, ledger) as any;
      callTool("delete_transaction", { id: voided.id }, ledger);

      const listed = callTool("list_transactions", { status: "all", compact: true, limit: 100 }, ledger) as any;
      expect(listed.total).toBe(3);
      expect(listed.transactions.map((tx: any) => tx.status).sort()).toEqual(["pending", "planned", "posted"]);
      expect(listed.transactions[0]).not.toHaveProperty("entries");
      expect(listed.transactions[0]).not.toHaveProperty("tags");
      expect(listed.transactions[0].entry_count).toBe(2);
      expect(listed.transactions[0].account_ids).toHaveLength(2);
      const fullListed = callTool("list_transactions", { status: "all", compact: false, limit: 1 }, ledger) as any;
      expect(fullListed.transactions[0].entries).toHaveLength(2);
      expect(fullListed.transactions[0].tags).toEqual([]);
      expect((callTool("count_transactions", { status: "all" }, ledger) as any).count).toBe(3);
      expect((callTool("count_transactions", { status: null }, ledger) as any).count).toBe(3);
      expect((callTool("get_balance", { account_id: accounts.Checking, status: "all" }, ledger) as any).balance_cents).toBe(17500);
      expect((callTool("trial_balance", { asset_id: usd, status: "all" }, ledger) as any).balanced).toBe(true);
      expect((callTool("account_register", { account_id: accounts.Checking, status: "all" }, ledger) as any).total).toBe(3);
      expect((callTool("search_transactions", { query: "Posted", status: "all" }, ledger) as any).transactions.map((tx: any) => tx.id)).toEqual([posted.id]);

      callTool("set_budget", { account: accounts.Groceries, amount: 100, year: 2026, month: 6 }, ledger);
      callTool("create_transaction", { date: "2026-06-05", amount: 10, from_account_id: accounts.Checking, to_account_id: accounts.Groceries, description: "Posted groceries", status: "posted" }, ledger);
      callTool("create_transaction", { date: "2026-06-06", amount: 5, from_account_id: accounts.Checking, to_account_id: accounts.Groceries, description: "Pending groceries", status: "pending" }, ledger);
      callTool("plan_transaction", { date: "2026-06-07", amount: 2, from_account_id: accounts.Checking, to_account_id: accounts.Groceries, description: "Planned groceries" }, ledger);
      const voidedExpense = callTool("create_transaction", { date: "2026-06-08", amount: 1, from_account_id: accounts.Checking, to_account_id: accounts.Groceries, description: "Voided groceries", status: "posted" }, ledger) as any;
      callTool("delete_transaction", { id: voidedExpense.id }, ledger);
      expect((callTool("spending", { year: 2026, month: 6, quote_asset_id: usd }, ledger) as any).total).toBe(1000);
      expect((callTool("spending", { year: 2026, month: 6, quote_asset_id: usd, status: "all" }, ledger) as any).total).toBe(1700);
      expect((callTool("spending", { year: 2026, month: 6, quote_asset_id: usd, status: null }, ledger) as any).total).toBe(1700);
      expect((callTool("budget_summary", { year: 2026, month: 6, quote_asset_id: usd, status: "all" }, ledger) as any).total_spent_cents).toBe(1700);
      expect((callTool("budget_summary", { year: 2026, month: 6, quote_asset_id: usd, status: null }, ledger) as any).total_spent_cents).toBe(1700);
    } finally {
      ledger.close();
    }
  });

  it("applies export transaction filters instead of dumping the whole ledger", () => {
    const ledger = tempLedger();
    try {
      callTool("init_defaults", { template: "personal", currency: "USD" }, ledger);
      const accounts = Object.fromEntries((callTool("list_accounts", {}, ledger) as any[]).map((row) => [row.name, row.id]));
      callTool("create_transaction", { date: "2026-06-01", amount: 100, from_account_id: accounts.Salary, to_account_id: accounts.Checking, description: "June pay", status: "posted" }, ledger);
      callTool("create_transaction", { date: "2026-06-02", amount: 10, from_account_id: accounts.Checking, to_account_id: accounts.Groceries, description: "June groceries", status: "posted" }, ledger);
      callTool("create_transaction", { date: "2026-07-01", amount: 200, from_account_id: accounts.Salary, to_account_id: accounts.Checking, description: "July pay", status: "posted" }, ledger);
      const voided = callTool("create_transaction", { date: "2026-06-03", amount: 3, from_account_id: accounts.Salary, to_account_id: accounts.Checking, description: "Voided June pay", status: "posted" }, ledger) as any;
      callTool("delete_transaction", { id: voided.id }, ledger);

      const exported = callTool("export_transactions", { account_id: accounts.Checking, date_from: "2026-06-01", date_to: "2026-06-30", status: "all" }, ledger) as any;
      const lines = String(exported.csv).trim().split(/\r?\n/);
      expect(exported.exported).toBe(2);
      expect(lines).toHaveLength(3);
      expect(lines[1]).toContain(",10000,");
      expect(lines[2]).toContain(",-1000,");
      expect(lines.every((line) => line === lines[0] || line.startsWith("2026-06-"))).toBe(true);
      expect(lines.slice(1).every((line) => line.includes(`,${accounts.Checking},`))).toBe(true);
    } finally {
      ledger.close();
    }
  });

  it("applies scoped export_ledger filters instead of dumping the whole ledger", () => {
    const ledger = tempLedger();
    try {
      callTool("init_defaults", { template: "personal", currency: "USD" }, ledger);
      const accounts = Object.fromEntries((callTool("list_accounts", {}, ledger) as any[]).map((row) => [row.name, row.id]));
      const june = callTool("create_transaction", { date: "2026-06-01", amount: 100, from_account_id: accounts.Salary, to_account_id: accounts.Checking, description: "June pay", status: "posted" }, ledger) as any;
      callTool("create_transaction", { date: "2026-06-02", amount: 10, from_account_id: accounts.Checking, to_account_id: accounts.Groceries, description: "June groceries", status: "posted" }, ledger);
      callTool("create_transaction", { date: "2026-07-01", amount: 200, from_account_id: accounts.Salary, to_account_id: accounts.Checking, description: "July pay", status: "posted" }, ledger);

      const scoped = JSON.parse((callTool("export_ledger", { account_ids: [accounts.Groceries], date_from: "2026-06-01", date_to: "2026-06-30" }, ledger) as any).data);
      expect(scoped.scope).toMatchObject({ date_from: "2026-06-01", date_to: "2026-06-30", transaction_count: 1 });
      expect(scoped.transactions.map((tx: any) => tx.description)).toEqual(["June groceries"]);
      expect(scoped.accounts.map((row: any) => row.id)).toContain(accounts.Groceries);
      expect(scoped.accounts.map((row: any) => row.id)).not.toContain(accounts.Salary);

      const byEntity = JSON.parse((callTool("export_ledger", { entity_id: june.id }, ledger) as any).data);
      expect(byEntity.transactions.map((tx: any) => tx.id)).toEqual([june.id]);
    } finally {
      ledger.close();
    }
  });

  it("uses true posted_at filters for transaction search", () => {
    const ledger = tempLedger();
    try {
      callTool("init_defaults", { template: "personal", currency: "USD" }, ledger);
      const accounts = Object.fromEntries((callTool("list_accounts", {}, ledger) as any[]).map((row) => [row.name, row.id]));
      const early = callTool("create_transaction", { date: "2026-06-30", amount: 100, from_account_id: accounts.Salary, to_account_id: accounts.Checking, description: "Early posted", status: "posted" }, ledger) as any;
      const late = callTool("create_transaction", { date: "2026-06-01", amount: 100, from_account_id: accounts.Salary, to_account_id: accounts.Checking, description: "Late posted", status: "posted" }, ledger) as any;
      ledger.db.prepare("UPDATE journals SET posted_at = ? WHERE id = ?").run("2026-06-01T09:00:00Z", early.id);
      ledger.db.prepare("UPDATE journals SET posted_at = ? WHERE id = ?").run("2026-06-10T09:00:00Z", late.id);

      const byPosted = callTool("search_transactions", { posted_at_from: "2026-06-10", posted_at_to: "2026-06-10", status: "posted" }, ledger) as any;
      expect(byPosted.transactions.map((tx: any) => tx.id)).toEqual([late.id]);
      const byDate = callTool("search_transactions", { date_from: "2026-06-30", date_to: "2026-06-30", status: "posted" }, ledger) as any;
      expect(byDate.transactions.map((tx: any) => tx.id)).toEqual([early.id]);
    } finally {
      ledger.close();
    }
  });

  it("uses recurring detection time windows and amount tolerance", () => {
    const ledger = tempLedger();
    try {
      callTool("init_defaults", { template: "personal", currency: "USD" }, ledger);
      const accounts = Object.fromEntries((callTool("list_accounts", {}, ledger) as any[]).map((row) => [row.name, row.id]));
      callTool("create_transaction", { date: "2026-05-01", amount: 100, from_account_id: accounts.Checking, to_account_id: accounts.Utilities, description: "Utility Bill", status: "posted" }, ledger);
      callTool("create_transaction", { date: "2026-06-01", amount: 104, from_account_id: accounts.Checking, to_account_id: accounts.Utilities, description: "Utility Bill", status: "posted" }, ledger);
      callTool("create_transaction", { date: "2026-06-01", amount: 50, from_account_id: accounts.Checking, to_account_id: accounts.Groceries, description: "One-off", status: "posted" }, ledger);

      const tolerant = callTool("detect_recurring", { year: 2026, month: 6, min_occurrences: 2, amount_tolerance_pct: 5 }, ledger) as any[];
      expect(tolerant).toEqual([]);
      const twoMonths = callTool("detect_recurring", { months: 2, min_occurrences: 2, amount_tolerance_pct: 5 }, ledger) as any[];
      expect(twoMonths).toContainEqual(expect.objectContaining({ description: "Utility Bill", occurrences: 2 }));
      const strict = callTool("detect_recurring", { months: 2, min_occurrences: 2, amount_tolerance_pct: 1 }, ledger) as any[];
      expect(strict).toEqual([]);
    } finally {
      ledger.close();
    }
  });

  it("computes age_of_money from remaining inflow lots instead of echoing the input", () => {
    const ledger = tempLedger();
    try {
      const usd = ledger.createAsset("USD", "currency", 2);
      const checking = ledger.createAccount("Checking", "asset");
      const salary = ledger.createAccount("Salary", "income");
      const groceries = ledger.createAccount("Groceries", "expense");
      for (const accountId of [checking, salary, groceries]) ledger.createAnnotation("account", accountId, "default_asset", usd);
      const asOf = new Date();
      const oldDate = new Date(asOf);
      oldDate.setUTCDate(oldDate.getUTCDate() - 10);
      const newDate = new Date(asOf);
      newDate.setUTCDate(newDate.getUTCDate() - 2);
      ledger.recordTransaction(oldDate.toISOString().slice(0, 10), 10000n, salary, checking, usd, "Old pay", "posted");
      ledger.recordTransaction(newDate.toISOString().slice(0, 10), 10000n, salary, checking, usd, "New pay", "posted");
      ledger.recordTransaction(newDate.toISOString().slice(0, 10), 5000n, checking, groceries, usd, "Spend", "posted");

      const result = callTool("age_of_money", { days: 30, quote_asset_id: usd }, ledger) as any;
      expect(result.income_cents).toBe(20000);
      expect(result.outflow_cents).toBe(5000);
      expect(result.remaining_cents).toBe(15000);
      expect(result.average_age_days).toBeGreaterThan(2);
      expect(result.average_age_days).toBeLessThan(30);
    } finally {
      ledger.close();
    }
  });

  it("exposes tool registry metadata and normalizes common asset aliases", () => {
    const ledger = tempLedger();
    try {
      callTool("init_defaults", { template: "personal", currency: "USD" }, ledger);
      const accounts = Object.fromEntries((callTool("list_accounts", {}, ledger) as any[]).map((row) => [row.name, row.id]));
      callTool("create_transaction", { date: "2026-06-01", amount: 100, from_account_id: accounts.Salary, to_account_id: accounts.Checking, description: "Pay", status: "posted" }, ledger);

      const registry = callTool("tool_registry", {}, ledger) as any;
      expect(registry.count).toBe(TOOL_NAMES.length);
      const byName = Object.fromEntries(registry.tools.map((tool: any) => [tool.name, tool]));
      expect(byName.list_accounts.safety.readOnlyHint).toBe(true);
      expect(byName.delete_transaction.safety.destructiveHint).toBe(true);
      expect(byName.create_account.safety.supportsDryRun).toBe(true);
      expect(byName.create_account.definition.parameters.map((parameter: any) => parameter[0])).toContain("dry_run");
      expect(byName.create_account.signature).toContain("dry_run?: boolean");
      expect(byName.balance_sheet.aliases.currency).toBe("quote_asset_id");
      expect(byName.operating_manual.safety.readOnlyHint).toBe(true);
      expect(byName.tool_registry.safety.idempotentHint).toBe(true);
      expect(registry.file_access.mode).toBe("unrestricted");
      expect(registry.file_access.path_policy).toContain("operating system permits");
      const filtered = callTool("tool_registry", { names: ["list_accounts", "delete_transaction"], summary: true, safety_filter: "read_only" }, ledger) as any;
      expect(filtered).toMatchObject({ count: TOOL_NAMES.length, returned_count: 1, summary: true });
      expect(filtered.tools).toEqual([expect.objectContaining({ name: "list_accounts", signature: expect.any(String) })]);
      expect(filtered.tools[0].definition).toBeUndefined();
      const partial = callTool("tool_registry", { names: ["list_accounts", "not_a_tool"], summary: true }, ledger) as any;
      expect(partial.returned_count).toBe(1);
      expect(partial.unknown_names).toEqual(["not_a_tool"]);
      expect(partial.tools[0].name).toBe("list_accounts");

      const sheet = callTool("balance_sheet", { currency: "USD", status: "all" }, ledger) as any;
      expect(sheet.quote_asset_id).toBe((callTool("get_asset_by_symbol", { symbol: "USD" }, ledger) as any).id);
      expect(sheet.total_assets).toBe(10000);
    } finally {
      ledger.close();
    }
  });

  it("exposes the Clovis Operating Manual as a read-only app tool", () => {
    const ledger = tempLedger();
    try {
      const manual = callTool("operating_manual", { topic: "statement_import" }, ledger) as any;
      expect(manual.name).toBe("Clovis Operating Manual");
      expect(manual.topic).toBe("statement_import");
      expect(manual.recommended_tools).toContain("preview_import");
      expect(manual.guidance.join(" ")).toContain("pending");
      expect(() => callTool("operating_manual", { topic: "nonsense" }, ledger)).toThrow(/Unsupported operating manual topic/);
    } finally {
      ledger.close();
    }
  });

  it("keeps financial picture report scopes consistent", () => {
    const ledger = tempLedger();
    try {
      callTool("init_defaults", { template: "personal", currency: "USD" }, ledger);
      const accounts = Object.fromEntries((callTool("list_accounts", {}, ledger) as any[]).map((row) => [row.name, row.id]));
      const usd = (callTool("get_asset_by_symbol", { symbol: "USD" }, ledger) as any).id;
      callTool("create_transaction", { date: "2026-06-01", amount: 100, from_account_id: accounts.Salary, to_account_id: accounts.Checking, description: "Posted pay", status: "posted" }, ledger);
      callTool("create_transaction", { date: "2026-06-15", amount: 50, from_account_id: accounts.Salary, to_account_id: accounts.Checking, description: "Pending pay", status: "pending" }, ledger);
      callTool("plan_transaction", { date: "2026-06-30", amount: 25, from_account_id: accounts.Salary, to_account_id: accounts.Checking, description: "Planned pay" }, ledger);
      callTool("set_budget", { account: accounts.Groceries, amount: 200, year: 2026, month: 6 }, ledger);
      callTool("create_transaction", { date: "2026-06-10", amount: 10, from_account_id: accounts.Checking, to_account_id: accounts.Groceries, description: "Posted groceries", status: "posted" }, ledger);
      callTool("create_transaction", { date: "2026-06-11", amount: 5, from_account_id: accounts.Checking, to_account_id: accounts.Groceries, description: "Pending groceries", status: "pending" }, ledger);

      const picture = callTool("financial_picture", { year: 2026, month: 6, quote_asset_id: usd }, ledger) as any;
      expect(picture.monthly_activity.income).toBe(15000);
      expect(picture.current_snapshot.total_assets).toBe(13500);
      expect(picture.budget_position.total_spent_cents).toBe(1500);
      expect(picture.include_planned).toBe(false);
      expect(picture.warnings).toEqual([]);
      expect(picture.current_snapshot).not.toHaveProperty("as_of");
      expect(picture.current_snapshot.as_of_basis).toBe("current_open_ended");
      expect(picture.current_snapshot.as_of_description).toContain("Open-ended");
      expect(picture.current_snapshot).not.toHaveProperty("ledger_as_of");
      expect(picture.actual_cash_cents).toBe(9000);
      expect(picture.planned_cash_cents).toBe(0);

      const planned = callTool("financial_picture", { year: 2026, month: 6, quote_asset_id: usd, include_planned: true }, ledger) as any;
      expect(planned.monthly_activity.income).toBe(17500);
      expect(planned.current_snapshot.total_assets).toBe(16000);
      expect(planned.include_planned).toBe(true);
      expect(planned.planned_cash_cents).toBe(2500);

      const postedOnly = callTool("financial_picture", { year: 2026, month: 6, quote_asset_id: usd, include_pending: false }, ledger) as any;
      expect(postedOnly.monthly_activity.income).toBe(10000);
      expect(postedOnly.current_snapshot.total_assets).toBe(9000);
      expect(postedOnly.budget_position.total_spent_cents).toBe(1000);

      const activeConflict = callTool("financial_picture", { year: 2026, month: 6, quote_asset_id: usd, status: "active", include_planned: true }, ledger) as any;
      expect(activeConflict.include_planned).toBe(false);
      expect(activeConflict.warnings).toContainEqual(expect.objectContaining({ code: "status_overrides_include_planned" }));

      const postedConflict = callTool("financial_picture", { year: 2026, month: 6, quote_asset_id: usd, status: "posted", include_pending: true }, ledger) as any;
      expect(postedConflict.include_pending).toBe(false);
      expect(postedConflict.warnings).toContainEqual(expect.objectContaining({ code: "status_overrides_include_pending" }));
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

  it("surfaces missing conversions in cash flow", () => {
    const ledger = tempLedger();
    try {
      const cad = ledger.createAsset("CAD", "currency", 2);
      const usd = ledger.createAsset("USD", "currency", 2);
      const cadChecking = ledger.createAccount("CAD Checking", "asset");
      const usdChecking = ledger.createAccount("USD Checking", "asset");
      const salary = ledger.createAccount("Salary", "income");
      const fees = ledger.createAccount("Fees", "expense");
      ledger.recordTransaction("2026-06-01", 10000n, salary, cadChecking, cad, "CAD pay", "posted");
      ledger.recordTransaction("2026-06-02", 300n, usdChecking, fees, usd, "USD fee", "posted");

      const report = callTool("cash_flow", { year: 2026, month: 6, quote_asset_id: cad }, ledger) as any;
      expect(report.operating_total).toBe(-10000);
      expect(report.valuation_complete).toBe(false);
      expect(report.missing_conversions).toHaveLength(1);
      expect(report.missing_conversions[0]).toMatchObject({ account_id: fees, asset_id: usd, quote_asset_id: cad, quantity: 300 });
    } finally {
      ledger.close();
    }
  });

  it("projects balances through quote conversion paths", () => {
    const ledger = tempLedger();
    try {
      const cad = ledger.createAsset("CAD", "currency", 2);
      const usd = ledger.createAsset("USD", "currency", 2);
      const usdChecking = ledger.createAccount("USD Checking", "asset");
      const equity = ledger.createAccount("Opening Balance", "equity");
      ledger.recordTransaction("2026-06-01", 7900n, equity, usdChecking, usd, "USD opening", "posted");

      const missing = callTool("project_balances", { through: "2026-06-30", account_ids: [usdChecking], quote_asset_id: cad }, ledger) as any;
      expect(missing.accounts[0].balance_cents).toBe(0);
      expect(missing.net_worth_cents).toBe(0);
      expect(missing.valuation_complete).toBe(false);
      expect(missing.missing_conversions[0]).toMatchObject({ account_id: usdChecking, asset_id: usd, quote_asset_id: cad, quantity: 7900 });

      ledger.createPrice(usd, cad, "1.25", "2026-06-01");
      const converted = callTool("project_balances", { through: "2026-06-30", account_ids: [usdChecking], quote_asset_id: cad }, ledger) as any;
      expect(converted.accounts[0].balance_cents).toBe(9875);
      expect(converted.net_worth_cents).toBe(9875);
      expect(converted.valuation_complete).toBe(true);
      expect(converted.missing_conversions).toEqual([]);
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
      const missingGoal = callTool("goal_progress", { account: accounts.Checking }, ledger) as any;
      expect(missingGoal).toMatchObject({ found: false, account_id: accounts.Checking, goal: null, target_cents: null });
      const progress = callTool("goal_progress", { account: accounts.Savings }, ledger) as any;
      expect(progress).toMatchObject({ found: true, account_id: accounts.Savings, target_cents: 50000 });
      expect(callTool("list_import_batches", {}, ledger)).toEqual([]);
    } finally {
      ledger.close();
    }
  });

  it("projects cash with explicit pending, planned, and liability buckets", () => {
    const ledger = tempLedger();
    try {
      const usd = ledger.createAsset("USD", "currency", 2);
      const checking = ledger.createAccount("Checking", "asset");
      const visa = ledger.createAccount("Visa", "liability");
      const equity = ledger.createAccount("Opening Balances", "equity");
      const salary = ledger.createAccount("Salary", "income");
      const groceries = ledger.createAccount("Groceries", "expense");

      ledger.recordTransaction("2026-05-31", 100000n, equity, checking, usd, "Opening cash", "posted");
      ledger.recordTransaction("2026-06-03", 10000n, checking, groceries, usd, "Pending groceries", "pending");
      ledger.recordTransaction("2026-06-04", 5000n, visa, groceries, usd, "Posted card", "posted");
      ledger.recordTransaction("2026-06-05", 2500n, visa, groceries, usd, "Pending card", "pending");
      ledger.recordTransaction("2026-05-29", 324640n, salary, checking, usd, "Stale planned payroll", "planned");
      ledger.recordTransaction("2026-06-15", 324343n, salary, checking, usd, "June planned payroll", "planned");

      const base = callTool("cash_projection", { year: 2026, month: 6, asset_account_ids: [checking], liability_account_ids: [visa], include_pending: false, include_planned: false, quote_asset_id: usd }, ledger) as any;
      expect(base.gross_cash_cents).toBe(100000);
      expect(base.pending_cash_cents).toBe(0);
      expect(base.planned_cash_cents).toBe(0);
      expect(base.liability_effect_cents).toBe(-5000);
      expect(base.available_cash_cents).toBe(95000);
      expect(base.basis).toBe("actual");
      expect(base.audit_trail.line_items).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "starting_cash", amount_cents: 100000 }),
        expect.objectContaining({ type: "posted_liabilities", amount_cents: -5000 })
      ]));

      const noLiability = callTool("cash_projection", { year: 2026, month: 6, asset_account_ids: [checking], include_pending: false, include_planned: false, quote_asset_id: usd }, ledger) as any;
      expect(noLiability.liability_effect_cents).toBe(0);
      expect(noLiability.available_cash_cents).toBe(100000);

      const full = callTool("cash_projection", { year: 2026, month: 6, asset_account_ids: [checking], liability_account_ids: [visa], include_pending: true, include_planned: true, quote_asset_id: usd }, ledger) as any;
      expect(full.pending_cash_cents).toBe(-10000);
      expect(full.planned_cash_cents).toBe(324343);
      expect(full.liability_effect_cents).toBe(-7500);
      expect(full.available_cash_cents).toBe(406843);
      expect(full.available_cash_cents).not.toBe(base.available_cash_cents);

      const monthEndMixed = callTool("project_month_end", { year: 2026, month: 6, account_ids: [checking, visa], quote_asset_id: usd }, ledger) as any;
      expect(monthEndMixed.asset_account_ids).toEqual([checking]);
      expect(monthEndMixed.liability_account_ids).toEqual([visa]);
      expect(monthEndMixed.available_cash_cents).toBe(full.available_cash_cents);
      expect(monthEndMixed.projected_month_end_cents).toBe(full.available_cash_cents);

      const monthEndExplicit = callTool("project_month_end", { year: 2026, month: 6, asset_account_ids: [checking], liability_account_ids: [visa], expected_inflows: [{ amount: 100 }], expected_outflows: [{ amount: 25 }], quote_asset_id: usd }, ledger) as any;
      expect(monthEndExplicit.projected_month_end_cents).toBe(full.available_cash_cents + 7500);
    } finally {
      ledger.close();
    }
  });

  it("excludes realized planned rows from cash projections and can reconcile them", () => {
    const ledger = tempLedger();
    try {
      const usd = ledger.createAsset("USD", "currency", 2);
      const checking = ledger.createAccount("Checking", "asset");
      const equity = ledger.createAccount("Opening Balances", "equity");
      const salary = ledger.createAccount("Salary", "income");
      for (const accountId of [checking, equity, salary]) ledger.createAnnotation("account", accountId, "default_asset", usd);

      ledger.recordTransaction("2026-06-01", 100000n, equity, checking, usd, "Opening cash", "posted");
      const landed = ledger.recordTransaction("2026-06-14", 30000n, salary, checking, usd, "June payroll", "posted");
      const realized = ledger.recordTransaction("2026-06-15", 30000n, salary, checking, usd, "June payroll", "planned");
      const unrealized = ledger.recordTransaction("2026-06-28", 12000n, salary, checking, usd, "Bonus payroll", "planned");

      const matches = callTool("find_realized_planned", { year: 2026, month: 6, account_id: checking }, ledger) as any;
      expect(matches.count).toBe(1);
      expect(matches.realized_planned_rows[0]).toMatchObject({ planned_tx_id: realized.id, matched_tx_id: landed.id, amount_cents: 30000 });

      const projection = callTool("cash_projection", { year: 2026, month: 6, asset_account_ids: [checking], include_planned: true, quote_asset_id: usd }, ledger) as any;
      expect(projection.planned_cash_cents).toBe(12000);
      expect(projection.gross_cash_cents).toBe(142000);
      expect(projection.realized_planned_count).toBe(1);
      expect(projection.realized_planned_rows[0].planned_tx_id).toBe(realized.id);

      const dryRun = callTool("reconcile_planned", { year: 2026, month: 6, account_id: checking }, ledger) as any;
      expect(dryRun).toMatchObject({ matched: 1, voided: 0, dry_run: true });
      expect(ledger.getTx(realized.id)?.status).toBe("planned");

      const reconciled = callTool("reconcile_planned", { year: 2026, month: 6, account_id: checking, dry_run: false }, ledger) as any;
      expect(reconciled).toMatchObject({ matched: 1, voided: 1, dry_run: false });
      expect(ledger.getTx(realized.id)?.status).toBe("void");
      expect(ledger.getTx(unrealized.id)?.status).toBe("planned");
    } finally {
      ledger.close();
    }
  });

  it("calculates conservative cash runway with explicit burn assumptions", () => {
    const ledger = tempLedger();
    try {
      const usd = ledger.createAsset("USD", "currency", 2);
      const cad = ledger.createAsset("CAD", "currency", 2);
      const assets = ledger.createAccount("Assets", "asset");
      const checking = ledger.createAccount("Checking", "asset", assets);
      const foreignReserve = ledger.createAccount("Foreign Reserve", "asset", assets);
      const brokerage = ledger.createAccount("Brokerage", "asset", assets);
      const visa = ledger.createAccount("Visa", "liability");
      const equity = ledger.createAccount("Opening Balances", "equity");
      const salary = ledger.createAccount("Salary", "income");
      const rent = ledger.createAccount("Rent", "expense");
      const shopping = ledger.createAccount("Shopping", "expense");

      ledger.recordTransaction("2026-03-31", 100000n, equity, checking, usd, "Opening cash", "posted");
      ledger.recordTransaction("2026-03-31", 500000n, equity, brokerage, usd, "Brokerage opening", "posted");
      ledger.recordTransaction("2026-04-05", 20000n, checking, rent, usd, "April rent", "posted");
      ledger.recordTransaction("2026-05-05", 20000n, checking, rent, usd, "May rent", "posted");
      ledger.recordTransaction("2026-05-10", 700n, foreignReserve, shopping, cad, "Unpriced May shopping", "posted");
      ledger.recordTransaction("2026-06-05", 20000n, checking, rent, usd, "June rent", "posted");
      ledger.recordTransaction("2026-06-06", 10000n, visa, shopping, usd, "Posted card shopping", "posted");
      ledger.recordTransaction("2026-06-10", 5000n, checking, shopping, usd, "Pending shopping", "pending");
      ledger.recordTransaction("2026-06-20", 30000n, salary, checking, usd, "Planned pay", "planned");
      callTool("set_budget", { account: rent, amount: 200, asset_id: usd, year: 2026, month: 6 }, ledger);
      callTool("set_budget", { account: shopping, amount: 150, asset_id: usd, year: 2026, month: 6 }, ledger);

      const runway = callTool("cash_runway", { year: 2026, month: 6, as_of: "2026-06-11", quote_asset_id: usd }, ledger) as any;
      expect(runway.include_pending).toBe(false);
      expect(runway.include_planned).toBe(false);
      expect(runway.include_sources).toBe(false);
      expect(runway.asset_account_ids).toEqual([checking]);
      expect(runway.excluded_asset_account_ids).toContain(brokerage);
      expect(runway.actual_cash_cents).toBe(30000);
      expect(runway.available_cash_cents).toBe(30000);
      expect(runway.current_month_budget_reserve_cents).toBe(5000);
      expect(runway.spendable_cash_cents).toBe(25000);
      expect(runway.planned_cash_cents).toBe(0);
      expect(runway.trailing_window).toMatchObject({ year: 2026, month: 5, basis: "last_complete_months", excluded_partial_month: { year: 2026, month: 6, as_of: "2026-06-11" } });
      expect(runway.burn_models.map((row: any) => row.model)).toEqual([
        "budget_burn",
        "trailing_3_month_actual",
        "trailing_6_month_actual",
        "fixed_obligation_burn",
        "discretionary_adjusted_burn"
      ]);
      expect(runway.burn_models[0].source).toBeUndefined();
      expect(runway.burn_models[0].source_summary).toBeDefined();
      expect(runway.models).toBeUndefined();
      expect(runway.missing_conversions).toHaveLength(1);
      expect(runway.missing_conversions[0]).toMatchObject({
        account_name: "Shopping",
        asset_symbol: "CAD",
        quote_asset_symbol: "USD",
        affected_sections: ["trailing_actuals.short", "trailing_actuals.long"],
        affected_models: ["trailing_3_month_actual", "trailing_6_month_actual"],
        materiality: "unknown",
        materiality_basis: "missing_price"
      });
      expect(runway.conversion_warning).toMatchObject({
        severity: "unknown",
        missing_count: 1,
        affected_models: ["trailing_3_month_actual", "trailing_6_month_actual"],
        recommended_model: "trailing_3_month_actual",
        recommended_model_affected: true
      });
      expect(runway.burn_models.find((row: any) => row.model === "budget_burn")).toMatchObject({ monthly_burn_cents: 35000, runway_months: 0.71 });
      expect(runway.burn_models.find((row: any) => row.model === "budget_burn")).toMatchObject({ valuation_complete: true, missing_conversion_count: 0 });
      expect(runway.burn_models.find((row: any) => row.model === "trailing_3_month_actual")).toMatchObject({ monthly_burn_cents: 13333, runway_months: 1.88 });
      expect(runway.burn_models.find((row: any) => row.model === "trailing_3_month_actual")).toMatchObject({ valuation_complete: false, missing_conversion_count: 1 });
      expect(runway.burn_models.find((row: any) => row.model === "fixed_obligation_burn")).toMatchObject({ monthly_burn_cents: 20000, runway_months: 1.25 });
      expect(runway.burn_models.find((row: any) => row.model === "discretionary_adjusted_burn")).toMatchObject({ monthly_burn_cents: 27500, runway_months: 0.91 });

      const partial = callTool("cash_runway", { year: 2026, month: 6, as_of: "2026-06-11", include_partial_month: true, quote_asset_id: usd }, ledger) as any;
      expect(partial.trailing_window).toMatchObject({ year: 2026, month: 6, basis: "requested_month_including_partial" });
      expect(partial.burn_models.find((row: any) => row.model === "trailing_3_month_actual").source_summary.monthly_burn_cents).toBe(23333);

      const withSources = callTool("cash_runway", { year: 2026, month: 6, as_of: "2026-06-11", include_sources: true, quote_asset_id: usd }, ledger) as any;
      expect(withSources.include_sources).toBe(true);
      expect(withSources.burn_models[0].source).toBeDefined();
      expect(withSources.burn_models.find((row: any) => row.model === "trailing_3_month_actual").missing_conversions).toHaveLength(1);

      const withPlanned = callTool("cash_runway", { year: 2026, month: 6, as_of: "2026-06-11", include_planned: true, quote_asset_id: usd }, ledger) as any;
      expect(withPlanned.spendable_cash_cents).toBe(55000);
      expect(withPlanned.planned_cash_cents).toBe(30000);
    } finally {
      ledger.close();
    }
  });

  it("keeps mixed-type account trees out of balance projections", () => {
    const ledger = tempLedger();
    try {
      const usd = ledger.createAsset("USD", "currency", 2);
      const assetParent = ledger.createAccount("Asset Parent", "asset");
      const checking = ledger.createAccount("Checking", "asset", assetParent);
      const dining = ledger.createAccount("Dining", "expense", assetParent);
      const salary = ledger.createAccount("Salary", "income", assetParent);
      ledger.createAnnotation("account", assetParent, "default_asset", usd);
      ledger.createAnnotation("account", checking, "default_asset", usd);

      ledger.recordTransaction("2026-06-01", 10000n, salary, checking, usd, "Pay", "posted");
      ledger.recordTransaction("2026-06-02", 1000n, checking, dining, usd, "Dinner", "posted");
      ledger.recordTransaction("2026-06-15", 5000n, salary, checking, usd, "Planned pay", "planned");

      expect(ledger.balanceTree(assetParent, usd, null, "posted")).toBe(9000n);
      expect((callTool("get_balance", { account_id: assetParent, asset_id: usd }, ledger) as any).balance_cents).toBe(9000);
      expect((callTool("forecast", { account_id: assetParent, asset_id: usd, as_of: "2026-06-30" }, ledger) as any).projected_cents).toBe(14000);

      const projection = callTool("cash_projection", { year: 2026, month: 6, quote_asset_id: usd }, ledger) as any;
      expect(projection.asset_account_ids).toEqual([assetParent]);
      expect(projection.gross_cash_cents).toBe(9000);
      const projected = callTool("cash_projection", { year: 2026, month: 6, include_planned: true, quote_asset_id: usd }, ledger) as any;
      expect(projected.gross_cash_cents).toBe(14000);

      const monthEnd = callTool("project_month_end", { year: 2026, month: 6, account_ids: [checking], expected_inflows: [{ amount: 2 }], expected_outflows: [{ amount: 1 }], quote_asset_id: usd }, ledger) as any;
      expect(monthEnd.asset_account_ids).toEqual([checking]);
      expect(monthEnd.gross_cash_cents).toBe(14000);
      expect(monthEnd.projected_month_end_cents).toBe(14100);
    } finally {
      ledger.close();
    }
  });

  it("rolls child category spending into parent budgets when requested", () => {
    const ledger = tempLedger();
    try {
      const usd = ledger.createAsset("USD", "currency", 2);
      const checking = ledger.createAccount("Checking", "asset");
      const food = ledger.createAccount("Food", "expense");
      const dining = ledger.createAccount("Dining", "expense", food);

      ledger.recordTransaction("2026-06-02", 4200n, checking, dining, usd, "Dinner", "posted");
      callTool("set_budget", { account: food, amount: 100, asset_id: usd, year: 2026, month: 6 }, ledger);

      const exact = callTool("budget_status", { account: food, year: 2026, month: 6, quote_asset_id: usd }, ledger) as any;
      expect(exact.budgets[0].spent_cents).toBe(0);

      const rolled = callTool("budget_status", { account: food, year: 2026, month: 6, rollup: true, quote_asset_id: usd }, ledger) as any;
      expect(rolled.budgets[0].spent_cents).toBe(4200);
      expect(rolled.budgets[0].remaining_cents).toBe(5800);
    } finally {
      ledger.close();
    }
  });

  it("collapses overlapping budgets before reporting totals", () => {
    const ledger = tempLedger();
    try {
      const usd = ledger.createAsset("USD", "currency", 2);
      const checking = ledger.createAccount("Checking", "asset");
      const dining = ledger.createAccount("Dining", "expense");

      ledger.recordTransaction("2026-06-02", 4200n, checking, dining, usd, "Dinner", "posted");
      callTool("set_budget", { account: dining, amount: 300, asset_id: usd }, ledger);
      callTool("set_budget", { account: dining, amount: 100, asset_id: usd, year: 2026, month: 6 }, ledger);

      const budget = callTool("budget_status", { year: 2026, month: 6, quote_asset_id: usd }, ledger) as any;
      expect(budget.budgets).toHaveLength(1);
      expect(budget.total_budgeted_cents).toBe(10000);
      expect(budget.total_spent_cents).toBe(4200);
      expect(budget.budgets[0].remaining_cents).toBe(5800);
      expect(budget.shadowed_budget_count).toBe(1);
      expect(budget.shadowed_budgets[0].quantity).toBe(30000);
      expect(ledger.integrityCheck().ok).toBe(true);
    } finally {
      ledger.close();
    }
  });

  it("respects pending, FX warnings, and rolled-up aggregate spending in budgets", () => {
    const ledger = tempLedger();
    try {
      const usd = ledger.createAsset("USD", "currency", 2);
      const cad = ledger.createAsset("CAD", "currency", 2);
      const checking = ledger.createAccount("Checking", "asset");
      const cadChecking = ledger.createAccount("CAD Checking", "asset");
      const food = ledger.createAccount("Food", "expense");
      const dining = ledger.createAccount("Dining", "expense", food);

      ledger.recordTransaction("2026-06-01", 1000n, checking, food, usd, "Posted groceries", "posted");
      ledger.recordTransaction("2026-06-02", 500n, checking, food, usd, "Pending groceries", "pending");
      ledger.recordTransaction("2026-06-03", 4200n, checking, dining, usd, "Dinner", "posted");
      callTool("set_budget", { account: food, amount: 100, asset_id: usd, year: 2026, month: 6 }, ledger);
      callTool("set_budget", { account: dining, amount: 50, asset_id: usd, year: 2026, month: 6 }, ledger);

      const posted = callTool("budget_status", { year: 2026, month: 6, quote_asset_id: usd }, ledger) as any;
      const active = callTool("budget_status", { year: 2026, month: 6, include_pending: true, quote_asset_id: usd }, ledger) as any;
      expect(active.total_spent_cents).toBe(Number(posted.total_spent_cents) + 500);
      expect(Number(posted.total_remaining_cents)).toBe(Number(posted.total_budgeted_cents) - Number(posted.total_spent_cents));

      const rolled = callTool("budget_status", { year: 2026, month: 6, rollup: true, quote_asset_id: usd }, ledger) as any;
      expect(rolled.budgets.map((row: any) => row.spent_cents)).toEqual(expect.arrayContaining([5200, 4200]));
      expect(rolled.total_spent_cents).toBe(5200);

      ledger.recordTransaction("2026-06-04", 700n, cadChecking, food, cad, "CAD groceries", "posted");
      const missing = callTool("budget_status", { year: 2026, month: 6, quote_asset_id: usd }, ledger) as any;
      expect(missing.valuation_complete).toBe(false);
      expect(missing.missing_conversions).toContainEqual(expect.objectContaining({ account_id: food, asset_id: cad, quote_asset_id: usd }));
      const rollover = callTool("budget_rollover_preview", { year: 2026, month: 6, quote_asset_id: usd }, ledger) as any;
      expect(rollover).toMatchObject({ valuation_complete: false, total_rollover_cents: 0 });
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

  it("uses the default CLI database path", () => {
    expect(defaultDbPath()).toBe(join(homedir(), ".clovis", "clovis.db"));
  });

  it("rejects unsupported branch filters explicitly", () => {
    const ledger = tempLedger();
    try {
      const usd = ledger.createAsset("USD", "currency", 2);
      expect(() => callTool("balance_sheet", { branch: "scenario" }, ledger)).toThrow(/branch/);
      expect(callTool("compare_scenarios", { asset_id: usd }, ledger)).toMatchObject({ differences: [] });
    } finally {
      ledger.close();
    }
  });

  it("fails closed for scenario branch lifecycle commands", () => {
    const ledger = tempLedger();
    try {
      callTool("init_defaults", { template: "personal", currency: "USD" }, ledger);

      expect(() => callTool("create_branch", { name: "Actual" }, ledger)).toThrow(/conflicts/);
      expect(() => callTool("discard_branch", { name: "missing-branch" }, ledger)).toThrow(/not found/);
      expect(() => callTool("merge_branch", { source: "Actual" }, ledger)).toThrow(/not found/);
      expect(callTool("list_branches", {}, ledger)).toEqual([]);
      expect((callTool("integrity_check", {}, ledger) as any).ok).toBe(true);

      const branch = callTool("create_branch", { name: "what-if" }, ledger) as any;
      expect(branch).toMatchObject({ name: "what-if", discarded_at: null });
      const merged = callTool("merge_branch", { source: "what-if" }, ledger) as any;
      expect(merged).toMatchObject({ merged: branch.id, name: "what-if" });
      expect(ledger.listAnnotations("book", branch.id)).toContainEqual(expect.objectContaining({ key: "merged_at" }));
      expect((callTool("integrity_check", {}, ledger) as any).ok).toBe(true);

      const discarded = callTool("discard_branch", { name: "what-if" }, ledger) as any;
      expect(discarded).toMatchObject({ discarded: branch.id, name: "what-if", updated: 1 });
      expect(() => callTool("merge_branch", { source: "what-if" }, ledger)).toThrow(/discarded/);
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
      process.env.CLOVIS_DB = join(dir, "ledger.db");
      try {
        const usd = ledger.createAsset("USD", "currency", 2);
        const checking = ledger.createAccount("Checking", "asset");
        const equity = ledger.createAccount("Equity", "equity");
        ledger.createAnnotation("account", checking, "default_asset", usd);
        ledger.createAnnotation("account", equity, "default_asset", usd);
        const statementPath = join(dir, "statement.csv");
        writeFileSync(statementPath, "date,amount,description\n2026-06-01,25.00,Deposit\n", "utf8");
        expect(() => callTool("process_statement", { file_path: statementPath, account_id: checking, counterpart_account_id: equity, expected_balance: 24.99, commit: true }, ledger)).toThrow(/expected_balance/);
        expect(ledger.balanceTree(checking, usd, null, null)).toBe(0n);
        const plan = callTool("apply_reconciliation_plan", { file_path: statementPath, account_id: checking, counterpart_account_id: equity }, ledger) as any;
        expect(plan.dry_run ?? true).toBe(true);
        expect(ledger.balanceTree(checking, usd, null, null)).toBe(0n);
        const result = callTool("process_statement", { file_path: statementPath, account_id: checking, counterpart_account_id: equity, expected_balance: 25.00, commit: true }, ledger) as any;
        expect(result.balance_matches).toBe(true);
        expect(result.actual_balance_cents).toBe(2500);
        expect(result.transactions[0].status).toBe("posted");
      } finally {
        if (previousDb == null) delete process.env.CLOVIS_DB; else process.env.CLOVIS_DB = previousDb;
      }
    } finally {
      ledger.close();
    }
  });

  it("stores hardened immutable statement plans", () => {
    const ledger = tempLedger();
    try {
      const dir = mkdtempSync(join(tmpdir(), "clovis-statement-plan-"));
      dirs.push(dir);
      const usd = ledger.createAsset("USD", "currency", 2);
      const checking = ledger.createAccount("Checking", "asset");
      const equity = ledger.createAccount("Equity", "equity");
      for (const accountId of [checking, equity]) ledger.createAnnotation("account", accountId, "default_asset", usd);
      const statementPath = join(dir, "statement.csv");
      writeFileSync(statementPath, "date,amount,description\n2026-06-01,25.00,Deposit\n", "utf8");

      const preview = callTool("refresh_statement", { action: "plan", file_path: statementPath, account_id: checking, counterpart_account_id: equity }, ledger) as any;
      expect(preview).toMatchObject({ plan_id: null, dry_run: true });
      expect((ledger.db.prepare("SELECT count(*) AS count FROM statement_plans").get() as any).count).toBe(0n);

      const plan = callTool("refresh_statement", { action: "plan", file_path: statementPath, account_id: checking, counterpart_account_id: equity, dry_run: false }, ledger) as any;
      expect(plan.plan_id).toEqual(expect.stringMatching(/^stmtplan_/));
      expect(plan.actions.new_posted).toBe(1);
      expect((ledger.db.prepare("SELECT count(*) AS count FROM statement_plan_rows WHERE plan_id = ?").get(plan.plan_id) as any).count).toBe(1n);
      const discardPreview = callTool("refresh_statement", { action: "discard", plan_id: plan.plan_id }, ledger) as any;
      expect(discardPreview).toMatchObject({ dry_run: true, would_discard: true, status: "planned" });
      expect(ledger.getStatementPlan(plan.plan_id)?.status).toBe("planned");
      const reversePreview = callTool("reverse_ledger_operation", { operation_id: plan.operation_id }, ledger) as any;
      expect(reversePreview).toMatchObject({ dry_run: true, reversible: true });
      expect(reversePreview.row_reversals).toEqual(expect.arrayContaining([
        expect.objectContaining({ table: "statement_plans", action: "discard", reason: expect.stringContaining("discarded") })
      ]));
      callTool("reverse_ledger_operation", { operation_id: plan.operation_id, dry_run: false }, ledger);
      expect(ledger.getStatementPlan(plan.plan_id)?.status).toBe("discarded");
      expect((callTool("get_ledger_operation", { operation_id: plan.operation_id }, ledger) as any).status).toBe("reversed");
      expect(() => ledger.db.prepare("UPDATE statement_plan_rows SET description = 'changed' WHERE plan_id = ?").run(plan.plan_id)).toThrow(/immutable/);
      expect(() => ledger.db.prepare("DELETE FROM statement_plans WHERE id = ?").run(plan.plan_id)).toThrow(/audit records/);
    } finally {
      ledger.close();
    }
  });

  it("surfaces realized planned rows during statement review", () => {
    const ledger = tempLedger();
    try {
      const dir = mkdtempSync(join(tmpdir(), "clovis-realized-planned-statement-"));
      dirs.push(dir);
      const usd = ledger.createAsset("USD", "currency", 2);
      const checking = ledger.createAccount("Checking", "asset");
      const equity = ledger.createAccount("Equity", "equity");
      for (const accountId of [checking, equity]) ledger.createAnnotation("account", accountId, "default_asset", usd);
      const posted = ledger.recordTransaction("2026-06-01", 2500n, equity, checking, usd, "Deposit", "posted");
      const planned = ledger.recordTransaction("2026-06-02", 2500n, equity, checking, usd, "Deposit", "planned");
      const statementPath = join(dir, "statement.csv");
      writeFileSync(statementPath, "date,amount,description\n2026-06-01,25.00,Deposit\n", "utf8");

      const plan = callTool("refresh_statement", { action: "plan", file_path: statementPath, account_id: checking, counterpart_account_id: equity }, ledger) as any;
      expect(plan.actions.matched).toBe(1);
      expect(plan.realized_planned_count).toBe(1);
      expect(plan.realized_planned_rows[0]).toMatchObject({ planned_tx_id: planned.id, matched_tx_id: posted.id });
      expect(plan.warnings).toContain("realized planned rows should be reconciled or voided before planned projections");
    } finally {
      ledger.close();
    }
  });

  it("plans, applies, and verifies a full statement refresh lifecycle", () => {
    const ledger = tempLedger();
    try {
      const dir = mkdtempSync(join(tmpdir(), "clovis-refresh-"));
      dirs.push(dir);
      const usd = ledger.createAsset("USD", "currency", 2);
      const checking = ledger.createAccount("Checking", "asset");
      const equity = ledger.createAccount("Equity", "equity");
      for (const accountId of [checking, equity]) ledger.createAnnotation("account", accountId, "default_asset", usd);
      const pending = ledger.recordTransaction("2026-06-01", 500n, equity, checking, usd, "Pending deposit", "pending");
      const stale = ledger.recordTransaction("2026-06-02", 200n, equity, checking, usd, "Stale pending", "pending");
      const statementPath = join(dir, "statement.csv");
      writeFileSync(statementPath, "date,amount,description\n2026-06-01,5.00,Pending deposit\n2026-06-03,3.00,New deposit\n", "utf8");

      const plan = callTool("refresh_statement", {
        action: "plan",
        file_path: statementPath,
        account_id: checking,
        counterpart_account_id: equity,
        expected_balance: 8,
        void_stale_pending: true,
        pending_transactions: [{ date: "2026-06-04", amount: 1.5, description: "Fresh pending" }],
        dry_run: false
      }, ledger) as any;
      expect(plan.actions).toMatchObject({ pending_to_commit: 1, new_posted: 1, new_pending: 1, stale_pending_to_void: 1, ambiguous: 0 });
      expect(plan.balance_matches).toBe(true);

      const preview = callTool("refresh_statement", { action: "apply", plan_id: plan.plan_id }, ledger) as any;
      expect(preview).toMatchObject({ dry_run: true, would_apply: 4 });
      expect(ledger.getTx(pending.id)?.status).toBe("pending");
      expect(ledger.getTx(stale.id)?.status).toBe("pending");

      const applied = callTool("refresh_statement", { action: "apply", plan_id: plan.plan_id, dry_run: false }, ledger) as any;
      expect(applied).toMatchObject({ created: 2, committed: 1, voided: 1, balance_matches: true });
      expect(applied.actual_balance_cents).toBe(800);
      expect(ledger.getTx(pending.id)?.status).toBe("posted");
      expect(ledger.getTx(stale.id)?.status).toBe("void");
      expect(ledger.balanceTree(checking, usd, null, "posted")).toBe(800n);
      expect(ledger.balanceTree(checking, usd, null, "pending")).toBe(-150n);

      const verified = callTool("refresh_statement", { action: "verify", plan_id: plan.plan_id }, ledger) as any;
      expect(verified).toMatchObject({ verified: true, mismatches: [] });
      expect(() => callTool("refresh_statement", { action: "apply", plan_id: plan.plan_id, dry_run: false }, ledger)).toThrow(/is applied/);
    } finally {
      ledger.close();
    }
  });

  it("process_statement applies only true unmatched rows from duplicate-rich statements", () => {
    const ledger = tempLedger();
    try {
      const dir = mkdtempSync(join(tmpdir(), "clovis-safe-process-"));
      dirs.push(dir);
      const usd = ledger.createAsset("USD", "currency", 2);
      const checking = ledger.createAccount("Checking", "asset");
      const equity = ledger.createAccount("Equity", "equity");
      for (const accountId of [checking, equity]) ledger.createAnnotation("account", accountId, "default_asset", usd);
      ledger.recordTransaction("2026-06-01", 2500n, equity, checking, usd, "Older row without FITID", "posted");
      const statementPath = join(dir, "statement.csv");
      writeFileSync(statementPath, "date,amount,description\n2026-06-01,25.00,Older row without FITID\n2026-06-02,5.00,New row\n", "utf8");

      const result = callTool("process_statement", { file_path: statementPath, account_id: checking, counterpart_account_id: equity, expected_balance: 30, commit: true }, ledger) as any;
      expect(result.actions).toMatchObject({ matched: 1, new_posted: 1 });
      expect(result).toMatchObject({ matched_existing: 1, new_rows: 1, ambiguous_count: 0, ignored_count: 0, would_import: 1, would_apply: 1 });
      expect(result).not.toHaveProperty("skipped_duplicates");
      expect(result.created).toBe(1);
      expect(result.skipped).toBe(1);
      expect(ledger.listTransactions({ status: "posted" }).filter((tx) => tx.description === "Older row without FITID")).toHaveLength(1);
      expect(ledger.balanceTree(checking, usd, null, "posted")).toBe(3000n);
    } finally {
      ledger.close();
    }
  });

  it("accepts user-facing positive expected balances for credit-card statements", () => {
    const ledger = tempLedger();
    try {
      const dir = mkdtempSync(join(tmpdir(), "clovis-card-balance-"));
      dirs.push(dir);
      const usd = ledger.createAsset("USD", "currency", 2);
      const card = ledger.createAccount("Visa", "liability");
      const shopping = ledger.createAccount("Shopping", "expense");
      for (const accountId of [card, shopping]) ledger.createAnnotation("account", accountId, "default_asset", usd);
      const statementPath = join(dir, "visa.csv");
      writeFileSync(statementPath, "date,amount,description\n2026-06-01,-10.00,Card charge\n", "utf8");

      expect(() => callTool("refresh_statement", { action: "plan", file_path: statementPath, account_id: card, counterpart_account_id: shopping, expected_balance: 10 }, ledger)).toThrow(/expected_balance/);
      const plan = callTool("refresh_statement", { action: "plan", file_path: statementPath, account_id: card, counterpart_account_id: shopping, expected_balance: 10, statement_type: "credit_card" }, ledger) as any;
      expect(plan).toMatchObject({ dry_run: true, balance_matches: true, expected_balance_cents: -1000, planned_balance_cents: -1000, balance_sign: "user_facing_liability" });
    } finally {
      ledger.close();
    }
  });

  it("previews import writes without mutating and returns tags after real imports", () => {
    const ledger = tempLedger();
    try {
      const usd = ledger.createAsset("USD", "currency", 2);
      const checking = ledger.createAccount("Checking", "asset");
      const equity = ledger.createAccount("Equity", "equity");
      for (const accountId of [checking, equity]) ledger.createAnnotation("account", accountId, "default_asset", usd);

      const dryRun = callTool("import_transactions", {
        account_id: checking,
        counterpart_id: equity,
        asset_id: usd,
        dry_run: true,
        transactions: [{ date: "2026-06-01", amount: 25, description: "Preview deposit", tags: { kind: "preview" } }]
      }, ledger) as any;
      expect(dryRun).toMatchObject({ dry_run: true, would_create: 1, created: 0 });
      expect(dryRun.transactions[0].entries).toHaveLength(2);
      expect(ledger.listTransactions({ status: null })).toHaveLength(0);

      const imported = callTool("import_transactions", {
        account_id: checking,
        counterpart_id: equity,
        asset_id: usd,
        tags: { import_kind: "manual" },
        transactions: [{ date: "2026-06-01", amount: 25, description: "Preview deposit", tags: { row_kind: "statement" } }]
      }, ledger) as any;
      expect(imported.created).toBe(1);
      expect(imported.transactions[0].tags).toContainEqual(expect.objectContaining({ key: "import_kind", value: "manual" }));
      expect(imported.transactions[0].tags).toContainEqual(expect.objectContaining({ key: "row_kind", value: "statement" }));

      callTool("delete_transaction", { id: imported.transactions[0].id }, ledger);
      const reimported = callTool("import_transactions", {
        account_id: checking,
        counterpart_id: equity,
        asset_id: usd,
        transactions: [{ date: "2026-06-01", amount: 25, description: "Preview deposit" }]
      }, ledger) as any;
      expect(reimported).toMatchObject({ created: 1, skipped: 0 });

      ledger.recordTransaction("2026-06-02", 1000n, equity, checking, usd, "Planned deposit", "planned");
      const landedPlanned = callTool("import_transactions", {
        account_id: checking,
        counterpart_id: equity,
        asset_id: usd,
        transactions: [{ date: "2026-06-02", amount: 10, description: "Planned deposit" }]
      }, ledger) as any;
      expect(landedPlanned).toMatchObject({ created: 1, skipped: 0 });
    } finally {
      ledger.close();
    }
  });

  it("parses CSV date wrappers and requires explicit ambiguous numeric date formats", () => {
    const ledger = tempLedger();
    try {
      const dir = mkdtempSync(join(tmpdir(), "clovis-flex-csv-"));
      dirs.push(dir);
      const usd = ledger.createAsset("USD", "currency", 2);
      const checking = ledger.createAccount("Checking", "asset");
      const equity = ledger.createAccount("Equity", "equity");
      for (const accountId of [checking, equity]) ledger.createAnnotation("account", accountId, "default_asset", usd);

      const wrappedPath = join(dir, "wrapped.csv");
      writeFileSync(wrappedPath, "Downloaded from Bank\ndate,amount,description\n\"June 10, 2026\",12.34,Named date\nFooter disclaimer\n", "utf8");
      const wrapped = callTool("preview_import", { file_path: wrappedPath, account_id: checking, counterpart_account_id: equity, skip_rows: 1, skip_footer_rows: 1 }, ledger) as any;
      expect(wrapped.rows).toHaveLength(1);
      expect(wrapped.rows[0]).toMatchObject({ date: "2026-06-10", amount: 12.34, description: "Named date" });

      const ambiguousPath = join(dir, "ambiguous.csv");
      writeFileSync(ambiguousPath, "date,amount,description\n06/10/2026,1.00,Ambiguous\n", "utf8");
      expect(() => callTool("preview_import", { file_path: ambiguousPath, account_id: checking, counterpart_account_id: equity }, ledger)).toThrow(/Ambiguous date/);
      const explicit = callTool("preview_import", { file_path: ambiguousPath, account_id: checking, counterpart_account_id: equity, date_format: "mdy" }, ledger) as any;
      expect(explicit.rows[0].date).toBe("2026-06-10");
    } finally {
      ledger.close();
    }
  });

  it("rejects non-positive amounts on manual transaction wrappers", () => {
    const ledger = tempLedger();
    try {
      callTool("init_defaults", { template: "personal", currency: "USD" }, ledger);
      const accounts = Object.fromEntries((callTool("list_accounts", {}, ledger) as any[]).map((row) => [row.name, row.id]));
      const usd = (callTool("get_asset_by_symbol", { symbol: "USD" }, ledger) as any).id;
      const eur = (callTool("create_asset", { symbol: "EUR", asset_type: "currency", decimals: 2 }, ledger) as any).id;
      const brokerage = (callTool("create_account", { name: "Brokerage", type: "asset", default_asset_id: usd }, ledger) as any).id;
      const fxClearing = (callTool("create_account", { name: "FX Clearing", type: "asset", default_asset_id: usd }, ledger) as any).id;

      expect(() => callTool("create_transaction", { date: "2026-06-01", amount: 0, from_account_id: accounts.Salary, to_account_id: accounts.Checking, description: "Zero", status: "posted" }, ledger)).toThrow(/positive/);
      expect(() => callTool("create_transaction", { date: "2026-06-01", amount: -12.34, from_account_id: accounts.Salary, to_account_id: accounts.Checking, description: "Negative", status: "posted" }, ledger)).toThrow(/positive/);
      expect(() => callTool("transfer", { date: "2026-06-01", amount: 0, from_account_id: accounts.Checking, to_account_id: accounts.Savings, description: "Zero move" }, ledger)).toThrow(/positive/);
      expect(() => callTool("fx_transfer", { date: "2026-06-01", from_amount: 0, to_amount: 9, from_account_id: accounts.Checking, to_account_id: accounts.Savings, from_asset_id: usd, to_asset_id: eur, fx_account_id: fxClearing, description: "Zero FX" }, ledger)).toThrow(/positive/);
      expect(() => callTool("create_scheduled_transaction", { date: "2026-06-01", amount: 0, from_account_id: accounts.Checking, to_account_id: accounts.Groceries, description: "Zero schedule" }, ledger)).toThrow(/positive/);
      expect(() => callTool("record_investment", { date: "2026-06-01", amount: -1, source_account_id: accounts.Checking, investment_account_id: brokerage, description: "Negative investment" }, ledger)).toThrow(/positive/);
    } finally {
      ledger.close();
    }
  });

  it("keeps void and planned rows out of bulk match-rule application", () => {
    const ledger = tempLedger();
    try {
      callTool("init_defaults", { template: "personal", currency: "USD" }, ledger);
      const accounts = Object.fromEntries((callTool("list_accounts", {}, ledger) as any[]).map((row) => [row.name, row.id]));
      callTool("add_match_rule", { account_id: accounts.Groceries, pattern: "Lifecycle Merchant" }, ledger);
      const active = callTool("create_transaction", { date: "2026-06-01", amount: 10, from_account_id: accounts.Checking, to_account_id: accounts.Uncategorized, description: "Lifecycle Merchant", status: "pending" }, ledger) as any;
      const voided = callTool("create_transaction", { date: "2026-06-02", amount: 10, from_account_id: accounts.Checking, to_account_id: accounts.Uncategorized, description: "Lifecycle Merchant", status: "posted" }, ledger) as any;
      callTool("delete_transaction", { id: voided.id }, ledger);
      const planned = callTool("plan_transaction", { date: "2026-06-03", amount: 10, from_account_id: accounts.Checking, to_account_id: accounts.Uncategorized, description: "Lifecycle Merchant" }, ledger) as any;

      const preview = callTool("apply_match_rules", { catch_all_account_id: accounts.Uncategorized }, ledger) as any;
      expect(preview).toMatchObject({ matched: 1, updated: 0, dry_run: true });
      expect(preview.transactions.map((row: any) => row.tx_id)).toEqual([active.id]);

      const applied = callTool("apply_match_rules", { catch_all_account_id: accounts.Uncategorized, dry_run: false }, ledger) as any;
      expect(applied).toMatchObject({ matched: 1, updated: 1, dry_run: false });
      expect(ledger.getEntries(active.id)).toContainEqual(expect.objectContaining({ account_id: accounts.Groceries }));
      expect(ledger.getEntries(voided.id)).toContainEqual(expect.objectContaining({ account_id: accounts.Uncategorized }));
      expect(ledger.getEntries(planned.id)).toContainEqual(expect.objectContaining({ account_id: accounts.Uncategorized }));
    } finally {
      ledger.close();
    }
  });

  it("does not move or migrate voided journal lines", () => {
    const ledger = tempLedger();
    try {
      callTool("init_defaults", { template: "personal", currency: "USD" }, ledger);
      const accounts = Object.fromEntries((callTool("list_accounts", {}, ledger) as any[]).map((row) => [row.name, row.id]));
      const usd = (callTool("get_asset_by_symbol", { symbol: "USD" }, ledger) as any).id;
      const cad = (callTool("create_asset", { symbol: "CAD", asset_type: "currency", decimals: 2 }, ledger) as any).id;
      const posted = ledger.recordTransaction("2026-06-01", 1000n, accounts.Checking, accounts.Uncategorized, cad, "Moveable CAD", "posted");
      const voided = ledger.recordTransaction("2026-06-02", 2000n, accounts.Checking, accounts.Uncategorized, cad, "Voided CAD", "posted");
      ledger.voidTx(voided.id);

      expect(callTool("move_transactions", { from_account: accounts.Uncategorized, to_account: accounts.Groceries }, ledger)).toMatchObject({ matched: 1, moved: 0, dry_run: true });
      expect(callTool("move_transactions", { from_account: accounts.Uncategorized, to_account: accounts.Groceries, dry_run: false }, ledger)).toMatchObject({ matched: 1, moved: 1, dry_run: false });
      expect(ledger.getEntries(posted.id)).toContainEqual(expect.objectContaining({ account_id: accounts.Groceries }));
      expect(ledger.getEntries(voided.id)).toContainEqual(expect.objectContaining({ account_id: accounts.Uncategorized }));

      expect(callTool("migrate_asset_entries", { from_asset_id: cad, to_asset_id: usd }, ledger)).toMatchObject({ matched: 2, updated: 0, dry_run: true });
      expect(callTool("migrate_asset_entries", { from_asset_id: cad, to_asset_id: usd, dry_run: false }, ledger)).toMatchObject({ matched: 2, updated: 2, dry_run: false });
      expect(ledger.getEntries(posted.id).every((entry) => entry.asset_id === usd)).toBe(true);
      expect(ledger.getEntries(voided.id).every((entry) => entry.asset_id === cad)).toBe(true);
    } finally {
      ledger.close();
    }
  });

  it("honors reconciliation plan row controls before writing", () => {
    const ledger = tempLedger();
    try {
      const dir = mkdtempSync(join(tmpdir(), "clovis-reconcile-plan-"));
      dirs.push(dir);
      const usd = ledger.createAsset("USD", "currency", 2);
      const checking = ledger.createAccount("Checking", "asset");
      const equity = ledger.createAccount("Equity", "equity");
      for (const accountId of [checking, equity]) ledger.createAnnotation("account", accountId, "default_asset", usd);

      const preamblePath = join(dir, "preamble.csv");
      writeFileSync(preamblePath, "Downloaded from Bank\ndate,amount,description\n2026-06-01,25.00,Deposit\n", "utf8");
      const preview = callTool("preview_import", { file_path: preamblePath, account_id: checking, counterpart_account_id: equity, skip_rows: 1 }, ledger) as any;
      expect(preview.total_rows).toBe(1);
      expect(preview.rows[0]).toMatchObject({ date: "2026-06-01", amount: 25 });

      const statementPath = join(dir, "statement.csv");
      writeFileSync(statementPath, "date,amount,description\n2026-06-01,10.00,First\n2026-06-02,20.00,Second\n", "utf8");
      expect(() => callTool("apply_reconciliation_plan", { file_path: statementPath, account_id: checking, counterpart_account_id: equity, expected_balance: 29.99, dry_run: false }, ledger)).toThrow(/expected_balance/);
      expect(ledger.balanceTree(checking, usd, null, null)).toBe(0n);

      const applied = callTool("apply_reconciliation_plan", { file_path: statementPath, account_id: checking, counterpart_account_id: equity, row_indexes: [1], expected_balance: 20, dry_run: false }, ledger) as any;
      expect(applied).toMatchObject({ created: 1, skipped: 0, balance_matches: true });
      expect(applied.transactions[0].description).toBe("Second");
      expect(ledger.balanceTree(checking, usd, null, "pending")).toBe(2000n);

      const duplicate = callTool("import_transactions", {
        account_id: checking,
        counterpart_id: equity,
        asset_id: usd,
        transactions: [{ date: "2026-06-02", amount: 20, description: "Second" }]
      }, ledger) as any;
      expect(duplicate).toMatchObject({ created: 0, skipped: 1 });

      const nearbyPath = join(dir, "nearby.csv");
      writeFileSync(nearbyPath, "date,amount,description\n2026-06-04,20.00,Second\n", "utf8");
      const plan = callTool("reconcile_statement_plan", { file_path: nearbyPath, account_id: checking, counterpart_account_id: equity, date_tolerance_days: 3 }, ledger) as any;
      expect(plan).toMatchObject({ matched: 0, unmatched: 1, reconciled: false });
      expect(plan.actions.pending_to_commit).toBe(1);
    } finally {
      ledger.close();
    }
  });

  it("returns candidate details for ambiguous statement rows", () => {
    const ledger = tempLedger();
    try {
      const dir = mkdtempSync(join(tmpdir(), "clovis-ambiguous-plan-"));
      dirs.push(dir);
      const usd = ledger.createAsset("USD", "currency", 2);
      const checking = ledger.createAccount("Checking", "asset");
      const equity = ledger.createAccount("Equity", "equity");
      for (const accountId of [checking, equity]) ledger.createAnnotation("account", accountId, "default_asset", usd);
      const first = ledger.recordTransaction("2026-06-01", 1000n, equity, checking, usd, "Store A", "posted");
      const second = ledger.recordTransaction("2026-06-01", 1000n, equity, checking, usd, "Store B", "posted");
      const statementPath = join(dir, "statement.csv");
      writeFileSync(statementPath, "date,amount,description\n2026-06-01,10.00,Store\n", "utf8");

      const plan = callTool("reconcile_statement_plan", { file_path: statementPath, account_id: checking, counterpart_account_id: equity, date_tolerance_days: 0 }, ledger) as any;
      expect(plan.actions.ambiguous).toBe(1);
      expect(plan.ambiguous[0].candidates.map((candidate: any) => candidate.journal_id).sort()).toEqual([first.id, second.id].sort());
      expect(plan.ambiguous[0].candidates[0]).toEqual(expect.objectContaining({ date: "2026-06-01", amount_cents: 1000, score: expect.any(Number), reasons: expect.arrayContaining(["amount", "date_tolerance"]) }));
    } finally {
      ledger.close();
    }
  });

  it("previews and reconciles QFX statement files", () => {
    const ledger = tempLedger();
    try {
      const dir = mkdtempSync(join(tmpdir(), "clovis-qfx-"));
      dirs.push(dir);
      const usd = ledger.createAsset("USD", "currency", 2);
      const checking = ledger.createAccount("Checking", "asset");
      const equity = ledger.createAccount("Equity", "equity");
      for (const accountId of [checking, equity]) ledger.createAnnotation("account", accountId, "default_asset", usd);
      ledger.recordTransaction("2026-06-01", 1250n, equity, checking, usd, "Existing QFX row", "posted", { externalId: "fitid-1" });

      const statementPath = join(dir, "statement.qfx");
      writeFileSync(statementPath, [
        "OFXHEADER:100",
        "DATA:OFXSGML",
        "<OFX>",
        "<BANKTRANLIST>",
        "<STMTTRN>",
        "<TRNTYPE>CREDIT",
        "<DTPOSTED>20260601120000[-5:EST]",
        "<TRNAMT>12.50",
        "<FITID>fitid-1",
        "<NAME>Existing QFX row",
        "</STMTTRN>",
        "<STMTTRN>",
        "<TRNTYPE>DEBIT",
        "<DTPOSTED>20260602120000[-5:EST]",
        "<TRNAMT>-4.25",
        "<FITID>fitid-2",
        "<NAME>Coffee",
        "<MEMO>Morning coffee",
        "</STMTTRN>",
        "</BANKTRANLIST>",
        "</OFX>"
      ].join("\n"), "utf8");

      const preview = callTool("preview_import", { file_path: statementPath, account_id: checking, counterpart_account_id: equity }, ledger) as any;
      expect(preview.total_rows).toBe(2);
      expect(preview.rows[0]).toMatchObject({ date: "2026-06-01", amount: 12.5, description: "Existing QFX row", external_id: "fitid-1" });

      const plan = callTool("reconcile_statement_plan", { file_path: statementPath, account_id: checking, counterpart_account_id: equity, date_tolerance_days: 0 }, ledger) as any;
      expect(plan).toMatchObject({ matched: 1, unmatched: 1, reconciled: false });
      expect(plan.rows[1]).toMatchObject({ date: "2026-06-02", amount: -4.25, description: "Coffee" });
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
      process.env.CLOVIS_DB = join(dir, "ledger.db");
      try {
        const usd = ledger.createAsset("USD", "currency", 2);
        const checking = ledger.createAccount("Checking", "asset");
        const equity = ledger.createAccount("Equity", "equity");
        const dining = ledger.createAccount("Dining", "expense");
        for (const accountId of [checking, equity, dining]) ledger.createAnnotation("account", accountId, "default_asset", usd);
        const rowsPath = join(dir, "rows.csv");
        writeFileSync(rowsPath, "date,amount,description,counterpart,kind\n2026-06-01,-12.50,Coffee,Dining,meal\n", "utf8");

        const result = callTool("import_file", { file_path: rowsPath, account_id: checking, counterpart_account_id: equity, counterpart_col: "counterpart", tag_cols: { kind: "kind" }, status: "posted" }, ledger) as any;
        expect(result.created).toBe(1);
        const tx = callTool("get_transaction", { id: result.transactions[0].id }, ledger) as any;
        expect(tx.entries.some((entry: any) => entry.account_id === dining)).toBe(true);
        expect(tx.tags).toContainEqual(expect.objectContaining({ key: "kind", value: "meal" }));
        expect(ledger.balance(checking, usd)).toBe(-1250n);
      } finally {
        if (previousDb == null) delete process.env.CLOVIS_DB; else process.env.CLOVIS_DB = previousDb;
      }
    } finally {
      ledger.close();
    }
  });

  it("rejects malformed and oversized statement imports", () => {
    const ledger = tempLedger();
    try {
      const dir = mkdtempSync(join(tmpdir(), "clovis-bad-import-"));
      dirs.push(dir);
      const previousDb = process.env.CLOVIS_DB;
      process.env.CLOVIS_DB = join(dir, "ledger.db");
      try {
        const usd = ledger.createAsset("USD", "currency", 2);
        const checking = ledger.createAccount("Checking", "asset");
        const equity = ledger.createAccount("Equity", "equity");
        for (const accountId of [checking, equity]) ledger.createAnnotation("account", accountId, "default_asset", usd);

        const badQuotesPath = join(dir, "bad-quotes.csv");
        writeFileSync(badQuotesPath, "date,amount,description\n2026-06-01,1.00,\"unterminated\n", "utf8");
        expect(() => callTool("preview_import", { file_path: badQuotesPath, account_id: checking, counterpart_account_id: equity }, ledger)).toThrow(/Invalid CSV quote/);

        const badAmountPath = join(dir, "bad-amount.csv");
        writeFileSync(badAmountPath, "date,amount,description\n2026-06-01,not-money,Bad\n", "utf8");
        expect(() => callTool("preview_import", { file_path: badAmountPath, account_id: checking, counterpart_account_id: equity }, ledger)).toThrow(/Invalid amount/);

        const rows = Array.from({ length: 10001 }, (_, index) => `2026-06-01,${index + 1},Row`).join("\n");
        const tooManyPath = join(dir, "too-many.csv");
        writeFileSync(tooManyPath, `date,amount,description\n${rows}\n`, "utf8");
        expect(() => callTool("preview_import", { file_path: tooManyPath, account_id: checking, counterpart_account_id: equity }, ledger)).toThrow(/too many rows/);
      } finally {
        if (previousDb == null) delete process.env.CLOVIS_DB; else process.env.CLOVIS_DB = previousDb;
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

  it("lists tag-only import batches and resolves them for batch operations", () => {
    const ledger = tempLedger();
    try {
      const usd = ledger.createAsset("USD", "currency", 2);
      const checking = ledger.createAccount("Checking", "asset");
      const equity = ledger.createAccount("Equity", "equity");
      const tx = ledger.recordTransaction("2026-06-01", 2500n, equity, checking, usd, "Manual pending", "pending");
      ledger.createAnnotation("tx", tx.id, "import_batch", "manual-pending-20260608T161311294225");

      const batches = callTool("list_import_batches", {}, ledger) as any[];
      expect(batches).toContainEqual(expect.objectContaining({
        id: "manual-pending-20260608T161311294225",
        origin: "tag",
        tx_count: 1
      }));

      const committed = callTool("commit_batch", { batch_id: "manual-pending-20260608T161311294225" }, ledger) as any;
      expect(committed.committed).toBe(1);
      expect(ledger.getTx(tx.id)?.status).toBe("posted");
    } finally {
      ledger.close();
    }
  });

  it("sets SQLite WAL mode and a busy timeout for concurrent local clients", () => {
    const ledger = tempLedger();
    try {
      expect((ledger.db.prepare("PRAGMA journal_mode").get() as any).journal_mode).toBe("wal");
      expect(Number((ledger.db.prepare("PRAGMA busy_timeout").get() as any).timeout)).toBeGreaterThanOrEqual(5000);
    } finally {
      ledger.close();
    }
  });

  it("allows concurrent read-only CLI clients against the same database", async () => {
    const ledger = tempLedger();
    try {
      callTool("init_defaults", { template: "personal", currency: "USD" }, ledger);
      const accounts = Object.fromEntries((callTool("list_accounts", {}, ledger) as any[]).map((row) => [row.name, row.id]));
      callTool("create_transaction", { date: "2026-06-01", amount: 100, from_account_id: accounts.Salary, to_account_id: accounts.Checking, description: "Posted", status: "posted" }, ledger);

      const results = await Promise.all(Array.from({ length: 8 }, () => execFileAsync(process.execPath, [
        "dist/cli/main.js",
        "--db",
        ledger.path,
        "--format",
        "json",
        "tool",
        "count_transactions",
        "--json",
        JSON.stringify({ status: "all" })
      ], { cwd: process.cwd(), encoding: "utf8" })));

      for (const result of results) {
        const envelope = JSON.parse(String(result.stdout));
        expect(envelope).toMatchObject({ ok: true, data: { count: 1 } });
      }
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

  it("protects lot-linked journals from generic void and delete workflows", () => {
    const ledger = tempLedger();
    try {
      callTool("init_defaults", { template: "personal", currency: "USD" }, ledger);
      const accounts = Object.fromEntries((callTool("list_accounts", {}, ledger) as any[]).map((row) => [row.name, row.id]));
      const tx = callTool("buy_security", { account_id: accounts.Checking, symbol: "AAPL", shares: "1.5", total_cost_cents: 12345, date: "2026-06-01" }, ledger) as any;
      const lot = ledger.listLots()[0];
      expect(lot.opened_journal_id).toBe(tx.id);
      expect(lot.status).toBe("open");

      expect(() => callTool("delete_transaction", { id: tx.id }, ledger)).toThrow(/linked investment lots/);
      expect(() => callTool("delete_transaction", { id: tx.id, hard_delete: true }, ledger)).toThrow(/linked investment lots/);
      expect(() => callTool("recategorize_transaction", { tx_id: tx.id, new_account_id: accounts.Groceries }, ledger)).toThrow(/linked investment lots/);
      expect(ledger.getTx(tx.id)?.status).toBe("posted");
      expect(ledger.listLots()).toHaveLength(1);
      expect((callTool("integrity_check", {}, ledger) as any).ok).toBe(true);
    } finally {
      ledger.close();
    }
  });

  it("cleans owned annotations on hard deletes and repairs orphan annotations", () => {
    const ledger = tempLedger();
    try {
      const usd = ledger.createAsset("USD", "currency", 2);
      const checking = ledger.createAccount("Checking", "asset");
      const equity = ledger.createAccount("Equity", "equity");
      const tx = ledger.recordTransaction("2026-06-01", 100n, equity, checking, usd, "Seed", "posted");
      ledger.createAnnotation("tx", tx.id, "memo", "delete me");
      ledger.deleteTx(tx.id);
      expect(ledger.listAnnotations("tx", tx.id)).toEqual([]);

      const temp = ledger.createAccount("Temp", "asset");
      ledger.createAnnotation("account", temp, "default_asset", usd);
      ledger.deleteAccount(temp);
      expect(ledger.listAnnotations("account", temp)).toEqual([]);

      ledger.createAnnotation("tx", "tx_missing", "memo", "orphan");
      const before = callTool("integrity_check", {}, ledger) as any;
      expect(before.ok).toBe(false);
      expect(before.orphan_annotations).toHaveLength(1);
      const repaired = callTool("repair_integrity", { dry_run: false, backup: false }, ledger) as any;
      expect(repaired.repaired).toBe(1);
      expect(repaired.ok).toBe(true);
      expect(callTool("integrity_check", {}, ledger)).toMatchObject({ ok: true });
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

  it("allows ordinary filesystem paths while blocking overwrites and invalid suffixes", () => {
    const ledger = tempLedger();
    try {
      const dir = mkdtempSync(join(tmpdir(), "clovis-files-"));
      dirs.push(dir);
      const previousDb = process.env.CLOVIS_DB;
      process.env.CLOVIS_DB = join(dir, "ledger.db");
      try {
        callTool("init_defaults", { template: "personal", currency: "USD" }, ledger);
        const result = callTool("export_ledger", { output_path: join(dir, "snapshot.json") }, ledger) as any;
        expect(String(result.file).endsWith("snapshot.json")).toBe(true);
        expect(() => callTool("export_ledger", { output_path: join(dir, "snapshot.json") }, ledger)).toThrow(/already exists/);
        expect(() => callTool("export_ledger", { output_path: join(dir, "snapshot.txt") }, ledger)).toThrow(/File suffix not allowed/);
        const outside = mkdtempSync(join(tmpdir(), "clovis-outside-"));
        dirs.push(outside);
        writeFileSync(join(outside, "statement.csv"), "date,amount,description\n2026-06-01,1.00,Escape\n", "utf8");
        const imported = callTool("import_file", { file_path: join(outside, "statement.csv"), account_id: "Checking", counterpart_account_id: "Opening Balances" }, ledger) as any;
        expect(imported.created).toBe(1);
      } finally {
        if (previousDb == null) delete process.env.CLOVIS_DB; else process.env.CLOVIS_DB = previousDb;
      }
    } finally {
      ledger.close();
    }
  });

  it("reports unrestricted file access and reads explicit workspace paths", () => {
    const ledger = tempLedger();
    try {
      const workspace = mkdtempSync(join(tmpdir(), "clovis-workspace-"));
      dirs.push(workspace);
      callTool("init_defaults", { template: "personal", currency: "USD" }, ledger);
      writeFileSync(join(workspace, "statement.csv"), "date,amount,description\n2026-06-01,1.00,Allowed\n", "utf8");

      const status = callTool("file_access_status", {}, ledger) as any;
      expect(status.mode).toBe("unrestricted");
      expect(status.path_policy).toContain("operating system permits");

      const registry = callTool("tool_registry", {}, ledger) as any;
      expect(registry.file_access.mode).toBe("unrestricted");
      expect(registry.tools.find((tool: any) => tool.name === "file_access_status").safety.readOnlyHint).toBe(true);

      const preview = callTool("preview_import", { file_path: join(workspace, "statement.csv"), account_id: "Checking", counterpart_account_id: "Opening Balances" }, ledger) as any;
      expect(preview.total_rows).toBe(1);
      expect(preview.rows[0].description).toBe("Allowed");
    } finally {
      ledger.close();
    }
  });

  it("runs MCP tools without capability gates", () => {
    const dir = mkdtempSync(join(tmpdir(), "clovis-mcp-cap-"));
    dirs.push(dir);
    const previousDb = process.env.CLOVIS_DB;
    process.env.CLOVIS_DB = join(dir, "ledger.db");
    try {
      const backup = callTool("backup_now", {}) as any;
      expect(String(backup.path)).toContain("backups");
      expect(String(backup.path)).not.toContain(dir);
      const explicitBackup = callTool("backup_now", { output_path: join(dir, "explicit-backup.db") }) as any;
      expect(explicitBackup.path).toBe(realpathSync(join(dir, "explicit-backup.db")));
      const disposable = callTool("create_account", { name: "Disposable", type: "expense" }) as any;
      expect((callTool("delete_account", { id: disposable.id }) as any).deleted).toBe(disposable.id);
      expect(() => callTool("delete_account", { id: "missing" })).toThrow(/not found/);
    } finally {
      if (previousDb == null) delete process.env.CLOVIS_DB; else process.env.CLOVIS_DB = previousDb;
    }
  });

  it("lists backup database files without treating SQLite sidecars as standalone backups", () => {
    const ledger = tempLedger();
    try {
      const backupDir = join(dirname(ledger.path), "backups");
      const dryRun = callTool("backup_now", { dry_run: true }, ledger) as any;
      expect(dryRun).toMatchObject({ dry_run: true, would_backup: true, compact: true });
      expect(String(dryRun.path)).toContain("backups");
      expect(existsSync(backupDir)).toBe(false);
      const explicitDryPath = join(dirname(ledger.path), "explicit-dry-run.db");
      const explicitDryRun = callTool("backup_now", { output_path: explicitDryPath, dry_run: true }, ledger) as any;
      expect(String(explicitDryRun.path)).toMatch(/explicit-dry-run\.db$/);
      expect(existsSync(String(explicitDryRun.path))).toBe(false);
      const preview = callTool("preview_mutation", { tool_name: "backup_now", arguments: { output_path: explicitDryPath } }, ledger) as any;
      expect(preview.dry_run).toBe(true);
      expect(preview.would_result.path).toBe(explicitDryRun.path);
      expect(existsSync(String(preview.would_result.path))).toBe(false);

      const backup = callTool("backup_now", {}, ledger) as any;
      expect(String(backup.path)).toContain("backups");
      const manual = join(backupDir, "manual.db");
      writeFileSync(manual, "backup");
      writeFileSync(`${manual}-wal`, "");
      writeFileSync(`${manual}-shm`, "sidecar");
      writeFileSync(join(backupDir, "orphan.db-wal"), "");

      const backups = callTool("list_backups", {}, ledger) as any[];
      expect(backups.some((row) => String(row.path).endsWith(".db-wal"))).toBe(false);
      expect(backups.some((row) => String(row.path).endsWith(".db-shm"))).toBe(false);
      expect(backups.some((row) => String(row.path).includes("orphan.db-wal"))).toBe(false);
      const manualBackup = backups.find((row) => String(row.path).endsWith("manual.db"));
      expect(manualBackup).toBeDefined();
      expect(manualBackup.sidecars.map((row: any) => row.type).sort()).toEqual(["shm", "wal"]);
      expect(manualBackup.sidecars.find((row: any) => row.type === "wal").size_bytes).toBe(0);
    } finally {
      ledger.close();
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

  it("posts atomic journal legs and rolls back recategorization batches", () => {
    const ledger = tempLedger();
    try {
      const usd = ledger.createAsset("USD", "currency", 2);
      const checking = ledger.createAccount("Checking", "asset");
      const equity = ledger.createAccount("Equity", "equity");
      const groceries = ledger.createAccount("Groceries", "expense");
      const dining = ledger.createAccount("Dining", "expense");

      const journal = callTool("post_journal_entry", {
        date: "2026-06-01",
        description: "Atomic journal",
        legs: [
          { account_id: checking, asset_id: usd, amount_cents: 1000 },
          { account_id: equity, asset_id: usd, amount_cents: -1000 }
        ],
        status: "posted"
      }, ledger) as any;
      expect(journal.entries.map((entry: any) => entry.quantity)).toEqual([1000, -1000]);

      const tx = ledger.recordTransaction("2026-06-02", 2500n, checking, groceries, usd, "Market", "posted");
      const recat = callTool("recategorize_by_pattern", { pattern: "Market", new_account_id: dining, old_account_id: groceries, status: "posted", dry_run: false }, ledger) as any;
      expect(ledger.getEntries(tx.id).map((entry) => entry.account_id)).toContain(dining);

      const rolled = callTool("rollback_recategorize", { batch_id: recat.batch_id }, ledger) as any;
      expect(rolled.rolled_back).toBe(1);
      const entries = ledger.getEntries(tx.id);
      expect(entries).toContainEqual(expect.objectContaining({ account_id: checking, quantity: -2500n }));
      expect(entries).toContainEqual(expect.objectContaining({ account_id: groceries, quantity: 2500n }));
      expect(entries.some((entry) => entry.account_id === dining)).toBe(false);
    } finally {
      ledger.close();
    }
  });

  it("previews, audits, and reverses single-transaction recategorization as ledger operations", () => {
    const ledger = tempLedger();
    try {
      const usd = ledger.createAsset("USD", "currency", 2);
      const checking = ledger.createAccount("Checking", "asset");
      const groceries = ledger.createAccount("Groceries", "expense");
      const dining = ledger.createAccount("Dining", "expense");
      const tx = ledger.recordTransaction("2026-06-02", 2500n, checking, groceries, usd, "Market", "posted");

      const preview = callTool("recategorize_transaction", { tx_id: tx.id, old_account_id: groceries, new_account_id: dining, dry_run: true }, ledger) as any;
      expect(preview).toMatchObject({
        dry_run: true,
        reversible: true,
        before_category: { account_id: groceries },
        after_category: { account_id: dining }
      });
      expect(ledger.listTransactions({ status: null })).toHaveLength(1);
      expect(ledger.getEntries(tx.id)).toContainEqual(expect.objectContaining({ account_id: groceries, quantity: 2500n }));

      const applied = callTool("recategorize_transaction", { tx_id: tx.id, old_account_id: groceries, new_account_id: dining }, ledger) as any;
      expect(applied.operation_id).toMatch(/^op_/);
      expect(applied.correction_journal_id).toMatch(/^tx_/);
      expect(applied.ledger_operation).toBeUndefined();
      expect(ledger.getEntries(tx.id)).toContainEqual(expect.objectContaining({ account_id: groceries, quantity: 2500n }));
      expect(ledger.getEntries(applied.correction_journal_id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ account_id: groceries, quantity: -2500n }),
        expect.objectContaining({ account_id: dining, quantity: 2500n })
      ]));

      const operation = callTool("get_ledger_operation", { operation_id: applied.operation_id }, ledger) as any;
      expect(operation).toMatchObject({ id: applied.operation_id, operation_type: "recategorize_transaction", status: "applied" });
      expect(operation.rows[0]).toMatchObject({ action: "correction", correction_journal_id: applied.correction_journal_id });

      const reversePreview = callTool("reverse_ledger_operation", { operation_id: applied.operation_id }, ledger) as any;
      expect(reversePreview).toMatchObject({ dry_run: true, reversible: true, operation_id: applied.operation_id });
      const reversed = callTool("reverse_ledger_operation", { operation_id: applied.operation_id, dry_run: false }, ledger) as any;
      expect(reversed.operation_id).toMatch(/^op_/);
      expect(reversed.reverse_journal_ids).toHaveLength(1);
      expect(ledger.getEntries(reversed.reverse_journal_ids[0])).toEqual(expect.arrayContaining([
        expect.objectContaining({ account_id: groceries, quantity: 2500n }),
        expect.objectContaining({ account_id: dining, quantity: -2500n })
      ]));
      expect((callTool("get_ledger_operation", { operation_id: applied.operation_id }, ledger) as any).status).toBe("reversed");
      expect(() => callTool("reverse_ledger_operation", { operation_id: applied.operation_id, dry_run: false }, ledger)).toThrow(/already reversed/);
    } finally {
      ledger.close();
    }
  });

  it("reverses pending recategorization operations in place", () => {
    const ledger = tempLedger();
    try {
      const usd = ledger.createAsset("USD", "currency", 2);
      const checking = ledger.createAccount("Checking", "asset");
      const groceries = ledger.createAccount("Groceries", "expense");
      const dining = ledger.createAccount("Dining", "expense");
      const tx = ledger.recordTransaction("2026-06-02", 2500n, checking, groceries, usd, "Pending Market", "pending");

      const applied = callTool("recategorize_transaction", { tx_id: tx.id, old_account_id: groceries, new_account_id: dining }, ledger) as any;
      expect(applied.operation_id).toMatch(/^op_/);
      expect(applied.correction_journal_id).toBeUndefined();
      expect(ledger.getEntries(tx.id)).toContainEqual(expect.objectContaining({ account_id: dining, quantity: 2500n }));

      const preview = callTool("reverse_ledger_operation", { operation_id: applied.operation_id }, ledger) as any;
      expect(preview).toMatchObject({ dry_run: true, reversible: true, reversal_strategy: "recategorize_in_place" });
      const reversed = callTool("reverse_ledger_operation", { operation_id: applied.operation_id, dry_run: false }, ledger) as any;
      expect(reversed).toMatchObject({ dry_run: false, reversal_strategy: "recategorize_in_place" });
      expect(ledger.getEntries(tx.id)).toContainEqual(expect.objectContaining({ account_id: groceries, quantity: 2500n }));
      expect((callTool("get_ledger_operation", { operation_id: applied.operation_id }, ledger) as any).status).toBe("reversed");
    } finally {
      ledger.close();
    }
  });

  it("oversees generic mutations with preview, audit, and row-level reversal", () => {
    const ledger = tempLedger();
    try {
      const preview = callTool("create_account", { name: "Preview Expense", type: "expense", dry_run: true }, ledger) as any;
      expect(preview).toMatchObject({ dry_run: true, tool_name: "create_account" });
      expect(preview.diff).toEqual(expect.arrayContaining([expect.objectContaining({ entity_type: "accounts", action: "insert" })]));
      expect(ledger.listAccounts().some((account) => account.name === "Preview Expense")).toBe(false);

      const created = callTool("create_account", { name: "Temporary Expense", type: "expense" }, ledger) as any;
      expect(created.mutation_id).toMatch(/^op_/);
      expect(created.operation_id).toBe(created.mutation_id);
      expect(created.ledger_operation).toBeUndefined();
      const operation = callTool("get_ledger_operation", { operation_id: created.mutation_id }, ledger) as any;
      expect(operation).toMatchObject({ operation_type: "create_account", status: "applied" });
      expect(operation.rows).toEqual(expect.arrayContaining([expect.objectContaining({ entity_type: "accounts", action: "insert" })]));
      expect(ledger.listAccounts().some((account) => account.name === "Temporary Expense")).toBe(true);

      const reversed = callTool("reverse_ledger_operation", { operation_id: created.mutation_id, dry_run: false }, ledger) as any;
      expect(reversed.reversed_rows).toEqual(expect.arrayContaining([expect.objectContaining({ table: "accounts", action: "insert" })]));
      expect(ledger.listAccounts().some((account) => account.name === "Temporary Expense")).toBe(false);
      expect((callTool("get_ledger_operation", { operation_id: created.mutation_id }, ledger) as any).status).toBe("reversed");
    } finally {
      ledger.close();
    }
  });

  it("deactivates referenced inserted accounts instead of deleting them during reversal", () => {
    const ledger = tempLedger();
    try {
      const usd = ledger.createAsset("USD", "currency", 2);
      const checking = ledger.createAccount("Checking", "asset");
      const created = callTool("create_account", { name: "Ephemeral Category", type: "expense", default_asset_id: usd }, ledger) as any;
      callTool("create_transaction", {
        date: "2026-06-20",
        amount: 12,
        from_account_id: checking,
        to_account_id: created.id,
        description: "Uses later-created category",
        status: "posted",
        asset_id: usd
      }, ledger);

      const preview = callTool("reverse_ledger_operation", { operation_id: created.operation_id }, ledger) as any;
      expect(preview.row_reversals).toEqual(expect.arrayContaining([
        expect.objectContaining({
          table: "accounts",
          action: "update",
          entity_id: created.id,
          reason: expect.stringContaining("deactivates")
        })
      ]));

      const reversed = callTool("reverse_ledger_operation", { operation_id: created.operation_id, dry_run: false }, ledger) as any;
      expect(reversed.operation_id).toMatch(/^op_/);
      expect(ledger.tableRows("accounts").find((row) => row.id === created.id)?.status).toBe("inactive");
      expect(ledger.integrityCheck().ok).toBe(true);
      expect((callTool("get_ledger_operation", { operation_id: created.operation_id }, ledger) as any).status).toBe("reversed");
    } finally {
      ledger.close();
    }
  });

  it("does not delete stale inserted account rows that changed after the original operation", () => {
    const ledger = tempLedger();
    try {
      const usd = ledger.createAsset("USD", "currency", 2);
      const created = callTool("create_account", { name: "Mutable Category", type: "expense", default_asset_id: usd }, ledger) as any;
      callTool("update_account", { id: created.id, name: "Mutable Category Updated", code: "6400" }, ledger);

      const preview = callTool("reverse_ledger_operation", { operation_id: created.operation_id }, ledger) as any;
      expect(preview.row_reversals).toEqual(expect.arrayContaining([
        expect.objectContaining({
          table: "accounts",
          action: "update",
          entity_id: created.id,
          reason: expect.stringContaining("changed after operation")
        })
      ]));

      callTool("reverse_ledger_operation", { operation_id: created.operation_id, dry_run: false }, ledger);
      const row = ledger.tableRows("accounts").find((account) => account.id === created.id);
      expect(row).toMatchObject({ name: "Mutable Category Updated", code: "6400", status: "inactive" });
      expect(ledger.integrityCheck().ok).toBe(true);
    } finally {
      ledger.close();
    }
  });

  it("reverses generic posted accounting mutations with correction journals", () => {
    const ledger = tempLedger();
    try {
      const usd = ledger.createAsset("USD", "currency", 2);
      const checking = ledger.createAccount("Checking", "asset");
      const dining = ledger.createAccount("Dining", "expense");

      const created = callTool("create_transaction", {
        date: "2026-06-20",
        amount: 25,
        from_account_id: checking,
        to_account_id: dining,
        description: "Dinner",
        status: "posted",
        asset_id: usd
      }, ledger) as any;
      expect(created.mutation_id).toMatch(/^op_/);
      expect(ledger.balanceTree(checking, usd, null, "posted")).toBe(-2500n);

      const operation = callTool("get_ledger_operation", { operation_id: created.mutation_id }, ledger) as any;
      expect(operation.metadata.accounting_delta).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: "posted", account_id: checking, asset_id: usd, quantity: "-2500" })
      ]));

      const reversePreview = callTool("reverse_ledger_operation", { operation_id: created.mutation_id }, ledger) as any;
      expect(reversePreview).toMatchObject({ dry_run: true, reversal_strategy: "generic_ledger_operation" });
      const reversed = callTool("reverse_ledger_operation", { operation_id: created.mutation_id, dry_run: false, date: "2026-06-21" }, ledger) as any;
      expect(reversed.reverse_journal_ids).toHaveLength(1);
      expect(ledger.getEntries(reversed.reverse_journal_ids[0])).toEqual(expect.arrayContaining([
        expect.objectContaining({ account_id: checking, quantity: 2500n }),
        expect.objectContaining({ account_id: dining, quantity: -2500n })
      ]));
      expect(ledger.balanceTree(checking, usd, null, "posted")).toBe(0n);
    } finally {
      ledger.close();
    }
  });

  it("blocks reversal while newer dependent ledger operations are still active", () => {
    const ledger = tempLedger();
    try {
      const usd = ledger.createAsset("USD", "currency", 2);
      const checking = ledger.createAccount("Checking", "asset");
      const groceries = ledger.createAccount("Groceries", "expense");
      const dining = ledger.createAccount("Dining", "expense");

      const tx = callTool("create_transaction", {
        date: "2026-06-20",
        amount: 25,
        from_account_id: checking,
        to_account_id: groceries,
        description: "Market",
        status: "posted",
        asset_id: usd
      }, ledger) as any;
      const recat = callTool("recategorize_transaction", {
        tx_id: tx.id,
        old_account_id: groceries,
        new_account_id: dining,
        dry_run: false,
        correction_date: "2026-06-21"
      }, ledger) as any;

      expect(() => callTool("reverse_ledger_operation", { operation_id: tx.operation_id, dry_run: false, date: "2026-06-22" }, ledger))
        .toThrow(/active dependent operations/);

      callTool("reverse_ledger_operation", { operation_id: recat.operation_id, dry_run: false, date: "2026-06-22" }, ledger);
      const reversed = callTool("reverse_ledger_operation", { operation_id: tx.operation_id, dry_run: false, date: "2026-06-23" }, ledger) as any;
      expect(reversed.reverse_journal_ids).toHaveLength(1);
      expect(ledger.balanceTree(checking, usd, null, "posted")).toBe(0n);
      expect(ledger.balanceTree(groceries, usd, null, "posted")).toBe(0n);
      expect(ledger.balanceTree(dining, usd, null, "posted")).toBe(0n);
      expect(ledger.integrityCheck().ok).toBe(true);
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

  it("prints useful CLI help for core workflows and the generic tool path", () => {
    const help = (...args: string[]) => execFileSync(process.execPath, ["dist/cli/main.js", ...args, "--help"], { cwd: process.cwd(), encoding: "utf8" });
    expect(help()).toContain("Default ledger:");
    expect(help()).toContain("clovis tool account_balances");
    expect(help("tool")).toContain("Tool args must be a JSON object");
    expect(help("tool")).toContain("dry_run:false");
    expect(help("tool")).not.toContain("--allow-destructive");
    expect(help("account", "balances")).toContain("Current balance is posted plus pending");
    expect(help("import")).toContain("Default status is pending");
    expect(help("report", "balance-sheet")).toContain("Quote asset symbol or id");
    expect(help("txn", "add")).toContain("Transaction status: posted, pending, planned, or void");
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
    const balances = run("account", "balances", "--type", "asset").data;
    expect(balances.find((row: any) => row.account_id === checking && row.asset_symbol === "USD").current_balance_cents).toBe(288000);
  });

  it("exposes the full app catalog through the generic CLI tool path", () => {
    const dir = mkdtempSync(join(tmpdir(), "clovis-cli-tools-"));
    dirs.push(dir);
    const db = join(dir, "ledger.db");
    const run = (...args: string[]) => JSON.parse(execFileSync(process.execPath, ["dist/cli/main.js", "--db", db, "--format", "json", ...args], { cwd: process.cwd(), encoding: "utf8" }));
    const tools = run("tools");
    expect(tools.count).toBe(TOOL_NAMES.length);
    expect(tools.data.find((row: any) => row.name === "account_balances").signature).toBe(TOOL_SIGNATURES.account_balances);

    run("tool", "init_defaults", "--json", JSON.stringify({ template: "personal", currency: "USD" }));
    const accounts = run("tool", "list_accounts").data;
    const checking = accounts.find((row: any) => row.name === "Checking").id;
    const balances = run("tool", "account_balances", "--json", JSON.stringify({ account_type: "asset", hide_zero: false })).data;
    expect(balances.find((row: any) => row.account_id === checking && row.asset_symbol === "USD").current_balance_cents).toBe(0);

    const created = JSON.parse(execFileSync(process.execPath, ["dist/cli/main.js", "--db", db, "--format", "json", "tool", "create_asset", "--stdin"], {
      cwd: process.cwd(),
      encoding: "utf8",
      input: JSON.stringify({ symbol: "CAD", asset_type: "currency", decimals: 2 })
    }));
    expect(created.data.symbol).toBe("CAD");
  });

  it("enforces generic CLI tool JSON shape and capability gates", () => {
    const dir = mkdtempSync(join(tmpdir(), "clovis-cli-tool-gates-"));
    dirs.push(dir);
    const db = join(dir, "ledger.db");
    const base = ["dist/cli/main.js", "--db", db, "--format", "json"];
    const run = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [...base, ...args], { cwd: process.cwd(), encoding: "utf8" }));
    const fail = (args: string[], input?: string) => {
      try {
        execFileSync(process.execPath, [...base, ...args], { cwd: process.cwd(), encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });
        throw new Error("expected CLI command to fail");
      } catch (error: any) {
        const stdout = String(error.stdout ?? "");
        return stdout.trim() ? JSON.parse(stdout) : { ok: false, error: String(error.stderr ?? error.message) };
      }
    };

    run("init", "--currency", "USD");
    expect(fail(["tool", "list_accounts", "--json", "[]"])).toMatchObject({ ok: false, error: expect.stringContaining("Tool args must be a JSON object") });
    expect(fail(["tool", "spending", "--json", JSON.stringify({ year: 2026, month: 13, quote_asset_id: "USD" })])).toMatchObject({ ok: false, error: expect.stringContaining("Too big") });
    expect(fail(["tool", "list_transactions", "--json", JSON.stringify({ limit: 0 })])).toMatchObject({ ok: false, error: expect.stringContaining("Too small") });
    expect(fail(["tool", "void_by_filter", "--json", JSON.stringify({ status: "pending", dry_run: "false" })])).toMatchObject({ ok: false, error: expect.stringContaining("expected boolean") });
    expect(fail(["tool", "account_balances", "--json", JSON.stringify({ as_of: "2026-99-99" })])).toMatchObject({ ok: false, error: expect.stringContaining("valid YYYY-MM-DD") });
    expect(fail(["tool", "import_ledger", "--json", JSON.stringify({ data: "x" })])).toMatchObject({ ok: false, error: expect.stringContaining("not valid JSON") });
    expect(run("tool", "backup_now").data.path).toContain("backups");

    const disposable = run("tool", "create_account", "--json", JSON.stringify({ name: "Disposable", type: "expense" })).data.id;
    const deleteArgs = ["tool", "delete_account", "--json", JSON.stringify({ id: disposable })];
    expect(run(...deleteArgs).data.deleted).toBe(disposable);
  });

  it("roots generic CLI file tools beside --db when CLOVIS_DB is unset", () => {
    const dir = mkdtempSync(join(tmpdir(), "clovis-cli-tool-root-"));
    dirs.push(dir);
    const db = join(dir, "ledger.db");
    writeFileSync(join(dir, "statement.csv"), "date,amount,description\n2026-06-01,1.00,Seed\n", "utf8");
    const env = { ...process.env };
    delete env.CLOVIS_DB;
    const run = (...args: string[]) => JSON.parse(execFileSync(process.execPath, ["dist/cli/main.js", "--db", db, "--format", "json", ...args], { cwd: process.cwd(), encoding: "utf8", env }));
    run("init", "--currency", "USD");
    const accounts = run("account", "list").data;
    const accountId = (name: string) => accounts.find((row: any) => row.name === name).id;
    const preview = run("tool", "preview_import", "--json", JSON.stringify({ file_path: "statement.csv", account_id: accountId("Checking"), counterpart_account_id: accountId("Opening Balances") }));
    expect(preview.data.total_rows).toBe(1);
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

  it("defaults CLI imports to pending for review", () => {
    const dir = mkdtempSync(join(tmpdir(), "clovis-cli-import-"));
    dirs.push(dir);
    const db = join(dir, "ledger.db");
    writeFileSync(join(dir, "statement.csv"), "date,amount,description\n2026-06-01,10.00,Statement row\n", "utf8");
    const run = (...args: string[]) => JSON.parse(execFileSync(process.execPath, ["dist/cli/main.js", "--db", db, "--format", "json", ...args], { cwd: process.cwd(), encoding: "utf8" }));
    run("init", "--currency", "USD");
    const accounts = run("account", "list").data;
    const accountId = (name: string) => accounts.find((row: any) => row.name === name).id;
    const imported = run("import", "--file", "statement.csv", "--account", accountId("Checking"), "--counterpart", accountId("Uncategorized"));
    expect(imported.data.transactions[0].status).toBe("pending");
    expect(run("txn", "list", "--status", "pending").data.transactions.some((tx: any) => tx.description === "Statement row")).toBe(true);
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

  it("catches import uniqueness conflicts during dry-run", () => {
    const ledger = tempLedger();
    try {
      ledger.createAccount("Checking", "asset");
      const doc = {
        format: "clovis-ledger-v1",
        assets: [{ id: "asset_usd", symbol: "USD", type: "currency", scale: 2 }],
        accounts: [{ id: "acct_checking", name: "Checking", type: "asset" }]
      };

      const dryRun = callTool("import_ledger", { data: JSON.stringify(doc), preserve_ids: false, dry_run: true }, ledger) as any;
      expect(dryRun.valid).toBe(false);
      expect(dryRun.errors.join("\n")).toMatch(/name already exists/);
      expect(() => callTool("import_ledger", { data: JSON.stringify(doc), preserve_ids: false }, ledger)).toThrow(/Ledger import validation failed/);
      expect(ledger.listAccounts().filter((account) => account.name === "Checking")).toHaveLength(1);
    } finally {
      ledger.close();
    }
  });

  it("applies MCP file size limits to inline ledger imports", () => {
    const ledger = tempLedger();
    try {
      const previousMax = process.env.CLOVIS_MAX_FILE_BYTES;
      process.env.CLOVIS_MAX_FILE_BYTES = "32";
      try {
        expect(() => callTool("import_ledger", { data: JSON.stringify({ format: "clovis-ledger-v1", assets: [] }) }, ledger)).toThrow(/too large/);
      } finally {
        if (previousMax == null) delete process.env.CLOVIS_MAX_FILE_BYTES; else process.env.CLOVIS_MAX_FILE_BYTES = previousMax;
      }
    } finally {
      ledger.close();
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

    const ageOfMoney = inputShapeFromDefinition(TOOL_DEFINITIONS.age_of_money);
    expect(ageOfMoney.quote_asset_id.parse("USD")).toBe("USD");

    const compareScenarios = inputShapeFromDefinition(TOOL_DEFINITIONS.compare_scenarios);
    expect(compareScenarios.asset_id.safeParse(undefined).success).toBe(false);
    expect(compareScenarios.branch_a).toBeUndefined();

    const createTransaction = inputShapeFromDefinition(TOOL_DEFINITIONS.create_transaction);
    expect(() => createTransaction.date.parse("today")).toThrow();
    expect(() => createTransaction.date.parse("2026-99-99")).toThrow();
    expect(createTransaction.date.parse("2026-06-01")).toBe("2026-06-01");

    const strictListTransactions = inputSchemaFromDefinition(TOOL_DEFINITIONS.list_transactions);
    expect(() => strictListTransactions.parse({ limit: 1, unexpected: "x" })).toThrow();
  });
});
