import type { Ledger } from "../../core/ledger.js";
import type { TxStatus } from "../../core/types.js";
import type { Row, ToolHandlers, ToolRuntimeContext } from "../tool-runtime.js";
import { defineToolGroup } from "../tool-spec.js";

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

export function reportHandlers(ctx: ToolRuntimeContext, handlers: ToolHandlers): Partial<ToolHandlers> {
  const {
    account,
    accountAsset,
    ageOfMoney,
    amountForAccount,
    asset,
    budgetBurn,
    budgetSummary,
    cashProjectionSummary,
    conversionSeverity,
    display,
    explicitAsset,
    incomeStatementRows,
    iterTransactions,
    monthBounds,
    nonNegativeMoneyAmount,
    nonOverlappingAccounts,
    optionalDate,
    parseTxStatusFilter,
    positive,
    presentAccountBalance,
    previousDate,
    quotedPlannedUnrealized,
    realizedPlannedRows,
    reportAsset,
    reportStatus,
    resolveScopedAccounts,
    rootAccountIds,
    runwayMonths,
    scaleBigint,
    scopedMissingConversions,
    spendableAssetAccountDefaults,
    spendingRows,
    splitProjectionAccounts,
    today,
    trailingSpend,
    trailingSummary,
    trailingWindowEnd,
    txPublic,
    unsupportedArguments,
    validateDate
  } = ctx;
  const balanceSheetReport = (ledger: Ledger, args: Row): Row => {
    const quote = reportAsset(ledger, args.quote_asset_id);
    const status = reportStatus(args, "active");
    const includesPending = status == null || status === "active" || status === "combined" || status === "pending";
    const scope = resolveScopedAccounts(ledger, args, ["asset", "liability", "equity"]);
    if (!scope.scoped) {
      const report = ledger.balanceSheet(optionalDate(args.date), quote, status);
      if (args.hide_zero) {
        report.assets = (report.assets as Row[]).filter((row) => row.balance !== 0n);
        report.liabilities = (report.liabilities as Row[]).filter((row) => row.balance !== 0n);
        report.equity = (report.equity as Row[]).filter((row) => row.balance !== 0n);
      }
      return { ...report, report_status: status, include_pending: includesPending };
    }

    const date = optionalDate(args.date);
    const asOf = date ?? "9999-12-31";
    const assetRow = ledger.getAsset(quote);
    const scale = assetRow?.scale ?? 2;
    const missing: Row[] = [];
    const sections: Record<"asset" | "liability" | "equity", Row[]> = { asset: [], liability: [], equity: [] };
    for (const accountId of scope.root_account_ids) {
      const account = ledger.getAccount(accountId);
      if (!account || !["asset", "liability", "equity"].includes(account.account_type)) continue;
      const section = account.account_type as "asset" | "liability" | "equity";
      const balance = ledger.quotedBalanceTree(accountId, quote, asOf, status);
      missing.push(...balance.missing);
      if (args.hide_zero && balance.total === 0n) continue;
      const presented = presentAccountBalance(ledger, accountId, quote, balance.total, "ledger");
      sections[section].push({
        id: account.id,
        name: account.name,
        account_type: account.account_type,
        type: account.account_type,
        statement: account.statement,
        quantity: balance.total,
        scale,
        asset_id: quote,
        balance: balance.total,
        balance_cents: balance.total,
        balance_display: display(ledger, balance.total, quote),
        ...presented,
        children: []
      });
    }
    const total = (rows: Row[]) => rows.reduce((sum, row) => sum + BigInt(row.balance), 0n);
    const normalTotal = (rows: Row[]) => rows.reduce((sum, row) => sum + BigInt(row.normal_balance_cents), 0n);
    const totals = { asset: total(sections.asset), liability: total(sections.liability), equity: total(sections.equity) };
    const normalTotals = { asset: normalTotal(sections.asset), liability: normalTotal(sections.liability), equity: normalTotal(sections.equity) };
    return {
      as_of: asOf,
      scope: { account_ids: [...scope.account_ids!], root_account_ids: scope.root_account_ids },
      assets: sections.asset,
      liabilities: sections.liability,
      equity: sections.equity,
      total_assets: totals.asset,
      total_liabilities: totals.liability,
      total_equity: totals.equity,
      total_assets_cents: totals.asset,
      total_liabilities_cents: totals.liability,
      total_equity_cents: totals.equity,
      accounting_total_assets: normalTotals.asset,
      accounting_total_liabilities: normalTotals.liability,
      accounting_total_equity: normalTotals.equity,
      accounting_current_income: 0n,
      accounting_current_expense: 0n,
      accounting_current_earnings: 0n,
      accounting_equation_balanced: null,
      quote_asset_id: quote,
      scale,
      report_status: status,
      include_pending: includesPending,
      valuation_complete: missing.length === 0,
      missing_conversions: missing
    };
  };
  const publicCurrentAsOf = (report: Row, args: Row): Row => {
    if (args.date || report.as_of !== "9999-12-31") return report;
    return {
      ...report,
      as_of: null,
      as_of_basis: "current_open_ended",
      as_of_description: "Open-ended current snapshot; no calendar cutoff was applied."
    };
  };
  return {

    income_statement: (ledger, args) => {
      unsupportedArguments({ branch: args.branch, account_ids: args.account_ids, entity_id: args.entity_id });
      const month = args.month == null ? null : Number(args.month);
      const status = reportStatus(args, args.include_pending ? "active" : "posted");
      const report = incomeStatementRows(ledger, Number(args.year), month, status, args.quote_asset_id);
      if (month == null) report.months = Array.from({ length: 12 }, (_, index) => incomeStatementRows(ledger, Number(args.year), index + 1, status, args.quote_asset_id));
      return args.compact ? { year: Number(args.year), month, income: report.income, expense: report.expense, net: report.net } : report;
    },

    balance_sheet: (ledger, args) => {
      unsupportedArguments({ branch: args.branch });
      const report = publicCurrentAsOf(balanceSheetReport(ledger, args), args);
      return args.compact ? { total_assets: report.total_assets, total_liabilities: report.total_liabilities, total_equity: report.total_equity, total_assets_cents: report.total_assets, total_liabilities_cents: report.total_liabilities, total_equity_cents: report.total_equity } : report;
    },

    net_worth: (ledger, args) => {
      unsupportedArguments({ branch: args.branch });
      const sheet = publicCurrentAsOf(balanceSheetReport(ledger, { ...args, hide_zero: false }), args);
      const net = BigInt(sheet.total_assets) + BigInt(sheet.total_liabilities);
      return {
        as_of: sheet.as_of,
        total_assets: sheet.total_assets,
        total_liabilities: sheet.total_liabilities,
        net_worth: net,
        ...(sheet.as_of_basis ? { as_of_basis: sheet.as_of_basis, as_of_description: sheet.as_of_description } : {}),
        total_assets_cents: sheet.total_assets,
        total_liabilities_cents: sheet.total_liabilities,
        net_worth_cents: net,
        quote_asset_id: sheet.quote_asset_id,
        scale: sheet.scale,
        report_status: sheet.report_status,
        include_pending: sheet.include_pending,
        valuation_complete: sheet.valuation_complete,
        missing_conversions: sheet.missing_conversions,
        scope: sheet.scope
      };
    },

    spending: (ledger, args) => {
      unsupportedArguments({ branch: args.branch, account_ids: args.account_ids, entity_id: args.entity_id });
      const result = spendingRows(ledger, Number(args.year), Number(args.month), reportStatus(args, args.include_pending ? "active" : "posted"), args.quote_asset_id, true) as { rows: Row[]; missing: Row[] };
      return { year: args.year, month: args.month, categories: result.rows, spending: result.rows, total: result.rows.reduce((sum, row) => sum + BigInt(row.amount_cents), 0n), warnings: result.missing, valuation_complete: result.missing.length === 0, missing_conversions: result.missing };
    },

    cash_flow: (ledger, args) => {
      unsupportedArguments({ branch: args.branch });
      const status = reportStatus(args, "posted");
      const report = ledger.cashFlow(Number(args.year), Number(args.month), reportAsset(ledger, args.quote_asset_id), status);
      return args.compact ? { year: report.year, month: report.month, operating_total: report.operating_total, investing_total: report.investing_total, financing_total: report.financing_total, net_change: report.net_change } : report;
    },

    account_register: (ledger, args) => {
      unsupportedArguments({ branch: args.branch });
      const accountId = account(ledger, args.account_id);
      const assetId = args.asset_id ? explicitAsset(ledger, args.asset_id) : accountAsset(ledger, accountId);
      const rows = ledger.accountRegister(accountId, assetId, optionalDate(args.date_from ?? args.time_from), optionalDate(args.date_to ?? args.time_to), parseTxStatusFilter(args.status));
      const page = rows.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 100));
      if (args.summary) return { account_id: accountId, transaction_count: rows.length, total_debits: page.reduce((sum, row) => sum + BigInt(row.debit as string | number | bigint | boolean), 0n), total_credits: page.reduce((sum, row) => sum + BigInt(row.credit as string | number | bigint | boolean), 0n), rows: page };
      return { account_id: accountId, entries: page, rows, total: rows.length, limit: args.limit ?? 100, offset: args.offset ?? 0 };
    },

    trial_balance: (ledger, args) => {
      unsupportedArguments({ branch: args.branch });
      return ledger.trialBalance(explicitAsset(ledger, args.asset_id, "asset_id"), parseTxStatusFilter(args.status, "posted"));
    },

    financial_overview: (ledger, args) => {
      const status = reportStatus(args, "active");
      return {
        current_snapshot: handlers.balance_sheet(ledger, { quote_asset_id: args.quote_asset_id, status }),
        monthly_activity: handlers.income_statement(ledger, { year: args.year ?? new Date().getUTCFullYear(), month: args.month ?? new Date().getUTCMonth() + 1, quote_asset_id: args.quote_asset_id, status }),
        budget_position: handlers.budget_summary(ledger, { ...args, status })
      };
    },

    financial_picture: (ledger, args) => {
      const fallbackIncludesPending = args.include_pending !== false;
      const fallbackIncludesPlanned = args.include_planned === true;
      const status = reportStatus(args, fallbackIncludesPlanned ? "combined" : fallbackIncludesPending ? "active" : "posted");
      const includePending = status == null || status === "active" || status === "combined" || status === "pending";
      const includePlanned = status == null || status === "combined" || status === "planned";
      const warnings: Row[] = [];
      if (args.status !== undefined && args.status !== "") {
        if (args.include_pending !== undefined && Boolean(args.include_pending) !== includePending) {
          warnings.push({
            code: "status_overrides_include_pending",
            message: `Explicit status '${String(args.status)}' overrides include_pending:${Boolean(args.include_pending)}; resolved include_pending:${includePending}.`
          });
        }
        if (args.include_planned !== undefined && Boolean(args.include_planned) !== includePlanned) {
          warnings.push({
            code: "status_overrides_include_planned",
            message: `Explicit status '${String(args.status)}' overrides include_planned:${Boolean(args.include_planned)}; resolved include_planned:${includePlanned}.`
          });
        }
      }
      const overview = handlers.financial_overview(ledger, { ...args, status }) as Row;
      const year = args.year ?? new Date().getUTCFullYear();
      const month = args.month ?? new Date().getUTCMonth() + 1;
      const actualCash = handlers.cash_projection(ledger, { year, month, quote_asset_id: args.quote_asset_id, include_pending: false, include_planned: false }) as Row;
      const projectedCash = handlers.cash_projection(ledger, { year, month, quote_asset_id: args.quote_asset_id, include_pending: includePending, include_planned: includePlanned }) as Row;
      const currentSnapshot = overview.current_snapshot as Row;
      if (currentSnapshot.as_of === "9999-12-31") {
        delete currentSnapshot.as_of;
        currentSnapshot.as_of_basis = "current_open_ended";
        currentSnapshot.as_of_description = "Open-ended current snapshot; no calendar cutoff was applied.";
      }
      return {
        ...overview,
        current_snapshot: currentSnapshot,
        basis: includePlanned ? "planned_projection" : includePending ? "current_active" : "current_actual",
        report_status: status,
        include_pending: includePending,
        include_planned: includePlanned,
        actual_cash_cents: actualCash.available_cash_cents,
        planned_cash_cents: projectedCash.planned_cash_cents,
        projected_cash_cents: projectedCash.available_cash_cents,
        cash_position: {
          actual: actualCash,
          selected: projectedCash
        },
        warnings,
        conversion_warning: projectedCash.conversion_warning
      };
    },

    cash_projection: (ledger, args) => {
      const quote = reportAsset(ledger, args.quote_asset_id);
      const [periodStart, asOf] = monthBounds(args.year, args.month);
      const plannedAfter = previousDate(periodStart);
      const assetAccounts = nonOverlappingAccounts(ledger, args.asset_account_ids ?? rootAccountIds(ledger, ["asset"]), ["asset"]);
      const liabilityAccounts = nonOverlappingAccounts(ledger, args.liability_account_ids ?? [], ["liability"]);
      const missing: Row[] = [];
      const projectionAccountIds = [...assetAccounts, ...liabilityAccounts];
      const realizedPlanned = args.include_planned === true ? realizedPlannedRows(ledger, {
        year: args.year,
        month: args.month,
        date_from: periodStart,
        date_to: asOf,
        account_ids: projectionAccountIds,
        date_tolerance_days: args.planned_match_tolerance_days ?? args.date_tolerance_days ?? 3
      }) : [];
      const realizedPlannedIds = new Set(realizedPlanned.map((row) => String(row.planned_tx_id)));

      const quoted = (accountId: string, status: TxStatus | string, dateFrom?: string | null): bigint => {
        const result = ledger.quotedBalanceTree(accountId, quote, asOf, status, dateFrom);
        missing.push(...result.missing);
        return result.total;
      };

      const accountBreakdown = assetAccounts.map((ref: string) => {
        const accountId = account(ledger, ref);
        const accountRow = ledger.getAccount(accountId);
        const posted = quoted(accountId, "posted");
        const pending = args.include_pending === true ? quoted(accountId, "pending") : 0n;
        const planned = args.include_planned === true ? quotedPlannedUnrealized(ledger, accountId, quote, asOf, plannedAfter, realizedPlannedIds, missing) : 0n;
        return { account_id: accountId, account_name: accountRow?.name ?? "", posted_cash_cents: posted, pending_cash_cents: pending, planned_cash_cents: planned, included_cash_cents: posted + pending + planned };
      });
      const liabilityBreakdown = liabilityAccounts.map((ref: string) => {
        const accountId = account(ledger, ref);
        const accountRow = ledger.getAccount(accountId);
        const posted = quoted(accountId, "posted");
        const pending = args.include_pending === true ? quoted(accountId, "pending") : 0n;
        const planned = args.include_planned === true ? quotedPlannedUnrealized(ledger, accountId, quote, asOf, plannedAfter, realizedPlannedIds, missing) : 0n;
        const effect = posted + pending + planned;
        return { account_id: accountId, account_name: accountRow?.name ?? "", posted_liability_effect_cents: posted, pending_liability_effect_cents: pending, planned_liability_effect_cents: planned, included_liability_effect_cents: effect, included_liability_balance_cents: -effect };
      });

      const postedCash = accountBreakdown.reduce((sum: bigint, row: Row) => sum + BigInt(row.posted_cash_cents), 0n);
      const pendingCash = accountBreakdown.reduce((sum: bigint, row: Row) => sum + BigInt(row.pending_cash_cents), 0n);
      const plannedCash = accountBreakdown.reduce((sum: bigint, row: Row) => sum + BigInt(row.planned_cash_cents), 0n);
      const gross = postedCash + pendingCash + plannedCash;
      const postedLiabilities = liabilityBreakdown.reduce((sum: bigint, row: Row) => sum + BigInt(row.posted_liability_effect_cents), 0n);
      const pendingLiabilities = liabilityBreakdown.reduce((sum: bigint, row: Row) => sum + BigInt(row.pending_liability_effect_cents), 0n);
      const plannedLiabilities = liabilityBreakdown.reduce((sum: bigint, row: Row) => sum + BigInt(row.planned_liability_effect_cents), 0n);
      const liabilityEffect = postedLiabilities + pendingLiabilities + plannedLiabilities;
      const earmarkItems = (args.earmarks ?? []).map((row: Row, index: number) => ({ name: row.name ?? row.label ?? `Earmark ${index + 1}`, amount_cents: nonNegativeMoneyAmount(ledger, quote, row.amount ?? 0, "Earmark amount") }));
      const earmarks = earmarkItems.reduce((sum: bigint, row: Row) => sum + BigInt(row.amount_cents), 0n);
      const budget = args.year == null || args.month == null ? null : handlers.budget_summary(ledger, { year: args.year, month: args.month, quote_asset_id: quote, include_pending: args.include_pending === true }) as Row;
      const plannedIncome = args.include_planned === true ? positive(plannedCash) : 0n;
      const available = gross + liabilityEffect - earmarks;
      const auditLineItems = [
        { type: "starting_cash", label: "Posted cash", amount_cents: postedCash },
        { type: "pending_cash", label: "Pending asset-account cash", amount_cents: pendingCash, included: args.include_pending === true },
        { type: "planned_cash", label: "Planned asset-account cash", amount_cents: plannedCash, included: args.include_planned === true },
        { type: "posted_liabilities", label: "Posted liability effect", amount_cents: postedLiabilities },
        { type: "pending_liabilities", label: "Pending liability effect", amount_cents: pendingLiabilities, included: args.include_pending === true },
        { type: "planned_liabilities", label: "Planned liability effect", amount_cents: plannedLiabilities, included: args.include_planned === true },
        ...earmarkItems.map((row: Row) => ({ type: "earmark", label: row.name, amount_cents: -BigInt(row.amount_cents) })),
        { type: "remaining_budget", label: "Remaining budget", amount_cents: budget?.total_remaining_cents ?? null, included: false },
        { type: "planned_income", label: "Planned income", amount_cents: plannedIncome, included: args.include_planned === true }
      ];
      return {
        year: args.year,
        month: args.month,
        as_of: asOf,
        planned_date_from: periodStart,
        basis: args.include_planned === true ? "projection" : args.include_pending === true ? "actual_plus_pending" : "actual",
        gross_cash_cents: gross,
        actual_cash_cents: postedCash,
        posted_cash_cents: postedCash,
        pending_cash_cents: pendingCash,
        planned_cash_cents: plannedCash,
        liability_effect_cents: liabilityEffect,
        liability_balance_cents: -liabilityEffect,
        posted_liability_effect_cents: postedLiabilities,
        pending_liability_effect_cents: pendingLiabilities,
        planned_liability_effect_cents: plannedLiabilities,
        earmarks_cents: earmarks,
        available_cash_cents: available,
        actual_available_cash_cents: postedCash + postedLiabilities - earmarks,
        pending_available_delta_cents: pendingCash + pendingLiabilities,
        planned_available_delta_cents: plannedCash + plannedLiabilities,
        remaining_budget_cents: budget?.total_remaining_cents ?? null,
        planned_income_cents: plannedIncome,
        accounts: assetAccounts,
        asset_account_ids: assetAccounts,
        liability_account_ids: liabilityAccounts,
        account_breakdown: accountBreakdown,
        liability_breakdown: liabilityBreakdown,
        earmarks: earmarkItems,
        audit_trail: {
          line_items: auditLineItems,
          asset_accounts: accountBreakdown,
          liabilities: liabilityBreakdown,
          earmarks: earmarkItems,
          remaining_budget: budget,
          planned_income_cents: plannedIncome,
          realized_planned_rows: realizedPlanned
        },
        realized_planned_rows: realizedPlanned,
        realized_planned_count: realizedPlanned.length,
        warnings: realizedPlanned.length > 0 ? ["excluded realized planned rows from planned projection; run reconcile_planned to void or review them"] : [],
        quote_asset_id: quote,
        include_pending: args.include_pending === true,
        include_planned: args.include_planned === true,
        valuation_complete: missing.length === 0,
        missing_conversions: missing,
        conversion_warning: conversionSeverity(missing)
      };
    },

    cash_runway: (ledger, args) => {
      const quote = reportAsset(ledger, args.quote_asset_id);
      const nowDate = new Date();
      const year = Number(args.year ?? nowDate.getUTCFullYear());
      const month = Number(args.month ?? nowDate.getUTCMonth() + 1);
      const asOf = args.as_of ? validateDate(String(args.as_of)) : today();
      const includePending = args.include_pending === true;
      const includePlanned = args.include_planned === true;
      const includeSources = args.include_sources === true && args.summary !== true;
      const shortMonths = Number(args.trailing_months_short ?? 3);
      const longMonths = Number(args.trailing_months_long ?? 6);
      if (!Number.isInteger(shortMonths) || shortMonths < 1) throw new Error("trailing_months_short must be a positive integer");
      if (!Number.isInteger(longMonths) || longMonths < 1) throw new Error("trailing_months_long must be a positive integer");
      const discretionaryMultiplier = args.discretionary_multiplier == null ? 0.5 : Number(args.discretionary_multiplier);
      if (!Number.isFinite(discretionaryMultiplier) || discretionaryMultiplier < 0 || discretionaryMultiplier > 1) throw new Error("discretionary_multiplier must be between 0 and 1");

      const defaultAssets = spendableAssetAccountDefaults(ledger);
      const assetAccounts = nonOverlappingAccounts(ledger, args.asset_account_ids ?? defaultAssets.selected, ["asset"]);
      const liabilityAccounts = nonOverlappingAccounts(ledger, args.liability_account_ids ?? rootAccountIds(ledger, ["liability"]), ["liability"]);
      const projection = handlers.cash_projection(ledger, {
        year,
        month,
        asset_account_ids: assetAccounts,
        liability_account_ids: liabilityAccounts,
        earmarks: args.earmarks ?? null,
        include_pending: includePending,
        include_planned: includePlanned,
        quote_asset_id: quote
      }) as Row;
      const budget = budgetBurn(ledger, year, month, quote, includePending);
      const trailingEnd = trailingWindowEnd(year, month, asOf, args.include_partial_month === true);
      const trailingShort = trailingSpend(ledger, Number(trailingEnd.year), Number(trailingEnd.month), shortMonths, quote, includeSources);
      const trailingLong = trailingSpend(ledger, Number(trailingEnd.year), Number(trailingEnd.month), longMonths, quote, includeSources);
      const currentMonthBudgetReserve = args.reserve_remaining_budget === false ? 0n : positive(BigInt((budget.budget as Row).total_remaining_cents ?? 0));
      const available = BigInt(projection.available_cash_cents);
      const runwayCash = positive(available - currentMonthBudgetReserve);
      const fixedBurn = BigInt(budget.fixed_budget_cents);
      const discretionaryBurn = BigInt(budget.discretionary_budget_cents);
      const discretionaryAdjusted = fixedBurn + scaleBigint(discretionaryBurn, discretionaryMultiplier);
      const shortModelName = `trailing_${shortMonths}_month_actual`;
      const longModelName = `trailing_${longMonths}_month_actual`;
      const budgetModelNames = ["budget_burn", "fixed_obligation_burn", "discretionary_adjusted_burn"];
      const burnModelNames = [...budgetModelNames.slice(0, 1), shortModelName, longModelName, ...budgetModelNames.slice(1)];
      const projectionMissing = projection.missing_conversions as Row[];
      const budgetMissing = ((budget.budget as Row).missing_conversions ?? []) as Row[];
      const shortMissing = trailingShort.missing_conversions as Row[];
      const longMissing = trailingLong.missing_conversions as Row[];
      const missing = scopedMissingConversions(ledger, [
        { section: "cash_projection", affectedModels: burnModelNames, rows: projectionMissing },
        { section: "budget", affectedModels: budgetModelNames, rows: budgetMissing },
        { section: "trailing_actuals.short", affectedModels: [shortModelName], rows: shortMissing },
        { section: "trailing_actuals.long", affectedModels: [longModelName], rows: longMissing }
      ]);
      const missingForModel = (name: string) => missing.filter((row) => ((row.affected_models as string[] | undefined) ?? []).includes(name));
      const withSource = (source: Row, sourceSummary: Row) => includeSources ? { source } : { source_summary: sourceSummary };
      const model = (name: string, label: string, monthlyBurn: bigint, source: Row, sourceSummary: Row) => {
        const modelMissing = missingForModel(name);
        return {
          model: name,
          label,
          monthly_burn_cents: monthlyBurn,
          runway_months: runwayMonths(runwayCash, monthlyBurn),
          valuation_complete: modelMissing.length === 0,
          missing_conversion_count: modelMissing.length,
          ...(includeSources && modelMissing.length > 0 ? { missing_conversions: modelMissing } : {}),
          ...withSource(source, sourceSummary)
        };
      };
      const burnModels = [
        model("budget_burn", "Budget burn", BigInt(budget.monthly_burn_cents), budget.budget as Row, budgetSummary(budget.budget as Row)),
        model(shortModelName, `Trailing ${shortMonths}-month actual burn`, BigInt(trailingShort.monthly_burn_cents), trailingShort, trailingSummary(trailingShort)),
        model(longModelName, `Trailing ${longMonths}-month actual burn`, BigInt(trailingLong.monthly_burn_cents), trailingLong, trailingSummary(trailingLong)),
        model("fixed_obligation_burn", "Fixed-obligation burn", fixedBurn, { fixed_budget_rows: budget.fixed_budget_rows }, { fixed_budget_count: (budget.fixed_budget_rows as Row[]).length, fixed_budget_cents: fixedBurn }),
        model("discretionary_adjusted_burn", "Fixed plus reduced discretionary burn", discretionaryAdjusted, {
          fixed_budget_cents: fixedBurn,
          discretionary_budget_cents: discretionaryBurn,
          discretionary_multiplier: discretionaryMultiplier
        }, {
          fixed_budget_cents: fixedBurn,
          discretionary_budget_cents: discretionaryBurn,
          discretionary_multiplier: discretionaryMultiplier
        })
      ];
      const recommended = burnModels.find((row) => row.model === `trailing_${shortMonths}_month_actual` && row.runway_months != null)
        ?? burnModels.find((row) => row.model === "budget_burn" && row.runway_months != null)
        ?? burnModels.find((row) => row.runway_months != null)
        ?? burnModels[0];
      return {
        year,
        month,
        as_of: asOf,
        quote_asset_id: quote,
        basis: includePlanned ? "projection" : includePending ? "actual_plus_pending" : "conservative_actual",
        summary: args.summary === true,
        include_sources: includeSources,
        include_pending: includePending,
        include_planned: includePlanned,
        actual_cash_cents: projection.actual_available_cash_cents,
        available_cash_cents: available,
        current_month_budget_reserve_cents: currentMonthBudgetReserve,
        spendable_cash_cents: runwayCash,
        runway_cash_cents: runwayCash,
        planned_cash_cents: projection.planned_cash_cents,
        pending_cash_delta_cents: projection.pending_available_delta_cents,
        earmarks_cents: projection.earmarks_cents,
        liability_effect_cents: projection.liability_effect_cents,
        asset_account_ids: assetAccounts,
        liability_account_ids: liabilityAccounts,
        excluded_asset_account_ids: args.asset_account_ids ? [] : defaultAssets.excluded,
        account_selection_rule: args.asset_account_ids ? "explicit asset_account_ids" : defaultAssets.rule,
        assumptions: {
          conservative_default: true,
          planned_cash_excluded_unless_requested: true,
          pending_cash_excluded_unless_requested: true,
          investments_excluded_by_default_when_named_as_investment_accounts: true,
          current_month_budget_reserved_by_default: args.reserve_remaining_budget !== false,
          partial_month_excluded_from_trailing_actuals_by_default: args.include_partial_month !== true,
          trailing_months_short: shortMonths,
          trailing_months_long: longMonths,
          trailing_window_basis: trailingEnd.basis,
          trailing_window_end_year: trailingEnd.year,
          trailing_window_end_month: trailingEnd.month,
          discretionary_multiplier: discretionaryMultiplier
        },
        trailing_window: trailingEnd,
        recommended_model: recommended.model,
        runway_months: recommended.runway_months,
        burn_models: burnModels,
        cash_projection: includeSources ? projection : cashProjectionSummary(projection),
        budget: includeSources ? budget.budget : budgetSummary(budget.budget as Row),
        trailing_actuals: {
          short: includeSources ? trailingShort : trailingSummary(trailingShort),
          long: includeSources ? trailingLong : trailingSummary(trailingLong)
        },
        valuation_complete: missing.length === 0,
        missing_conversions: missing,
        conversion_warning: conversionSeverity(missing, { recommendedModel: String(recommended.model) })
      };
    },

    forecast: (ledger, args) => {
      const accountId = account(ledger, args.account_id);
      const assetId = args.asset_id ? explicitAsset(ledger, args.asset_id) : accountAsset(ledger, accountId);
      const asOf = optionalDate(args.as_of);
      return { account_id: accountId, posted_cents: ledger.balanceTree(accountId, assetId, asOf, "posted"), pending_cents: ledger.balanceTree(accountId, assetId, asOf, "pending"), planned_cents: ledger.balanceTree(accountId, assetId, asOf, "planned"), projected_cents: ledger.balanceTree(accountId, assetId, asOf, null) };
    },

    preview_commit: (ledger, args) => {
      const accounts = new Map(ledger.listAccounts().map((row) => [row.id, row]));
      const changes = new Map<string, bigint>();
      for (const tx of ledger.listTransactions({ status: "pending", dateTo: optionalDate(args.as_of) })) for (const entry of ledger.getEntries(tx.id)) changes.set(entry.account_id, (changes.get(entry.account_id) ?? 0n) + entry.quantity);
      const rows = [...changes.entries()].filter(([, amount]) => amount !== 0n).map(([accountId, amount]) => ({ account_id: accountId, account_name: accounts.get(accountId)?.name ?? "", change_cents: amount }));
      return { affected_accounts: rows, total_accounts: rows.length };
    },

    project_month_end: (ledger, args) => {
      const projectionAccounts = splitProjectionAccounts(ledger, args);
      const projection = handlers.cash_projection(ledger, {
        ...args,
        include_pending: args.include_pending ?? true,
        include_planned: args.include_planned ?? true,
        ...projectionAccounts
      }) as Row;
      const quote = reportAsset(ledger, args.quote_asset_id);
      const inflows = [...(args.expected_inflows ?? []), ...(args.expected_paychecks ?? [])].reduce((sum: bigint, row: Row) => sum + nonNegativeMoneyAmount(ledger, quote, row.amount ?? 0, "Expected inflow amount"), 0n);
      const outflows = (args.expected_outflows ?? []).reduce((sum: bigint, row: Row) => sum + nonNegativeMoneyAmount(ledger, quote, row.amount ?? 0, "Expected outflow amount"), 0n);
      return { ...projection, projected_month_end_cents: BigInt(projection.available_cash_cents) + inflows - outflows };
    },

    project_balances: (ledger, args) => {
      unsupportedArguments({ branch: args.branch });
      const quote = reportAsset(ledger, args.quote_asset_id);
      const accounts = nonOverlappingAccounts(ledger, args.account_ids ?? rootAccountIds(ledger, ["asset", "liability"]));
      const missing: Row[] = [];
      const rows = accounts.map((accountId: string) => {
        const result = ledger.quotedBalanceTree(accountId, quote, validateDate(String(args.through)), null);
        missing.push(...result.missing);
        return { account_id: accountId, balance_cents: result.total };
      });
      return {
        through: args.through,
        accounts: rows,
        net_worth_cents: rows.reduce((sum: bigint, row: Row) => sum + BigInt(row.balance_cents), 0n),
        quote_asset_id: quote,
        valuation_complete: missing.length === 0,
        missing_conversions: missing,
        goals: args.include_goals ? handlers.list_goals(ledger, {}) : undefined
      };
    },

    list_uncategorized: (ledger, args) => {
      const catchAll = args.catch_all_account_id ? account(ledger, args.catch_all_account_id) : null;
      const accounts = new Map(ledger.listAccounts().map((row) => [row.id, row]));
      const rows = iterTransactions(ledger, { status: reportStatus(args, "pending"), date_from: args.date_from, date_to: args.date_to }).filter((tx) => ledger.getEntries(tx.id).some((entry) => catchAll ? entry.account_id === catchAll : accounts.get(entry.account_id)?.name.toLowerCase() === "uncategorized")).map((tx) => txPublic(ledger, tx, Boolean(args.compact)));
      return { transactions: rows.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 50)), items: rows, total: rows.length, limit: args.limit ?? 50, offset: args.offset ?? 0 };
    },

    audit_categorization: (ledger, args) => {
      const uncategorized = handlers.list_uncategorized(ledger, { status: reportStatus(args, "posted"), date_from: args.date_from, date_to: args.date_to, limit: 1000, compact: true }) as Row;
      const counts = new Map<string, number>();
      for (const tx of uncategorized.transactions as Row[]) counts.set(String(tx.description), (counts.get(String(tx.description)) ?? 0) + 1);
      return { mode: args.mode ?? "budget", uncategorized, frequent_descriptions: [...counts.entries()].filter(([, count]) => count >= (args.min_occurrences ?? 2)).map(([description, count]) => ({ description, count })) };
    },

    top_descriptions: (ledger, args) => {
      const accountId = account(ledger, args.account_id);
      const counts = new Map<string, { count: number; amount: bigint }>();
      for (const tx of iterTransactions(ledger, { status: args.status })) {
        const amount = amountForAccount(ledger, tx.id, accountId);
        if (amount === 0n) continue;
        const current = counts.get(tx.description) ?? { count: 0, amount: 0n };
        current.count += 1; current.amount += amount < 0n ? -amount : amount; counts.set(tx.description, current);
      }
      return [...counts.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, args.limit ?? 50).map(([description, row]) => ({ description, count: row.count, amount_cents: row.amount }));
    },

    count_transactions: (ledger, args) => {
      let rows = iterTransactions(ledger, { status: args.status, date_from: args.date_from, date_to: args.date_to });
      if (args.account_id) rows = rows.filter((tx) => amountForAccount(ledger, tx.id, account(ledger, args.account_id)) !== 0n);
      return { count: rows.length, by_status: Object.fromEntries([...new Set(rows.map((tx) => tx.status))].map((status) => [status, rows.filter((tx) => tx.status === status).length])) };
    },

    age_of_money: (ledger, args) => ageOfMoney(ledger, args),

    holdings: (ledger, args) => {
      const acct = args.account_id ? account(ledger, args.account_id) : null;
      const rows = ledger.listAssets().filter((ast) => !args.asset_type || ast.asset_type === args.asset_type).flatMap((ast) => ledger.listAccounts()
        .filter((accountRow) => accountRow.account_type === "asset")
        .filter((accountRow) => !acct || accountRow.id === acct)
        .map((accountRow) => {
          const quantity = ledger.balanceTree(accountRow.id, ast.id, null, null);
          return { account_id: accountRow.id, account_name: accountRow.name, asset_id: ast.id, asset_symbol: ast.symbol, quantity, quantity_display: display(ledger, quantity, ast.id) };
        })
      ).filter((row) => row.quantity !== 0n);
      return rows;
    },
  };
}
