import { defineToolGroup } from "../../tool-spec.js";

export const transactionTools = defineToolGroup([
  {
    name: "create_transaction",
    definition: {
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
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "transactions",
    mutation: "write"
  },
  {
    name: "transfer",
    definition: {
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
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "transactions",
    mutation: "write"
  },
  {
    name: "plan_transaction",
    definition: {
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
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "transactions",
    mutation: "write"
  },
  {
    name: "post_journal_entry",
    definition: {
      parameters: [
        ["date", "string"],
        ["legs", "object[]"],
        ["description", "string"],
        ["status", "string", { optional: true, defaultValue: "pending" }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "transactions",
    mutation: "write"
  },
  {
    name: "record_opening_balance",
    definition: {
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
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "read",
    mutation: "write"
  },
  {
    name: "record_opening_balances",
    definition: {
      parameters: [
        ["balances", "object[]"],
        ["date", "string"],
        ["status", "string", { optional: true, defaultValue: "pending" }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "read",
    mutation: "write"
  },
  {
    name: "list_transactions",
    definition: {
      parameters: [
        ["account_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["category_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["year", "integer", { nullable: true, optional: true, defaultValue: null }],
        ["month", "integer", { nullable: true, optional: true, defaultValue: null }],
        ["date_from", "string", { nullable: true, optional: true, defaultValue: null }],
        ["date_to", "string", { nullable: true, optional: true, defaultValue: null }],
        ["status", "string", { nullable: true, optional: true, defaultValue: null }],
        ["limit", "integer", { optional: true, defaultValue: 50 }],
        ["offset", "integer", { optional: true, defaultValue: 0 }],
        ["compact", "boolean", { optional: true, defaultValue: true }],
        ["include_account_effects", "boolean", { optional: true, defaultValue: false }],
        ["sort", "string", { optional: true, defaultValue: "date_desc" }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "transactions",
    mutation: "read"
  },
  {
    name: "search_transactions",
    definition: {
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
        ["include_account_effects", "boolean", { optional: true, defaultValue: false }],
        ["sort", "string", { optional: true, defaultValue: "date_desc" }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "transactions",
    mutation: "read"
  },
  {
    name: "get_transaction",
    definition: {
      parameters: [
        ["id", "string"]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "transactions",
    mutation: "read"
  },
  {
    name: "delete_transaction",
    definition: {
      parameters: [
        ["id", "string"],
        ["hard_delete", "boolean", { optional: true, defaultValue: false }],
        ["dry_run", "boolean", { optional: true, defaultValue: false }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "transactions",
    mutation: "write"
  },
  {
    name: "list_entries",
    definition: {
      parameters: [
        ["tx_id", "string"]
      ],
      returns: { type: "object[]" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "transactions",
    mutation: "read"
  },
  {
    name: "list_entries_by_asset",
    definition: {
      parameters: [
        ["asset_id", "string"],
        ["limit", "integer", { optional: true, defaultValue: 100 }],
        ["offset", "integer", { optional: true, defaultValue: 0 }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "transactions",
    mutation: "read"
  },
  {
    name: "get_balance",
    definition: {
      parameters: [
        ["account_id", "string"],
        ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["date", "string", { nullable: true, optional: true, defaultValue: null }],
        ["status", "string", { optional: true, defaultValue: "posted" }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "read",
    mutation: "read"
  },
  {
    name: "account_balances",
    definition: {
      parameters: [
        ["account_type", "string", { nullable: true, optional: true, defaultValue: null }],
        ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["as_of", "string", { nullable: true, optional: true, defaultValue: null }],
        ["rollup", "boolean", { optional: true, defaultValue: false }],
        ["hide_zero", "boolean", { optional: true, defaultValue: true }],
        ["native_asset_only", "boolean", { optional: true, defaultValue: false }],
        ["presentation", "string", { optional: true, defaultValue: "ledger" }],
        ["account_ids", "string[]", { nullable: true, optional: true, defaultValue: null }],
        ["entity_id", "string", { nullable: true, optional: true, defaultValue: null }]
      ],
      returns: { type: "object[]" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "setup",
    mutation: "read"
  },
  {
    name: "recategorize_transaction",
    definition: {
      parameters: [
        ["tx_id", "string"],
        ["new_account_id", "string"],
        ["old_account_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["correction_date", "string", { nullable: true, optional: true, defaultValue: null }],
        ["dry_run", "boolean", { optional: true, defaultValue: false }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "transactions",
    mutation: "write"
  },
  {
    name: "flip_entries",
    definition: {
      parameters: [
        ["tx_ids", "string[]"]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "transactions",
    mutation: "write"
  },
  {
    name: "void_by_filter",
    definition: {
      parameters: [
        ["date_from", "string", { nullable: true, optional: true, defaultValue: null }],
        ["date_to", "string", { nullable: true, optional: true, defaultValue: null }],
        ["account_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["status", "string", { nullable: true, optional: true, defaultValue: null }],
        ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["posted_at_from", "string", { nullable: true, optional: true, defaultValue: null }],
        ["posted_at_to", "string", { nullable: true, optional: true, defaultValue: null }],
        ["dry_run", "boolean", { optional: true, defaultValue: true }],
        ["hard_delete", "boolean", { optional: true, defaultValue: false }],
        ["sample_limit", "integer", { nullable: true, optional: true, defaultValue: null }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: true },
    workflow: "read",
    mutation: "dry-run"
  },
  {
    name: "move_transactions",
    definition: {
      parameters: [
        ["from_account", "string"],
        ["to_account", "string"],
        ["dry_run", "boolean", { optional: true, defaultValue: true }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: true },
    workflow: "transactions",
    mutation: "dry-run"
  },
  {
    name: "add_match_rule",
    definition: {
      parameters: [
        ["account_id", "string"],
        ["pattern", "string"]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "transactions",
    mutation: "write"
  },
  {
    name: "add_match_rules",
    definition: {
      parameters: [
        ["rules", "object[]"]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "transactions",
    mutation: "write"
  },
  {
    name: "list_match_rules",
    definition: {
      parameters: [],
      returns: { type: "object[]" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "transactions",
    mutation: "read"
  },
  {
    name: "delete_match_rule",
    definition: {
      parameters: [
        ["account_id", "string"],
        ["pattern", "string"]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "transactions",
    mutation: "write"
  },
  {
    name: "delete_match_rules",
    definition: {
      parameters: [
        ["rules", "object[]"]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "transactions",
    mutation: "write"
  },
  {
    name: "apply_match_rules",
    definition: {
      parameters: [
        ["catch_all_account_id", "string"],
        ["date_from", "string", { nullable: true, optional: true, defaultValue: null }],
        ["date_to", "string", { nullable: true, optional: true, defaultValue: null }],
        ["dry_run", "boolean", { optional: true, defaultValue: true }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: true },
    workflow: "transactions",
    mutation: "dry-run"
  },
  {
    name: "apply_pattern",
    definition: {
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
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: true },
    workflow: "transactions",
    mutation: "dry-run"
  },
  {
    name: "recategorize_by_pattern",
    definition: {
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
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: true },
    workflow: "transactions",
    mutation: "dry-run"
  },
  {
    name: "recategorize_by_patterns",
    definition: {
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
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: true },
    workflow: "transactions",
    mutation: "dry-run"
  },
  {
    name: "rollback_recategorize",
    definition: {
      parameters: [
        ["batch_id", "string"]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "transactions",
    mutation: "write"
  },
  {
    name: "fx_transfer",
    definition: {
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
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "transactions",
    mutation: "write"
  },
  {
    name: "create_scheduled_transaction",
    definition: {
      parameters: [
        ["date", "string"],
        ["amount", "number"],
        ["from_account_id", "string"],
        ["to_account_id", "string"],
        ["description", "string", { optional: true, defaultValue: "" }],
        ["frequency", "string", { optional: true, defaultValue: "monthly" }],
        ["end_date", "string", { nullable: true, optional: true, defaultValue: null }],
        ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "transactions",
    mutation: "write"
  },
  {
    name: "list_scheduled",
    definition: {
      parameters: [],
      returns: { type: "object[]" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "read",
    mutation: "read"
  },
  {
    name: "process_scheduled",
    definition: {
      parameters: [
        ["through_date", "string", { nullable: true, optional: true, defaultValue: null }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "read",
    mutation: "write"
  },
  {
    name: "detect_recurring",
    definition: {
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
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "read",
    mutation: "read"
  },
  {
    name: "pending_summary",
    definition: {
      parameters: [
        ["year", "integer", { nullable: true, optional: true, defaultValue: null }],
        ["month", "integer", { nullable: true, optional: true, defaultValue: null }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "statements",
    mutation: "read"
  },
  {
    name: "record_pending_expenses",
    definition: {
      parameters: [
        ["account_id", "string"],
        ["transactions", "object[]"],
        ["counterpart_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["batch_label", "string", { nullable: true, optional: true, defaultValue: null }],
        ["tags", "object", { nullable: true, optional: true, defaultValue: null }],
        ["dry_run", "boolean", { optional: true, defaultValue: true }],
        ["skip_dedup", "boolean", { optional: true, defaultValue: false }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: true },
    workflow: "statements",
    mutation: "dry-run"
  },
  {
    name: "find_pending_duplicates",
    definition: {
      parameters: [
        ["account_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["date_from", "string", { nullable: true, optional: true, defaultValue: null }],
        ["date_to", "string", { nullable: true, optional: true, defaultValue: null }],
        ["date_tolerance_days", "integer", { optional: true, defaultValue: 3 }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "statements",
    mutation: "read"
  },
  {
    name: "find_realized_planned",
    definition: {
      parameters: [
        ["year", "integer", { nullable: true, optional: true, defaultValue: null }],
        ["month", "integer", { nullable: true, optional: true, defaultValue: null }],
        ["date_from", "string", { nullable: true, optional: true, defaultValue: null }],
        ["date_to", "string", { nullable: true, optional: true, defaultValue: null }],
        ["account_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["account_ids", "string[]", { nullable: true, optional: true, defaultValue: null }],
        ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["date_tolerance_days", "integer", { optional: true, defaultValue: 3 }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "statements",
    mutation: "read"
  },
  {
    name: "reconcile_planned",
    definition: {
      parameters: [
        ["year", "integer", { nullable: true, optional: true, defaultValue: null }],
        ["month", "integer", { nullable: true, optional: true, defaultValue: null }],
        ["date_from", "string", { nullable: true, optional: true, defaultValue: null }],
        ["date_to", "string", { nullable: true, optional: true, defaultValue: null }],
        ["account_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["account_ids", "string[]", { nullable: true, optional: true, defaultValue: null }],
        ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["date_tolerance_days", "integer", { optional: true, defaultValue: 3 }],
        ["dry_run", "boolean", { optional: true, defaultValue: true }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: true },
    workflow: "statements",
    mutation: "dry-run"
  },
  {
    name: "record_investment",
    definition: {
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
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "transactions",
    mutation: "write"
  },
  {
    name: "buy_security",
    definition: {
      parameters: [
        ["account_id", "string"],
        ["symbol", "string"],
        ["shares", "number"],
        ["total_cost_cents", "integer"],
        ["date", "string"],
        ["commission_cents", "integer", { optional: true, defaultValue: 0 }],
        ["status", "string", { optional: true, defaultValue: "posted" }],
        ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "read",
    mutation: "write"
  },
  {
    name: "recognize_gain_loss",
    definition: {
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
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "read",
    mutation: "write"
  }
] as const);
