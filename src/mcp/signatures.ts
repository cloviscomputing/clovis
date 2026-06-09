export type ToolValueType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "string[]"
  | "integer[]"
  | "object[]";

export type ToolTypeDefinition = {
  type: ToolValueType;
  nullable?: boolean;
};

export type ToolParameterOptions = {
  nullable?: boolean;
  optional?: boolean;
  defaultValue?: string | number | boolean | null;
};

export type ToolParameterDefinition = readonly [
  name: string,
  type: ToolValueType,
  options?: ToolParameterOptions
];

export type ToolDefinition = {
  parameters: readonly ToolParameterDefinition[];
  returns: ToolTypeDefinition;
};

export const TOOL_DEFINITIONS = {
  "account_register": {
    parameters: [
      ["account_id", "string"],
      ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_from", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_to", "string", { nullable: true, optional: true, defaultValue: null }],
      ["time_from", "string", { nullable: true, optional: true, defaultValue: null }],
      ["time_to", "string", { nullable: true, optional: true, defaultValue: null }],
      ["branch", "string", { nullable: true, optional: true, defaultValue: null }],
      ["status", "string", { nullable: true, optional: true, defaultValue: null }],
      ["limit", "integer", { optional: true, defaultValue: 100 }],
      ["offset", "integer", { optional: true, defaultValue: 0 }],
      ["summary", "boolean", { optional: true, defaultValue: false }]
    ],
    returns: { type: "object" }
  },
  "add_match_rule": {
    parameters: [
      ["account_id", "string"],
      ["pattern", "string"]
    ],
    returns: { type: "object" }
  },
  "add_match_rules": {
    parameters: [
      ["rules", "object[]"]
    ],
    returns: { type: "object" }
  },
  "age_of_money": {
    parameters: [
      ["days", "integer", { optional: true, defaultValue: 30 }]
    ],
    returns: { type: "object" }
  },
  "apply_match_rules": {
    parameters: [
      ["catch_all_account_id", "string"],
      ["date_from", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_to", "string", { nullable: true, optional: true, defaultValue: null }],
      ["dry_run", "boolean", { optional: true, defaultValue: true }]
    ],
    returns: { type: "object" }
  },
  "apply_pattern": {
    parameters: [
      ["pattern", "string"],
      ["target_account", "string"],
      ["force", "boolean", { optional: true, defaultValue: false }],
      ["persist_rule", "boolean", { optional: true, defaultValue: false }],
      ["dry_run", "boolean", { optional: true, defaultValue: true }],
      ["source_account", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_from", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_to", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "apply_reconciliation_plan": {
    parameters: [
      ["file_path", "string"],
      ["account_id", "string"],
      ["counterpart_account_id", "string"],
      ["expected_balance", "number", { nullable: true, optional: true, defaultValue: null }],
      ["currency", "string", { optional: true, defaultValue: "USD" }],
      ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_col", "string", { nullable: true, optional: true, defaultValue: null }],
      ["amount_col", "string", { nullable: true, optional: true, defaultValue: null }],
      ["desc_col", "string", { nullable: true, optional: true, defaultValue: null }],
      ["inflow_col", "string", { nullable: true, optional: true, defaultValue: null }],
      ["outflow_col", "string", { nullable: true, optional: true, defaultValue: null }],
      ["skip_rows", "integer", { optional: true, defaultValue: 0 }],
      ["amount_convention", "string", { optional: true, defaultValue: "signed" }],
      ["statement_type", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_tolerance_days", "integer", { optional: true, defaultValue: 3 }],
      ["min_likely_score", "number", { optional: true, defaultValue: 0.72 }],
      ["row_indexes", "integer[]", { nullable: true, optional: true, defaultValue: null }],
      ["commit_imported", "boolean", { optional: true, defaultValue: false }],
      ["annotate_posted_matches", "boolean", { optional: true, defaultValue: true }],
      ["allow_review_skip", "boolean", { optional: true, defaultValue: false }],
      ["require_balance_match", "boolean", { optional: true, defaultValue: true }],
      ["dry_run", "boolean", { optional: true, defaultValue: true }]
    ],
    returns: { type: "object" }
  },
  "apply_rollover": {
    parameters: [
      ["year", "integer"],
      ["month", "integer"]
    ],
    returns: { type: "object" }
  },
  "assert_balance": {
    parameters: [
      ["account_id", "string"],
      ["expected", "number"],
      ["date", "string", { nullable: true, optional: true, defaultValue: null }],
      ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["status", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "assert_balances": {
    parameters: [
      ["assertions", "array"],
      ["status", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "audit_categorization": {
    parameters: [
      ["date_from", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_to", "string", { nullable: true, optional: true, defaultValue: null }],
      ["min_occurrences", "integer", { optional: true, defaultValue: 2 }],
      ["status", "string", { optional: true, defaultValue: "posted" }],
      ["mode", "string", { optional: true, defaultValue: "budget" }]
    ],
    returns: { type: "object" }
  },
  "backup_now": {
    parameters: [
      ["output_path", "string", { nullable: true, optional: true, defaultValue: null }],
      ["compact", "boolean", { optional: true, defaultValue: false }]
    ],
    returns: { type: "object" }
  },
  "backup_status": {
    parameters: [

    ],
    returns: { type: "object" }
  },
  "balance_sheet": {
    parameters: [
      ["date", "string", { nullable: true, optional: true, defaultValue: null }],
      ["branch", "string", { nullable: true, optional: true, defaultValue: null }],
      ["compact", "boolean", { optional: true, defaultValue: false }],
      ["include_pending", "boolean", { optional: true, defaultValue: false }],
      ["hide_zero", "boolean", { optional: true, defaultValue: false }],
      ["quote_asset_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["account_ids", "string[]", { nullable: true, optional: true, defaultValue: null }],
      ["entity_id", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "budget_rollover_preview": {
    parameters: [
      ["year", "integer"],
      ["month", "integer"]
    ],
    returns: { type: "object" }
  },
  "budget_status": {
    parameters: [
      ["account", "string", { nullable: true, optional: true, defaultValue: null }],
      ["year", "integer", { nullable: true, optional: true, defaultValue: null }],
      ["month", "integer", { nullable: true, optional: true, defaultValue: null }],
      ["rollup", "boolean", { optional: true, defaultValue: false }],
      ["status", "string", { optional: true, defaultValue: "posted" }],
      ["quote_asset_id", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "budget_summary": {
    parameters: [
      ["year", "integer", { nullable: true, optional: true, defaultValue: null }],
      ["month", "integer", { nullable: true, optional: true, defaultValue: null }],
      ["status", "string", { optional: true, defaultValue: "posted" }],
      ["quote_asset_id", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "buy_security": {
    parameters: [
      ["account_id", "string"],
      ["symbol", "string"],
      ["shares", "number"],
      ["total_cost_cents", "integer"],
      ["date", "string"],
      ["commission_cents", "integer", { optional: true, defaultValue: 0 }],
      ["status", "string", { optional: true, defaultValue: "posted" }]
    ],
    returns: { type: "object" }
  },
  "cash_flow": {
    parameters: [
      ["year", "integer"],
      ["month", "integer"],
      ["branch", "string", { nullable: true, optional: true, defaultValue: null }],
      ["compact", "boolean", { optional: true, defaultValue: false }],
      ["include_pending", "boolean", { optional: true, defaultValue: false }],
      ["quote_asset_id", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "cash_projection": {
    parameters: [
      ["year", "integer", { nullable: true, optional: true, defaultValue: null }],
      ["month", "integer", { nullable: true, optional: true, defaultValue: null }],
      ["asset_account_ids", "string[]", { nullable: true, optional: true, defaultValue: null }],
      ["liability_account_ids", "string[]", { nullable: true, optional: true, defaultValue: null }],
      ["entity_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["earmarks", "object[]", { nullable: true, optional: true, defaultValue: null }],
      ["include_pending", "boolean", { optional: true, defaultValue: true }],
      ["include_planned", "boolean", { optional: true, defaultValue: true }],
      ["quote_asset_id", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "close_period": {
    parameters: [
      ["name", "string"],
      ["as_of", "string"],
      ["description", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "commit_batch": {
    parameters: [
      ["tx_ids", "string[]", { nullable: true, optional: true, defaultValue: null }],
      ["batch_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_from", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_to", "string", { nullable: true, optional: true, defaultValue: null }],
      ["account_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["dry_run", "boolean", { optional: true, defaultValue: false }]
    ],
    returns: { type: "object" }
  },
  "compare_scenarios": {
    parameters: [
      ["branch_a", "string", { nullable: true, optional: true, defaultValue: null }],
      ["branch_b", "string", { nullable: true, optional: true, defaultValue: null }],
      ["as_of_a", "string", { nullable: true, optional: true, defaultValue: null }],
      ["as_of_b", "string", { nullable: true, optional: true, defaultValue: null }],
      ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "consolidate_transfers": {
    parameters: [
      ["account_a", "string"],
      ["account_b", "string"],
      ["transfer_account_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_tolerance_days", "integer", { optional: true, defaultValue: 1 }],
      ["dry_run", "boolean", { optional: true, defaultValue: true }]
    ],
    returns: { type: "object" }
  },
  "copy_budgets": {
    parameters: [
      ["from_year", "integer"],
      ["from_month", "integer"],
      ["to_year", "integer"],
      ["to_month", "integer"]
    ],
    returns: { type: "object" }
  },
  "count_transactions": {
    parameters: [
      ["account_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["status", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_from", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_to", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "create_account": {
    parameters: [
      ["name", "string"],
      ["type", "string"],
      ["code", "string", { optional: true, defaultValue: "" }],
      ["parent_id", "string", { optional: true, defaultValue: "" }],
      ["color_hex", "string", { optional: true, defaultValue: "#888888" }]
    ],
    returns: { type: "object" }
  },
  "create_accounts": {
    parameters: [
      ["accounts", "object[]"]
    ],
    returns: { type: "object" }
  },
  "create_asset": {
    parameters: [
      ["symbol", "string"],
      ["asset_type", "string", { optional: true, defaultValue: "currency" }],
      ["decimals", "integer", { optional: true, defaultValue: 2 }],
      ["name", "string", { optional: true, defaultValue: "" }]
    ],
    returns: { type: "object" }
  },
  "create_branch": {
    parameters: [
      ["name", "string"]
    ],
    returns: { type: "object" }
  },
  "create_price": {
    parameters: [
      ["asset_id", "string"],
      ["quote_id", "string"],
      ["rate", "number"],
      ["time", "string"]
    ],
    returns: { type: "object" }
  },
  "create_scheduled_transaction": {
    parameters: [
      ["date", "string"],
      ["amount", "number"],
      ["from_account_id", "string"],
      ["to_account_id", "string"],
      ["description", "string", { optional: true, defaultValue: "" }],
      ["frequency", "string", { optional: true, defaultValue: "monthly" }],
      ["end_date", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "create_transaction": {
    parameters: [
      ["date", "string"],
      ["amount", "number"],
      ["from_account_id", "string"],
      ["to_account_id", "string"],
      ["description", "string"],
      ["status", "string", { optional: true, defaultValue: "pending" }],
      ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["branch", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "delete_account": {
    parameters: [
      ["id", "string"]
    ],
    returns: { type: "object" }
  },
  "delete_asset": {
    parameters: [
      ["asset_id", "string"],
      ["force", "boolean", { optional: true, defaultValue: false }]
    ],
    returns: { type: "object" }
  },
  "delete_budget": {
    parameters: [
      ["account", "string"],
      ["year", "integer", { nullable: true, optional: true, defaultValue: null }],
      ["month", "integer", { nullable: true, optional: true, defaultValue: null }],
      ["include_overrides", "boolean", { optional: true, defaultValue: false }]
    ],
    returns: { type: "object" }
  },
  "delete_budgets": {
    parameters: [
      ["accounts", "string[]", { nullable: true, optional: true, defaultValue: null }],
      ["year", "integer", { nullable: true, optional: true, defaultValue: null }],
      ["month", "integer", { nullable: true, optional: true, defaultValue: null }],
      ["include_overrides", "boolean", { optional: true, defaultValue: false }]
    ],
    returns: { type: "object" }
  },
  "delete_goal": {
    parameters: [
      ["account", "string"]
    ],
    returns: { type: "object" }
  },
  "delete_match_rule": {
    parameters: [
      ["account_id", "string"],
      ["pattern", "string"]
    ],
    returns: { type: "object" }
  },
  "delete_match_rules": {
    parameters: [
      ["rules", "object[]"]
    ],
    returns: { type: "object" }
  },
  "delete_tag": {
    parameters: [
      ["tag_id", "string"]
    ],
    returns: { type: "object" }
  },
  "delete_tags": {
    parameters: [
      ["entity_type", "string"],
      ["entity_id", "string"],
      ["key", "string", { nullable: true, optional: true, defaultValue: null }],
      ["val", "string", { nullable: true, optional: true, defaultValue: null }],
      ["dry_run", "boolean", { optional: true, defaultValue: true }]
    ],
    returns: { type: "object" }
  },
  "delete_transaction": {
    parameters: [
      ["id", "string"],
      ["hard_delete", "boolean", { optional: true, defaultValue: false }]
    ],
    returns: { type: "object" }
  },
  "detect_recurring": {
    parameters: [
      ["months", "integer", { optional: true, defaultValue: 6 }],
      ["year", "integer", { nullable: true, optional: true, defaultValue: null }],
      ["month", "integer", { nullable: true, optional: true, defaultValue: null }],
      ["min_occurrences", "integer", { optional: true, defaultValue: 2 }],
      ["amount_tolerance_pct", "number", { optional: true, defaultValue: 5 }],
      ["account_id", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object[]" }
  },
  "discard_batch": {
    parameters: [
      ["tx_ids", "string[]", { nullable: true, optional: true, defaultValue: null }],
      ["batch_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_from", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_to", "string", { nullable: true, optional: true, defaultValue: null }],
      ["account_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["dry_run", "boolean", { optional: true, defaultValue: true }]
    ],
    returns: { type: "object" }
  },
  "discard_branch": {
    parameters: [
      ["name", "string"]
    ],
    returns: { type: "object" }
  },
  "export_ledger": {
    parameters: [
      ["output_path", "string", { nullable: true, optional: true, defaultValue: null }],
      ["entity_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_from", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_to", "string", { nullable: true, optional: true, defaultValue: null }],
      ["account_ids", "string[]", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "export_transactions": {
    parameters: [
      ["account_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_from", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_to", "string", { nullable: true, optional: true, defaultValue: null }],
      ["output_path", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "financial_overview": {
    parameters: [
      ["year", "integer", { nullable: true, optional: true, defaultValue: null }],
      ["month", "integer", { nullable: true, optional: true, defaultValue: null }],
      ["status", "string", { optional: true, defaultValue: "active" }],
      ["quote_asset_id", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "financial_picture": {
    parameters: [
      ["year", "integer", { nullable: true, optional: true, defaultValue: null }],
      ["month", "integer", { nullable: true, optional: true, defaultValue: null }],
      ["quote_asset_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["status", "string", { optional: true, defaultValue: "combined" }],
      ["include_pending", "boolean", { optional: true, defaultValue: true }]
    ],
    returns: { type: "object" }
  },
  "find_pending_duplicates": {
    parameters: [
      ["account_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_from", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_to", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_tolerance_days", "integer", { optional: true, defaultValue: 3 }]
    ],
    returns: { type: "object" }
  },
  "flip_entries": {
    parameters: [
      ["tx_ids", "string[]"]
    ],
    returns: { type: "object" }
  },
  "forecast": {
    parameters: [
      ["account_id", "string"],
      ["as_of", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "forecast_month_end": {
    parameters: [
      ["year", "integer", { nullable: true, optional: true, defaultValue: null }],
      ["month", "integer", { nullable: true, optional: true, defaultValue: null }],
      ["status", "string", { optional: true, defaultValue: "posted" }],
      ["quote_asset_id", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "fx_transfer": {
    parameters: [
      ["from_account_id", "string"],
      ["to_account_id", "string"],
      ["from_amount", "number"],
      ["to_amount", "number"],
      ["from_asset_id", "string"],
      ["to_asset_id", "string"],
      ["fx_account_id", "string"],
      ["date", "string"],
      ["description", "string"],
      ["status", "string", { optional: true, defaultValue: "posted" }],
      ["record_rate", "boolean", { optional: true, defaultValue: true }]
    ],
    returns: { type: "object" }
  },
  "get_account": {
    parameters: [
      ["id", "string"]
    ],
    returns: { type: "object" }
  },
  "get_account_by_name": {
    parameters: [
      ["name", "string"]
    ],
    returns: { type: "object", nullable: true }
  },
  "get_asset_by_symbol": {
    parameters: [
      ["symbol", "string"]
    ],
    returns: { type: "object", nullable: true }
  },
  "get_balance": {
    parameters: [
      ["account_id", "string"]
    ],
    returns: { type: "object" }
  },
  "get_price": {
    parameters: [
      ["asset_id", "string"],
      ["quote_id", "string"],
      ["as_of", "string"]
    ],
    returns: { type: "object", nullable: true }
  },
  "get_transaction": {
    parameters: [
      ["id", "string"]
    ],
    returns: { type: "object" }
  },
  "goal_progress": {
    parameters: [
      ["account", "string"]
    ],
    returns: { type: "object" }
  },
  "holdings": {
    parameters: [
      ["account_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["asset_type", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object[]" }
  },
  "import_file": {
    parameters: [
      ["file_path", "string"],
      ["account_id", "string"],
      ["counterpart_account_id", "string"],
      ["currency", "string", { optional: true, defaultValue: "USD" }],
      ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_col", "string", { nullable: true, optional: true, defaultValue: null }],
      ["amount_col", "string", { nullable: true, optional: true, defaultValue: null }],
      ["desc_col", "string", { nullable: true, optional: true, defaultValue: null }],
      ["inflow_col", "string", { nullable: true, optional: true, defaultValue: null }],
      ["outflow_col", "string", { nullable: true, optional: true, defaultValue: null }],
      ["counterpart_col", "string", { nullable: true, optional: true, defaultValue: null }],
      ["tag_cols", "object", { nullable: true, optional: true, defaultValue: null }],
      ["skip_rows", "integer", { optional: true, defaultValue: 0 }],
      ["status", "string", { optional: true, defaultValue: "pending" }],
      ["amount_convention", "string", { optional: true, defaultValue: "signed" }],
      ["show_duplicates", "boolean", { optional: true, defaultValue: false }],
      ["statement_type", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "import_ledger": {
    parameters: [
      ["file_path", "string", { nullable: true, optional: true, defaultValue: null }],
      ["data", "string", { nullable: true, optional: true, defaultValue: null }],
      ["preserve_ids", "boolean", { optional: true, defaultValue: true }],
      ["dry_run", "boolean", { optional: true, defaultValue: false }]
    ],
    returns: { type: "object" }
  },
  "import_transactions": {
    parameters: [
      ["account_id", "string"],
      ["counterpart_id", "string"],
      ["transactions", "object[]"],
      ["status", "string", { optional: true, defaultValue: "pending" }],
      ["dry_run", "boolean", { optional: true, defaultValue: false }],
      ["batch_label", "string", { nullable: true, optional: true, defaultValue: null }],
      ["tags", "object", { nullable: true, optional: true, defaultValue: null }],
      ["amount_convention", "string", { optional: true, defaultValue: "signed" }],
      ["date_tolerance_days", "integer", { optional: true, defaultValue: 1 }],
      ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["skip_dedup", "boolean", { optional: true, defaultValue: false }],
      ["statement_type", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "income_statement": {
    parameters: [
      ["year", "integer"],
      ["month", "integer", { nullable: true, optional: true, defaultValue: null }],
      ["branch", "string", { nullable: true, optional: true, defaultValue: null }],
      ["compact", "boolean", { optional: true, defaultValue: false }],
      ["include_pending", "boolean", { optional: true, defaultValue: false }],
      ["account_ids", "string[]", { nullable: true, optional: true, defaultValue: null }],
      ["entity_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["quote_asset_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["status", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "init_defaults": {
    parameters: [
      ["template", "string", { optional: true, defaultValue: "personal" }]
    ],
    returns: { type: "object" }
  },
  "inspect_transaction": {
    parameters: [
      ["tx_id", "string"]
    ],
    returns: { type: "object" }
  },
  "integrity_check": {
    parameters: [

    ],
    returns: { type: "object" }
  },
  "invert_import": {
    parameters: [
      ["batch_id", "string"]
    ],
    returns: { type: "object" }
  },
  "list_accounts": {
    parameters: [
      ["type", "string", { nullable: true, optional: true, defaultValue: null }],
      ["parent_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["include_counts", "boolean", { optional: true, defaultValue: false }],
      ["tree", "boolean", { optional: true, defaultValue: false }]
    ],
    returns: { type: "object[]" }
  },
  "list_assets": {
    parameters: [
      ["asset_type", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object[]" }
  },
  "list_backups": {
    parameters: [

    ],
    returns: { type: "object[]" }
  },
  "list_branches": {
    parameters: [

    ],
    returns: { type: "object[]" }
  },
  "list_checkpoints": {
    parameters: [

    ],
    returns: { type: "object[]" }
  },
  "list_entries": {
    parameters: [
      ["tx_id", "string"]
    ],
    returns: { type: "object[]" }
  },
  "list_entries_by_asset": {
    parameters: [
      ["asset_id", "string"],
      ["limit", "integer", { optional: true, defaultValue: 100 }],
      ["offset", "integer", { optional: true, defaultValue: 0 }]
    ],
    returns: { type: "object" }
  },
  "list_goals": {
    parameters: [

    ],
    returns: { type: "array" }
  },
  "list_import_batches": {
    parameters: [
      ["limit", "integer", { optional: true, defaultValue: 20 }],
      ["date_from", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object[]" }
  },
  "list_match_rules": {
    parameters: [

    ],
    returns: { type: "object[]" }
  },
  "list_prices": {
    parameters: [

    ],
    returns: { type: "object[]" }
  },
  "list_scheduled": {
    parameters: [

    ],
    returns: { type: "object[]" }
  },
  "list_tags": {
    parameters: [
      ["entity_type", "string"],
      ["entity_id", "string"]
    ],
    returns: { type: "object[]" }
  },
  "list_transactions": {
    parameters: [
      ["account_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["category_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["year", "integer", { nullable: true, optional: true, defaultValue: null }],
      ["month", "integer", { nullable: true, optional: true, defaultValue: null }],
      ["status", "string", { nullable: true, optional: true, defaultValue: null }],
      ["limit", "integer", { optional: true, defaultValue: 50 }],
      ["offset", "integer", { optional: true, defaultValue: 0 }],
      ["compact", "boolean", { optional: true, defaultValue: true }],
      ["sort", "string", { optional: true, defaultValue: "date_desc" }]
    ],
    returns: { type: "object" }
  },
  "list_uncategorized": {
    parameters: [
      ["catch_all_account_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["status", "string", { optional: true, defaultValue: "pending" }],
      ["date_from", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_to", "string", { nullable: true, optional: true, defaultValue: null }],
      ["limit", "integer", { optional: true, defaultValue: 50 }],
      ["offset", "integer", { optional: true, defaultValue: 0 }],
      ["compact", "boolean", { optional: true, defaultValue: false }]
    ],
    returns: { type: "object" }
  },
  "list_unmatched_transfers": {
    parameters: [
      ["date_tolerance_days", "integer", { optional: true, defaultValue: 3 }]
    ],
    returns: { type: "object[]" }
  },
  "match_transfer_pairs": {
    parameters: [
      ["clearing_account", "string", { nullable: true, optional: true, defaultValue: null }],
      ["account_a", "string", { nullable: true, optional: true, defaultValue: null }],
      ["account_b", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_from", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_to", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_tolerance_days", "integer", { optional: true, defaultValue: 0 }],
      ["match_by", "string", { optional: true, defaultValue: "amount+date+code" }],
      ["dry_run", "boolean", { optional: true, defaultValue: true }]
    ],
    returns: { type: "object" }
  },
  "match_transfers": {
    parameters: [
      ["account_a", "string"],
      ["account_b", "string"],
      ["date_tolerance_days", "integer", { optional: true, defaultValue: 1 }],
      ["dry_run", "boolean", { optional: true, defaultValue: true }],
      ["status", "string", { optional: true, defaultValue: "pending" }]
    ],
    returns: { type: "object" }
  },
  "merge_accounts": {
    parameters: [
      ["sources", "string[]"],
      ["target", "string"],
      ["delete_sources", "boolean", { optional: true, defaultValue: true }]
    ],
    returns: { type: "object" }
  },
  "merge_branch": {
    parameters: [
      ["source", "string"]
    ],
    returns: { type: "object" }
  },
  "migrate_asset_entries": {
    parameters: [
      ["from_asset_id", "string"],
      ["to_asset_id", "string"],
      ["dry_run", "boolean", { optional: true, defaultValue: true }]
    ],
    returns: { type: "object" }
  },
  "move_transactions": {
    parameters: [
      ["from_account", "string"],
      ["to_account", "string"],
      ["dry_run", "boolean", { optional: true, defaultValue: true }]
    ],
    returns: { type: "object" }
  },
  "net_worth": {
    parameters: [
      ["date", "string", { nullable: true, optional: true, defaultValue: null }],
      ["branch", "string", { nullable: true, optional: true, defaultValue: null }],
      ["include_pending", "boolean", { optional: true, defaultValue: false }],
      ["quote_asset_id", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "pending_summary": {
    parameters: [
      ["year", "integer", { nullable: true, optional: true, defaultValue: null }],
      ["month", "integer", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "plan_transaction": {
    parameters: [
      ["date", "string"],
      ["amount", "number"],
      ["from_account_id", "string"],
      ["to_account_id", "string"],
      ["description", "string"],
      ["branch", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "post_journal_entry": {
    parameters: [
      ["date", "string"],
      ["legs", "object[]"],
      ["description", "string"],
      ["status", "string", { optional: true, defaultValue: "pending" }]
    ],
    returns: { type: "object" }
  },
  "preview_commit": {
    parameters: [
      ["as_of", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "preview_import": {
    parameters: [
      ["file_path", "string"],
      ["account_id", "string"],
      ["counterpart_account_id", "string"],
      ["rows", "integer", { optional: true, defaultValue: 3 }],
      ["currency", "string", { optional: true, defaultValue: "USD" }],
      ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_col", "string", { nullable: true, optional: true, defaultValue: null }],
      ["amount_col", "string", { nullable: true, optional: true, defaultValue: null }],
      ["desc_col", "string", { nullable: true, optional: true, defaultValue: null }],
      ["inflow_col", "string", { nullable: true, optional: true, defaultValue: null }],
      ["outflow_col", "string", { nullable: true, optional: true, defaultValue: null }],
      ["skip_rows", "integer", { optional: true, defaultValue: 0 }],
      ["amount_convention", "string", { optional: true, defaultValue: "signed" }],
      ["statement_type", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "process_scheduled": {
    parameters: [
      ["through_date", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "process_statement": {
    parameters: [
      ["file_path", "string"],
      ["account_id", "string"],
      ["counterpart_account_id", "string"],
      ["expected_balance", "number", { nullable: true, optional: true, defaultValue: null }],
      ["currency", "string", { optional: true, defaultValue: "USD" }],
      ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_col", "string", { nullable: true, optional: true, defaultValue: null }],
      ["amount_col", "string", { nullable: true, optional: true, defaultValue: null }],
      ["desc_col", "string", { nullable: true, optional: true, defaultValue: null }],
      ["inflow_col", "string", { nullable: true, optional: true, defaultValue: null }],
      ["outflow_col", "string", { nullable: true, optional: true, defaultValue: null }],
      ["counterpart_col", "string", { nullable: true, optional: true, defaultValue: null }],
      ["tag_cols", "object", { nullable: true, optional: true, defaultValue: null }],
      ["skip_rows", "integer", { optional: true, defaultValue: 0 }],
      ["amount_convention", "string", { optional: true, defaultValue: "signed" }],
      ["statement_type", "string", { nullable: true, optional: true, defaultValue: null }],
      ["transfer_account_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_tolerance_days", "integer", { optional: true, defaultValue: 1 }],
      ["commit", "boolean", { optional: true, defaultValue: false }],
      ["show_duplicates", "boolean", { optional: true, defaultValue: true }],
      ["preview_rows", "integer", { optional: true, defaultValue: 10 }]
    ],
    returns: { type: "object" }
  },
  "project_balances": {
    parameters: [
      ["through", "string"],
      ["account_ids", "string[]", { nullable: true, optional: true, defaultValue: null }],
      ["include_goals", "boolean", { optional: true, defaultValue: false }],
      ["branch", "string", { nullable: true, optional: true, defaultValue: null }],
      ["quote_asset_id", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "project_month_end": {
    parameters: [
      ["year", "integer", { nullable: true, optional: true, defaultValue: null }],
      ["month", "integer", { nullable: true, optional: true, defaultValue: null }],
      ["expected_inflows", "object[]", { nullable: true, optional: true, defaultValue: null }],
      ["expected_outflows", "object[]", { nullable: true, optional: true, defaultValue: null }],
      ["expected_paychecks", "object[]", { nullable: true, optional: true, defaultValue: null }],
      ["include_pending", "boolean", { optional: true, defaultValue: true }],
      ["account_ids", "string[]", { nullable: true, optional: true, defaultValue: null }],
      ["quote_asset_id", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "recategorize_by_pattern": {
    parameters: [
      ["pattern", "string"],
      ["new_account_id", "string"],
      ["old_account_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_from", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_to", "string", { nullable: true, optional: true, defaultValue: null }],
      ["dry_run", "boolean", { optional: true, defaultValue: true }],
      ["persist_rule", "boolean", { optional: true, defaultValue: false }],
      ["verbose", "boolean", { optional: true, defaultValue: false }],
      ["status", "string", { optional: true, defaultValue: "posted" }],
      ["amount_min", "integer", { nullable: true, optional: true, defaultValue: null }],
      ["amount_max", "integer", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "recategorize_by_patterns": {
    parameters: [
      ["rules", "object[]"],
      ["date_from", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_to", "string", { nullable: true, optional: true, defaultValue: null }],
      ["dry_run", "boolean", { optional: true, defaultValue: true }],
      ["persist_rules", "boolean", { optional: true, defaultValue: false }],
      ["old_account_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["verbose", "boolean", { optional: true, defaultValue: false }],
      ["status", "string", { optional: true, defaultValue: "posted" }],
      ["amount_min", "integer", { nullable: true, optional: true, defaultValue: null }],
      ["amount_max", "integer", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "recategorize_transaction": {
    parameters: [
      ["tx_id", "string"],
      ["new_account_id", "string"],
      ["old_account_id", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "recognize_gain_loss": {
    parameters: [
      ["date", "string"],
      ["amount", "number"],
      ["investment_account_id", "string"],
      ["description", "string"],
      ["gain_loss_account_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["status", "string", { optional: true, defaultValue: "posted" }],
      ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "reconcile_diff": {
    parameters: [
      ["account_id", "string"],
      ["date_from", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_to", "string", { nullable: true, optional: true, defaultValue: null }],
      ["branch", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "reconcile_statement": {
    parameters: [
      ["account_id", "string"],
      ["counterpart_id", "string"],
      ["transactions", "object[]"],
      ["amount_convention", "string", { optional: true, defaultValue: "signed" }],
      ["statement_type", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "reconcile_statement_plan": {
    parameters: [
      ["file_path", "string"],
      ["account_id", "string"],
      ["counterpart_account_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["expected_balance", "number", { nullable: true, optional: true, defaultValue: null }],
      ["currency", "string", { optional: true, defaultValue: "USD" }],
      ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_col", "string", { nullable: true, optional: true, defaultValue: null }],
      ["amount_col", "string", { nullable: true, optional: true, defaultValue: null }],
      ["desc_col", "string", { nullable: true, optional: true, defaultValue: null }],
      ["inflow_col", "string", { nullable: true, optional: true, defaultValue: null }],
      ["outflow_col", "string", { nullable: true, optional: true, defaultValue: null }],
      ["skip_rows", "integer", { optional: true, defaultValue: 0 }],
      ["amount_convention", "string", { optional: true, defaultValue: "signed" }],
      ["statement_type", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_tolerance_days", "integer", { optional: true, defaultValue: 3 }],
      ["min_likely_score", "number", { optional: true, defaultValue: 0.72 }],
      ["sample_limit", "integer", { optional: true, defaultValue: 20 }]
    ],
    returns: { type: "object" }
  },
  "reconcile_to_balance": {
    parameters: [
      ["account_id", "string"],
      ["target_balance", "number"],
      ["offset_account_id", "string"],
      ["date", "string"],
      ["description", "string", { nullable: true, optional: true, defaultValue: null }],
      ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["status", "string", { optional: true, defaultValue: "posted" }],
      ["dry_run", "boolean", { optional: true, defaultValue: false }]
    ],
    returns: { type: "object" }
  },
  "record_investment": {
    parameters: [
      ["date", "string"],
      ["amount", "number"],
      ["investment_account_id", "string"],
      ["source_account_id", "string"],
      ["description", "string"],
      ["status", "string", { optional: true, defaultValue: "posted" }],
      ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "record_opening_balance": {
    parameters: [
      ["account_id", "string"],
      ["amount", "number"],
      ["date", "string"],
      ["status", "string", { optional: true, defaultValue: "pending" }],
      ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["counterpart_account_id", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "record_opening_balances": {
    parameters: [
      ["balances", "object[]"],
      ["date", "string"],
      ["status", "string", { optional: true, defaultValue: "pending" }]
    ],
    returns: { type: "object" }
  },
  "record_pending_expenses": {
    parameters: [
      ["account_id", "string"],
      ["transactions", "object[]"],
      ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["batch_label", "string", { nullable: true, optional: true, defaultValue: null }],
      ["tags", "object", { nullable: true, optional: true, defaultValue: null }],
      ["dry_run", "boolean", { optional: true, defaultValue: true }],
      ["skip_dedup", "boolean", { optional: true, defaultValue: false }]
    ],
    returns: { type: "object" }
  },
  "reopen_period": {
    parameters: [
      ["checkpoint_id", "string"]
    ],
    returns: { type: "object" }
  },
  "repair_integrity": {
    parameters: [
      ["dry_run", "boolean", { optional: true, defaultValue: true }],
      ["backup", "boolean", { optional: true, defaultValue: true }]
    ],
    returns: { type: "object" }
  },
  "rollback_import": {
    parameters: [
      ["batch_id", "string"]
    ],
    returns: { type: "object" }
  },
  "rollback_recategorize": {
    parameters: [
      ["batch_id", "string"]
    ],
    returns: { type: "object" }
  },
  "search_transactions": {
    parameters: [
      ["desc", "string", { nullable: true, optional: true, defaultValue: null }],
      ["query", "string", { nullable: true, optional: true, defaultValue: null }],
      ["amount_min", "integer", { nullable: true, optional: true, defaultValue: null }],
      ["amount_max", "integer", { nullable: true, optional: true, defaultValue: null }],
      ["account_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["status", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_from", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_to", "string", { nullable: true, optional: true, defaultValue: null }],
      ["posted_at_from", "string", { nullable: true, optional: true, defaultValue: null }],
      ["posted_at_to", "string", { nullable: true, optional: true, defaultValue: null }],
      ["limit", "integer", { optional: true, defaultValue: 50 }],
      ["offset", "integer", { optional: true, defaultValue: 0 }],
      ["sort", "string", { optional: true, defaultValue: "date_desc" }]
    ],
    returns: { type: "object" }
  },
  "set_budget": {
    parameters: [
      ["account", "string"],
      ["amount", "number"],
      ["period", "string", { optional: true, defaultValue: "monthly" }],
      ["year", "integer", { nullable: true, optional: true, defaultValue: null }],
      ["month", "integer", { nullable: true, optional: true, defaultValue: null }],
      ["rollover", "boolean", { optional: true, defaultValue: false }]
    ],
    returns: { type: "object" }
  },
  "set_budgets": {
    parameters: [
      ["budgets", "object[]"],
      ["year", "integer", { nullable: true, optional: true, defaultValue: null }],
      ["month", "integer", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "set_goal": {
    parameters: [
      ["account", "string"],
      ["target", "number"],
      ["name", "string"],
      ["target_date", "string", { nullable: true, optional: true, defaultValue: null }],
      ["priority", "integer", { optional: true, defaultValue: 1 }]
    ],
    returns: { type: "object" }
  },
  "spending": {
    parameters: [
      ["year", "integer"],
      ["month", "integer"],
      ["branch", "string", { nullable: true, optional: true, defaultValue: null }],
      ["include_pending", "boolean", { optional: true, defaultValue: false }],
      ["status", "string", { nullable: true, optional: true, defaultValue: null }],
      ["account_ids", "string[]", { nullable: true, optional: true, defaultValue: null }],
      ["entity_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["quote_asset_id", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "spending_rate": {
    parameters: [
      ["account", "string", { nullable: true, optional: true, defaultValue: null }],
      ["year", "integer", { nullable: true, optional: true, defaultValue: null }],
      ["month", "integer", { nullable: true, optional: true, defaultValue: null }],
      ["status", "string", { optional: true, defaultValue: "posted" }],
      ["quote_asset_id", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object[]" }
  },
  "suggest_budgets": {
    parameters: [
      ["months", "integer", { optional: true, defaultValue: 3 }],
      ["year", "integer", { nullable: true, optional: true, defaultValue: null }],
      ["month", "integer", { nullable: true, optional: true, defaultValue: null }],
      ["skip_budgeted", "boolean", { optional: true, defaultValue: true }]
    ],
    returns: { type: "object[]" }
  },
  "top_descriptions": {
    parameters: [
      ["account_id", "string"],
      ["limit", "integer", { optional: true, defaultValue: 50 }],
      ["status", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object[]" }
  },
  "transfer": {
    parameters: [
      ["from_account_id", "string"],
      ["to_account_id", "string"],
      ["amount", "number"],
      ["date", "string"],
      ["description", "string"],
      ["status", "string", { optional: true, defaultValue: "posted" }],
      ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "trial_balance": {
    parameters: [
      ["branch", "string", { nullable: true, optional: true, defaultValue: null }],
      ["status", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "unbudgeted_spending": {
    parameters: [
      ["year", "integer", { nullable: true, optional: true, defaultValue: null }],
      ["month", "integer", { nullable: true, optional: true, defaultValue: null }],
      ["status", "string", { optional: true, defaultValue: "posted" }],
      ["quote_asset_id", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object[]" }
  },
  "update_account": {
    parameters: [
      ["id", "string"],
      ["name", "string", { nullable: true, optional: true, defaultValue: null }],
      ["type", "string", { nullable: true, optional: true, defaultValue: null }],
      ["code", "string", { nullable: true, optional: true, defaultValue: null }],
      ["parent_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["color_hex", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "update_asset": {
    parameters: [
      ["asset_id", "string"],
      ["symbol", "string", { nullable: true, optional: true, defaultValue: null }],
      ["name", "string", { nullable: true, optional: true, defaultValue: null }]
    ],
    returns: { type: "object" }
  },
  "void_by_filter": {
    parameters: [
      ["date_from", "string", { nullable: true, optional: true, defaultValue: null }],
      ["date_to", "string", { nullable: true, optional: true, defaultValue: null }],
      ["account_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["status", "string", { nullable: true, optional: true, defaultValue: null }],
      ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }],
      ["posted_at_from", "string", { nullable: true, optional: true, defaultValue: null }],
      ["posted_at_to", "string", { nullable: true, optional: true, defaultValue: null }],
      ["dry_run", "boolean", { optional: true, defaultValue: true }],
      ["hard_delete", "boolean", { optional: true, defaultValue: false }]
    ],
    returns: { type: "object" }
  }
} as const satisfies Record<string, ToolDefinition>;

export type ToolSignatureName = keyof typeof TOOL_DEFINITIONS;

function typeDisplay(definition: ToolTypeDefinition): string {
  let rendered: string;
  switch (definition.type) {
    case "string": rendered = "string"; break;
    case "number": rendered = "number"; break;
    case "integer": rendered = "number"; break;
    case "boolean": rendered = "boolean"; break;
    case "object": rendered = "Record<string, unknown>"; break;
    case "array": rendered = "unknown[]"; break;
    case "string[]": rendered = "string[]"; break;
    case "integer[]": rendered = "number[]"; break;
    case "object[]": rendered = "Array<Record<string, unknown>>"; break;
  }
  return definition.nullable ? `${rendered} | null` : rendered;
}

function parameterType(parameter: ToolParameterDefinition): ToolTypeDefinition {
  return { type: parameter[1], nullable: parameter[2]?.nullable };
}

function renderSignature(definition: ToolDefinition): string {
  const params = definition.parameters
    .map((parameter) => `${parameter[0]}${parameter[2]?.optional ? "?" : ""}: ${typeDisplay(parameterType(parameter))}`)
    .join(", ");
  return `(${params}) => ${typeDisplay(definition.returns)}`;
}

export const TOOL_SIGNATURES = Object.fromEntries(
  Object.entries(TOOL_DEFINITIONS).map(([name, definition]) => [name, renderSignature(definition)])
) as { [Name in ToolSignatureName]: string };
