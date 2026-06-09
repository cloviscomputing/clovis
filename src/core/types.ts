// Public core types intentionally include a few compatibility aliases
// (`asset_type`, `account_type`, `qty_cents`) while core storage stays canonical.
export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";
export type AssetType = "currency" | "commodity" | "custom" | "security";
export type TxStatus = "posted" | "pending" | "planned" | "void";
export type BookType = "actual" | "scenario";

export interface Asset {
  id: string;
  symbol: string;
  type: AssetType;
  asset_type: AssetType;
  scale: number;
  decimals: number;
  name: string;
}

export interface Account {
  id: string;
  book_id: string;
  name: string;
  type: AccountType;
  account_type: AccountType;
  parent_id: string | null;
  code: string;
  color_hex: string;
  normal_balance: "debit" | "credit";
  statement: "balance_sheet" | "income_statement";
}

export interface Journal {
  id: string;
  book_id: string;
  date: string;
  time: string;
  posted_at: string;
  status: TxStatus;
  description: string;
  source_id: string | null;
  external_id: string | null;
}

export interface JournalLine {
  id: string;
  journal_id: string;
  tx_id: string;
  account_id: string;
  asset_id: string;
  quantity: bigint;
  qty: bigint;
  qty_cents: bigint;
}

export interface PublicJournalLine extends Omit<JournalLine, "quantity" | "qty" | "qty_cents"> {
  quantity: number;
  qty: number;
  qty_cents: number;
  amount_cents: number;
  amount_display?: number;
  account_name?: string;
  account_type?: AccountType;
  asset_symbol?: string;
  scale?: number;
}

export interface Price {
  id: string;
  book_id: string;
  asset_id: string;
  quote_asset_id: string;
  quote_id: string;
  rate_value: bigint;
  rate_scale: number;
  rate_cents: number;
  rate: number;
  time: string;
}

export class InvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvariantError";
  }
}
