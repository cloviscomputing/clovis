import type { Journal, TxStatus } from "../core/types.js";

export type TxStatusFilter = TxStatus | "active" | "combined" | "all" | null | undefined;
export type TxLike = Pick<Journal, "status">;

export const LIVE_TX_STATUSES = ["posted", "pending", "planned"] as const satisfies readonly TxStatus[];
export const ACTIVE_TX_STATUSES = ["posted", "pending"] as const satisfies readonly TxStatus[];
export const COMBINED_TX_STATUSES = ["posted", "pending", "planned"] as const satisfies readonly TxStatus[];

const LIVE = new Set<string>(LIVE_TX_STATUSES);
const ACTIVE = new Set<string>(ACTIVE_TX_STATUSES);
const COMBINED = new Set<string>(COMBINED_TX_STATUSES);

export function isLiveTxStatus(status: unknown): boolean {
  return LIVE.has(String(status));
}

export function isActiveTxStatus(status: unknown): boolean {
  return ACTIVE.has(String(status));
}

export function isPlannedTxStatus(status: unknown): boolean {
  return status === "planned";
}

export function txStatusSet(filter: TxStatusFilter): Set<string> | null {
  if (filter == null || filter === "all") return null;
  if (filter === "active") return new Set(ACTIVE);
  if (filter === "combined") return new Set(COMBINED);
  return new Set([filter]);
}

export function txMatchesStatusFilter(tx: TxLike, filter: TxStatusFilter): boolean {
  const allowed = txStatusSet(filter);
  return allowed ? allowed.has(tx.status) : isLiveTxStatus(tx.status);
}

export function isImportDedupeCandidate(tx: TxLike): boolean {
  return isActiveTxStatus(tx.status);
}

export function isStatementMatchCandidate(tx: TxLike): boolean {
  return isActiveTxStatus(tx.status);
}

export function isRealizedPlannedLandedTx(tx: TxLike): boolean {
  return isActiveTxStatus(tx.status);
}

export function isProjectionPlannedTx(tx: TxLike): boolean {
  return isPlannedTxStatus(tx.status);
}

export function isBulkCategorizationCandidate(tx: TxLike): boolean {
  return isActiveTxStatus(tx.status);
}
