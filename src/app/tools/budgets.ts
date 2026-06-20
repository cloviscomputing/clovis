import type { Row, ToolHandlers, ToolRuntimeContext } from "../tool-runtime.js";
import { defineToolGroup } from "../tool-spec.js";

export const budgetTools = defineToolGroup([
  {
    name: "set_budget",
    definition: {
      parameters: [
        ["account", "string"],
        ["amount", "number"],
        ["period", "string", { optional: true, defaultValue: "monthly" }],
        ["year", "integer", { nullable: true, optional: true, defaultValue: null }],
        ["month", "integer", { nullable: true, optional: true, defaultValue: null }],
        ["rollover", "boolean", { optional: true, defaultValue: false }],
        ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "budgets",
    mutation: "write"
  },
  {
    name: "set_budgets",
    definition: {
      parameters: [
        ["budgets", "object[]"],
        ["year", "integer", { nullable: true, optional: true, defaultValue: null }],
        ["month", "integer", { nullable: true, optional: true, defaultValue: null }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "budgets",
    mutation: "write"
  },
  {
    name: "budget_status",
    definition: {
      parameters: [
        ["account", "string", { nullable: true, optional: true, defaultValue: null }],
        ["year", "integer", { nullable: true, optional: true, defaultValue: null }],
        ["month", "integer", { nullable: true, optional: true, defaultValue: null }],
        ["rollup", "boolean", { optional: true, defaultValue: false }],
        ["include_pending", "boolean", { optional: true, defaultValue: false }],
        ["status", "string", { optional: true, defaultValue: "posted" }],
        ["quote_asset_id", "string"]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "budgets",
    mutation: "read"
  },
  {
    name: "budget_summary",
    definition: {
      parameters: [
        ["year", "integer", { nullable: true, optional: true, defaultValue: null }],
        ["month", "integer", { nullable: true, optional: true, defaultValue: null }],
        ["include_pending", "boolean", { optional: true, defaultValue: false }],
        ["status", "string", { optional: true, defaultValue: "posted" }],
        ["quote_asset_id", "string"]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "budgets",
    mutation: "read"
  },
  {
    name: "delete_budget",
    definition: {
      parameters: [
        ["account", "string"],
        ["year", "integer", { nullable: true, optional: true, defaultValue: null }],
        ["month", "integer", { nullable: true, optional: true, defaultValue: null }],
        ["include_overrides", "boolean", { optional: true, defaultValue: false }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "budgets",
    mutation: "write"
  },
  {
    name: "delete_budgets",
    definition: {
      parameters: [
        ["accounts", "string[]", { nullable: true, optional: true, defaultValue: null }],
        ["year", "integer", { nullable: true, optional: true, defaultValue: null }],
        ["month", "integer", { nullable: true, optional: true, defaultValue: null }],
        ["include_overrides", "boolean", { optional: true, defaultValue: false }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "budgets",
    mutation: "write"
  },
  {
    name: "copy_budgets",
    definition: {
      parameters: [
        ["from_year", "integer"],
        ["from_month", "integer"],
        ["to_year", "integer"],
        ["to_month", "integer"]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "budgets",
    mutation: "write"
  },
  {
    name: "budget_rollover_preview",
    definition: {
      parameters: [
        ["year", "integer"],
        ["month", "integer"],
        ["include_pending", "boolean", { optional: true, defaultValue: false }],
        ["status", "string", { optional: true, defaultValue: "posted" }],
        ["quote_asset_id", "string"]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "budgets",
    mutation: "read"
  },
  {
    name: "apply_rollover",
    definition: {
      parameters: [
        ["year", "integer"],
        ["month", "integer"],
        ["quote_asset_id", "string"]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "read",
    mutation: "write"
  },
  {
    name: "unbudgeted_spending",
    definition: {
      parameters: [
        ["year", "integer", { nullable: true, optional: true, defaultValue: null }],
        ["month", "integer", { nullable: true, optional: true, defaultValue: null }],
        ["status", "string", { optional: true, defaultValue: "posted" }],
        ["quote_asset_id", "string"]
      ],
      returns: { type: "object[]" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "budgets",
    mutation: "read"
  },
  {
    name: "spending_rate",
    definition: {
      parameters: [
        ["account", "string", { nullable: true, optional: true, defaultValue: null }],
        ["year", "integer", { nullable: true, optional: true, defaultValue: null }],
        ["month", "integer", { nullable: true, optional: true, defaultValue: null }],
        ["status", "string", { optional: true, defaultValue: "posted" }],
        ["quote_asset_id", "string"]
      ],
      returns: { type: "object[]" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "budgets",
    mutation: "read"
  },
  {
    name: "forecast_month_end",
    definition: {
      parameters: [
        ["year", "integer", { nullable: true, optional: true, defaultValue: null }],
        ["month", "integer", { nullable: true, optional: true, defaultValue: null }],
        ["status", "string", { nullable: true, optional: true, defaultValue: null }],
        ["include_pending", "boolean", { optional: true, defaultValue: true }],
        ["include_planned", "boolean", { optional: true, defaultValue: true }],
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
    name: "suggest_budgets",
    definition: {
      parameters: [
        ["months", "integer", { optional: true, defaultValue: 3 }],
        ["year", "integer", { nullable: true, optional: true, defaultValue: null }],
        ["month", "integer", { nullable: true, optional: true, defaultValue: null }],
        ["skip_budgeted", "boolean", { optional: true, defaultValue: true }],
        ["quote_asset_id", "string"]
      ],
      returns: { type: "object[]" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "budgets",
    mutation: "read"
  },
  {
    name: "set_goal",
    definition: {
      parameters: [
        ["account", "string"],
        ["target", "number"],
        ["name", "string"],
        ["target_date", "string", { nullable: true, optional: true, defaultValue: null }],
        ["priority", "integer", { optional: true, defaultValue: 1 }],
        ["asset_id", "string", { nullable: true, optional: true, defaultValue: null }]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "budgets",
    mutation: "write"
  },
  {
    name: "list_goals",
    definition: {
      parameters: [],
      returns: { type: "array" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "budgets",
    mutation: "read"
  },
  {
    name: "goal_progress",
    definition: {
      parameters: [
        ["account", "string"]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, supportsDryRun: false, defaultDryRun: false },
    workflow: "budgets",
    mutation: "read"
  },
  {
    name: "delete_goal",
    definition: {
      parameters: [
        ["account", "string"]
      ],
      returns: { type: "object" }
    },
    safety: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false, supportsDryRun: true, defaultDryRun: false },
    workflow: "budgets",
    mutation: "write"
  }
] as const);

export function budgetHandlers(ctx: ToolRuntimeContext, handlers: ToolHandlers): Partial<ToolHandlers> {
  const {
    account,
    accountAsset,
    asset,
    budgetExposure,
    budgetRows,
    display,
    effectiveBudgetRows,
    explicitAsset,
    nonNegativeMoneyAmount,
    positiveMoneyAmount,
    reportAsset,
    reportStatus,
    spendingRows
  } = ctx;
  return {

    set_budget: (ledger, args) => {
      const acct = ledger.getAccount(account(ledger, args.account))!;
      if (acct.account_type !== "expense") throw new Error("Budgets can only be set on expense accounts");
      const assetId = args.asset_id ? explicitAsset(ledger, args.asset_id) : accountAsset(ledger, acct.id);
      const quantity = nonNegativeMoneyAmount(ledger, assetId, args.amount, "Budget amount");
      ledger.setBudget(acct.id, assetId, quantity, args.period ?? "monthly", args.year ?? null, args.month ?? null, Boolean(args.rollover));
      return { account_id: acct.id, asset_id: assetId, quantity, amount_cents: quantity, period: args.period ?? "monthly", year: args.year ?? null, month: args.month ?? null, rollover: Boolean(args.rollover) };
    },

    set_budgets: (ledger, args) => {
      const rows = (args.budgets ?? []).map((row: Row) => handlers.set_budget(ledger, { account: row.account ?? row.account_id, amount: row.amount, asset_id: row.asset_id, period: row.period ?? "monthly", year: row.year ?? args.year, month: row.month ?? args.month, rollover: row.rollover ?? false }));
      return { set: rows.length, budgets: rows };
    },

    budget_status: (ledger, args) => {
      const year = args.year ?? new Date().getUTCFullYear();
      const month = args.month ?? new Date().getUTCMonth() + 1;
      const acct = args.account ? account(ledger, args.account) : null;
      const quote = reportAsset(ledger, args.quote_asset_id);
      const spendingResult = spendingRows(ledger, year, month, reportStatus(args, "posted"), quote, true) as { rows: Row[]; missing: Row[] };
      const spending = new Map(spendingResult.rows.map((row) => [row.account_id, row]));
      const missing: Row[] = [...spendingResult.missing];
      const effective = effectiveBudgetRows(ledger, acct, year, month);
      const spendingAccountIdsForBudget = (accountId: string): string[] => {
        if (!args.rollup) return spending.has(accountId) ? [accountId] : [];
        const budgetAccount = ledger.getAccount(accountId);
        if (!budgetAccount) return [];
        return [...ledger.descendants(accountId)]
          .filter((id) => ledger.getAccount(id)?.account_type === budgetAccount.account_type && spending.has(id));
      };
      const spentForBudget = (accountId: string): bigint => {
        if (!args.rollup) return BigInt(spending.get(accountId)?.amount_cents ?? 0);
        return spendingAccountIdsForBudget(accountId)
          .reduce((sum, id) => sum + BigInt(spending.get(id)?.amount_cents ?? 0), 0n);
      };
      const rows = effective.rows.flatMap((budget) => {
        const [budgeted, error] = ledger.tryConvertQuantity(BigInt(budget.quantity), String(budget.asset_id), quote);
        if (budgeted == null) {
          missing.push({ account_id: budget.account_id, asset_id: budget.asset_id, quote_asset_id: quote, quantity: budget.quantity, error });
          return [];
        }
        const spent = spentForBudget(String(budget.account_id));
        return [{ account_id: budget.account_id, account_name: ledger.getAccount(String(budget.account_id))?.name ?? "", asset_id: quote, source_budget_id: budget.id, budgeted_cents: budgeted, spent_cents: spent, remaining_cents: budgeted - spent, percent_used: budgeted ? Number(spent) / Number(budgeted) * 100 : 0 }];
      });
      const coveredSpendingAccountIds = new Set(rows.flatMap((row) => spendingAccountIdsForBudget(String(row.account_id))));
      const totalBudgeted = rows.reduce((s, r) => s + r.budgeted_cents, 0n);
      const totalSpent = [...coveredSpendingAccountIds].reduce((sum, id) => sum + BigInt(spending.get(id)?.amount_cents ?? 0), 0n);
      return {
        year,
        month,
        budgets: rows,
        total_budgeted_cents: totalBudgeted,
        total_spent_cents: totalSpent,
        total_remaining_cents: totalBudgeted - totalSpent,
        shadowed_budget_count: effective.shadowed.length,
        shadowed_budgets: effective.shadowed.map((row) => ({ id: row.id, account_id: row.account_id, asset_id: row.asset_id, quantity: row.quantity, period: row.period, year: row.year, month: row.month })),
        valuation_complete: missing.length === 0,
        missing_conversions: missing
      };
    },

    budget_summary: (ledger, args) => {
      const status = handlers.budget_status(ledger, args) as Row;
      status.total_remaining_cents = BigInt(status.total_budgeted_cents) - BigInt(status.total_spent_cents);
      return status;
    },

    delete_budget: (ledger, args) => {
      const accountId = account(ledger, args.account);
      return { deleted: ledger.deleteBudget(accountId, args.year, args.month), account_id: accountId };
    },

    delete_budgets: (ledger, args) => args.accounts ? { deleted: (args.accounts as string[]).reduce((sum, acct) => sum + Number((handlers.delete_budget(ledger, { account: acct, year: args.year, month: args.month }) as Row).deleted), 0) } : { deleted: ledger.deleteAllBudgets() },

    copy_budgets: (ledger, args) => {
      let copied = 0;
      for (const row of budgetRows(ledger, null, args.from_year, args.from_month)) {
        handlers.set_budget(ledger, { account: row.account_id, amount: display(ledger, BigInt(row.quantity), row.asset_id), period: row.period, year: args.to_year, month: args.to_month, rollover: Boolean(row.rollover_rule) });
        copied += 1;
      }
      return { copied };
    },

    budget_rollover_preview: (ledger, args) => {
      const status = handlers.budget_status(ledger, args) as Row;
      if (status.valuation_complete === false) return { year: args.year, month: args.month, rollovers: [], total_rollover_cents: 0n, valuation_complete: false, missing_conversions: status.missing_conversions };
      const rollovers = (status.budgets as Row[]).filter((row) => BigInt(row.remaining_cents) > 0n).map((row) => ({ ...row, rollover_cents: row.remaining_cents }));
      return { year: args.year, month: args.month, rollovers, total_rollover_cents: rollovers.reduce((sum, row) => sum + BigInt(row.rollover_cents), 0n), valuation_complete: true, missing_conversions: [] };
    },

    apply_rollover: (ledger, args) => {
      const preview = handlers.budget_rollover_preview(ledger, args) as Row;
      const nextYear = args.month === 12 ? args.year + 1 : args.year;
      const nextMonth = args.month === 12 ? 1 : args.month + 1;
      for (const row of preview.rollovers as Row[]) handlers.set_budget(ledger, { account: row.account_id, amount: display(ledger, BigInt(row.rollover_cents), row.asset_id), asset_id: row.asset_id, year: nextYear, month: nextMonth });
      return { applied: (preview.rollovers as Row[]).length, to_year: nextYear, to_month: nextMonth };
    },

    unbudgeted_spending: (ledger, args) => {
      const budgeted = new Set(effectiveBudgetRows(ledger, null, args.year, args.month).rows.map((row) => row.account_id));
      return (spendingRows(ledger, args.year, args.month, reportStatus(args, "posted"), args.quote_asset_id) as Row[]).filter((row) => !budgeted.has(row.account_id));
    },

    spending_rate: (ledger, args) => {
      const report = handlers.budget_status(ledger, args) as Row;
      const nowDate = new Date();
      const daysTotal = new Date(Date.UTC(args.year ?? nowDate.getUTCFullYear(), args.month ?? nowDate.getUTCMonth() + 1, 0)).getUTCDate();
      const daysElapsed = (args.year ?? nowDate.getUTCFullYear()) === nowDate.getUTCFullYear() && (args.month ?? nowDate.getUTCMonth() + 1) === nowDate.getUTCMonth() + 1 ? nowDate.getUTCDate() : daysTotal;
      return (report.budgets as Row[]).map((row) => ({ ...row, pace_cents: BigInt(row.budgeted_cents) * BigInt(daysElapsed) / BigInt(daysTotal), pace: BigInt(row.spent_cents) > BigInt(row.budgeted_cents) * BigInt(daysElapsed) / BigInt(daysTotal) ? "over" : "on_track" }));
    },

    forecast_month_end: (ledger, args) => {
      const explicitStatus = args.status !== undefined && args.status !== "";
      const includePendingFromArgs = args.include_pending !== false;
      const includePlannedFromArgs = args.include_planned !== false;
      const fallbackStatus = includePendingFromArgs && includePlannedFromArgs ? "combined" : includePendingFromArgs ? "active" : includePlannedFromArgs ? "planned" : "posted";
      const status = explicitStatus ? reportStatus({ status: args.status }, fallbackStatus) : fallbackStatus;
      const includePending = explicitStatus ? status == null || status === "active" || status === "combined" || status === "pending" : includePendingFromArgs;
      const includePlanned = explicitStatus ? status == null || status === "combined" || status === "planned" : includePlannedFromArgs;
      const report = budgetExposure(ledger, { ...args, include_pending: includePending, include_planned: includePlanned }) as Row;
      const warnings = [...(report.warnings as string[] ?? [])];
      if (explicitStatus) {
        if (args.include_pending !== undefined && Boolean(args.include_pending) !== includePending) warnings.push(`Explicit status '${String(args.status)}' overrides include_pending:${Boolean(args.include_pending)}; resolved include_pending:${includePending}.`);
        if (args.include_planned !== undefined && Boolean(args.include_planned) !== includePlanned) warnings.push(`Explicit status '${String(args.status)}' overrides include_planned:${Boolean(args.include_planned)}; resolved include_planned:${includePlanned}.`);
      }
      return { ...report, report_status: status, warnings };
    },

    suggest_budgets: (ledger, args) => {
      const totals = new Map<string, bigint[]>();
      const nowDate = new Date();
      let year = args.year ?? nowDate.getUTCFullYear();
      let month = args.month ?? nowDate.getUTCMonth() + 1;
      for (let i = 0; i < (args.months ?? 3); i += 1) {
        for (const row of spendingRows(ledger, year, month, "posted", args.quote_asset_id) as Row[]) totals.set(row.account_id, [...(totals.get(row.account_id) ?? []), BigInt(row.amount_cents)]);
        month -= 1; if (month === 0) { month = 12; year -= 1; }
      }
      const budgeted = new Set(budgetRows(ledger).map((row) => row.account_id));
      const accounts = new Map(ledger.listAccounts().map((row) => [row.id, row]));
      const skipBudgeted = args.skip_budgeted !== false;
      return [...totals.entries()].filter(([accountId]) => !skipBudgeted || !budgeted.has(accountId)).map(([accountId, values]) => ({ account_id: accountId, account_name: accounts.get(accountId)?.name ?? "", suggested_cents: values.reduce((s, v) => s + v, 0n) / BigInt(values.length) }));
    },

    set_goal: (ledger, args) => {
      const acct = ledger.getAccount(account(ledger, args.account))!;
      if (acct.account_type !== "asset") throw new Error("Goals can only be set on asset accounts");
      const assetId = args.asset_id ? explicitAsset(ledger, args.asset_id) : accountAsset(ledger, acct.id);
      const quantity = positiveMoneyAmount(ledger, assetId, args.target, "Goal target");
      ledger.setGoal(acct.id, assetId, quantity, args.name, args.target_date ?? null, args.priority ?? 1);
      return { account_id: acct.id, asset_id: assetId, name: args.name, target_quantity: quantity, target_cents: quantity, target_date: args.target_date ?? null, priority: args.priority ?? 1 };
    },

    list_goals: (ledger) => ledger.listGoalTargets().map((row) => ({ ...row, target_quantity: row.quantity, target_cents: row.quantity, ...handlers.goal_progress(ledger, { account: row.account_id }) as Row })),

    goal_progress: (ledger, args) => {
      const acct = account(ledger, args.account);
      const accountRow = ledger.getAccount(acct)!;
      const row = ledger.getGoalTarget(acct);
      if (!row) {
        return {
          found: false,
          account_id: acct,
          account_name: accountRow.name,
          goal: null,
          asset_id: null,
          name: null,
          target_quantity: null,
          target_cents: null,
          current_cents: null,
          remaining_cents: null,
          progress_pct: null
        };
      }
      const balance = ledger.balanceTree(acct, String(row.asset_id), null, null);
      const target = BigInt(row.quantity as string | number | bigint | boolean);
      return {
        found: true,
        account_id: acct,
        account_name: accountRow.name,
        goal: row,
        asset_id: row.asset_id,
        name: row.name,
        target_quantity: target,
        target_cents: target,
        current_cents: balance,
        remaining_cents: target > balance ? target - balance : 0n,
        progress_pct: target ? Number(balance) / Number(target) * 100 : 0
      };
    },

    delete_goal: (ledger, args) => ({ deleted: ledger.deleteGoal(account(ledger, args.account)), account_id: account(ledger, args.account) }),
  };
}
