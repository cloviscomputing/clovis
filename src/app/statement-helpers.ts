import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import { Ledger } from "../core/ledger.js";
import type { Journal, TxStatus } from "../core/types.js";
import { signedMoneyAmount, statementQuantity } from "./amount-policy.js";
import { readToolTextFile } from "./filesystem.js";
import { safeJson } from "./json.js";
import { statementDetailMode } from "./read-view.js";
import { publicPlanRows, statementPlanOutput } from "./statement-workflow.js";
import { isImportDedupeCandidate, isStatementMatchCandidate } from "./transaction-lifecycle.js";
import { parseTxStatus, validateDate } from "./validation.js";
import {
  account,
  accountAsset,
  addDays,
  amountForAccount,
  asset,
  batch,
  categorizationText,
  dateDeltaDays,
  explicitAsset,
  realizedPlannedRows,
  tagTx,
  txPublic,
  type Args,
  type Row
} from "./transaction-helpers.js";

const MAX_IMPORT_ROWS = 10000;

const MAX_CSV_COLUMNS = 200;

const MONTHS = new Map([
  ["january", 1], ["jan", 1],
  ["february", 2], ["feb", 2],
  ["march", 3], ["mar", 3],
  ["april", 4], ["apr", 4],
  ["may", 5],
  ["june", 6], ["jun", 6],
  ["july", 7], ["jul", 7],
  ["august", 8], ["aug", 8],
  ["september", 9], ["sep", 9], ["sept", 9],
  ["october", 10], ["oct", 10],
  ["november", 11], ["nov", 11],
  ["december", 12], ["dec", 12]
]);

export function parseCsv(text: string): Row[] {
  // Statement imports use a bounded CSV parser instead of accepting arbitrary
  // file sizes or column counts through MCP.
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) return [];
  const split = (line: string, lineNumber: number) => {
    const cells: string[] = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quoted && ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = !quoted;
      else if (ch === "," && !quoted) {
        cells.push(cell);
        cell = "";
      } else cell += ch;
    }
    if (quoted) throw new Error(`Invalid CSV quote on line ${lineNumber}`);
    cells.push(cell);
    if (cells.length > MAX_CSV_COLUMNS) throw new Error(`CSV has too many columns; maximum is ${MAX_CSV_COLUMNS}`);
    return cells;
  };
  const headers = split(lines[0], 1).map((h) => h.trim());
  if (headers.length > MAX_CSV_COLUMNS) throw new Error(`CSV has too many columns; maximum is ${MAX_CSV_COLUMNS}`);
  const rows = lines.slice(1);
  if (rows.length > MAX_IMPORT_ROWS) throw new Error(`CSV has too many rows; maximum is ${MAX_IMPORT_ROWS}`);
  return rows.map((line, index) => Object.fromEntries(split(line, index + 2).map((value, i) => [headers[i] || `col_${i}`, value.trim()])).valueOf() as Row & { index: number }).map((row, index) => ({ ...row, index }));
}

export function trimCsvWrapperRows(text: string, skipRows: number, skipFooterRows: number): string {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  while (lines.length > 0 && String(lines.at(-1) ?? "").trim() === "") lines.pop();
  const start = Math.max(0, skipRows);
  const end = skipFooterRows > 0 ? Math.max(start, lines.length - skipFooterRows) : lines.length;
  return lines.slice(start, end).join("\n");
}

export function normalizedDate(year: number, month: number, day: number): string {
  return validateDate(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
}

export function parseImportDate(value: string, format: unknown, rowIndex: number): string {
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return validateDate(text);
  const mode = String(format ?? "auto").toLowerCase();
  const monthName = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(text);
  if (monthName) {
    const month = MONTHS.get(monthName[1].toLowerCase());
    if (!month) throw new Error(`Invalid date on row ${rowIndex}: ${value}`);
    return normalizedDate(Number(monthName[3]), month, Number(monthName[2]));
  }
  const numeric = /^(\d{1,4})[/-](\d{1,2})[/-](\d{1,4})$/.exec(text);
  if (!numeric) throw new Error(`Invalid date on row ${rowIndex}: ${value}`);
  const first = Number(numeric[1]);
  const second = Number(numeric[2]);
  const third = Number(numeric[3]);
  if (numeric[1].length === 4) return normalizedDate(first, second, third);
  if (numeric[3].length !== 4) throw new Error(`Invalid date on row ${rowIndex}: ${value}`);
  if (mode === "mdy") return normalizedDate(third, first, second);
  if (mode === "dmy") return normalizedDate(third, second, first);
  if (mode === "iso") throw new Error(`date must be YYYY-MM-DD on row ${rowIndex}`);
  if (mode !== "auto") throw new Error("date_format must be auto, iso, mdy, or dmy");
  if (first > 12 && second <= 12) return normalizedDate(third, second, first);
  if (second > 12 && first <= 12) return normalizedDate(third, first, second);
  throw new Error(`Ambiguous date on row ${rowIndex}: ${value}; pass date_format mdy or dmy`);
}

export function qfxTag(block: string, tag: string): string {
  const paired = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i").exec(block)?.[1];
  if (paired != null) return paired.trim();
  return new RegExp(`<${tag}>([^<\\r\\n]*)`, "i").exec(block)?.[1]?.trim() ?? "";
}

export function qfxDate(value: string, index: number): string {
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(value);
  if (!match) throw new Error(`Invalid QFX date on row ${index}`);
  return validateDate(`${match[1]}-${match[2]}-${match[3]}`);
}

export function parseQfx(text: string): Row[] {
  const blocks = [...text.matchAll(/<STMTTRN>([\s\S]*?)(?:<\/STMTTRN>|(?=<STMTTRN>)|<\/BANKTRANLIST>|<\/CCSTMTRS>|$)/gi)].map((match) => match[1]);
  if (blocks.length > MAX_IMPORT_ROWS) throw new Error(`QFX has too many rows; maximum is ${MAX_IMPORT_ROWS}`);
  return blocks.map((block, index) => {
    const amount = Number(qfxTag(block, "TRNAMT"));
    if (!Number.isFinite(amount)) throw new Error(`Invalid QFX amount on row ${index}`);
    const name = qfxTag(block, "NAME");
    const memo = qfxTag(block, "MEMO");
    return {
      index,
      date: qfxDate(qfxTag(block, "DTPOSTED") || qfxTag(block, "DTUSER"), index),
      amount,
      description: name || memo || qfxTag(block, "FITID"),
      external_id: qfxTag(block, "FITID") || null,
      tags: Object.fromEntries([
        ["qfx_fitid", qfxTag(block, "FITID")],
        ["qfx_name", name],
        ["qfx_memo", memo],
        ["qfx_type", qfxTag(block, "TRNTYPE")]
      ].filter(([, value]) => value !== ""))
    };
  });
}

export function parseQfxMetadata(text: string): Row {
  const ledgerBalance = /<LEDGERBAL>([\s\S]*?)<\/LEDGERBAL>/i.exec(text)?.[1] ?? "";
  const availableBalance = /<AVAILBAL>([\s\S]*?)<\/AVAILBAL>/i.exec(text)?.[1] ?? "";
  const block = ledgerBalance || availableBalance;
  if (!block) return {};
  const balance = qfxTag(block, "BALAMT");
  if (!balance) return {};
  const amount = Number(balance);
  if (!Number.isFinite(amount)) return {};
  const asOf = qfxTag(block, "DTASOF");
  return {
    statement_balance: amount,
    statement_balance_date: asOf ? qfxDate(asOf, -1) : null,
    balance_source: ledgerBalance ? "qfx_ledger_balance" : availableBalance ? "qfx_available_balance" : "qfx_balance"
  };
}

export function parseStatementFile(ledger: Ledger, filePath: string, args: Args = {}): { rows: Row[]; file_name: string; file_sha256: string; metadata?: Row } {
  const { path: file, text } = readToolTextFile(ledger.path, filePath, new Set([".csv", ".qfx", ".ofx"]));
  const extension = extname(file).toLowerCase();
  const statementType = String(args.statement_type ?? "").toLowerCase();
  if (extension === ".qfx" || extension === ".ofx" || statementType === "qfx" || statementType === "ofx") {
    return { rows: parseQfx(text), file_name: basename(file), file_sha256: createHash("sha256").update(text).digest("hex"), metadata: parseQfxMetadata(text) };
  }
  const rows = parseCsv(trimCsvWrapperRows(text, Number(args.skip_rows ?? 0), Number(args.skip_footer_rows ?? 0)));
  const dateCol = args.date_col || "date";
  const amountCol = args.amount_col || "amount";
  const descCol = args.desc_col || "description";
  const inflowCol = args.inflow_col;
  const outflowCol = args.outflow_col;
  const counterpartCol = args.counterpart_col;
  const tagCols = args.tag_cols ?? {};
  return { rows: rows.map((row, index) => {
    let amount = amountCol in row ? Number(row[amountCol]) : 0;
    if (inflowCol && row[inflowCol] !== "") amount = Number(row[inflowCol]);
    if (outflowCol && row[outflowCol] !== "") amount = -Math.abs(Number(row[outflowCol]));
    if (args.amount_convention === "unsigned_charges") amount = -Math.abs(amount);
    if (!Number.isFinite(amount)) throw new Error(`Invalid amount on row ${index}`);
    return {
      index,
      date: parseImportDate(String(row[dateCol]), args.date_format, index),
      amount,
      description: String(row[descCol] ?? ""),
      counterpart_ref: counterpartCol ? String(row[counterpartCol] ?? "") : "",
      tags: Object.fromEntries(Object.entries(tagCols).map(([key, col]) => [key, String(row[String(col)] ?? "")]).filter(([, value]) => value !== ""))
    };
  }), file_name: basename(file), file_sha256: createHash("sha256").update(text).digest("hex") };
}

export function parseStatementRows(ledger: Ledger, filePath: string, args: Args = {}): Row[] {
  return parseStatementFile(ledger, filePath, args).rows;
}

export function selectStatementRows(rows: Row[], args: Args = {}): Row[] {
  if (!Array.isArray(args.row_indexes)) return rows;
  const selected = new Set(args.row_indexes.map((index) => Number(index)));
  return rows.filter((row) => selected.has(Number(row.index)));
}

export function importTransactionRows(ledger: Ledger, accountId: string, counterpartId: string, rows: Row[], options: Args = {}) {
  // Statement amounts are signed relative to the statement account: positive
  // amounts debit the account, negative amounts credit it.
  const status = parseTxStatus(options.status ?? "pending") ?? "pending";
  const assetId = options.asset_id ? explicitAsset(ledger, options.asset_id) : options.currency ? asset(ledger, null, options.currency) : accountAsset(ledger, accountId);
  const created: Row[] = [];
  const errors: Row[] = [];
  let skipped = 0;
  const existing = existingImportFingerprints(ledger, accountId, assetId);
  rows.forEach((row, index) => {
    try {
      const rowCounterpart = counterpartForRow(ledger, row, counterpartId);
      if (!rowCounterpart) throw new Error("counterpart_id is required");
      const signed = signedStatementQuantity(ledger, assetId, row, options.amount_convention);
      const fingerprint = importFingerprint(row, signed);
      if (!options.skip_dedup && existing.has(fingerprint)) { skipped += 1; return; }
      const postOptions = {
        sourceId: options.source_id ? String(options.source_id) : null,
        externalId: row.external_id ? String(row.external_id) : null
      };
      const tx = signed >= 0n
        ? ledger.recordTransaction(String(row.date), signed, rowCounterpart, accountId, assetId, String(row.description ?? ""), status, postOptions)
        : ledger.recordTransaction(String(row.date), -signed, accountId, rowCounterpart, assetId, String(row.description ?? ""), status, postOptions);
      for (const [key, value] of Object.entries(row.tags ?? {})) tagTx(ledger, tx.id, key, String(value));
      created.push(txPublic(ledger, tx));
      existing.add(fingerprint);
    } catch (error) {
      errors.push({ index, error: error instanceof Error ? error.message : String(error) });
    }
  });
  return { created: created.length, transactions: created, errors, skipped, dry_run: false };
}

export function signedStatementQuantity(ledger: Ledger, assetId: string, row: Row, amountConvention?: unknown): bigint {
  return statementQuantity(ledger, assetId, row, amountConvention);
}

export function importFingerprint(row: Row, signed: bigint): string {
  return `${row.date}|${signed}|${String(row.description ?? "").toLowerCase()}`;
}

export function existingImportFingerprints(ledger: Ledger, accountId: string, assetId: string): Set<string> {
  return new Set(ledger.listTransactions({ status: null }).filter(isImportDedupeCandidate).map((tx) => {
    const amount = amountForAccount(ledger, tx.id, accountId, assetId);
    return importFingerprint(tx, amount);
  }));
}

export function statementRowHash(row: Row, quantity: bigint): string {
  return createHash("sha256").update(JSON.stringify({
    index: row.index ?? row.row_index ?? null,
    date: row.date,
    quantity: quantity.toString(),
    description: String(row.description ?? "").trim(),
    external_id: row.external_id ?? null
  })).digest("hex");
}

export function signedRowEntries(ledger: Ledger, accountId: string, counterpartId: string, assetId: string, row: Row, status: string, amountConvention?: unknown): Row {
  const signed = signedStatementQuantity(ledger, assetId, row, amountConvention);
  const abs = signed < 0n ? -signed : signed;
  const fromAccountId = signed >= 0n ? counterpartId : accountId;
  const toAccountId = signed >= 0n ? accountId : counterpartId;
  return {
    id: null,
    date: row.date,
    status,
    description: String(row.description ?? ""),
    external_id: row.external_id ?? null,
    amount_cents: abs,
    quantity: signed,
    entries: [
      { account_id: fromAccountId, asset_id: assetId, quantity: -abs, amount_cents: -abs },
      { account_id: toAccountId, asset_id: assetId, quantity: abs, amount_cents: abs }
    ],
    tags: Object.entries(row.tags ?? {}).map(([key, value]) => ({ key, value }))
  };
}

export function counterpartForRow(ledger: Ledger, row: Row, fallback?: string | null): string | null {
  if (row.counterpart_ref) return account(ledger, String(row.counterpart_ref));
  if (row.counterpart_id) return account(ledger, String(row.counterpart_id));
  const matched = ledger.autoCategorize(categorizationText(row));
  if (matched) return matched;
  return fallback ?? null;
}

export function importPreview(ledger: Ledger, accountId: string, counterpartId: string | null, rows: Row[], options: Args = {}): Row {
  const status = parseTxStatus(options.status ?? "pending") ?? "pending";
  const assetId = options.asset_id ? explicitAsset(ledger, options.asset_id) : options.currency ? asset(ledger, null, options.currency) : accountAsset(ledger, accountId);
  const existing = existingImportFingerprints(ledger, accountId, assetId);
  const transactions: Row[] = [];
  const duplicates: Row[] = [];
  const errors: Row[] = [];
  let balanceImpact = 0n;
  rows.forEach((row, index) => {
    try {
      const rowCounterpart = counterpartForRow(ledger, row, counterpartId);
      if (!rowCounterpart) throw new Error("counterpart_id is required");
      const signed = signedStatementQuantity(ledger, assetId, row, options.amount_convention);
      const fingerprint = importFingerprint(row, signed);
      if (!options.skip_dedup && existing.has(fingerprint)) {
        duplicates.push({ index, row_index: row.index ?? index, fingerprint, date: row.date, quantity: signed, description: row.description });
        return;
      }
      existing.add(fingerprint);
      balanceImpact += signed;
      transactions.push({
        ...signedRowEntries(ledger, accountId, rowCounterpart, assetId, row, status, options.amount_convention),
        row_index: row.index ?? index,
        counterpart_account_id: rowCounterpart,
        would_create: true
      });
    } catch (error) {
      errors.push({ index, row_index: row.index ?? index, error: error instanceof Error ? error.message : String(error) });
    }
  });
  return {
    created: 0,
    imported: 0,
    skipped: duplicates.length,
    would_create: transactions.length,
    transactions,
    duplicates,
    errors,
    dry_run: true,
    batch_id: null,
    batch_label: options.batch_label ?? null,
    balance_impact_cents: balanceImpact,
    transfer_stats: { matched: 0, unmatched: 0 }
  };
}

export function statementCandidates(ledger: Ledger, accountId: string, assetId: string, row: Row, quantity: bigint, tolerance: number): Journal[] {
  const rows = ledger.listTransactions({ status: null })
    .filter(isStatementMatchCandidate)
    .filter((tx) => amountForAccount(ledger, tx.id, accountId, assetId) === quantity);
  if (row.external_id) {
    const external = rows.filter((tx) => tx.external_id === String(row.external_id));
    if (external.length > 0) return external;
  }
  const dated = rows.filter((tx) => dateDeltaDays(tx.date, String(row.date)) <= tolerance);
  if (dated.length <= 1) return dated;
  const description = String(row.description ?? "").trim().toLowerCase();
  const sameDescription = dated.filter((tx) => tx.description.trim().toLowerCase() === description);
  return sameDescription.length === 1 ? sameDescription : dated;
}

export function statementCandidateSummary(ledger: Ledger, accountId: string, assetId: string, row: Row, quantity: bigint, tolerance: number, tx: Journal): Row {
  const matchedQuantity = amountForAccount(ledger, tx.id, accountId, assetId);
  const date_delta_days = dateDeltaDays(tx.date, String(row.date));
  const sameDescription = tx.description.trim().toLowerCase() === String(row.description ?? "").trim().toLowerCase();
  const externalMatch = row.external_id != null && row.external_id !== "" && tx.external_id === String(row.external_id);
  const reasons = [
    matchedQuantity === quantity ? "amount" : null,
    date_delta_days <= tolerance ? "date_tolerance" : null,
    sameDescription ? "description" : null,
    externalMatch ? "external_id" : null
  ].filter(Boolean);
  const score = (matchedQuantity === quantity ? 60 : 0) + (date_delta_days <= tolerance ? 20 : 0) + (sameDescription ? 15 : 0) + (externalMatch ? 25 : 0);
  return {
    journal_id: tx.id,
    date: tx.date,
    description: tx.description,
    status: tx.status,
    external_id: tx.external_id ?? null,
    amount_cents: matchedQuantity,
    date_delta_days,
    score,
    reasons
  };
}

export function planRow(row: Row, action: string, quantity: bigint, counterpartId: string | null, reason: string, matchedId?: string | null, extraMetadata: Row = {}): Row {
  return {
    row_index: Number(row.index ?? row.row_index ?? 0),
    date: row.date,
    quantity,
    description: String(row.description ?? ""),
    external_id: row.external_id ?? null,
    row_hash: statementRowHash(row, quantity),
    action,
    matched_journal_id: matchedId ?? null,
    counterpart_account_id: counterpartId,
    reason,
    metadata: {
      amount: row.amount ?? null,
      tags: row.tags ?? {},
      source_row: row,
      ...extraMetadata
    }
  };
}

export function userFacingLiabilityBalance(args: Args): boolean {
  const statementType = String(args.statement_type ?? "").toLowerCase().replace(/[\s_-]+/g, "");
  const balanceSign = String(args.balance_sign ?? args.balance_basis ?? "").toLowerCase().replace(/[\s_-]+/g, "");
  return ["creditcard", "cardstatement", "liabilitystatement"].includes(statementType) || ["statement", "userfacing", "positive", "liability"].includes(balanceSign);
}

export function expectedStatementBalance(ledger: Ledger, accountId: string, assetId: string, args: Args): bigint | null {
  if (args.expected_balance == null) return null;
  let expected = signedMoneyAmount(ledger, assetId, args.expected_balance, "Expected balance");
  const accountRow = ledger.getAccount(accountId);
  if (accountRow?.account_type === "liability" && expected > 0n && userFacingLiabilityBalance(args)) expected = -expected;
  return expected;
}

export function statementBalanceFields(ledger: Ledger, assetId: string, statementFile: Row, accountId?: string | null): Row {
  const metadata = safeJson(statementFile.metadata);
  if (metadata.statement_balance == null || !Number.isFinite(Number(metadata.statement_balance))) return {};
  const raw = signedMoneyAmount(ledger, assetId, Number(metadata.statement_balance), "Statement balance");
  const accountRow = accountId ? ledger.getAccount(accountId) : null;
  const ledgerNormalized = accountRow?.account_type === "liability" && raw > 0n ? -raw : raw;
  return {
    statement_balance_cents: raw,
    statement_balance_raw_cents: raw,
    statement_balance_ledger_cents: ledgerNormalized,
    statement_balance_date: metadata.statement_balance_date ?? null,
    balance_source: metadata.balance_source ?? "statement_balance"
  };
}

export function buildStatementPlan(ledger: Ledger, args: Args, options: { persist?: boolean; targetStatus?: TxStatus | string; rows?: Row[]; file?: Row } = {}): Row {
  const statementFile = options.file ?? (args.file_path ? parseStatementFile(ledger, args.file_path, args) : { rows: args.transactions ?? [], file_name: "", file_sha256: "" });
  const selectedRows = selectStatementRows(options.rows ?? statementFile.rows, args);
  const accountId = account(ledger, args.account_id);
  const assetId = args.asset_id ? explicitAsset(ledger, args.asset_id) : args.currency ? asset(ledger, null, args.currency) : accountAsset(ledger, accountId);
  const targetStatus = parseTxStatus(String(options.targetStatus ?? args.status ?? "posted")) ?? "posted";
  const counterpartId = args.counterpart_account_id || args.counterpart_id ? account(ledger, args.counterpart_account_id ?? args.counterpart_id) : null;
  const tolerance = Number(args.date_tolerance_days ?? 3);
  const planRows: Row[] = [];
  let plannedDelta = 0n;

  for (const row of selectedRows) {
    const quantity = signedStatementQuantity(ledger, assetId, row, args.amount_convention);
    const rowCounterpart = counterpartForRow(ledger, row, counterpartId);
    const candidates = statementCandidates(ledger, accountId, assetId, row, quantity, tolerance);
    if (candidates.length === 1) {
      const matched = candidates[0];
      if (matched.status === "pending" && targetStatus === "posted") {
        planRows.push(planRow(row, "pending_to_commit", quantity, rowCounterpart, "matched pending transaction", matched.id));
        plannedDelta += quantity;
      } else {
        planRows.push(planRow(row, "matched", quantity, rowCounterpart, "matched existing transaction", matched.id));
      }
    } else if (candidates.length > 1) {
      planRows.push(planRow(row, "ambiguous", quantity, rowCounterpart, "multiple matching transactions", null, {
        candidates: candidates.map((tx) => statementCandidateSummary(ledger, accountId, assetId, row, quantity, tolerance, tx))
      }));
    } else if (!rowCounterpart) {
      planRows.push(planRow(row, "ambiguous", quantity, null, "counterpart account could not be resolved", null));
    } else if (targetStatus === "pending") {
      planRows.push(planRow(row, "new_pending", quantity, rowCounterpart, "new pending transaction", null));
      plannedDelta += quantity;
    } else {
      planRows.push(planRow(row, "new_posted", quantity, rowCounterpart, "new posted transaction", null));
      plannedDelta += quantity;
    }
  }

  const usedPending = new Set(planRows.filter((row) => row.action === "pending_to_commit").map((row) => String(row.matched_journal_id)));
  const syntheticStart = selectedRows.reduce((max, row) => Math.max(max, Number(row.index ?? 0)), -1) + 1;
  for (const [offset, row] of ((args.pending_transactions ?? []) as Row[]).entries()) {
    const pendingRow = { ...row, index: syntheticStart + offset, date: parseImportDate(String(row.date), args.date_format, syntheticStart + offset) };
    const quantity = signedStatementQuantity(ledger, assetId, pendingRow, "unsigned_charges");
    const pendingFallback = args.counterpart_id || args.counterpart_account_id
      ? account(ledger, args.counterpart_id ?? args.counterpart_account_id)
      : ledger.findAccount("Pending Expenses")?.id ?? null;
    const rowCounterpart = counterpartForRow(ledger, pendingRow, pendingFallback);
    planRows.push(planRow(pendingRow, rowCounterpart ? "new_pending" : "ambiguous", quantity, rowCounterpart, rowCounterpart ? "new pending transaction" : "counterpart account could not be resolved", null));
    if (targetStatus === "pending" && rowCounterpart) plannedDelta += quantity;
  }

  if (args.void_stale_pending === true) {
    const dateValues = selectedRows.map((row) => String(row.date)).sort();
    const dateFrom = args.date_from ?? dateValues[0] ?? null;
    const dateTo = args.date_to ?? dateValues.at(-1) ?? null;
    let staleIndex = syntheticStart + ((args.pending_transactions ?? []) as Row[]).length;
    for (const tx of ledger.listTransactions({ status: "pending", dateFrom, dateTo })) {
      if (usedPending.has(tx.id)) continue;
      const quantity = amountForAccount(ledger, tx.id, accountId, assetId);
      if (quantity === 0n) continue;
      planRows.push(planRow({ index: staleIndex++, date: tx.date, description: tx.description, external_id: tx.external_id }, "stale_pending_to_void", quantity, null, "pending transaction not present in refreshed statement", tx.id));
    }
  }

  const selectedDates = selectedRows.map((row) => String(row.date)).sort();
  const realizedDateFrom = args.date_from ?? (selectedDates[0] ? addDays(selectedDates[0], -tolerance) : null);
  const realizedDateTo = args.date_to ?? (selectedDates.at(-1) ? addDays(String(selectedDates.at(-1)), tolerance) : null);
  const realizedPlanned = realizedPlannedRows(ledger, {
    account_id: accountId,
    asset_id: assetId,
    date_from: realizedDateFrom,
    date_to: realizedDateTo,
    date_tolerance_days: tolerance
  });
  const baseStatus = targetStatus === "pending" ? "active" : "posted";
  const plannedBalance = ledger.balanceTree(accountId, assetId, null, baseStatus) + plannedDelta;
  const expected = expectedStatementBalance(ledger, accountId, assetId, args);
  const balanceMatches = expected == null ? null : expected === plannedBalance;
  if (expected != null && !balanceMatches && args.require_balance_match !== false) throw new Error(`expected_balance mismatch: expected ${expected}, actual ${plannedBalance}`);
  const metadata = {
    target_status: targetStatus,
    amount_convention: args.amount_convention ?? "signed",
    date_tolerance_days: tolerance,
    void_stale_pending: args.void_stale_pending === true,
    statement_type: args.statement_type ?? null
  };
  const persisted = options.persist ? ledger.createStatementPlan({
    account_id: accountId,
    asset_id: assetId,
    statement_kind: args.statement_type ?? "statement",
    file_name: statementFile.file_name,
    file_sha256: statementFile.file_sha256,
    expected_balance: expected,
    planned_balance: plannedBalance,
    metadata
  }, planRows) : null;
  const persistedRows = persisted ? ledger.listStatementPlanRows(String(persisted.id)) : planRows;
  return statementPlanOutput(persisted, persistedRows, {
    account_id: accountId,
    asset_id: assetId,
    expected_balance_cents: expected,
    planned_balance_cents: plannedBalance,
    balance_matches: balanceMatches,
    balance_sign: userFacingLiabilityBalance(args) ? "user_facing_liability" : "ledger",
    sample_limit: args.sample_limit ?? args.preview_rows ?? 20,
    include_details: args.include_details,
    verbosity: args.verbosity,
    dry_run: !options.persist,
    realized_planned_rows: realizedPlanned,
    metadata,
    ...statementBalanceFields(ledger, assetId, statementFile, accountId)
  });
}

export function applyStatementPlan(ledger: Ledger, planId: string, args: Args = {}): Row {
  const plan = ledger.getStatementPlan(planId);
  if (!plan) throw new Error(`Statement plan '${planId}' not found`);
  if (String(plan.status) !== "planned") throw new Error(`Statement plan '${planId}' is ${String(plan.status)}`);
  const rows = publicPlanRows(ledger.listStatementPlanRows(planId));
  if (rows.some((row) => row.action === "ambiguous")) throw new Error("Statement plan has ambiguous rows; resolve them before applying");
  const accountId = String(plan.account_id);
  const assetId = String(plan.asset_id);
  const metadata = safeJson(plan.metadata_json);
  const targetStatus = String(metadata.target_status ?? "posted");
  const effectiveRows = rows.filter((row) => ["pending_to_commit", "new_posted", "new_pending", "stale_pending_to_void"].includes(String(row.action)));
  if (args.dry_run !== false) {
    return statementPlanOutput(plan, rows, { dry_run: true, would_apply: effectiveRows.length, sample_limit: args.sample_limit ?? 20, include_details: args.include_details, verbosity: args.verbosity });
  }
  let created = 0;
  let committed = 0;
  let voided = 0;
  const createdTransactions: Row[] = [];
  const includeDetails = statementDetailMode(args);
  const sourceId = ledger.runInTransaction(() => {
    const batchId = batch(ledger, args.batch_label ?? `Statement plan ${planId}`, { statement_plan_id: planId, statement_type: plan.statement_kind }, targetStatus === "posted" ? "posted_import" : "pending_import");
    for (const row of rows) {
      if (row.action === "matched" || row.action === "ignored") continue;
      if (row.action === "pending_to_commit") {
        const tx = ledger.getTx(String(row.matched_journal_id));
        if (!tx || tx.status !== "pending") throw new Error(`Matched pending transaction '${String(row.matched_journal_id)}' changed before apply`);
        if (amountForAccount(ledger, tx.id, accountId, assetId) !== BigInt(row.quantity)) throw new Error(`Matched pending transaction '${tx.id}' amount changed before apply`);
        ledger.updateTxStatus(tx.id, "posted");
        ledger.updateTransactionSource(tx.id, batchId);
        tagTx(ledger, tx.id, "statement_plan", planId);
        committed += 1;
      } else if (row.action === "stale_pending_to_void") {
        const tx = ledger.getTx(String(row.matched_journal_id));
        if (!tx || tx.status !== "pending") throw new Error(`Stale pending transaction '${String(row.matched_journal_id)}' changed before apply`);
        ledger.voidTx(tx.id);
        tagTx(ledger, tx.id, "statement_plan", planId);
        voided += 1;
      } else if (row.action === "new_posted" || row.action === "new_pending") {
        const counterpartId = row.counterpart_account_id ? String(row.counterpart_account_id) : null;
        if (!counterpartId) throw new Error(`Plan row ${String(row.id)} has no counterpart account`);
        const status = row.action === "new_posted" ? "posted" : "pending";
        const quantity = BigInt(row.quantity);
        const tx = quantity >= 0n
          ? ledger.recordTransaction(String(row.date), quantity, counterpartId, accountId, assetId, String(row.description ?? ""), status, { sourceId: batchId, externalId: row.external_id ? String(row.external_id) : null })
          : ledger.recordTransaction(String(row.date), -quantity, accountId, counterpartId, assetId, String(row.description ?? ""), status, { sourceId: batchId, externalId: row.external_id ? String(row.external_id) : null });
        ledger.setStatementPlanRowCreatedJournal(String(row.id), tx.id);
        tagTx(ledger, tx.id, "import_batch", batchId);
        tagTx(ledger, tx.id, "statement_plan", planId);
        for (const [key, value] of Object.entries(safeJson(row.metadata).tags ?? {})) tagTx(ledger, tx.id, key, String(value));
        createdTransactions.push(txPublic(ledger, ledger.getTx(tx.id)!));
        created += 1;
      }
    }
    ledger.markStatementPlanApplied(planId, batchId, ledger.balanceTree(accountId, assetId, null, targetStatus === "pending" ? "pending" : "posted"));
    return batchId;
  });
  const appliedPlan = ledger.getStatementPlan(planId)!;
  const appliedRows = ledger.listStatementPlanRows(planId);
  return {
    ...statementPlanOutput(appliedPlan, appliedRows, { dry_run: false, sample_limit: args.sample_limit ?? 20, include_details: args.include_details, verbosity: args.verbosity }),
    batch_id: sourceId,
    created,
    committed,
    voided,
    skipped: appliedRows.filter((row) => row.action === "matched").length,
    imported: created,
    ...(includeDetails ? { transactions: createdTransactions } : {}),
    balance_matches: appliedPlan.expected_balance == null ? null : BigInt(appliedPlan.expected_balance as string | number | bigint | boolean) === BigInt(appliedPlan.applied_balance as string | number | bigint | boolean),
    actual_balance_cents: appliedPlan.applied_balance
  };
}

export function verifyStatementPlan(ledger: Ledger, planId: string): Row {
  const plan = ledger.getStatementPlan(planId);
  if (!plan) throw new Error(`Statement plan '${planId}' not found`);
  const rows = publicPlanRows(ledger.listStatementPlanRows(planId));
  const mismatches: Row[] = [];
  for (const row of rows) {
    const txId = row.created_journal_id ?? row.matched_journal_id;
    if (!txId || ["new_posted", "new_pending", "pending_to_commit", "stale_pending_to_void", "matched"].includes(String(row.action)) === false) continue;
    const tx = ledger.getTx(String(txId));
    if (!tx) mismatches.push({ row_id: row.id, tx_id: txId, error: "transaction missing" });
    else if (row.action === "stale_pending_to_void" && tx.status !== "void") mismatches.push({ row_id: row.id, tx_id: txId, error: `expected void, got ${tx.status}` });
    else if (row.action === "pending_to_commit" && tx.status !== "posted") mismatches.push({ row_id: row.id, tx_id: txId, error: `expected posted, got ${tx.status}` });
    else if (row.action === "new_posted" && tx.status !== "posted") mismatches.push({ row_id: row.id, tx_id: txId, error: `expected posted, got ${tx.status}` });
    else if (row.action === "new_pending" && tx.status !== "pending") mismatches.push({ row_id: row.id, tx_id: txId, error: `expected pending, got ${tx.status}` });
    else if (row.action !== "stale_pending_to_void" && amountForAccount(ledger, tx.id, String(plan.account_id), String(plan.asset_id)) !== BigInt(row.quantity)) mismatches.push({ row_id: row.id, tx_id: txId, error: "quantity changed" });
  }
  return { ...statementPlanOutput(plan, rows, { dry_run: false }), verified: mismatches.length === 0, mismatches };
}
