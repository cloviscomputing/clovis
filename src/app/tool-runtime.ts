import { createHash } from "node:crypto";
import { Ledger } from "../core/ledger.js";
import type { TxStatus } from "../core/types.js";
import {
  journalLegQuantity,
  nonNegativeMoneyAmount,
  positiveAtomicQuantity,
  positiveMoneyAmount,
  positiveShareQuantity,
  signedMoneyAmount
} from "./amount-policy.js";
import { backupPreview, backupResultPublic, backupStatus, listBackupFiles, resolveBackupWritePath } from "./backup-filesystem.js";
import { safeJson, stringifyPublic } from "./json.js";
import { assertLedgerImportSize, assertToolDataSize, fileAccessStatus, readLedgerImportFile, readToolTextFile, redactToolPath, resolveToolWritePath, writeToolTextFile } from "./filesystem.js";
import {
  mutationPreview,
  operationPublic
} from "./mutation-overseer.js";
import { reverseLedgerOperation as reverseLedgerOperationWithDeps } from "./operation-reversal.js";
import { operatingManual } from "./operating-manual.js";
import { createScenarioBranch, discardScenarioBranch, listScenarioBranches, resolveOpenScenarioBranch } from "./scenario-policy.js";
import { effectiveToolDefinition, normalizeToolInput, parameterAliasesForTool, STATUS_FILTER_VALUES, TOOL_SIGNATURES, type ToolSignatureName } from "./signatures.js";
import {
  MAX_MATCH_INPUT_LENGTH,
  account,
  accountAsset,
  accountDefaultAsset,
  accountPublic,
  addDays,
  amountForAccount,
  amountWithinTolerance,
  applyRecategorizeTransaction,
  asset,
  batch,
  dateDeltaDays,
  directedTxPublic,
  display,
  entriesPublic,
  explicitAsset,
  id,
  iterTransactions,
  monthBounds,
  nonOverlappingAccounts,
  now,
  optionalDate,
  postedAtBound,
  previousDate,
  realizedPlannedRows,
  recategorizePreview,
  recurringDateRange,
  reportAsset,
  reportStatus,
  rootAccountIds,
  safeMatchRegex,
  selectBatchTransactions,
  setAccountDefaultAsset,
  splitProjectionAccounts,
  tagTx,
  today,
  transactionAsset,
  transactionMagnitude,
  txIdsForBatch,
  txPublic,
  txWithEntries,
  unsupportedArguments,
} from "./transaction-helpers.js";
import type { Args, Row } from "./transaction-helpers.js";
import {
  ageOfMoney,
  budgetRows,
  budgetSummary,
  cashProjectionSummary,
  conversionSeverity,
  effectiveBudgetRows,
  incomeStatementRows,
  positive,
  quotedPlannedUnrealized,
  runwayMonths,
  scaleBigint,
  scopedMissingConversions,
  spendableAssetAccountDefaults,
  spendingRows,
  trailingSpend,
  trailingSummary,
  trailingWindowEnd
} from "./report-helpers.js";
import {
  compactTransactionEffects,
  hasSelectedSameTypeAncestor,
  presentAccountBalance,
  resolveScopedAccounts,
  statementDetailMode
} from "./read-view.js";
import {
  applyStatementPlan,
  buildStatementPlan,
  counterpartForRow,
  importPreview,
  parseStatementFile,
  importTransactionRows,
  parseStatementRows,
  signedStatementQuantity,
  statementBalanceFields,
  verifyStatementPlan
} from "./statement-helpers.js";
import type { ToolHandler, ToolSpec } from "./tool-spec.js";
import { accountHandlers } from "./tools/accounts.js";
import { budgetHandlers } from "./tools/budgets.js";
import { maintenanceHandlers } from "./tools/maintenance.js";
import { reportHandlers } from "./tools/reports.js";
import { statementHandlers } from "./tools/statements.js";
import { transactionHandlers } from "./tools/transactions.js";
import {
  isBulkCategorizationCandidate,
  txMatchesStatusFilter
} from "./transaction-lifecycle.js";
import { parseTxStatus, parseTxStatusFilter, validateDate } from "./validation.js";

// Shared command catalog for CLI and MCP. This layer translates user/tool
// arguments into Ledger calls and public JSON shapes; core owns durable state.
export type Handler = ToolHandler;
export type { Args, Row } from "./transaction-helpers.js";

export type ToolName = ToolSignatureName;

let installedToolSpecs: Record<string, ToolSpec> = {};

export function installToolSpecMap(specs: Record<string, ToolSpec>): void {
  installedToolSpecs = specs;
}

function toolNames(): ToolName[] {
  return Object.keys(installedToolSpecs) as ToolName[];
}

function toolSpec(name: ToolName): ToolSpec {
  const spec = installedToolSpecs[name];
  if (!spec) throw new Error(`Tool '${name}' is not implemented`);
  return spec;
}

function fixedBudgetAccount(accountName: string): boolean {
  return /\b(rent|mortgage|utilities?|insurance|loan|debt|phone|internet|subscription|tax|property tax|childcare|daycare|tuition)\b/i.test(accountName);
}

function budgetBurn(ledger: Ledger, year: number, month: number, quote: string, includePending: boolean): Row {
  const budget = handlers.budget_summary(ledger, { year, month, quote_asset_id: quote, include_pending: includePending }) as Row;
  const budgets = (budget.budgets as Row[]) ?? [];
  const fixedRows = budgets.filter((row) => fixedBudgetAccount(String(row.account_name ?? ledger.getAccount(String(row.account_id))?.name ?? "")));
  const fixed = fixedRows.reduce((sum, row) => sum + BigInt(row.budgeted_cents), 0n);
  return {
    budget,
    monthly_burn_cents: BigInt(budget.total_budgeted_cents ?? 0),
    fixed_budget_cents: fixed,
    discretionary_budget_cents: BigInt(budget.total_budgeted_cents ?? 0) - fixed,
    fixed_budget_rows: fixedRows
  };
}

function registryNames(args: Args): { names: ToolName[]; unknown_names: string[] } {
  if (args.names == null) return { names: toolNames(), unknown_names: [] };
  const requested = Array.isArray(args.names)
    ? args.names.map((name) => String(name))
    : String(args.names).split(",").map((name) => name.trim()).filter(Boolean);
  const known = new Set<string>(toolNames());
  const unknown = requested.filter((name) => !known.has(name));
  return { names: requested.filter((name) => known.has(name)) as ToolName[], unknown_names: unknown };
}

function registrySafetyMatches(name: ToolName, args: Args): boolean {
  const safety = toolSpec(name).safety;
  const filter = args.safety_filter;
  if (filter == null) return true;
  if (typeof filter === "string") {
    const value = filter.toLowerCase().replace(/[\s_-]+/g, "");
    if (["readonly", "read"].includes(value)) return safety.readOnlyHint;
    if (["write", "mutating"].includes(value)) return !safety.readOnlyHint;
    if (value === "destructive") return safety.destructiveHint;
    if (["dryrun", "dryruncapable"].includes(value)) return safety.supportsDryRun;
    if (value === "defaultdryrun") return safety.defaultDryRun;
    if (value === "idempotent") return safety.idempotentHint;
    if (value === "safe") return safety.readOnlyHint || safety.defaultDryRun;
    throw new Error(`Unknown safety_filter: ${filter}`);
  }
  if (typeof filter !== "object") throw new Error("safety_filter must be a string or object");
  for (const [key, expected] of Object.entries(filter)) {
    if (key in safety && (safety as Row)[key] !== expected) return false;
  }
  return true;
}

function registryEntry(name: ToolName, summary: boolean): Row {
  const spec = toolSpec(name);
  const safety = spec.safety;
  const definition = effectiveToolDefinition(name);
  if (summary) {
    return {
      name,
      workflow: spec.workflow,
      mutation: spec.mutation,
      signature: TOOL_SIGNATURES[name],
      parameters: definition.parameters.map((parameter) => parameter[0]),
      aliases: parameterAliasesForTool(name),
      safety
    };
  }
  return {
    name,
    workflow: spec.workflow,
    mutation: spec.mutation,
    signature: TOOL_SIGNATURES[name],
    definition,
    aliases: parameterAliasesForTool(name),
    safety
  };
}

function scopedExportDocument(ledger: Ledger, args: Args): Row {
  const doc = ledger.exportDocument() as Row;
  const accountIds = args.account_ids
    ? new Set((args.account_ids as string[]).flatMap((ref) => [...ledger.descendants(account(ledger, ref))]))
    : null;
  const entityId = args.entity_id ? String(args.entity_id) : null;
  const dateFrom = optionalDate(args.date_from);
  const dateTo = optionalDate(args.date_to);
  const hasScope = Boolean(accountIds?.size || entityId || dateFrom || dateTo);
  if (!hasScope) return doc;

  const transactions = ((doc.transactions as Row[]) ?? []).filter((tx) => {
    if (dateFrom && String(tx.date) < dateFrom) return false;
    if (dateTo && String(tx.date) > dateTo) return false;
    const entries = (tx.entries as Row[]) ?? [];
    const tags = (tx.tags as Row[]) ?? [];
    if (accountIds && !entries.some((entry) => accountIds.has(String(entry.account_id)))) return false;
    if (entityId) {
      const matchesEntity = tx.id === entityId
        || tx.source_id === entityId
        || entries.some((entry) => entry.account_id === entityId || entry.asset_id === entityId)
        || tags.some((tag) => tag.id === entityId || tag.entity_id === entityId || tag.value === entityId || tag.val === entityId);
      if (!matchesEntity) return false;
    }
    return true;
  });

  const txIds = new Set(transactions.map((tx) => String(tx.id)));
  const sourceIds = new Set(transactions.map((tx) => tx.source_id).filter(Boolean).map(String));
  const usedAccountIds = new Set<string>(accountIds ?? []);
  for (const tx of transactions) for (const entry of (tx.entries as Row[]) ?? []) usedAccountIds.add(String(entry.account_id));
  for (const id of [...usedAccountIds]) {
    let parentId = ledger.getAccount(id)?.parent_id ?? null;
    while (parentId) {
      usedAccountIds.add(parentId);
      parentId = ledger.getAccount(parentId)?.parent_id ?? null;
    }
  }
  const accountScoped = (row: Row): boolean => usedAccountIds.size === 0 || usedAccountIds.has(String(row.account_id));

  return {
    ...doc,
    scope: {
      entity_id: entityId,
      date_from: dateFrom,
      date_to: dateTo,
      account_ids: accountIds ? [...accountIds] : null,
      transaction_count: transactions.length
    },
    accounts: usedAccountIds.size ? (doc.accounts as Row[]).filter((row) => usedAccountIds.has(String(row.id))) : doc.accounts,
    sources: (doc.sources as Row[]).filter((row) => sourceIds.has(String(row.id)) || row.id === entityId),
    transactions,
    account_tags: ((doc.account_tags as Row[]) ?? []).filter((row) => usedAccountIds.size === 0 || usedAccountIds.has(String(row.entity_id))),
    budgets: ((doc.budgets as Row[]) ?? []).filter(accountScoped),
    goals: ((doc.goals as Row[]) ?? []).filter(accountScoped),
    lots: ((doc.lots as Row[]) ?? []).filter((row) => accountScoped(row) || txIds.has(String(row.opened_journal_id)) || txIds.has(String(row.closed_journal_id))),
    scheduled_transactions: ((doc.scheduled_transactions as Row[]) ?? []).filter((row) => {
      if (usedAccountIds.size === 0) return true;
      return usedAccountIds.has(String(row.from_account_id)) || usedAccountIds.has(String(row.to_account_id));
    })
  };
}

export type ToolCapability = never;

export function requiredToolCapabilities(name: string, args: Args = {}): ToolCapability[] {
  void name;
  void args;
  const capabilities: ToolCapability[] = [];
  return capabilities;
}

export function assertToolCapabilities(name: string, args: Args, granted: Set<ToolCapability | "all">, surface: "CLI" | "MCP"): void {
  void name;
  void args;
  void granted;
  void surface;
}

function assertMcpCapability(name: string, args: Args): void {
  // MCP is a trusted local control plane; tool annotations and dry-run previews
  // guide callers, while hard boundaries belong to the host environment.
  void name;
  void args;
}

const runtimeContext = {
  MAX_MATCH_INPUT_LENGTH,
  STATUS_FILTER_VALUES,
  account,
  accountAsset,
  accountDefaultAsset,
  accountPublic,
  addDays,
  ageOfMoney,
  amountForAccount,
  amountWithinTolerance,
  applyRecategorizeTransaction,
  applyStatementPlan,
  assertToolDataSize,
  assertLedgerImportSize,
  asset,
  backupPreview,
  backupResultPublic,
  backupStatus,
  batch,
  budgetBurn,
  budgetRows,
  budgetSummary,
  buildStatementPlan,
  cashProjectionSummary,
  compactTransactionEffects,
  conversionSeverity,
  counterpartForRow,
  createHash,
  createScenarioBranch,
  dateDeltaDays,
  directedTxPublic,
  discardScenarioBranch,
  display,
  effectiveBudgetRows,
  entriesPublic,
  explicitAsset,
  fileAccessStatus,
  id,
  incomeStatementRows,
  importPreview,
  importTransactionRows,
  isBulkCategorizationCandidate,
  iterTransactions,
  journalLegQuantity,
  listBackupFiles,
  listScenarioBranches,
  monthBounds,
  mutationPreview,
  nonNegativeMoneyAmount,
  nonOverlappingAccounts,
  now,
  normalizeToolInput,
  operatingManual,
  operationPublic,
  optionalDate,
  parseStatementFile,
  parseStatementRows,
  parseTxStatus,
  parseTxStatusFilter,
  postedAtBound,
  presentAccountBalance,
  hasSelectedSameTypeAncestor,
  positive,
  positiveAtomicQuantity,
  positiveMoneyAmount,
  positiveShareQuantity,
  previousDate,
  quotedPlannedUnrealized,
  readLedgerImportFile,
  readToolTextFile,
  realizedPlannedRows,
  recategorizePreview,
  recurringDateRange,
  redactToolPath,
  registryEntry,
  registryNames,
  registrySafetyMatches,
  reportAsset,
  reportStatus,
  resolveScopedAccounts,
  resolveBackupWritePath,
  resolveOpenScenarioBranch,
  resolveToolWritePath,
  reverseLedgerOperationWithDeps,
  rootAccountIds,
  runwayMonths,
  safeJson,
  safeMatchRegex,
  scaleBigint,
  scopedExportDocument,
  scopedMissingConversions,
  selectBatchTransactions,
  setAccountDefaultAsset,
  signedMoneyAmount,
  signedStatementQuantity,
  statementBalanceFields,
  spendableAssetAccountDefaults,
  spendingRows,
  splitProjectionAccounts,
  statementDetailMode,
  stringifyPublic,
  tagTx,
  today,
  toolNames,
  toolSpec,
  transactionAsset,
  transactionMagnitude,
  trailingSpend,
  trailingSummary,
  trailingWindowEnd,
  txIdsForBatch,
  txMatchesStatusFilter,
  txPublic,
  txWithEntries,
  unsupportedArguments,
  validateDate,
  verifyStatementPlan,
  writeToolTextFile
};

export type ToolRuntimeContext = typeof runtimeContext;
export type ToolHandlers = Record<ToolName, Handler>;

export const handlers: ToolHandlers = {} as ToolHandlers;

function registerHandlerGroup(groupName: string, group: Partial<ToolHandlers>): void {
  for (const [name, handler] of Object.entries(group)) {
    if (handlers[name as ToolName]) throw new Error(`Duplicate handler '${name}' in ${groupName}`);
    handlers[name as ToolName] = handler as Handler;
  }
}

registerHandlerGroup("accounts", accountHandlers(runtimeContext, handlers));
registerHandlerGroup("transactions", transactionHandlers(runtimeContext, handlers));
registerHandlerGroup("statements", statementHandlers(runtimeContext, handlers));
registerHandlerGroup("reports", reportHandlers(runtimeContext, handlers));
registerHandlerGroup("budgets", budgetHandlers(runtimeContext, handlers));
registerHandlerGroup("maintenance", maintenanceHandlers(runtimeContext, handlers));
