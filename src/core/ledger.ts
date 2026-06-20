import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { annotateAmounts, debitCredit, normalAmount, normalSide } from "./accounting.js";
import { exportTransactionsCsv as exportTransactionsCsvDocument } from "./ledger-export.js";
import { exportDocument as exportDocumentFromStore, importDocument as importDocumentFromStore } from "./ledger-document.js";
import { integrityCheck as integrityCheckInStore } from "./ledger-integrity.js";
import {
  createScenarioBook as createScenarioBookInStore,
  discardScenarioBook as discardScenarioBookInStore,
  getScenarioBook as getScenarioBookInStore,
  listScenarioBooks as listScenarioBooksInStore
} from "./ledger-scenarios.js";
import {
  getLedgerOperationRow,
  insertLedgerOperation,
  jsonText,
  listLedgerOperationRows as auditOperationRows,
  listLedgerOperationRowsByBook,
  markLedgerOperationReversedRow,
  reverseAuditRows
} from "./operation-audit.js";
import {
  accountType,
  assetScaleValue,
  assetType,
  dateOnly,
  id,
  type BudgetTargetOptions,
  type LedgerOptions,
  monthBounds,
  monthValue,
  now,
  type PostTxOptions,
  positiveQuantity,
  recurrenceFrequency,
  type Row,
  targetPeriod,
  toAccount,
  toAsset,
  toJournal,
  toLine,
  toPrice,
  txStatus,
  validateLines,
  yearValue
} from "./ledger-codec.js";
import { LedgerStore } from "./ledger-store.js";
import type { Account, AccountBalance, AccountType, Asset, AssetType, Journal, JournalLine, Price, TxStatus } from "./types.js";
import { decimalToScaled, fromAtomicUnits, gcd, reduceRatio, roundRatio, toAtomicUnits } from "./money.js";

export class Ledger {
  readonly path: string;
  readonly bookId: string;
  private readonly store: LedgerStore;

  constructor(path: string, options: LedgerOptions = {}) {
    this.store = new LedgerStore(path, options);
    this.path = this.store.path;
    this.bookId = this.store.bookId;
  }

  private get db() {
    return this.store.db;
  }

  close(): void {
    this.store.close();
  }

  initialize(): void {
    this.store.initialize();
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
    ).run(accountId, this.bookId, name, normalized, parentId || null, code, colorHex);
    return accountId;
  }

  findAccount(ref: string): Account | null {
    return this.getAccount(ref) ??
      toAccount(this.db.prepare("SELECT * FROM accounts WHERE book_id = ? AND lower(name) = lower(?) ORDER BY id LIMIT 1").get(this.bookId, ref) as Row | undefined);
  }

  getAccount(accountId: string): Account | null {
    return toAccount(this.db.prepare("SELECT * FROM accounts WHERE book_id = ? AND id = ?").get(this.bookId, accountId) as Row | undefined);
  }

  listAccounts(): Account[] {
    return (this.db.prepare("SELECT * FROM accounts WHERE book_id = ? ORDER BY name, id").all(this.bookId) as Row[]).map((row) => toAccount(row)!);
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
    default_asset_id?: string | null;
    code?: string | null;
    color_hex?: string | null;
  }): Account {
    const existingAccount = this.getAccount(accountId);
    if (!existingAccount) throw new Error(`Account ${accountId} not found`);
    if (values.name != null) this.db.prepare("UPDATE accounts SET name = ? WHERE book_id = ? AND id = ?").run(values.name, this.bookId, accountId);
    if (values.type != null) {
      const nextType = accountType(String(values.type));
      if (nextType !== existingAccount.account_type) this.assertAccountNotLinkedToLots(accountId);
      this.db.prepare("UPDATE accounts SET type = ? WHERE book_id = ? AND id = ?").run(nextType, this.bookId, accountId);
    }
    if (values.parent_id !== undefined) {
      if (values.parent_id && !this.getAccount(values.parent_id)) throw new Error(`Parent account ${values.parent_id} not found`);
      this.assertValidAccountParent(accountId, values.parent_id || null);
      this.db.prepare("UPDATE accounts SET parent_id = ? WHERE book_id = ? AND id = ?").run(values.parent_id || null, this.bookId, accountId);
    }
    if (values.code != null) this.db.prepare("UPDATE accounts SET code = ? WHERE book_id = ? AND id = ?").run(values.code, this.bookId, accountId);
    if (values.color_hex != null) this.db.prepare("UPDATE accounts SET color_hex = ? WHERE book_id = ? AND id = ?").run(values.color_hex, this.bookId, accountId);
    if (values.default_asset_id !== undefined) {
      if (values.default_asset_id && !this.getAsset(values.default_asset_id)) throw new Error(`Asset ${values.default_asset_id} not found`);
      this.db.prepare("UPDATE accounts SET default_asset_id = ? WHERE book_id = ? AND id = ?").run(values.default_asset_id || null, this.bookId, accountId);
    }
    return this.getAccount(accountId)!;
  }

  deleteAccount(accountId: string): void {
    if (!this.getAccount(accountId)) throw new Error(`Account ${accountId} not found`);
    const children = (this.db.prepare("SELECT count(*) AS c FROM accounts WHERE book_id = ? AND parent_id = ?").get(this.bookId, accountId) as Row).c as bigint;
    if (children > 0n) throw new Error("Account has child accounts");
    const entries = (this.db.prepare("SELECT count(*) AS c FROM journal_lines WHERE book_id = ? AND account_id = ?").get(this.bookId, accountId) as Row).c as bigint;
    if (entries > 0n) throw new Error("Account has entries");
    this.transaction(() => {
      this.db.prepare("DELETE FROM accounts WHERE book_id = ? AND id = ?").run(this.bookId, accountId);
      this.db.prepare("DELETE FROM annotations WHERE book_id = ? AND entity_type = 'account' AND entity_id = ?").run(this.bookId, accountId);
    });
  }

  createAnnotation(entityType: string, entityId: string, key: string, value: string): string {
    const annotationId = id("ann");
    this.db.prepare("INSERT INTO annotations(id, book_id, entity_type, entity_id, key, value) VALUES (?, ?, ?, ?, ?, ?)").run(
      annotationId,
      this.bookId,
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
    ).all(this.bookId, entityType, entityId) as Row[]).map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, String(v)])));
  }

  deleteAnnotation(annotationId: string): void {
    this.db.prepare("DELETE FROM annotations WHERE book_id = ? AND id = ?").run(this.bookId, annotationId);
  }

  listAnnotationEntityIds(entityType: string, key: string, value: string): string[] {
    return (this.db.prepare("SELECT entity_id FROM annotations WHERE book_id = ? AND entity_type = ? AND key = ? AND value = ? ORDER BY entity_id").all(this.bookId, entityType, key, value) as Row[])
      .map((row) => String(row.entity_id));
  }

  listAnnotationValues(entityType: string, key: string): Row[] {
    return this.db.prepare(`
      SELECT a.value,
             count(DISTINCT a.entity_id) AS count,
             min(j.posted_at) AS first_seen_at,
             max(j.posted_at) AS last_seen_at
        FROM annotations a
        LEFT JOIN journals j
          ON j.book_id = a.book_id
         AND a.entity_type = 'tx'
         AND j.id = a.entity_id
       WHERE a.book_id = ?
         AND a.entity_type = ?
         AND a.key = ?
       GROUP BY a.value
       ORDER BY max(j.posted_at) DESC, a.value
    `).all(this.bookId, entityType, key) as Row[];
  }

  createSource(type: string, label?: string | null, metadata: Row = {}, status = "open"): string {
    const sourceId = id(type === "import" ? "batch" : "source");
    this.db.prepare("INSERT INTO sources(id, book_id, type, label, status, created_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      sourceId,
      this.bookId,
      type,
      label ?? "",
      status,
      now(),
      jsonText(metadata)
    );
    return sourceId;
  }

  listSources(type?: string | null, limit: number | null = 20): Row[] {
    let sql = "SELECT * FROM sources WHERE book_id = ?";
    const params: SQLInputValue[] = [this.bookId];
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
    return Number(this.db.prepare("UPDATE sources SET status = ? WHERE book_id = ? AND id = ?").run(status, this.bookId, sourceId).changes);
  }

  updateTransactionSource(txId: string, sourceId: string | null): number {
    if (sourceId != null && !this.db.prepare("SELECT id FROM sources WHERE book_id = ? AND id = ?").get(this.bookId, sourceId)) throw new Error(`Source ${sourceId} not found`);
    return Number(this.db.prepare("UPDATE journals SET source_id = ? WHERE book_id = ? AND id = ?").run(sourceId, this.bookId, txId).changes);
  }

  listTransactionIdsForSource(sourceId: string): string[] {
    const ids = new Set<string>();
    for (const row of this.db.prepare("SELECT id FROM journals WHERE book_id = ? AND source_id = ? AND finalized_at IS NOT NULL ORDER BY date, id").all(this.bookId, sourceId) as Row[]) {
      ids.add(String(row.id));
    }
    for (const txId of this.listAnnotationEntityIds("tx", "import_batch", sourceId)) ids.add(txId);
    return [...ids].sort();
  }

  createStatementPlan(input: Row, rows: Row[]): Row {
    return this.transaction(() => {
      const planId = String(input.id ?? id("stmtplan"));
      const createdAt = String(input.created_at ?? now());
      this.db.prepare(`
        INSERT INTO statement_plans(
          id, book_id, account_id, asset_id, source_id, status, statement_kind, file_name, file_sha256,
          expected_balance, planned_balance, applied_balance, created_at, applied_at, discarded_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        planId,
        this.bookId,
        String(input.account_id),
        String(input.asset_id),
        input.source_id == null ? null : String(input.source_id),
        String(input.status ?? "planned"),
        String(input.statement_kind ?? ""),
        String(input.file_name ?? ""),
        String(input.file_sha256 ?? ""),
        input.expected_balance == null ? null : BigInt(input.expected_balance as string | number | bigint | boolean),
        BigInt(input.planned_balance as string | number | bigint | boolean),
        input.applied_balance == null ? null : BigInt(input.applied_balance as string | number | bigint | boolean),
        createdAt,
        input.applied_at == null ? null : String(input.applied_at),
        input.discarded_at == null ? null : String(input.discarded_at),
        jsonText(input.metadata ?? input.metadata_json ?? {})
      );
      for (const row of rows) {
        this.db.prepare(`
          INSERT INTO statement_plan_rows(
            id, book_id, plan_id, row_index, date, quantity, description, external_id, row_hash, action,
            matched_journal_id, created_journal_id, counterpart_account_id, reason, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          String(row.id ?? id("stmtrow")),
          this.bookId,
          planId,
          Number(row.row_index),
          dateOnly(String(row.date)),
          BigInt(row.quantity as string | number | bigint | boolean),
          String(row.description ?? ""),
          row.external_id == null || row.external_id === "" ? null : String(row.external_id),
          String(row.row_hash),
          String(row.action),
          row.matched_journal_id == null ? null : String(row.matched_journal_id),
          row.created_journal_id == null ? null : String(row.created_journal_id),
          row.counterpart_account_id == null ? null : String(row.counterpart_account_id),
          String(row.reason ?? ""),
          jsonText(row.metadata ?? row.metadata_json ?? {})
        );
      }
      return this.getStatementPlan(planId)!;
    });
  }

  getStatementPlan(planId: string): Row | null {
    return (this.db.prepare("SELECT * FROM statement_plans WHERE book_id = ? AND id = ?").get(this.bookId, planId) as Row | undefined) ?? null;
  }

  listStatementPlanRows(planId: string): Row[] {
    return this.db.prepare("SELECT * FROM statement_plan_rows WHERE book_id = ? AND plan_id = ? ORDER BY row_index, id").all(this.bookId, planId) as Row[];
  }

  markStatementPlanApplied(planId: string, sourceId: string | null, appliedBalance: bigint | number): Row {
    this.db.prepare("UPDATE statement_plans SET status = 'applied', source_id = ?, applied_balance = ?, applied_at = ? WHERE book_id = ? AND id = ?").run(
      sourceId,
      BigInt(appliedBalance),
      now(),
      this.bookId,
      planId
    );
    return this.getStatementPlan(planId)!;
  }

  discardStatementPlan(planId: string): Row {
    this.db.prepare("UPDATE statement_plans SET status = 'discarded', discarded_at = ? WHERE book_id = ? AND id = ?").run(now(), this.bookId, planId);
    return this.getStatementPlan(planId)!;
  }

  setStatementPlanRowCreatedJournal(rowId: string, journalId: string): void {
    this.db.prepare("UPDATE statement_plan_rows SET created_journal_id = ? WHERE book_id = ? AND id = ?").run(journalId, this.bookId, rowId);
  }

  createLedgerOperation(input: Row, rows: Row[]): Row {
    return this.transaction(() => {
      const operationId = insertLedgerOperation(this.db, this.bookId, input, rows);
      return this.getLedgerOperation(operationId)!;
    });
  }

  getLedgerOperation(operationId: string): Row | null {
    return getLedgerOperationRow(this.db, this.bookId, operationId);
  }

  listLedgerOperations(limit: number | null = 50): Row[] {
    return listLedgerOperationRowsByBook(this.db, this.bookId, limit);
  }

  listLedgerOperationRows(operationId: string): Row[] {
    return auditOperationRows(this.db, this.bookId, operationId);
  }

  markLedgerOperationReversed(operationId: string, reversedByOperationId: string): Row {
    return markLedgerOperationReversedRow(this.db, this.bookId, operationId, reversedByOperationId);
  }

  runInTransaction<T>(fn: () => T): T {
    return this.transaction(fn);
  }

  private transaction<T>(fn: () => T): T {
    return this.store.transaction(fn);
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

  reverseRows(rows: Array<{ table: string; action: string; before?: Row | null; after?: Row | null }>): Row[] {
    return this.transaction(() => reverseAuditRows(this.db, rows));
  }

  countTransactions(): number {
    return Number((this.db.prepare("SELECT count(*) AS c FROM journals WHERE book_id = ? AND finalized_at IS NOT NULL").get(this.bookId) as Row).c);
  }

  countEntries(): number {
    return Number((this.db.prepare(
      "SELECT count(*) AS c FROM journal_lines l JOIN journals t ON t.book_id = l.book_id AND t.id = l.journal_id WHERE l.book_id = ? AND t.finalized_at IS NOT NULL"
    ).get(this.bookId) as Row).c);
  }

  countEntriesByAsset(assetId: string): number {
    return Number((this.db.prepare(
      "SELECT count(*) AS c FROM journal_lines l JOIN journals t ON t.book_id = l.book_id AND t.id = l.journal_id WHERE l.book_id = ? AND t.finalized_at IS NOT NULL AND t.status != 'void' AND l.asset_id = ?"
    ).get(this.bookId, assetId) as Row).c);
  }

  countEntriesByAccount(accountId: string): number {
    return Number((this.db.prepare(
      "SELECT count(*) AS c FROM journal_lines l JOIN journals t ON t.book_id = l.book_id AND t.id = l.journal_id WHERE l.book_id = ? AND t.finalized_at IS NOT NULL AND t.status != 'void' AND l.account_id = ?"
    ).get(this.bookId, accountId) as Row).c);
  }

  countTransactionsByAccount(accountId: string): number {
    return Number((this.db.prepare(
      "SELECT count(DISTINCT l.journal_id) AS c FROM journal_lines l JOIN journals t ON t.book_id = l.book_id AND t.id = l.journal_id WHERE l.book_id = ? AND t.finalized_at IS NOT NULL AND t.status != 'void' AND l.account_id = ?"
    ).get(this.bookId, accountId) as Row).c);
  }

  listEntriesByAsset(assetId: string, limit = 100, offset = 0): Row[] {
    return this.db.prepare(
      "SELECT l.* FROM journal_lines l JOIN journals t ON t.book_id = l.book_id AND t.id = l.journal_id WHERE l.book_id = ? AND t.finalized_at IS NOT NULL AND l.asset_id = ? ORDER BY l.journal_id, l.line_no LIMIT ? OFFSET ?"
    ).all(this.bookId, assetId, limit, offset) as Row[];
  }

  createRule(type: string, accountId: string, pattern: string): string {
    const existing = this.db.prepare("SELECT id FROM rules WHERE book_id = ? AND type = ? AND account_id = ? AND pattern = ? AND status = 'active'").get(this.bookId, type, accountId, pattern) as Row | undefined;
    if (existing) return String(existing.id);
    const ruleId = id("rule");
    this.db.prepare("INSERT INTO rules(id, book_id, type, account_id, pattern, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(ruleId, this.bookId, type, accountId, pattern, now());
    return ruleId;
  }

  listRules(type = "match"): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT id, account_id, pattern, priority, status FROM rules WHERE book_id = ? AND type = ? AND status = 'active' ORDER BY priority, id").all(this.bookId, type) as Row[];
  }

  deleteRule(accountId: string, pattern: string, type = "match"): number {
    const result = this.db.prepare("UPDATE rules SET status = 'deleted' WHERE book_id = ? AND type = ? AND account_id = ? AND pattern = ? AND status = 'active'").run(this.bookId, type, accountId, pattern);
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
    const params: SQLInputValue[] = [this.bookId];
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
    return this.transaction(() => {
      this.db.prepare("DELETE FROM targets WHERE book_id = ? AND type = 'budget' AND account_id = ? AND asset_id = ? AND period = ? AND year IS ? AND month IS ?").run(this.bookId, accountId, assetId, normalizedPeriod, normalizedYear, normalizedMonth);
      const targetId = id("budget");
      this.db.prepare("INSERT INTO targets(id, book_id, type, account_id, asset_id, quantity, period, year, month, rollover_rule) VALUES (?, ?, 'budget', ?, ?, ?, ?, ?, ?, ?)").run(
        targetId,
        this.bookId,
        accountId,
        assetId,
        amount,
        normalizedPeriod,
        normalizedYear,
        normalizedMonth,
        rollover ? "full" : ""
      );
      return this.db.prepare("SELECT * FROM targets WHERE book_id = ? AND id = ?").get(this.bookId, targetId) as Row;
    });
  }

  deleteBudget(accountId: string, year?: number | null, month?: number | null): number {
    let sql = "DELETE FROM targets WHERE book_id = ? AND type = 'budget' AND account_id = ?";
    const params: SQLInputValue[] = [this.bookId, accountId];
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
    return Number(this.db.prepare("DELETE FROM targets WHERE book_id = ? AND type = 'budget'").run(this.bookId).changes);
  }

  setGoal(accountId: string, assetId: string, quantity: bigint | number, name: string, targetDate?: string | null, priority = 1): Row {
    if (!this.getAccount(accountId)) throw new Error(`Account ${accountId} not found`);
    if (!this.getAsset(assetId)) throw new Error(`Asset ${assetId} not found`);
    const amount = positiveQuantity(quantity, "Goal target");
    const normalizedDate = targetDate == null || targetDate === "" ? null : dateOnly(targetDate);
    return this.transaction(() => {
      this.db.prepare("DELETE FROM targets WHERE book_id = ? AND type = 'goal' AND account_id = ? AND asset_id = ?").run(this.bookId, accountId, assetId);
      const targetId = id("goal");
      this.db.prepare("INSERT INTO targets(id, book_id, type, account_id, asset_id, quantity, name, target_date, priority) VALUES (?, ?, 'goal', ?, ?, ?, ?, ?, ?)").run(
        targetId,
        this.bookId,
        accountId,
        assetId,
        amount,
        name,
        normalizedDate,
        priority
      );
      return this.db.prepare("SELECT * FROM targets WHERE book_id = ? AND id = ?").get(this.bookId, targetId) as Row;
    });
  }

  listGoalTargets(): Row[] {
    return this.db.prepare("SELECT * FROM targets WHERE book_id = ? AND type = 'goal' ORDER BY priority, name").all(this.bookId) as Row[];
  }

  getGoalTarget(accountId: string): Row | null {
    return (this.db.prepare("SELECT * FROM targets WHERE book_id = ? AND type = 'goal' AND account_id = ? ORDER BY priority, name LIMIT 1").get(this.bookId, accountId) as Row | undefined) ?? null;
  }

  deleteGoal(accountId: string): number {
    return Number(this.db.prepare("DELETE FROM targets WHERE book_id = ? AND type = 'goal' AND account_id = ?").run(this.bookId, accountId).changes);
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
      this.bookId,
      dateOnly(date),
      amount,
      fromAccountId,
      toAccountId,
      description,
      normalizedFrequency,
      normalizedEndDate,
      assetId
    );
    return this.db.prepare("SELECT *, quantity AS amount_cents FROM recurrences WHERE book_id = ? AND id = ?").get(this.bookId, recurrenceId) as Row;
  }

  listRecurrences(): Row[] {
    return this.db.prepare("SELECT *, quantity AS amount_cents FROM recurrences WHERE book_id = ? ORDER BY next_date, id").all(this.bookId) as Row[];
  }

  updateRecurrenceNextDate(recurrenceId: string, nextDate: string): number {
    return Number(this.db.prepare("UPDATE recurrences SET next_date = ? WHERE book_id = ? AND id = ?").run(dateOnly(nextDate), this.bookId, recurrenceId).changes);
  }

  createScenarioBook(name: string): Row {
    return createScenarioBookInStore(this.store, name);
  }

  listScenarioBooks(): Row[] {
    return listScenarioBooksInStore(this.store);
  }

  getScenarioBook(name: string): Row | null {
    return getScenarioBookInStore(this.store, name);
  }

  discardScenarioBook(name: string): number {
    return discardScenarioBookInStore(this.store, name);
  }

  listLots(): Row[] {
    return this.db.prepare("SELECT * FROM lots WHERE book_id = ? ORDER BY opened_at, id").all(this.bookId) as Row[];
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
    ).run(priceId, this.bookId, assetId, quoteId, scaled.value, scaled.scale, time);
    return priceId;
  }

  listPrices(): Price[] {
    return (this.db.prepare("SELECT * FROM prices WHERE book_id = ? ORDER BY time DESC, id DESC").all(this.bookId) as Row[]).map((row) => toPrice(row)!);
  }

  queryPrice(assetId: string, quoteId: string, asOf: string): Price | null {
    return toPrice(this.db.prepare(
      "SELECT * FROM prices WHERE book_id = ? AND asset_id = ? AND quote_asset_id = ? AND time <= ? ORDER BY time DESC, id DESC LIMIT 1"
    ).get(this.bookId, assetId, quoteId, asOf) as Row | undefined);
  }

  private priceGraph(asOf: string): Map<string, Array<{ to: string; numerator: bigint; denominator: bigint }>> {
    const assets = new Map(this.listAssets().map((asset) => [asset.id, asset]));
    const graph = new Map<string, Array<{ to: string; numerator: bigint; denominator: bigint }>>();
    const seen = new Set<string>();
    const rows = this.db.prepare("SELECT * FROM prices WHERE book_id = ? AND time <= ? ORDER BY time DESC, id DESC").all(this.bookId, asOf) as Row[];
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
    ).get(this.bookId, txDate) as Row | undefined;
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
      this.bookId,
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
        this.bookId,
        txId,
        index + 1,
        accountId,
        assetId,
        quantity
      );
    });
    this.finalizeTx(txId);
    return txId;
  }

  private finalizeTx(txId: string): void {
    this.db.prepare("UPDATE journals SET finalized_at = ? WHERE book_id = ? AND id = ?").run(now(), this.bookId, txId);
  }

  private reopenTx(txId: string): void {
    this.db.prepare("UPDATE journals SET finalized_at = NULL WHERE book_id = ? AND id = ?").run(this.bookId, txId);
  }

  private assertTxNotLinkedToLots(txId: string): void {
    const row = this.db.prepare("SELECT id FROM lots WHERE book_id = ? AND (opened_journal_id = ? OR closed_journal_id = ?) LIMIT 1").get(this.bookId, txId, txId) as Row | undefined;
    if (row) throw new Error("Transaction has linked investment lots; use an investment reversal workflow");
  }

  postTx(date: string, status: TxStatus | string, description: string | null | undefined, lines: Array<[string, string, bigint | number]>, options: PostTxOptions = {}): string {
    const txDate = dateOnly(date);
    this.assertPeriodOpen(txDate);
    const statusValue = txStatus(String(status));
    const normalized = lines.map(([accountId, assetId, quantity]) => [accountId, assetId, BigInt(quantity)] as [string, string, bigint]);
    validateLines(normalized);
    this.validateLineRefs(normalized);
    return this.transaction(() => this.insertTx(txDate, statusValue, description, normalized, options));
  }

  recordTransaction(date: string, amount: bigint | number, fromAccountId: string, toAccountId: string, assetId: string, description = "", status: TxStatus | string = "pending", options: PostTxOptions = {}): Journal & { entries: JournalLine[] } {
    const quantity = positiveQuantity(amount, "Transaction amount");
    const txId = this.postTx(date, status, description, [
      [fromAccountId, assetId, -quantity],
      [toAccountId, assetId, quantity]
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
    this.db.prepare("UPDATE journals SET status = 'void' WHERE book_id = ? AND id = ?").run(this.bookId, txId);
  }

  updateTxStatus(txId: string, status: TxStatus | string): boolean {
    const tx = this.getTx(txId);
    if (!tx) throw new Error(`Transaction ${txId} not found`);
    this.assertPeriodOpen(tx.date);
    const statusValue = txStatus(String(status));
    if (statusValue === "void") this.assertTxNotLinkedToLots(txId);
    const result = this.db.prepare("UPDATE journals SET status = ? WHERE book_id = ? AND id = ?").run(statusValue, this.bookId, txId);
    return Number(result.changes) > 0;
  }

  deleteTx(txId: string): void {
    const tx = this.getTx(txId);
    if (!tx) throw new Error(`Transaction ${txId} not found`);
    this.assertPeriodOpen(tx.date);
    this.assertTxNotLinkedToLots(txId);
    this.transaction(() => {
      this.reopenTx(txId);
      this.db.prepare("DELETE FROM annotations WHERE book_id = ? AND entity_type = 'tx' AND entity_id = ?").run(this.bookId, txId);
      this.db.prepare("DELETE FROM journals WHERE book_id = ? AND id = ?").run(this.bookId, txId);
    });
  }

  getTx(txId: string): Journal | null {
    return toJournal(this.db.prepare("SELECT * FROM journals WHERE book_id = ? AND id = ?").get(this.bookId, txId) as Row | undefined);
  }

  listTransactions(options: { status?: TxStatus | string | null; dateFrom?: string | null; dateTo?: string | null; sort?: "date_asc" | "date_desc" } = {}): Journal[] {
    let sql = "SELECT * FROM journals WHERE book_id = ? AND finalized_at IS NOT NULL";
    const params: SQLInputValue[] = [this.bookId];
    if (options.status != null) {
      if (options.status === "all") sql += " AND status != 'void'";
      else if (options.status === "active") sql += " AND status IN ('posted', 'pending')";
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
    return (this.db.prepare("SELECT * FROM journal_lines WHERE book_id = ? AND journal_id = ? ORDER BY line_no, id").all(this.bookId, txId) as Row[]).map((row) => toLine(row)!);
  }

  txWithEntries(txId: string): Journal & { entries: JournalLine[] } {
    const tx = this.getTx(txId);
    if (!tx) throw new Error(`Transaction ${txId} not found`);
    return { ...tx, entries: this.getEntries(txId) };
  }

  private assertAccountNotLinkedToLots(accountId: string): void {
    const row = this.db.prepare("SELECT id FROM lots WHERE book_id = ? AND account_id = ? LIMIT 1").get(this.bookId, accountId) as Row | undefined;
    if (row) throw new Error("Account has linked investment lots; use an investment-specific workflow");
  }

  private assertAssetNotLinkedToLots(assetId: string): void {
    const row = this.db.prepare("SELECT id FROM lots WHERE book_id = ? AND (asset_id = ? OR cost_asset_id = ?) LIMIT 1").get(this.bookId, assetId, assetId) as Row | undefined;
    if (row) throw new Error("Asset has linked investment lots; use an investment-specific workflow");
  }

  recategorizeTransaction(txId: string, oldAccountId: string, newAccountId: string): Record<string, string> {
    const tx = this.getTx(txId);
    if (!tx) throw new Error(`Transaction ${txId} not found`);
    this.assertPeriodOpen(tx.date);
    this.assertTxNotLinkedToLots(txId);
    if (tx.status === "void") throw new Error("Cannot recategorize a void transaction");
    if (!this.getAccount(newAccountId)) throw new Error(`Account ${newAccountId} not found`);
    return this.transaction(() => {
      this.reopenTx(txId);
      const result = this.db.prepare("UPDATE journal_lines SET account_id = ? WHERE book_id = ? AND journal_id = ? AND account_id = ?").run(newAccountId, this.bookId, txId, oldAccountId);
      if (Number(result.changes) === 0) throw new Error(`Account ${oldAccountId} is not on transaction ${txId}`);
      this.finalizeTx(txId);
      return { tx_id: txId, from_account_id: oldAccountId, to_account_id: newAccountId };
    });
  }

  flipEntries(txIds: string[]): string[] {
    return this.transaction(() => {
      const flipped: string[] = [];
      for (const txId of txIds) {
        const tx = this.getTx(txId);
        if (!tx) throw new Error(`Transaction ${txId} not found`);
        this.assertPeriodOpen(tx.date);
        this.assertTxNotLinkedToLots(txId);
        if (tx.status === "void") continue;
        this.reopenTx(txId);
        this.db.prepare("UPDATE journal_lines SET quantity = -quantity WHERE book_id = ? AND journal_id = ?").run(this.bookId, txId);
        this.finalizeTx(txId);
        flipped.push(txId);
      }
      return flipped;
    });
  }

  moveEntriesBetweenAccounts(sourceAccountId: string, targetAccountId: string): number {
    if (!this.getAccount(sourceAccountId) || !this.getAccount(targetAccountId)) throw new Error("Account not found");
    this.assertAccountNotLinkedToLots(sourceAccountId);
    this.assertAccountNotLinkedToLots(targetAccountId);
    const rows = this.db.prepare(
      "SELECT DISTINCT t.id, t.date FROM journals t JOIN journal_lines l ON l.book_id = t.book_id AND l.journal_id = t.id WHERE t.book_id = ? AND t.finalized_at IS NOT NULL AND t.status != 'void' AND l.account_id = ?"
    ).all(this.bookId, sourceAccountId) as Row[];
    rows.forEach((row) => this.assertPeriodOpen(String(row.date)));
    if (rows.length === 0) return 0;
    const txIds = rows.map((row) => String(row.id));
    const placeholders = txIds.map(() => "?").join(", ");
    const count = (this.db.prepare(`SELECT count(*) AS c FROM journal_lines WHERE book_id = ? AND account_id = ? AND journal_id IN (${placeholders})`).get(this.bookId, sourceAccountId, ...txIds) as Row).c as bigint;
    this.transaction(() => {
      for (const row of rows) this.reopenTx(String(row.id));
      this.db.prepare(`UPDATE journal_lines SET account_id = ? WHERE book_id = ? AND account_id = ? AND journal_id IN (${placeholders})`).run(targetAccountId, this.bookId, sourceAccountId, ...txIds);
      for (const row of rows) this.finalizeTx(String(row.id));
    });
    return Number(count);
  }

  migrateAssetEntries(fromAssetId: string, toAssetId: string): number {
    if (!this.getAsset(fromAssetId) || !this.getAsset(toAssetId)) throw new Error("Asset not found");
    this.assertAssetNotLinkedToLots(fromAssetId);
    this.assertAssetNotLinkedToLots(toAssetId);
    const rows = this.db.prepare(
      "SELECT DISTINCT t.id, t.date FROM journals t JOIN journal_lines l ON l.book_id = t.book_id AND l.journal_id = t.id WHERE t.book_id = ? AND t.finalized_at IS NOT NULL AND t.status != 'void' AND l.asset_id = ?"
    ).all(this.bookId, fromAssetId) as Row[];
    rows.forEach((row) => this.assertPeriodOpen(String(row.date)));
    if (rows.length === 0) return 0;
    const txIds = rows.map((row) => String(row.id));
    const placeholders = txIds.map(() => "?").join(", ");
    const count = (this.db.prepare(`SELECT count(*) AS c FROM journal_lines WHERE book_id = ? AND asset_id = ? AND journal_id IN (${placeholders})`).get(this.bookId, fromAssetId, ...txIds) as Row).c as bigint;
    this.transaction(() => {
      for (const row of rows) this.reopenTx(String(row.id));
      this.db.prepare(`UPDATE journal_lines SET asset_id = ? WHERE book_id = ? AND asset_id = ? AND journal_id IN (${placeholders})`).run(toAssetId, this.bookId, fromAssetId, ...txIds);
      for (const row of rows) this.finalizeTx(String(row.id));
    });
    return Number(count);
  }

  closePeriod(name: string, asOf: string, description?: string | null): Record<string, unknown> {
    const periodId = id("period");
    const date = dateOnly(asOf);
    this.db.prepare("INSERT INTO period_closes(id, book_id, name, as_of, description, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      periodId,
      this.bookId,
      name,
      date,
      description ?? null,
      now()
    );
    return { id: periodId, name, as_of: date, description: description ?? null };
  }

  listCheckpoints(): Row[] {
    return this.db.prepare("SELECT * FROM period_closes WHERE book_id = ? ORDER BY as_of, id").all(this.bookId) as Row[];
  }

  reopenPeriod(periodId: string): Record<string, string> {
    const result = this.db.prepare("UPDATE period_closes SET reopened_at = ? WHERE book_id = ? AND id = ?").run(now(), this.bookId, periodId);
    if (Number(result.changes) === 0) throw new Error(`Checkpoint ${periodId} not found`);
    return { reopened: periodId };
  }

  private statusClause(status: TxStatus | string | null | undefined): { sql: string; params: unknown[] } {
    if (status == null) return { sql: "AND t.status != 'void'", params: [] };
    if (status === "all") return { sql: "AND t.status != 'void'", params: [] };
    if (status === "active") return { sql: "AND t.status IN ('posted', 'pending')", params: [] };
    if (status === "combined") return { sql: "AND t.status IN ('posted', 'pending', 'planned')", params: [] };
    return { sql: "AND t.status = ?", params: [txStatus(String(status))] };
  }

  balance(accountId: string, assetId: string, asOf?: string | null, status: TxStatus | string | null = "posted", dateFrom?: string | null): bigint {
    const clause = this.statusClause(status);
    let sql = `SELECT coalesce(sum(l.quantity), 0) AS total
      FROM journal_lines l JOIN journals t ON t.book_id = l.book_id AND t.id = l.journal_id
      WHERE l.book_id = ? AND t.finalized_at IS NOT NULL AND l.account_id = ? AND l.asset_id = ? ${clause.sql}`;
    const params: SQLInputValue[] = [this.bookId, accountId, assetId, ...clause.params as SQLInputValue[]];
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
      const rows = this.db.prepare("SELECT id FROM accounts WHERE book_id = ? AND parent_id = ?").all(this.bookId, current) as Row[];
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
      const defaultAssetId = account.default_asset_id ?? this.listAnnotations("account", account.id).filter((tag) => tag.key === "default_asset").at(-1)?.value ?? null;
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
    for (const tx of this.listTransactions({ status: status ?? "all", dateFrom, dateTo })) {
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
    for (const tx of this.listTransactions({ status: status ?? "all", dateFrom, dateTo })) {
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
    const equityEquivalent = new Set(["transfer clearing", "opening balance", "opening balances", "retained earnings"]);
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
    for (const tx of this.listTransactions({ status: status ?? "all", dateFrom, dateTo })) {
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
    postedAtFrom?: string | null;
    postedAtTo?: string | null;
    assetId?: string | null;
    sort?: string;
    limit?: number | null;
    offset?: number;
  }) {
    let rows: Array<Journal & { entries: JournalLine[] }> = [];
    for (const tx of this.listTransactions({ status: options.status, dateFrom: options.dateFrom, dateTo: options.dateTo })) {
      if (options.status == null && tx.status === "void") continue;
      if (options.postedAtFrom && tx.posted_at < options.postedAtFrom) continue;
      if (options.postedAtTo && tx.posted_at > options.postedAtTo) continue;
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
      if (!this.getAccount(accountId)?.default_asset_id) this.updateAccount(accountId, { default_asset_id: assetId });
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

    return this.transaction(() => {
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
        this.bookId,
        holdingAccountId,
        securityId,
        shares,
        options.cashAssetId,
        totalCost,
        txId,
        txDate
      );
      return this.txWithEntries(txId);
    });
  }

  backupNow(outputPath?: string | null) {
    const target = outputPath || join(dirname(this.path), "backups", `${now().replaceAll(":", "-")}.db`);
    mkdirSync(dirname(target), { recursive: true });
    this.db.prepare("VACUUM INTO ?").run(target);
    return { path: target };
  }

  integrityCheck() {
    return integrityCheckInStore(this, this.store);
  }

  exportDocument() {
    return exportDocumentFromStore(this, this.store);
  }

  importDocument(doc: Record<string, any>, preserveIds = true, dryRun = false) {
    return importDocumentFromStore(this, this.store, doc, preserveIds, dryRun);
  }

  exportTransactionsCsv(outputPath?: string | null, options: { accountId?: string | null; dateFrom?: string | null; dateTo?: string | null; status?: TxStatus | string | null } = {}) {
    return exportTransactionsCsvDocument(this, outputPath, options);
  }
}
