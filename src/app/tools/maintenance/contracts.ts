import { defineToolGroup } from "../../tool-spec.js";

export const maintenanceTools = defineToolGroup([
  {
    name: "list_ledger_operations",
    definition: {
      parameters: [
        ["limit", "integer", { optional: true, defaultValue: 50 }]
      ],
      returns: { type: "object[]" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "maintenance",
    mutation: "read"
  },
  {
    name: "get_ledger_operation",
    definition: {
      parameters: [
        ["operation_id", "string"]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "maintenance",
    mutation: "read"
  },
  {
    name: "preview_mutation",
    definition: {
      parameters: [
        ["tool_name", "string"],
        ["arguments", "object", { optional: true }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "maintenance",
    mutation: "read"
  },
  {
    name: "reverse_ledger_operation",
    definition: {
      parameters: [
        ["operation_id", "string"],
        ["date", "string", { nullable: true, optional: true, defaultValue: null }],
        ["dry_run", "boolean", { optional: true, defaultValue: true }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: true },
    workflow: "maintenance",
    mutation: "dry-run"
  },
  {
    name: "export_transactions",
    definition: {
      parameters: [
        ["account_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["date_from", "string", { nullable: true, optional: true, defaultValue: null }],
        ["date_to", "string", { nullable: true, optional: true, defaultValue: null }],
        ["status", "string", { nullable: true, optional: true, defaultValue: null }],
        ["output_path", "string", { nullable: true, optional: true, defaultValue: null }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "transactions",
    mutation: "read"
  },
  {
    name: "file_access_status",
    definition: {
      parameters: [],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "maintenance",
    mutation: "read"
  },
  {
    name: "export_ledger",
    definition: {
      parameters: [
        ["output_path", "string", { nullable: true, optional: true, defaultValue: null }],
        ["entity_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["date_from", "string", { nullable: true, optional: true, defaultValue: null }],
        ["date_to", "string", { nullable: true, optional: true, defaultValue: null }],
        ["account_ids", "string[]", { nullable: true, optional: true, defaultValue: null }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "read",
    mutation: "read"
  },
  {
    name: "import_ledger",
    definition: {
      parameters: [
        ["file_path", "string", { nullable: true, optional: true, defaultValue: null }],
        ["data", "string", { nullable: true, optional: true, defaultValue: null }],
        ["preserve_ids", "boolean", { optional: true, defaultValue: true }],
        ["dry_run", "boolean", { optional: true, defaultValue: false }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "statements",
    mutation: "write"
  },
  {
    name: "operating_manual",
    definition: {
      parameters: [
        ["topic", "string", { optional: true, defaultValue: "all" }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "maintenance",
    mutation: "read"
  },
  {
    name: "create_branch",
    definition: {
      parameters: [
        ["name", "string"]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "setup",
    mutation: "write"
  },
  {
    name: "list_branches",
    definition: {
      parameters: [],
      returns: { type: "object[]" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "setup",
    mutation: "read"
  },
  {
    name: "merge_branch",
    definition: {
      parameters: [
        ["source", "string"]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "setup",
    mutation: "write"
  },
  {
    name: "discard_branch",
    definition: {
      parameters: [
        ["name", "string"]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "setup",
    mutation: "write"
  },
  {
    name: "compare_scenarios",
    definition: {
      parameters: [
        ["as_of_a", "string", { nullable: true, optional: true, defaultValue: null }],
        ["as_of_b", "string", { nullable: true, optional: true, defaultValue: null }],
        ["asset_id", "string"]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "reports",
    mutation: "read"
  },
  {
    name: "close_period",
    definition: {
      parameters: [
        ["name", "string"],
        ["as_of", "string"],
        ["description", "string", { nullable: true, optional: true, defaultValue: null }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "advanced",
    mutation: "write"
  },
  {
    name: "list_checkpoints",
    definition: {
      parameters: [],
      returns: { type: "object[]" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "advanced",
    mutation: "read"
  },
  {
    name: "reopen_period",
    definition: {
      parameters: [
        ["checkpoint_id", "string"]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "advanced",
    mutation: "write"
  },
  {
    name: "assert_balance",
    definition: {
      parameters: [
        ["account_id", "string"],
        ["expected", "number"],
        ["date", "string", { nullable: true, optional: true, defaultValue: null }],
        ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["status", "string", { nullable: true, optional: true, defaultValue: null }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "read",
    mutation: "read"
  },
  {
    name: "assert_balances",
    definition: {
      parameters: [
        ["assertions", "array"],
        ["status", "string", { nullable: true, optional: true, defaultValue: null }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "read",
    mutation: "read"
  },
  {
    name: "reconcile_to_balance",
    definition: {
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
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "read",
    mutation: "write"
  },
  {
    name: "reconcile_diff",
    definition: {
      parameters: [
        ["account_id", "string"],
        ["date_from", "string", { nullable: true, optional: true, defaultValue: null }],
        ["date_to", "string", { nullable: true, optional: true, defaultValue: null }],
        ["branch", "string", { nullable: true, optional: true, defaultValue: null }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "read",
    mutation: "read"
  },
  {
    name: "backup_now",
    definition: {
      parameters: [
        ["output_path", "string", { nullable: true, optional: true, defaultValue: null }],
        ["compact", "boolean", { optional: true, defaultValue: false }],
        ["dry_run", "boolean", { optional: true, defaultValue: false }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "maintenance",
    mutation: "filesystem"
  },
  {
    name: "backup_status",
    definition: {
      parameters: [],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "maintenance",
    mutation: "read"
  },
  {
    name: "list_backups",
    definition: {
      parameters: [],
      returns: { type: "object[]" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "maintenance",
    mutation: "read"
  },
  {
    name: "integrity_check",
    definition: {
      parameters: [],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "maintenance",
    mutation: "read"
  },
  {
    name: "repair_integrity",
    definition: {
      parameters: [
        ["dry_run", "boolean", { optional: true, defaultValue: true }],
        ["backup", "boolean", { optional: true, defaultValue: true }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: true },
    workflow: "maintenance",
    mutation: "dry-run"
  },
  {
    name: "list_tags",
    definition: {
      parameters: [
        ["entity_type", "string"],
        ["entity_id", "string"]
      ],
      returns: { type: "object[]" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "setup",
    mutation: "read"
  },
  {
    name: "delete_tag",
    definition: {
      parameters: [
        ["tag_id", "string"]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "setup",
    mutation: "write"
  },
  {
    name: "delete_tags",
    definition: {
      parameters: [
        ["entity_type", "string"],
        ["entity_id", "string"],
        ["key", "string", { nullable: true, optional: true, defaultValue: null }],
        ["val", "string", { nullable: true, optional: true, defaultValue: null }],
        ["dry_run", "boolean", { optional: true, defaultValue: true }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: true },
    workflow: "setup",
    mutation: "dry-run"
  },
  {
    name: "tool_registry",
    definition: {
      parameters: [
        ["names", "string[]", { nullable: true, optional: true, defaultValue: null }],
        ["summary", "boolean", { optional: true, defaultValue: false }],
        ["safety_filter", "string", { nullable: true, optional: true, defaultValue: null }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "maintenance",
    mutation: "read"
  },
  {
    name: "inspect_transaction",
    definition: {
      parameters: [
        ["tx_id", "string"]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "transactions",
    mutation: "read"
  }
] as const);
