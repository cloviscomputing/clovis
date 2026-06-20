import { Ledger } from "../core/ledger.js";
import type { Account, Journal, TxStatus } from "../core/types.js";
import { fromAtomicUnits } from "../core/money.js";
import { recordMutationAudit, stableHash } from "./mutation-overseer.js";
import { isProjectionPlannedTx, isRealizedPlannedLandedTx, txMatchesStatusFilter } from "./transaction-lifecycle.js";
import { parseTxStatusFilter, resolveAccount, resolveAsset, validateDate } from "./validation.js";

export type Args = Record<string, any>;
export type Row = Record<string, any>;

const MAX_MATCH_PATTERN_LENGTH = 200;

export const MAX_MATCH_INPUT_LENGTH = 2048;

const CATEGORIZATION_TAG_KEYS = new Set(["merchant", "memo", "name", "ofx_memo", "ofx_name", "payee", "qfx_memo", "qfx_name"]);

const NESTED_QUANTIFIER_PATTERN = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,?\d*\})/;

export function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

export function monthBounds(year?: number | null, month?: number | null): [string, string] {
  const base = new Date();
  const y = year ?? base.getUTCFullYear();
  const m = month ?? base.getUTCMonth() + 1;
  const start = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-01`;
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return [start, end];
}

export function previousDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

export function monthEnd(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

export function dateDeltaDays(left: string, right: string): number {
  return Math.abs((Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`)) / 86400000);
}

export function optionalDate(value: unknown): string | null {
  if (value == null || value === "") return null;
  return validateDate(String(value));
}

export function postedAtBound(value: unknown, side: "from" | "to"): string | null {
  if (value == null || value === "") return null;
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return side === "from" ? `${text}T00:00:00Z` : `${text}T23:59:59Z`;
  return text;
}

export function account(ledger: Ledger, ref?: string | null): string {
  return resolveAccount(ledger, ref);
}

export function asset(ledger: Ledger, ref?: string | null, symbol?: string | null): string {
  return resolveAsset(ledger, ref, symbol);
}

export function explicitAsset(ledger: Ledger, ref?: string | null, label = "asset_id"): string {
  // Currency is never guessed. Callers must provide an asset explicitly or use
  // an account default that has already been recorded on the ledger.
  if (!ref) throw new Error(`${label} is required; Clovis does not infer a default currency`);
  return resolveAsset(ledger, ref);
}

export function reportAsset(ledger: Ledger, ref?: string | null): string {
  return explicitAsset(ledger, ref, "quote_asset_id");
}

export function accountDefaultAsset(ledger: Ledger, accountId: string): string | null {
  const account = ledger.getAccount(accountId);
  if (account?.default_asset_id) {
    if (!ledger.getAsset(account.default_asset_id)) throw new Error(`Account '${accountId}' has invalid default_asset '${account.default_asset_id}'`);
    return account.default_asset_id;
  }
  const tags = ledger.listAnnotations("account", accountId).filter((tag) => tag.key === "default_asset");
  const value = tags.at(-1)?.value ?? null;
  if (!value) return null;
  if (!ledger.getAsset(value)) throw new Error(`Account '${accountId}' has invalid default_asset '${value}'`);
  return value;
}

export function setAccountDefaultAsset(ledger: Ledger, accountId: string, assetId?: string | null): void {
  ledger.updateAccount(accountId, { default_asset_id: assetId ? explicitAsset(ledger, assetId) : null });
  for (const tag of ledger.listAnnotations("account", accountId).filter((row) => row.key === "default_asset")) ledger.deleteAnnotation(tag.id);
}

export function accountAsset(ledger: Ledger, accountId: string, label = "asset_id"): string {
  const assetId = accountDefaultAsset(ledger, accountId);
  if (assetId) return assetId;
  throw new Error(`${label} is required because account '${accountId}' has no default_asset`);
}

export function transactionAsset(ledger: Ledger, fromAccountId: string, toAccountId: string, explicit?: string | null): string {
  if (explicit) return resolveAsset(ledger, explicit);
  const fromAsset = accountDefaultAsset(ledger, fromAccountId);
  const toAsset = accountDefaultAsset(ledger, toAccountId);
  if (!fromAsset || !toAsset) throw new Error("asset_id is required unless both accounts have default_asset set");
  if (fromAsset !== toAsset) throw new Error("asset_id is required for accounts with different default_asset values; use fx_transfer for cross-currency movement");
  return fromAsset;
}

export function rootAccountIds(ledger: Ledger, types: string[]): string[] {
  const accounts = ledger.listAccounts();
  const byId = new Map(accounts.map((row) => [row.id, row]));
  return accounts
    .filter((row) => types.includes(row.account_type))
    .filter((row) => !row.parent_id || byId.get(row.parent_id)?.account_type !== row.account_type)
    .map((row) => row.id);
}

export function nonOverlappingAccounts(ledger: Ledger, refs: string[], allowedTypes?: string[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const accountId = account(ledger, ref);
    const row = ledger.getAccount(accountId);
    if (!row) throw new Error(`Account '${accountId}' not found`);
    if (allowedTypes && !allowedTypes.includes(row.account_type)) {
      throw new Error(`Account '${row.name}' must be ${allowedTypes.join(" or ")}`);
    }
    if (!seen.has(accountId)) {
      ids.push(accountId);
      seen.add(accountId);
    }
  }
  return ids.filter((accountId) => {
    const row = ledger.getAccount(accountId);
    return !ids.some((otherId) => {
      if (otherId === accountId) return false;
      const other = ledger.getAccount(otherId);
      return other?.account_type === row?.account_type && ledger.descendants(otherId).has(accountId);
    });
  });
}

export function splitProjectionAccounts(ledger: Ledger, args: Args): { asset_account_ids?: string[]; liability_account_ids?: string[] } {
  let assetRefs = args.asset_account_ids == null ? null : [...args.asset_account_ids as string[]];
  let liabilityRefs = args.liability_account_ids == null ? null : [...args.liability_account_ids as string[]];
  for (const ref of args.account_ids ?? []) {
    const accountId = account(ledger, ref);
    const row = ledger.getAccount(accountId);
    if (!row) throw new Error(`Account '${accountId}' not found`);
    if (row.account_type === "asset") {
      assetRefs ??= [];
      assetRefs.push(accountId);
    } else if (row.account_type === "liability") {
      liabilityRefs ??= [];
      liabilityRefs.push(accountId);
    } else {
      throw new Error(`Account '${row.name}' must be asset or liability`);
    }
  }
  return {
    asset_account_ids: assetRefs ?? undefined,
    liability_account_ids: liabilityRefs ?? undefined
  };
}

export function assetScale(ledger: Ledger, assetId?: string | null): number {
  return ledger.getAsset(assetId || "")?.scale ?? 2;
}

export function display(ledger: Ledger, quantity: bigint, assetId?: string | null): number {
  return Number(fromAtomicUnits(quantity, assetScale(ledger, assetId)));
}

export function accountPublic(row: Account, ledger?: Ledger): Row {
  // Account rows carry default_asset_id directly; annotations remain readable
  // for old databases imported before schema v2.
  const defaultAssetId = ledger ? accountDefaultAsset(ledger, row.id) : null;
  const defaultAsset = defaultAssetId ? ledger?.getAsset(defaultAssetId) : null;
  return { ...row, type: row.account_type, default_asset_id: defaultAssetId, default_asset_symbol: defaultAsset?.symbol ?? null };
}

export function entriesPublic(ledger: Ledger, txId: string): Row[] {
  // Journal lines carry signed atomic quantities. Public entries add account,
  // asset, and display context without changing the underlying sign convention.
  const accounts = new Map(ledger.listAccounts().map((row) => [row.id, row]));
  const assets = new Map(ledger.listAssets().map((row) => [row.id, row]));
  return ledger.getEntries(txId).map((entry) => {
    const acct = accounts.get(entry.account_id);
    const ast = assets.get(entry.asset_id);
    return {
      ...entry,
      account_name: acct?.name ?? "",
      account_type: acct?.account_type ?? "",
      asset_symbol: ast?.symbol ?? "",
      amount_cents: entry.quantity,
      scale: ast?.scale ?? 2,
      amount_display: display(ledger, entry.quantity, entry.asset_id)
    };
  });
}

export function txPublic(ledger: Ledger, tx: Journal, compact = false): Row {
  // Representative transaction amounts are derived from the largest line. The
  // full entries array remains authoritative for multi-leg or multi-asset work.
  const entries = entriesPublic(ledger, tx.id);
  const main = entries.toSorted((a, b) => Number(BigInt(b.quantity) ** 2n - BigInt(a.quantity) ** 2n))[0];
  const amount = main ? (BigInt(main.quantity) < 0n ? -BigInt(main.quantity) : BigInt(main.quantity)) : 0n;
  const tags = ledger.listAnnotations("tx", tx.id);
  if (compact) {
    const { entries: _entries, tags: _tags, ...header } = tx as Row;
    void _entries;
    void _tags;
    return {
      ...header,
      amount,
      amount_cents: amount,
      amount_display: main ? display(ledger, amount, String(main.asset_id)) : 0,
      entry_count: entries.length,
      tag_count: tags.length,
      account_ids: [...new Set(entries.map((entry) => String(entry.account_id)))],
      asset_ids: [...new Set(entries.map((entry) => String(entry.asset_id)))]
    };
  }
  const out: Row = {
    ...tx,
    entries,
    amount,
    amount_cents: amount,
    amount_display: main ? display(ledger, amount, String(main.asset_id)) : 0,
    tags
  };
  return out;
}

export function txWithEntries(ledger: Ledger, txId: string): Row {
  const tx = ledger.getTx(txId);
  if (!tx) throw new Error(`Transaction '${txId}' not found`);
  return txPublic(ledger, tx);
}

function categoryTagValue(row: Row): string | null {
  const key = String(row.key ?? "").toLowerCase();
  if (!CATEGORIZATION_TAG_KEYS.has(key)) return null;
  const value = row.value ?? row.val;
  return value == null ? null : String(value);
}

export function categorizationText(row: Row, annotations: Row[] = []): string {
  const values: string[] = [String(row.description ?? "")];
  const tags = row.tags;
  if (Array.isArray(tags)) {
    for (const tag of tags) {
      const value = categoryTagValue(tag);
      if (value) values.push(value);
    }
  } else if (tags && typeof tags === "object") {
    for (const [key, value] of Object.entries(tags)) {
      if (CATEGORIZATION_TAG_KEYS.has(key.toLowerCase()) && value != null) values.push(String(value));
    }
  }
  for (const tag of annotations) {
    const value = categoryTagValue(tag);
    if (value) values.push(value);
  }
  return values.map((value) => value.trim()).filter(Boolean).join(" ").slice(0, MAX_MATCH_INPUT_LENGTH);
}

export function transactionCategorizationText(ledger: Ledger, tx: Journal): string {
  return categorizationText(tx as unknown as Row, ledger.listAnnotations("tx", tx.id));
}

export function directedTxPublic(ledger: Ledger, tx: Journal, fromAccountId: string, toAccountId: string): Row {
  return {
    ...txPublic(ledger, tx),
    from_account: fromAccountId,
    to_account: toAccountId
  };
}

export function reportStatus(args: Args, fallback: TxStatus | "active" | "combined" | null): TxStatus | "active" | "combined" | null {
  if (args.status !== undefined && args.status !== "") return parseTxStatusFilter(args.status, fallback);
  if (args.include_pending === true) return "active";
  if (args.include_pending === false) return "posted";
  return fallback;
}

export function iterTransactions(ledger: Ledger, args: { status?: string | null; includePending?: boolean; date_from?: string | null; date_to?: string | null } = {}): Journal[] {
  const status = parseTxStatusFilter(args.status, args.includePending ? "active" : null);
  const rows = ledger.listTransactions({ status: null, dateFrom: optionalDate(args.date_from), dateTo: optionalDate(args.date_to), sort: "date_asc" });
  return rows.filter((tx) => txMatchesStatusFilter(tx, status));
}

export function amountForAccount(ledger: Ledger, txId: string, accountId: string, assetId?: string | null): bigint {
  return ledger.getEntries(txId).filter((entry) => entry.account_id === accountId && (!assetId || entry.asset_id === assetId)).reduce((sum, entry) => sum + entry.quantity, 0n);
}

export function recategorizePreview(ledger: Ledger, args: Args): Row {
  const tx = ledger.getTx(String(args.tx_id));
  if (!tx) throw new Error(`Transaction '${String(args.tx_id)}' not found`);
  if (tx.status === "void") throw new Error("Cannot recategorize a void transaction");
  if (ledger.listLots().some((lot) => lot.opened_journal_id === tx.id || lot.closed_journal_id === tx.id)) {
    throw new Error("Transaction has linked investment lots; use an investment reversal workflow");
  }
  const entries = ledger.getEntries(tx.id);
  const oldAccount = args.old_account_id
    ? account(ledger, args.old_account_id)
    : entries.find((entry) => ledger.getAccount(entry.account_id)?.account_type === "expense")?.account_id
      ?? entries.toSorted((a, b) => Number((b.quantity < 0n ? -b.quantity : b.quantity) - (a.quantity < 0n ? -a.quantity : a.quantity)))[0]?.account_id;
  if (!oldAccount) throw new Error("Transaction has no entries");
  const newAccount = account(ledger, args.new_account_id);
  const changedEntries = entries.filter((entry) => entry.account_id === oldAccount);
  if (changedEntries.length === 0) throw new Error(`Account ${oldAccount} is not on transaction ${tx.id}`);
  const oldRow = ledger.getAccount(oldAccount);
  const newRow = ledger.getAccount(newAccount);
  if (!newRow) throw new Error(`Account ${newAccount} not found`);
  const correctionDate = validateDate(String(args.correction_date ?? args.date ?? tx.date));
  const correctionLines = changedEntries.flatMap((entry) => [
    { account_id: oldAccount, asset_id: entry.asset_id, quantity: -entry.quantity },
    { account_id: newAccount, asset_id: entry.asset_id, quantity: entry.quantity }
  ]);
  const before = txWithEntries(ledger, tx.id);
  const after = {
    transaction_id: tx.id,
    original_transaction_status: tx.status,
    correction_date: correctionDate,
    correction_lines: correctionLines,
    old_account_id: oldAccount,
    old_account_name: oldRow?.name ?? "",
    new_account_id: newAccount,
    new_account_name: newRow.name
  };
  return {
    dry_run: true,
    tool: "recategorize_transaction",
    reversible: true,
    tx_id: tx.id,
    before_category: { account_id: oldAccount, account_name: oldRow?.name ?? "" },
    after_category: { account_id: newAccount, account_name: newRow.name },
    diff: [{
      entity_type: "tx",
      entity_id: tx.id,
      action: tx.status === "posted" ? "correction" : "update",
      before,
      after,
      before_hash: stableHash(before),
      after_hash: stableHash(after)
    }],
    affected_reports: {
      budgets: [...new Set([oldAccount, newAccount])],
      income_statement: true,
      cash_projection: false
    }
  };
}

export function applyRecategorizeTransaction(ledger: Ledger, args: Args): Row {
  const preview = recategorizePreview(ledger, args);
  const tx = ledger.getTx(String(preview.tx_id))!;
  if (tx.status !== "posted") {
    const diff = preview.diff[0] as Row;
    const result = ledger.recategorizeTransaction(tx.id, String(preview.before_category.account_id), String(preview.after_category.account_id));
    const operation = recordMutationAudit(ledger, {
      tool_name: "recategorize_transaction",
      operation_type: "recategorize_transaction",
      input: { ...args, dry_run: false },
      preview,
      result,
      metadata: { reversible: true, mode: "in_place_non_posted" }
    }, [{
      entity_type: "tx",
      entity_id: tx.id,
      action: "update",
      before: diff.before,
      after: txWithEntries(ledger, tx.id),
      before_hash: diff.before_hash,
      after_hash: stableHash(txWithEntries(ledger, tx.id))
    }]);
    return { ...result, operation_id: operation.id, dry_run: false };
  }

  const correctionLines = (preview.diff[0] as Row).after.correction_lines as Row[];
  const correctionId = ledger.postTx(String((preview.diff[0] as Row).after.correction_date), "posted", `Correction: recategorize ${tx.description}`, correctionLines.map((line) => [
    String(line.account_id),
    String(line.asset_id),
    BigInt(line.quantity as string | number | bigint | boolean)
  ]));
  tagTx(ledger, correctionId, "ledger_operation_kind", "recategorize_transaction");
  const correction = txWithEntries(ledger, correctionId);
  const operation = recordMutationAudit(ledger, {
    tool_name: "recategorize_transaction",
    operation_type: "recategorize_transaction",
    input: { ...args, dry_run: false },
    preview,
    result: { correction_journal_id: correctionId },
    metadata: { reversible: true, mode: "append_only_correction" }
  }, [{
    entity_type: "tx",
    entity_id: tx.id,
    action: "correction",
    before: (preview.diff[0] as Row).before,
    after: { ...(preview.diff[0] as Row).after, correction },
    before_hash: (preview.diff[0] as Row).before_hash,
    after_hash: stableHash({ ...(preview.diff[0] as Row).after, correction }),
    correction_journal_id: correctionId
  }]);
  tagTx(ledger, correctionId, "ledger_operation", String(operation.id));
  return {
    tx_id: tx.id,
    from_account_id: preview.before_category.account_id,
    to_account_id: preview.after_category.account_id,
    correction_journal_id: correctionId,
    operation_id: operation.id,
    dry_run: false
  };
}

export function normalizedDescription(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function compatibleDescription(left: unknown, right: unknown): boolean {
  const a = normalizedDescription(left);
  const b = normalizedDescription(right);
  if (!a || !b) return true;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const aTokens = new Set(a.split(" ").filter((token) => token.length >= 3));
  const bTokens = b.split(" ").filter((token) => token.length >= 3);
  if (aTokens.size === 0 || bTokens.length === 0) return false;
  const overlap = bTokens.filter((token) => aTokens.has(token)).length;
  return overlap >= Math.min(2, aTokens.size, bTokens.length);
}

export function txTouchesAccountTree(ledger: Ledger, txId: string, accountIds: Set<string>): boolean {
  return ledger.getEntries(txId).some((entry) => accountIds.has(entry.account_id));
}

export function realizedPlannedRows(ledger: Ledger, args: Args = {}): Row[] {
  const tolerance = Number(args.date_tolerance_days ?? 3);
  const [monthStart, monthFinish] = args.year == null ? [null, null] : monthBounds(Number(args.year), args.month == null ? null : Number(args.month));
  const dateFrom = optionalDate(args.date_from) ?? monthStart;
  const dateTo = optionalDate(args.date_to) ?? monthFinish;
  const explicitAccountIds = args.account_ids
    ? new Set((args.account_ids as string[]).flatMap((ref) => [...ledger.descendants(account(ledger, ref))]))
    : args.account_id
      ? ledger.descendants(account(ledger, args.account_id))
      : null;
  const assetId = args.asset_id ? explicitAsset(ledger, args.asset_id) : null;
  const planned = ledger.listTransactions({ status: null, dateFrom, dateTo, sort: "date_asc" })
    .filter(isProjectionPlannedTx)
    .filter((tx) => !explicitAccountIds || txTouchesAccountTree(ledger, tx.id, explicitAccountIds));
  const landed = ledger.listTransactions({ status: null, sort: "date_asc" })
    .filter(isRealizedPlannedLandedTx)
    .filter((tx) => !explicitAccountIds || txTouchesAccountTree(ledger, tx.id, explicitAccountIds));
  const rows: Row[] = [];
  for (const plannedTx of planned) {
    const plannedEntries = ledger.getEntries(plannedTx.id)
      .filter((entry) => (!explicitAccountIds || explicitAccountIds.has(entry.account_id)) && (!assetId || entry.asset_id === assetId));
    if (plannedEntries.length === 0) continue;
    const candidates: Row[] = [];
    for (const landedTx of landed) {
      if (landedTx.id === plannedTx.id) continue;
      if (dateDeltaDays(plannedTx.date, landedTx.date) > tolerance) continue;
      if (!compatibleDescription(plannedTx.description, landedTx.description)) continue;
      for (const plannedEntry of plannedEntries) {
        const landedQuantity = amountForAccount(ledger, landedTx.id, plannedEntry.account_id, plannedEntry.asset_id);
        if (landedQuantity !== plannedEntry.quantity) continue;
        candidates.push({
          journal_id: landedTx.id,
          tx_id: landedTx.id,
          date: landedTx.date,
          description: landedTx.description,
          status: landedTx.status,
          account_id: plannedEntry.account_id,
          asset_id: plannedEntry.asset_id,
          amount_cents: landedQuantity,
          date_delta_days: dateDeltaDays(plannedTx.date, landedTx.date),
          reasons: ["account", "amount", "date_tolerance", "description"]
        });
      }
    }
    if (candidates.length === 0) continue;
    const uniqueCandidates = [...new Map(candidates.map((candidate) => [candidate.journal_id, candidate])).values()];
    const primary = uniqueCandidates[0];
    rows.push({
      planned_tx_id: plannedTx.id,
      tx_id: plannedTx.id,
      date: plannedTx.date,
      description: plannedTx.description,
      status: plannedTx.status,
      matched_tx_id: primary.journal_id,
      matched_status: primary.status,
      matched_date: primary.date,
      matched_description: primary.description,
      account_id: primary.account_id,
      asset_id: primary.asset_id,
      amount_cents: primary.amount_cents,
      candidates: uniqueCandidates,
      ambiguous: uniqueCandidates.length > 1
    });
  }
  return rows;
}

export function transactionMagnitude(ledger: Ledger, txId: string, accountId?: string | null): bigint {
  return ledger.getEntries(txId)
    .filter((entry) => !accountId || entry.account_id === accountId)
    .reduce((max, entry) => {
      const amount = entry.quantity < 0n ? -entry.quantity : entry.quantity;
      return amount > max ? amount : max;
    }, 0n);
}

export function amountWithinTolerance(left: bigint, right: bigint, tolerancePct: number): boolean {
  if (left === right) return true;
  const base = left > right ? left : right;
  if (base === 0n) return left === right;
  return Number((left > right ? left - right : right - left) * 10000n / base) <= tolerancePct * 100;
}

export function recurringDateRange(args: Args): [string | null, string | null] {
  if (args.year != null) return monthBounds(Number(args.year), args.month == null ? null : Number(args.month));
  const end = new Date(`${today()}T00:00:00Z`);
  const start = new Date(end);
  start.setUTCMonth(start.getUTCMonth() - Number(args.months ?? 6));
  start.setUTCDate(start.getUTCDate() + 1);
  return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)];
}

export function batch(ledger: Ledger, label?: string | null, metadata: Row = {}, status = "open"): string {
  return ledger.createSource("import", label, metadata, status);
}

export function txIdsForBatch(ledger: Ledger, batchId: string): string[] {
  return [...new Set([
    ...ledger.listTransactionIdsForSource(batchId),
    ...ledger.listAnnotationEntityIds("tx", "import_batch", batchId)
  ])].sort();
}

export function tagTx(ledger: Ledger, txId: string, key: string, value: string): void {
  if (!ledger.listAnnotations("tx", txId).some((tag) => tag.key === key && (tag.val === value || tag.value === value))) {
    ledger.createAnnotation("tx", txId, key, value);
  }
}

export function selectBatchTransactions(ledger: Ledger, args: Args): string[] {
  const selected = new Set<string>(args.tx_ids ?? []);
  if (args.batch_id) for (const txId of txIdsForBatch(ledger, args.batch_id)) selected.add(txId);
  const acct = args.account_id ? account(ledger, args.account_id) : null;
  if (selected.size === 0) {
    for (const tx of ledger.listTransactions({ status: "pending", dateFrom: optionalDate(args.date_from), dateTo: optionalDate(args.date_to) })) {
      if (acct && !ledger.getEntries(tx.id).some((entry) => entry.account_id === acct)) continue;
      selected.add(tx.id);
    }
  }
  return [...selected].sort();
}

export function unsupportedArguments(values: Args): void {
  const names = Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== false && value !== "" && !(Array.isArray(value) && value.length === 0)).map(([key]) => key);
  if (names.length) throw new Error(`Unsupported MCP parameter(s): ${names.join(", ")}`);
}

export function safeMatchRegex(pattern: unknown): RegExp {
  // Regex rules are user-provided and can run across many rows, so they are
  // length-bounded and reject obvious catastrophic-backtracking shapes.
  const value = String(pattern ?? "");
  if (!value) throw new Error("pattern is required");
  if (value.length > MAX_MATCH_PATTERN_LENGTH) throw new Error(`pattern must be ${MAX_MATCH_PATTERN_LENGTH} characters or fewer`);
  if (NESTED_QUANTIFIER_PATTERN.test(value)) throw new Error("pattern is too complex");
  try {
    return new RegExp(value, "i");
  } catch (error) {
    throw new Error(`Invalid pattern: ${error instanceof Error ? error.message : String(error)}`);
  }
}
