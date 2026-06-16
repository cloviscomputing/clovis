import { dateOnly, type Row, validateLines } from "./ledger-codec.js";
import type { LedgerStore } from "./ledger-store.js";
import type { Ledger } from "./ledger.js";

export function integrityCheck(ledger: Ledger, store: LedgerStore) {
  const { db, bookId } = store;
  const imbalanced: Row[] = [];
  for (const tx of ledger.listTransactions({ status: null })) {
    try {
      validateLines(ledger.getEntries(tx.id).map((entry) => [entry.account_id, entry.asset_id, entry.quantity]));
    } catch (error) {
      imbalanced.push({ tx_id: tx.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const accountCycles: Row[] = [];
  const accounts = ledger.listAccounts();
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

  const exists = (table: string, entityId: string): boolean => Boolean(db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(entityId));
  const orphanAnnotations: Row[] = [];
  const invalidDefaultAssets: Row[] = [];
  const annotations = db.prepare("SELECT * FROM annotations WHERE book_id = ? ORDER BY entity_type, entity_id, key, id").all(bookId) as Row[];
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
      if (!ledger.getAccount(String(annotation.entity_id)) || !ledger.getAsset(String(annotation.value))) invalidDefaultAssets.push(annotation);
    }
  }
  invalidDefaultAssets.push(...db.prepare(
    `SELECT id AS account_id, default_asset_id AS value, 'default_asset_id' AS key, 'account default_asset_id points at missing asset' AS error
     FROM accounts
     WHERE book_id = ?
       AND default_asset_id IS NOT NULL
       AND default_asset_id NOT IN (SELECT id FROM assets)
     ORDER BY id`
  ).all(bookId) as Row[]);

  const invalidPrices = db.prepare(
    "SELECT * FROM prices WHERE book_id = ? AND (rate_value <= 0 OR rate_scale < 0 OR rate_scale > 18 OR rate_scale != CAST(rate_scale AS INTEGER)) ORDER BY id"
  ).all(bookId) as Row[];

  const invalidTargets = db.prepare(
    `SELECT * FROM targets
     WHERE book_id = ? AND (
       (type = 'budget' AND quantity < 0) OR
       (type = 'goal' AND quantity <= 0) OR
       (period IS NOT NULL AND period NOT IN ('monthly', 'yearly')) OR
       (month IS NOT NULL AND (month < 1 OR month > 12))
     )
     ORDER BY id`
  ).all(bookId) as Row[];
  for (const target of db.prepare("SELECT * FROM targets WHERE book_id = ? AND type = 'goal' AND target_date IS NOT NULL ORDER BY id").all(bookId) as Row[]) {
    try {
      dateOnly(String(target.target_date));
    } catch (error) {
      invalidTargets.push({ ...target, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const duplicateBudgets = db.prepare(
    `SELECT account_id, asset_id, period, year, month, count(*) AS count
     FROM targets
     WHERE book_id = ? AND type = 'budget'
     GROUP BY account_id, asset_id, period, coalesce(year, -1), coalesce(month, -1)
     HAVING count(*) > 1`
  ).all(bookId) as Row[];

  const invalidRecurrences = db.prepare(
    `SELECT * FROM recurrences
     WHERE book_id = ? AND (
       quantity <= 0 OR
       frequency NOT IN ('daily', 'weekly', 'monthly', 'yearly') OR
       status NOT IN ('active', 'paused', 'deleted')
     )
     ORDER BY id`
  ).all(bookId) as Row[];
  for (const recurrence of db.prepare("SELECT * FROM recurrences WHERE book_id = ? ORDER BY id").all(bookId) as Row[]) {
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
  for (const lot of ledger.listLots()) {
    const opened = lot.opened_journal_id ? ledger.getTx(String(lot.opened_journal_id)) : null;
    const closed = lot.closed_journal_id ? ledger.getTx(String(lot.closed_journal_id)) : null;
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
    const balance = ledger.balanceTree(accountId, assetId, null, null);
    if (balance !== quantity) invalidLots.push({ account_id: accountId, asset_id: assetId, open_lot_quantity: quantity, balance, error: "open lot quantity does not match account balance" });
  }

  const schemaVersion = (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as Row | undefined)?.value ?? null;
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
