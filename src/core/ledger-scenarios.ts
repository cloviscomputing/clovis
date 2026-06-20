import type { SQLInputValue } from "node:sqlite";
import { id, now, type Row } from "./ledger-codec.js";
import type { LedgerStore } from "./ledger-store.js";

export function createScenarioBook(store: LedgerStore, name: string): Row {
  const { db, bookId } = store;
  const scenarioId = String(name ?? "").trim();
  if (!scenarioId) throw new Error("Scenario name is required");
  const existing = db.prepare("SELECT id, name, parent_id, created_at, closed_at FROM books WHERE type = 'scenario' AND parent_id = ? AND (id = ? OR lower(name) = lower(?)) LIMIT 1").get(bookId, scenarioId, scenarioId) as Row | undefined;
  if (existing) return existing;
  const conflict = db.prepare("SELECT id, name, type FROM books WHERE id = ? OR lower(name) = lower(?) LIMIT 1").get(scenarioId, scenarioId) as Row | undefined;
  if (conflict) throw new Error(`Scenario '${scenarioId}' conflicts with existing ${String(conflict.type)} book '${String(conflict.name)}'`);

  const createdAt = now();
  const accountMap = new Map<string, string>();
  const sourceMap = new Map<string, string>();
  const txMap = new Map<string, string>();
  const priceMap = new Map<string, string>();
  const ruleMap = new Map<string, string>();
  const targetMap = new Map<string, string>();
  const recurrenceMap = new Map<string, string>();
  const periodMap = new Map<string, string>();
  const lotMap = new Map<string, string>();
  const sqlValue = (value: unknown): SQLInputValue => value == null ? null : value as SQLInputValue;
  const requiredMapped = (map: Map<string, string>, value: unknown, label: string): string => {
    const mapped = map.get(String(value));
    if (!mapped) throw new Error(`Scenario clone missing ${label} mapping for ${String(value)}`);
    return mapped;
  };
  const mappedEntityId = (entityType: string, entityId: string): string => {
    if (entityType === "account") return accountMap.get(entityId) ?? entityId;
    if (entityType === "source") return sourceMap.get(entityId) ?? entityId;
    if (entityType === "tx" || entityType === "journal") return txMap.get(entityId) ?? entityId;
    if (entityType === "price") return priceMap.get(entityId) ?? entityId;
    if (entityType === "rule") return ruleMap.get(entityId) ?? entityId;
    if (entityType === "target") return targetMap.get(entityId) ?? entityId;
    if (entityType === "recurrence") return recurrenceMap.get(entityId) ?? entityId;
    if (entityType === "period_close") return periodMap.get(entityId) ?? entityId;
    if (entityType === "lot") return lotMap.get(entityId) ?? entityId;
    if (entityType === "book" && entityId === bookId) return scenarioId;
    return entityId;
  };
  const mappedAnnotationValue = (key: string, value: string): string => {
    if (key === "import_batch") return sourceMap.get(value) ?? value;
    if (key === "recategorize_from" || key === "recategorize_to") return accountMap.get(value) ?? value;
    if (key === "branch" && value === bookId) return scenarioId;
    return value;
  };

  return store.transaction(() => {
    db.prepare("INSERT INTO books(id, name, type, parent_id, created_at) VALUES (?, ?, 'scenario', ?, ?)").run(scenarioId, scenarioId, bookId, createdAt);

    const accounts = db.prepare("SELECT * FROM accounts WHERE book_id = ? ORDER BY name, id").all(bookId) as Row[];
    for (const account of accounts) {
      const nextId = id("acct");
      accountMap.set(String(account.id), nextId);
      db.prepare(
        "INSERT INTO accounts(id, book_id, name, type, parent_id, default_asset_id, code, color_hex, status) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)"
      ).run(
        nextId,
        scenarioId,
        sqlValue(account.name),
        sqlValue(account.type),
        sqlValue(account.default_asset_id),
        sqlValue(account.code ?? ""),
        sqlValue(account.color_hex ?? "#888888"),
        sqlValue(account.status ?? "active")
      );
    }
    for (const account of accounts) {
      if (!account.parent_id) continue;
      db.prepare("UPDATE accounts SET parent_id = ? WHERE book_id = ? AND id = ?").run(
        requiredMapped(accountMap, account.parent_id, "account parent"),
        scenarioId,
        requiredMapped(accountMap, account.id, "account")
      );
    }

    for (const source of db.prepare("SELECT * FROM sources WHERE book_id = ? ORDER BY created_at, id").all(bookId) as Row[]) {
      const nextId = id(String(source.type) === "import" ? "batch" : "source");
      sourceMap.set(String(source.id), nextId);
      db.prepare("INSERT INTO sources(id, book_id, type, label, status, created_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        nextId,
        scenarioId,
        sqlValue(source.type),
        sqlValue(source.label ?? ""),
        sqlValue(source.status ?? "open"),
        sqlValue(source.created_at ?? createdAt),
        sqlValue(source.metadata_json ?? "{}")
      );
    }

    const journals = db.prepare("SELECT * FROM journals WHERE book_id = ? AND finalized_at IS NOT NULL ORDER BY date, id").all(bookId) as Row[];
    for (const journal of journals) {
      const nextId = id("tx");
      txMap.set(String(journal.id), nextId);
      db.prepare("INSERT INTO journals(id, book_id, source_id, date, posted_at, status, description, external_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        nextId,
        scenarioId,
        journal.source_id == null ? null : sourceMap.get(String(journal.source_id)) ?? null,
        sqlValue(journal.date),
        sqlValue(journal.posted_at),
        sqlValue(journal.status),
        sqlValue(journal.description ?? ""),
        sqlValue(journal.external_id)
      );
    }
    for (const line of db.prepare(
      `SELECT l.* FROM journal_lines l
       JOIN journals t ON t.book_id = l.book_id AND t.id = l.journal_id
       WHERE l.book_id = ? AND t.finalized_at IS NOT NULL
       ORDER BY l.journal_id, l.line_no, l.id`
    ).all(bookId) as Row[]) {
      db.prepare("INSERT INTO journal_lines(id, book_id, journal_id, line_no, account_id, asset_id, quantity, memo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        id("line"),
        scenarioId,
        requiredMapped(txMap, line.journal_id, "journal"),
        sqlValue(line.line_no),
        requiredMapped(accountMap, line.account_id, "line account"),
        sqlValue(line.asset_id),
        sqlValue(line.quantity),
        sqlValue(line.memo ?? "")
      );
    }
    for (const journal of journals) {
      db.prepare("UPDATE journals SET finalized_at = ? WHERE book_id = ? AND id = ?").run(sqlValue(journal.finalized_at), scenarioId, requiredMapped(txMap, journal.id, "journal"));
    }

    for (const price of db.prepare("SELECT * FROM prices WHERE book_id = ? ORDER BY time, id").all(bookId) as Row[]) {
      const nextId = id("price");
      priceMap.set(String(price.id), nextId);
      db.prepare("INSERT INTO prices(id, book_id, asset_id, quote_asset_id, rate_value, rate_scale, time) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        nextId,
        scenarioId,
        sqlValue(price.asset_id),
        sqlValue(price.quote_asset_id),
        sqlValue(price.rate_value),
        sqlValue(price.rate_scale),
        sqlValue(price.time)
      );
    }

    for (const rule of db.prepare("SELECT * FROM rules WHERE book_id = ? ORDER BY priority, id").all(bookId) as Row[]) {
      const nextId = id("rule");
      ruleMap.set(String(rule.id), nextId);
      db.prepare("INSERT INTO rules(id, book_id, type, account_id, pattern, priority, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        nextId,
        scenarioId,
        sqlValue(rule.type),
        rule.account_id == null ? null : requiredMapped(accountMap, rule.account_id, "rule account"),
        sqlValue(rule.pattern),
        sqlValue(rule.priority ?? 100),
        sqlValue(rule.status ?? "active"),
        sqlValue(rule.created_at ?? createdAt)
      );
    }

    for (const target of db.prepare("SELECT * FROM targets WHERE book_id = ? ORDER BY type, id").all(bookId) as Row[]) {
      const nextId = id(String(target.type) === "budget" ? "budget" : "goal");
      targetMap.set(String(target.id), nextId);
      db.prepare(
        "INSERT INTO targets(id, book_id, type, account_id, asset_id, quantity, period, year, month, rollover_rule, name, target_date, priority, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        nextId,
        scenarioId,
        sqlValue(target.type),
        requiredMapped(accountMap, target.account_id, "target account"),
        sqlValue(target.asset_id),
        sqlValue(target.quantity),
        sqlValue(target.period),
        sqlValue(target.year),
        sqlValue(target.month),
        sqlValue(target.rollover_rule ?? ""),
        sqlValue(target.name ?? ""),
        sqlValue(target.target_date),
        sqlValue(target.priority ?? 1),
        sqlValue(target.status ?? "active")
      );
    }

    for (const recurrence of db.prepare("SELECT * FROM recurrences WHERE book_id = ? ORDER BY next_date, id").all(bookId) as Row[]) {
      const nextId = id("sched");
      recurrenceMap.set(String(recurrence.id), nextId);
      db.prepare(
        "INSERT INTO recurrences(id, book_id, next_date, quantity, from_account_id, to_account_id, description, frequency, end_date, asset_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        nextId,
        scenarioId,
        sqlValue(recurrence.next_date),
        sqlValue(recurrence.quantity),
        requiredMapped(accountMap, recurrence.from_account_id, "recurrence from_account"),
        requiredMapped(accountMap, recurrence.to_account_id, "recurrence to_account"),
        sqlValue(recurrence.description ?? ""),
        sqlValue(recurrence.frequency),
        sqlValue(recurrence.end_date),
        sqlValue(recurrence.asset_id),
        sqlValue(recurrence.status ?? "active")
      );
    }

    for (const period of db.prepare("SELECT * FROM period_closes WHERE book_id = ? ORDER BY as_of, id").all(bookId) as Row[]) {
      const nextId = id("period");
      periodMap.set(String(period.id), nextId);
      db.prepare("INSERT INTO period_closes(id, book_id, name, as_of, description, created_at, reopened_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        nextId,
        scenarioId,
        sqlValue(period.name),
        sqlValue(period.as_of),
        sqlValue(period.description),
        sqlValue(period.created_at ?? createdAt),
        sqlValue(period.reopened_at)
      );
    }

    for (const lot of db.prepare("SELECT * FROM lots WHERE book_id = ? ORDER BY opened_at, id").all(bookId) as Row[]) {
      const nextId = id("lot");
      lotMap.set(String(lot.id), nextId);
      db.prepare("INSERT INTO lots(id, book_id, account_id, asset_id, quantity, cost_asset_id, cost_quantity, opened_journal_id, closed_journal_id, opened_at, closed_at, status, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        nextId,
        scenarioId,
        requiredMapped(accountMap, lot.account_id, "lot account"),
        sqlValue(lot.asset_id),
        sqlValue(lot.quantity),
        sqlValue(lot.cost_asset_id),
        sqlValue(lot.cost_quantity),
        requiredMapped(txMap, lot.opened_journal_id, "lot opened journal"),
        lot.closed_journal_id == null ? null : requiredMapped(txMap, lot.closed_journal_id, "lot closed journal"),
        sqlValue(lot.opened_at),
        sqlValue(lot.closed_at),
        sqlValue(lot.status ?? "open"),
        sqlValue(lot.metadata_json ?? "{}")
      );
    }

    for (const annotation of db.prepare("SELECT * FROM annotations WHERE book_id = ? ORDER BY entity_type, entity_id, key, id").all(bookId) as Row[]) {
      const entityType = String(annotation.entity_type);
      const key = String(annotation.key);
      db.prepare("INSERT INTO annotations(id, book_id, entity_type, entity_id, key, value) VALUES (?, ?, ?, ?, ?, ?)").run(
        id("ann"),
        scenarioId,
        entityType,
        mappedEntityId(entityType, String(annotation.entity_id)),
        key,
        mappedAnnotationValue(key, String(annotation.value))
      );
    }

    return db.prepare("SELECT id, name, parent_id, created_at, closed_at FROM books WHERE id = ?").get(scenarioId) as Row;
  });
}

export function listScenarioBooks(store: LedgerStore): Row[] {
  return store.db.prepare("SELECT id, name, parent_id, created_at, closed_at FROM books WHERE type = 'scenario' AND parent_id = ? ORDER BY name").all(store.bookId) as Row[];
}

export function getScenarioBook(store: LedgerStore, name: string): Row | null {
  const scenarioId = String(name ?? "").trim();
  if (!scenarioId) throw new Error("Scenario name is required");
  return (store.db.prepare("SELECT id, name, parent_id, created_at, closed_at FROM books WHERE type = 'scenario' AND parent_id = ? AND (id = ? OR lower(name) = lower(?)) LIMIT 1").get(store.bookId, scenarioId, scenarioId) as Row | undefined) ?? null;
}

export function discardScenarioBook(store: LedgerStore, name: string): number {
  const scenario = getScenarioBook(store, name);
  if (!scenario) throw new Error(`Scenario '${String(name)}' not found`);
  if (scenario.closed_at != null) return 0;
  return Number(store.db.prepare("UPDATE books SET closed_at = ? WHERE type = 'scenario' AND parent_id = ? AND id = ?").run(now(), store.bookId, String(scenario.id)).changes);
}
