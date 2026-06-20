import { toAtomicUnits } from "../core/money.js";
import type { Ledger } from "../core/ledger.js";
import { amountToQuantity } from "./validation.js";

type AmountInput = string | number | bigint;

type RowLike = Record<string, unknown>;

function atomicQuantity(value: unknown, label: string): bigint {
  try {
    return BigInt(value as string | number | bigint | boolean);
  } catch {
    throw new Error(`${label} must be an integer atomic quantity`);
  }
}

export function signedMoneyAmount(ledger: Ledger, assetId: string, amount: AmountInput, _label = "Amount"): bigint {
  return amountToQuantity(ledger, assetId, amount);
}

export function positiveMoneyAmount(ledger: Ledger, assetId: string, amount: AmountInput, label = "Amount"): bigint {
  const quantity = signedMoneyAmount(ledger, assetId, amount, label);
  if (quantity <= 0n) throw new Error(`${label} must be positive`);
  return quantity;
}

export function nonNegativeMoneyAmount(ledger: Ledger, assetId: string, amount: AmountInput, label = "Amount"): bigint {
  const quantity = signedMoneyAmount(ledger, assetId, amount, label);
  if (quantity < 0n) throw new Error(`${label} cannot be negative`);
  return quantity;
}

export function signedAtomicQuantity(value: unknown, label = "Quantity"): bigint {
  return atomicQuantity(value, label);
}

export function positiveAtomicQuantity(value: unknown, label = "Quantity"): bigint {
  const quantity = atomicQuantity(value, label);
  if (quantity <= 0n) throw new Error(`${label} must be positive`);
  return quantity;
}

export function positiveShareQuantity(value: AmountInput, label = "Shares"): bigint {
  const quantity = toAtomicUnits(value, 8);
  if (quantity <= 0n) throw new Error(`${label} must be positive`);
  return quantity;
}

export function statementQuantity(ledger: Ledger, assetId: string, row: RowLike, amountConvention?: unknown): bigint {
  const quantity = row.amount_cents != null || row.quantity != null
    ? signedAtomicQuantity(row.amount_cents ?? row.quantity, "Statement amount")
    : signedMoneyAmount(ledger, assetId, (row.amount ?? 0) as AmountInput, "Statement amount");
  return amountConvention === "unsigned_charges" ? -((quantity < 0n) ? -quantity : quantity) : quantity;
}

export function journalLegQuantity(ledger: Ledger, assetId: string, leg: RowLike): bigint {
  if (leg.amount != null) return signedMoneyAmount(ledger, assetId, leg.amount as AmountInput, "Journal leg amount");
  if (leg.amount_cents != null) return signedAtomicQuantity(leg.amount_cents, "Journal leg amount");
  if (leg.quantity != null) return signedAtomicQuantity(leg.quantity, "Journal leg quantity");
  if (leg.qty_cents != null) return signedAtomicQuantity(leg.qty_cents, "Journal leg quantity");
  if (leg.qty != null) return signedAtomicQuantity(leg.qty, "Journal leg quantity");
  return 0n;
}
