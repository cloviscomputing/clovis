import type { Journal } from "../../core/types.js";
import type { Row, ToolHandlers, ToolRuntimeContext } from "../tool-runtime.js";
import { defineToolGroup } from "../tool-spec.js";

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
        ["sample_limit", "integer", { optional: true, defaultValue: 20 }]
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
        ["sample_limit", "integer", { optional: true, defaultValue: 20 }]
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

export function statementHandlers(ctx: ToolRuntimeContext, handlers: ToolHandlers): Partial<ToolHandlers> {
  const {
    account,
    accountAsset,
    amountForAccount,
    applyStatementPlan,
    asset,
    batch,
    buildStatementPlan,
    dateDeltaDays,
    explicitAsset,
    importPreview,
    importTransactionRows,
    iterTransactions,
    parseStatementRows,
    parseTxStatus,
    reportStatus,
    selectBatchTransactions,
    signedStatementQuantity,
    tagTx,
    txIdsForBatch,
    txPublic,
    unsupportedArguments,
    verifyStatementPlan
  } = ctx;
  return {

    import_transactions: (ledger, args) => {
      if (args.date_tolerance_days != null && args.date_tolerance_days !== 1) unsupportedArguments({ date_tolerance_days: args.date_tolerance_days });
      if (args.dry_run) return importPreview(ledger, account(ledger, args.account_id), account(ledger, args.counterpart_id), args.transactions ?? [], args);
      const result = importTransactionRows(ledger, account(ledger, args.account_id), account(ledger, args.counterpart_id), args.transactions ?? [], { ...args, source_id: null });
      const status = parseTxStatus(args.status ?? "pending") ?? "pending";
      const batchStatus = status === "posted" ? "posted_import" : status === "pending" ? "pending_import" : `${status}_import`;
      const batchId = result.created > 0 ? batch(ledger, args.batch_label, { statement_type: args.statement_type }, batchStatus) : null;
      for (const tx of result.transactions) {
        if (batchId) {
          ledger.updateTransactionSource(String(tx.id), batchId);
          tx.source_id = batchId;
          tagTx(ledger, String(tx.id), "import_batch", batchId);
        }
        for (const [key, value] of Object.entries(args.tags ?? {})) tagTx(ledger, String(tx.id), key, String(value));
      }
      const transactions = result.transactions.map((tx) => txPublic(ledger, ledger.getTx(String(tx.id))!));
      return { ...result, transactions, batch_id: batchId, imported: result.created, skipped: result.skipped, transfer_stats: { matched: 0, unmatched: 0 } };
    },

    import_file: (ledger, args) => {
      const rows = parseStatementRows(ledger, args.file_path, args);
      return handlers.import_transactions(ledger, { account_id: args.account_id, counterpart_id: args.counterpart_account_id, transactions: rows, status: args.status ?? "pending", currency: args.currency, asset_id: args.asset_id, amount_convention: args.amount_convention ?? "signed", statement_type: args.statement_type });
    },

    preview_import: (_ledger, args) => {
      const rows = parseStatementRows(_ledger, args.file_path, args);
      return { rows: rows.slice(0, args.rows ?? 3), transactions: rows.slice(0, args.rows ?? 3), total_rows: rows.length, would_import: rows.length, warnings: [], dry_run: true };
    },

    process_statement: (ledger, args) => {
      unsupportedArguments({ transfer_account_id: args.transfer_account_id });
      const plan = buildStatementPlan(ledger, { ...args, status: "posted" }, { persist: Boolean(args.commit), targetStatus: "posted" });
      const actions = plan.actions ?? {};
      const newRows = (actions.new_posted ?? 0) + (actions.new_pending ?? 0);
      const wouldApply = newRows + (actions.pending_to_commit ?? 0) + (actions.stale_pending_to_void ?? 0);
      const preview = {
        ...plan,
        transactions: [...(plan.new_posted ?? []), ...(plan.pending_to_commit ?? [])].slice(0, args.preview_rows ?? 10),
        matched_existing: actions.matched ?? 0,
        pending_to_commit_count: actions.pending_to_commit ?? 0,
        stale_pending_to_void_count: actions.stale_pending_to_void ?? 0,
        new_rows: newRows,
        ambiguous_count: actions.ambiguous ?? 0,
        ignored_count: actions.ignored ?? 0,
        would_import: newRows,
        would_apply: wouldApply,
        dry_run: !args.commit
      };
      return args.commit ? { ...preview, ...applyStatementPlan(ledger, String(plan.plan_id), { dry_run: false, batch_label: args.batch_label }) } : { ...preview, created: 0 };
    },

    list_import_batches: (ledger, args) => {
      const rows = new Map<string, Row>();
      for (const row of ledger.listSources("import", args.limit ?? 1000)) {
        rows.set(String(row.id), { ...row, id: String(row.id), batch_id: String(row.id), origin: "source", tx_count: txIdsForBatch(ledger, String(row.id)).length });
      }
      for (const tag of ledger.listAnnotationValues("tx", "import_batch")) {
        const batchId = String(tag.value);
        const existing = rows.get(batchId);
        rows.set(batchId, {
          ...existing,
          id: batchId,
          batch_id: batchId,
          type: existing?.type ?? "import",
          label: existing?.label ?? batchId,
          status: existing?.status ?? "tagged",
          created_at: existing?.created_at ?? tag.first_seen_at ?? "",
          origin: existing ? "source+tag" : "tag",
          tx_count: txIdsForBatch(ledger, batchId).length
        });
      }
      return [...rows.values()]
        .filter((row) => !args.date_from || !row.created_at || String(row.created_at) >= args.date_from)
        .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))
        .slice(0, args.limit ?? 20);
    },

    rollback_import: (ledger, args) => {
      const txIds = txIdsForBatch(ledger, args.batch_id);
      for (const txId of txIds) if (ledger.getTx(txId)) ledger.voidTx(txId);
      ledger.updateSourceStatus(args.batch_id, "rolled_back");
      return { batch_id: args.batch_id, rolled_back: txIds.length, tx_ids: txIds };
    },

    commit_batch: (ledger, args) => {
      const selected = selectBatchTransactions(ledger, args);
      if (!args.dry_run) {
        for (const txId of selected) if (ledger.getTx(txId)?.status === "pending") ledger.updateTxStatus(txId, "posted");
        if (args.batch_id) ledger.updateSourceStatus(args.batch_id, "committed");
      }
      return { matched: selected.length, committed: args.dry_run ? 0 : selected.length, tx_ids: selected, dry_run: Boolean(args.dry_run) };
    },

    discard_batch: (ledger, args) => {
      const selected = selectBatchTransactions(ledger, args);
      if (args.dry_run === false) {
        for (const txId of selected) ledger.deleteTx(txId);
        if (args.batch_id) ledger.updateSourceStatus(args.batch_id, "discarded");
      }
      return { matched: selected.length, discarded: args.dry_run === false ? selected.length : 0, tx_ids: selected, dry_run: args.dry_run !== false };
    },

    invert_import: (ledger, args) => handlers.flip_entries(ledger, { tx_ids: txIdsForBatch(ledger, args.batch_id) }),

    reconcile_statement: (ledger, args) => {
      const accountId = account(ledger, args.account_id);
      const assetId = args.asset_id ? explicitAsset(ledger, args.asset_id) : args.currency ? asset(ledger, null, args.currency) : accountAsset(ledger, accountId);
      const existing = (handlers.list_transactions(ledger, { account_id: accountId, status: null, compact: false, limit: 100000 }) as Row).transactions as Row[];
      const unmatched: Row[] = [];
      const tolerance = Number(args.date_tolerance_days ?? 0);
      for (const row of args.transactions ?? []) {
        const amount = signedStatementQuantity(ledger, assetId, row, args.amount_convention);
        const found = existing.some((tx) => dateDeltaDays(String(tx.date), String(row.date)) <= tolerance && (tx.entries as Row[]).some((entry) => entry.account_id === accountId && entry.asset_id === assetId && BigInt(entry.quantity) === amount));
        if (!found) unmatched.push(row);
      }
      return { matched: (args.transactions ?? []).length - unmatched.length, unmatched: unmatched.length, unmatched_rows: unmatched, reconciled: unmatched.length === 0 };
    },

    reconcile_statement_plan: (ledger, args) => {
      return buildStatementPlan(ledger, { ...args, status: "posted" }, { persist: false, targetStatus: "posted" });
    },

    apply_reconciliation_plan: (ledger, args) => {
      const targetStatus = args.status ?? "pending";
      if (args.plan_id) return applyStatementPlan(ledger, args.plan_id, args);
      const plan = buildStatementPlan(ledger, { ...args, status: targetStatus }, { persist: args.dry_run === false, targetStatus });
      return args.dry_run === false ? applyStatementPlan(ledger, String(plan.plan_id), args) : plan;
    },

    refresh_statement: (ledger, args) => {
      const action = String(args.action ?? "plan");
      if (action === "plan") return buildStatementPlan(ledger, { ...args, status: args.status ?? "posted" }, { persist: args.dry_run === false, targetStatus: args.status ?? "posted" });
      if (action === "apply") return applyStatementPlan(ledger, args.plan_id, args);
      if (action === "verify") return verifyStatementPlan(ledger, args.plan_id);
      if (action === "discard") {
        const plan = ledger.getStatementPlan(args.plan_id);
        if (!plan) throw new Error(`Statement plan '${String(args.plan_id)}' not found`);
        if (args.dry_run !== false) return { dry_run: true, would_discard: true, plan_id: args.plan_id, status: plan.status };
        return { ...ledger.discardStatementPlan(args.plan_id), dry_run: false, discarded: true };
      }
      throw new Error("action must be plan, apply, verify, or discard");
    },

    match_transfers: (ledger, args) => {
      const a = account(ledger, args.account_a);
      const b = account(ledger, args.account_b);
      const txs = iterTransactions(ledger, { status: reportStatus(args, "pending") });
      const pairs: Row[] = [];
      const maybeAddPair = (txA: Journal, txB: Journal) => {
        const amountA = amountForAccount(ledger, txA.id, a);
        const amountB = amountForAccount(ledger, txB.id, b);
        const delta = dateDeltaDays(txA.date, txB.date);
        if (amountA !== 0n && amountA === -amountB && delta <= (args.date_tolerance_days ?? 1)) pairs.push({ tx_a: txA.id, tx_b: txB.id, amount_cents: amountA < 0n ? -amountA : amountA });
      };
      for (let leftIndex = 0; leftIndex < txs.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < txs.length; rightIndex += 1) {
          maybeAddPair(txs[leftIndex], txs[rightIndex]);
          maybeAddPair(txs[rightIndex], txs[leftIndex]);
        }
      }
      const dryRun = args.dry_run !== false;
      if (!dryRun) for (const pair of pairs) { tagTx(ledger, pair.tx_a, "transfer", "matched"); tagTx(ledger, pair.tx_b, "transfer", "matched"); }
      return { matched: pairs.length, pairs, dry_run: dryRun };
    },

    match_transfer_pairs: (ledger, args) => args.account_a && args.account_b ? handlers.match_transfers(ledger, { ...args, status: "pending" }) : { matched: 0, pairs: [], dry_run: args.dry_run !== false },

    consolidate_transfers: (ledger, args) => {
      const result = handlers.match_transfers(ledger, { ...args, dry_run: true, status: "pending" }) as Row;
      const dryRun = args.dry_run !== false;
      if (!dryRun) for (const pair of result.pairs as Row[]) { tagTx(ledger, pair.tx_a, "transfer", "consolidated"); ledger.voidTx(pair.tx_b); }
      return { ...result, consolidated: dryRun ? 0 : (result.pairs as Row[]).length, dry_run: dryRun };
    },

    list_unmatched_transfers: (ledger, args) => {
      const tolerance = Number(args.date_tolerance_days ?? 3);
      const pending = iterTransactions(ledger, { status: "pending" });
      const tagged = pending.filter((tx) => ledger.listAnnotations("tx", tx.id).some((tag) => tag.key === "transfer" && tag.value === "unmatched"));
      return tagged.filter((tx) => !pending.some((other) => {
        if (other.id === tx.id) return false;
        if (dateDeltaDays(tx.date, other.date) > tolerance) return false;
        const txEntries = ledger.getEntries(tx.id);
        const otherEntries = ledger.getEntries(other.id);
        return txEntries.some((left) => otherEntries.some((right) => left.asset_id === right.asset_id && left.quantity === -right.quantity));
      })).map((tx) => txPublic(ledger, tx));
    },
  };
}
