import type { Account, AccountType } from "./types.js";

export type NormalSide = "debit" | "credit";

// Accounting reports use normal balances for presentation; journal storage uses
// signed quantities and remains balanced per asset.
export function normalSide(accountType: AccountType): NormalSide {
  switch (accountType) {
    case "asset":
    case "expense":
      return "debit";
    case "liability":
    case "equity":
    case "income":
      return "credit";
  }
}

export function statement(accountType: AccountType): "balance_sheet" | "income_statement" {
  return accountType === "income" || accountType === "expense" ? "income_statement" : "balance_sheet";
}

export function normalAmount(accountType: AccountType, raw: bigint): bigint {
  return normalSide(accountType) === "debit" ? raw : -raw;
}

export function debitCredit(raw: bigint): { debit: bigint; credit: bigint } {
  return raw >= 0n ? { debit: raw, credit: 0n } : { debit: 0n, credit: -raw };
}

export function annotateAccount<T extends { account_type?: AccountType; type?: AccountType }>(row: T): T & Account {
  const accountType = (row.account_type ?? row.type) as AccountType;
  return {
    ...row,
    account_type: accountType,
    type: accountType,
    normal_balance: normalSide(accountType),
    statement: statement(accountType)
  } as T & Account;
}

export function annotateAmounts(accountType: AccountType, raw: bigint) {
  const normal = normalAmount(accountType, raw);
  const dc = debitCredit(raw);
  return {
    normal_balance: normalSide(accountType),
    normal_balance_cents: normal,
    accounting_balance: normal,
    debit: dc.debit,
    credit: dc.credit
  };
}
