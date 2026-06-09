import { randomUUID } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { annotateAccount, annotateAmounts, debitCredit, normalAmount, normalSide } from "./accounting.js";
import { DEFAULT_BOOK_ID, DDL, SCHEMA_VERSION } from "./schema.js";
import type { Account, AccountType, Asset, AssetType, Journal, JournalLine, Price, TxStatus } from "./types.js";
import { InvariantError } from "./types.js";
import { decimalToScaled, fromAtomicUnits, gcd, reduceRatio, roundRatio, scaledToNumber, toAtomicUnits } from "./money.js";

type Row = Record<string, unknown>;

type PostTxOptions = {
  sourceId?: string | null;
  externalId?: string | null;
};

type BudgetTargetOptions = {
  accountId?: string | null;
  year?: number | null;
  month?: number | null;
};

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function dateOnly(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("date must be YYYY-MM-DD");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error("date must be YYYY-MM-DD");
  }
  return value;
}

function monthBounds(year: number, month?: number | null): [string, string] {
  if (month == null) return [`${year.toString().padStart(4, "0")}-01-01`, `${year.toString().padStart(4, "0")}-12-31`];
  if (month < 1 || month > 12) throw new Error("month must be 1-12");
  const start = `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-01`;
  const endDate = new Date(Date.UTC(year, month, 0));
  return [start, endDate.toISOString().slice(0, 10)];
}

function accountType(value: string): AccountType {
  if (!["asset", "liability", "equity", "income", "expense"].includes(value)) {
    throw new Error(`Invalid account type: ${value}`);
  }
  return value as AccountType;
}

function txStatus(value: string): TxStatus {
  if (!["posted", "pending", "planned", "void"].includes(value)) {
    throw new Error(`Invalid transaction status: ${value}`);
  }
  return value as TxStatus;
}

function assetType(value: string): AssetType {
  if (!["currency", "commodity", "custom", "security"].includes(value)) {
    throw new Error(`Invalid asset type: ${value}`);
  }
  return value as AssetType;
}

function boolDate(value: unknown): string | null {
  return value == null ? null : String(value);
}

function toAsset(row: Row | undefined): Asset | null {
  if (!row) return null;
  const type = assetType(String(row.type));
  const scale = Number(row.scale);
  return {
    id: String(row.id),
    symbol: String(row.symbol),
    type,
    asset_type: type,
    scale,
    decimals: scale,
    name: String(row.name ?? "")
  };
}

function toAccount(row: Row | undefined): Account | null {
  if (!row) return null;
  return annotateAccount({
    id: String(row.id),
    book_id: String(row.book_id),
    name: String(row.name),
    type: accountType(String(row.type)),
    account_type: accountType(String(row.type)),
    parent_id: boolDate(row.parent_id),
    code: String(row.code ?? ""),
    color_hex: String(row.color_hex ?? "#888888")
  });
}

function toJournal(row: Row | undefined): Journal | null {
  if (!row) return null;
  const date = String(row.date);
  return {
    id: String(row.id),
    book_id: String(row.book_id),
    date,
    time: date,
    posted_at: String(row.posted_at),
    status: txStatus(String(row.status)),
    description: String(row.description ?? ""),
    source_id: boolDate(row.source_id),
    external_id: boolDate(row.external_id)
  };
}

function toLine(row: Row | undefined): JournalLine | null {
  if (!row) return null;
  const quantity = BigInt(row.quantity as bigint | number | string);
  const journalId = String(row.journal_id);
  return {
    id: String(row.id),
    journal_id: journalId,
    tx_id: journalId,
    account_id: String(row.account_id),
    asset_id: String(row.asset_id),
    quantity,
    qty: quantity,
    qty_cents: quantity
  };
}

function toPrice(row: Row | undefined): Price | null {
  if (!row) return null;
  const value = BigInt(row.rate_value as bigint | number | string);
  const scale = Number(row.rate_scale);
  const rate = scaledToNumber(value, scale);
  return {
    id: String(row.id),
    book_id: String(row.book_id),
    asset_id: String(row.asset_id),
    quote_asset_id: String(row.quote_asset_id),
    quote_id: String(row.quote_asset_id),
    rate_value: value,
    rate_scale: scale,
    rate_cents: Number(roundRatio(value * 100n, 10n ** BigInt(scale))),
    rate,
    time: String(row.time)
  };
}

function validateLines(lines: Array<[string, string, bigint]>): void {
  if (lines.length === 0) throw new InvariantError("transaction must have entries");
  const totals = new Map<string, bigint>();
  for (const [, assetId, quantity] of lines) {
    if (quantity < -(2n ** 63n) || quantity > 2n ** 63n - 1n) {
      throw new InvariantError("quantity outside SQLite integer range");
    }
    totals.set(assetId, (totals.get(assetId) ?? 0n) + quantity);
  }
  const imbalanced = [...totals.entries()].filter(([, quantity]) => quantity !== 0n);
  if (imbalanced.length) {
    throw new InvariantError(`entries must balance to zero per asset: ${imbalanced.map(([asset]) => asset).join(", ")}`);
  }
}

export class Ledger {
  readonly path: string;
  private readonly db: DatabaseSync;

  constructor(path: string) {
    let dbPath = path;
    if (path.endsWith(sep)) dbPath = join(path, "clovis.db");
    try {
      if (statSync(dbPath).isDirectory()) dbPath = join(dbPath, "clovis.db");
    } catch {
      // path does not exist yet
    }
    mkdirSync(dirname(dbPath), { recursive: true });
    this.path = dbPath;
    this.db = new DatabaseSync(this.path, { readBigInts: true });
    this.db.exec("PRAGMA foreign_keys = ON");
    this.initialize();
  }

  close(): void {
    this.db.close();
  }

  initialize(): void {
    this.db.exec(DDL);
    this.db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
    this.db.prepare(
      "INSERT OR IGNORE INTO books(id, name, type, parent_id, created_at) VALUES (?, 'Actual', 'actual', NULL, ?)"
    ).run(DEFAULT_BOOK_ID, "1970-01-01T00:00:00Z");
  }

  createAsset(symbol: string, type: AssetType | string = "currency", scale = 2, name = ""): string {
    const normalized = symbol.trim().toUpperCase();
    const existing = this.getAssetBySymbol(normalized);
    if (existing) return existing.id;
    const assetId = id("asset");
    this.db.prepare("INSERT INTO assets(id, symbol, type, scale, name) VALUES (?, ?, ?, ?, ?)").run(
      assetId,
      normalized,
      assetType(String(type)),
      scale,
      name
    );
    return assetId;
  }

  getAsset(assetId: string): Asset | null {
    return toAsset(this.db.prepare("SELECT * FROM assets WHERE id = ?").get(assetId) as Row | undefined);
  }

  getAssetBySymbol(symbol: string): Asset | null {
    return toAsset(this.db.prepare("SELECT * FROM assets WHERE upper(symbol) = upper(?)").get(symbol.trim()) as Row | undefined);
  }

  listAssets(): Asset[] {
    return (this.db.prepare("SELECT * FROM assets ORDER BY symbol, id").all() as Row[]).map((row) => toAsset(row)!);
  }

  updateAsset(assetId: string, values: { symbol?: string | null; name?: string | null }): Asset {
    if (!this.getAsset(assetId)) throw new Error(`Asset ${assetId} not found`);
    if (values.symbol != null) this.db.prepare("UPDATE assets SET symbol = ? WHERE id = ?").run(values.symbol.toUpperCase(), assetId);
    if (values.name != null) this.db.prepare("UPDATE assets SET name = ? WHERE id = ?").run(values.name, assetId);
    return this.getAsset(assetId)!;
  }

  deleteAsset(assetId: string, force = false): void {
    if (!this.getAsset(assetId)) throw new Error(`Asset ${assetId} not found`);
    const count = (this.db.prepare("SELECT count(*) AS c FROM journal_lines WHERE asset_id = ?").get(assetId) as Row).c as bigint;
    if (count > 0n && !force) throw new Error("Asset has entries");
    this.db.prepare("DELETE FROM assets WHERE id = ?").run(assetId);
  }

  createAccount(name: string, type: AccountType | string, parentId?: string | null, code = "", colorHex = "#888888"): string {
    const normalized = accountType(String(type));
    normalSide(normalized);
    if (parentId && !this.getAccount(parentId)) throw new Error(`Parent account ${parentId} not found`);
    const accountId = id("acct");
    this.db.prepare(
      "INSERT INTO accounts(id, book_id, name, type, parent_id, code, color_hex) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(accountId, DEFAULT_BOOK_ID, name, normalized, parentId || null, code, colorHex);
    return accountId;
  }

  findAccount(ref: string): Account | null {
    return this.getAccount(ref) ??
      toAccount(this.db.prepare("SELECT * FROM accounts WHERE lower(name) = lower(?) ORDER BY id LIMIT 1").get(ref) as Row | undefined);
  }

  getAccount(accountId: string): Account | null {
    return toAccount(this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId) as Row | undefined);
  }

  listAccounts(): Account[] {
    return (this.db.prepare("SELECT * FROM accounts ORDER BY name, id").all() as Row[]).map((row) => toAccount(row)!);
  }

  updateAccount(accountId: string, values: {
    name?: string | null;
    type?: AccountType | string | null;
    parent_id?: string | null;
    code?: string | null;
    color_hex?: string | null;
  }): Account {
    if (!this.getAccount(accountId)) throw new Error(`Account ${accountId} not found`);
    if (values.name != null) this.db.prepare("UPDATE accounts SET name = ? WHERE id = ?").run(values.name, accountId);
    if (values.type != null) this.db.prepare("UPDATE accounts SET type = ? WHERE id = ?").run(accountType(String(values.type)), accountId);
    if (values.parent_id !== undefined) {
      if (values.parent_id && !this.getAccount(values.parent_id)) throw new Error(`Parent account ${values.parent_id} not found`);
      this.db.prepare("UPDATE accounts SET parent_id = ? WHERE id = ?").run(values.parent_id || null, accountId);
    }
    if (values.code != null) this.db.prepare("UPDATE accounts SET code = ? WHERE id = ?").run(values.code, accountId);
    if (values.color_hex != null) this.db.prepare("UPDATE accounts SET color_hex = ? WHERE id = ?").run(values.color_hex, accountId);
    return this.getAccount(accountId)!;
  }

  deleteAccount(accountId: string): void {
    if (!this.getAccount(accountId)) throw new Error(`Account ${accountId} not found`);
    const children = (this.db.prepare("SELECT count(*) AS c FROM accounts WHERE parent_id = ?").get(accountId) as Row).c as bigint;
    if (children > 0n) throw new Error("Account has child accounts");
    const entries = (this.db.prepare("SELECT count(*) AS c FROM journal_lines WHERE account_id = ?").get(accountId) as Row).c as bigint;
    if (entries > 0n) throw new Error("Account has entries");
    this.db.prepare("DELETE FROM accounts WHERE id = ?").run(accountId);
  }

  createAnnotation(entityType: string, entityId: string, key: string, value: string): string {
    const annotationId = id("ann");
    this.db.prepare("INSERT INTO annotations(id, entity_type, entity_id, key, value) VALUES (?, ?, ?, ?, ?)").run(
      annotationId,
      entityType,
      entityId,
      key,
      value
    );
    return annotationId;
  }

  listAnnotations(entityType: string, entityId: string): Array<Record<string, string>> {
    return (this.db.prepare(
      "SELECT id, entity_type, entity_id, key, value AS val, value FROM annotations WHERE entity_type = ? AND entity_id = ? ORDER BY key, id"
    ).all(entityType, entityId) as Row[]).map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, String(v)])));
  }

  deleteAnnotation(annotationId: string): void {
    this.db.prepare("DELETE FROM annotations WHERE id = ?").run(annotationId);
  }

  listAnnotationEntityIds(entityType: string, key: string, value: string): string[] {
    return (this.db.prepare("SELECT entity_id FROM annotations WHERE entity_type = ? AND key = ? AND value = ? ORDER BY entity_id").all(entityType, key, value) as Row[])
      .map((row) => String(row.entity_id));
  }

  createSource(type: string, label?: string | null, metadata: Row = {}, status = "open"): string {
    const sourceId = id(type === "import" ? "batch" : "source");
    this.db.prepare("INSERT INTO sources(id, type, label, status, created_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?)").run(
      sourceId,
      type,
      label ?? "",
      status,
      now(),
      JSON.stringify(metadata)
    );
    return sourceId;
  }

  listSources(type?: string | null, limit: number | null = 20): Row[] {
    let sql = "SELECT * FROM sources";
    const params: SQLInputValue[] = [];
    if (type) {
      sql += " WHERE type = ?";
      params.push(type);
    }
    sql += " ORDER BY created_at DESC";
    if (limit != null) {
      sql += " LIMIT ?";
      params.push(limit);
    }
    return this.db.prepare(sql).all(...params) as Row[];
  }

  updateSourceStatus(sourceId: string, status: string): number {
    return Number(this.db.prepare("UPDATE sources SET status = ? WHERE id = ?").run(status, sourceId).changes);
  }

  listTransactionIdsForSource(sourceId: string): string[] {
    const ids = new Set<string>();
    for (const row of this.db.prepare("SELECT id FROM journals WHERE source_id = ? ORDER BY date, id").all(sourceId) as Row[]) {
      ids.add(String(row.id));
    }
    for (const txId of this.listAnnotationEntityIds("tx", "import_batch", sourceId)) ids.add(txId);
    return [...ids].sort();
  }

  tableNames(): string[] {
    return (this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Row[]).map((row) => String(row.name));
  }

  tableColumns(table: string): string[] {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error("Invalid table name");
    return (this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((row) => String(row.name));
  }

  tableRows(table: string): Row[] {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error("Invalid table name");
    return this.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Row[];
  }

  countTransactions(): number {
    return Number((this.db.prepare("SELECT count(*) AS c FROM journals").get() as Row).c);
  }

  countEntries(): number {
    return Number((this.db.prepare("SELECT count(*) AS c FROM journal_lines").get() as Row).c);
  }

  countEntriesByAsset(assetId: string): number {
    return Number((this.db.prepare("SELECT count(*) AS c FROM journal_lines WHERE asset_id = ?").get(assetId) as Row).c);
  }

  countEntriesByAccount(accountId: string): number {
    return Number((this.db.prepare("SELECT count(*) AS c FROM journal_lines WHERE account_id = ?").get(accountId) as Row).c);
  }

  countTransactionsByAccount(accountId: string): number {
    return Number((this.db.prepare("SELECT count(DISTINCT journal_id) AS c FROM journal_lines WHERE account_id = ?").get(accountId) as Row).c);
  }

  listEntriesByAsset(assetId: string, limit = 100, offset = 0): Row[] {
    return this.db.prepare("SELECT * FROM journal_lines WHERE asset_id = ? ORDER BY journal_id, line_no LIMIT ? OFFSET ?").all(assetId, limit, offset) as Row[];
  }

  createRule(type: string, accountId: string, pattern: string): string {
    const existing = this.db.prepare("SELECT id FROM rules WHERE type = ? AND account_id = ? AND pattern = ? AND status = 'active'").get(type, accountId, pattern) as Row | undefined;
    if (existing) return String(existing.id);
    const ruleId = id("rule");
    this.db.prepare("INSERT INTO rules(id, type, account_id, pattern, created_at) VALUES (?, ?, ?, ?, ?)").run(ruleId, type, accountId, pattern, now());
    return ruleId;
  }

  listRules(type = "match"): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT id, account_id, pattern, priority, status FROM rules WHERE type = ? AND status = 'active' ORDER BY priority, id").all(type) as Row[];
  }

  deleteRule(accountId: string, pattern: string, type = "match"): number {
    const result = this.db.prepare("UPDATE rules SET status = 'deleted' WHERE type = ? AND account_id = ? AND pattern = ? AND status = 'active'").run(type, accountId, pattern);
    return Number(result.changes);
  }

  autoCategorize(description: string): string | null {
    const desc = description.toLowerCase();
    for (const rule of this.listRules("match")) {
      if (desc.includes(String(rule.pattern).toLowerCase())) return String(rule.account_id);
    }
    return null;
  }

  listBudgetTargets(options: BudgetTargetOptions = {}): Row[] {
    let sql = "SELECT * FROM targets WHERE type = 'budget'";
    const params: SQLInputValue[] = [];
    if (options.accountId) {
      sql += " AND account_id = ?";
      params.push(options.accountId);
    }
    if (options.year != null) {
      sql += " AND (year IS NULL OR year = ?)";
      params.push(options.year);
    }
    if (options.month != null) {
      sql += " AND (month IS NULL OR month = ?)";
      params.push(options.month);
    }
    sql += " ORDER BY account_id, year, month";
    return this.db.prepare(sql).all(...params) as Row[];
  }

  setBudget(accountId: string, assetId: string, quantity: bigint | number, period = "monthly", year?: number | null, month?: number | null, rollover = false): Row {
    if (!this.getAccount(accountId)) throw new Error(`Account ${accountId} not found`);
    if (!this.getAsset(assetId)) throw new Error(`Asset ${assetId} not found`);
    const amount = BigInt(quantity);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM targets WHERE type = 'budget' AND account_id = ? AND asset_id = ? AND period = ? AND year IS ? AND month IS ?").run(accountId, assetId, period, year ?? null, month ?? null);
      const targetId = id("budget");
      this.db.prepare("INSERT INTO targets(id, type, account_id, asset_id, quantity, period, year, month, rollover_rule) VALUES (?, 'budget', ?, ?, ?, ?, ?, ?, ?)").run(
        targetId,
        accountId,
        assetId,
        amount,
        period,
        year ?? null,
        month ?? null,
        rollover ? "full" : ""
      );
      this.db.exec("COMMIT");
      return this.db.prepare("SELECT * FROM targets WHERE id = ?").get(targetId) as Row;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  deleteBudget(accountId: string, year?: number | null, month?: number | null): number {
    let sql = "DELETE FROM targets WHERE type = 'budget' AND account_id = ?";
    const params: SQLInputValue[] = [accountId];
    if (year != null) {
      sql += " AND year = ?";
      params.push(year);
    }
    if (month != null) {
      sql += " AND month = ?";
      params.push(month);
    }
    return Number(this.db.prepare(sql).run(...params).changes);
  }

  deleteAllBudgets(): number {
    return Number(this.db.prepare("DELETE FROM targets WHERE type = 'budget'").run().changes);
  }

  setGoal(accountId: string, assetId: string, quantity: bigint | number, name: string, targetDate?: string | null, priority = 1): Row {
    if (!this.getAccount(accountId)) throw new Error(`Account ${accountId} not found`);
    if (!this.getAsset(assetId)) throw new Error(`Asset ${assetId} not found`);
    const amount = BigInt(quantity);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM targets WHERE type = 'goal' AND account_id = ? AND asset_id = ?").run(accountId, assetId);
      const targetId = id("goal");
      this.db.prepare("INSERT INTO targets(id, type, account_id, asset_id, quantity, name, target_date, priority) VALUES (?, 'goal', ?, ?, ?, ?, ?, ?)").run(
        targetId,
        accountId,
        assetId,
        amount,
        name,
        targetDate ?? null,
        priority
      );
      this.db.exec("COMMIT");
      return this.db.prepare("SELECT * FROM targets WHERE id = ?").get(targetId) as Row;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listGoalTargets(): Row[] {
    return this.db.prepare("SELECT * FROM targets WHERE type = 'goal' ORDER BY priority, name").all() as Row[];
  }

  getGoalTarget(accountId: string): Row | null {
    return (this.db.prepare("SELECT * FROM targets WHERE type = 'goal' AND account_id = ? ORDER BY priority, name LIMIT 1").get(accountId) as Row | undefined) ?? null;
  }

  deleteGoal(accountId: string): number {
    return Number(this.db.prepare("DELETE FROM targets WHERE type = 'goal' AND account_id = ?").run(accountId).changes);
  }

  createRecurrence(date: string, quantity: bigint | number, fromAccountId: string, toAccountId: string, description: string, frequency: string, endDate: string | null, assetId: string): Row {
    if (!this.getAccount(fromAccountId) || !this.getAccount(toAccountId)) throw new Error("Account not found");
    if (!this.getAsset(assetId)) throw new Error(`Asset ${assetId} not found`);
    const recurrenceId = id("sched");
    this.db.prepare("INSERT INTO recurrences(id, next_date, quantity, from_account_id, to_account_id, description, frequency, end_date, asset_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      recurrenceId,
      dateOnly(date),
      BigInt(quantity),
      fromAccountId,
      toAccountId,
      description,
      frequency,
      endDate ?? null,
      assetId
    );
    return this.db.prepare("SELECT *, quantity AS amount_cents FROM recurrences WHERE id = ?").get(recurrenceId) as Row;
  }

  listRecurrences(): Row[] {
    return this.db.prepare("SELECT *, quantity AS amount_cents FROM recurrences ORDER BY next_date, id").all() as Row[];
  }

  updateRecurrenceNextDate(recurrenceId: string, nextDate: string): number {
    return Number(this.db.prepare("UPDATE recurrences SET next_date = ? WHERE id = ?").run(dateOnly(nextDate), recurrenceId).changes);
  }

  createScenarioBook(name: string): Row {
    this.db.prepare("INSERT OR IGNORE INTO books(id, name, type, parent_id, created_at) VALUES (?, ?, 'scenario', ?, ?)").run(name, name, DEFAULT_BOOK_ID, now());
    return this.db.prepare("SELECT name, created_at, closed_at FROM books WHERE id = ?").get(name) as Row;
  }

  listScenarioBooks(): Row[] {
    return this.db.prepare("SELECT name, created_at, closed_at FROM books WHERE type = 'scenario' ORDER BY name").all() as Row[];
  }

  discardScenarioBook(name: string): number {
    this.createScenarioBook(name);
    return Number(this.db.prepare("UPDATE books SET closed_at = ? WHERE id = ?").run(now(), name).changes);
  }

  listLots(): Row[] {
    return this.db.prepare("SELECT * FROM lots ORDER BY opened_at, id").all() as Row[];
  }

  createPrice(assetId: string, quoteId: string, rate: number | string | bigint, time: string, rateScale?: number): string {
    if (!this.getAsset(assetId) || !this.getAsset(quoteId)) throw new Error("Asset not found");
    const scaled = rateScale == null ? decimalToScaled(rate) : { value: BigInt(rate), scale: rateScale };
    const priceId = id("price");
    this.db.prepare(
      "INSERT INTO prices(id, book_id, asset_id, quote_asset_id, rate_value, rate_scale, time) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(priceId, DEFAULT_BOOK_ID, assetId, quoteId, scaled.value, scaled.scale, time);
    return priceId;
  }

  listPrices(): Price[] {
    return (this.db.prepare("SELECT * FROM prices ORDER BY time DESC, id DESC").all() as Row[]).map((row) => toPrice(row)!);
  }

  queryPrice(assetId: string, quoteId: string, asOf: string): Price | null {
    return toPrice(this.db.prepare(
      "SELECT * FROM prices WHERE asset_id = ? AND quote_asset_id = ? AND time <= ? ORDER BY time DESC, id DESC LIMIT 1"
    ).get(assetId, quoteId, asOf) as Row | undefined);
  }

  private priceGraph(asOf: string): Map<string, Array<{ to: string; numerator: bigint; denominator: bigint }>> {
    const assets = new Map(this.listAssets().map((asset) => [asset.id, asset]));
    const graph = new Map<string, Array<{ to: string; numerator: bigint; denominator: bigint }>>();
    const seen = new Set<string>();
    const rows = this.db.prepare("SELECT * FROM prices WHERE time <= ? ORDER BY time DESC, id DESC").all(asOf) as Row[];
    for (const raw of rows) {
      const price = toPrice(raw)!;
      const key = `${price.asset_id}:${price.quote_asset_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const source = assets.get(price.asset_id);
      const quote = assets.get(price.quote_asset_id);
      if (!source || !quote || price.rate_value === 0n) continue;
      const forward = reduceRatio(
        price.rate_value * 10n ** BigInt(quote.scale),
        10n ** BigInt(source.scale + price.rate_scale)
      );
      const inverse = reduceRatio(forward.denominator, forward.numerator);
      graph.set(price.asset_id, [...(graph.get(price.asset_id) ?? []), { to: price.quote_asset_id, ...forward }]);
      graph.set(price.quote_asset_id, [...(graph.get(price.quote_asset_id) ?? []), { to: price.asset_id, ...inverse }]);
    }
    return graph;
  }

  convertQuantity(quantity: bigint, assetId: string, quoteAssetId: string, asOf = "9999-12-31"): bigint {
    if (assetId === quoteAssetId) return quantity;
    if (!this.getAsset(assetId) || !this.getAsset(quoteAssetId)) throw new Error("Asset not found");
    const graph = this.priceGraph(asOf);
    const queue: Array<{ assetId: string; numerator: bigint; denominator: bigint }> = [{ assetId, numerator: quantity, denominator: 1n }];
    const visited = new Set([assetId]);
    while (queue.length) {
      const current = queue.shift()!;
      for (const edge of graph.get(current.assetId) ?? []) {
        if (visited.has(edge.to)) continue;
        const next = reduceRatio(current.numerator * edge.numerator, current.denominator * edge.denominator);
        if (edge.to === quoteAssetId) return roundRatio(next.numerator, next.denominator);
        visited.add(edge.to);
        queue.push({ assetId: edge.to, ...next });
      }
    }
    throw new Error(`No price path from ${assetId} to ${quoteAssetId} as of ${asOf}`);
  }

  tryConvertQuantity(quantity: bigint, assetId: string, quoteAssetId: string, asOf = "9999-12-31"): [bigint | null, string | null] {
    try {
      return [this.convertQuantity(quantity, assetId, quoteAssetId, asOf), null];
    } catch (error) {
      return [null, error instanceof Error ? error.message : String(error)];
    }
  }

  private assertPeriodOpen(txDate: string): void {
    const row = this.db.prepare(
      "SELECT id, name, as_of FROM period_closes WHERE book_id = ? AND reopened_at IS NULL AND as_of >= ? ORDER BY as_of DESC, created_at DESC LIMIT 1"
    ).get(DEFAULT_BOOK_ID, txDate) as Row | undefined;
    if (row) throw new Error(`Period '${String(row.name)}' is closed through ${String(row.as_of)}; transaction date ${txDate} cannot be modified`);
  }

  private validateLineRefs(lines: Array<[string, string, bigint]>): void {
    for (const [accountId, assetId] of lines) {
      if (!this.getAccount(accountId)) throw new Error(`Account ${accountId} not found`);
      if (!this.getAsset(assetId)) throw new Error(`Asset ${assetId} not found`);
    }
  }

  private insertTx(txDate: string, statusValue: TxStatus, description: string | null | undefined, lines: Array<[string, string, bigint]>, options: PostTxOptions = {}): string {
    const txId = id("tx");
    this.db.prepare("INSERT INTO journals(id, book_id, source_id, date, posted_at, status, description, external_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      txId,
      DEFAULT_BOOK_ID,
      options.sourceId ?? null,
      txDate,
      now(),
      statusValue,
      description ?? "",
      options.externalId ?? null
    );
    lines.forEach(([accountId, assetId, quantity], index) => {
      this.db.prepare("INSERT INTO journal_lines(id, journal_id, line_no, account_id, asset_id, quantity) VALUES (?, ?, ?, ?, ?, ?)").run(
        id("line"),
        txId,
        index + 1,
        accountId,
        assetId,
        quantity
      );
    });
    return txId;
  }

  postTx(date: string, status: TxStatus | string, description: string | null | undefined, lines: Array<[string, string, bigint | number]>, options: PostTxOptions = {}): string {
    const txDate = dateOnly(date);
    this.assertPeriodOpen(txDate);
    const statusValue = txStatus(String(status));
    const normalized = lines.map(([accountId, assetId, quantity]) => [accountId, assetId, BigInt(quantity)] as [string, string, bigint]);
    validateLines(normalized);
    this.validateLineRefs(normalized);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const txId = this.insertTx(txDate, statusValue, description, normalized, options);
      this.db.exec("COMMIT");
      return txId;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordTransaction(date: string, amount: bigint | number, fromAccountId: string, toAccountId: string, assetId: string, description = "", status: TxStatus | string = "pending", options: PostTxOptions = {}): Journal & { entries: JournalLine[] } {
    const quantity = BigInt(amount);
    const absolute = quantity < 0n ? -quantity : quantity;
    const txId = this.postTx(date, status, description, [
      [fromAccountId, assetId, -absolute],
      [toAccountId, assetId, absolute]
    ], options);
    return this.txWithEntries(txId);
  }

  recordJournalEntry(date: string, legs: Array<[string, bigint | number]>, description: string, assetId: string, status: TxStatus | string = "pending", options: PostTxOptions = {}): Journal & { entries: JournalLine[] } {
    const txId = this.postTx(date, status, description, legs.map(([accountId, quantity]) => [accountId, assetId, BigInt(quantity)]), options);
    return this.txWithEntries(txId);
  }

  recordMultiAssetJournalEntry(date: string, legs: Array<[string, string, bigint | number]>, description: string, status: TxStatus | string = "pending", options: PostTxOptions = {}): Journal & { entries: JournalLine[] } {
    const txId = this.postTx(date, status, description, legs.map(([accountId, assetId, quantity]) => [accountId, assetId, BigInt(quantity)]), options);
    return this.txWithEntries(txId);
  }

  recordOpeningBalance(accountId: string, balance: bigint | number, assetId: string, date: string, status: TxStatus | string = "pending", counterpartAccountId?: string | null) {
    const counterpart = counterpartAccountId || this.getOrCreateAccount("Opening Balances", "equity");
    const txId = this.postTx(date, status, "Opening balance", [
      [accountId, assetId, BigInt(balance)],
      [counterpart, assetId, -BigInt(balance)]
    ]);
    return this.txWithEntries(txId);
  }

  voidTx(txId: string): void {
    const tx = this.getTx(txId);
    if (!tx) throw new Error(`Transaction ${txId} not found`);
    this.assertPeriodOpen(tx.date);
    this.db.prepare("UPDATE journals SET status = 'void' WHERE id = ?").run(txId);
  }

  updateTxStatus(txId: string, status: TxStatus | string): boolean {
    const tx = this.getTx(txId);
    if (!tx) throw new Error(`Transaction ${txId} not found`);
    this.assertPeriodOpen(tx.date);
    const result = this.db.prepare("UPDATE journals SET status = ? WHERE id = ?").run(txStatus(String(status)), txId);
    return Number(result.changes) > 0;
  }

  deleteTx(txId: string): void {
    const tx = this.getTx(txId);
    if (!tx) throw new Error(`Transaction ${txId} not found`);
    this.assertPeriodOpen(tx.date);
    this.db.prepare("DELETE FROM journals WHERE id = ?").run(txId);
  }

  getTx(txId: string): Journal | null {
    return toJournal(this.db.prepare("SELECT * FROM journals WHERE id = ?").get(txId) as Row | undefined);
  }

  listTransactions(options: { status?: TxStatus | string | null; dateFrom?: string | null; dateTo?: string | null; sort?: "date_asc" | "date_desc" } = {}): Journal[] {
    let sql = "SELECT * FROM journals WHERE 1 = 1";
    const params: SQLInputValue[] = [];
    if (options.status != null) {
      sql += " AND status = ?";
      params.push(txStatus(String(options.status)));
    }
    if (options.dateFrom) {
      sql += " AND date >= ?";
      params.push(options.dateFrom);
    }
    if (options.dateTo) {
      sql += " AND date <= ?";
      params.push(options.dateTo);
    }
    sql += options.sort === "date_desc" ? " ORDER BY date DESC, id DESC" : " ORDER BY date, id";
    return (this.db.prepare(sql).all(...params) as Row[]).map((row) => toJournal(row)!);
  }

  getEntries(txId: string): JournalLine[] {
    return (this.db.prepare("SELECT * FROM journal_lines WHERE journal_id = ? ORDER BY line_no, id").all(txId) as Row[]).map((row) => toLine(row)!);
  }

  txWithEntries(txId: string): Journal & { entries: JournalLine[] } {
    const tx = this.getTx(txId);
    if (!tx) throw new Error(`Transaction ${txId} not found`);
    return { ...tx, entries: this.getEntries(txId) };
  }

  recategorizeTransaction(txId: string, oldAccountId: string, newAccountId: string): Record<string, string> {
    const tx = this.getTx(txId);
    if (!tx) throw new Error(`Transaction ${txId} not found`);
    this.assertPeriodOpen(tx.date);
    if (!this.getAccount(newAccountId)) throw new Error(`Account ${newAccountId} not found`);
    const result = this.db.prepare("UPDATE journal_lines SET account_id = ? WHERE journal_id = ? AND account_id = ?").run(newAccountId, txId, oldAccountId);
    if (Number(result.changes) === 0) throw new Error(`Account ${oldAccountId} is not on transaction ${txId}`);
    return { tx_id: txId, from_account_id: oldAccountId, to_account_id: newAccountId };
  }

  flipEntries(txIds: string[]): string[] {
    const flipped: string[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const txId of txIds) {
        const tx = this.getTx(txId);
        if (!tx) throw new Error(`Transaction ${txId} not found`);
        this.assertPeriodOpen(tx.date);
        if (tx.status === "void") continue;
        this.db.prepare("UPDATE journal_lines SET quantity = -quantity WHERE journal_id = ?").run(txId);
        flipped.push(txId);
      }
      this.db.exec("COMMIT");
      return flipped;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  moveEntriesBetweenAccounts(sourceAccountId: string, targetAccountId: string): number {
    if (!this.getAccount(sourceAccountId) || !this.getAccount(targetAccountId)) throw new Error("Account not found");
    const rows = this.db.prepare(
      "SELECT DISTINCT t.id, t.date FROM journals t JOIN journal_lines l ON l.journal_id = t.id WHERE l.account_id = ?"
    ).all(sourceAccountId) as Row[];
    rows.forEach((row) => this.assertPeriodOpen(String(row.date)));
    const count = (this.db.prepare("SELECT count(*) AS c FROM journal_lines WHERE account_id = ?").get(sourceAccountId) as Row).c as bigint;
    this.db.prepare("UPDATE journal_lines SET account_id = ? WHERE account_id = ?").run(targetAccountId, sourceAccountId);
    return Number(count);
  }

  migrateAssetEntries(fromAssetId: string, toAssetId: string): number {
    if (!this.getAsset(fromAssetId) || !this.getAsset(toAssetId)) throw new Error("Asset not found");
    const rows = this.db.prepare(
      "SELECT DISTINCT t.id, t.date FROM journals t JOIN journal_lines l ON l.journal_id = t.id WHERE l.asset_id = ?"
    ).all(fromAssetId) as Row[];
    rows.forEach((row) => this.assertPeriodOpen(String(row.date)));
    const count = (this.db.prepare("SELECT count(*) AS c FROM journal_lines WHERE asset_id = ?").get(fromAssetId) as Row).c as bigint;
    this.db.prepare("UPDATE journal_lines SET asset_id = ? WHERE asset_id = ?").run(toAssetId, fromAssetId);
    return Number(count);
  }

  closePeriod(name: string, asOf: string, description?: string | null): Record<string, unknown> {
    const periodId = id("period");
    const date = dateOnly(asOf);
    this.db.prepare("INSERT INTO period_closes(id, book_id, name, as_of, description, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      periodId,
      DEFAULT_BOOK_ID,
      name,
      date,
      description ?? null,
      now()
    );
    return { id: periodId, name, as_of: date, description: description ?? null };
  }

  listCheckpoints(): Row[] {
    return this.db.prepare("SELECT * FROM period_closes ORDER BY as_of, id").all() as Row[];
  }

  reopenPeriod(periodId: string): Record<string, string> {
    const result = this.db.prepare("UPDATE period_closes SET reopened_at = ? WHERE id = ?").run(now(), periodId);
    if (Number(result.changes) === 0) throw new Error(`Checkpoint ${periodId} not found`);
    return { reopened: periodId };
  }

  private statusClause(status: TxStatus | string | null | undefined): { sql: string; params: unknown[] } {
    if (status == null) return { sql: "AND t.status != 'void'", params: [] };
    return { sql: "AND t.status = ?", params: [txStatus(String(status))] };
  }

  balance(accountId: string, assetId: string, asOf?: string | null, status: TxStatus | string | null = "posted", dateFrom?: string | null): bigint {
    const clause = this.statusClause(status);
    let sql = `SELECT coalesce(sum(l.quantity), 0) AS total
      FROM journal_lines l JOIN journals t ON t.id = l.journal_id
      WHERE l.account_id = ? AND l.asset_id = ? ${clause.sql}`;
    const params: SQLInputValue[] = [accountId, assetId, ...clause.params as SQLInputValue[]];
    if (asOf) {
      sql += " AND t.date <= ?";
      params.push(asOf);
    }
    if (dateFrom) {
      sql += " AND t.date > ?";
      params.push(dateFrom);
    }
    return BigInt((this.db.prepare(sql).get(...params) as Row).total as bigint | number);
  }

  descendants(accountId: string): Set<string> {
    const out = new Set([accountId]);
    const queue = [accountId];
    while (queue.length) {
      const current = queue.pop()!;
      const rows = this.db.prepare("SELECT id FROM accounts WHERE parent_id = ?").all(current) as Row[];
      for (const row of rows) {
        const child = String(row.id);
        if (!out.has(child)) {
          out.add(child);
          queue.push(child);
        }
      }
    }
    return out;
  }

  balanceTree(accountId: string, assetId: string, asOf?: string | null, status: TxStatus | string | null = "posted", dateFrom?: string | null): bigint {
    let total = 0n;
    for (const id of this.descendants(accountId)) total += this.balance(id, assetId, asOf, status, dateFrom);
    return total;
  }

  accountingBalance(accountId: string, assetId: string, asOf?: string | null, status: TxStatus | string | null = "posted") {
    const account = this.getAccount(accountId);
    if (!account) throw new Error(`Account ${accountId} not found`);
    const asset = this.getAsset(assetId);
    const scale = asset?.scale ?? 2;
    const raw = this.balanceTree(accountId, assetId, asOf, status);
    const amounts = annotateAmounts(account.account_type, raw);
    return {
      account_id: accountId,
      account_name: account.name,
      account_type: account.account_type,
      asset_id: assetId,
      asset_symbol: asset?.symbol ?? "",
      scale,
      quantity: raw,
      balance: raw,
      balance_cents: raw,
      balance_display: Number(fromAtomicUnits(raw, scale)),
      ...amounts,
      debit_cents: amounts.debit,
      credit_cents: amounts.credit,
      normal_balance_display: Number(fromAtomicUnits(amounts.normal_balance_cents, scale))
    };
  }

  quotedBalanceTree(accountId: string, quoteAssetId: string, asOf?: string | null, status: TxStatus | string | null = "posted", dateFrom?: string | null) {
    const date = asOf || "9999-12-31";
    let total = 0n;
    const missing: Row[] = [];
    for (const asset of this.listAssets()) {
      const raw = this.balanceTree(accountId, asset.id, asOf, status, dateFrom);
      if (raw === 0n) continue;
      const [converted, error] = this.tryConvertQuantity(raw, asset.id, quoteAssetId, date);
      if (converted == null) missing.push({ account_id: accountId, asset_id: asset.id, quote_asset_id: quoteAssetId, quantity: raw, error });
      else total += converted;
    }
    return { total, missing };
  }

  incomeExpenseRows(year: number, month: number | null, quoteAssetId: string, status: TxStatus | string | null = "posted") {
    const [dateFrom, dateTo] = monthBounds(year, month);
    const accounts = new Map(this.listAccounts().map((a) => [a.id, a]));
    const quote = this.getAsset(quoteAssetId);
    const scale = quote?.scale ?? 2;
    const income = new Map<string, Row>();
    const expense = new Map<string, Row>();
    const missing: Row[] = [];
    for (const tx of this.listTransactions({ status, dateFrom, dateTo })) {
      for (const entry of this.getEntries(tx.id)) {
        const [converted, error] = this.tryConvertQuantity(entry.quantity, entry.asset_id, quoteAssetId, tx.date);
        if (converted == null) {
          missing.push({ tx_id: tx.id, account_id: entry.account_id, asset_id: entry.asset_id, quote_asset_id: quoteAssetId, quantity: entry.quantity, error });
          continue;
        }
        const account = accounts.get(entry.account_id);
        if (!account) continue;
        if (account.account_type === "income" || account.account_type === "expense") {
          const target = account.account_type === "income" ? income : expense;
          const current = target.get(account.id) ?? {
            account_id: account.id,
            account_name: account.name,
            account_type: account.account_type,
            normal_balance: account.normal_balance,
            amount: 0n
          };
          current.amount = BigInt(current.amount as bigint) + normalAmount(account.account_type, converted);
          target.set(account.id, current);
        }
      }
    }
    const normalize = (rows: Row[]): Row[] => rows.map((row) => ({
      ...row,
      amount: row.amount,
      amount_cents: row.amount,
      quantity: row.amount,
      scale,
      asset_id: quoteAssetId,
      amount_display: Number(fromAtomicUnits(row.amount as bigint, scale))
    }));
    const incomeRows = normalize([...income.values()].sort((a, b) => String(a.account_name).localeCompare(String(b.account_name))));
    const expenseRows = normalize([...expense.values()].sort((a, b) => Number((b.amount as bigint) - (a.amount as bigint))));
    const incomeTotal = incomeRows.reduce((sum, row) => sum + BigInt(row.amount as bigint), 0n);
    const expenseTotal = expenseRows.reduce((sum, row) => sum + BigInt(row.amount as bigint), 0n);
    return {
      year,
      month,
      income: incomeTotal,
      expense: expenseTotal,
      net: incomeTotal - expenseTotal,
      income_by_account: incomeRows,
      expense_by_account: expenseRows,
      quote_asset_id: quoteAssetId,
      scale,
      valuation_complete: missing.length === 0,
      missing_conversions: missing
    };
  }

  incomeStatement(year: number, month: number | null, quoteAssetId: string) {
    const result = this.incomeExpenseRows(year, month, quoteAssetId);
    if (month == null) {
      return { ...result, months: Array.from({ length: 12 }, (_, index) => this.incomeExpenseRows(year, index + 1, quoteAssetId)) };
    }
    return result;
  }

  spending(year: number, month: number, quoteAssetId: string) {
    return this.incomeExpenseRows(year, month, quoteAssetId).expense_by_account;
  }

  balanceSheet(asOf: string | null, quoteAssetId: string) {
    const date = asOf || "9999-12-31";
    const accounts = this.listAccounts();
    const children = new Map<string | null, Account[]>();
    for (const account of accounts) {
      const key = account.parent_id ?? null;
      children.set(key, [...(children.get(key) ?? []), account]);
    }
    const quote = this.getAsset(quoteAssetId);
    const scale = quote?.scale ?? 2;
    const missing: Row[] = [];
    const build = (account: Account): Row => {
      const balance = this.quotedBalanceTree(account.id, quoteAssetId, date);
      missing.push(...balance.missing);
      const amounts = annotateAmounts(account.account_type, balance.total);
      return {
        id: account.id,
        name: account.name,
        account_type: account.account_type,
        type: account.account_type,
        statement: account.statement,
        quantity: balance.total,
        scale,
        asset_id: quoteAssetId,
        balance: balance.total,
        ...amounts,
        balance_cents: balance.total,
        balance_display: Number(fromAtomicUnits(balance.total, scale)),
        normal_balance_display: Number(fromAtomicUnits(amounts.normal_balance_cents, scale)),
        children: (children.get(account.id) ?? []).map(build)
      };
    };
    const sections: Record<string, Row[]> = { asset: [], liability: [], equity: [] };
    let currentIncome = 0n;
    let currentExpense = 0n;
    for (const account of children.get(null) ?? []) {
      if (account.account_type in sections) sections[account.account_type].push(build(account));
      else if (account.account_type === "income" || account.account_type === "expense") {
        const balance = this.quotedBalanceTree(account.id, quoteAssetId, date);
        missing.push(...balance.missing);
        if (account.account_type === "income") currentIncome += normalAmount(account.account_type, balance.total);
        else currentExpense += normalAmount(account.account_type, balance.total);
      }
    }
    const total = (rows: Row[]) => rows.reduce((sum, row) => sum + BigInt(row.balance as bigint), 0n);
    const normalTotal = (rows: Row[]) => rows.reduce((sum, row) => sum + BigInt(row.normal_balance_cents as bigint), 0n);
    const totals = { asset: total(sections.asset), liability: total(sections.liability), equity: total(sections.equity) };
    const normalTotals = { asset: normalTotal(sections.asset), liability: normalTotal(sections.liability), equity: normalTotal(sections.equity) };
    const currentEarnings = currentIncome - currentExpense;
    return {
      as_of: date,
      assets: sections.asset,
      liabilities: sections.liability,
      equity: sections.equity,
      total_assets: totals.asset,
      total_liabilities: totals.liability,
      total_equity: totals.equity,
      accounting_total_assets: normalTotals.asset,
      accounting_total_liabilities: normalTotals.liability,
      accounting_total_equity: normalTotals.equity,
      accounting_current_income: currentIncome,
      accounting_current_expense: currentExpense,
      accounting_current_earnings: currentEarnings,
      accounting_equation_balanced: normalTotals.asset === normalTotals.liability + normalTotals.equity + currentEarnings,
      quote_asset_id: quoteAssetId,
      scale,
      valuation_complete: missing.length === 0,
      missing_conversions: missing
    };
  }

  netWorthReport(asOf: string, quoteAssetId: string) {
    const sheet = this.balanceSheet(asOf, quoteAssetId);
    const net = BigInt(sheet.total_assets as bigint) + BigInt(sheet.total_liabilities as bigint);
    return {
      as_of: asOf,
      total_assets: sheet.total_assets,
      total_liabilities: sheet.total_liabilities,
      net_worth: net,
      total_assets_cents: sheet.total_assets,
      total_liabilities_cents: sheet.total_liabilities,
      net_worth_cents: net,
      quote_asset_id: quoteAssetId,
      scale: sheet.scale,
      valuation_complete: sheet.valuation_complete,
      missing_conversions: sheet.missing_conversions
    };
  }

  cashFlow(year: number, month: number, quoteAssetId: string) {
    const summary = this.incomeExpenseRows(year, month, quoteAssetId);
    const [dateFrom, dateTo] = monthBounds(year, month);
    const accounts = new Map(this.listAccounts().map((a) => [a.id, a]));
    let netChange = 0n;
    for (const tx of this.listTransactions({ status: "posted", dateFrom, dateTo })) {
      for (const entry of this.getEntries(tx.id)) {
        const account = accounts.get(entry.account_id);
        if (account?.account_type === "asset") {
          const [converted] = this.tryConvertQuantity(entry.quantity, entry.asset_id, quoteAssetId, tx.date);
          if (converted != null) netChange += converted;
        }
      }
    }
    return {
      year,
      month,
      operating: [...summary.income_by_account, ...summary.expense_by_account.map((row: Row) => ({ ...row, amount: -BigInt(row.amount as bigint), amount_cents: -BigInt(row.amount as bigint) }))],
      investing: [],
      financing: [],
      operating_total: BigInt(summary.income) - BigInt(summary.expense),
      investing_total: 0n,
      financing_total: 0n,
      net_change: netChange,
      quote_asset_id: quoteAssetId,
      valuation_complete: summary.valuation_complete,
      missing_conversions: summary.missing_conversions
    };
  }

  accountRegister(accountId: string, assetId: string, dateFrom?: string | null, dateTo?: string | null, status: TxStatus | string | null = "posted") {
    const account = this.getAccount(accountId);
    if (!account) throw new Error(`Account ${accountId} not found`);
    let running = 0n;
    const rows: Row[] = [];
    for (const tx of this.listTransactions({ status, dateFrom, dateTo })) {
      for (const entry of this.getEntries(tx.id).filter((line) => line.account_id === accountId && line.asset_id === assetId)) {
        running += entry.quantity;
        const parts = debitCredit(entry.quantity);
        rows.push({
          tx_id: tx.id,
          date: tx.date,
          description: tx.description,
          debit: parts.debit,
          credit: parts.credit,
          amount: entry.quantity,
          normal_amount: normalAmount(account.account_type, entry.quantity),
          running_balance: running,
          normal_running_balance: normalAmount(account.account_type, running),
          normal_balance: account.normal_balance
        });
      }
    }
    return rows;
  }

  searchTransactions(options: {
    desc?: string | null;
    amountMin?: bigint | null;
    amountMax?: bigint | null;
    accountId?: string | null;
    status?: TxStatus | string | null;
    dateFrom?: string | null;
    dateTo?: string | null;
    assetId?: string | null;
    sort?: string;
    limit?: number | null;
    offset?: number;
  }) {
    let rows: Array<Journal & { entries: JournalLine[] }> = [];
    for (const tx of this.listTransactions({ status: options.status, dateFrom: options.dateFrom, dateTo: options.dateTo })) {
      if (options.desc && !tx.description.toLowerCase().includes(options.desc.toLowerCase())) continue;
      const entries = this.getEntries(tx.id);
      if (options.accountId && !entries.some((entry) => entry.account_id === options.accountId)) continue;
      const filtered = entries.filter((entry) => !options.assetId || entry.asset_id === options.assetId);
      const magnitudes = filtered.map((entry) => entry.quantity < 0n ? -entry.quantity : entry.quantity);
      if (options.amountMin != null && (magnitudes.length === 0 || magnitudes.every((amount) => amount < options.amountMin!))) continue;
      if (options.amountMax != null && (magnitudes.length === 0 || magnitudes.every((amount) => amount > options.amountMax!))) continue;
      rows.push({ ...tx, entries });
    }
    const reverse = ["date_desc", "recent", "latest"].includes(options.sort ?? "");
    rows = rows.sort((a, b) => `${a.date}:${a.id}`.localeCompare(`${b.date}:${b.id}`) * (reverse ? -1 : 1));
    const offset = options.offset ?? 0;
    return rows.slice(offset, options.limit == null ? undefined : offset + options.limit);
  }

  trialBalance(assetId: string, status: TxStatus | string | null = null) {
    const rows = this.listAccounts().map((account) => {
      const balance = this.balance(account.id, assetId, null, status);
      const parts = debitCredit(balance);
      return {
        ...account,
        balance,
        balance_cents: balance,
        normal_balance_cents: normalAmount(account.account_type, balance),
        debit: parts.debit,
        credit: parts.credit
      };
    });
    return {
      accounts: rows,
      total: rows.reduce((sum, row) => sum + row.balance, 0n),
      debit_total: rows.reduce((sum, row) => sum + row.debit, 0n),
      credit_total: rows.reduce((sum, row) => sum + row.credit, 0n),
      balanced: rows.reduce((sum, row) => sum + row.balance, 0n) === 0n
    };
  }

  initDefaults(template: "personal" | "business" | "empty" = "personal") {
    if (!["personal", "business", "empty"].includes(template)) throw new Error("template must be personal, business, or empty");
    const usd = this.createAsset("USD", "currency", 2, "US Dollar");
    const created: string[] = [];
    const ensure = (name: string, type: AccountType, parent?: string) => {
      const existing = this.listAccounts().find((account) => account.name.toLowerCase() === name.toLowerCase());
      if (existing) return existing.id;
      const accountId = this.createAccount(name, type, parent);
      created.push(accountId);
      return accountId;
    };
    if (template === "personal") {
      ensure("Checking", "asset");
      ensure("Savings", "asset");
      ensure("Credit Card", "liability");
      ensure("Opening Balances", "equity");
      ensure("Salary", "income");
      ensure("Interest Income", "income");
      ensure("Groceries", "expense");
      ensure("Dining Out", "expense");
      ensure("Rent", "expense");
      ensure("Utilities", "expense");
      ensure("Transport", "expense");
      ensure("Uncategorized", "expense");
    } else if (template === "business") {
      ensure("Bank", "asset");
      ensure("Accounts Receivable", "asset");
      ensure("Accounts Payable", "liability");
      ensure("Owner Equity", "equity");
      ensure("Revenue", "income");
      ensure("Cost of Goods Sold", "expense");
      ensure("Payroll", "expense");
      ensure("Software", "expense");
    }
    return { template, asset_id: usd, accounts_created: created.length, account_ids: created };
  }

  getOrCreateAccount(name: string, type: AccountType): string {
    return this.listAccounts().find((account) => account.name.toLowerCase() === name.toLowerCase())?.id ?? this.createAccount(name, type);
  }

  recordSecurityPurchase(options: {
    symbol: string;
    shares: bigint | number;
    totalCost: bigint | number;
    cashAssetId: string;
    investmentAccountId: string;
    date: string;
    status?: TxStatus | string | null;
  }): Journal & { entries: JournalLine[] } {
    const txDate = dateOnly(options.date);
    const statusValue = txStatus(String(options.status ?? "posted"));
    const symbol = String(options.symbol).trim().toUpperCase();
    if (!symbol) throw new Error("Security symbol is required");
    const shares = BigInt(options.shares);
    const totalCost = BigInt(options.totalCost);
    if (shares <= 0n) throw new Error("Security shares must be positive");
    if (totalCost <= 0n) throw new Error("Security cost must be positive");

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertPeriodOpen(txDate);
      const securityId = this.createAsset(symbol, "security", 8, symbol);
      const holdingAccountId = this.getOrCreateAccount(`${symbol} Holdings`, "asset");
      const costAccountId = this.getOrCreateAccount("Investment Cost", "expense");
      const lines: Array<[string, string, bigint]> = [
        [options.investmentAccountId, options.cashAssetId, -totalCost],
        [costAccountId, options.cashAssetId, totalCost],
        [costAccountId, securityId, -shares],
        [holdingAccountId, securityId, shares]
      ];
      validateLines(lines);
      this.validateLineRefs(lines);
      const txId = this.insertTx(txDate, statusValue, `Buy ${symbol}`, lines);
      this.db.prepare("INSERT INTO lots(id, account_id, asset_id, quantity, cost_asset_id, cost_quantity, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        id("lot"),
        holdingAccountId,
        securityId,
        shares,
        options.cashAssetId,
        totalCost,
        txDate
      );
      this.db.exec("COMMIT");
      return this.txWithEntries(txId);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  backupNow(outputPath?: string | null) {
    const target = outputPath || join(dirname(this.path), "backups", `${now().replaceAll(":", "-")}.db`);
    mkdirSync(dirname(target), { recursive: true });
    this.db.prepare("VACUUM INTO ?").run(target);
    return { path: target };
  }

  integrityCheck() {
    const imbalanced: Row[] = [];
    for (const tx of this.listTransactions({ status: null })) {
      try {
        validateLines(this.getEntries(tx.id).map((entry) => [entry.account_id, entry.asset_id, entry.quantity]));
      } catch (error) {
        imbalanced.push({ tx_id: tx.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { ok: imbalanced.length === 0, imbalanced_transactions: imbalanced };
  }

  exportDocument() {
    const transactions = this.listTransactions({ status: null }).map((tx) => ({ ...tx, entries: this.getEntries(tx.id), tags: this.listAnnotations("tx", tx.id) }));
    return {
      format: "clovis-ledger-v1",
      assets: this.listAssets(),
      accounts: this.listAccounts(),
      sources: this.listSources(null, null),
      transactions,
      account_tags: (this.db.prepare("SELECT id, entity_type, entity_id, key, value AS val, value FROM annotations WHERE entity_type = 'account'").all() as Row[]),
      prices: this.listPrices(),
      budgets: this.db.prepare("SELECT * FROM targets WHERE type = 'budget'").all() as Row[],
      goals: (this.db.prepare("SELECT * FROM targets WHERE type = 'goal'").all() as Row[]).map((row) => ({ ...row, target_quantity: row.quantity, target_cents: row.quantity })),
      branches: this.db.prepare("SELECT name, created_at, closed_at AS discarded_at FROM books WHERE type = 'scenario' ORDER BY name").all() as Row[],
      checkpoints: this.listCheckpoints(),
      lots: this.listLots(),
      scheduled_transactions: this.db.prepare("SELECT * FROM recurrences ORDER BY next_date, id").all() as Row[]
    };
  }

  importDocument(doc: Record<string, any>, preserveIds = true, dryRun = false) {
    if (!/^clovis(?:-[a-z]+)?-ledger-v[12]$/.test(String(doc.format))) {
      throw new Error("Unsupported ledger export format");
    }
    const assetMap = new Map<string, string>();
    const accountMap = new Map<string, string>();
    const sourceMap = new Map<string, string>();
    const txMap = new Map<string, string>();
    for (const asset of doc.assets ?? []) assetMap.set(asset.id, preserveIds ? asset.id : (this.getAssetBySymbol(asset.symbol)?.id ?? id("asset")));
    for (const account of doc.accounts ?? []) accountMap.set(account.id, preserveIds ? account.id : id("acct"));
    for (const source of doc.sources ?? []) sourceMap.set(source.id, preserveIds ? source.id : id(source.type === "import" ? "batch" : "source"));
    for (const tx of doc.transactions ?? []) {
      txMap.set(tx.id, preserveIds ? tx.id : id("tx"));
      const lines = (tx.entries ?? []).map((entry: any) => [
        accountMap.get(entry.account_id)!,
        assetMap.get(entry.asset_id)!,
        BigInt(entry.quantity ?? entry.qty_cents ?? 0)
      ] as [string, string, bigint]);
      validateLines(lines);
      this.assertPeriodOpen(dateOnly(tx.date));
    }
    const result = {
      valid: true,
      assets: (doc.assets ?? []).length,
      accounts: (doc.accounts ?? []).length,
      sources: (doc.sources ?? []).length,
      transactions: (doc.transactions ?? []).length,
      prices: (doc.prices ?? []).length,
      budgets: (doc.budgets ?? []).length,
      goals: (doc.goals ?? []).length,
      branches: (doc.branches ?? []).length,
      checkpoints: (doc.checkpoints ?? []).length,
      lots: (doc.lots ?? []).length,
      scheduled_transactions: (doc.scheduled_transactions ?? []).length,
      dry_run: dryRun
    };
    if (dryRun) return result;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const asset of doc.assets ?? []) {
        this.db.prepare("INSERT OR IGNORE INTO assets(id, symbol, type, scale, name) VALUES (?, ?, ?, ?, ?)").run(
          assetMap.get(asset.id)!,
          asset.symbol,
          asset.type ?? asset.asset_type,
          Number(asset.scale ?? asset.decimals ?? 2),
          asset.name ?? ""
        );
      }
      for (const account of doc.accounts ?? []) {
        this.db.prepare("INSERT OR IGNORE INTO accounts(id, book_id, name, type, parent_id, code, color_hex) VALUES (?, ?, ?, ?, NULL, ?, ?)").run(
          accountMap.get(account.id)!,
          DEFAULT_BOOK_ID,
          account.name,
          account.type ?? account.account_type,
          account.code ?? "",
          account.color_hex ?? "#888888"
        );
      }
      for (const account of doc.accounts ?? []) {
        if (account.parent_id) this.db.prepare("UPDATE accounts SET parent_id = ? WHERE id = ?").run(accountMap.get(account.parent_id)!, accountMap.get(account.id)!);
      }
      for (const source of doc.sources ?? []) {
        this.db.prepare("INSERT OR IGNORE INTO sources(id, type, label, status, created_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?)").run(
          sourceMap.get(source.id)!,
          source.type,
          source.label ?? "",
          source.status ?? "open",
          source.created_at ?? now(),
          source.metadata_json ?? "{}"
        );
      }
      for (const tx of doc.transactions ?? []) {
        const txId = txMap.get(tx.id)!;
        this.db.prepare("INSERT OR IGNORE INTO journals(id, book_id, source_id, date, posted_at, status, description, external_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
          txId,
          DEFAULT_BOOK_ID,
          tx.source_id ? sourceMap.get(tx.source_id) ?? tx.source_id : null,
          tx.date,
          tx.posted_at ?? now(),
          tx.status,
          tx.description ?? "",
          tx.external_id ?? null
        );
        (tx.entries ?? []).forEach((entry: any, index: number) => {
          this.db.prepare("INSERT OR IGNORE INTO journal_lines(id, journal_id, line_no, account_id, asset_id, quantity) VALUES (?, ?, ?, ?, ?, ?)").run(
            preserveIds ? entry.id : id("line"),
            txId,
            index + 1,
            accountMap.get(entry.account_id)!,
            assetMap.get(entry.asset_id)!,
            BigInt(entry.quantity ?? entry.qty_cents ?? 0)
          );
        });
        for (const tag of tx.tags ?? []) {
          this.createAnnotation(tag.entity_type ?? "tx", txId, tag.key, tag.val ?? tag.value ?? "");
        }
      }
      for (const price of doc.prices ?? []) {
        this.db.prepare("INSERT OR IGNORE INTO prices(id, book_id, asset_id, quote_asset_id, rate_value, rate_scale, time) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
          preserveIds ? price.id : id("price"),
          DEFAULT_BOOK_ID,
          assetMap.get(price.asset_id)!,
          assetMap.get(price.quote_asset_id ?? price.quote_id)!,
          BigInt(price.rate_value ?? price.rate_cents ?? 0),
          Number(price.rate_scale ?? 2),
          price.time
        );
      }
      let defaultAssetId = [...(doc.assets ?? [])].find((asset: any) => String(asset.symbol).toUpperCase() === "USD")?.id;
      defaultAssetId = defaultAssetId ? assetMap.get(defaultAssetId) : (this.getAssetBySymbol("USD")?.id ?? this.createAsset("USD", "currency", 2, "US Dollar"));
      for (const budget of doc.budgets ?? []) {
        this.db.prepare("INSERT OR IGNORE INTO targets(id, type, account_id, asset_id, quantity, period, year, month, rollover_rule) VALUES (?, 'budget', ?, ?, ?, ?, ?, ?, ?)").run(
          preserveIds ? budget.id : id("target"),
          accountMap.get(budget.account_id)!,
          budget.asset_id ? assetMap.get(budget.asset_id)! : defaultAssetId!,
          BigInt(budget.quantity ?? budget.amount_cents ?? 0),
          budget.period ?? "monthly",
          budget.year ?? null,
          budget.month ?? null,
          budget.rollover_rule ?? ""
        );
      }
      for (const goal of doc.goals ?? []) {
        this.db.prepare("INSERT OR IGNORE INTO targets(id, type, account_id, asset_id, quantity, name, target_date, priority) VALUES (?, 'goal', ?, ?, ?, ?, ?, ?)").run(
          preserveIds && goal.id ? goal.id : id("target"),
          accountMap.get(goal.account_id)!,
          goal.asset_id ? assetMap.get(goal.asset_id)! : defaultAssetId!,
          BigInt(goal.quantity ?? goal.target_quantity ?? goal.target_cents ?? 0),
          goal.name,
          goal.target_date ?? null,
          Number(goal.priority ?? 1)
        );
      }
      for (const branch of doc.branches ?? []) {
        this.db.prepare("INSERT OR IGNORE INTO books(id, name, type, parent_id, created_at, closed_at) VALUES (?, ?, 'scenario', ?, ?, ?)").run(
          branch.name,
          branch.name,
          DEFAULT_BOOK_ID,
          branch.created_at ?? now(),
          branch.discarded_at ?? branch.closed_at ?? null
        );
      }
      for (const checkpoint of doc.checkpoints ?? []) {
        this.db.prepare("INSERT OR IGNORE INTO period_closes(id, book_id, name, as_of, description, created_at, reopened_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
          preserveIds ? checkpoint.id : id("period"),
          DEFAULT_BOOK_ID,
          checkpoint.name,
          checkpoint.as_of,
          checkpoint.description ?? null,
          checkpoint.created_at ?? now(),
          checkpoint.reopened_at ?? null
        );
      }
      for (const lot of doc.lots ?? []) {
        this.db.prepare("INSERT OR IGNORE INTO lots(id, account_id, asset_id, quantity, cost_asset_id, cost_quantity, opened_at, closed_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
          preserveIds ? lot.id : id("lot"),
          accountMap.get(lot.account_id)!,
          assetMap.get(lot.asset_id)!,
          BigInt(lot.quantity ?? 0),
          assetMap.get(lot.cost_asset_id)!,
          BigInt(lot.cost_quantity ?? 0),
          lot.opened_at,
          lot.closed_at ?? null,
          lot.metadata_json ?? "{}"
        );
      }
      for (const scheduled of doc.scheduled_transactions ?? []) {
        this.db.prepare("INSERT OR IGNORE INTO recurrences(id, next_date, quantity, from_account_id, to_account_id, description, frequency, end_date, asset_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
          preserveIds ? scheduled.id : id("sched"),
          scheduled.next_date,
          BigInt(scheduled.quantity ?? scheduled.amount_cents ?? 0),
          accountMap.get(scheduled.from_account_id)!,
          accountMap.get(scheduled.to_account_id)!,
          scheduled.description ?? "",
          scheduled.frequency,
          scheduled.end_date ?? null,
          scheduled.asset_id ? assetMap.get(scheduled.asset_id)! : defaultAssetId!,
          scheduled.status ?? "active"
        );
      }
      this.db.exec("COMMIT");
      return { ...result, imported: true };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  exportTransactionsCsv(outputPath?: string | null) {
    const rows = ["date,description,amount,account_id,tx_id"];
    for (const tx of this.listTransactions({ status: null })) {
      if (tx.status === "void") continue;
      for (const entry of this.getEntries(tx.id)) {
        const desc = `"${tx.description.replaceAll('"', '""')}"`;
        rows.push(`${tx.date},${desc},${entry.quantity.toString()},${entry.account_id},${tx.id}`);
      }
    }
    const csv = `${rows.join("\n")}\n`;
    if (outputPath) {
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, csv, "utf8");
      return { exported: rows.length - 1, csv: null, file: outputPath };
    }
    return { exported: rows.length - 1, csv, file: null };
  }
}
