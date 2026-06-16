import { defineToolGroup } from "../../tool-spec.js";

export const statementTools = defineToolGroup([
  {
    name: "import_transactions",
    definition: {
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
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "statements",
    mutation: "write"
  },
  {
    name: "import_file",
    definition: {
      parameters: [
        ["file_path", "string"],
        ["account_id", "string"],
        ["counterpart_account_id", "string"],
        ["currency", "string", { nullable: true, optional: true, defaultValue: null }],
        ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["date_col", "string", { nullable: true, optional: true, defaultValue: null }],
        ["amount_col", "string", { nullable: true, optional: true, defaultValue: null }],
        ["desc_col", "string", { nullable: true, optional: true, defaultValue: null }],
        ["inflow_col", "string", { nullable: true, optional: true, defaultValue: null }],
        ["outflow_col", "string", { nullable: true, optional: true, defaultValue: null }],
        ["counterpart_col", "string", { nullable: true, optional: true, defaultValue: null }],
        ["tag_cols", "object", { nullable: true, optional: true, defaultValue: null }],
        ["skip_rows", "integer", { optional: true, defaultValue: 0 }],
        ["skip_footer_rows", "integer", { optional: true, defaultValue: 0 }],
        ["date_format", "string", { optional: true, defaultValue: "auto" }],
        ["status", "string", { optional: true, defaultValue: "pending" }],
        ["amount_convention", "string", { optional: true, defaultValue: "signed" }],
        ["show_duplicates", "boolean", { optional: true, defaultValue: false }],
        ["statement_type", "string", { nullable: true, optional: true, defaultValue: null }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "statements",
    mutation: "filesystem"
  },
  {
    name: "preview_import",
    definition: {
      parameters: [
        ["file_path", "string"],
        ["account_id", "string"],
        ["counterpart_account_id", "string"],
        ["rows", "integer", { optional: true, defaultValue: 3 }],
        ["currency", "string", { nullable: true, optional: true, defaultValue: null }],
        ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["date_col", "string", { nullable: true, optional: true, defaultValue: null }],
        ["amount_col", "string", { nullable: true, optional: true, defaultValue: null }],
        ["desc_col", "string", { nullable: true, optional: true, defaultValue: null }],
        ["inflow_col", "string", { nullable: true, optional: true, defaultValue: null }],
        ["outflow_col", "string", { nullable: true, optional: true, defaultValue: null }],
        ["skip_rows", "integer", { optional: true, defaultValue: 0 }],
        ["skip_footer_rows", "integer", { optional: true, defaultValue: 0 }],
        ["date_format", "string", { optional: true, defaultValue: "auto" }],
        ["amount_convention", "string", { optional: true, defaultValue: "signed" }],
        ["statement_type", "string", { nullable: true, optional: true, defaultValue: null }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "statements",
    mutation: "read"
  },
  {
    name: "process_statement",
    definition: {
      parameters: [
        ["file_path", "string"],
        ["account_id", "string"],
        ["counterpart_account_id", "string"],
        ["expected_balance", "number", { nullable: true, optional: true, defaultValue: null }],
        ["currency", "string", { nullable: true, optional: true, defaultValue: null }],
        ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["date_col", "string", { nullable: true, optional: true, defaultValue: null }],
        ["amount_col", "string", { nullable: true, optional: true, defaultValue: null }],
        ["desc_col", "string", { nullable: true, optional: true, defaultValue: null }],
        ["inflow_col", "string", { nullable: true, optional: true, defaultValue: null }],
        ["outflow_col", "string", { nullable: true, optional: true, defaultValue: null }],
        ["counterpart_col", "string", { nullable: true, optional: true, defaultValue: null }],
        ["tag_cols", "object", { nullable: true, optional: true, defaultValue: null }],
        ["skip_rows", "integer", { optional: true, defaultValue: 0 }],
        ["skip_footer_rows", "integer", { optional: true, defaultValue: 0 }],
        ["date_format", "string", { optional: true, defaultValue: "auto" }],
        ["amount_convention", "string", { optional: true, defaultValue: "signed" }],
        ["statement_type", "string", { nullable: true, optional: true, defaultValue: null }],
        ["balance_sign", "string", { nullable: true, optional: true, defaultValue: null }],
        ["transfer_account_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["date_tolerance_days", "integer", { optional: true, defaultValue: 1 }],
        ["commit", "boolean", { optional: true, defaultValue: false }],
        ["show_duplicates", "boolean", { optional: true, defaultValue: true }],
        ["preview_rows", "integer", { optional: true, defaultValue: 10 }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "statements",
    mutation: "filesystem"
  },
  {
    name: "list_import_batches",
    definition: {
      parameters: [
        ["limit", "integer", { optional: true, defaultValue: 20 }],
        ["date_from", "string", { nullable: true, optional: true, defaultValue: null }]
      ],
      returns: { type: "object[]" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "statements",
    mutation: "read"
  },
  {
    name: "rollback_import",
    definition: {
      parameters: [
        ["batch_id", "string"]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "statements",
    mutation: "write"
  },
  {
    name: "commit_batch",
    definition: {
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
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "statements",
    mutation: "write"
  },
  {
    name: "discard_batch",
    definition: {
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
    safety: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: true },
    workflow: "statements",
    mutation: "dry-run"
  },
  {
    name: "invert_import",
    definition: {
      parameters: [
        ["batch_id", "string"]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "statements",
    mutation: "write"
  },
  {
    name: "reconcile_statement",
    definition: {
      parameters: [
        ["account_id", "string"],
        ["counterpart_id", "string"],
        ["transactions", "object[]"],
        ["currency", "string", { nullable: true, optional: true, defaultValue: null }],
        ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["amount_convention", "string", { optional: true, defaultValue: "signed" }],
        ["statement_type", "string", { nullable: true, optional: true, defaultValue: null }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "statements",
    mutation: "read"
  },
  {
    name: "reconcile_statement_plan",
    definition: {
      parameters: [
        ["file_path", "string"],
        ["account_id", "string"],
        ["counterpart_account_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["expected_balance", "number", { nullable: true, optional: true, defaultValue: null }],
        ["currency", "string", { nullable: true, optional: true, defaultValue: null }],
        ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["date_col", "string", { nullable: true, optional: true, defaultValue: null }],
        ["amount_col", "string", { nullable: true, optional: true, defaultValue: null }],
        ["desc_col", "string", { nullable: true, optional: true, defaultValue: null }],
        ["inflow_col", "string", { nullable: true, optional: true, defaultValue: null }],
        ["outflow_col", "string", { nullable: true, optional: true, defaultValue: null }],
        ["skip_rows", "integer", { optional: true, defaultValue: 0 }],
        ["skip_footer_rows", "integer", { optional: true, defaultValue: 0 }],
        ["date_format", "string", { optional: true, defaultValue: "auto" }],
        ["amount_convention", "string", { optional: true, defaultValue: "signed" }],
        ["statement_type", "string", { nullable: true, optional: true, defaultValue: null }],
        ["balance_sign", "string", { nullable: true, optional: true, defaultValue: null }],
        ["date_tolerance_days", "integer", { optional: true, defaultValue: 3 }],
        ["min_likely_score", "number", { optional: true, defaultValue: 0.72 }],
        ["sample_limit", "integer", { optional: true, defaultValue: 20 }],
        ["include_details", "boolean", { optional: true, defaultValue: false }],
        ["verbosity", "string", { nullable: true, optional: true, defaultValue: null }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "statements",
    mutation: "read"
  },
  {
    name: "apply_reconciliation_plan",
    definition: {
      parameters: [
        ["file_path", "string", { nullable: true, optional: true, defaultValue: null }],
        ["plan_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["account_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["counterpart_account_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["expected_balance", "number", { nullable: true, optional: true, defaultValue: null }],
        ["currency", "string", { nullable: true, optional: true, defaultValue: null }],
        ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["date_col", "string", { nullable: true, optional: true, defaultValue: null }],
        ["amount_col", "string", { nullable: true, optional: true, defaultValue: null }],
        ["desc_col", "string", { nullable: true, optional: true, defaultValue: null }],
        ["inflow_col", "string", { nullable: true, optional: true, defaultValue: null }],
        ["outflow_col", "string", { nullable: true, optional: true, defaultValue: null }],
        ["skip_rows", "integer", { optional: true, defaultValue: 0 }],
        ["skip_footer_rows", "integer", { optional: true, defaultValue: 0 }],
        ["date_format", "string", { optional: true, defaultValue: "auto" }],
        ["amount_convention", "string", { optional: true, defaultValue: "signed" }],
        ["statement_type", "string", { nullable: true, optional: true, defaultValue: null }],
        ["balance_sign", "string", { nullable: true, optional: true, defaultValue: null }],
        ["date_tolerance_days", "integer", { optional: true, defaultValue: 3 }],
        ["min_likely_score", "number", { optional: true, defaultValue: 0.72 }],
        ["row_indexes", "integer[]", { nullable: true, optional: true, defaultValue: null }],
        ["commit_imported", "boolean", { optional: true, defaultValue: false }],
        ["annotate_posted_matches", "boolean", { optional: true, defaultValue: true }],
        ["allow_review_skip", "boolean", { optional: true, defaultValue: false }],
        ["require_balance_match", "boolean", { optional: true, defaultValue: true }],
        ["sample_limit", "integer", { optional: true, defaultValue: 20 }],
        ["include_details", "boolean", { optional: true, defaultValue: false }],
        ["verbosity", "string", { nullable: true, optional: true, defaultValue: null }],
        ["dry_run", "boolean", { optional: true, defaultValue: true }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: true },
    workflow: "read",
    mutation: "filesystem"
  },
  {
    name: "refresh_statement",
    definition: {
      parameters: [
        ["action", "string", { optional: true, defaultValue: "plan" }],
        ["plan_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["file_path", "string", { nullable: true, optional: true, defaultValue: null }],
        ["account_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["counterpart_account_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["expected_balance", "number", { nullable: true, optional: true, defaultValue: null }],
        ["currency", "string", { nullable: true, optional: true, defaultValue: null }],
        ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["date_col", "string", { nullable: true, optional: true, defaultValue: null }],
        ["amount_col", "string", { nullable: true, optional: true, defaultValue: null }],
        ["desc_col", "string", { nullable: true, optional: true, defaultValue: null }],
        ["inflow_col", "string", { nullable: true, optional: true, defaultValue: null }],
        ["outflow_col", "string", { nullable: true, optional: true, defaultValue: null }],
        ["counterpart_col", "string", { nullable: true, optional: true, defaultValue: null }],
        ["tag_cols", "object", { nullable: true, optional: true, defaultValue: null }],
        ["skip_rows", "integer", { optional: true, defaultValue: 0 }],
        ["skip_footer_rows", "integer", { optional: true, defaultValue: 0 }],
        ["date_format", "string", { optional: true, defaultValue: "auto" }],
        ["amount_convention", "string", { optional: true, defaultValue: "signed" }],
        ["statement_type", "string", { nullable: true, optional: true, defaultValue: null }],
        ["balance_sign", "string", { nullable: true, optional: true, defaultValue: null }],
        ["date_tolerance_days", "integer", { optional: true, defaultValue: 3 }],
        ["row_indexes", "integer[]", { nullable: true, optional: true, defaultValue: null }],
        ["pending_transactions", "object[]", { nullable: true, optional: true, defaultValue: null }],
        ["void_stale_pending", "boolean", { optional: true, defaultValue: false }],
        ["status", "string", { optional: true, defaultValue: "posted" }],
        ["dry_run", "boolean", { optional: true, defaultValue: true }],
        ["batch_label", "string", { nullable: true, optional: true, defaultValue: null }],
        ["sample_limit", "integer", { optional: true, defaultValue: 20 }],
        ["include_details", "boolean", { optional: true, defaultValue: false }],
        ["verbosity", "string", { nullable: true, optional: true, defaultValue: null }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: true },
    workflow: "statements",
    mutation: "filesystem"
  },
  {
    name: "match_transfers",
    definition: {
      parameters: [
        ["account_a", "string"],
        ["account_b", "string"],
        ["date_tolerance_days", "integer", { optional: true, defaultValue: 1 }],
        ["dry_run", "boolean", { optional: true, defaultValue: true }],
        ["status", "string", { optional: true, defaultValue: "pending" }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: true },
    workflow: "transactions",
    mutation: "dry-run"
  },
  {
    name: "match_transfer_pairs",
    definition: {
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
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: true },
    workflow: "transactions",
    mutation: "dry-run"
  },
  {
    name: "consolidate_transfers",
    definition: {
      parameters: [
        ["account_a", "string"],
        ["account_b", "string"],
        ["transfer_account_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["date_tolerance_days", "integer", { optional: true, defaultValue: 1 }],
        ["dry_run", "boolean", { optional: true, defaultValue: true }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: true },
    workflow: "transactions",
    mutation: "dry-run"
  },
  {
    name: "list_unmatched_transfers",
    definition: {
      parameters: [
        ["date_tolerance_days", "integer", { optional: true, defaultValue: 3 }]
      ],
      returns: { type: "object[]" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "transactions",
    mutation: "read"
  }
] as const);
