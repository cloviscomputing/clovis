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
  default_asset_id: string | null;
  code: string;
  color_hex: string;
  normal_balance: "debit" | "credit";
  statement: "balance_sheet" | "income_statement";
}

export interface AccountBalance {
  account_id: string;
  account_name: string;
  account_type: AccountType;
  type: AccountType;
  parent_id: string | null;
  asset_id: string;
  asset_symbol: string;
  default_asset_id: string | null;
  default_asset_symbol: string | null;
  scale: number;
  rollup: boolean;
  posted_quantity: bigint;
  pending_quantity: bigint;
  current_quantity: bigint;
  posted_balance: bigint;
  pending_balance: bigint;
  current_balance: bigint;
  posted_balance_cents: bigint;
  pending_balance_cents: bigint;
  current_balance_cents: bigint;
  posted_display: number;
  pending_display: number;
  current_display: number;
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

export interface JournalEffectLine {
  tx_id: string;
  date: string;
  time: string;
  posted_at: string;
  status: TxStatus;
  description: string;
  description_key: string;
  source_id: string | null;
  external_id: string | null;
  line_id: string;
  line_no: number;
  account_id: string;
  account_name: string;
  account_type: AccountType;
  asset_id: string;
  asset_symbol: string;
  scale: number;
  quantity: bigint;
  quantity_cents: bigint;
  normal_amount_cents: bigint;
  income_cents: bigint;
  expense_cents: bigint;
  asset_cents: bigint;
  liability_cents: bigint;
  equity_cents: bigint;
  balance_sheet_cents: bigint;
  has_income: boolean;
  has_expense: boolean;
  has_balance_sheet: boolean;
  is_balance_sheet_only: boolean;
  is_transfer: boolean;
  is_card_payment: boolean;
  has_negative_expense: boolean;
  has_mixed_reporting_signs: boolean;
  is_refund: boolean;
}

export interface QueryEffectLinesOptions {
  status?: TxStatus | "active" | "combined" | "all" | string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  query?: string | null;
  accountId?: string | null;
  accountType?: AccountType | string | null;
  assetId?: string | null;
  sort?: "date_asc" | "date_desc" | "recent" | "latest" | "amount_asc" | "amount_desc" | string | null;
  limit?: number | null;
  offset?: number;
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
