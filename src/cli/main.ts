#!/usr/bin/env node
// Thin human-facing wrapper over the shared app catalog. The CLI should not
// own bookkeeping behavior; it only maps flags to tool calls and formats output.
import { Command } from "commander";
import { openLedger } from "../app/context.js";
import { callTool } from "../app/catalog.js";
import { stringifyPublic, publicize } from "../app/json.js";
import type { Ledger } from "../core/ledger.js";
import { VERSION } from "../version.js";

type GlobalOptions = { format?: "json" | "table"; db?: string };

function withLedger(program: Command, fn: (ledger: Ledger, format: "json" | "table") => unknown): void {
  const opts = program.optsWithGlobals<GlobalOptions>();
  const format = opts.format ?? (process.stdout.isTTY ? "table" : "json");
  const ledger = openLedger(opts.db);
  try {
    const result = fn(ledger, format);
    output(result, format);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    ledger.close();
  }
}

function output(value: unknown, format: "json" | "table"): void {
  const json = publicize(value);
  const envelope = Array.isArray(json)
    ? { ok: true, data: json, count: json.length }
    : { ok: true, data: json };
  if (format === "json") {
    console.log(stringifyPublic(envelope));
    return;
  }
  if (Array.isArray(json)) {
    console.table(json);
    return;
  }
  if (json && typeof json === "object") {
    console.log(stringifyPublic(json));
    return;
  }
  console.log(String(json));
}

function addCommon(program: Command): Command {
  return program
    .option("--format <format>", "Output format: json or table")
    .option("--db <path>", "Path to ledger database", process.env.CLOVIS_DB);
}

const program = addCommon(new Command())
  .name("clovis")
  .description("Local-first bookkeeping CLI")
  .version(VERSION);

const account = program.command("account").description("Manage accounts");
account.command("add")
  .requiredOption("--name <name>")
  .requiredOption("--type <type>")
  .option("--code <code>", "", "")
  .option("--parent <id>", "Parent account id")
  .option("--color <hex>", "Account color", "#888888")
  .action((opts) => withLedger(program, (ledger) => callTool("create_account", { name: opts.name, type: opts.type, code: opts.code, parent_id: opts.parent, color_hex: opts.color }, ledger)));
account.command("list")
  .option("--type <type>")
  .option("--parent <id>")
  .option("--tree")
  .action((opts) => withLedger(program, (ledger) => callTool("list_accounts", { type: opts.type, parent_id: opts.parent, tree: Boolean(opts.tree) }, ledger)));
account.command("get").argument("<id>").action((idValue) => withLedger(program, (ledger) => callTool("get_account", { id: idValue }, ledger)));
account.command("update")
  .argument("<id>")
  .option("--name <name>")
  .option("--type <type>")
  .option("--code <code>")
  .option("--parent <id>")
  .option("--color <hex>")
  .action((idValue, opts) => withLedger(program, (ledger) => callTool("update_account", { id: idValue, name: opts.name, type: opts.type, code: opts.code, parent_id: opts.parent, color_hex: opts.color }, ledger)));
account.command("delete").argument("<id>").action((idValue) => withLedger(program, (ledger) => callTool("delete_account", { id: idValue }, ledger)));

const txn = program.command("txn").description("Manage transactions");
txn.command("add")
  .requiredOption("--date <date>")
  .requiredOption("--amount <amount>")
  .requiredOption("--from <id>")
  .requiredOption("--to <id>")
  .option("--desc <description>", "", "")
  .option("--status <status>", "", "pending")
  .option("--asset <id>")
  .action((opts) => withLedger(program, (ledger) => callTool("create_transaction", { date: opts.date, amount: opts.amount, from_account_id: opts.from, to_account_id: opts.to, description: opts.desc, status: opts.status, asset_id: opts.asset }, ledger)));
txn.command("transfer")
  .requiredOption("--from <id>")
  .requiredOption("--to <id>")
  .requiredOption("--amount <amount>")
  .requiredOption("--date <date>")
  .option("--desc <description>", "", "Transfer")
  .option("--asset <id>")
  .action((opts) => withLedger(program, (ledger) => callTool("transfer", { from_account_id: opts.from, to_account_id: opts.to, amount: opts.amount, date: opts.date, description: opts.desc, asset_id: opts.asset }, ledger)));
txn.command("journal")
  .requiredOption("--date <date>")
  .requiredOption("--leg <leg...>", "account_id:amount")
  .option("--desc <description>", "", "")
  .option("--status <status>", "", "pending")
  .option("--asset <id>")
  .action((opts) => withLedger(program, (ledger) => callTool("post_journal_entry", { date: opts.date, description: opts.desc, status: opts.status, asset_id: opts.asset, legs: opts.leg.map((leg: string) => { const [accountId, amount] = leg.split(":"); return { account_id: accountId, amount }; }) }, ledger)));
txn.command("opening-balance")
  .requiredOption("--account <id>")
  .requiredOption("--amount <amount>")
  .requiredOption("--date <date>")
  .option("--status <status>", "", "pending")
  .option("--asset <id>")
  .option("--counterpart <id>")
  .action((opts) => withLedger(program, (ledger) => callTool("record_opening_balance", { account_id: opts.account, amount: opts.amount, date: opts.date, status: opts.status, asset_id: opts.asset, counterpart_account_id: opts.counterpart }, ledger)));
txn.command("list")
  .option("--account <id>")
  .option("--year <year>")
  .option("--month <month>")
  .option("--status <status>")
  .option("--desc <desc>")
  .option("--limit <n>", "", "50")
  .action((opts) => withLedger(program, (ledger) => callTool("list_transactions", { account_id: opts.account, year: opts.year ? Number(opts.year) : undefined, month: opts.month ? Number(opts.month) : undefined, status: opts.status, desc: opts.desc, limit: Number(opts.limit), compact: false }, ledger)));
txn.command("get").argument("<id>").action((idValue) => withLedger(program, (ledger) => callTool("get_transaction", { id: idValue }, ledger)));
txn.command("delete").argument("<id>").option("--hard").action((idValue, opts) => withLedger(program, (ledger) => callTool("delete_transaction", { id: idValue, hard_delete: Boolean(opts.hard) }, ledger)));
txn.command("entries").argument("<tx_id>").action((txId) => withLedger(program, (ledger) => callTool("list_entries", { tx_id: txId }, ledger)));
txn.command("recategorize").argument("<tx_id>").requiredOption("--from <id>").requiredOption("--to <id>").action((txId, opts) => withLedger(program, (ledger) => callTool("recategorize_transaction", { tx_id: txId, old_account_id: opts.from, new_account_id: opts.to }, ledger)));

program.command("balance").argument("<account_id>").action((accountId) => withLedger(program, (ledger) => callTool("get_balance", { account_id: accountId }, ledger)));

program.command("init")
  .option("--template <template>", "", "personal")
  .requiredOption("--currency <symbol>")
  .action((opts) => withLedger(program, (ledger) => callTool("init_defaults", { template: opts.template, currency: opts.currency }, ledger)));

program.command("export")
  .option("--account <id>")
  .option("--from <date>")
  .option("--to <date>")
  .option("--output <path>")
  .action((opts) => withLedger(program, (ledger) => callTool("export_transactions", { account_id: opts.account, date_from: opts.from, date_to: opts.to, output_path: opts.output }, ledger)));

program.command("import")
  .requiredOption("--file <path>")
  .requiredOption("--account <id>")
  .requiredOption("--counterpart <id>")
  .option("--currency <symbol>")
  .option("--status <status>", "", "posted")
  .action((opts) => withLedger(program, (ledger) => callTool("import_file", { file_path: opts.file, account_id: opts.account, counterpart_account_id: opts.counterpart, currency: opts.currency, status: opts.status }, ledger)));

const report = program.command("report").description("Reports");
report.command("income-statement").requiredOption("--year <year>").option("--month <month>").requiredOption("--quote <asset>").action((opts) => withLedger(program, (ledger) => callTool("income_statement", { year: Number(opts.year), month: opts.month ? Number(opts.month) : undefined, quote_asset_id: opts.quote }, ledger)));
report.command("balance-sheet").option("--date <date>").requiredOption("--quote <asset>").action((opts) => withLedger(program, (ledger) => callTool("balance_sheet", { date: opts.date, quote_asset_id: opts.quote }, ledger)));
report.command("net-worth").option("--date <date>").requiredOption("--quote <asset>").action((opts) => withLedger(program, (ledger) => callTool("net_worth", { date: opts.date, quote_asset_id: opts.quote }, ledger)));
report.command("spending").requiredOption("--year <year>").requiredOption("--month <month>").requiredOption("--quote <asset>").action((opts) => withLedger(program, (ledger) => callTool("spending", { year: Number(opts.year), month: Number(opts.month), quote_asset_id: opts.quote }, ledger)));
report.command("cash-flow").requiredOption("--year <year>").requiredOption("--month <month>").requiredOption("--quote <asset>").action((opts) => withLedger(program, (ledger) => callTool("cash_flow", { year: Number(opts.year), month: Number(opts.month), quote_asset_id: opts.quote }, ledger)));
report.command("register").requiredOption("--account <id>").option("--asset <id>").option("--from <date>").option("--to <date>").option("--status <status>").action((opts) => withLedger(program, (ledger) => callTool("account_register", { account_id: opts.account, asset_id: opts.asset, date_from: opts.from, date_to: opts.to, status: opts.status }, ledger)));
report.command("trial-balance").requiredOption("--asset <id>").option("--status <status>").action((opts) => withLedger(program, (ledger) => callTool("trial_balance", { asset_id: opts.asset, status: opts.status }, ledger)));

program.parseAsync();
