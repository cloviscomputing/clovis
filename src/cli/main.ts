#!/usr/bin/env node
// Thin human-facing wrapper over the shared app catalog. The CLI should not
// own bookkeeping behavior; it only maps flags to tool calls and formats output.
import { readFileSync } from "node:fs";
import { Command, Option } from "commander";
import { defaultDbPath, openLedger } from "../app/context.js";
import { callTool, TOOL_NAMES } from "../app/catalog.js";
import { stringifyPublic, publicize } from "../app/json.js";
import { TOOL_SIGNATURES, type ToolSignatureName } from "../app/signatures.js";
import type { Ledger } from "../core/ledger.js";
import { parseToolInput } from "../mcp/tools.js";
import { VERSION } from "../version.js";

type GlobalOptions = { format?: "json" | "table"; db?: string };
type ToolOptions = { json?: string; stdin?: boolean; allowDestructive?: boolean; allowAll?: boolean };

const STATUS_HELP = "Transaction status: posted, pending, planned, or void";
const STATUS_FILTER_HELP = "Transaction status filter: posted, pending, planned, void, active, combined, or all";

function helpBlock(title: string, lines: string[]): string {
  return `\n${title}:\n${lines.map((line) => `  ${line}`).join("\n")}`;
}

function examples(lines: string[]): string {
  return helpBlock("Examples", lines);
}

function notes(lines: string[]): string {
  return helpBlock("Notes", lines);
}

function withLedger(program: Command, fn: (ledger: Ledger, format: "json" | "table") => unknown): void {
  const opts = program.optsWithGlobals<GlobalOptions>();
  const format = opts.format ?? (process.stdout.isTTY ? "table" : "json");
  let ledger: Ledger | null = null;
  try {
    ledger = openLedger(opts.db);
    const result = fn(ledger, format);
    output(result, format);
  } catch (error) {
    outputError(error, format);
  } finally {
    ledger?.close();
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

function outputError(error: unknown, format: "json" | "table"): void {
  const message = error instanceof Error ? error.message : String(error);
  if (format === "json") console.log(stringifyPublic({ ok: false, error: message }));
  else console.error(message);
  process.exitCode = 1;
}

function withOutput(program: Command, fn: (format: "json" | "table") => unknown): void {
  const opts = program.optsWithGlobals<GlobalOptions>();
  const format = opts.format ?? (process.stdout.isTTY ? "table" : "json");
  try {
    output(fn(format), format);
  } catch (error) {
    outputError(error, format);
  }
}

function runReadOnlyDoctor(ledger: Ledger, quote?: string | null): Record<string, unknown> {
  const checks: Array<Record<string, unknown>> = [];
  const check = (name: string, fn: () => unknown): void => {
    try {
      checks.push({ name, ok: true, result: fn() });
    } catch (error) {
      checks.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  check("tool_registry", () => {
    const registry = callTool("tool_registry", {}, ledger) as any;
    if (registry.count !== TOOL_NAMES.length) throw new Error(`expected ${TOOL_NAMES.length} tools, got ${registry.count}`);
    return { count: registry.count };
  });

  check("status_all", () => {
    const all = callTool("count_transactions", { status: "all" }, ledger) as any;
    const explicitNull = callTool("count_transactions", { status: null }, ledger) as any;
    if (all.count !== explicitNull.count) throw new Error(`status all/null mismatch: ${all.count} != ${explicitNull.count}`);
    return { count: all.count, by_status: all.by_status };
  });

  check("list_transactions_all", () => {
    const result = callTool("list_transactions", { status: "all", limit: 10, compact: true }, ledger) as any;
    if ((result.transactions ?? []).some((tx: any) => tx.status === "void")) throw new Error("status all returned void transactions");
    return { total: result.total, sampled: result.transactions.length };
  });

  check("export_filters", () => {
    const sample = callTool("list_transactions", { status: "all", limit: 1, compact: false, sort: "date_asc" }, ledger) as any;
    const tx = sample.transactions?.[0];
    if (!tx) return { skipped: "ledger has no visible transactions" };
    const entry = tx.entries?.[0];
    if (!entry) return { skipped: "sample transaction has no entries" };
    const exported = callTool("export_transactions", { account_id: entry.account_id, date_from: tx.date, date_to: tx.date, status: "all" }, ledger) as any;
    const lines = String(exported.csv ?? "").trim().split(/\r?\n/).slice(1).filter(Boolean);
    for (const line of lines) {
      const cells = line.match(/(?:^|,)(?:"(?:[^"]|"")*"|[^,]*)/g)?.map((cell) => cell.replace(/^,/, "").replace(/^"|"$/g, "").replaceAll('""', '"')) ?? [];
      if (cells[0] !== tx.date) throw new Error(`export date filter leaked ${cells[0]}`);
      if (cells[3] !== entry.account_id) throw new Error(`export account filter leaked ${cells[3]}`);
    }
    return { exported: exported.exported, sample_tx: tx.id };
  });

  check("integrity_check", () => {
    const result = callTool("integrity_check", {}, ledger) as any;
    if (!result.ok) throw new Error("ledger integrity check failed");
    return { ok: result.ok };
  });

  if (quote) {
    check("quote_reports", () => {
      const now = new Date();
      const year = now.getUTCFullYear();
      const month = now.getUTCMonth() + 1;
      const balanceSheet = callTool("balance_sheet", { quote_asset_id: quote, status: "all" }, ledger) as any;
      const cashFlow = callTool("cash_flow", { year, month, quote_asset_id: quote, status: "all" }, ledger) as any;
      return { quote_asset_id: balanceSheet.quote_asset_id ?? quote, cash_flow_month: cashFlow.month };
    });
  }

  return { ok: checks.every((row) => row.ok), checks };
}

function addCommon(program: Command): Command {
  return program
    .option("--format <format>", "Output format: json or table")
    .option("--db <path>", "Path to ledger database", process.env.CLOVIS_DB);
}

const program = addCommon(new Command())
  .name("clovis")
  .description("Local-first bookkeeping CLI")
  .version(VERSION)
  .showHelpAfterError()
  .addHelpText("after", [
    examples([
      "clovis init --currency CAD",
      "clovis account balances --type asset",
      "clovis txn add --date 2026-06-01 --amount 100 --from <equity-id> --to <checking-id> --status posted",
      "clovis report balance-sheet --quote CAD",
      "clovis tool account_balances --json '{\"account_type\":\"asset\"}'"
    ]),
    notes([
      `Default ledger: ${defaultDbPath()}`,
      "Use --db or CLOVIS_DB to select another ledger.",
      "Use --format json for stable machine-readable output.",
      "Clovis does not infer report currency; report commands require --quote."
    ])
  ].join("\n"));

function parseToolArgs(opts: ToolOptions): Record<string, unknown> {
  if (opts.json && opts.stdin) throw new Error("Use either --json or --stdin, not both");
  const text = opts.stdin ? readFileSync(0, "utf8") : opts.json ?? "{}";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Tool args must be a JSON object");
  return parsed as Record<string, unknown>;
}

function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function scopeArgs(opts: { account?: string[]; entity?: string; parent?: string }): Record<string, unknown> {
  if (opts.entity && opts.parent && opts.entity !== opts.parent) throw new Error("Use either --entity or --parent, not both");
  const accountIds = Array.isArray(opts.account) ? opts.account : [];
  return {
    ...(accountIds.length > 0 ? { account_ids: accountIds } : {}),
    ...(opts.entity || opts.parent ? { entity_id: opts.entity ?? opts.parent } : {})
  };
}

function hasScope(args: Record<string, unknown>): boolean {
  return Boolean(args.entity_id) || (Array.isArray(args.account_ids) && args.account_ids.length > 0);
}

function entityRootNames(ledger: Ledger): string[] {
  return ledger.listAccounts().filter((account) => {
    if (account.parent_id) return false;
    const descendantIds = [...ledger.descendants(account.id)].filter((id) => id !== account.id);
    if (descendantIds.length === 0) return false;
    const types = new Set([...descendantIds, account.id].map((id) => ledger.getAccount(id)?.account_type).filter(Boolean));
    return types.size > 1;
  }).map((account) => account.name);
}

function requireScopeWhenAmbiguous(ledger: Ledger, args: Record<string, unknown>, command: string): void {
  if (hasScope(args)) return;
  const roots = entityRootNames(ledger);
  if (roots.length <= 1) return;
  throw new Error(`${command} is ambiguous across account groups (${roots.join(", ")}); pass --parent/--entity or --account.`);
}

program.command("tools")
  .description("List every public app tool")
  .addHelpText("after", examples([
    "clovis --format json tools",
    "clovis tools | grep account_balances"
  ]))
  .action(() => withOutput(program, () => TOOL_NAMES.map((name) => ({ name, signature: TOOL_SIGNATURES[name as ToolSignatureName] }))));

program.command("doctor")
  .description("Run local diagnostics")
  .option("--read-only-tools", "Exercise read-only tool paths")
  .option("--quote <asset>", "Quote asset id or symbol for report checks")
  .addHelpText("after", [
    examples(["clovis doctor --read-only-tools --quote CAD"]),
    notes(["The read-only suite does not mutate the ledger."])
  ].join("\n"))
  .action((opts) => withLedger(program, (ledger) => {
    if (!opts.readOnlyTools) return runReadOnlyDoctor(ledger, opts.quote);
    return runReadOnlyDoctor(ledger, opts.quote);
  }));

program.command("tool")
  .description("Run any public app tool by name")
  .argument("<name>")
  .option("--json <json>", "Tool args as a JSON object")
  .option("--stdin", "Read tool args as a JSON object from stdin")
  .addOption(new Option("--allow-destructive", "Deprecated no-op; tool calls execute directly").hideHelp())
  .addOption(new Option("--allow-all", "Deprecated no-op; tool calls execute directly").hideHelp())
  .addHelpText("after", [
    examples([
      "clovis tool account_balances --json '{\"account_type\":\"asset\"}'",
      "clovis tool import_transactions --stdin < args.json",
      "clovis tool backup_now",
      "clovis tool void_by_filter --json '{\"status\":\"planned\",\"date_to\":\"2026-05-31\"}'",
      "clovis tool void_by_filter --json '{\"status\":\"planned\",\"date_to\":\"2026-05-31\",\"dry_run\":false}'"
    ]),
    notes([
      "Run `clovis tools` to list tool names and signatures.",
      "Tool args must be a JSON object.",
      "File tools use ordinary filesystem permissions.",
      "Bulk mutation tools default to dry_run; pass dry_run:false to apply."
    ])
  ].join("\n"))
  .action((name: string, opts: ToolOptions) => withLedger(program, (ledger) => {
    const args = parseToolInput(name, parseToolArgs(opts));
    return callTool(name, args, ledger);
  }));

const account = program.command("account")
  .description("Manage accounts")
  .addHelpText("after", examples([
    "clovis account list",
    "clovis account balances --type asset",
    "clovis account add --name \"Cash\" --type asset"
  ]));
account.command("add")
  .description("Create an account")
  .requiredOption("--name <name>", "Account name")
  .requiredOption("--type <type>", "Account type: asset, liability, equity, income, or expense")
  .option("--code <code>", "Optional account code", "")
  .option("--parent <id>", "Parent account id")
  .option("--color <hex>", "Account color", "#888888")
  .addHelpText("after", examples([
    "clovis account add --name \"Operating Cash\" --type asset --code 1000",
    "clovis account add --name \"Dining Out\" --type expense --color '#7c3aed'"
  ]))
  .action((opts) => withLedger(program, (ledger) => callTool("create_account", { name: opts.name, type: opts.type, code: opts.code, parent_id: opts.parent, color_hex: opts.color }, ledger)));
account.command("balances")
  .description("List posted, pending, and current balances by account and asset")
  .option("--type <type>", "Account type")
  .option("--asset <id>", "Asset id or symbol")
  .option("--entity <id>", "Scope to an account group")
  .option("--parent <id>", "Alias for --entity")
  .option("--account <id>", "Restrict to an account or account subtree; may be repeated", collectOption, [])
  .option("--as-of <date>", "Balance date, YYYY-MM-DD")
  .option("--rollup", "Roll balances up through same-type account children")
  .option("--native-only", "Only include each account's native/default asset")
  .option("--presentation <mode>", "Display mode: ledger, bank, or banking", "ledger")
  .option("--show-zero", "Include zero-balance rows")
  .addHelpText("after", [
    examples([
      "clovis account balances --type asset",
      "clovis account balances --type liability --asset CAD",
      "clovis --format json account balances --type asset --show-zero"
    ]),
    notes([
      "Balances are reported in their native asset; Clovis does not silently convert currencies.",
      "Current balance is posted plus pending."
    ])
  ].join("\n"))
  .action((opts) => withLedger(program, (ledger) => {
    const args = { account_type: opts.type, asset_id: opts.asset, as_of: opts.asOf, rollup: Boolean(opts.rollup), hide_zero: !opts.showZero, native_asset_only: Boolean(opts.nativeOnly), presentation: opts.presentation, ...scopeArgs(opts) };
    if (args.rollup) requireScopeWhenAmbiguous(ledger, args, "account balances --rollup");
    return callTool("account_balances", args, ledger);
  }));
account.command("list")
  .description("List accounts")
  .option("--type <type>", "Account type")
  .option("--parent <id>", "Parent account id")
  .option("--tree", "Include account tree context")
  .addHelpText("after", examples([
    "clovis account list",
    "clovis --format json account list --type expense"
  ]))
  .action((opts) => withLedger(program, (ledger) => callTool("list_accounts", { type: opts.type, parent_id: opts.parent, tree: Boolean(opts.tree) }, ledger)));
account.command("get").description("Show one account").argument("<id>").action((idValue) => withLedger(program, (ledger) => callTool("get_account", { id: idValue }, ledger)));
account.command("update")
  .description("Update an account")
  .argument("<id>")
  .option("--name <name>", "Account name")
  .option("--type <type>", "Account type: asset, liability, equity, income, or expense")
  .option("--code <code>", "Optional account code")
  .option("--parent <id>", "Parent account id")
  .option("--color <hex>", "Account color")
  .action((idValue, opts) => withLedger(program, (ledger) => callTool("update_account", { id: idValue, name: opts.name, type: opts.type, code: opts.code, parent_id: opts.parent, color_hex: opts.color }, ledger)));
account.command("delete").description("Delete an unused account").argument("<id>").action((idValue) => withLedger(program, (ledger) => callTool("delete_account", { id: idValue }, ledger)));

const txn = program.command("txn")
  .description("Manage transactions")
  .addHelpText("after", examples([
    "clovis txn add --date 2026-06-01 --amount 100 --from <income-id> --to <checking-id> --status pending",
    "clovis txn transfer --date 2026-06-02 --amount 50 --from <checking-id> --to <savings-id>",
    "clovis txn list --status pending"
  ]));
txn.command("add")
  .description("Record a two-sided transaction")
  .requiredOption("--date <date>", "Transaction date, YYYY-MM-DD")
  .requiredOption("--amount <amount>", "Positive decimal amount in the transaction asset")
  .requiredOption("--from <id>", "Source account id")
  .requiredOption("--to <id>", "Destination account id")
  .option("--desc <description>", "Transaction description", "")
  .option("--status <status>", STATUS_HELP, "pending")
  .option("--asset <id>", "Asset id or symbol; required when account default assets differ")
  .addHelpText("after", [
    examples([
      "clovis txn add --date 2026-06-01 --amount 100 --from <salary-id> --to <checking-id> --desc \"Pay\" --status posted",
      "clovis txn add --date 2026-06-03 --amount 12.50 --from <checking-id> --to <dining-id>"
    ]),
    notes(["Default status is pending."])
  ].join("\n"))
  .action((opts) => withLedger(program, (ledger) => callTool("create_transaction", { date: opts.date, amount: opts.amount, from_account_id: opts.from, to_account_id: opts.to, description: opts.desc, status: opts.status, asset_id: opts.asset }, ledger)));
txn.command("transfer")
  .description("Record a same-asset transfer between balance-sheet accounts")
  .requiredOption("--from <id>", "Source account id")
  .requiredOption("--to <id>", "Destination account id")
  .requiredOption("--amount <amount>", "Positive decimal amount")
  .requiredOption("--date <date>", "Transaction date, YYYY-MM-DD")
  .option("--desc <description>", "Transfer description", "Transfer")
  .option("--asset <id>", "Asset id or symbol")
  .addHelpText("after", examples([
    "clovis txn transfer --date 2026-06-02 --amount 250 --from <checking-id> --to <savings-id>",
    "clovis txn transfer --date 2026-06-02 --amount 79 --asset USD --from <usd-checking-id> --to <usd-savings-id>"
  ]))
  .action((opts) => withLedger(program, (ledger) => callTool("transfer", { from_account_id: opts.from, to_account_id: opts.to, amount: opts.amount, date: opts.date, description: opts.desc, asset_id: opts.asset }, ledger)));
txn.command("journal")
  .description("Post a manual journal entry")
  .requiredOption("--date <date>", "Journal date, YYYY-MM-DD")
  .requiredOption("--leg <leg...>", "account_id:amount")
  .option("--desc <description>", "Journal description", "")
  .option("--status <status>", STATUS_HELP, "pending")
  .option("--asset <id>", "Default asset id or symbol for legs without asset ids")
  .addHelpText("after", [
    examples(["clovis txn journal --date 2026-06-30 --leg <debit-account>:10 --leg <credit-account>:-10 --asset CAD"]),
    notes(["Leg amounts must balance per asset."])
  ].join("\n"))
  .action((opts) => withLedger(program, (ledger) => callTool("post_journal_entry", { date: opts.date, description: opts.desc, status: opts.status, asset_id: opts.asset, legs: opts.leg.map((leg: string) => { const [accountId, amount] = leg.split(":"); return { account_id: accountId, amount }; }) }, ledger)));
txn.command("opening-balance")
  .description("Record an opening balance")
  .requiredOption("--account <id>", "Account id receiving the opening balance")
  .requiredOption("--amount <amount>", "Decimal opening amount")
  .requiredOption("--date <date>", "Opening date, YYYY-MM-DD")
  .option("--status <status>", STATUS_HELP, "pending")
  .option("--asset <id>", "Asset id or symbol")
  .option("--counterpart <id>", "Counterpart equity account id")
  .addHelpText("after", examples([
    "clovis txn opening-balance --account <checking-id> --amount 125 --date 2026-05-31 --status posted"
  ]))
  .action((opts) => withLedger(program, (ledger) => callTool("record_opening_balance", { account_id: opts.account, amount: opts.amount, date: opts.date, status: opts.status, asset_id: opts.asset, counterpart_account_id: opts.counterpart }, ledger)));
txn.command("list")
  .description("List transactions")
  .option("--account <id>", "Filter by account id")
  .option("--year <year>", "Filter by UTC year")
  .option("--month <month>", "Filter by month, 1-12")
  .option("--status <status>", STATUS_FILTER_HELP)
  .option("--desc <desc>", "Case-insensitive description search")
  .option("--limit <n>", "Maximum rows", "50")
  .addHelpText("after", examples([
    "clovis txn list --status pending",
    "clovis --format json txn list --account <checking-id> --limit 100"
  ]))
  .action((opts) => withLedger(program, (ledger) => callTool("list_transactions", { account_id: opts.account, year: opts.year ? Number(opts.year) : undefined, month: opts.month ? Number(opts.month) : undefined, status: opts.status, desc: opts.desc, limit: Number(opts.limit), compact: false }, ledger)));
txn.command("get").description("Show one transaction").argument("<id>").action((idValue) => withLedger(program, (ledger) => callTool("get_transaction", { id: idValue }, ledger)));
txn.command("delete").description("Void a transaction, or hard-delete with --hard").argument("<id>").option("--hard", "Physically delete instead of voiding").action((idValue, opts) => withLedger(program, (ledger) => callTool("delete_transaction", { id: idValue, hard_delete: Boolean(opts.hard) }, ledger)));
txn.command("entries").description("List journal entries for a transaction").argument("<tx_id>").action((txId) => withLedger(program, (ledger) => callTool("list_entries", { tx_id: txId }, ledger)));
txn.command("recategorize")
  .description("Recategorize a transaction")
  .argument("<tx_id>")
  .requiredOption("--from <id>", "Current account id")
  .requiredOption("--to <id>", "New account id")
  .option("--dry-run", "Preview the correction without applying it")
  .action((txId, opts) => withLedger(program, (ledger) => callTool("recategorize_transaction", {
    tx_id: txId,
    old_account_id: opts.from,
    new_account_id: opts.to,
    dry_run: opts.dryRun === true
  }, ledger)));

program.command("balance")
  .description("Show posted balances for an account")
  .argument("<account_id>")
  .addHelpText("after", [
    examples(["clovis balance <checking-id>"]),
    notes(["Use `clovis account balances` for posted, pending, and current balances across accounts."])
  ].join("\n"))
  .action((accountId) => withLedger(program, (ledger) => callTool("get_balance", { account_id: accountId }, ledger)));

program.command("init")
  .description("Initialize a ledger with default accounts")
  .option("--template <template>", "Default account template", "personal")
  .requiredOption("--currency <symbol>", "Explicit setup currency symbol, e.g. CAD or USD")
  .addHelpText("after", [
    examples(["clovis init --currency CAD"]),
    notes(["Clovis does not infer a default currency."])
  ].join("\n"))
  .action((opts) => withLedger(program, (ledger) => callTool("init_defaults", { template: opts.template, currency: opts.currency }, ledger)));

program.command("export")
  .description("Export transactions as CSV")
  .option("--account <id>", "Filter by account id")
  .option("--from <date>", "Start date, YYYY-MM-DD")
  .option("--to <date>", "End date, YYYY-MM-DD")
  .option("--status <status>", STATUS_FILTER_HELP)
  .option("--output <path>", "Write CSV file")
  .addHelpText("after", examples([
    "clovis export --from 2026-06-01 --to 2026-06-30 --output june.csv",
    "clovis --format json export --account <checking-id>"
  ]))
  .action((opts) => withLedger(program, (ledger) => callTool("export_transactions", { account_id: opts.account, date_from: opts.from, date_to: opts.to, status: opts.status, output_path: opts.output }, ledger)));

program.command("import")
  .description("Import a CSV statement into an account")
  .requiredOption("--file <path>", "CSV file path")
  .requiredOption("--account <id>", "Destination account id")
  .requiredOption("--counterpart <id>", "Counterpart/category account id for imported rows")
  .option("--currency <symbol>", "Explicit asset symbol if the file differs from the account default")
  .option("--status <status>", STATUS_HELP, "pending")
  .addHelpText("after", [
    examples([
      "clovis import --file statement.csv --account <checking-id> --counterpart <uncategorized-id>",
      "clovis import --file visa.csv --account <card-id> --counterpart <uncategorized-id> --status pending"
    ]),
    notes([
      "Default status is pending so imported rows can be reviewed before posting.",
      "File paths use ordinary filesystem permissions."
    ])
  ].join("\n"))
  .action((opts) => withLedger(program, (ledger) => callTool("import_file", { file_path: opts.file, account_id: opts.account, counterpart_account_id: opts.counterpart, currency: opts.currency, status: opts.status }, ledger)));

const report = program.command("report")
  .description("Run accounting reports")
  .addHelpText("after", [
    examples([
      "clovis report balance-sheet --quote CAD",
      "clovis report income-statement --year 2026 --month 6 --quote CAD",
      "clovis report register --account <checking-id> --status posted"
    ]),
    notes(["Reports require explicit quote assets; Clovis does not infer report currency."])
  ].join("\n"));
report.command("income-statement").description("Report income, expenses, and net income").requiredOption("--year <year>", "UTC year").option("--month <month>", "Month, 1-12").requiredOption("--quote <asset>", "Quote asset symbol or id").addHelpText("after", examples(["clovis report income-statement --year 2026 --month 6 --quote CAD"])).action((opts) => withLedger(program, (ledger) => callTool("income_statement", { year: Number(opts.year), month: opts.month ? Number(opts.month) : undefined, quote_asset_id: opts.quote }, ledger)));
report.command("balance-sheet").description("Report assets, liabilities, and equity").option("--date <date>", "As-of date, YYYY-MM-DD").requiredOption("--quote <asset>", "Quote asset symbol or id").option("--entity <id>", "Scope to an account group").option("--parent <id>", "Alias for --entity").option("--account <id>", "Restrict to an account or account subtree; may be repeated", collectOption, []).option("--include-pending", "Include pending transactions").option("--status <status>", STATUS_FILTER_HELP).option("--hide-zero", "Hide zero-balance rows").addHelpText("after", examples(["clovis report balance-sheet --date 2026-06-30 --quote CAD --parent Personal"])).action((opts) => withLedger(program, (ledger) => {
  const args = { date: opts.date, quote_asset_id: opts.quote, include_pending: Boolean(opts.includePending), status: opts.status, hide_zero: Boolean(opts.hideZero), ...scopeArgs(opts) };
  requireScopeWhenAmbiguous(ledger, args, "report balance-sheet");
  return callTool("balance_sheet", args, ledger);
}));
report.command("net-worth").description("Report net worth").option("--date <date>", "As-of date, YYYY-MM-DD").requiredOption("--quote <asset>", "Quote asset symbol or id").option("--entity <id>", "Scope to an account group").option("--parent <id>", "Alias for --entity").option("--account <id>", "Restrict to an account or account subtree; may be repeated", collectOption, []).option("--include-pending", "Include pending transactions").option("--status <status>", STATUS_FILTER_HELP).addHelpText("after", examples(["clovis report net-worth --quote CAD --parent Personal"])).action((opts) => withLedger(program, (ledger) => {
  const args = { date: opts.date, quote_asset_id: opts.quote, include_pending: Boolean(opts.includePending), status: opts.status, ...scopeArgs(opts) };
  requireScopeWhenAmbiguous(ledger, args, "report net-worth");
  return callTool("net_worth", args, ledger);
}));
report.command("spending").description("Report spending by category").requiredOption("--year <year>", "UTC year").requiredOption("--month <month>", "Month, 1-12").requiredOption("--quote <asset>", "Quote asset symbol or id").addHelpText("after", examples(["clovis report spending --year 2026 --month 6 --quote CAD"])).action((opts) => withLedger(program, (ledger) => callTool("spending", { year: Number(opts.year), month: Number(opts.month), quote_asset_id: opts.quote }, ledger)));
report.command("cash-flow").description("Report cash flow by activity").requiredOption("--year <year>", "UTC year").requiredOption("--month <month>", "Month, 1-12").requiredOption("--quote <asset>", "Quote asset symbol or id").addHelpText("after", examples(["clovis report cash-flow --year 2026 --month 6 --quote CAD"])).action((opts) => withLedger(program, (ledger) => callTool("cash_flow", { year: Number(opts.year), month: Number(opts.month), quote_asset_id: opts.quote }, ledger)));
report.command("register").description("Show an account register").requiredOption("--account <id>", "Account id").option("--asset <id>", "Asset id or symbol").option("--from <date>", "Start date, YYYY-MM-DD").option("--to <date>", "End date, YYYY-MM-DD").option("--status <status>", STATUS_FILTER_HELP).addHelpText("after", examples(["clovis report register --account <checking-id> --from 2026-06-01 --to 2026-06-30"])).action((opts) => withLedger(program, (ledger) => callTool("account_register", { account_id: opts.account, asset_id: opts.asset, date_from: opts.from, date_to: opts.to, status: opts.status }, ledger)));
report.command("trial-balance").description("Show debit and credit totals for one asset").requiredOption("--asset <id>", "Asset id or symbol").option("--status <status>", STATUS_FILTER_HELP).addHelpText("after", examples(["clovis report trial-balance --asset CAD"])).action((opts) => withLedger(program, (ledger) => callTool("trial_balance", { asset_id: opts.asset, status: opts.status }, ledger)));

program.parseAsync();
