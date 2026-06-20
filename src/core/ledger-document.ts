import {
  accountType,
  assetScaleValue,
  assetType,
  dateOnly,
  id,
  monthValue,
  now,
  recurrenceFrequency,
  type Row,
  targetPeriod,
  txStatus,
  validateLines,
  yearValue
} from "./ledger-codec.js";
import type { LedgerStore } from "./ledger-store.js";
import type { Ledger } from "./ledger.js";

function assertPeriodOpen(store: LedgerStore, txDate: string): void {
  const row = store.db.prepare(
    "SELECT id, name, as_of FROM period_closes WHERE book_id = ? AND reopened_at IS NULL AND as_of >= ? ORDER BY as_of DESC, created_at DESC LIMIT 1"
  ).get(store.bookId, txDate) as Row | undefined;
  if (row) throw new Error(`Period '${String(row.name)}' is closed through ${String(row.as_of)}; transaction date ${txDate} cannot be modified`);
}

export function exportDocument(ledger: Ledger, store: LedgerStore) {
    const transactions = ledger.listTransactions({ status: null }).map((tx) => ({ ...tx, entries: ledger.getEntries(tx.id), tags: ledger.listAnnotations("tx", tx.id) }));
    const accounts = ledger.listAccounts().map((account) => {
      const defaultAssetId = account.default_asset_id ?? ledger.listAnnotations("account", account.id).filter((tag) => tag.key === "default_asset").at(-1)?.value ?? null;
      const defaultAsset = defaultAssetId ? ledger.getAsset(defaultAssetId) : null;
      return { ...account, default_asset_id: defaultAssetId, default_asset_symbol: defaultAsset?.symbol ?? null };
    });
    return {
      format: "clovis-ledger-v2",
      assets: ledger.listAssets(),
      accounts,
      sources: ledger.listSources(null, null),
      transactions,
      account_tags: (store.db.prepare("SELECT id, book_id, entity_type, entity_id, key, value AS val, value FROM annotations WHERE book_id = ? AND entity_type = 'account'").all(store.bookId) as Row[]),
      prices: ledger.listPrices(),
      budgets: store.db.prepare("SELECT * FROM targets WHERE book_id = ? AND type = 'budget'").all(store.bookId) as Row[],
      goals: (store.db.prepare("SELECT * FROM targets WHERE book_id = ? AND type = 'goal'").all(store.bookId) as Row[]).map((row) => ({ ...row, target_quantity: row.quantity, target_cents: row.quantity })),
      branches: store.db.prepare("SELECT name, created_at, closed_at AS discarded_at FROM books WHERE type = 'scenario' ORDER BY name").all() as Row[],
      checkpoints: ledger.listCheckpoints(),
      lots: ledger.listLots(),
      scheduled_transactions: store.db.prepare("SELECT * FROM recurrences WHERE book_id = ? ORDER BY next_date, id").all(store.bookId) as Row[]
    };
  }
export function importDocument(ledger: Ledger, store: LedgerStore, doc: Record<string, any>, preserveIds = true, dryRun = false) {
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
      skipped_existing: {
        assets: 0,
        accounts: 0,
        sources: 0,
        transactions: 0
      },
      conflicts: [] as Row[],
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
    const existingSource = (sourceId: string): boolean => Boolean(store.db.prepare("SELECT id FROM sources WHERE book_id = ? AND id = ?").get(store.bookId, sourceId));
    const assetMap = new Map<string, string>();
    const accountMap = new Map<string, string>();
    const sourceMap = new Map<string, string>();
    const txMap = new Map<string, string>();
    const mappedAsset = (ref: unknown, label: string): string => {
      const value = String(ref ?? "");
      const mapped = assetMap.get(value);
      if (mapped) return mapped;
      if (ledger.getAsset(value)) return value;
      errors.push(`${label} references unknown asset ${value}`);
      return "";
    };
    const mappedAccount = (ref: unknown, label: string): string => {
      const value = String(ref ?? "");
      const mapped = accountMap.get(value);
      if (mapped) return mapped;
      if (ledger.getAccount(value)) return value;
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
      if (ledger.getTx(value)) return value;
      errors.push(`${label} references unknown transaction ${value}`);
      return "";
    };
    const tagValue = (tag: any): string => String(tag?.value ?? tag?.val ?? "");
    const mappedTxTagValue = (key: string, value: string): string => {
      if (key === "import_batch") return sourceMap.get(value) ?? value;
      if (key === "recategorize_from" || key === "recategorize_to") return accountMap.get(value) ?? value;
      return value;
    };
    const sameText = (left: unknown, right: unknown): boolean => String(left ?? "") === String(right ?? "");
    const noteExisting = (section: keyof typeof result.skipped_existing): void => {
      result.skipped_existing[section] += 1;
      result.skipped += 1;
    };
    const conflict = (section: string, index: number, idValue: string, message: string): void => {
      const text = `${section}[${index}].${message}`;
      result.conflicts.push({ section, index, id: idValue, error: message });
      errors.push(text);
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
      const existing = preserveIds ? ledger.getAsset(assetId) : null;
      if (existing) {
        if (dryRun && sameText(existing.symbol, symbol) && sameText(existing.type, asset.type ?? asset.asset_type) && Number(existing.scale) === Number(asset.scale ?? asset.decimals ?? 2)) noteExisting("assets");
        else conflict("assets", index, assetId, `id already exists: ${assetId}`);
      }
      assetMap.set(assetId, preserveIds ? assetId : (symbol ? ledger.getAssetBySymbol(symbol)?.id ?? id("asset") : id("asset")));
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
      if (account.parent_id && !accountMap.has(String(account.parent_id)) && !ledger.getAccount(String(account.parent_id))) {
        errors.push(`accounts[${index}].parent_id references unknown account ${String(account.parent_id)}`);
      }
      const existing = preserveIds ? ledger.getAccount(accountId) : null;
      if (existing) {
        const parent = account.parent_id ? accountMap.get(String(account.parent_id)) ?? String(account.parent_id) : null;
        const defaultAsset = account.default_asset_id ?? account.asset_id ?? null;
        const defaultMatches = defaultAsset == null || sameText(existing.default_asset_id, defaultAsset);
        if (dryRun && sameText(existing.name, accountName) && sameText(existing.account_type, account.type ?? account.account_type) && sameText(existing.parent_id, parent) && defaultMatches) noteExisting("accounts");
        else conflict("accounts", index, accountId, `id already exists: ${accountId}`);
      }
    });
    const accountNames = new Map<string, number>();
    accounts.forEach((account, index) => {
      const name = String(account.name ?? "").trim();
      if (!name) return;
      const key = name.toLowerCase();
      if (accountNames.has(key)) errors.push(`accounts[${index}].name duplicates accounts[${accountNames.get(key)}].name: ${name}`);
      else accountNames.set(key, index);
      const existing = store.db.prepare("SELECT id FROM accounts WHERE book_id = ? AND lower(name) = lower(?) LIMIT 1").get(store.bookId, name) as Row | undefined;
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
        current = importedParents.has(current) ? importedParents.get(current)! : ledger.getAccount(current)?.parent_id ?? null;
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
      const account = ledger.getAccount(accountId);
      if (account?.default_asset_id && ledger.getAsset(account.default_asset_id)) return account.default_asset_id;
      const existing = ledger.listAnnotations("account", accountId).filter((tag) => tag.key === "default_asset").at(-1)?.value ?? null;
      return existing && ledger.getAsset(existing) ? existing : null;
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
      const existing = preserveIds ? store.db.prepare("SELECT * FROM sources WHERE book_id = ? AND id = ?").get(store.bookId, sourceId) as Row | undefined : undefined;
      if (existing) {
        if (dryRun && sameText(existing.type, source.type) && sameText(existing.label, source.label ?? "") && sameText(existing.status, source.status ?? "open")) noteExisting("sources");
        else conflict("sources", index, sourceId, `id already exists: ${sourceId}`);
      }
      sourceMap.set(sourceId, preserveIds ? sourceId : id(source.type === "import" ? "batch" : "source"));
    });

    transactions.forEach((tx, index) => {
      const txId = requireId("transactions", tx, index);
      if (!txId) return;
      trackId("transactions", txId, index);
      txMap.set(txId, preserveIds ? txId : id("tx"));
      const existing = preserveIds ? ledger.getTx(txId) : null;
      if (existing) {
        if (dryRun && sameText(existing.date, tx.date) && sameText(existing.status, tx.status) && sameText(existing.description, tx.description ?? "") && sameText(existing.external_id, tx.external_id)) noteExisting("transactions");
        else conflict("transactions", index, txId, `id already exists: ${txId}`);
      }
      try {
        assertPeriodOpen(store, dateOnly(String(tx.date)));
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
        const existing = store.db.prepare("SELECT id FROM targets WHERE book_id = ? AND type = 'budget' AND account_id = ? AND asset_id = ? AND period = ? AND year IS ? AND month IS ? LIMIT 1")
          .get(store.bookId, accountId, assetId, period, year, month) as Row | undefined;
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
        const existing = store.db.prepare("SELECT id FROM targets WHERE book_id = ? AND type = 'goal' AND account_id = ? AND asset_id = ? LIMIT 1")
          .get(store.bookId, accountId, assetId) as Row | undefined;
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
      if (name && store.db.prepare("SELECT id FROM books WHERE lower(name) = lower(?) LIMIT 1").get(name)) {
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

    return store.transaction(() => {
      for (const asset of assets) {
        if (!preserveIds && ledger.getAsset(assetMap.get(asset.id)!)) {
          result.skipped += 1;
          continue;
        }
        store.db.prepare("INSERT INTO assets(id, symbol, type, scale, name) VALUES (?, ?, ?, ?, ?)").run(
          assetMap.get(asset.id)!,
          asset.symbol,
          asset.type ?? asset.asset_type,
          Number(asset.scale ?? asset.decimals ?? 2),
          asset.name ?? ""
        );
        result.inserted.assets += 1;
      }
      for (const account of accounts) {
        store.db.prepare("INSERT INTO accounts(id, book_id, name, type, parent_id, code, color_hex) VALUES (?, ?, ?, ?, NULL, ?, ?)").run(
          accountMap.get(account.id)!,
          store.bookId,
          account.name,
          account.type ?? account.account_type,
          account.code ?? "",
          account.color_hex ?? "#888888"
        );
        result.inserted.accounts += 1;
      }
      for (const account of accounts) {
        if (account.parent_id) store.db.prepare("UPDATE accounts SET parent_id = ? WHERE book_id = ? AND id = ?").run(accountMap.get(account.parent_id)!, store.bookId, accountMap.get(account.id)!);
      }
      for (const [accountId, assetId] of accountDefaultAssets) {
        store.db.prepare("UPDATE accounts SET default_asset_id = ? WHERE book_id = ? AND id = ?").run(assetId, store.bookId, accountId);
      }
      for (const tag of accountTags) {
        const annotationId = preserveIds && typeof tag.id === "string" && tag.id.trim() !== "" ? tag.id : id("ann");
        const entityId = mappedAccount(tag.entity_id, "account_tag.entity_id");
        const key = String(tag.key ?? "");
        const rawValue = tagValue(tag);
        const value = key === "default_asset" ? mappedAsset(rawValue, "account_tag.default_asset") : rawValue;
        if (key === "default_asset") continue;
        store.db.prepare("INSERT INTO annotations(id, book_id, entity_type, entity_id, key, value) VALUES (?, ?, 'account', ?, ?, ?)").run(
          annotationId,
          store.bookId,
          entityId,
          key,
          value
        );
        result.inserted.account_tags += 1;
      }
      for (const source of sources) {
        store.db.prepare("INSERT INTO sources(id, book_id, type, label, status, created_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
          sourceMap.get(source.id)!,
          store.bookId,
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
        store.db.prepare("INSERT INTO journals(id, book_id, source_id, date, posted_at, status, description, external_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
          txId,
          store.bookId,
          mappedSource(tx.source_id, "transaction.source_id"),
          tx.date,
          tx.posted_at ?? now(),
          tx.status,
          tx.description ?? "",
          tx.external_id ?? null
        );
        (tx.entries ?? []).forEach((entry: any, index: number) => {
          store.db.prepare("INSERT INTO journal_lines(id, book_id, journal_id, line_no, account_id, asset_id, quantity) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
            preserveIds ? entry.id : id("line"),
            store.bookId,
            txId,
            index + 1,
            mappedAccount(entry.account_id, "journal_line.account_id"),
            mappedAsset(entry.asset_id, "journal_line.asset_id"),
            BigInt(entry.quantity ?? entry.qty_cents ?? 0)
          );
        });
        store.db.prepare("UPDATE journals SET finalized_at = ? WHERE book_id = ? AND id = ?").run(tx.finalized_at ?? tx.posted_at ?? now(), store.bookId, txId);
        for (const tag of tx.tags ?? []) {
          const key = String(tag.key ?? "");
          ledger.createAnnotation(tag.entity_type ?? "tx", txId, key, mappedTxTagValue(key, tagValue(tag)));
        }
        result.inserted.transactions += 1;
      }
      for (const price of prices) {
        store.db.prepare("INSERT INTO prices(id, book_id, asset_id, quote_asset_id, rate_value, rate_scale, time) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
          preserveIds ? price.id : id("price"),
          store.bookId,
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
        store.db.prepare("INSERT INTO targets(id, book_id, type, account_id, asset_id, quantity, period, year, month, rollover_rule) VALUES (?, ?, 'budget', ?, ?, ?, ?, ?, ?, ?)").run(
          preserveIds ? budget.id : id("target"),
          store.bookId,
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
        store.db.prepare("INSERT INTO targets(id, book_id, type, account_id, asset_id, quantity, name, target_date, priority) VALUES (?, ?, 'goal', ?, ?, ?, ?, ?, ?)").run(
          preserveIds && goal.id ? goal.id : id("target"),
          store.bookId,
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
        store.db.prepare("INSERT INTO books(id, name, type, parent_id, created_at, closed_at) VALUES (?, ?, 'scenario', ?, ?, ?)").run(
          branch.name,
          branch.name,
          store.bookId,
          branch.created_at ?? now(),
          branch.discarded_at ?? branch.closed_at ?? null
        );
        result.inserted.branches += 1;
      }
      for (const checkpoint of checkpoints) {
        store.db.prepare("INSERT INTO period_closes(id, book_id, name, as_of, description, created_at, reopened_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
          preserveIds ? checkpoint.id : id("period"),
          store.bookId,
          checkpoint.name,
          checkpoint.as_of,
          checkpoint.description ?? null,
          checkpoint.created_at ?? now(),
          checkpoint.reopened_at ?? null
        );
        result.inserted.checkpoints += 1;
      }
      for (const lot of lots) {
        store.db.prepare("INSERT INTO lots(id, book_id, account_id, asset_id, quantity, cost_asset_id, cost_quantity, opened_journal_id, closed_journal_id, opened_at, closed_at, status, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
          preserveIds ? lot.id : id("lot"),
          store.bookId,
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
        store.db.prepare("INSERT INTO recurrences(id, book_id, next_date, quantity, from_account_id, to_account_id, description, frequency, end_date, asset_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
          preserveIds ? scheduled.id : id("sched"),
          store.bookId,
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
      return { ...result, imported: true };
    });
  }
