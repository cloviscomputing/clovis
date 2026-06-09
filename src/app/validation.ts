import type { Ledger } from "../core/ledger.js";
import type { AccountType, AssetType, TxStatus } from "../core/types.js";
import { toAtomicUnits } from "../core/money.js";

// App-level validation normalizes user-facing arguments before they cross into
// core. Core still enforces accounting invariants and foreign-key integrity.
export function validateDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("date must be YYYY-MM-DD");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) throw new Error("date must be YYYY-MM-DD");
  return value;
}

export function parseSmartDate(value: string): string {
  const text = value.trim().toLowerCase();
  const today = new Date();
  if (text === "today") return today.toISOString().slice(0, 10);
  if (text === "yesterday") {
    today.setUTCDate(today.getUTCDate() - 1);
    return today.toISOString().slice(0, 10);
  }
  if (text === "tomorrow") {
    today.setUTCDate(today.getUTCDate() + 1);
    return today.toISOString().slice(0, 10);
  }
  return validateDate(value);
}

export function parseMonth(month: number): number {
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error("month must be 1-12");
  return month;
}

export function parseAccountType(value: string): AccountType {
  if (!["asset", "liability", "equity", "income", "expense"].includes(value)) throw new Error(`Invalid account type: ${value}`);
  return value as AccountType;
}

export function parseAssetType(value: string): AssetType {
  if (!["currency", "commodity", "custom", "security"].includes(value)) throw new Error(`Invalid asset type: ${value}`);
  return value as AssetType;
}

export function parseTxStatus(value?: string | null): TxStatus | null {
  if (value == null || value === "") return null;
  if (!["posted", "pending", "planned", "void"].includes(value)) throw new Error(`Invalid transaction status: ${value}`);
  return value as TxStatus;
}

export function resolveAsset(ledger: Ledger, ref?: string | null, symbol?: string | null): string {
  // Symbol creation is explicit here for import/init flows. Generic operations
  // should pass an asset id or resolve an account default before calling core.
  if (ref) {
    const byId = ledger.getAsset(ref);
    if (byId) return byId.id;
    const bySymbol = ledger.getAssetBySymbol(ref);
    if (bySymbol) return bySymbol.id;
    throw new Error(`Asset '${ref}' not found`);
  }
  if (symbol) {
    const normalized = symbol.toUpperCase();
    return ledger.getAssetBySymbol(normalized)?.id ?? ledger.createAsset(normalized, "currency", normalized === "JPY" ? 0 : 2, normalized);
  }
  throw new Error("asset_id is required; Clovis does not infer a default currency");
}

export function amountToQuantity(ledger: Ledger, assetId: string, amount: number | string | bigint): bigint {
  const asset = ledger.getAsset(assetId);
  if (!asset) throw new Error(`Asset '${assetId}' not found`);
  return toAtomicUnits(amount, asset.scale);
}

export function resolveAccount(ledger: Ledger, ref?: string | null): string {
  if (!ref) throw new Error("account is required");
  const account = ledger.findAccount(ref);
  if (!account) throw new Error(`Account '${ref}' not found`);
  return account.id;
}
