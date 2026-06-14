import type { JournalLine } from "../../core/types.js";
import type { Row, ToolName, ToolHandlers, ToolRuntimeContext } from "../tool-runtime.js";
import { defineToolGroup } from "../tool-spec.js";

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

export function maintenanceHandlers(ctx: ToolRuntimeContext, handlers: ToolHandlers): Partial<ToolHandlers> {
  const {
    STATUS_FILTER_VALUES,
    account,
    accountAsset,
    amountForAccount,
    assertToolDataSize,
    asset,
    backupPreview,
    backupResultPublic,
    backupStatus,
    createHash,
    createScenarioBranch,
    discardScenarioBranch,
    explicitAsset,
    fileAccessStatus,
    listBackupFiles,
    listScenarioBranches,
    mutationPreview,
    normalizeToolInput,
    now,
    operatingManual,
    operationPublic,
    optionalDate,
    parseTxStatusFilter,
    readToolTextFile,
    redactToolPath,
    registryEntry,
    registryNames,
    registrySafetyMatches,
    resolveBackupWritePath,
    resolveOpenScenarioBranch,
    resolveToolWritePath,
    reverseLedgerOperationWithDeps,
    safeJson,
    scopedExportDocument,
    signedMoneyAmount,
    stringifyPublic,
    tagTx,
    toolNames,
    toolSpec,
    txMatchesStatusFilter,
    txPublic,
    txWithEntries,
    unsupportedArguments,
    validateDate,
    writeToolTextFile
  } = ctx;
  return {

    list_ledger_operations: (ledger, args) => ledger.listLedgerOperations(args.limit ?? 50).map((row) => operationPublic(ledger, row)),

    get_ledger_operation: (ledger, args) => {
      const operation = ledger.getLedgerOperation(String(args.operation_id));
      if (!operation) throw new Error(`Ledger operation '${String(args.operation_id)}' not found`);
      return operationPublic(ledger, operation);
    },

    preview_mutation: (ledger, args) => {
      const target = String(args.tool_name);
      if (!toolNames().includes(target as ToolName)) throw new Error(`Tool '${target}' is not implemented`);
      if (target === "preview_mutation") throw new Error("preview_mutation cannot preview itself");
      const targetArgs = normalizeToolInput(target, safeJson(args.arguments ?? {}));
      return mutationPreview(ledger, toolSpec(target as ToolName), targetArgs);
    },

    reverse_ledger_operation: (ledger, args) => reverseLedgerOperationWithDeps(ledger, args, {
      txWithEntries: (txId) => txWithEntries(ledger, txId),
      tagTx: (txId, key, value) => tagTx(ledger, txId, key, value)
    }),

    export_transactions: (ledger, args) => ledger.exportTransactionsCsv(
      args.output_path ? resolveToolWritePath(ledger.path, args.output_path, new Set([".csv"])) : null,
      {
        accountId: args.account_id ? account(ledger, args.account_id) : null,
        dateFrom: optionalDate(args.date_from),
        dateTo: optionalDate(args.date_to),
        status: parseTxStatusFilter(args.status)
      }
    ),

    file_access_status: (ledger) => fileAccessStatus(ledger.path),

    export_ledger: (ledger, args) => {
      const doc = scopedExportDocument(ledger, args);
      const text = stringifyPublic(doc);
      const content_hash = createHash("sha256").update(text).digest("hex");
      if (args.output_path) {
        const output = writeToolTextFile(ledger.path, args.output_path, text, new Set([".json"]));
        return { file: redactToolPath(ledger.path, output), content_hash };
      }
      return { data: text, content_hash };
    },

    import_ledger: (ledger, args) => {
      if (Boolean(args.file_path) === Boolean(args.data)) throw new Error("Exactly one of file_path or data is required");
      const text = args.file_path ? readToolTextFile(ledger.path, args.file_path, new Set([".json"])).text : String(args.data);
      assertToolDataSize(text);
      return ledger.importDocument(JSON.parse(text), args.preserve_ids !== false, Boolean(args.dry_run));
    },

    operating_manual: (_ledger, args) => operatingManual(args.topic),

    create_branch: (ledger, args) => {
      return createScenarioBranch(ledger, args.name);
    },

    list_branches: (ledger) => listScenarioBranches(ledger),

    merge_branch: (ledger, args) => {
      const branch = resolveOpenScenarioBranch(ledger, String(args.source));
      ledger.createAnnotation("book", String(branch.id), "merged_at", now());
      return { merged: branch.id, name: branch.name };
    },

    discard_branch: (ledger, args) => {
      const { branch, updated } = discardScenarioBranch(ledger, String(args.name));
      return { discarded: branch.id, name: branch.name, updated };
    },

    compare_scenarios: (ledger, args) => {
      const assetId = asset(ledger, args.asset_id);
      const rows = ledger.listAccounts().map((acct) => {
        const a = ledger.balanceTree(acct.id, assetId, optionalDate(args.as_of_a), null);
        const b = ledger.balanceTree(acct.id, assetId, optionalDate(args.as_of_b), null);
        return a === b ? null : { account_id: acct.id, account_name: acct.name, a_cents: a, b_cents: b, delta_cents: b - a };
      }).filter(Boolean);
      return { differences: rows, as_of_a: args.as_of_a ?? null, as_of_b: args.as_of_b ?? null };
    },

    close_period: (ledger, args) => ledger.closePeriod(args.name, validateDate(args.as_of), args.description),

    list_checkpoints: (ledger) => ledger.listCheckpoints(),

    reopen_period: (ledger, args) => ledger.reopenPeriod(args.checkpoint_id),

    assert_balance: (ledger, args) => {
      const accountId = account(ledger, args.account_id);
      const assetId = args.asset_id ? explicitAsset(ledger, args.asset_id) : accountAsset(ledger, accountId);
      const actual = ledger.balanceTree(accountId, assetId, optionalDate(args.date), parseTxStatusFilter(args.status));
      const expected = signedMoneyAmount(ledger, assetId, args.expected, "Expected balance");
      return { account_id: accountId, expected_cents: expected, actual_cents: actual, matches: actual === expected, difference_cents: actual - expected, date: args.date ?? null };
    },

    assert_balances: (ledger, args) => {
      const results = (args.assertions ?? []).map((row: Row) => handlers.assert_balance(ledger, { account_id: row.account_id ?? row.account, expected: row.expected, date: row.date, asset_id: row.asset_id, status: args.status }));
      return { matches: results.every((row: any) => row.matches), results };
    },

    reconcile_to_balance: (ledger, args) => {
      const accountId = account(ledger, args.account_id);
      const offset = account(ledger, args.offset_account_id);
      const assetId = args.asset_id ? explicitAsset(ledger, args.asset_id) : accountAsset(ledger, accountId);
      const current = ledger.balanceTree(accountId, assetId);
      const target = signedMoneyAmount(ledger, assetId, args.target_balance, "Target balance");
      const diff = target - current;
      if (args.dry_run || diff === 0n) return { current_cents: current, target_cents: target, difference_cents: diff, dry_run: Boolean(args.dry_run), posted: false };
      const date = validateDate(args.date);
      const tx = diff > 0n ? ledger.recordTransaction(date, diff, offset, accountId, assetId, args.description ?? "Reconcile balance", args.status ?? "posted") : ledger.recordTransaction(date, -diff, accountId, offset, assetId, args.description ?? "Reconcile balance", args.status ?? "posted");
      return { current_cents: current, target_cents: target, difference_cents: diff, posted: true, transaction: txPublic(ledger, tx) };
    },

    reconcile_diff: (ledger, args) => {
      unsupportedArguments({ branch: args.branch });
      const accountId = account(ledger, args.account_id);
      const txs = ledger.listTransactions({ status: null, dateFrom: optionalDate(args.date_from), dateTo: optionalDate(args.date_to) })
        .filter((tx) => txMatchesStatusFilter(tx, "all"))
        .filter((tx) => amountForAccount(ledger, tx.id, accountId) !== 0n)
        .map((tx) => txPublic(ledger, tx));
      return { account_id: accountId, missing: [], extra: [], transactions: txs };
    },

    backup_now: (ledger, args) => {
      const target = resolveBackupWritePath(ledger.path, args.output_path);
      const compact = args.compact !== false;
      if (args.dry_run === true) return backupPreview(ledger.path, target, compact);
      return backupResultPublic(ledger.path, ledger.backupNow(target), Boolean(target), compact);
    },

    backup_status: (ledger) => backupStatus(ledger.path),

    list_backups: (ledger) => listBackupFiles(ledger.path),

    integrity_check: (ledger) => ({ ...ledger.integrityCheck(), healthy: ledger.integrityCheck().ok }),

    repair_integrity: (ledger, args) => {
      const before = ledger.integrityCheck();
      const dryRun = args.dry_run !== false;
      const backup = !dryRun && args.backup !== false ? ledger.backupNow().path : null;
      const repairable = [
        ...((before as Row).orphan_annotations ?? []) as Row[],
        ...((before as Row).invalid_default_assets ?? []) as Row[]
      ];
      const ids = [...new Set(repairable.map((row) => String(row.id)).filter(Boolean))];
      if (!dryRun) for (const id of ids) ledger.deleteAnnotation(id);
      const after = dryRun ? before : ledger.integrityCheck();
      return { dry_run: dryRun, backup: backup ? redactToolPath(ledger.path, backup) : args.backup !== false, before, repaired: dryRun ? 0 : ids.length, after, ok: (after as Row).ok };
    },

    list_tags: (ledger, args) => ledger.listAnnotations(args.entity_type, args.entity_id),

    delete_tag: (ledger, args) => { ledger.deleteAnnotation(args.tag_id); return { deleted: args.tag_id }; },

    delete_tags: (ledger, args) => {
      const tags = ledger.listAnnotations(args.entity_type, args.entity_id).filter((tag) => (args.key == null || tag.key === args.key) && (args.val == null || tag.value === args.val || tag.val === args.val));
      const dryRun = args.dry_run !== false;
      if (!dryRun) for (const tag of tags) ledger.deleteAnnotation(tag.id);
      return { matched: tags.length, deleted: dryRun ? 0 : tags.length, dry_run: dryRun };
    },

    tool_registry: (ledger, args) => {
      const selection = registryNames(args);
      const names = selection.names.filter((name) => registrySafetyMatches(name, args));
      const summary = args.summary === true;
      return {
        version: 1,
        count: toolNames().length,
        returned_count: names.length,
        unknown_names: selection.unknown_names,
        summary,
        file_access: fileAccessStatus(ledger.path),
        status_filter: {
          accepted_values: STATUS_FILTER_VALUES,
          all: "all non-void transactions",
          "null": "same as all for read/filter status",
          active: "posted + pending",
          combined: "posted + pending + planned",
          creation_status_values: ["posted", "pending", "planned", "void"]
        },
        asset_references: {
          asset_id: "asset id or symbol",
          quote_asset_id: "asset id or symbol; aliases currency, quote, and quote_id are accepted when the tool does not already define those parameters"
        },
        filters: {
          names: args.names ?? null,
          safety_filter: args.safety_filter ?? null,
          unknown_names: selection.unknown_names
        },
        tools: names.map((name) => registryEntry(name, summary))
      };
    },

    inspect_transaction: (ledger, args) => {
      const tx = txWithEntries(ledger, args.tx_id);
      tx.integrity = { balanced: (tx.entries as JournalLine[] | Row[]).reduce((sum: bigint, entry: any) => sum + BigInt(entry.quantity), 0n) === 0n };
      return tx;
    },
  };
}
