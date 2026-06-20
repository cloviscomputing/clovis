import { safeJson } from "./json.js";
import { statementDetailMode } from "./read-view.js";

type Row = Record<string, any>;

export function planRowsByAction(rows: Row[]): Record<string, Row[]> {
  const grouped: Record<string, Row[]> = {};
  for (const row of rows) {
    const action = String(row.action);
    grouped[action] = [...(grouped[action] ?? []), row];
  }
  return grouped;
}

export function publicPlanRows(rows: Row[]): Row[] {
  return rows.map((row) => {
    const metadata = safeJson(row.metadata_json ?? row.metadata);
    const sourceRow = safeJson(metadata.source_row);
    const quantity = BigInt(row.quantity as string | number | bigint | boolean);
    return {
      ...row,
      metadata,
      quantity,
      amount_cents: quantity,
      amount: sourceRow.amount ?? metadata.amount ?? null,
      candidates: metadata.candidates ?? []
    };
  });
}

function samplePlanRows(grouped: Record<string, Row[]>, limit: number): Row[] {
  if (limit <= 0) return [];
  const priority = ["ambiguous", "pending_to_commit", "stale_pending_to_void", "new_posted", "new_pending", "matched", "ignored"];
  const out: Row[] = [];
  for (const action of priority) {
    for (const row of grouped[action] ?? []) {
      if (out.length >= limit) return out;
      out.push(row);
    }
  }
  return out;
}

export function statementPlanOutput(plan: Row | null, rows: Row[], extra: Row = {}): Row {
  const publicRows = publicPlanRows(rows);
  const grouped = planRowsByAction(publicRows);
  const summary = Object.fromEntries(["matched", "pending_to_commit", "new_posted", "new_pending", "stale_pending_to_void", "ambiguous", "ignored"].map((action) => [action, grouped[action]?.length ?? 0]));
  const realizedPlannedRows = (extra.realized_planned_rows as Row[] | undefined) ?? [];
  const includeDetails = statementDetailMode(extra);
  const warnings = [
    ...(summary.ambiguous > 0 ? ["ambiguous rows require manual review"] : []),
    ...(realizedPlannedRows.length > 0 ? ["realized planned rows should be reconciled or voided before planned projections"] : [])
  ];
  const details = includeDetails ? {
    matched_rows: grouped.matched ?? [],
    pending_to_commit: grouped.pending_to_commit ?? [],
    stale_pending_to_void: grouped.stale_pending_to_void ?? [],
    new_posted: grouped.new_posted ?? [],
    new_pending: grouped.new_pending ?? [],
    ambiguous: grouped.ambiguous ?? [],
    ignored: grouped.ignored ?? []
  } : {};
  return {
    plan_id: plan?.id ?? null,
    status: plan?.status ?? "preview",
    account_id: plan?.account_id ?? extra.account_id,
    asset_id: plan?.asset_id ?? extra.asset_id,
    expected_balance_cents: plan?.expected_balance ?? extra.expected_balance_cents ?? null,
    planned_balance_cents: plan?.planned_balance ?? extra.planned_balance_cents ?? null,
    applied_balance_cents: plan?.applied_balance ?? null,
    balance_matches: extra.balance_matches ?? null,
    balance_sign: extra.balance_sign ?? null,
    available_actions: ["plan", "apply", "verify", "discard"],
    rows: samplePlanRows(grouped, Number(extra.sample_limit ?? 20)),
    total_rows: publicRows.length,
    actions: summary,
    matched: summary.matched,
    unmatched: summary.new_posted + summary.new_pending + summary.pending_to_commit + summary.stale_pending_to_void + summary.ambiguous,
    reconciled: summary.new_posted + summary.new_pending + summary.pending_to_commit + summary.stale_pending_to_void + summary.ambiguous === 0,
    detail_rows_included: includeDetails,
    realized_planned_rows: realizedPlannedRows,
    realized_planned_count: realizedPlannedRows.length,
    warnings,
    dry_run: extra.dry_run ?? true,
    ...extra,
    ...details
  };
}
