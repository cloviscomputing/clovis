import type { Ledger } from "../core/ledger.js";
import type { Journal } from "../core/types.js";

type Row = Record<string, any>;

export type TransactionDeletionPlan = {
  mode: "void" | "hard_delete";
  matched: number;
  tx_ids: string[];
  blockers: Row[];
  hard_delete_safe: boolean;
};

export type TransactionDeletionPreview = TransactionDeletionPlan & {
  total_tx_ids: number;
  total_blockers: number;
  sample_limit?: number;
  output_truncated?: boolean;
};

function countRows(ledger: Ledger, table: string, predicate: (row: Row) => boolean): number {
  return ledger.tableRows(table).filter(predicate).length;
}

function sampleLimit(value: unknown): number | null {
  if (value == null) return null;
  const limit = Number(value);
  if (!Number.isFinite(limit)) return null;
  return Math.max(0, Math.trunc(limit));
}

function hardDeleteBlockers(ledger: Ledger, tx: Journal): Row[] {
  const checks: Row[] = [
    {
      table: "lots",
      reason: "transaction has linked investment lots",
      count: countRows(ledger, "lots", (row) => row.opened_journal_id === tx.id || row.closed_journal_id === tx.id)
    },
    {
      table: "statement_plan_rows",
      reason: "transaction is referenced by a statement plan",
      count: countRows(ledger, "statement_plan_rows", (row) => row.matched_journal_id === tx.id || row.created_journal_id === tx.id)
    },
    {
      table: "ledger_operation_rows",
      reason: "transaction is referenced by operation audit rows",
      count: countRows(ledger, "ledger_operation_rows", (row) => (
        row.correction_journal_id === tx.id
        || row.reverse_journal_id === tx.id
        || (["journals", "tx"].includes(String(row.entity_type)) && row.entity_id === tx.id)
      ))
    }
  ];
  return checks.filter((row) => row.count > 0).map((row) => ({ tx_id: tx.id, ...row }));
}

export function planTransactionDeletion(ledger: Ledger, txIds: string[], hardDelete = false): TransactionDeletionPlan {
  const ids = [...new Set(txIds.map(String))];
  const transactions = ids.map((txId) => {
    const tx = ledger.getTx(txId);
    if (!tx) throw new Error(`Transaction ${txId} not found`);
    return tx;
  });
  const blockers = hardDelete ? transactions.flatMap((tx) => hardDeleteBlockers(ledger, tx)) : [];
  return {
    mode: hardDelete ? "hard_delete" : "void",
    matched: transactions.length,
    tx_ids: transactions.map((tx) => tx.id),
    blockers,
    hard_delete_safe: !hardDelete || blockers.length === 0
  };
}

export function presentTransactionDeletionPlan(plan: TransactionDeletionPlan, requestedLimit?: unknown): TransactionDeletionPreview {
  const limit = sampleLimit(requestedLimit);
  const txIds = limit == null ? plan.tx_ids : plan.tx_ids.slice(0, limit);
  const blockers = limit == null ? plan.blockers : plan.blockers.slice(0, limit);
  const output: TransactionDeletionPreview = {
    ...plan,
    tx_ids: txIds,
    blockers,
    total_tx_ids: plan.tx_ids.length,
    total_blockers: plan.blockers.length
  };
  if (limit != null) {
    output.sample_limit = limit;
    output.output_truncated = txIds.length < plan.tx_ids.length || blockers.length < plan.blockers.length;
  }
  return output;
}

export function assertTransactionDeletionAllowed(plan: TransactionDeletionPlan): void {
  if (plan.blockers.length === 0) return;
  const summary = plan.blockers.map((row) => `${row.tx_id}:${row.table} ${row.count} (${row.reason})`).join(", ");
  throw new Error(`Hard delete blocked by ledger references: ${summary}`);
}
