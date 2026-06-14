import type { Row, ToolHandlers, ToolRuntimeContext } from "../tool-runtime.js";
import { assertTransactionDeletionAllowed, planTransactionDeletion, presentTransactionDeletionPlan } from "../transaction-deletion.js";
import { defineToolGroup } from "../tool-spec.js";

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

export function transactionHandlers(ctx: ToolRuntimeContext, handlers: ToolHandlers): Partial<ToolHandlers> {
  const {
    MAX_MATCH_INPUT_LENGTH,
    account,
    accountAsset,
    accountDefaultAsset,
    amountWithinTolerance,
    applyRecategorizeTransaction,
    asset,
    compactTransactionEffects,
    counterpartForRow,
    dateDeltaDays,
    directedTxPublic,
    display,
    entriesPublic,
    explicitAsset,
    id,
    importPreview,
    isBulkCategorizationCandidate,
    iterTransactions,
    journalLegQuantity,
    hasSelectedSameTypeAncestor,
    monthBounds,
    optionalDate,
    parseTxStatusFilter,
    presentAccountBalance,
    postedAtBound,
    positiveAtomicQuantity,
    positiveMoneyAmount,
    positiveShareQuantity,
    realizedPlannedRows,
    recategorizePreview,
    recurringDateRange,
    reportStatus,
    resolveScopedAccounts,
    safeMatchRegex,
    signedMoneyAmount,
    tagTx,
    today,
    transactionAsset,
    transactionMagnitude,
    txPublic,
    txWithEntries,
    unsupportedArguments,
    validateDate
  } = ctx;
  return {

    create_transaction: (ledger, args) => {
      const fromAccountId = account(ledger, args.from_account_id);
      const toAccountId = account(ledger, args.to_account_id);
      const assetId = transactionAsset(ledger, fromAccountId, toAccountId, args.asset_id);
      const quantity = positiveMoneyAmount(ledger, assetId, args.amount, "Transaction amount");
      const tx = ledger.recordTransaction(validateDate(args.date), quantity, fromAccountId, toAccountId, assetId, args.description ?? "", args.status ?? "pending");
      if (args.branch) {
        handlers.create_branch(ledger, { name: args.branch });
        tagTx(ledger, tx.id, "branch", String(args.branch));
      }
      return directedTxPublic(ledger, tx, fromAccountId, toAccountId);
    },

    transfer: (ledger, args) => {
      const tx = handlers.create_transaction(ledger, { ...args, status: args.status ?? "posted", from_account_id: args.from_account_id, to_account_id: args.to_account_id }) as Row;
      return {
        tx,
        entries: tx.entries,
        amount: tx.amount,
        amount_cents: tx.amount_cents,
        from_account: tx.from_account,
        to_account: tx.to_account
      };
    },

    plan_transaction: (ledger, args) => handlers.create_transaction(ledger, { ...args, status: "planned" }),

    post_journal_entry: (ledger, args) => {
      const defaultAsset = args.asset_id ? explicitAsset(ledger, args.asset_id) : null;
      const lines = (args.legs ?? []).map((leg: Row) => {
        const accountId = account(ledger, leg.account_id ?? leg.account);
        const assetId = leg.asset_id ? explicitAsset(ledger, leg.asset_id) : defaultAsset ?? accountAsset(ledger, accountId, "leg.asset_id");
        return [accountId, assetId, journalLegQuantity(ledger, assetId, leg)] as [string, string, bigint];
      });
      const txId = ledger.postTx(validateDate(args.date), args.status ?? "pending", args.description ?? "", lines);
      return txWithEntries(ledger, txId);
    },

    record_opening_balance: (ledger, args) => {
      const accountId = account(ledger, args.account_id);
      const assetId = args.asset_id ? explicitAsset(ledger, args.asset_id) : accountAsset(ledger, accountId);
      return txPublic(ledger, ledger.recordOpeningBalance(accountId, signedMoneyAmount(ledger, assetId, args.amount, "Opening balance"), assetId, validateDate(args.date), args.status ?? "pending", args.counterpart_account_id ? account(ledger, args.counterpart_account_id) : null));
    },

    record_opening_balances: (ledger, args) => {
      const rows = (args.balances ?? []).map((row: Row) => handlers.record_opening_balance(ledger, { ...row, date: args.date, status: args.status ?? "pending" }));
      return { created: rows.length, transactions: rows };
    },

    list_transactions: (ledger, args) => {
      const dateRange = args.year ? monthBounds(Number(args.year), args.month ? Number(args.month) : null) : [optionalDate(args.date_from), optionalDate(args.date_to)];
      const options = {
        desc: args.desc,
        accountId: args.account_id ? account(ledger, args.account_id) : args.category_id ? account(ledger, args.category_id) : null,
        assetId: args.asset_id ? asset(ledger, args.asset_id) : null,
        amountMin: args.amount_min == null ? null : BigInt(args.amount_min as string | number | bigint | boolean),
        amountMax: args.amount_max == null ? null : BigInt(args.amount_max as string | number | bigint | boolean),
        status: parseTxStatusFilter(args.status),
        dateFrom: dateRange[0],
        dateTo: dateRange[1],
        sort: args.sort ?? "date_desc"
      };
      const total = ledger.searchTransactions({ ...options, limit: null, offset: 0 }).length;
      const rows = ledger.searchTransactions({ ...options, limit: args.limit ?? 50, offset: args.offset ?? 0 }).map((tx) => {
        const row = txPublic(ledger, tx, args.compact !== false);
        if (args.include_account_effects === true) row.account_effects = compactTransactionEffects(ledger, tx, args);
        return row;
      });
      return { transactions: rows, items: rows, total, limit: args.limit ?? 50, offset: args.offset ?? 0 };
    },

    search_transactions: (ledger, args) => {
      const dateRange = args.year ? monthBounds(Number(args.year), args.month ? Number(args.month) : null) : [optionalDate(args.date_from), optionalDate(args.date_to)];
      const options = {
        desc: args.desc ?? args.query,
        accountId: args.account_id ? account(ledger, args.account_id) : args.category_id ? account(ledger, args.category_id) : null,
        assetId: args.asset_id ? asset(ledger, args.asset_id) : null,
        amountMin: args.amount_min == null ? null : BigInt(args.amount_min as string | number | bigint | boolean),
        amountMax: args.amount_max == null ? null : BigInt(args.amount_max as string | number | bigint | boolean),
        status: parseTxStatusFilter(args.status),
        dateFrom: dateRange[0],
        dateTo: dateRange[1],
        postedAtFrom: postedAtBound(args.posted_at_from, "from"),
        postedAtTo: postedAtBound(args.posted_at_to, "to"),
        sort: args.sort ?? "date_desc"
      };
      const total = ledger.searchTransactions({ ...options, limit: null, offset: 0 }).length;
      const rows = ledger.searchTransactions({ ...options, limit: args.limit ?? 50, offset: args.offset ?? 0 }).map((tx) => {
        const row = txPublic(ledger, tx, false);
        if (args.include_account_effects === true) row.account_effects = compactTransactionEffects(ledger, tx, args);
        return row;
      });
      return { transactions: rows, items: rows, total, limit: args.limit ?? 50, offset: args.offset ?? 0 };
    },

    get_transaction: (ledger, args) => txWithEntries(ledger, args.id),

    delete_transaction: (ledger, args) => {
      const plan = planTransactionDeletion(ledger, [args.id], Boolean(args.hard_delete));
      if (args.dry_run === true) return { ...plan, deleted: 0, voided: 0, dry_run: true };
      assertTransactionDeletionAllowed(plan);
      if (args.hard_delete) ledger.deleteTx(args.id);
      else ledger.voidTx(args.id);
      return { deleted: args.hard_delete ? 1 : 0, voided: args.hard_delete ? 0 : 1, tx_id: args.id, hard_delete: Boolean(args.hard_delete), dry_run: false };
    },

    list_entries: (ledger, args) => {
      if (!ledger.getTx(args.tx_id)) throw new Error(`Transaction '${args.tx_id}' not found`);
      return entriesPublic(ledger, args.tx_id);
    },

    list_entries_by_asset: (ledger, args) => {
      const assetId = asset(ledger, args.asset_id);
      const rows = ledger.listEntriesByAsset(assetId, args.limit ?? 100, args.offset ?? 0);
      const entries = rows.map((row) => ({ ...row, tx_id: row.journal_id, qty_cents: row.quantity }));
      return { entries, items: entries, limit: args.limit ?? 100, offset: args.offset ?? 0 };
    },

    get_balance: (ledger, args) => {
      const accountId = account(ledger, args.account_id);
      const acct = ledger.getAccount(accountId)!;
      const balances = ledger.listAssets().map((ast) => {
        const balance = ledger.balanceTree(accountId, ast.id, optionalDate(args.date), parseTxStatusFilter(args.status, "posted"));
        return { account_id: accountId, asset_id: ast.id, asset_symbol: ast.symbol, quantity: balance, balance, balance_cents: balance, scale: ast.scale, balance_display: display(ledger, balance, ast.id) };
      }).filter((row) => row.balance !== 0n);
      if (balances.length === 0) {
        const defaultAssetId = accountDefaultAsset(ledger, accountId);
        const defaultAsset = defaultAssetId ? ledger.getAsset(defaultAssetId) : null;
        if (defaultAsset) balances.push({ account_id: accountId, asset_id: defaultAsset.id, asset_symbol: defaultAsset.symbol, quantity: 0n, balance: 0n, balance_cents: 0n, scale: defaultAsset.scale, balance_display: 0 });
      }
      const defaultAssetId = accountDefaultAsset(ledger, accountId);
      const primary = balances.find((row) => row.asset_id === defaultAssetId) ?? balances[0];
      return {
        account_id: accountId,
        account_name: acct.name,
        balances,
        balance: primary?.balance ?? 0n,
        balance_cents: primary?.balance_cents ?? 0n,
        total_cents: balances.reduce((sum, row) => sum + row.balance, 0n)
      };
    },

    account_balances: (ledger, args) => {
      const scope = resolveScopedAccounts(ledger, args);
      const scopedRootIds = new Set(scope.root_account_ids);
      let rows = ledger.accountBalances({
        accountType: args.account_type ?? null,
        assetId: args.asset_id ? asset(ledger, args.asset_id) : null,
        asOf: args.as_of ? validateDate(args.as_of) : null,
        rollup: Boolean(args.rollup),
        hideZero: args.hide_zero !== false
      });
      if (scope.account_ids) rows = rows.filter((row) => scope.account_ids!.has(row.account_id));
      if (scope.scoped && args.rollup === true) rows = rows.filter((row) => scopedRootIds.has(row.account_id));
      rows = rows.filter((row) => args.native_asset_only !== true || args.asset_id || row.asset_id === row.default_asset_id);
      const rowIds = new Set(rows.map((row) => row.account_id));
      const overlappingRollup = args.rollup === true && !scope.scoped && rows.some((row) => hasSelectedSameTypeAncestor(ledger, row.account_id, rowIds));
      const summable = args.rollup === true ? !overlappingRollup : true;
      return rows.map((row) => {
        const current = presentAccountBalance(ledger, row.account_id, row.asset_id, row.current_balance_cents, args.presentation);
        const posted = presentAccountBalance(ledger, row.account_id, row.asset_id, row.posted_balance_cents, args.presentation);
        const pending = presentAccountBalance(ledger, row.account_id, row.asset_id, row.pending_balance_cents, args.presentation);
        return {
          ...row,
          summable,
          ...(scope.scoped ? { scope: { account_ids: [...scope.account_ids!], root_account_ids: scope.root_account_ids } } : {}),
          ...(overlappingRollup ? { rollup_warning: "Rollup rows include parent and child accounts; pass account_ids or entity_id for summable scoped rollups." } : {}),
          display_sign_basis: current.display_sign_basis,
          display_balance_cents: current.display_balance_cents,
          display_balance: current.display_balance,
          posted_display_balance_cents: posted.display_balance_cents,
          posted_display_balance: posted.display_balance,
          pending_display_balance_cents: pending.display_balance_cents,
          pending_display_balance: pending.display_balance,
          current_display_balance_cents: current.display_balance_cents,
          current_display_balance: current.display_balance
        };
      });
    },

    recategorize_transaction: (ledger, args) => {
      const preview = recategorizePreview(ledger, args);
      return args.dry_run === true ? preview : applyRecategorizeTransaction(ledger, args);
    },

    flip_entries: (ledger, args) => {
      if (!args.tx_ids?.length) throw new Error("tx_ids is required");
      for (const txId of args.tx_ids) if (!ledger.getTx(txId)) throw new Error(`Transaction '${txId}' not found`);
      const flipped = ledger.flipEntries(args.tx_ids);
      return { flipped: flipped.length, tx_ids: flipped };
    },

    void_by_filter: (ledger, args) => {
      const matches = (handlers.list_transactions(ledger, { ...args, compact: true, limit: 100000 }) as Row).transactions as Row[];
      const dryRun = args.dry_run !== false;
      const plan = planTransactionDeletion(ledger, matches.map((tx) => String(tx.id)), Boolean(args.hard_delete));
      const output = presentTransactionDeletionPlan(plan, args.sample_limit);
      if (dryRun) return { ...output, voided: 0, deleted: 0, dry_run: true };
      assertTransactionDeletionAllowed(plan);
      for (const tx of matches) args.hard_delete ? ledger.deleteTx(String(tx.id)) : ledger.voidTx(String(tx.id));
      return { ...output, voided: args.hard_delete ? 0 : matches.length, deleted: args.hard_delete ? matches.length : 0, dry_run: false };
    },

    move_transactions: (ledger, args) => {
      const source = account(ledger, args.from_account);
      const target = account(ledger, args.to_account);
      const count = ledger.countEntriesByAccount(source);
      return args.dry_run === false ? { matched: count, moved: ledger.moveEntriesBetweenAccounts(source, target), dry_run: false } : { matched: count, moved: 0, dry_run: true };
    },

    add_match_rule: (ledger, args) => ({ id: ledger.createRule("match", account(ledger, args.account_id), args.pattern), account_id: account(ledger, args.account_id), pattern: args.pattern }),

    add_match_rules: (ledger, args) => {
      const rules: Row[] = [];
      const errors: Row[] = [];
      (args.rules ?? []).forEach((row: Row, index: number) => {
        try {
          rules.push(handlers.add_match_rule(ledger, { account_id: row.account_id ?? row.account, pattern: row.pattern }) as Row);
        } catch (error) {
          errors.push({ index, error: error instanceof Error ? error.message : String(error) });
        }
      });
      return { created: rules.length, rules, errors };
    },

    list_match_rules: (ledger) => ledger.listRules("match"),

    delete_match_rule: (ledger, args) => ({ deleted: ledger.deleteRule(account(ledger, args.account_id), args.pattern), account_id: account(ledger, args.account_id), pattern: args.pattern }),

    delete_match_rules: (ledger, args) => ({ deleted: (args.rules ?? []).reduce((sum: number, row: Row) => sum + Number((handlers.delete_match_rule(ledger, { account_id: row.account_id ?? row.account, pattern: row.pattern }) as Row).deleted), 0), errors: [] }),

    apply_match_rules: (ledger, args) => {
      const catchAll = account(ledger, args.catch_all_account_id);
      const changed: Row[] = [];
      const dryRun = args.dry_run !== false;
      for (const tx of ledger.listTransactions({ status: null, dateFrom: optionalDate(args.date_from), dateTo: optionalDate(args.date_to) }).filter(isBulkCategorizationCandidate)) {
        const match = ledger.autoCategorize(tx.description);
        if (!match) continue;
        if (ledger.getEntries(tx.id).some((entry) => entry.account_id === catchAll)) {
          changed.push({ tx_id: tx.id, new_account_id: match });
          if (!dryRun) ledger.recategorizeTransaction(tx.id, catchAll, match);
        }
      }
      return { matched: changed.length, updated: dryRun ? 0 : changed.length, transactions: changed, dry_run: dryRun };
    },

    apply_pattern: (ledger, args) => {
      unsupportedArguments({ force: args.force });
      return handlers.recategorize_by_pattern(ledger, { pattern: args.pattern, new_account_id: args.target_account, old_account_id: args.source_account, date_from: args.date_from, date_to: args.date_to, dry_run: args.dry_run, persist_rule: args.persist_rule });
    },

    recategorize_by_pattern: (ledger, args) => {
      const newAccount = account(ledger, args.new_account_id);
      const oldAccount = args.old_account_id ? account(ledger, args.old_account_id) : null;
      const dryRun = args.dry_run !== false;
      const matches: Row[] = [];
      const regex = safeMatchRegex(args.pattern);
      for (const tx of iterTransactions(ledger, { status: reportStatus(args, "posted"), date_from: args.date_from, date_to: args.date_to })) {
        if (!regex.test(tx.description.slice(0, MAX_MATCH_INPUT_LENGTH))) continue;
        const entries = ledger.getEntries(tx.id);
        const magnitudes = entries.map((entry) => entry.quantity < 0n ? -entry.quantity : entry.quantity);
        if (args.amount_min != null && (magnitudes.length === 0 || magnitudes.every((amount) => amount < BigInt(args.amount_min as string | number | bigint | boolean)))) continue;
        if (args.amount_max != null && (magnitudes.length === 0 || magnitudes.every((amount) => amount > BigInt(args.amount_max as string | number | bigint | boolean)))) continue;
        const selectedOld = oldAccount ?? entries.find((entry) => ledger.getAccount(entry.account_id)?.account_type === "expense")?.account_id ?? entries[0]?.account_id;
        if (!selectedOld) continue;
        matches.push({ tx_id: tx.id, old_account_id: selectedOld, new_account_id: newAccount, description: tx.description });
      }
      const batchId = id("recat");
      if (!dryRun) for (const match of matches) { ledger.recategorizeTransaction(match.tx_id, match.old_account_id, match.new_account_id); tagTx(ledger, match.tx_id, "recategorize_batch", batchId); tagTx(ledger, match.tx_id, "recategorize_from", match.old_account_id); tagTx(ledger, match.tx_id, "recategorize_to", match.new_account_id); }
      if (args.persist_rule && !dryRun) ledger.createRule("match", newAccount, args.pattern);
      return { matched: matches.length, updated: dryRun ? 0 : matches.length, transactions: args.verbose || dryRun ? matches : [], batch_id: batchId, dry_run: dryRun };
    },

    recategorize_by_patterns: (ledger, args) => {
      const results = (args.rules ?? []).map((rule: Row) => handlers.recategorize_by_pattern(ledger, { ...args, pattern: rule.pattern, new_account_id: rule.new_account_id ?? rule.target_account, persist_rule: args.persist_rules }));
      return { rules: results.length, matched: results.reduce((s: number, r: any) => s + r.matched, 0), updated: results.reduce((s: number, r: any) => s + r.updated, 0), results, dry_run: args.dry_run !== false };
    },

    rollback_recategorize: (ledger, args) => {
      const rows = ledger.listAnnotationEntityIds("tx", "recategorize_batch", args.batch_id).map((entity_id) => ({ entity_id }));
      let rolled = 0;
      for (const row of rows) {
        const txId = String(row.entity_id);
        const tags = ledger.listAnnotations("tx", txId);
        const from = tags.filter((tag) => tag.key === "recategorize_from").at(-1)?.value;
        const taggedTo = tags.filter((tag) => tag.key === "recategorize_to").at(-1)?.value;
        const entries = ledger.getEntries(txId);
        const fromAccountType = from ? ledger.getAccount(from)?.account_type : null;
        const sameTypeAccounts = [...new Set(entries
          .filter((entry) => entry.account_id !== from && (!fromAccountType || ledger.getAccount(entry.account_id)?.account_type === fromAccountType))
          .map((entry) => entry.account_id))];
        const current = taggedTo && entries.some((entry) => entry.account_id === taggedTo) ? taggedTo : sameTypeAccounts.length === 1 ? sameTypeAccounts[0] : null;
        if (from && current && current !== from) { ledger.recategorizeTransaction(txId, current, from); rolled += 1; }
      }
      return { batch_id: args.batch_id, rolled_back: rolled };
    },

    fx_transfer: (ledger, args) => {
      const fromAsset = asset(ledger, args.from_asset_id);
      const toAsset = asset(ledger, args.to_asset_id);
      const fromQty = positiveMoneyAmount(ledger, fromAsset, args.from_amount, "FX source amount");
      const toQty = positiveMoneyAmount(ledger, toAsset, args.to_amount, "FX target amount");
      const txDate = validateDate(args.date);
      const txId = ledger.postTx(txDate, args.status ?? "posted", args.description, [
        [account(ledger, args.from_account_id), fromAsset, -fromQty],
        [account(ledger, args.fx_account_id), fromAsset, fromQty],
        [account(ledger, args.fx_account_id), toAsset, -toQty],
        [account(ledger, args.to_account_id), toAsset, toQty]
      ]);
      if (args.record_rate !== false) ledger.createPrice(fromAsset, toAsset, Number(args.to_amount) / Number(args.from_amount), txDate);
      return txWithEntries(ledger, txId);
    },

    create_scheduled_transaction: (ledger, args) => {
      const fromAccountId = account(ledger, args.from_account_id);
      const toAccountId = account(ledger, args.to_account_id);
      const assetId = transactionAsset(ledger, fromAccountId, toAccountId, args.asset_id);
      const row = ledger.createRecurrence(validateDate(args.date), positiveMoneyAmount(ledger, assetId, args.amount, "Scheduled transaction amount"), fromAccountId, toAccountId, args.description ?? "", args.frequency ?? "monthly", args.end_date ? validateDate(String(args.end_date)) : null, assetId);
      return { id: row.id, next_date: args.date, frequency: args.frequency ?? "monthly" };
    },

    list_scheduled: (ledger) => ledger.listRecurrences(),

    process_scheduled: (ledger, args) => {
      const through = args.through_date ? validateDate(String(args.through_date)) : today();
      const posted: string[] = [];
      for (const row of handlers.list_scheduled(ledger, {}) as Row[]) {
        if (row.status !== "active" || row.next_date > through) continue;
        const tx = ledger.recordTransaction(row.next_date, BigInt(row.quantity), row.from_account_id, row.to_account_id, row.asset_id, row.description, "posted");
        posted.push(tx.id);
        const next = new Date(`${row.next_date}T00:00:00Z`);
        if (row.frequency === "daily") next.setUTCDate(next.getUTCDate() + 1);
        else if (row.frequency === "weekly") next.setUTCDate(next.getUTCDate() + 7);
        else if (row.frequency === "yearly") next.setUTCFullYear(next.getUTCFullYear() + 1);
        else next.setUTCMonth(next.getUTCMonth() + 1);
        ledger.updateRecurrenceNextDate(String(row.id), next.toISOString().slice(0, 10));
      }
      return { posted: posted.length, tx_ids: posted };
    },

    detect_recurring: (ledger, args) => {
      const accountId = args.account_id ? account(ledger, args.account_id) : null;
      const [dateFrom, dateTo] = recurringDateRange(args);
      const tolerancePct = Number(args.amount_tolerance_pct ?? 5);
      const groups: Array<{ description: string; amount: bigint; occurrences: number; dates: string[]; tx_ids: string[] }> = [];
      for (const tx of ledger.listTransactions({ status: "posted", dateFrom, dateTo, sort: "date_asc" })) {
        if (!tx.description) continue;
        if (accountId && !ledger.getEntries(tx.id).some((entry) => entry.account_id === accountId)) continue;
        const amount = transactionMagnitude(ledger, tx.id, accountId);
        const descriptionKey = tx.description.trim().toLowerCase();
        const group = groups.find((row) => row.description.trim().toLowerCase() === descriptionKey && amountWithinTolerance(row.amount, amount, tolerancePct));
        if (group) {
          group.occurrences += 1;
          group.dates.push(tx.date);
          group.tx_ids.push(tx.id);
        } else {
          groups.push({ description: tx.description, amount, occurrences: 1, dates: [tx.date], tx_ids: [tx.id] });
        }
      }
      return groups
        .filter((row) => row.occurrences >= (args.min_occurrences ?? 2))
        .map((row) => ({ ...row, amount_cents: row.amount, first_date: row.dates[0], last_date: row.dates.at(-1), months: args.months ?? 6, date_from: dateFrom, date_to: dateTo }));
    },

    pending_summary: (ledger, args) => {
      const [date_from, date_to] = args.year ? monthBounds(args.year, args.month) : [undefined, undefined];
      const rows = ledger.listTransactions({ status: "pending", dateFrom: date_from, dateTo: date_to }).map((tx) => txPublic(ledger, tx));
      return { count: rows.length, transactions: rows, total_cents: rows.reduce((sum, row) => sum + BigInt(row.amount_cents), 0n) };
    },

    record_pending_expenses: (ledger, args) => {
      const accountId = account(ledger, args.account_id);
      const explicitFallback = args.counterpart_id ? account(ledger, args.counterpart_id) : null;
      const rows = (args.transactions ?? []).map((row: Row) => {
        const matched = counterpartForRow(ledger, row, explicitFallback);
        return matched ? { ...row, counterpart_id: matched } : row;
      });
      const hasUnresolved = rows.some((row: Row) => !row.counterpart_id);
      if (args.dry_run !== false) {
        const previewFallback = hasUnresolved ? ledger.findAccount("Pending Expenses")?.id ?? "__pending_expenses__" : explicitFallback ?? null;
        const previewRows = hasUnresolved ? rows.map((row: Row) => row.counterpart_id ? row : { ...row, counterpart_id: previewFallback }) : rows;
        const preview = importPreview(ledger, accountId, previewFallback, previewRows, { ...args, status: "pending", amount_convention: "unsigned_charges" });
        const usesSyntheticFallback = (preview.transactions as Row[]).some((tx) => (tx.entries as Row[]).some((entry) => entry.account_id === "__pending_expenses__"));
        return {
          ...preview,
          would_create_account: usesSyntheticFallback ? "Pending Expenses" : null
        };
      }
      const fallback = hasUnresolved ? ledger.getOrCreateAccount("Pending Expenses", "expense") : explicitFallback ?? String(rows.find((row: Row) => row.counterpart_id)?.counterpart_id ?? "");
      if (!fallback && rows.length === 0) return { created: 0, transactions: [], errors: [], skipped: 0, dry_run: false, batch_id: null, imported: 0, transfer_stats: { matched: 0, unmatched: 0 } };
      const importRows = rows.map((row: Row) => row.counterpart_id ? row : { ...row, counterpart_id: fallback });
      return handlers.import_transactions(ledger, {
        account_id: args.account_id,
        counterpart_id: fallback,
        transactions: importRows,
        status: "pending",
        dry_run: args.dry_run !== false,
        batch_label: args.batch_label,
        tags: args.tags,
        amount_convention: "unsigned_charges",
        asset_id: args.asset_id,
        skip_dedup: args.skip_dedup
      });
    },

    find_pending_duplicates: (ledger, args) => {
      const tolerance = Number(args.date_tolerance_days ?? 3);
      const pending = (handlers.list_transactions(ledger, { account_id: args.account_id, status: "pending", date_from: args.date_from, date_to: args.date_to, compact: false, limit: 100000 }) as Row).transactions as Row[];
      const posted = (handlers.list_transactions(ledger, { account_id: args.account_id, status: "posted", compact: false, limit: 100000 }) as Row).transactions as Row[];
      const byAmountDescription = (rows: Row[]) => {
        const groups = new Map<string, Row[]>();
        for (const tx of rows) {
          const key = `${tx.amount_cents}|${String(tx.description).toLowerCase()}`;
          groups.set(key, [...(groups.get(key) ?? []), tx]);
        }
        return groups;
      };
      const pendingGroups = byAmountDescription(pending);
      const postedGroups = byAmountDescription(posted);
      const duplicates: Row[] = [];
      for (const [key, rows] of pendingGroups) {
        if (rows.length > 1 && rows.some((left, index) => rows.slice(index + 1).some((right) => dateDeltaDays(String(left.date), String(right.date)) <= tolerance))) {
          duplicates.push({ type: "pending", key, tx_ids: rows.map((tx) => tx.id) });
        }
        const postedMatches = (postedGroups.get(key) ?? []).filter((postedTx) => rows.some((pendingTx) => dateDeltaDays(String(pendingTx.date), String(postedTx.date)) <= tolerance));
        if (postedMatches.length > 0) {
          duplicates.push({
            type: "posted",
            key,
            pending_tx_ids: rows.map((tx) => tx.id),
            posted_tx_ids: postedMatches.map((tx) => tx.id),
            tx_ids: [...rows.map((tx) => tx.id), ...postedMatches.map((tx) => tx.id)]
          });
        }
      }
      return { duplicates, count: duplicates.length };
    },

    find_realized_planned: (ledger, args) => {
      const rows = realizedPlannedRows(ledger, args);
      return {
        realized_planned_rows: rows,
        count: rows.length,
        matched: rows.length,
        ambiguous_count: rows.filter((row) => row.ambiguous).length,
        dry_run: true
      };
    },

    reconcile_planned: (ledger, args) => {
      const rows = realizedPlannedRows(ledger, args);
      const dryRun = args.dry_run !== false;
      const ambiguous = rows.filter((row) => row.ambiguous);
      if (!dryRun && ambiguous.length > 0) throw new Error("reconcile_planned found ambiguous matches; review realized_planned_rows before voiding planned rows");
      if (!dryRun) {
        for (const row of rows) {
          const tx = ledger.getTx(String(row.planned_tx_id));
          if (tx?.status === "planned") ledger.voidTx(tx.id);
        }
      }
      return {
        realized_planned_rows: rows,
        matched: rows.length,
        ambiguous_count: ambiguous.length,
        voided: dryRun ? 0 : rows.length,
        tx_ids: rows.map((row) => row.planned_tx_id),
        dry_run: dryRun
      };
    },

    record_investment: (ledger, args) => handlers.create_transaction(ledger, { from_account_id: args.source_account_id, to_account_id: args.investment_account_id, amount: args.amount, date: args.date, description: args.description, status: args.status ?? "posted", asset_id: args.asset_id }),

    buy_security: (ledger, args) => {
      const investmentAccount = account(ledger, args.account_id);
      const cashAsset = args.asset_id ? explicitAsset(ledger, args.asset_id) : accountAsset(ledger, investmentAccount);
      const shares = positiveShareQuantity(args.shares);
      const totalCost = positiveAtomicQuantity(BigInt(args.total_cost_cents) + BigInt(args.commission_cents ?? 0), "Security cost");
      const tx = ledger.recordSecurityPurchase({ symbol: args.symbol, shares, totalCost, cashAssetId: cashAsset, investmentAccountId: investmentAccount, date: validateDate(args.date), status: args.status ?? "posted" });
      return txWithEntries(ledger, tx.id);
    },

    recognize_gain_loss: (ledger, args) => {
      const gainLoss = args.gain_loss_account_id ? account(ledger, args.gain_loss_account_id) : ledger.getOrCreateAccount("Investment Gain/Loss", "income");
      const assetId = asset(ledger, args.asset_id);
      const amount = signedMoneyAmount(ledger, assetId, args.amount, "Gain/loss amount");
      return amount >= 0n
        ? handlers.create_transaction(ledger, { date: args.date, amount: args.amount, from_account_id: gainLoss, to_account_id: args.investment_account_id, description: args.description, status: args.status ?? "posted", asset_id: assetId })
        : handlers.create_transaction(ledger, { date: args.date, amount: display(ledger, -amount, assetId), from_account_id: args.investment_account_id, to_account_id: gainLoss, description: args.description, status: args.status ?? "posted", asset_id: assetId });
    },
  };
}
