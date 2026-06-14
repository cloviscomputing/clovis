// Signature helpers derive aliases, safety annotations, text signatures, and
// runtime schema hints from the public tool definitions.
import type {
  ToolDefinition,
  ToolParameterDefinition,
  ToolRuntimeSafety,
  ToolSafetyAnnotations,
  ToolTypeDefinition
} from "./tool-spec.js";
import { TOOL_DEFINITIONS, type ToolSignatureName } from "./tools/definitions.js";

export { TOOL_DEFINITIONS };
export type { ToolSignatureName };

export type {
  ToolDefinition,
  ToolParameterDefinition,
  ToolParameterOptions,
  ToolRuntimeSafety,
  ToolSafetyAnnotations,
  ToolTypeDefinition,
  ToolValueType
} from "./tool-spec.js";


export const STATUS_FILTER_VALUES = ["posted", "pending", "planned", "void", "active", "combined", "all"] as const;

const READ_ONLY_TOOLS = new Set<string>([
  "account_balances", "account_register", "age_of_money", "assert_balance", "assert_balances", "audit_categorization",
  "backup_status", "balance_sheet", "budget_rollover_preview", "budget_status", "budget_summary", "cash_flow",
  "cash_projection", "cash_runway", "compare_scenarios", "count_transactions", "detect_recurring", "export_ledger",
  "export_transactions", "file_access_status", "financial_overview", "financial_picture", "find_pending_duplicates", "find_realized_planned", "forecast",
  "forecast_month_end", "get_account", "get_account_by_name", "get_asset_by_symbol", "get_balance", "get_ledger_operation", "get_price",
  "get_transaction", "goal_progress", "holdings", "income_statement", "inspect_transaction", "integrity_check",
  "list_accounts", "list_assets", "list_backups", "list_branches", "list_checkpoints", "list_entries",
  "list_entries_by_asset", "list_goals", "list_import_batches", "list_ledger_operations", "list_match_rules", "list_prices", "list_scheduled",
  "list_tags", "list_transactions", "list_uncategorized", "list_unmatched_transfers", "net_worth", "operating_manual", "pending_summary",
  "preview_commit", "preview_import", "preview_mutation", "project_balances", "project_month_end", "reconcile_diff", "reconcile_statement",
  "reconcile_statement_plan", "search_transactions", "spending", "spending_rate", "suggest_budgets",
  "top_descriptions", "tool_registry", "trial_balance", "unbudgeted_spending"
]);

const DESTRUCTIVE_TOOLS = new Set<string>([
  "delete_account", "delete_asset", "delete_budget", "delete_budgets", "delete_goal", "delete_match_rule",
  "delete_match_rules", "delete_tag", "delete_tags", "delete_transaction", "discard_batch", "discard_branch",
  "merge_accounts", "migrate_asset_entries", "move_transactions", "reconcile_planned", "repair_integrity", "reverse_ledger_operation", "rollback_import",
  "rollback_recategorize", "void_by_filter"
]);

function parameterNames(definition: ToolDefinition): Set<string> {
  return new Set(definition.parameters.map((parameter) => parameter[0]));
}

export function toolAnnotations(name: string): ToolSafetyAnnotations {
  const readOnly = READ_ONLY_TOOLS.has(name);
  return {
    readOnlyHint: readOnly,
    destructiveHint: DESTRUCTIVE_TOOLS.has(name),
    idempotentHint: readOnly,
    openWorldHint: false
  };
}

export function toolSafety(name: string): ToolRuntimeSafety {
  const definition = TOOL_DEFINITIONS[name as ToolSignatureName];
  const dryRun = definition?.parameters.find((parameter) => parameter[0] === "dry_run");
  const annotations = toolAnnotations(name);
  return {
    ...annotations,
    supportsDryRun: !annotations.readOnlyHint || Boolean(dryRun),
    defaultDryRun: dryRun?.[2]?.defaultValue === true
  };
}

const SYNTHETIC_DRY_RUN_PARAMETER = ["dry_run", "boolean", { optional: true, defaultValue: false }] as const satisfies ToolParameterDefinition;

export function effectiveToolDefinition(name: string): ToolDefinition {
  const definition = TOOL_DEFINITIONS[name as ToolSignatureName];
  if (!definition) throw new Error(`Unknown tool: ${name}`);
  if (toolAnnotations(name).readOnlyHint || definition.parameters.some((parameter) => parameter[0] === "dry_run")) return definition;
  return { ...definition, parameters: [...definition.parameters, SYNTHETIC_DRY_RUN_PARAMETER] };
}

export function parameterAliasesForTool(name: string): Record<string, string> {
  const definition = TOOL_DEFINITIONS[name as ToolSignatureName];
  if (!definition) return {};
  const names = parameterNames(definition);
  const aliases: Record<string, string> = {};
  if (names.has("quote_asset_id")) {
    if (!names.has("currency")) aliases.currency = "quote_asset_id";
    if (!names.has("quote")) aliases.quote = "quote_asset_id";
    if (!names.has("quote_id")) aliases.quote_id = "quote_asset_id";
  }
  if (names.has("quote_id")) {
    if (!names.has("quote_asset_id")) aliases.quote_asset_id = "quote_id";
    if (!names.has("quote")) aliases.quote = "quote_id";
  }
  if (names.has("asset_id") && !names.has("asset")) aliases.asset = "asset_id";
  return aliases;
}

export function normalizeToolInput(name: string, input: Record<string, unknown> = {}): Record<string, unknown> {
  const aliases = parameterAliasesForTool(name);
  const normalized = { ...input };
  for (const [alias, target] of Object.entries(aliases)) {
    if (!(alias in normalized)) continue;
    if (target in normalized && normalized[target] !== normalized[alias]) {
      throw new Error(`Use either ${target} or ${alias}, not both`);
    }
    normalized[target] = normalized[alias];
    delete normalized[alias];
  }
  return normalized;
}

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

export function renderSignature(definition: ToolDefinition): string {
  const params = definition.parameters
    .map((parameter) => `${parameter[0]}${parameter[2]?.optional ? "?" : ""}: ${typeDisplay(parameterType(parameter))}`)
    .join(", ");
  return `(${params}) => ${typeDisplay(definition.returns)}`;
}

export const TOOL_SIGNATURES = Object.fromEntries(
  Object.keys(TOOL_DEFINITIONS).map((name) => [name, renderSignature(effectiveToolDefinition(name))])
) as { [Name in ToolSignatureName]: string };
