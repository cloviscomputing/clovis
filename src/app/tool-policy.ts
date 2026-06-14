import type { ToolMutation, ToolRuntimeSafety, ToolWorkflow } from "./tool-spec.js";

const FILESYSTEM_TOOLS = new Set<string>([
  "apply_reconciliation_plan", "backup_now", "export_transactions", "import_file",
  "preview_import", "process_statement", "refresh_statement"
]);

export function toolWorkflow(name: string): ToolWorkflow {
  if (name.includes("budget") || name.includes("goal") || ["spending", "spending_rate", "suggest_budgets", "unbudgeted_spending"].includes(name)) return "budgets";
  if (
    name.includes("statement") ||
    name.includes("import") ||
    name.includes("pending") ||
    name.includes("planned") ||
    ["commit_batch", "discard_batch", "invert_import", "preview_import", "record_pending_expenses", "refresh_statement"].includes(name)
  ) return "statements";
  if (
    name.includes("projection") ||
    name.includes("runway") ||
    name.includes("forecast") ||
    ["age_of_money", "balance_sheet", "cash_flow", "compare_scenarios", "financial_overview", "financial_picture", "income_statement", "net_worth", "project_balances", "project_month_end", "trial_balance"].includes(name)
  ) return "reports";
  if (
    name.includes("transaction") ||
    name.includes("transfer") ||
    name.includes("categor") ||
    name.includes("match") ||
    ["apply_pattern", "flip_entries", "holdings", "list_entries", "list_entries_by_asset", "post_journal_entry", "record_investment", "search_transactions", "top_descriptions"].includes(name)
  ) return "transactions";
  if (
    name.includes("account") ||
    name.includes("asset") ||
    name.includes("price") ||
    name.includes("tag") ||
    name.includes("rule") ||
    ["create_branch", "discard_branch", "list_branches", "merge_branch", "init_defaults"].includes(name)
  ) return "setup";
  if (
    name.includes("backup") ||
    name.includes("integrity") ||
    name.includes("ledger_operation") ||
    ["file_access_status", "operating_manual", "preview_mutation", "repair_integrity", "reverse_ledger_operation", "tool_registry"].includes(name)
  ) return "maintenance";
  if (name.includes("checkpoint") || name.includes("period") || name.includes("scenario")) return "advanced";
  return "read";
}

export function toolMutation(name: string, safety: ToolRuntimeSafety): ToolMutation {
  if (safety.readOnlyHint) return "read";
  if (FILESYSTEM_TOOLS.has(name)) return "filesystem";
  if (safety.defaultDryRun) return "dry-run";
  return "write";
}
