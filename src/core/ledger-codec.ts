import { randomUUID } from "node:crypto";
import { annotateAccount } from "./accounting.js";
import { scaledToNumber, roundRatio } from "./money.js";
import type { Account, AccountType, Asset, AssetType, Journal, JournalLine, Price, TxStatus } from "./types.js";
import { InvariantError } from "./types.js";

export type Row = Record<string, unknown>;

export type PostTxOptions = {
  sourceId?: string | null;
  externalId?: string | null;
};

export type LedgerOptions = {
  bookId?: string | null;
};

export type BudgetTargetOptions = {
  accountId?: string | null;
  year?: number | null;
  month?: number | null;
};

export function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

export function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function dateOnly(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("date must be YYYY-MM-DD");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error("date must be YYYY-MM-DD");
  }
  return value;
}

export function monthBounds(year: number, month?: number | null): [string, string] {
  if (month == null) return [`${year.toString().padStart(4, "0")}-01-01`, `${year.toString().padStart(4, "0")}-12-31`];
  if (month < 1 || month > 12) throw new Error("month must be 1-12");
  const start = `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-01`;
  const endDate = new Date(Date.UTC(year, month, 0));
  return [start, endDate.toISOString().slice(0, 10)];
}

export function accountType(value: string): AccountType {
  if (!["asset", "liability", "equity", "income", "expense"].includes(value)) {
    throw new Error(`Invalid account type: ${value}`);
  }
  return value as AccountType;
}

export function txStatus(value: string): TxStatus {
  if (!["posted", "pending", "planned", "void"].includes(value)) {
    throw new Error(`Invalid transaction status: ${value}`);
  }
  return value as TxStatus;
}

export function assetType(value: string): AssetType {
  if (!["currency", "commodity", "custom", "security"].includes(value)) {
    throw new Error(`Invalid asset type: ${value}`);
  }
  return value as AssetType;
}

export function integerInRange(value: unknown, label: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

export function assetScaleValue(value: unknown, label = "scale"): number {
  return integerInRange(value, label, 0, 18);
}

export function targetPeriod(value: string): string {
  if (!["monthly", "yearly"].includes(value)) throw new Error("period must be monthly or yearly");
  return value;
}

export function monthValue(value: number | null | undefined): number | null {
  if (value == null) return null;
  return integerInRange(value, "month", 1, 12);
}

export function yearValue(value: number | null | undefined): number | null {
  if (value == null) return null;
  return integerInRange(value, "year", 1, 9999);
}

export function recurrenceFrequency(value: string): string {
  if (!["daily", "weekly", "monthly", "yearly"].includes(value)) {
    throw new Error("frequency must be daily, weekly, monthly, or yearly");
  }
  return value;
}

export function positiveQuantity(value: bigint | number, label: string): bigint {
  const quantity = BigInt(value);
  if (quantity <= 0n) throw new Error(`${label} must be positive`);
  return quantity;
}

export function boolDate(value: unknown): string | null {
  return value == null ? null : String(value);
}

export function toAsset(row: Row | undefined): Asset | null {
  if (!row) return null;
  const type = assetType(String(row.type));
  const scale = Number(row.scale);
  return {
    id: String(row.id),
    symbol: String(row.symbol),
    type,
    asset_type: type,
    scale,
    decimals: scale,
    name: String(row.name ?? "")
  };
}

export function toAccount(row: Row | undefined): Account | null {
  if (!row) return null;
  return annotateAccount({
    id: String(row.id),
    book_id: String(row.book_id),
    name: String(row.name),
    type: accountType(String(row.type)),
    account_type: accountType(String(row.type)),
    parent_id: boolDate(row.parent_id),
    default_asset_id: boolDate(row.default_asset_id),
    code: String(row.code ?? ""),
    color_hex: String(row.color_hex ?? "#888888")
  });
}

export function toJournal(row: Row | undefined): Journal | null {
  if (!row) return null;
  const date = String(row.date);
  return {
    id: String(row.id),
    book_id: String(row.book_id),
    date,
    time: date,
    posted_at: String(row.posted_at),
    status: txStatus(String(row.status)),
    description: String(row.description ?? ""),
    source_id: boolDate(row.source_id),
    external_id: boolDate(row.external_id)
  };
}

export function toLine(row: Row | undefined): JournalLine | null {
  if (!row) return null;
  const quantity = BigInt(row.quantity as bigint | number | string);
  const journalId = String(row.journal_id);
  return {
    id: String(row.id),
    journal_id: journalId,
    tx_id: journalId,
    account_id: String(row.account_id),
    asset_id: String(row.asset_id),
    quantity,
    qty: quantity,
    qty_cents: quantity
  };
}

export function toPrice(row: Row | undefined): Price | null {
  if (!row) return null;
  const value = BigInt(row.rate_value as bigint | number | string);
  const scale = Number(row.rate_scale);
  const rate = scaledToNumber(value, scale);
  return {
    id: String(row.id),
    book_id: String(row.book_id),
    asset_id: String(row.asset_id),
    quote_asset_id: String(row.quote_asset_id),
    quote_id: String(row.quote_asset_id),
    rate_value: value,
    rate_scale: scale,
    rate_cents: Number(roundRatio(value * 100n, 10n ** BigInt(scale))),
    rate,
    time: String(row.time)
  };
}

export function validateLines(lines: Array<[string, string, bigint]>): void {
  if (lines.length === 0) throw new InvariantError("transaction must have entries");
  const totals = new Map<string, bigint>();
  for (const [, assetId, quantity] of lines) {
    if (quantity < -(2n ** 63n) || quantity > 2n ** 63n - 1n) {
      throw new InvariantError("quantity outside SQLite integer range");
    }
    totals.set(assetId, (totals.get(assetId) ?? 0n) + quantity);
  }
  const imbalanced = [...totals.entries()].filter(([, quantity]) => quantity !== 0n);
  if (imbalanced.length) {
    throw new InvariantError(`entries must balance to zero per asset: ${imbalanced.map(([asset]) => asset).join(", ")}`);
  }
}
