import { randomUUID } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { annotateAccount, annotateAmounts, debitCredit, normalAmount, normalSide } from "./accounting.js";
import { DEFAULT_BOOK_ID, DDL, SCHEMA_VERSION } from "./schema.js";
import type { Account, AccountBalance, AccountType, Asset, AssetType, Journal, JournalLine, Price, TxStatus } from "./types.js";
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

function integerInRange(value: unknown, label: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function assetScaleValue(value: unknown, label = "scale"): number {
  return integerInRange(value, label, 0, 18);
}

function targetPeriod(value: string): string {
  if (!["monthly", "yearly"].includes(value)) throw new Error("period must be monthly or yearly");
  return value;
}

function monthValue(value: number | null | undefined): number | null {
  if (value == null) return null;
  return integerInRange(value, "month", 1, 12);
}

function yearValue(value: number | null | undefined): number | null {
  if (value == null) return null;
  return integerInRange(value, "year", 1, 9999);
}

function recurrenceFrequency(value: string): string {
  if (!["daily", "weekly", "monthly", "yearly"].includes(value)) {
    throw new Error("frequency must be daily, weekly, monthly, or yearly");
  }
  return value;
}

function positiveQuantity(value: bigint | number, label: string): bigint {
  const quantity = BigInt(value);
  if (quantity <= 0n) throw new Error(`${label} must be positive`);
  return quantity;
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
    if (!normalized) throw new Error("Asset symbol is required");
    const normalizedScale = assetScaleValue(scale);
    const existing = this.getAssetBySymbol(normalized);
    if (existing) return existing.id;
    const assetId = id("asset");
    this.db.prepare("INSERT INTO assets(id, symbol, type, scale, name) VALUES (?, ?, ?, ?, ?)").run(
      assetId,
      normalized,
      assetType(String(type)),
      normalizedScale,
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

  private assertValidAccountParent(accountId: string, parentId: string | null): void {
    if (!parentId) return;
    if (parentId === accountId) throw new Error("Account cannot be its own parent");
    let current = this.getAccount(parentId);
    while (current) {
      if (current.id === accountId) throw new Error("Account parent would create a cycle");
      current = current.parent_id ? this.getAccount(current.parent_id) : null;
    }
  }

  updateAccount(accountId: string, values: {
    name?: string | null;
    type?: AccountType | string | null;
    parent_id?: string | null;
    code?: string | null;
    color_hex?: string | null;
  }): Account {
    const existingAccount = this.getAccount(accountId);
    if (!existingAccount) throw new Error(`Account ${accountId} not found`);
    if (values.name != null) this.db.prepare("UPDATE accounts SET name = ? WHERE id = ?").run(values.name, accountId);
    if (values.type != null) {
      const nextType = accountType(String(values.type));
      if (nextType !== existingAccount.account_type) this.assertAccountNotLinkedToLots(accountId);
      this.db.prepare("UPDATE accounts SET type = ? WHERE id = ?").run(nextType, accountId);
    }
    if (values.parent_id !== undefined) {
      if (values.parent_id && !this.getAccount(values.parent_id)) throw new Error(`Parent account ${values.parent_id} not found`);
      this.assertValidAccountParent(accountId, values.parent_id || null);
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
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM accounts WHERE id = ?").run(accountId);
      this.db.prepare("DELETE FROM annotations WHERE book_id = ? AND entity_type = 'account' AND entity_id = ?").run(DEFAULT_BOOK_ID, accountId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createAnnotation(entityType: string, entityId: string, key: string, value: string): string {
    const annotationId = id("ann");
    this.db.prepare("INSERT INTO annotations(id, book_id, entity_type, entity_id, key, value) VALUES (?, ?, ?, ?, ?, ?)").run(
      annotationId,
      DEFAULT_BOOK_ID,
      entityType,
      entityId,
      key,
      value
    );
    return annotationId;
  }

  listAnnotations(entityType: string, entityId: string): Array<Record<string, string>> {
    return (this.db.prepare(
      "SELECT id, book_id, entity_type, entity_id, key, value AS val, value FROM annotations WHERE book_id = ? AND entity_type = ? AND entity_id = ? ORDER BY key, id"
    ).all(DEFAULT_BOOK_ID, entityType, entityId) as Row[]).map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, String(v)])));
  }

  deleteAnnotation(annotationId: string): void {
    this.db.prepare("DELETE FROM annotations WHERE id = ?").run(annotationId);
  }

  listAnnotationEntityIds(entityType: string, key: string, value: string): string[] {
    return (this.db.prepare("SELECT entity_id FROM annotations WHERE book_id = ? AND entity_type = ? AND key = ? AND value = ? ORDER BY entity_id").all(DEFAULT_BOOK_ID, entityType, key, value) as Row[])
      .map((row) => String(row.entity_id));
  }

  createSource(type: string, label?: string | null, metadata: Row = {}, status = "open"): string {
    const sourceId = id(type === "import" ? "batch" : "source");
    this.db.prepare("INSERT INTO sources(id, book_id, type, label, status, created_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      sourceId,
      DEFAULT_BOOK_ID,
      type,
      label ?? "",
      status,
      now(),
      JSON.stringify(metadata)
    );
    return sourceId;
  }

  listSources(type?: string | null, limit: number | null = 20): Row[] {
    let sql = "SELECT * FROM sources WHERE book_id = ?";
    const params: SQLInputValue[] = [DEFAULT_BOOK_ID];
    if (type) {
      sql += " AND type = ?";
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

  updateTransactionSource(txId: string, sourceId: string | null): number {
    if (sourceId != null && !this.db.prepare("SELECT id FROM sources WHERE id = ?").get(sourceId)) throw new Error(`Source ${sourceId} not found`);
    return Number(this.db.prepare("UPDATE journals SET source_id = ? WHERE id = ?").run(sourceId, txId).changes);
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
    const existing = this.db.prepare("SELECT id FROM rules WHERE book_id = ? AND type = ? AND account_id = ? AND pattern = ? AND status = 'active'").get(DEFAULT_BOOK_ID, type, accountId, pattern) as Row | undefined;
    if (existing) return String(existing.id);
    const ruleId = id("rule");
    this.db.prepare("INSERT INTO rules(id, book_id, type, account_id, pattern, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(ruleId, DEFAULT_BOOK_ID, type, accountId, pattern, now());
    return ruleId;
  }

  listRules(type = "match"): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT id, account_id, pattern, priority, status FROM rules WHERE book_id = ? AND type = ? AND status = 'active' ORDER BY priority, id").all(DEFAULT_BOOK_ID, type) as Row[];
  }

  deleteRule(accountId: string, pattern: string, type = "match"): number {
    const result = this.db.prepare("UPDATE rules SET status = 'deleted' WHERE book_id = ? AND type = ? AND account_id = ? AND pattern = ? AND status = 'active'").run(DEFAULT_BOOK_ID, type, accountId, pattern);
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
    let sql = "SELECT * FROM targets WHERE book_id = ? AND type = 'budget'";
    const params: SQLInputValue[] = [DEFAULT_BOOK_ID];
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
    if (amount < 0n) throw new Error("Budget amount cannot be negative");
    const normalizedPeriod = targetPeriod(period);
    const normalizedYear = yearValue(year);
    const normalizedMonth = monthValue(month);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM targets WHERE book_id = ? AND type = 'budget' AND account_id = ? AND asset_id = ? AND period = ? AND year IS ? AND month IS ?").run(DEFAULT_BOOK_ID, accountId, assetId, normalizedPeriod, normalizedYear, normalizedMonth);
      const targetId = id("budget");
      this.db.prepare("INSERT INTO targets(id, book_id, type, account_id, asset_id, quantity, period, year, month, rollover_rule) VALUES (?, ?, 'budget', ?, ?, ?, ?, ?, ?, ?)").run(
        targetId,
        DEFAULT_BOOK_ID,
        accountId,
        assetId,
        amount,
        normalizedPeriod,
        normalizedYear,
        normalizedMonth,
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
    let sql = "DELETE FROM targets WHERE book_id = ? AND type = 'budget' AND account_id = ?";
    const params: SQLInputValue[] = [DEFAULT_BOOK_ID, accountId];
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
    return Number(this.db.prepare("DELETE FROM targets WHERE book_id = ? AND type = 'budget'").run(DEFAULT_BOOK_ID).changes);
  }

  setGoal(accountId: string, assetId: string, quantity: bigint | number, name: string, targetDate?: string | null, priority = 1): Row {
    if (!this.getAccount(accountId)) throw new Error(`Account ${accountId} not found`);
    if (!this.getAsset(assetId)) throw new Error(`Asset ${assetId} not found`);
    const amount = positiveQuantity(quantity, "Goal target");
    const normalizedDate = targetDate == null || targetDate === "" ? null : dateOnly(targetDate);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM targets WHERE book_id = ? AND type = 'goal' AND account_id = ? AND asset_id = ?").run(DEFAULT_BOOK_ID, accountId, assetId);
      const targetId = id("goal");
      this.db.prepare("INSERT INTO targets(id, book_id, type, account_id, asset_id, quantity, name, target_date, priority) VALUES (?, ?, 'goal', ?, ?, ?, ?, ?, ?)").run(
        targetId,
        DEFAULT_BOOK_ID,
        accountId,
        assetId,
        amount,
        name,
        normalizedDate,
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
    return this.db.prepare("SELECT * FROM targets WHERE book_id = ? AND type = 'goal' ORDER BY priority, name").all(DEFAULT_BOOK_ID) as Row[];
  }

  getGoalTarget(accountId: string): Row | null {
    return (this.db.prepare("SELECT * FROM targets WHERE book_id = ? AND type = 'goal' AND account_id = ? ORDER BY priority, name LIMIT 1").get(DEFAULT_BOOK_ID, accountId) as Row | undefined) ?? null;
  }

  deleteGoal(accountId: string): number {
    return Number(this.db.prepare("DELETE FROM targets WHERE book_id = ? AND type = 'goal' AND account_id = ?").run(DEFAULT_BOOK_ID, accountId).changes);
  }

  createRecurrence(date: string, quantity: bigint | number, fromAccountId: string, toAccountId: string, description: string, frequency: string, endDate: string | null, assetId: string): Row {
    if (!this.getAccount(fromAccountId) || !this.getAccount(toAccountId)) throw new Error("Account not found");
    if (!this.getAsset(assetId)) throw new Error(`Asset ${assetId} not found`);
    const amount = positiveQuantity(quantity, "Scheduled transaction amount");
    const normalizedFrequency = recurrenceFrequency(frequency);
    const normalizedEndDate = endDate == null || endDate === "" ? null : dateOnly(endDate);
    const recurrenceId = id("sched");
    this.db.prepare("INSERT INTO recurrences(id, book_id, next_date, quantity, from_account_id, to_account_id, description, frequency, end_date, asset_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      recurrenceId,
      DEFAULT_BOOK_ID,
      dateOnly(date),
      amount,
      fromAccountId,
      toAccountId,
      description,
      normalizedFrequency,
      normalizedEndDate,
      assetId
    );
    return this.db.prepare("SELECT *, quantity AS amount_cents FROM recurrences WHERE id = ?").get(recurrenceId) as Row;
  }

  listRecurrences(): Row[] {
    return this.db.prepare("SELECT *, quantity AS amount_cents FROM recurrences WHERE book_id = ? ORDER BY next_date, id").all(DEFAULT_BOOK_ID) as Row[];
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
    return this.db.prepare("SELECT * FROM lots WHERE book_id = ? ORDER BY opened_at, id").all(DEFAULT_BOOK_ID) as Row[];
  }

  createPrice(assetId: string, quoteId: string, rate: number | string | bigint, time: string, rateScale?: number): string {
    if (!this.getAsset(assetId) || !this.getAsset(quoteId)) throw new Error("Asset not found");
    const scaled = rateScale == null ? decimalToScaled(rate) : { value: BigInt(rate), scale: assetScaleValue(rateScale, "rate_scale") };
    if (scaled.value <= 0n) throw new Error("Price rate must be positive");
    assetScaleValue(scaled.scale, "rate_scale");
    if (!String(time ?? "").trim()) throw new Error("Price time is required");
    const priceId = id("price");
    this.db.prepare(
      "INSERT INTO prices(id, book_id, asset_id, quote_asset_id, rate_value, rate_scale, time) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(priceId, DEFAULT_BOOK_ID, assetId, quoteId, scaled.value, scaled.scale, time);
    return priceId;
  }

  listPrices(): Price[] {
    return (this.db.prepare("SELECT * FROM prices WHERE book_id = ? ORDER BY time DESC, id DESC").all(DEFAULT_BOOK_ID) as Row[]).map((row) => toPrice(row)!);
  }

  queryPrice(assetId: string, quoteId: string, asOf: string): Price | null {
    return toPrice(this.db.prepare(
      "SELECT * FROM prices WHERE book_id = ? AND asset_id = ? AND quote_asset_id = ? AND time <= ? ORDER BY time DESC, id DESC LIMIT 1"
    ).get(DEFAULT_BOOK_ID, assetId, quoteId, asOf) as Row | undefined);
  }

  private priceGraph(asOf: string): Map<string, Array<{ to: string; numerator: bigint; denominator: bigint }>> {
    const assets = new Map(this.listAssets().map((asset) => [asset.id, asset]));
    const graph = new Map<string, Array<{ to: string; numerator: bigint; denominator: bigint }>>();
    const seen = new Set<string>();
    const rows = this.db.prepare("SELECT * FROM prices WHERE book_id = ? AND time <= ? ORDER BY time DESC, id DESC").all(DEFAULT_BOOK_ID, asOf) as Row[];
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
      this.db.prepare("INSERT INTO journal_lines(id, book_id, journal_id, line_no, account_id, asset_id, quantity) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        id("line"),
        DEFAULT_BOOK_ID,
        txId,
        index + 1,
        accountId,
        assetId,
        quantity
      );
    });
    return txId;
  }

  private assertTxNotLinkedToLots(txId: string): void {
    const row = this.db.prepare("SELECT id FROM lots WHERE book_id = ? AND (opened_journal_id = ? OR closed_journal_id = ?) LIMIT 1").get(DEFAULT_BOOK_ID, txId, txId) as Row | undefined;
    if (row) throw new Error("Transaction has linked investment lots; use an investment reversal workflow");
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
    this.assertTxNotLinkedToLots(txId);
    this.db.prepare("UPDATE journals SET status = 'void' WHERE id = ?").run(txId);
  }

  updateTxStatus(txId: string, status: TxStatus | string): boolean {
    const tx = this.getTx(txId);
    if (!tx) throw new Error(`Transaction ${txId} not found`);
    this.assertPeriodOpen(tx.date);
    const statusValue = txStatus(String(status));
    if (statusValue === "void") this.assertTxNotLinkedToLots(txId);
    const result = this.db.prepare("UPDATE journals SET status = ? WHERE id = ?").run(statusValue, txId);
    return Number(result.changes) > 0;
  }

  deleteTx(txId: string): void {
    const tx = this.getTx(txId);
    if (!tx) throw new Error(`Transaction ${txId} not found`);
    this.assertPeriodOpen(tx.date);
    this.assertTxNotLinkedToLots(txId);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM annotations WHERE book_id = ? AND entity_type = 'tx' AND entity_id = ?").run(DEFAULT_BOOK_ID, txId);
      this.db.prepare("DELETE FROM journals WHERE id = ?").run(txId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getTx(txId: string): Journal | null {
    return toJournal(this.db.prepare("SELECT * FROM journals WHERE id = ?").get(txId) as Row | undefined);
  }

  listTransactions(options: { status?: TxStatus | string | null; dateFrom?: string | null; dateTo?: string | null; sort?: "date_asc" | "date_desc" } = {}): Journal[] {
    let sql = "SELECT * FROM journals WHERE 1 = 1";
    const params: SQLInputValue[] = [];
    if (options.status != null) {
      if (options.status === "active") sql += " AND status IN ('posted', 'pending')";
      else if (options.status === "combined") sql += " AND status IN ('posted', 'pending', 'planned')";
      else {
        sql += " AND status = ?";
        params.push(txStatus(String(options.status)));
      }
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

  private assertAccountNotLinkedToLots(accountId: string): void {
    const row = this.db.prepare("SELECT id FROM lots WHERE book_id = ? AND account_id = ? LIMIT 1").get(DEFAULT_BOOK_ID, accountId) as Row | undefined;
    if (row) throw new Error("Account has linked investment lots; use an investment-specific workflow");
  }

  private assertAssetNotLinkedToLots(assetId: string): void {
    const row = this.db.prepare("SELECT id FROM lots WHERE book_id = ? AND (asset_id = ? OR cost_asset_id = ?) LIMIT 1").get(DEFAULT_BOOK_ID, assetId, assetId) as Row | undefined;
    if (row) throw new Error("Asset has linked investment lots; use an investment-specific workflow");
  }

  recategorizeTransaction(txId: string, oldAccountId: string, newAccountId: string): Record<string, string> {
    const tx = this.getTx(txId);
    if (!tx) throw new Error(`Transaction ${txId} not found`);
    this.assertPeriodOpen(tx.date);
    this.assertTxNotLinkedToLots(txId);
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
        this.assertTxNotLinkedToLots(txId);
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
    this.assertAccountNotLinkedToLots(sourceAccountId);
    this.assertAccountNotLinkedToLots(targetAccountId);
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
    this.assertAssetNotLinkedToLots(fromAssetId);
    this.assertAssetNotLinkedToLots(toAssetId);
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
    if (status === "active") return { sql: "AND t.status IN ('posted', 'pending')", params: [] };
    if (status === "combined") return { sql: "AND t.status IN ('posted', 'pending', 'planned')", params: [] };
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
    const root = this.getAccount(accountId);
    if (!root) throw new Error(`Account ${accountId} not found`);
    let total = 0n;
    for (const id of this.descendants(accountId)) {
      const account = this.getAccount(id);
      if (account?.account_type === root.account_type) total += this.balance(id, assetId, asOf, status, dateFrom);
    }
    return total;
  }

  accountBalances(options: {
    accountType?: AccountType | string | null;
    assetId?: string | null;
    asOf?: string | null;
    rollup?: boolean;
    hideZero?: boolean;
  } = {}): AccountBalance[] {
    const filteredType = options.accountType ? accountType(String(options.accountType)) : null;
    const asOf = options.asOf ? dateOnly(options.asOf) : null;
    const rollup = Boolean(options.rollup);
    const hideZero = options.hideZero !== false;
    const accounts = this.listAccounts().filter((account) => !filteredType || account.account_type === filteredType);
    const assets = options.assetId
      ? [this.getAsset(options.assetId)].filter((asset): asset is Asset => asset != null)
      : this.listAssets();
    if (options.assetId && assets.length === 0) throw new Error(`Asset ${options.assetId} not found`);

    const allAccounts = this.listAccounts();
    const children = new Map<string, Account[]>();
    for (const account of allAccounts) {
      if (!account.parent_id) continue;
      children.set(account.parent_id, [...(children.get(account.parent_id) ?? []), account]);
    }
    const sameTypeDescendantIds = (account: Account): string[] => {
      if (!rollup) return [account.id];
      const ids: string[] = [];
      const visit = (current: Account): void => {
        if (current.account_type === account.account_type) ids.push(current.id);
        for (const child of children.get(current.id) ?? []) visit(child);
      };
      visit(account);
      return ids;
    };

    const rows: AccountBalance[] = [];
    for (const account of accounts) {
      const ids = sameTypeDescendantIds(account);
      const defaultAssetId = this.listAnnotations("account", account.id).filter((tag) => tag.key === "default_asset").at(-1)?.value ?? null;
      const defaultAsset = defaultAssetId ? this.getAsset(defaultAssetId) : null;
      for (const asset of assets) {
        const posted = ids.reduce((sum, id) => sum + this.balance(id, asset.id, asOf, "posted"), 0n);
        const pending = ids.reduce((sum, id) => sum + this.balance(id, asset.id, asOf, "pending"), 0n);
        const current = posted + pending;
        if (hideZero && posted === 0n && pending === 0n && current === 0n) continue;
        rows.push({
          account_id: account.id,
          account_name: account.name,
          account_type: account.account_type,
          type: account.account_type,
          parent_id: account.parent_id,
          asset_id: asset.id,
          asset_symbol: asset.symbol,
          default_asset_id: defaultAssetId,
          default_asset_symbol: defaultAsset?.symbol ?? null,
          scale: asset.scale,
          rollup,
          posted_quantity: posted,
          pending_quantity: pending,
          current_quantity: current,
          posted_balance: posted,
          pending_balance: pending,
          current_balance: current,
          posted_balance_cents: posted,
          pending_balance_cents: pending,
          current_balance_cents: current,
          posted_display: Number(fromAtomicUnits(posted, asset.scale)),
          pending_display: Number(fromAtomicUnits(pending, asset.scale)),
          current_display: Number(fromAtomicUnits(current, asset.scale))
        });
      }
    }
    return rows;
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

  balanceSheet(asOf: string | null, quoteAssetId: string, status: TxStatus | string | null = "posted") {
    const date = asOf || "9999-12-31";
    const accounts = this.listAccounts();
    const accountById = new Map(accounts.map((account) => [account.id, account]));
    const children = new Map<string | null, Account[]>();
    for (const account of accounts) {
      const key = account.parent_id ?? null;
      children.set(key, [...(children.get(key) ?? []), account]);
    }
    const quote = this.getAsset(quoteAssetId);
    const scale = quote?.scale ?? 2;
    const missing: Row[] = [];
    const sameTypeDescendants = (account: Account): Account[] => {
      const rows: Account[] = [];
      const visit = (current: Account): void => {
        if (current.account_type === account.account_type) rows.push(current);
        for (const child of children.get(current.id) ?? []) visit(child);
      };
      visit(account);
      return rows;
    };
    const typedQuotedBalance = (account: Account): { total: bigint; missing: Row[] } => {
      let total = 0n;
      const rowMissing: Row[] = [];
      for (const typedAccount of sameTypeDescendants(account)) {
        for (const asset of this.listAssets()) {
          const raw = this.balance(typedAccount.id, asset.id, date, status);
          if (raw === 0n) continue;
          const [converted, error] = this.tryConvertQuantity(raw, asset.id, quoteAssetId, date);
          if (converted == null) rowMissing.push({ account_id: typedAccount.id, asset_id: asset.id, quote_asset_id: quoteAssetId, quantity: raw, error });
          else total += converted;
        }
      }
      return { total, missing: rowMissing };
    };
    const sameTypeChildren = (account: Account): Account[] => {
      const rows: Account[] = [];
      const visit = (current: Account): void => {
        for (const child of children.get(current.id) ?? []) {
          if (child.account_type === account.account_type) rows.push(child);
          else visit(child);
        }
      };
      visit(account);
      return rows;
    };
    const sectionRoots = (type: AccountType): Account[] => accounts.filter((account) => {
      if (account.account_type !== type) return false;
      const parent = account.parent_id ? accountById.get(account.parent_id) : null;
      return parent?.account_type !== type;
    }).sort((a, b) => a.name.localeCompare(b.name));
    const build = (account: Account): Row => {
      const balance = typedQuotedBalance(account);
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
        children: sameTypeChildren(account).map(build)
      };
    };
    const sections: Record<string, Row[]> = { asset: [], liability: [], equity: [] };
    let currentIncome = 0n;
    let currentExpense = 0n;
    for (const type of ["asset", "liability", "equity"] as const) sections[type] = sectionRoots(type).map(build);
    for (const account of sectionRoots("income")) {
      const balance = typedQuotedBalance(account);
      missing.push(...balance.missing);
      currentIncome += normalAmount(account.account_type, balance.total);
    }
    for (const account of sectionRoots("expense")) {
      const balance = typedQuotedBalance(account);
      missing.push(...balance.missing);
      currentExpense += normalAmount(account.account_type, balance.total);
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

  netWorthReport(asOf: string, quoteAssetId: string, status: TxStatus | string | null = "posted") {
    const sheet = this.balanceSheet(asOf, quoteAssetId, status);
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

  cashFlow(year: number, month: number, quoteAssetId: string, status: TxStatus | string | null = "posted") {
    const [dateFrom, dateTo] = monthBounds(year, month);
    const accounts = new Map(this.listAccounts().map((a) => [a.id, a]));
    const scale = this.getAsset(quoteAssetId)?.scale ?? 2;
    const missing: Row[] = [];
    const totals = {
      income: new Map<string, bigint>(),
      expense: new Map<string, bigint>(),
      liability: new Map<string, bigint>()
    };
    for (const tx of this.listTransactions({ status, dateFrom, dateTo })) {
      for (const entry of this.getEntries(tx.id)) {
        const account = accounts.get(entry.account_id);
        if (account?.account_type === "income" || account?.account_type === "expense" || account?.account_type === "liability") {
          const [converted, error] = this.tryConvertQuantity(entry.quantity, entry.asset_id, quoteAssetId, tx.date);
          if (converted == null) {
            missing.push({ tx_id: tx.id, account_id: entry.account_id, asset_id: entry.asset_id, quote_asset_id: quoteAssetId, quantity: entry.quantity, error });
            continue;
          }
          const bucket = totals[account.account_type];
          bucket.set(account.id, (bucket.get(account.id) ?? 0n) + converted);
        }
      }
    }
    const line = (accountId: string, amount: bigint): Row => {
      const account = accounts.get(accountId);
      return {
        account_id: accountId,
        account_name: account?.name ?? "",
        account_type: account?.account_type ?? "",
        amount,
        amount_cents: amount,
        quantity: amount,
        asset_id: quoteAssetId,
        scale,
        amount_display: Number(fromAtomicUnits(amount, scale))
      };
    };
    const byName = ([leftId]: [string, bigint], [rightId]: [string, bigint]) => {
      const left = accounts.get(leftId)?.name ?? leftId;
      const right = accounts.get(rightId)?.name ?? rightId;
      return left.localeCompare(right);
    };
    const operating = [
      ...[...totals.income.entries()].filter(([, amount]) => amount !== 0n).sort(byName).map(([accountId, amount]) => line(accountId, amount)),
      ...[...totals.expense.entries()].filter(([, amount]) => amount !== 0n).sort(byName).map(([accountId, amount]) => line(accountId, amount))
    ];
    const equityEquivalent = new Set(["internal transfers", "opening balance", "opening balances", "retained earnings"]);
    const financing = [...totals.liability.entries()]
      .filter(([accountId, amount]) => amount !== 0n && !equityEquivalent.has((accounts.get(accountId)?.name ?? "").toLowerCase()))
      .sort(byName)
      .map(([accountId, amount]) => line(accountId, amount));
    const operatingTotal = operating.reduce((sum, row) => sum + BigInt(row.amount as bigint), 0n);
    const financingTotal = financing.reduce((sum, row) => sum + BigInt(row.amount as bigint), 0n);
    return {
      year,
      month,
      operating,
      investing: [],
      financing,
      operating_total: operatingTotal,
      investing_total: 0n,
      financing_total: financingTotal,
      net_change: -operatingTotal - financingTotal,
      quote_asset_id: quoteAssetId,
      valuation_complete: missing.length === 0,
      missing_conversions: missing
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

  trialBalance(assetId: string, status: TxStatus | string | null = "posted") {
    const scale = this.getAsset(assetId)?.scale ?? 2;
    const rows = this.listAccounts().map((account) => {
      const balance = this.balance(account.id, assetId, null, status);
      const parts = debitCredit(balance);
      return {
        ...account,
        amount: balance,
        amount_cents: balance,
        amount_display: Number(fromAtomicUnits(balance, scale)),
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

  initDefaults(template: "personal" | "business" | "empty" = "personal", assetId?: string | null) {
    if (!["personal", "business", "empty"].includes(template)) throw new Error("template must be personal, business, or empty");
    if (!assetId) throw new Error("asset_id is required for initDefaults");
    if (!this.getAsset(assetId)) throw new Error(`Asset ${assetId} not found`);
    const created: string[] = [];
    const ensure = (name: string, type: AccountType, parent?: string) => {
      const existing = this.listAccounts().find((account) => account.name.toLowerCase() === name.toLowerCase());
      const accountId = existing?.id ?? this.createAccount(name, type, parent);
      if (!existing) created.push(accountId);
      const hasDefault = this.listAnnotations("account", accountId).some((tag) => tag.key === "default_asset");
      if (!hasDefault) this.createAnnotation("account", accountId, "default_asset", assetId);
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
    return { template, asset_id: assetId, accounts_created: created.length, account_ids: created };
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
      this.db.prepare("INSERT INTO lots(id, book_id, account_id, asset_id, quantity, cost_asset_id, cost_quantity, opened_journal_id, opened_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')").run(
        id("lot"),
        DEFAULT_BOOK_ID,
        holdingAccountId,
        securityId,
        shares,
        options.cashAssetId,
        totalCost,
        txId,
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
    const accountCycles: Row[] = [];
    const accounts = this.listAccounts();
    const accountById = new Map(accounts.map((account) => [account.id, account]));
    for (const account of accounts) {
      const seen = new Set<string>([account.id]);
      let current = account.parent_id ? accountById.get(account.parent_id) : null;
      while (current) {
        if (seen.has(current.id)) {
          accountCycles.push({ account_id: account.id, cycle_at: current.id });
          break;
        }
        seen.add(current.id);
        current = current.parent_id ? accountById.get(current.parent_id) : null;
      }
    }

    const exists = (table: string, entityId: string): boolean => Boolean(this.db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(entityId));
    const orphanAnnotations: Row[] = [];
    const invalidDefaultAssets: Row[] = [];
    const annotations = this.db.prepare("SELECT * FROM annotations WHERE book_id = ? ORDER BY entity_type, entity_id, key, id").all(DEFAULT_BOOK_ID) as Row[];
    const annotationTables: Record<string, string> = {
      account: "accounts",
      asset: "assets",
      book: "books",
      lot: "lots",
      price: "prices",
      recurrence: "recurrences",
      source: "sources",
      target: "targets",
      tx: "journals",
      journal: "journals"
    };
    for (const annotation of annotations) {
      const table = annotationTables[String(annotation.entity_type)];
      if (table && !exists(table, String(annotation.entity_id))) orphanAnnotations.push(annotation);
      if (annotation.entity_type === "account" && annotation.key === "default_asset") {
        if (!this.getAccount(String(annotation.entity_id)) || !this.getAsset(String(annotation.value))) invalidDefaultAssets.push(annotation);
      }
    }

    const invalidPrices = this.db.prepare(
      "SELECT * FROM prices WHERE book_id = ? AND (rate_value <= 0 OR rate_scale < 0 OR rate_scale > 18 OR rate_scale != CAST(rate_scale AS INTEGER)) ORDER BY id"
    ).all(DEFAULT_BOOK_ID) as Row[];

    const invalidTargets = this.db.prepare(
      `SELECT * FROM targets
       WHERE book_id = ? AND (
         (type = 'budget' AND quantity < 0) OR
         (type = 'goal' AND quantity <= 0) OR
         (period IS NOT NULL AND period NOT IN ('monthly', 'yearly')) OR
         (month IS NOT NULL AND (month < 1 OR month > 12))
       )
       ORDER BY id`
    ).all(DEFAULT_BOOK_ID) as Row[];
    for (const target of this.db.prepare("SELECT * FROM targets WHERE book_id = ? AND type = 'goal' AND target_date IS NOT NULL ORDER BY id").all(DEFAULT_BOOK_ID) as Row[]) {
      try {
        dateOnly(String(target.target_date));
      } catch (error) {
        invalidTargets.push({ ...target, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const duplicateBudgets = this.db.prepare(
      `SELECT account_id, asset_id, period, year, month, count(*) AS count
       FROM targets
       WHERE book_id = ? AND type = 'budget'
       GROUP BY account_id, asset_id, period, coalesce(year, -1), coalesce(month, -1)
       HAVING count(*) > 1`
    ).all(DEFAULT_BOOK_ID) as Row[];

    const invalidRecurrences = this.db.prepare(
      `SELECT * FROM recurrences
       WHERE book_id = ? AND (
         quantity <= 0 OR
         frequency NOT IN ('daily', 'weekly', 'monthly', 'yearly') OR
         status NOT IN ('active', 'paused', 'deleted')
       )
       ORDER BY id`
    ).all(DEFAULT_BOOK_ID) as Row[];
    for (const recurrence of this.db.prepare("SELECT * FROM recurrences WHERE book_id = ? ORDER BY id").all(DEFAULT_BOOK_ID) as Row[]) {
      for (const field of ["next_date", "end_date"]) {
        if (recurrence[field] == null) continue;
        try {
          dateOnly(String(recurrence[field]));
        } catch (error) {
          invalidRecurrences.push({ ...recurrence, field, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }

    const invalidLots: Row[] = [];
    const openLotTotals = new Map<string, bigint>();
    for (const lot of this.listLots()) {
      const opened = lot.opened_journal_id ? this.getTx(String(lot.opened_journal_id)) : null;
      const closed = lot.closed_journal_id ? this.getTx(String(lot.closed_journal_id)) : null;
      const quantity = BigInt(lot.quantity as bigint | number | string);
      const costQuantity = BigInt(lot.cost_quantity as bigint | number | string);
      if (!opened || opened.status === "void") invalidLots.push({ ...lot, error: "opened_journal_id is missing or void" });
      if (lot.closed_journal_id && !closed) invalidLots.push({ ...lot, error: "closed_journal_id is missing" });
      if (quantity <= 0n || costQuantity <= 0n) invalidLots.push({ ...lot, error: "lot quantities must be positive" });
      if (!["open", "closed"].includes(String(lot.status))) invalidLots.push({ ...lot, error: "invalid lot status" });
      if (lot.status === "open") {
        const key = `${String(lot.account_id)}|${String(lot.asset_id)}`;
        openLotTotals.set(key, (openLotTotals.get(key) ?? 0n) + quantity);
      }
    }
    for (const [key, quantity] of openLotTotals) {
      const [accountId, assetId] = key.split("|");
      const balance = this.balanceTree(accountId, assetId, null, null);
      if (balance !== quantity) invalidLots.push({ account_id: accountId, asset_id: assetId, open_lot_quantity: quantity, balance, error: "open lot quantity does not match account balance" });
    }

    const schemaVersion = (this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as Row | undefined)?.value ?? null;
    return {
      ok: imbalanced.length === 0 &&
        accountCycles.length === 0 &&
        orphanAnnotations.length === 0 &&
        invalidDefaultAssets.length === 0 &&
        invalidPrices.length === 0 &&
        invalidTargets.length === 0 &&
        duplicateBudgets.length === 0 &&
        invalidRecurrences.length === 0 &&
        invalidLots.length === 0,
      schema_version: schemaVersion,
      imbalanced_transactions: imbalanced,
      account_cycles: accountCycles,
      orphan_annotations: orphanAnnotations,
      invalid_default_assets: invalidDefaultAssets,
      invalid_prices: invalidPrices,
      invalid_targets: invalidTargets,
      duplicate_budgets: duplicateBudgets,
      invalid_recurrences: invalidRecurrences,
      invalid_lots: invalidLots
    };
  }

  exportDocument() {
    const transactions = this.listTransactions({ status: null }).map((tx) => ({ ...tx, entries: this.getEntries(tx.id), tags: this.listAnnotations("tx", tx.id) }));
    const accounts = this.listAccounts().map((account) => {
      const defaultAssetId = this.listAnnotations("account", account.id).filter((tag) => tag.key === "default_asset").at(-1)?.value ?? null;
      const defaultAsset = defaultAssetId ? this.getAsset(defaultAssetId) : null;
      return { ...account, default_asset_id: defaultAssetId, default_asset_symbol: defaultAsset?.symbol ?? null };
    });
    return {
      format: "clovis-ledger-v1",
      assets: this.listAssets(),
      accounts,
      sources: this.listSources(null, null),
      transactions,
      account_tags: (this.db.prepare("SELECT id, book_id, entity_type, entity_id, key, value AS val, value FROM annotations WHERE book_id = ? AND entity_type = 'account'").all(DEFAULT_BOOK_ID) as Row[]),
      prices: this.listPrices(),
      budgets: this.db.prepare("SELECT * FROM targets WHERE book_id = ? AND type = 'budget'").all(DEFAULT_BOOK_ID) as Row[],
      goals: (this.db.prepare("SELECT * FROM targets WHERE book_id = ? AND type = 'goal'").all(DEFAULT_BOOK_ID) as Row[]).map((row) => ({ ...row, target_quantity: row.quantity, target_cents: row.quantity })),
      branches: this.db.prepare("SELECT name, created_at, closed_at AS discarded_at FROM books WHERE type = 'scenario' ORDER BY name").all() as Row[],
      checkpoints: this.listCheckpoints(),
      lots: this.listLots(),
      scheduled_transactions: this.db.prepare("SELECT * FROM recurrences WHERE book_id = ? ORDER BY next_date, id").all(DEFAULT_BOOK_ID) as Row[]
    };
  }

  importDocument(doc: Record<string, any>, preserveIds = true, dryRun = false) {
    if (!/^clovis(?:-[a-z]+)?-ledger-v[12]$/.test(String(doc.format))) {
      throw new Error("Unsupported ledger export format");
    }

    const errors: string[] = [];
    const array = (name: string): any[] => {
      const value = doc[name];
      if (value == null) return [];
      if (!Array.isArray(value)) {
        errors.push(`${name} must be an array`);
        return [];
      }
      return value;
    };
    const assets = array("assets");
    const accounts = array("accounts");
    const accountTags = array("account_tags");
    const sources = array("sources");
    const transactions = array("transactions");
    const prices = array("prices");
    const budgets = array("budgets");
    const goals = array("goals");
    const branches = array("branches");
    const checkpoints = array("checkpoints");
    const lots = array("lots");
    const scheduledTransactions = array("scheduled_transactions");

    const result = {
      valid: true,
      assets: assets.length,
      accounts: accounts.length,
      account_tags: accountTags.length,
      sources: sources.length,
      transactions: transactions.length,
      prices: prices.length,
      budgets: budgets.length,
      goals: goals.length,
      branches: branches.length,
      checkpoints: checkpoints.length,
      lots: lots.length,
      scheduled_transactions: scheduledTransactions.length,
      inserted: {
        assets: 0,
        accounts: 0,
        account_tags: 0,
        sources: 0,
        transactions: 0,
        prices: 0,
        budgets: 0,
        goals: 0,
        branches: 0,
        checkpoints: 0,
        lots: 0,
        scheduled_transactions: 0
      },
      skipped: 0,
      errors: [] as string[],
      dry_run: dryRun
    };

    const requireId = (section: string, row: any, index: number): string | null => {
      const value = row?.id;
      if (typeof value !== "string" || value.trim() === "") {
        errors.push(`${section}[${index}].id is required`);
        return null;
      }
      return value;
    };
    const seen = new Map<string, Set<string>>();
    const trackId = (section: string, value: string, index: number): void => {
      const sectionSeen = seen.get(section) ?? new Set<string>();
      if (sectionSeen.has(value)) errors.push(`${section}[${index}].id duplicates ${value}`);
      sectionSeen.add(value);
      seen.set(section, sectionSeen);
    };
    const parseQuantity = (value: unknown, label: string): bigint => {
      try {
        const quantity = BigInt(value as bigint | number | string);
        if (quantity < -(2n ** 63n) || quantity > 2n ** 63n - 1n) throw new Error("outside SQLite integer range");
        return quantity;
      } catch (error) {
        errors.push(`${label} must be an integer quantity${error instanceof Error ? `: ${error.message}` : ""}`);
        return 0n;
      }
    };
    const parseScale = (value: unknown, label: string): number => {
      try {
        return assetScaleValue(value, label);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        return 0;
      }
    };
    const existingSource = (sourceId: string): boolean => Boolean(this.db.prepare("SELECT id FROM sources WHERE id = ?").get(sourceId));
    const assetMap = new Map<string, string>();
    const accountMap = new Map<string, string>();
    const sourceMap = new Map<string, string>();
    const txMap = new Map<string, string>();
    const mappedAsset = (ref: unknown, label: string): string => {
      const value = String(ref ?? "");
      const mapped = assetMap.get(value);
      if (mapped) return mapped;
      if (this.getAsset(value)) return value;
      errors.push(`${label} references unknown asset ${value}`);
      return "";
    };
    const mappedAccount = (ref: unknown, label: string): string => {
      const value = String(ref ?? "");
      const mapped = accountMap.get(value);
      if (mapped) return mapped;
      if (this.getAccount(value)) return value;
      errors.push(`${label} references unknown account ${value}`);
      return "";
    };
    const mappedSource = (ref: unknown, label: string): string | null => {
      if (ref == null || ref === "") return null;
      const value = String(ref);
      const mapped = sourceMap.get(value);
      if (mapped) return mapped;
      if (existingSource(value)) return value;
      errors.push(`${label} references unknown source ${value}`);
      return null;
    };
    const mappedTx = (ref: unknown, label: string): string => {
      const value = String(ref ?? "");
      const mapped = txMap.get(value);
      if (mapped) return mapped;
      if (this.getTx(value)) return value;
      errors.push(`${label} references unknown transaction ${value}`);
      return "";
    };
    const tagValue = (tag: any): string => String(tag?.value ?? tag?.val ?? "");
    const mappedTxTagValue = (key: string, value: string): string => {
      if (key === "import_batch") return sourceMap.get(value) ?? value;
      if (key === "recategorize_from" || key === "recategorize_to") return accountMap.get(value) ?? value;
      return value;
    };

    assets.forEach((asset, index) => {
      const assetId = requireId("assets", asset, index);
      if (!assetId) return;
      trackId("assets", assetId, index);
      const symbol = String(asset.symbol ?? "").trim().toUpperCase();
      if (!symbol) errors.push(`assets[${index}].symbol is required`);
      try {
        assetType(String(asset.type ?? asset.asset_type));
      } catch (error) {
        errors.push(`assets[${index}].type is invalid: ${error instanceof Error ? error.message : String(error)}`);
      }
      parseScale(asset.scale ?? asset.decimals ?? 2, `assets[${index}].scale`);
      if (preserveIds && this.getAsset(assetId)) errors.push(`assets[${index}].id already exists: ${assetId}`);
      assetMap.set(assetId, preserveIds ? assetId : (symbol ? this.getAssetBySymbol(symbol)?.id ?? id("asset") : id("asset")));
    });

    accounts.forEach((account) => {
      if (typeof account?.id === "string" && account.id.trim() !== "" && !accountMap.has(account.id)) {
        accountMap.set(account.id, preserveIds ? account.id : id("acct"));
      }
    });
    accounts.forEach((account, index) => {
      const accountId = requireId("accounts", account, index);
      if (!accountId) return;
      trackId("accounts", accountId, index);
      if (!accountMap.has(accountId)) accountMap.set(accountId, preserveIds ? accountId : id("acct"));
      const accountName = String(account.name ?? "").trim();
      if (!accountName) errors.push(`accounts[${index}].name is required`);
      try {
        accountType(String(account.type ?? account.account_type));
      } catch (error) {
        errors.push(`accounts[${index}].type is invalid: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (account.parent_id && !accountMap.has(String(account.parent_id)) && !this.getAccount(String(account.parent_id))) {
        errors.push(`accounts[${index}].parent_id references unknown account ${String(account.parent_id)}`);
      }
      if (preserveIds && this.getAccount(accountId)) errors.push(`accounts[${index}].id already exists: ${accountId}`);
    });
    const accountNames = new Map<string, number>();
    accounts.forEach((account, index) => {
      const name = String(account.name ?? "").trim();
      if (!name) return;
      const key = name.toLowerCase();
      if (accountNames.has(key)) errors.push(`accounts[${index}].name duplicates accounts[${accountNames.get(key)}].name: ${name}`);
      else accountNames.set(key, index);
      const existing = this.db.prepare("SELECT id FROM accounts WHERE book_id = ? AND lower(name) = lower(?) LIMIT 1").get(DEFAULT_BOOK_ID, name) as Row | undefined;
      const mappedId = typeof account.id === "string" ? accountMap.get(account.id) : null;
      if (existing && String(existing.id) !== mappedId) errors.push(`accounts[${index}].name already exists: ${name}`);
    });
    const importedParents = new Map<string, string | null>();
    accounts.forEach((account) => {
      if (typeof account?.id !== "string" || account.id.trim() === "") return;
      const mappedId = accountMap.get(account.id);
      if (!mappedId) return;
      const parent = account.parent_id ? accountMap.get(String(account.parent_id)) ?? String(account.parent_id) : null;
      importedParents.set(mappedId, parent);
    });
    for (const accountId of importedParents.keys()) {
      const seen = new Set<string>([accountId]);
      let current = importedParents.get(accountId) ?? null;
      while (current) {
        if (seen.has(current)) {
          errors.push(`accounts parent hierarchy contains a cycle at ${accountId}`);
          break;
        }
        seen.add(current);
        current = importedParents.has(current) ? importedParents.get(current)! : this.getAccount(current)?.parent_id ?? null;
      }
    }

    const accountDefaultAssets = new Map<string, string>();
    const noteAccountDefaultAsset = (accountRef: unknown, assetRef: unknown, label: string): void => {
      const accountId = mappedAccount(accountRef, `${label}.account_id`);
      const assetId = mappedAsset(assetRef, `${label}.default_asset`);
      if (accountId && assetId) accountDefaultAssets.set(accountId, assetId);
    };
    accounts.forEach((account, index) => {
      const assetRef = account.default_asset_id ?? account.asset_id;
      if (assetRef != null && assetRef !== "") noteAccountDefaultAsset(account.id, assetRef, `accounts[${index}]`);
    });
    accountTags.forEach((tag, index) => {
      const key = String(tag?.key ?? "");
      const value = tagValue(tag);
      if (!key) errors.push(`account_tags[${index}].key is required`);
      mappedAccount(tag?.entity_id, `account_tags[${index}].entity_id`);
      if (preserveIds && typeof tag?.id === "string" && tag.id.trim() !== "") trackId("annotations", tag.id, index);
      if (key === "default_asset") noteAccountDefaultAsset(tag.entity_id, value, `account_tags[${index}]`);
    });
    const defaultAssetForAccount = (accountRef: unknown, label: string): string | null => {
      const accountId = mappedAccount(accountRef, `${label}.account_id`);
      if (!accountId) return null;
      const tagged = accountDefaultAssets.get(accountId);
      if (tagged) return tagged;
      const existing = this.listAnnotations("account", accountId).filter((tag) => tag.key === "default_asset").at(-1)?.value ?? null;
      return existing && this.getAsset(existing) ? existing : null;
    };
    const requiredAccountDefaultAsset = (accountRef: unknown, label: string): string | null => {
      const assetId = defaultAssetForAccount(accountRef, label);
      if (!assetId) errors.push(`${label}.asset_id is required because the referenced account has no default_asset`);
      return assetId;
    };
    const scheduledDefaultAsset = (scheduled: any, label: string): string | null => {
      const fromAsset = defaultAssetForAccount(scheduled.from_account_id, `${label}.from_account`);
      const toAsset = defaultAssetForAccount(scheduled.to_account_id, `${label}.to_account`);
      if (!fromAsset || !toAsset) {
        errors.push(`${label}.asset_id is required unless both accounts have default_asset set`);
        return null;
      }
      if (fromAsset !== toAsset) {
        errors.push(`${label}.asset_id is required for accounts with different default_asset values`);
        return null;
      }
      return fromAsset;
    };

    sources.forEach((source, index) => {
      const sourceId = requireId("sources", source, index);
      if (!sourceId) return;
      trackId("sources", sourceId, index);
      if (!String(source.type ?? "").trim()) errors.push(`sources[${index}].type is required`);
      if (source.metadata_json != null) {
        try {
          JSON.parse(String(source.metadata_json));
        } catch {
          errors.push(`sources[${index}].metadata_json must be valid JSON`);
        }
      }
      if (preserveIds && existingSource(sourceId)) errors.push(`sources[${index}].id already exists: ${sourceId}`);
      sourceMap.set(sourceId, preserveIds ? sourceId : id(source.type === "import" ? "batch" : "source"));
    });

    transactions.forEach((tx, index) => {
      const txId = requireId("transactions", tx, index);
      if (!txId) return;
      trackId("transactions", txId, index);
      txMap.set(txId, preserveIds ? txId : id("tx"));
      if (preserveIds && this.getTx(txId)) errors.push(`transactions[${index}].id already exists: ${txId}`);
      try {
        this.assertPeriodOpen(dateOnly(String(tx.date)));
      } catch (error) {
        errors.push(`transactions[${index}].date is invalid: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        txStatus(String(tx.status));
      } catch (error) {
        errors.push(`transactions[${index}].status is invalid: ${error instanceof Error ? error.message : String(error)}`);
      }
      mappedSource(tx.source_id, `transactions[${index}].source_id`);
      if (!Array.isArray(tx.entries)) {
        errors.push(`transactions[${index}].entries must be an array`);
        return;
      }
      const lines = tx.entries.map((entry: any, entryIndex: number) => [
          mappedAccount(entry.account_id, `transactions[${index}].entries[${entryIndex}].account_id`),
          mappedAsset(entry.asset_id, `transactions[${index}].entries[${entryIndex}].asset_id`),
          parseQuantity(entry.quantity ?? entry.qty_cents ?? 0, `transactions[${index}].entries[${entryIndex}].quantity`)
        ] as [string, string, bigint]);
      tx.entries.forEach((entry: any, entryIndex: number) => {
        if (!preserveIds) return;
        if (typeof entry.id !== "string" || entry.id.trim() === "") errors.push(`transactions[${index}].entries[${entryIndex}].id is required`);
        else trackId("journal_lines", entry.id, entryIndex);
      });
      try {
        validateLines(lines);
      } catch (error) {
        errors.push(`transactions[${index}].entries are invalid: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    prices.forEach((price, index) => {
      const priceId = requireId("prices", price, index);
      if (priceId) trackId("prices", priceId, index);
      mappedAsset(price.asset_id, `prices[${index}].asset_id`);
      mappedAsset(price.quote_asset_id ?? price.quote_id, `prices[${index}].quote_asset_id`);
      const rate = parseQuantity(price.rate_value ?? price.rate_cents ?? 0, `prices[${index}].rate_value`);
      if (rate <= 0n) errors.push(`prices[${index}].rate_value must be positive`);
      parseScale(price.rate_scale ?? 2, `prices[${index}].rate_scale`);
      if (!String(price.time ?? "").trim()) errors.push(`prices[${index}].time is required`);
    });

    const budgetKeys = new Map<string, number>();
    budgets.forEach((budget, index) => {
      const budgetId = requireId("budgets", budget, index);
      if (budgetId) trackId("budgets", budgetId, index);
      const accountId = mappedAccount(budget.account_id, `budgets[${index}].account_id`);
      const assetId = budget.asset_id ? mappedAsset(budget.asset_id, `budgets[${index}].asset_id`) : requiredAccountDefaultAsset(budget.account_id, `budgets[${index}]`);
      const quantity = parseQuantity(budget.quantity ?? budget.amount_cents ?? 0, `budgets[${index}].quantity`);
      if (quantity < 0n) errors.push(`budgets[${index}].quantity cannot be negative`);
      let period = String(budget.period ?? "monthly");
      try {
        period = targetPeriod(period);
      } catch (error) {
        errors.push(`budgets[${index}].period is invalid: ${error instanceof Error ? error.message : String(error)}`);
      }
      let year: number | null = null;
      let month: number | null = null;
      try {
        year = yearValue(budget.year == null ? null : Number(budget.year));
      } catch (error) {
        errors.push(`budgets[${index}].year is invalid: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        month = monthValue(budget.month == null ? null : Number(budget.month));
      } catch (error) {
        errors.push(`budgets[${index}].month is invalid: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (accountId && assetId) {
        const key = `${accountId}|${assetId}|${period}|${year ?? ""}|${month ?? ""}`;
        if (budgetKeys.has(key)) errors.push(`budgets[${index}] duplicates budgets[${budgetKeys.get(key)}]`);
        else budgetKeys.set(key, index);
        const existing = this.db.prepare("SELECT id FROM targets WHERE book_id = ? AND type = 'budget' AND account_id = ? AND asset_id = ? AND period = ? AND year IS ? AND month IS ? LIMIT 1")
          .get(DEFAULT_BOOK_ID, accountId, assetId, period, year, month) as Row | undefined;
        if (existing) errors.push(`budgets[${index}] conflicts with existing budget ${String(existing.id)}`);
      }
    });

    const goalKeys = new Map<string, number>();
    goals.forEach((goal, index) => {
      const goalId = requireId("goals", goal, index);
      if (goalId) trackId("goals", goalId, index);
      const accountId = mappedAccount(goal.account_id, `goals[${index}].account_id`);
      const assetId = goal.asset_id ? mappedAsset(goal.asset_id, `goals[${index}].asset_id`) : requiredAccountDefaultAsset(goal.account_id, `goals[${index}]`);
      const quantity = parseQuantity(goal.quantity ?? goal.target_quantity ?? goal.target_cents ?? 0, `goals[${index}].quantity`);
      if (quantity <= 0n) errors.push(`goals[${index}].quantity must be positive`);
      if (goal.target_date != null) {
        try {
          dateOnly(String(goal.target_date));
        } catch (error) {
          errors.push(`goals[${index}].target_date is invalid: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (accountId && assetId) {
        const key = `${accountId}|${assetId}`;
        if (goalKeys.has(key)) errors.push(`goals[${index}] duplicates goals[${goalKeys.get(key)}]`);
        else goalKeys.set(key, index);
        const existing = this.db.prepare("SELECT id FROM targets WHERE book_id = ? AND type = 'goal' AND account_id = ? AND asset_id = ? LIMIT 1")
          .get(DEFAULT_BOOK_ID, accountId, assetId) as Row | undefined;
        if (existing) errors.push(`goals[${index}] conflicts with existing goal ${String(existing.id)}`);
      }
    });

    const branchNames = new Set<string>();
    branches.forEach((branch, index) => {
      const name = String(branch.name ?? "").trim();
      if (!name) errors.push(`branches[${index}].name is required`);
      const key = name.toLowerCase();
      if (branchNames.has(key)) errors.push(`branches[${index}].name duplicates another branch: ${name}`);
      branchNames.add(key);
      if (name && this.db.prepare("SELECT id FROM books WHERE lower(name) = lower(?) LIMIT 1").get(name)) {
        errors.push(`branches[${index}].name already exists: ${name}`);
      }
    });

    checkpoints.forEach((checkpoint, index) => {
      const checkpointId = requireId("checkpoints", checkpoint, index);
      if (checkpointId) trackId("checkpoints", checkpointId, index);
      try {
        dateOnly(String(checkpoint.as_of));
      } catch (error) {
        errors.push(`checkpoints[${index}].as_of is invalid: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    lots.forEach((lot, index) => {
      const lotId = requireId("lots", lot, index);
      if (lotId) trackId("lots", lotId, index);
      mappedAccount(lot.account_id, `lots[${index}].account_id`);
      mappedAsset(lot.asset_id, `lots[${index}].asset_id`);
      mappedAsset(lot.cost_asset_id, `lots[${index}].cost_asset_id`);
      const quantity = parseQuantity(lot.quantity ?? 0, `lots[${index}].quantity`);
      if (quantity <= 0n) errors.push(`lots[${index}].quantity must be positive`);
      const costQuantity = parseQuantity(lot.cost_quantity ?? 0, `lots[${index}].cost_quantity`);
      if (costQuantity <= 0n) errors.push(`lots[${index}].cost_quantity must be positive`);
      mappedTx(lot.opened_journal_id, `lots[${index}].opened_journal_id`);
      if (lot.closed_journal_id != null && lot.closed_journal_id !== "") mappedTx(lot.closed_journal_id, `lots[${index}].closed_journal_id`);
      if (!["open", "closed"].includes(String(lot.status ?? "open"))) errors.push(`lots[${index}].status is invalid`);
      try {
        dateOnly(String(lot.opened_at));
      } catch (error) {
        errors.push(`lots[${index}].opened_at is invalid: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (lot.closed_at != null) {
        try {
          dateOnly(String(lot.closed_at));
        } catch (error) {
          errors.push(`lots[${index}].closed_at is invalid: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });

    scheduledTransactions.forEach((scheduled, index) => {
      const scheduledId = requireId("scheduled_transactions", scheduled, index);
      if (scheduledId) trackId("scheduled_transactions", scheduledId, index);
      mappedAccount(scheduled.from_account_id, `scheduled_transactions[${index}].from_account_id`);
      mappedAccount(scheduled.to_account_id, `scheduled_transactions[${index}].to_account_id`);
      if (scheduled.asset_id) mappedAsset(scheduled.asset_id, `scheduled_transactions[${index}].asset_id`);
      else scheduledDefaultAsset(scheduled, `scheduled_transactions[${index}]`);
      const quantity = parseQuantity(scheduled.quantity ?? scheduled.amount_cents ?? 0, `scheduled_transactions[${index}].quantity`);
      if (quantity <= 0n) errors.push(`scheduled_transactions[${index}].quantity must be positive`);
      try {
        dateOnly(String(scheduled.next_date));
      } catch (error) {
        errors.push(`scheduled_transactions[${index}].next_date is invalid: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (scheduled.end_date != null) {
        try {
          dateOnly(String(scheduled.end_date));
        } catch (error) {
          errors.push(`scheduled_transactions[${index}].end_date is invalid: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (!["daily", "weekly", "monthly", "yearly"].includes(String(scheduled.frequency))) errors.push(`scheduled_transactions[${index}].frequency is invalid`);
      if (!["active", "paused", "deleted"].includes(String(scheduled.status ?? "active"))) errors.push(`scheduled_transactions[${index}].status is invalid`);
    });

    if (errors.length) {
      const failure = { ...result, valid: false, imported: false, errors };
      if (dryRun) return failure;
      throw new Error(`Ledger import validation failed:\n${errors.join("\n")}`);
    }
    if (dryRun) return result;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const asset of assets) {
        if (!preserveIds && this.getAsset(assetMap.get(asset.id)!)) {
          result.skipped += 1;
          continue;
        }
        this.db.prepare("INSERT INTO assets(id, symbol, type, scale, name) VALUES (?, ?, ?, ?, ?)").run(
          assetMap.get(asset.id)!,
          asset.symbol,
          asset.type ?? asset.asset_type,
          Number(asset.scale ?? asset.decimals ?? 2),
          asset.name ?? ""
        );
        result.inserted.assets += 1;
      }
      for (const account of accounts) {
        this.db.prepare("INSERT INTO accounts(id, book_id, name, type, parent_id, code, color_hex) VALUES (?, ?, ?, ?, NULL, ?, ?)").run(
          accountMap.get(account.id)!,
          DEFAULT_BOOK_ID,
          account.name,
          account.type ?? account.account_type,
          account.code ?? "",
          account.color_hex ?? "#888888"
        );
        result.inserted.accounts += 1;
      }
      for (const account of accounts) {
        if (account.parent_id) this.db.prepare("UPDATE accounts SET parent_id = ? WHERE id = ?").run(accountMap.get(account.parent_id)!, accountMap.get(account.id)!);
      }
      const insertedAccountDefaultTags = new Set<string>();
      for (const tag of accountTags) {
        const annotationId = preserveIds && typeof tag.id === "string" && tag.id.trim() !== "" ? tag.id : id("ann");
        const entityId = mappedAccount(tag.entity_id, "account_tag.entity_id");
        const key = String(tag.key ?? "");
        const rawValue = tagValue(tag);
        const value = key === "default_asset" ? mappedAsset(rawValue, "account_tag.default_asset") : rawValue;
        this.db.prepare("INSERT INTO annotations(id, book_id, entity_type, entity_id, key, value) VALUES (?, ?, 'account', ?, ?, ?)").run(
          annotationId,
          DEFAULT_BOOK_ID,
          entityId,
          key,
          value
        );
        if (key === "default_asset") insertedAccountDefaultTags.add(entityId);
        result.inserted.account_tags += 1;
      }
      for (const account of accounts) {
        const entityId = accountMap.get(account.id)!;
        const assetRef = account.default_asset_id ?? account.asset_id;
        if (assetRef == null || assetRef === "" || insertedAccountDefaultTags.has(entityId)) continue;
        this.createAnnotation("account", entityId, "default_asset", mappedAsset(assetRef, "account.default_asset"));
        result.inserted.account_tags += 1;
      }
      for (const source of sources) {
        this.db.prepare("INSERT INTO sources(id, book_id, type, label, status, created_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
          sourceMap.get(source.id)!,
          DEFAULT_BOOK_ID,
          source.type,
          source.label ?? "",
          source.status ?? "open",
          source.created_at ?? now(),
          source.metadata_json ?? "{}"
        );
        result.inserted.sources += 1;
      }
      for (const tx of transactions) {
        const txId = txMap.get(tx.id)!;
        this.db.prepare("INSERT INTO journals(id, book_id, source_id, date, posted_at, status, description, external_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
          txId,
          DEFAULT_BOOK_ID,
          mappedSource(tx.source_id, "transaction.source_id"),
          tx.date,
          tx.posted_at ?? now(),
          tx.status,
          tx.description ?? "",
          tx.external_id ?? null
        );
        (tx.entries ?? []).forEach((entry: any, index: number) => {
          this.db.prepare("INSERT INTO journal_lines(id, book_id, journal_id, line_no, account_id, asset_id, quantity) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
            preserveIds ? entry.id : id("line"),
            DEFAULT_BOOK_ID,
            txId,
            index + 1,
            mappedAccount(entry.account_id, "journal_line.account_id"),
            mappedAsset(entry.asset_id, "journal_line.asset_id"),
            BigInt(entry.quantity ?? entry.qty_cents ?? 0)
          );
        });
        for (const tag of tx.tags ?? []) {
          const key = String(tag.key ?? "");
          this.createAnnotation(tag.entity_type ?? "tx", txId, key, mappedTxTagValue(key, tagValue(tag)));
        }
        result.inserted.transactions += 1;
      }
      for (const price of prices) {
        this.db.prepare("INSERT INTO prices(id, book_id, asset_id, quote_asset_id, rate_value, rate_scale, time) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
          preserveIds ? price.id : id("price"),
          DEFAULT_BOOK_ID,
          mappedAsset(price.asset_id, "price.asset_id"),
          mappedAsset(price.quote_asset_id ?? price.quote_id, "price.quote_asset_id"),
          BigInt(price.rate_value ?? price.rate_cents ?? 0),
          Number(price.rate_scale ?? 2),
          price.time
        );
        result.inserted.prices += 1;
      }
      for (const budget of budgets) {
        const budgetAssetId = budget.asset_id ? mappedAsset(budget.asset_id, "budget.asset_id") : requiredAccountDefaultAsset(budget.account_id, "budget");
        this.db.prepare("INSERT INTO targets(id, book_id, type, account_id, asset_id, quantity, period, year, month, rollover_rule) VALUES (?, ?, 'budget', ?, ?, ?, ?, ?, ?, ?)").run(
          preserveIds ? budget.id : id("target"),
          DEFAULT_BOOK_ID,
          mappedAccount(budget.account_id, "budget.account_id"),
          budgetAssetId,
          BigInt(budget.quantity ?? budget.amount_cents ?? 0),
          budget.period ?? "monthly",
          budget.year ?? null,
          budget.month ?? null,
          budget.rollover_rule ?? ""
        );
        result.inserted.budgets += 1;
      }
      for (const goal of goals) {
        const goalAssetId = goal.asset_id ? mappedAsset(goal.asset_id, "goal.asset_id") : requiredAccountDefaultAsset(goal.account_id, "goal");
        this.db.prepare("INSERT INTO targets(id, book_id, type, account_id, asset_id, quantity, name, target_date, priority) VALUES (?, ?, 'goal', ?, ?, ?, ?, ?, ?)").run(
          preserveIds && goal.id ? goal.id : id("target"),
          DEFAULT_BOOK_ID,
          mappedAccount(goal.account_id, "goal.account_id"),
          goalAssetId,
          BigInt(goal.quantity ?? goal.target_quantity ?? goal.target_cents ?? 0),
          goal.name,
          goal.target_date ?? null,
          Number(goal.priority ?? 1)
        );
        result.inserted.goals += 1;
      }
      for (const branch of branches) {
        this.db.prepare("INSERT INTO books(id, name, type, parent_id, created_at, closed_at) VALUES (?, ?, 'scenario', ?, ?, ?)").run(
          branch.name,
          branch.name,
          DEFAULT_BOOK_ID,
          branch.created_at ?? now(),
          branch.discarded_at ?? branch.closed_at ?? null
        );
        result.inserted.branches += 1;
      }
      for (const checkpoint of checkpoints) {
        this.db.prepare("INSERT INTO period_closes(id, book_id, name, as_of, description, created_at, reopened_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
          preserveIds ? checkpoint.id : id("period"),
          DEFAULT_BOOK_ID,
          checkpoint.name,
          checkpoint.as_of,
          checkpoint.description ?? null,
          checkpoint.created_at ?? now(),
          checkpoint.reopened_at ?? null
        );
        result.inserted.checkpoints += 1;
      }
      for (const lot of lots) {
        this.db.prepare("INSERT INTO lots(id, book_id, account_id, asset_id, quantity, cost_asset_id, cost_quantity, opened_journal_id, closed_journal_id, opened_at, closed_at, status, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
          preserveIds ? lot.id : id("lot"),
          DEFAULT_BOOK_ID,
          mappedAccount(lot.account_id, "lot.account_id"),
          mappedAsset(lot.asset_id, "lot.asset_id"),
          BigInt(lot.quantity ?? 0),
          mappedAsset(lot.cost_asset_id, "lot.cost_asset_id"),
          BigInt(lot.cost_quantity ?? 0),
          mappedTx(lot.opened_journal_id, "lot.opened_journal_id"),
          lot.closed_journal_id == null || lot.closed_journal_id === "" ? null : mappedTx(lot.closed_journal_id, "lot.closed_journal_id"),
          lot.opened_at,
          lot.closed_at ?? null,
          lot.status ?? "open",
          lot.metadata_json ?? "{}"
        );
        result.inserted.lots += 1;
      }
      for (const scheduled of scheduledTransactions) {
        const scheduledAssetId = scheduled.asset_id ? mappedAsset(scheduled.asset_id, "scheduled_transaction.asset_id") : scheduledDefaultAsset(scheduled, "scheduled_transaction");
        this.db.prepare("INSERT INTO recurrences(id, book_id, next_date, quantity, from_account_id, to_account_id, description, frequency, end_date, asset_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
          preserveIds ? scheduled.id : id("sched"),
          DEFAULT_BOOK_ID,
          scheduled.next_date,
          BigInt(scheduled.quantity ?? scheduled.amount_cents ?? 0),
          mappedAccount(scheduled.from_account_id, "scheduled_transaction.from_account_id"),
          mappedAccount(scheduled.to_account_id, "scheduled_transaction.to_account_id"),
          scheduled.description ?? "",
          scheduled.frequency,
          scheduled.end_date ?? null,
          scheduledAssetId,
          scheduled.status ?? "active"
        );
        result.inserted.scheduled_transactions += 1;
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
