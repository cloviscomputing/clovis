import { defineToolGroup } from "../../tool-spec.js";

export const reportTools = defineToolGroup([
  {
    name: "income_statement",
    definition: {
      parameters: [
        ["year", "integer"],
        ["month", "integer", { nullable: true, optional: true, defaultValue: null }],
        ["branch", "string", { nullable: true, optional: true, defaultValue: null }],
        ["compact", "boolean", { optional: true, defaultValue: false }],
        ["include_pending", "boolean", { optional: true, defaultValue: false }],
        ["account_ids", "string[]", { nullable: true, optional: true, defaultValue: null }],
        ["entity_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["quote_asset_id", "string"],
        ["status", "string", { nullable: true, optional: true, defaultValue: null }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "statements",
    mutation: "read"
  },
  {
    name: "balance_sheet",
    definition: {
      parameters: [
        ["date", "string", { nullable: true, optional: true, defaultValue: null }],
        ["branch", "string", { nullable: true, optional: true, defaultValue: null }],
        ["compact", "boolean", { optional: true, defaultValue: false }],
        ["include_pending", "boolean", { optional: true, defaultValue: true }],
        ["status", "string", { optional: true, defaultValue: "active" }],
        ["hide_zero", "boolean", { optional: true, defaultValue: false }],
        ["quote_asset_id", "string"],
        ["account_ids", "string[]", { nullable: true, optional: true, defaultValue: null }],
        ["entity_id", "string", { nullable: true, optional: true, defaultValue: null }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "reports",
    mutation: "read"
  },
  {
    name: "net_worth",
    definition: {
      parameters: [
        ["date", "string", { nullable: true, optional: true, defaultValue: null }],
        ["branch", "string", { nullable: true, optional: true, defaultValue: null }],
        ["include_pending", "boolean", { optional: true, defaultValue: true }],
        ["status", "string", { optional: true, defaultValue: "active" }],
        ["quote_asset_id", "string"],
        ["account_ids", "string[]", { nullable: true, optional: true, defaultValue: null }],
        ["entity_id", "string", { nullable: true, optional: true, defaultValue: null }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "reports",
    mutation: "read"
  },
  {
    name: "spending",
    definition: {
      parameters: [
        ["year", "integer"],
        ["month", "integer"],
        ["branch", "string", { nullable: true, optional: true, defaultValue: null }],
        ["include_pending", "boolean", { optional: true, defaultValue: false }],
        ["status", "string", { nullable: true, optional: true, defaultValue: null }],
        ["account_ids", "string[]", { nullable: true, optional: true, defaultValue: null }],
        ["entity_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["quote_asset_id", "string"]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "budgets",
    mutation: "read"
  },
  {
    name: "cash_flow",
    definition: {
      parameters: [
        ["year", "integer"],
        ["month", "integer"],
        ["branch", "string", { nullable: true, optional: true, defaultValue: null }],
        ["compact", "boolean", { optional: true, defaultValue: false }],
        ["include_pending", "boolean", { optional: true, defaultValue: false }],
        ["status", "string", { optional: true, defaultValue: "posted" }],
        ["quote_asset_id", "string"]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "reports",
    mutation: "read"
  },
  {
    name: "account_register",
    definition: {
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
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "setup",
    mutation: "read"
  },
  {
    name: "trial_balance",
    definition: {
      parameters: [
        ["branch", "string", { nullable: true, optional: true, defaultValue: null }],
        ["status", "string", { nullable: true, optional: true, defaultValue: null }],
        ["asset_id", "string"]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "reports",
    mutation: "read"
  },
  {
    name: "financial_overview",
    definition: {
      parameters: [
        ["year", "integer", { nullable: true, optional: true, defaultValue: null }],
        ["month", "integer", { nullable: true, optional: true, defaultValue: null }],
        ["status", "string", { optional: true, defaultValue: "active" }],
        ["quote_asset_id", "string"]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "reports",
    mutation: "read"
  },
  {
    name: "financial_picture",
    definition: {
      parameters: [
        ["year", "integer", { nullable: true, optional: true, defaultValue: null }],
        ["month", "integer", { nullable: true, optional: true, defaultValue: null }],
        ["quote_asset_id", "string"],
        ["status", "string", { optional: true, defaultValue: "active" }],
        ["include_pending", "boolean", { optional: true, defaultValue: true }],
        ["include_planned", "boolean", { optional: true, defaultValue: false }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "reports",
    mutation: "read"
  },
  {
    name: "cash_projection",
    definition: {
      parameters: [
        ["year", "integer", { nullable: true, optional: true, defaultValue: null }],
        ["month", "integer", { nullable: true, optional: true, defaultValue: null }],
        ["asset_account_ids", "string[]", { nullable: true, optional: true, defaultValue: null }],
        ["liability_account_ids", "string[]", { nullable: true, optional: true, defaultValue: null }],
        ["entity_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["earmarks", "object[]", { nullable: true, optional: true, defaultValue: null }],
        ["include_pending", "boolean", { optional: true, defaultValue: false }],
        ["include_planned", "boolean", { optional: true, defaultValue: false }],
        ["planned_match_tolerance_days", "integer", { optional: true, defaultValue: 3 }],
        ["quote_asset_id", "string"]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "reports",
    mutation: "read"
  },
  {
    name: "cash_runway",
    definition: {
      parameters: [
        ["year", "integer", { nullable: true, optional: true, defaultValue: null }],
        ["month", "integer", { nullable: true, optional: true, defaultValue: null }],
        ["as_of", "string", { nullable: true, optional: true, defaultValue: null }],
        ["asset_account_ids", "string[]", { nullable: true, optional: true, defaultValue: null }],
        ["liability_account_ids", "string[]", { nullable: true, optional: true, defaultValue: null }],
        ["earmarks", "object[]", { nullable: true, optional: true, defaultValue: null }],
        ["include_pending", "boolean", { optional: true, defaultValue: false }],
        ["include_planned", "boolean", { optional: true, defaultValue: false }],
        ["include_partial_month", "boolean", { optional: true, defaultValue: false }],
        ["reserve_remaining_budget", "boolean", { optional: true, defaultValue: true }],
        ["include_sources", "boolean", { optional: true, defaultValue: false }],
        ["summary", "boolean", { optional: true, defaultValue: false }],
        ["trailing_months_short", "integer", { optional: true, defaultValue: 3 }],
        ["trailing_months_long", "integer", { optional: true, defaultValue: 6 }],
        ["discretionary_multiplier", "number", { optional: true, defaultValue: 0.5 }],
        ["quote_asset_id", "string"]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "reports",
    mutation: "read"
  },
  {
    name: "forecast",
    definition: {
      parameters: [
        ["account_id", "string"],
        ["as_of", "string", { nullable: true, optional: true, defaultValue: null }],
        ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "reports",
    mutation: "read"
  },
  {
    name: "preview_commit",
    definition: {
      parameters: [
        ["as_of", "string", { nullable: true, optional: true, defaultValue: null }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "read",
    mutation: "read"
  },
  {
    name: "project_month_end",
    definition: {
      parameters: [
        ["year", "integer", { nullable: true, optional: true, defaultValue: null }],
        ["month", "integer", { nullable: true, optional: true, defaultValue: null }],
        ["expected_inflows", "object[]", { nullable: true, optional: true, defaultValue: null }],
        ["expected_outflows", "object[]", { nullable: true, optional: true, defaultValue: null }],
        ["expected_paychecks", "object[]", { nullable: true, optional: true, defaultValue: null }],
        ["include_pending", "boolean", { optional: true, defaultValue: true }],
        ["include_planned", "boolean", { optional: true, defaultValue: true }],
        ["account_ids", "string[]", { nullable: true, optional: true, defaultValue: null }],
        ["asset_account_ids", "string[]", { nullable: true, optional: true, defaultValue: null }],
        ["liability_account_ids", "string[]", { nullable: true, optional: true, defaultValue: null }],
        ["quote_asset_id", "string"]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "reports",
    mutation: "read"
  },
  {
    name: "project_balances",
    definition: {
      parameters: [
        ["through", "string"],
        ["account_ids", "string[]", { nullable: true, optional: true, defaultValue: null }],
        ["include_goals", "boolean", { optional: true, defaultValue: false }],
        ["branch", "string", { nullable: true, optional: true, defaultValue: null }],
        ["quote_asset_id", "string"]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "reports",
    mutation: "read"
  },
  {
    name: "list_uncategorized",
    definition: {
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
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "transactions",
    mutation: "read"
  },
  {
    name: "audit_categorization",
    definition: {
      parameters: [
        ["date_from", "string", { nullable: true, optional: true, defaultValue: null }],
        ["date_to", "string", { nullable: true, optional: true, defaultValue: null }],
        ["min_occurrences", "integer", { optional: true, defaultValue: 2 }],
        ["status", "string", { optional: true, defaultValue: "posted" }],
        ["mode", "string", { optional: true, defaultValue: "budget" }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "transactions",
    mutation: "read"
  },
  {
    name: "top_descriptions",
    definition: {
      parameters: [
        ["account_id", "string"],
        ["limit", "integer", { optional: true, defaultValue: 50 }],
        ["status", "string", { nullable: true, optional: true, defaultValue: null }]
      ],
      returns: { type: "object[]" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "transactions",
    mutation: "read"
  },
  {
    name: "count_transactions",
    definition: {
      parameters: [
        ["account_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["status", "string", { nullable: true, optional: true, defaultValue: null }],
        ["date_from", "string", { nullable: true, optional: true, defaultValue: null }],
        ["date_to", "string", { nullable: true, optional: true, defaultValue: null }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "transactions",
    mutation: "read"
  },
  {
    name: "age_of_money",
    definition: {
      parameters: [
        ["days", "integer", { optional: true, defaultValue: 30 }],
        ["quote_asset_id", "string"]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "reports",
    mutation: "read"
  },
  {
    name: "holdings",
    definition: {
      parameters: [
        ["account_id", "string", { nullable: true, optional: true, defaultValue: null }],
        ["asset_type", "string", { nullable: true, optional: true, defaultValue: null }]
      ],
      returns: { type: "object[]" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "transactions",
    mutation: "read"
  }
] as const);
