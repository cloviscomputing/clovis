import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { JournalLine, TxStatus } from "./types.js";

type TransactionRow = {
  id: string;
  date: string;
  description: string;
};

type LedgerCsvExportPort = {
  listTransactions(options: { status?: TxStatus | string | null; dateFrom?: string | null; dateTo?: string | null }): TransactionRow[];
  getEntries(txId: string): JournalLine[];
};

export function exportTransactionsCsv(
  ledger: LedgerCsvExportPort,
  outputPath: string | null | undefined,
  options: { accountId?: string | null; dateFrom?: string | null; dateTo?: string | null; status?: TxStatus | string | null } = {}
): { exported: number; csv: string | null; file: string | null } {
  const rows = ["date,description,amount,account_id,tx_id"];
  const status = options.status == null ? "all" : options.status;
  for (const tx of ledger.listTransactions({ status, dateFrom: options.dateFrom, dateTo: options.dateTo })) {
    for (const entry of ledger.getEntries(tx.id).filter((line) => !options.accountId || line.account_id === options.accountId)) {
      const desc = `"${tx.description.replaceAll('"', '""')}"`;
      rows.push(`${tx.date},${desc},${entry.quantity.toString()},${entry.account_id},${tx.id}`);
    }
  }
  const csv = `${rows.join("\n")}\n`;
  if (outputPath) {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, csv, "utf8");
    return { exported: rows.length - 1, csv: null, file: outputPath };
  }
  return { exported: rows.length - 1, csv, file: null };
}
