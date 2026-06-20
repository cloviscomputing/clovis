import { annotateAmounts } from "../core/accounting.js";
import { fromAtomicUnits } from "../core/money.js";
import type { AccountType, Journal } from "../core/types.js";
import type { Ledger } from "../core/ledger.js";
import { resolveAccount } from "./validation.js";

type Args = Record<string, any>;
type Row = Record<string, any>;

export function resolveScopedAccounts(
  ledger: Ledger,
  args: Args,
  allowedTypes?: AccountType[]
): { scoped: boolean; root_account_ids: string[]; account_ids: Set<string> | null } {
  const refs = [
    ...((args.account_ids ?? []) as string[]),
    ...(args.entity_id == null || args.entity_id === "" ? [] : [String(args.entity_id)])
  ];
  if (refs.length === 0) return { scoped: false, root_account_ids: [], account_ids: null };

  const allowed = allowedTypes ? new Set<AccountType>(allowedTypes) : null;
  const selected = new Set<string>();
  for (const ref of refs) {
    const root = resolveAccount(ledger, ref);
    for (const id of ledger.descendants(root)) {
      const account = ledger.getAccount(id);
      if (account && (!allowed || allowed.has(account.account_type))) selected.add(id);
    }
  }
  if (selected.size === 0) throw new Error("Scope contains no supported accounts");

  return {
    scoped: true,
    root_account_ids: [...selected].filter((id) => !hasSelectedSameTypeAncestor(ledger, id, selected)),
    account_ids: selected
  };
}

export function hasSelectedSameTypeAncestor(ledger: Ledger, accountId: string, selected: Set<string>): boolean {
  const account = ledger.getAccount(accountId);
  let parentId = account?.parent_id ?? null;
  while (parentId) {
    const parent = ledger.getAccount(parentId);
    if (parent && selected.has(parent.id) && parent.account_type === account?.account_type) return true;
    parentId = parent?.parent_id ?? null;
  }
  return false;
}

export function presentAccountBalance(
  ledger: Ledger,
  accountId: string,
  assetId: string,
  quantity: bigint | number | string,
  presentation: unknown = "ledger"
): Row {
  const account = ledger.getAccount(accountId);
  if (!account) throw new Error(`Account '${accountId}' not found`);
  const asset = ledger.getAsset(assetId);
  const scale = asset?.scale ?? 2;
  const ledgerQuantity = BigInt(quantity);
  const mode = normalizePresentationMode(presentation);
  const displayQuantity = mode === "banking" && account.account_type === "liability" ? -ledgerQuantity : ledgerQuantity;
  const amounts = annotateAmounts(account.account_type, ledgerQuantity);
  return {
    ledger_balance_cents: ledgerQuantity,
    ledger_balance_display: Number(fromAtomicUnits(ledgerQuantity, scale)),
    display_balance_cents: displayQuantity,
    display_balance: Number(fromAtomicUnits(displayQuantity, scale)),
    display_sign_basis: mode,
    ...amounts,
    debit_cents: amounts.debit,
    credit_cents: amounts.credit,
    normal_balance_display: Number(fromAtomicUnits(amounts.normal_balance_cents, scale))
  };
}

export function normalizePresentationMode(presentation: unknown): "ledger" | "banking" {
  const mode = String(presentation ?? "ledger").toLowerCase().replace(/[\s_-]+/g, "");
  return mode === "bank" || mode === "banking" ? "banking" : "ledger";
}

export function compactTransactionEffects(ledger: Ledger, tx: Journal, args: Args = {}): Row[] {
  if (args.include_account_effects !== true) return [];
  return ledger.getEntries(tx.id).map((entry) => {
    const account = ledger.getAccount(entry.account_id);
    const asset = ledger.getAsset(entry.asset_id);
    const presented = presentAccountBalance(ledger, entry.account_id, entry.asset_id, entry.quantity, "banking");
    const displayEffect = BigInt(presented.display_balance_cents);
    return {
      account_id: entry.account_id,
      account_name: account?.name ?? "",
      account_type: account?.account_type ?? "",
      asset_id: entry.asset_id,
      asset_symbol: asset?.symbol ?? "",
      scale: asset?.scale ?? 2,
      quantity: entry.quantity,
      quantity_cents: entry.quantity,
      ledger_quantity_cents: entry.quantity,
      display_effect_cents: displayEffect,
      display_effect: presented.display_balance,
      display_sign_basis: "banking",
      effect: displayEffect >= 0n ? "increase" : "decrease"
    };
  });
}

export function statementDetailMode(args: Args = {}): boolean {
  return args.include_details === true || String(args.verbosity ?? "").toLowerCase() === "audit";
}
