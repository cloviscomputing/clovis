import { Ledger } from "../core/ledger.js";
import type { TxStatus } from "../core/types.js";
import { normalAmount } from "../core/accounting.js";
import { isProjectionPlannedTx } from "./transaction-lifecycle.js";
import { parseTxStatusFilter, validateDate } from "./validation.js";
import {
  account,
  addMonths,
  amountForAccount,
  assetScale,
  display,
  iterTransactions,
  monthBounds,
  monthEnd,
  nonOverlappingAccounts,
  optionalDate,
  realizedPlannedRows,
  reportAsset,
  rootAccountIds,
  today,
  type Args,
  type Row
} from "./transaction-helpers.js";

export function budgetRows(ledger: Ledger, accountId?: string | null, year?: number | null, month?: number | null): Row[] {
  return ledger.listBudgetTargets({ accountId, year, month });
}

export function budgetSpecificity(row: Row): number {
  return (row.period === "monthly" ? 100 : 50) + (row.year == null ? 0 : 10) + (row.month == null ? 0 : 5);
}

export function effectiveBudgetRows(ledger: Ledger, accountId?: string | null, year?: number | null, month?: number | null): { rows: Row[]; shadowed: Row[] } {
  const selected = new Map<string, Row>();
  const shadowed: Row[] = [];
  for (const row of budgetRows(ledger, accountId, year, month)) {
    const key = `${row.account_id}|${row.asset_id}`;
    const current = selected.get(key);
    if (!current) {
      selected.set(key, row);
      continue;
    }
    if (budgetSpecificity(row) >= budgetSpecificity(current)) {
      shadowed.push(current);
      selected.set(key, row);
    } else {
      shadowed.push(row);
    }
  }
  return { rows: [...selected.values()], shadowed };
}

export function spendingRows(ledger: Ledger, year?: number | null, month?: number | null, status: TxStatus | "active" | "combined" | null = "posted", quoteAssetId?: string | null, returnMissing = false): Row[] | { rows: Row[]; missing: Row[] } {
  const quote = reportAsset(ledger, quoteAssetId);
  const [date_from, date_to] = monthBounds(year, month);
  const accounts = new Map(ledger.listAccounts().map((row) => [row.id, row]));
  const totals = new Map<string, bigint>();
  const missing: Row[] = [];
  for (const tx of iterTransactions(ledger, { status, date_from, date_to })) {
    for (const entry of ledger.getEntries(tx.id)) {
      const acct = accounts.get(entry.account_id);
      if (!acct || acct.account_type !== "expense") continue;
      const [converted, error] = ledger.tryConvertQuantity(entry.quantity, entry.asset_id, quote, tx.date);
      if (converted == null) {
        missing.push({ tx_id: tx.id, account_id: entry.account_id, asset_id: entry.asset_id, quote_asset_id: quote, quantity: entry.quantity, error });
        continue;
      }
      totals.set(entry.account_id, (totals.get(entry.account_id) ?? 0n) + converted);
    }
  }
  const rows = [...totals.entries()]
    .filter(([, amount]) => amount !== 0n)
    .sort((a, b) => Number(b[1] - a[1]))
    .map(([accountId, amount]) => ({
      account_id: accountId,
      account_name: accounts.get(accountId)?.name ?? "",
      asset_id: quote,
      amount,
      amount_cents: amount,
      quantity: amount,
      scale: assetScale(ledger, quote),
      amount_display: display(ledger, amount, quote)
    }));
  return returnMissing ? { rows, missing } : rows;
}

export type ProjectionReportStatus = TxStatus | "active" | "combined" | null;

export type ProjectionStatusResolution = {
  status: ProjectionReportStatus;
  includePending: boolean;
  includePlanned: boolean;
  explicitStatus: boolean;
  warnings: Row[];
};

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  if (value === true) return true;
  if (value === false) return false;
  return fallback;
}

function projectionFallbackStatus(includePending: boolean, includePlanned: boolean): Exclude<ProjectionReportStatus, null> {
  if (includePending && includePlanned) return "combined";
  if (includePending) return "active";
  if (includePlanned) return "planned";
  return "posted";
}

function statusIncludesPending(status: ProjectionReportStatus): boolean {
  return status == null || status === "active" || status === "combined" || status === "pending";
}

function statusIncludesPlanned(status: ProjectionReportStatus): boolean {
  return status == null || status === "combined" || status === "planned";
}

export function resolveProjectionStatus(args: Args, defaults: { includePending?: boolean; includePlanned?: boolean } = {}): ProjectionStatusResolution {
  const requestedIncludePending = optionalBoolean(args.include_pending, defaults.includePending ?? false);
  const requestedIncludePlanned = optionalBoolean(args.include_planned, defaults.includePlanned ?? false);
  const fallbackStatus = projectionFallbackStatus(requestedIncludePending, requestedIncludePlanned);
  const explicitStatus = args.status !== undefined && args.status !== null && args.status !== "";
  const status = explicitStatus ? parseTxStatusFilter(args.status, fallbackStatus) : fallbackStatus;
  const includePending = explicitStatus ? statusIncludesPending(status) : requestedIncludePending;
  const includePlanned = explicitStatus ? statusIncludesPlanned(status) : requestedIncludePlanned;
  const warnings: Row[] = [];
  if (explicitStatus) {
    if (args.include_pending !== undefined && Boolean(args.include_pending) !== includePending) {
      warnings.push({
        code: "status_overrides_include_pending",
        message: `Explicit status '${String(args.status)}' overrides include_pending:${Boolean(args.include_pending)}; resolved include_pending:${includePending}.`
      });
    }
    if (args.include_planned !== undefined && Boolean(args.include_planned) !== includePlanned) {
      warnings.push({
        code: "status_overrides_include_planned",
        message: `Explicit status '${String(args.status)}' overrides include_planned:${Boolean(args.include_planned)}; resolved include_planned:${includePlanned}.`
      });
    }
  }
  return { status, includePending, includePlanned, explicitStatus, warnings };
}

export function incomeStatementRows(ledger: Ledger, year: number, month: number | null, status: TxStatus | "active" | "combined" | null = "posted", quoteAssetId?: string | null): Row {
  const quote = reportAsset(ledger, quoteAssetId);
  const [date_from, date_to] = monthBounds(year, month);
  const accounts = new Map(ledger.listAccounts().map((row) => [row.id, row]));
  const income = new Map<string, Row>();
  const expense = new Map<string, Row>();
  const missing: Row[] = [];
  for (const tx of iterTransactions(ledger, { status, date_from, date_to })) {
    for (const entry of ledger.getEntries(tx.id)) {
      const acct = accounts.get(entry.account_id);
      if (!acct || !["income", "expense"].includes(acct.account_type)) continue;
      const [converted, error] = ledger.tryConvertQuantity(entry.quantity, entry.asset_id, quote, tx.date);
      if (converted == null) {
        missing.push({ tx_id: tx.id, account_id: entry.account_id, asset_id: entry.asset_id, quote_asset_id: quote, quantity: entry.quantity, error });
        continue;
      }
      const target = acct.account_type === "income" ? income : expense;
      const current = target.get(acct.id) ?? { account_id: acct.id, account_name: acct.name, account_type: acct.account_type, normal_balance: acct.normal_balance, amount: 0n };
      current.amount = BigInt(current.amount) + normalAmount(acct.account_type, converted);
      target.set(acct.id, current);
    }
  }
  const scale = assetScale(ledger, quote);
  const normalize = (rows: Row[]) => rows.map((row) => ({
    ...row,
    amount: row.amount,
    amount_cents: row.amount,
    quantity: row.amount,
    scale,
    asset_id: quote,
    amount_display: display(ledger, BigInt(row.amount), quote)
  }));
  const incomeRows = normalize([...income.values()].sort((a, b) => String(a.account_name).localeCompare(String(b.account_name))));
  const expenseRows = normalize([...expense.values()].sort((a, b) => Number(BigInt(b.amount) - BigInt(a.amount))));
  const incomeTotal = incomeRows.reduce((sum, row) => sum + BigInt(row.amount), 0n);
  const expenseTotal = expenseRows.reduce((sum, row) => sum + BigInt(row.amount), 0n);
  return {
    year,
    month,
    income: incomeTotal,
    expense: expenseTotal,
    net: incomeTotal - expenseTotal,
    income_by_account: incomeRows,
    expense_by_account: expenseRows,
    quote_asset_id: quote,
    scale,
    valuation_complete: missing.length === 0,
    missing_conversions: missing
  };
}

export function conversionSeverity(missing: Row[], options: { recommendedModel?: string | null } = {}): Row {
  if (missing.length === 0) {
    return {
      severity: "none",
      materiality: "none",
      missing_count: 0,
      message: "All requested balances converted into the report currency."
    };
  }
  const affectedSections = uniqueStrings(missing.flatMap((row) => row.affected_sections ?? []));
  const affectedModels = uniqueStrings(missing.flatMap((row) => row.affected_models ?? []));
  const recommendedModel = options.recommendedModel ?? null;
  const recommendedModelAffected = recommendedModel ? affectedModels.includes(recommendedModel) : null;
  return {
    severity: recommendedModelAffected === false && affectedModels.length > 0 ? "warning" : "unknown",
    materiality: "unknown",
    materiality_basis: "missing_price",
    missing_count: missing.length,
    affected_sections: affectedSections,
    affected_models: affectedModels,
    recommended_model: recommendedModel,
    recommended_model_affected: recommendedModelAffected,
    message: recommendedModelAffected === false
      ? "One or more balances could not be converted, but the recommended runway model is not directly affected."
      : "One or more balances could not be converted into the report currency, so materiality cannot be calculated safely."
  };
}

export function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.flatMap((value) => Array.isArray(value) ? value : [value]).map((value) => String(value ?? "")).filter(Boolean))];
}

export function missingConversionKey(row: Row): string {
  return [
    row.tx_id ?? "",
    row.account_id ?? "",
    row.asset_id ?? "",
    row.quote_asset_id ?? "",
    String(row.quantity ?? ""),
    row.error ?? ""
  ].join("|");
}

export function enrichMissingConversion(ledger: Ledger, row: Row): Row {
  const accountRow = row.account_id ? ledger.getAccount(String(row.account_id)) : null;
  const assetRow = row.asset_id ? ledger.getAsset(String(row.asset_id)) : null;
  const quoteRow = row.quote_asset_id ? ledger.getAsset(String(row.quote_asset_id)) : null;
  const quantity = row.quantity == null ? null : BigInt(row.quantity);
  return {
    ...row,
    account_name: accountRow?.name ?? null,
    account_type: accountRow?.account_type ?? null,
    asset_symbol: assetRow?.symbol ?? null,
    quote_asset_symbol: quoteRow?.symbol ?? null,
    quantity_display: quantity == null || !row.asset_id ? null : display(ledger, quantity, String(row.asset_id)),
    absolute_quantity_display: quantity == null || !row.asset_id ? null : display(ledger, quantity < 0n ? -quantity : quantity, String(row.asset_id)),
    materiality: "unknown",
    materiality_basis: "missing_price"
  };
}

export function scopedMissingConversions(ledger: Ledger, sources: Array<{ rows?: Row[] | null; section: string; affectedModels?: string[] }>): Row[] {
  const byKey = new Map<string, Row>();
  for (const source of sources) {
    for (const row of source.rows ?? []) {
      const key = missingConversionKey(row);
      const current = byKey.get(key) ?? enrichMissingConversion(ledger, row);
      current.affected_sections = uniqueStrings([...(current.affected_sections ?? []), source.section]);
      current.affected_models = uniqueStrings([...(current.affected_models ?? []), ...(source.affectedModels ?? [])]);
      byKey.set(key, current);
    }
  }
  return [...byKey.values()];
}

export function runwayMonths(cash: bigint, monthlyBurn: bigint): number | null {
  if (monthlyBurn <= 0n) return null;
  return Math.round((Number(cash) / Number(monthlyBurn)) * 100) / 100;
}

export function spendableAssetAccountDefaults(ledger: Ledger): { selected: string[]; excluded: string[]; rule: string } {
  const roots = rootAccountIds(ledger, ["asset"]);
  const assetAccounts = ledger.listAccounts().filter((row) => row.account_type === "asset");
  const accountMap = new Map(assetAccounts.map((row) => [row.id, row]));
  const accountName = (accountId: string) => ledger.getAccount(accountId)?.name ?? "";
  const illiquid = /\b(brokerage|investment|investing|security|securities|stock|stocks|crypto|coinbase|retirement|tfsa|rrsp|rsp|401k|ira|roth|pension|property|real estate|vehicle)\b/i;
  const cashLike = /\b(cash|checking|chequing|savings?|bank|operating|wallet)\b/i;
  const hasIlliquidName = (accountId: string): boolean => {
    let current: string | null | undefined = accountId;
    while (current) {
      if (illiquid.test(accountName(current))) return true;
      current = accountMap.get(current)?.parent_id ?? null;
    }
    return false;
  };
  const selectedAncestors = (selectedIds: string[]): Set<string> => {
    const ancestors = new Set<string>();
    for (const selected of selectedIds) {
      let current = accountMap.get(selected)?.parent_id ?? null;
      while (current) {
        ancestors.add(current);
        current = accountMap.get(current)?.parent_id ?? null;
      }
    }
    return ancestors;
  };
  const liquid = assetAccounts.filter((row) => cashLike.test(row.name) && !hasIlliquidName(row.id)).map((row) => row.id);
  const selected = nonOverlappingAccounts(ledger, liquid.length > 0 ? liquid : roots.filter((accountId) => !hasIlliquidName(accountId)), ["asset"]);
  const covered = new Set(selected);
  for (const selectedId of selected) for (const child of ledger.descendants(selectedId)) covered.add(child);
  const ancestors = selectedAncestors(selected);
  return {
    selected,
    excluded: assetAccounts.map((row) => row.id).filter((accountId) => !covered.has(accountId) && !ancestors.has(accountId)),
    rule: liquid.length > 0
      ? "cash-like asset accounts, excluding obvious investment and illiquid account names"
      : "root asset accounts excluding obvious investment and illiquid account names"
  };
}

export function trailingWindowEnd(year: number, month: number, asOf: string, includePartialMonth: boolean): Row {
  if (includePartialMonth || monthEnd(year, month) < asOf) {
    return { year, month, basis: includePartialMonth ? "requested_month_including_partial" : "requested_month_complete", excluded_partial_month: null };
  }
  const previous = addMonths(year, month, -1);
  return {
    ...previous,
    basis: "last_complete_months",
    excluded_partial_month: { year, month, as_of: asOf }
  };
}

export function trailingSpend(ledger: Ledger, year: number, month: number, months: number, quote: string, includeSources = false): Row {
  const monthRows: Row[] = [];
  const missing: Row[] = [];
  for (let offset = months - 1; offset >= 0; offset -= 1) {
    const period = addMonths(year, month, -offset);
    const result = spendingRows(ledger, period.year, period.month, "posted", quote, true) as { rows: Row[]; missing: Row[] };
    const total = result.rows.reduce((sum, row) => sum + BigInt(row.amount_cents), 0n);
    monthRows.push({ year: period.year, month: period.month, spending_cents: total, ...(includeSources ? { categories: result.rows } : {}) });
    missing.push(...result.missing);
  }
  const total = monthRows.reduce((sum, row) => sum + BigInt(row.spending_cents), 0n);
  return {
    months,
    total_cents: total,
    monthly_burn_cents: total / BigInt(months),
    month_rows: monthRows,
    missing_conversions: missing
  };
}

export function trailingSummary(row: Row): Row {
  return {
    months: row.months,
    total_cents: row.total_cents,
    monthly_burn_cents: row.monthly_burn_cents,
    month_rows: row.month_rows,
    missing_conversion_count: (row.missing_conversions as Row[] ?? []).length
  };
}

export function budgetSummary(row: Row): Row {
  return {
    total_budgeted_cents: row.total_budgeted_cents ?? 0n,
    total_spent_cents: row.total_spent_cents ?? 0n,
    total_remaining_cents: row.total_remaining_cents ?? 0n,
    budget_count: (row.budgets as Row[] ?? []).length,
    valuation_complete: row.valuation_complete,
    missing_conversion_count: (row.missing_conversions as Row[] ?? []).length
  };
}

function spendMap(rows: Row[]): Map<string, bigint> {
  return new Map(rows.map((row) => [String(row.account_id), BigInt(row.amount_cents ?? 0)]));
}

type ExpenseSpendBucket = { missing: Row[]; totals: Map<string, bigint> };

type ExpenseSpendBuckets = {
  periodEnd: string;
  posted: ExpenseSpendBucket;
  pending: ExpenseSpendBucket;
  planned: ExpenseSpendBucket;
  realizedPlanned: Row[];
  missing: Row[];
};

function spendRowsForStatus(ledger: Ledger, year: number, month: number, status: TxStatus | "active" | "combined" | null, quote: string): ExpenseSpendBucket {
  const result = spendingRows(ledger, year, month, status, quote, true) as { rows: Row[]; missing: Row[] };
  return { missing: result.missing, totals: spendMap(result.rows) };
}

function plannedExpenseSpendRows(ledger: Ledger, year: number, month: number, quote: string, realizedIds: Set<string>): ExpenseSpendBucket {
  const [dateFrom, dateTo] = monthBounds(year, month);
  const accounts = new Map(ledger.listAccounts().map((row) => [row.id, row]));
  const totals = new Map<string, bigint>();
  const missing: Row[] = [];
  for (const tx of ledger.listTransactions({ status: null, dateFrom, dateTo, sort: "date_asc" }).filter(isProjectionPlannedTx)) {
    if (realizedIds.has(tx.id)) continue;
    for (const entry of ledger.getEntries(tx.id)) {
      const acct = accounts.get(entry.account_id);
      if (!acct || acct.account_type !== "expense") continue;
      const [converted, error] = ledger.tryConvertQuantity(entry.quantity, entry.asset_id, quote, tx.date);
      if (converted == null) {
        missing.push({ tx_id: tx.id, account_id: entry.account_id, asset_id: entry.asset_id, quote_asset_id: quote, quantity: entry.quantity, error });
        continue;
      }
      totals.set(entry.account_id, (totals.get(entry.account_id) ?? 0n) + converted);
    }
  }
  return { missing, totals };
}

function expenseSpendBuckets(ledger: Ledger, year: number, month: number, quote: string, plannedMatchToleranceDays: number): ExpenseSpendBuckets {
  const [periodStart, periodEnd] = monthBounds(year, month);
  const expenseAccountIds = ledger.listAccounts().filter((row) => row.account_type === "expense").map((row) => row.id);
  const realizedPlanned = expenseAccountIds.length > 0 ? realizedPlannedRows(ledger, {
    year,
    month,
    date_from: periodStart,
    date_to: periodEnd,
    account_ids: expenseAccountIds,
    date_tolerance_days: plannedMatchToleranceDays
  }) : [];
  const realizedPlannedIds = new Set(realizedPlanned.map((row) => String(row.planned_tx_id)));
  const posted = spendRowsForStatus(ledger, year, month, "posted", quote);
  const pending = spendRowsForStatus(ledger, year, month, "pending", quote);
  const planned = plannedExpenseSpendRows(ledger, year, month, quote, realizedPlannedIds);
  return {
    periodEnd,
    posted,
    pending,
    planned,
    realizedPlanned,
    missing: [...posted.missing, ...pending.missing, ...planned.missing]
  };
}

function budgetExposureBasis(includePending: boolean, includePlanned: boolean): string {
  if (includePending && includePlanned) return "posted_plus_pending_plus_planned_known";
  if (includePending) return "posted_plus_pending";
  if (includePlanned) return "posted_plus_planned_known";
  return "posted_only";
}

export function budgetExposure(ledger: Ledger, args: Args): Row {
  const nowDate = new Date();
  const year = Number(args.year ?? nowDate.getUTCFullYear());
  const month = Number(args.month ?? nowDate.getUTCMonth() + 1);
  const quote = reportAsset(ledger, args.quote_asset_id);
  const includePending = args.include_pending !== false;
  const includePlanned = args.include_planned === true;
  const { periodEnd, posted, pending, planned, realizedPlanned, missing } = expenseSpendBuckets(ledger, year, month, quote, args.planned_match_tolerance_days ?? args.date_tolerance_days ?? 3);
  const effective = effectiveBudgetRows(ledger, null, year, month);
  const daysTotal = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const daysElapsed = year === nowDate.getUTCFullYear() && month === nowDate.getUTCMonth() + 1 ? nowDate.getUTCDate() : daysTotal;
  const budgetAccountIds = new Set<string>();
  const categoryRows = effective.rows.flatMap((budget) => {
    const accountId = String(budget.account_id);
    budgetAccountIds.add(accountId);
    const [budgeted, error] = ledger.tryConvertQuantity(BigInt(budget.quantity), String(budget.asset_id), quote);
    if (budgeted == null) {
      missing.push({ account_id: accountId, asset_id: budget.asset_id, quote_asset_id: quote, quantity: budget.quantity, error });
      return [];
    }
    const postedSpend = posted.totals.get(accountId) ?? 0n;
    const pendingSpend = pending.totals.get(accountId) ?? 0n;
    const plannedSpend = planned.totals.get(accountId) ?? 0n;
    const activeSpend = postedSpend + pendingSpend;
    const includedPending = includePending ? pendingSpend : 0n;
    const includedPlanned = includePlanned ? plannedSpend : 0n;
    const projectedSpend = postedSpend + includedPending + includedPlanned;
    const overBudgetNow = activeSpend > budgeted ? activeSpend - budgeted : 0n;
    const projectedOverBudget = projectedSpend > budgeted ? projectedSpend - budgeted : 0n;
    const pace = budgeted * BigInt(daysElapsed) / BigInt(daysTotal);
    return [{
      account_id: accountId,
      account_name: ledger.getAccount(accountId)?.name ?? "",
      asset_id: quote,
      source_budget_id: budget.id,
      budgeted_cents: budgeted,
      posted_spent_cents: postedSpend,
      pending_spend_cents: pendingSpend,
      planned_known_spend_cents: plannedSpend,
      active_spend_cents: activeSpend,
      known_projected_spend_cents: projectedSpend,
      spent_cents: activeSpend,
      remaining_cents: budgeted - activeSpend,
      remaining_budget_now_cents: budgeted - activeSpend,
      projected_remaining_budget_cents: budgeted - projectedSpend,
      budget_variance_now_cents: budgeted - activeSpend,
      projected_budget_variance_cents: budgeted - projectedSpend,
      over_budget_now_cents: overBudgetNow,
      projected_over_budget_cents: projectedOverBudget,
      percent_used: budgeted ? Number(activeSpend) / Number(budgeted) * 100 : 0,
      projected_percent_used: budgeted ? Number(projectedSpend) / Number(budgeted) * 100 : 0,
      pace_cents: pace,
      pace: activeSpend > pace ? "over" : "on_track",
      projected_pace: projectedSpend > budgeted ? "over_budget" : activeSpend > pace ? "over_pace" : "on_track"
    }];
  });
  const coveredTotal = (totals: Map<string, bigint>): bigint => [...budgetAccountIds].reduce((sum, accountId) => sum + (totals.get(accountId) ?? 0n), 0n);
  const unbudgetedAccountIds = new Set([...posted.totals.keys(), ...pending.totals.keys(), ...planned.totals.keys()].filter((accountId) => !budgetAccountIds.has(accountId)));
  const unbudgetedRows = [...unbudgetedAccountIds].map((accountId) => {
    const postedSpend = posted.totals.get(accountId) ?? 0n;
    const pendingSpend = pending.totals.get(accountId) ?? 0n;
    const plannedSpend = planned.totals.get(accountId) ?? 0n;
    const activeSpend = postedSpend + pendingSpend;
    const projectedSpend = postedSpend + (includePending ? pendingSpend : 0n) + (includePlanned ? plannedSpend : 0n);
    return {
      account_id: accountId,
      account_name: ledger.getAccount(accountId)?.name ?? "",
      asset_id: quote,
      posted_spent_cents: postedSpend,
      pending_spend_cents: pendingSpend,
      planned_known_spend_cents: plannedSpend,
      active_spend_cents: activeSpend,
      known_projected_spend_cents: projectedSpend
    };
  }).filter((row) => BigInt(row.known_projected_spend_cents) !== 0n || BigInt(row.active_spend_cents) !== 0n);
  const totalBudgeted = categoryRows.reduce((sum, row) => sum + BigInt(row.budgeted_cents), 0n);
  const postedSpent = coveredTotal(posted.totals);
  const pendingSpend = coveredTotal(pending.totals);
  const plannedKnownSpend = coveredTotal(planned.totals);
  const activeSpend = postedSpent + pendingSpend;
  const knownProjectedSpend = postedSpent + (includePending ? pendingSpend : 0n) + (includePlanned ? plannedKnownSpend : 0n);
  const overBudgetNow = activeSpend > totalBudgeted ? activeSpend - totalBudgeted : 0n;
  const projectedOverBudget = knownProjectedSpend > totalBudgeted ? knownProjectedSpend - totalBudgeted : 0n;
  const unbudgetedActiveSpend = unbudgetedRows.reduce((sum, row) => sum + BigInt(row.active_spend_cents), 0n);
  const unbudgetedKnownProjectedSpend = unbudgetedRows.reduce((sum, row) => sum + BigInt(row.known_projected_spend_cents), 0n);
  const activeExpense = activeSpend + unbudgetedActiveSpend;
  const knownProjectedExpense = knownProjectedSpend + unbudgetedKnownProjectedSpend;
  const activeExpenseOverBudget = activeExpense > totalBudgeted ? activeExpense - totalBudgeted : 0n;
  const knownProjectedExpenseOverBudget = knownProjectedExpense > totalBudgeted ? knownProjectedExpense - totalBudgeted : 0n;
  const warnings = [
    ...(includePlanned && realizedPlanned.length > 0 ? ["excluded realized planned expense rows from planned budget exposure; run reconcile_planned to void or review them"] : []),
    ...(unbudgetedKnownProjectedSpend !== 0n ? ["known projected spend includes unbudgeted expense accounts; review unbudgeted_spending for budget coverage"] : [])
  ];
  return {
    year,
    month,
    as_of: periodEnd,
    basis: budgetExposureBasis(includePending, includePlanned),
    scope: "budgeted_expense_accounts",
    include_pending: includePending,
    include_planned: includePlanned,
    total_budgeted_cents: totalBudgeted,
    posted_spent_cents: postedSpent,
    pending_spend_cents: pendingSpend,
    planned_known_spend_cents: plannedKnownSpend,
    active_spend_cents: activeSpend,
    known_projected_spend_cents: knownProjectedSpend,
    unbudgeted_active_spend_cents: unbudgetedActiveSpend,
    unbudgeted_known_projected_spend_cents: unbudgetedKnownProjectedSpend,
    active_expense_cents: activeExpense,
    known_projected_expense_cents: knownProjectedExpense,
    remaining_budget_now_cents: totalBudgeted - activeSpend,
    projected_remaining_budget_cents: totalBudgeted - knownProjectedSpend,
    budget_variance_now_cents: totalBudgeted - activeSpend,
    projected_budget_variance_cents: totalBudgeted - knownProjectedSpend,
    over_budget_now_cents: overBudgetNow,
    projected_over_budget_cents: projectedOverBudget,
    is_over_budget_now: activeSpend > totalBudgeted,
    is_projected_over_budget: knownProjectedSpend > totalBudgeted,
    active_expense_over_budget_cents: activeExpenseOverBudget,
    known_projected_expense_over_budget_cents: knownProjectedExpenseOverBudget,
    is_active_expense_over_budget: activeExpense > totalBudgeted,
    is_known_projected_expense_over_budget: knownProjectedExpense > totalBudgeted,
    is_projection_floor: true,
    unplanned_future_spend_cents: null,
    message: "Known projected spend excludes future unplanned transactions.",
    categories: categoryRows,
    overspend_risk: categoryRows.filter((row) => BigInt(row.remaining_cents) < 0n),
    projected_overspend_risk: categoryRows.filter((row) => BigInt(row.projected_over_budget_cents) > 0n),
    unbudgeted_spending: unbudgetedRows,
    shadowed_budget_count: effective.shadowed.length,
    shadowed_budgets: effective.shadowed.map((row) => ({ id: row.id, account_id: row.account_id, asset_id: row.asset_id, quantity: row.quantity, period: row.period, year: row.year, month: row.month })),
    realized_planned_rows: realizedPlanned,
    realized_planned_count: realizedPlanned.length,
    warnings,
    valuation_complete: missing.length === 0,
    missing_conversions: missing,
    conversion_warning: conversionSeverity(missing)
  };
}

export function cashProjectionSummary(row: Row): Row {
  return {
    basis: row.basis,
    actual_available_cash_cents: row.actual_available_cash_cents,
    available_cash_cents: row.available_cash_cents,
    pending_available_delta_cents: row.pending_available_delta_cents,
    planned_available_delta_cents: row.planned_available_delta_cents,
    earmarks_cents: row.earmarks_cents,
    liability_effect_cents: row.liability_effect_cents,
    remaining_budget_cents: row.remaining_budget_cents,
    planned_income_cents: row.planned_income_cents,
    realized_planned_count: row.realized_planned_count,
    warnings: row.warnings,
    valuation_complete: row.valuation_complete,
    missing_conversion_count: (row.missing_conversions as Row[] ?? []).length
  };
}

export function positive(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

export function scaleBigint(value: bigint, multiplier: number): bigint {
  return value * BigInt(Math.round(multiplier * 10000)) / 10000n;
}

export function quotedPlannedUnrealized(ledger: Ledger, accountId: string, quote: string, asOf: string, dateFrom: string | null, realizedIds: Set<string>, missing: Row[]): bigint {
  const rootType = ledger.getAccount(accountId)?.account_type;
  const accountIds = new Set([...ledger.descendants(accountId)].filter((id) => ledger.getAccount(id)?.account_type === rootType));
  let total = 0n;
  for (const tx of ledger.listTransactions({ status: null, dateFrom, dateTo: asOf, sort: "date_asc" }).filter(isProjectionPlannedTx)) {
    if (realizedIds.has(tx.id)) continue;
    for (const entry of ledger.getEntries(tx.id).filter((line) => accountIds.has(line.account_id))) {
      const [converted, error] = ledger.tryConvertQuantity(entry.quantity, entry.asset_id, quote, tx.date);
      if (converted == null) missing.push({ tx_id: tx.id, account_id: entry.account_id, asset_id: entry.asset_id, quote_asset_id: quote, quantity: entry.quantity, error });
      else total += converted;
    }
  }
  return total;
}

export function ageOfMoney(ledger: Ledger, args: Args): Row {
  const quote = reportAsset(ledger, args.quote_asset_id);
  const asOf = today();
  const cutoffDate = new Date(`${asOf}T00:00:00Z`);
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - Number(args.days ?? 30));
  const dateFrom = cutoffDate.toISOString().slice(0, 10);
  const assetAccounts = new Set(ledger.listAccounts().filter((row) => row.account_type === "asset").map((row) => row.id));
  const lots: Array<{ date: string; quantity: bigint }> = [];
  const missing: Row[] = [];
  let income = 0n;
  let outflow = 0n;

  for (const tx of ledger.listTransactions({ status: "posted", dateFrom, dateTo: asOf, sort: "date_asc" })) {
    let delta = 0n;
    for (const entry of ledger.getEntries(tx.id).filter((line) => assetAccounts.has(line.account_id))) {
      const [converted, error] = ledger.tryConvertQuantity(entry.quantity, entry.asset_id, quote, tx.date);
      if (converted == null) {
        missing.push({ tx_id: tx.id, account_id: entry.account_id, asset_id: entry.asset_id, quote_asset_id: quote, quantity: entry.quantity, error });
        continue;
      }
      delta += converted;
    }
    if (delta > 0n) {
      income += delta;
      lots.push({ date: tx.date, quantity: delta });
      continue;
    }
    if (delta < 0n) {
      let remaining = -delta;
      outflow += remaining;
      while (remaining > 0n && lots.length) {
        const lot = lots[0];
        const used = lot.quantity < remaining ? lot.quantity : remaining;
        lot.quantity -= used;
        remaining -= used;
        if (lot.quantity === 0n) lots.shift();
      }
    }
  }

  const remaining = lots.reduce((sum, lot) => sum + lot.quantity, 0n);
  const weightedDays = lots.reduce((sum, lot) => {
    const age = Math.max(0, Math.floor((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${lot.date}T00:00:00Z`)) / 86400000));
    return sum + Number(lot.quantity) * age;
  }, 0);

  return {
    days: args.days ?? 30,
    date_from: dateFrom,
    as_of: asOf,
    quote_asset_id: quote,
    income_cents: income,
    outflow_cents: outflow,
    remaining_cents: remaining,
    average_age_days: remaining === 0n ? 0 : weightedDays / Number(remaining),
    valuation_complete: missing.length === 0,
    missing_conversions: missing
  };
}
