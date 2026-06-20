# Clovis Operating Manual

Clovis is a local-first bookkeeping system for people and agents. It keeps
financial facts in a SQLite double-entry ledger and exposes a CLI, Node API,
and MCP server over the same app catalog.

The main idea is simple: let the ledger remember facts, let pending rows hold
uncertainty, let reconciliation decide trust, and let reports explain only the
universe they actually queried.

This guide is operational guidance, not financial, tax, or legal advice.

## First Principles

- Live Clovis data is the source of truth. Chat history is not.
- Pending is review. Posted is history. Planned is intent.
- QFX and OFX are preferred for imports when available because stable ids make
  duplicate detection safer. CSV remains supported.
- Before using `include_planned:true`, inspect or reconcile realized planned
  rows so landed income or bills are not counted twice.
- Transfers move balances. Expenses consume money. Do not mix them.
- Read-only and dry-run tools should come before mutation.
- Applied mutations should leave an audit event and a ledger-level reversal
  path.

## Statement Import

A statement file is a pile of bank facts. Clovis turns those facts into a
review plan first, then writes pending or posted ledger transactions only when
the plan is applied.

Use QFX or OFX when the bank offers it. Those files usually include stable ids
such as `FITID`, which help Clovis recognize the same bank row later.

Use CSV when QFX or OFX is unavailable, incomplete, or malformed. CSV works, but
the bank often leaves out stable ids, so date, amount, and description matching
matters more.

Preview the file before importing. The preview answers: can Clovis read the
file, which columns did it understand, and what rows will it create?

Use `refresh_statement` when you need the safest path. It previews a plan by
default; pass `dry_run:false` to stage an immutable plan. The plan separates
already-matched rows, pending rows to commit, true new rows, stale pending rows
to void, and ambiguous rows that need review.

Review `realized_planned_rows` in statement plans. Those are planned rows that
appear to have landed as posted or pending transactions and should be
reconciled before projected cash is trusted.

Import direct rows as pending by default. Pending means the row is visible and
useful, but not yet trusted as final bookkeeping.

Before committing, reconcile against the statement and check duplicate
candidates. A clean plan is boring: expected rows, expected balance, no
unexplained extras.

Commit only after review. If the import looks wrong, discard the batch or fix
the mapping instead of posting bad rows and cleaning them up later.

Recommended tools:

- `file_access_status`
- `preview_import`
- `refresh_statement`
- `reconcile_statement_plan`
- `process_statement`
- `import_file`
- `find_pending_duplicates`
- `find_realized_planned`
- `reconcile_planned`
- `commit_batch`
- `discard_batch`
- `void_by_filter`

Watch outs:

- Do not commit a fresh import just because parsing succeeded. Parsing only
  proves the file was readable.
- If a path fails, check the actual file path, suffix, file size, and
  operating-system permissions.
- If CSV descriptions change between exports, duplicate detection is weaker
  than QFX/OFX stable-id matching.

## Reconciliation

Reconciliation is the part where Clovis proves that its ledger story agrees
with an outside source, usually a bank or card statement.

Start from the source statement. The statement is the receipt for what the bank
says happened.

Compare statement rows with posted and pending ledger rows for the same account,
date range, and currency.

Treat duplicate candidates as questions, not automatic truth. Same date and
amount can be a duplicate, but it can also be two real purchases.

Use expected ending balance when you have it. Matching rows plus matching
balance is much stronger than matching rows alone.

Preserve transfer intent. A payment from Checking to Visa is not dining, rent,
or shopping; it is debt movement between accounts.

When reconciliation finds a mismatch, fix the narrowest cause: mapping, missing
row, duplicate row, wrong account, wrong sign, or wrong status.

Recommended tools:

- `reconcile_statement_plan`
- `refresh_statement`
- `reconcile_diff`
- `reconcile_statement`
- `inspect_transaction`
- `list_transactions`
- `find_pending_duplicates`
- `integrity_check`

Watch outs:

- A balanced journal can still be the wrong journal. Double-entry prevents
  broken math, not bad categorization.
- Do not resolve reconciliation mismatches by changing historical posted data
  unless you know which source fact was wrong.
- Transfers should explain movement between balance-sheet accounts; they should
  not inflate expense reports.

## Month End

Month end is a snapshot exercise: what came in, what went out, what is still
pending, what cash is spendable, and what obligations remain.

Separate assets from liabilities. Cash in Checking and debt on Visa are both
real, but they answer different questions.

Use liability-aware projections for credit cards and debt. Spendable cash is
not the same thing as gross cash.

Include earmarks and goals when explaining available money. Money can be
present but already assigned.

For current personal balance-sheet and net-worth snapshots, default to active
balances that include pending rows. Use `status:posted` when the answer must be
posted-only.

Before `include_planned:true` projections, run `find_realized_planned` or
`reconcile_planned` for the period. `cash_projection` excludes realized planned
rows, but unresolved matches still deserve review.

Use budgets to explain variance, not just totals. A month-end answer should say
which categories are driving the result.

Run integrity checks before giving final numbers. If the ledger is structurally
unhealthy, the report is not ready.

Recommended tools:

- `cash_projection`
- `find_realized_planned`
- `reconcile_planned`
- `project_month_end`
- `financial_picture`
- `financial_overview`
- `budget_summary`
- `budget_status`
- `pending_summary`
- `integrity_check`

Watch outs:

- Do not call all cash spendable when liabilities or earmarks are waiting to be
  paid.
- Do not mix planned, pending, and posted rows without saying which universe the
  answer uses.
- Month-end projections are assumptions. State expected inflows, expected
  outflows, included accounts, and quote asset.

## Cash Runway

Cash runway is how long spendable cash lasts under explicit burn assumptions.
Clovis treats this as a conservative report, not a net-worth shortcut.

Start with `cash_runway`. It defaults to posted actual cash, deducts
liabilities, excludes planned and pending rows, and keeps obvious investment
accounts out of default spendable cash.

By default, trailing actual burn uses the last complete months, not the current
partial month. Use `include_partial_month:true` only when a partial month should
be part of the denominator.

Runway cash reserves the remaining current-month budget by default. Use
`reserve_remaining_budget:false` only when you intentionally want raw available
cash.

`cash_runway` omits heavy source rows by default. Use `include_sources:true` for
audit/debug views after the compact answer is understood.

Use `include_pending:true` or `include_planned:true` only when the answer should
explicitly become a projection.

Before `include_planned:true`, inspect realized planned rows. Use
`reconcile_planned` dry-run first, then `dry_run:false` to void planned rows
that have landed.

Read the burn models separately: budget burn, trailing actual burn,
fixed-obligation burn, and discretionary-adjusted burn answer different
questions.

Use `cash_projection` when you need the audit trail behind spendable cash:
starting cash, liabilities, earmarks, remaining budget, and planned income.

Remove earmarked money when it is not available for general spending. A tax
reserve or rent reserve is not free cash.

State the quote asset, included accounts, included statuses, and burn
assumptions in the answer.

Use scenarios for what-if work instead of rewriting actual history.

Recommended tools:

- `cash_runway`
- `cash_projection`
- `find_realized_planned`
- `reconcile_planned`
- `budget_summary`
- `spending_rate`
- `spending`
- `net_worth`
- `balance_sheet`
- `forecast`

Watch outs:

- Net worth is not runway. Illiquid investments and unpaid card balances can
  make net worth look better than cash reality.
- Planned paycheques are not current cash. If they are included, say that the
  answer is a projection.
- Missing currency conversions need severity. A tiny missing balance may be
  noise; a large missing balance can invalidate the answer.
- Average spend can hide annual or irregular obligations. Look for rent, taxes,
  insurance, subscriptions, and debt payments.
- Runway answers should be ranges when inputs are uncertain.

## Categorization

Categorization names what a transaction means. The ledger already knows money
moved; categories explain why it moved.

Categorize the economic event, not just the merchant string. A card payment is a
transfer; a restaurant charge is dining.

Use durable match rules only for stable merchants and stable meanings. A broad
rule can silently corrupt future imports.

Keep Uncategorized as a review queue, not a permanent home.

Audit repeated descriptions before applying bulk changes. Repetition is a clue,
not proof.

Prefer dry-run recategorization first so you can see the affected rows.

After bulk categorization, inspect totals and a sample of changed transactions.

Recommended tools:

- `audit_categorization`
- `apply_match_rules`
- `recategorize_transaction`
- `recategorize_by_pattern`
- `recategorize_by_patterns`
- `top_descriptions`
- `list_uncategorized`
- `inspect_transaction`

Watch outs:

- Do not create catch-all rules that classify every unknown merchant as real
  spending.
- Do not categorize transfers, refunds, reimbursements, or credit-card payments
  as ordinary expenses without checking both sides.
- Bulk recategorization should be dry-run first unless the affected rows were
  already inspected.

## Safety

Safety means Clovis should be useful to agents without making it easy for an
agent to damage the ledger by accident.

Prefer read-only tools first. They are safe for discovery, diagnosis, and
explanation.

Read MCP annotations before routing calls. `readOnlyHint`, `destructiveHint`,
and `idempotentHint` are machine-readable safety labels.

Treat MCP as a trusted local control plane. Clovis does not authenticate MCP
clients or enforce per-tool capability grants inside the server; use OS
sandboxing, containers, dedicated user accounts, and filesystem permissions for
hard boundaries.

File tools default to `CLOVIS_FILE_POLICY=unrestricted`. Use
`CLOVIS_FILE_POLICY=ledger-dir` or `CLOVIS_FILE_POLICY=roots` with
`CLOVIS_FILE_ROOTS` when Clovis itself should enforce path boundaries.

Use dry-run-capable tools in preview mode before applying changes. The preview
is the change request.

For tools without native dry-run output, use `preview_mutation` to run the
change inside a rolled-back ledger transaction and inspect the structured diff.

Applied ledger mutations return a `mutation_id`/`operation_id`. Inspect it with
`get_ledger_operation` or `list_ledger_operations`, and reverse supported
operations with `reverse_ledger_operation` rather than editing history by hand.

Back up before destructive or broad edits. Backups are cheap compared with
manual reconstruction.

Use `file_access_status` when a statement path fails. It reports the current
path policy, allowed roots, max file size, and relevant filesystem
configuration.

Run doctor or integrity checks after upgrades and before important month-end
work.

Recommended tools:

- `tool_registry`
- `file_access_status`
- `backup_status`
- `backup_now`
- `integrity_check`
- `preview_commit`
- `preview_mutation`
- `list_ledger_operations`
- `get_ledger_operation`
- `reverse_ledger_operation`

Watch outs:

- Destructive tools should not be called speculatively.
- A dry-run result is not a committed result. The caller must pass the explicit
  commit or `dry_run:false` argument to apply supported mutations.
- Reversals are corrections, not deletion. Posted facts stay inspectable.
- Clovis can organize bookkeeping facts, but it is not a bank, tax advisor,
  custody system, or substitute for professional review.

## MCP Surface

The same manual is exposed to MCP clients in three ways:

- server instructions, returned during MCP initialization
- the read-only `operating_manual` tool
- Markdown resources:
  - `clovis://manual`
  - `clovis://manual/statement-import`
  - `clovis://manual/month-end`
  - `clovis://manual/runway`
  - `clovis://manual/safety`

Agents that support MCP resources can read the Markdown directly. Agents that
only support tool calls can call:

```sh
clovis --db ./ledger.db --format json tool operating_manual \
  --json '{"topic":"statement_import"}'
```

Allowed topics are `all`, `statement_import`, `reconciliation`, `month_end`,
`runway`, `categorization`, and `safety`.
