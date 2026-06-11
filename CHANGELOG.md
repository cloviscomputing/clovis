# Changelog

## Unreleased

## 0.2.7

Report warning and backup listing polish release.

- Scope `cash_runway` conversion warnings to affected sections/models, enrich missing conversion rows with account and asset names, and expose per-model valuation completeness.
- Make open-ended `financial_picture.current_snapshot` omit `as_of` instead of returning `null`.
- Make `list_backups` return backup database files only, grouping SQLite WAL/SHM sidecars under their parent backup.

## 0.2.6

Cash runway and financial picture cleanup release.

- Remove the duplicate `cash_runway.models` response alias; `burn_models` is now the only burn-model array.
- Deduplicate `cash_runway.missing_conversions` before returning conversion warnings.
- Add `financial_picture` warnings when explicit `status` overrides contradictory `include_pending` or `include_planned` flags.

## 0.2.5

Cash runway semantics and changelog packaging release.

- Make `cash_runway` default to last complete trailing months, reserve remaining current-month budget from runway cash, compact source payloads by default, and expose opt-ins for partial months and full sources.
- Make `budget_status` return top-level `total_remaining_cents`, make `financial_picture.current_snapshot` avoid user-facing `9999-12-31`, and let filtered `tool_registry` return known tools plus `unknown_names`.
- Add a docs changelog landing page and include `CHANGELOG.md` in packed npm artifacts.

## 0.2.4

Runtime safety and cash runway release.

- Remove the Clovis file path gate. File tools now use ordinary filesystem permissions while retaining suffix checks, overwrite protection, and `CLOVIS_MAX_FILE_BYTES`.
- Make `refresh_statement` dry-runs non-persistent, require `dry_run:false` to stage statement plans, add credit-card statement balance sign handling, expose clearer statement counters and ambiguous match candidates, return explicit backup output paths, and add filtered/summary `tool_registry` responses.
- Add conservative `cash_runway`, make cash projection default to actual posted cash, add projection audit trails, expose planned/pending cash assumptions, and add severity-shaped currency conversion warnings.

## 0.2.3

Schema v3 statement plan release.

- Add schema v3 statement import plans with immutable `statement_plans` and `statement_plan_rows` audit tables.
- Add `refresh_statement` for plan/apply/verify/discard statement workflows across CLI/MCP.
- Make `process_statement` and `apply_reconciliation_plan` apply only the planner's true unmatched rows instead of relying on external-id-only duplicate checks.
- Make import dry-runs predictive, including would-create entries, duplicates, tags, balance impact, and validation errors.
- Preserve pending expense categories through per-row counterparts and match rules, using `Pending Expenses` only as the unresolved fallback.
- Support QFX/OFX previews, CSV footer skipping, month-name dates, explicit `mdy`/`dmy` parsing, and plan-safe expected-balance checks.
- Make `project_month_end` accept explicit `asset_account_ids` and `liability_account_ids`, and split mixed `account_ids` into the correct cash-projection buckets.
- Make `list_transactions compact:true` omit full `entries` and `tags` while retaining scan-friendly counts and account/asset IDs.
- Make missing `goal_progress` return `{ found:false, goal:null }` instead of throwing.
- Recommend QFX/OFX statement imports when available while keeping CSV documented as a supported fallback.
- Add the Clovis Operating Manual as public docs, MCP server instructions, MCP Markdown resources, and the read-only `operating_manual` tool.

## 0.2.2

Agent file-access configuration release.

- Add `CLOVIS_ALLOWED_ROOTS` so CLI and MCP file tools can use multiple local workspace roots.
- Add the read-only `file_access_status` tool and expose the same configuration through `tool_registry.file_access`.
- Make blocked file-path errors show the requested path, current allowed roots, and a restart-ready `CLOVIS_ALLOWED_ROOTS` hint.
- Document file-access configuration in the README and SQLite persistence docs.
- Add core, MCP contract, and read-only oracle coverage for multi-root file access and the new metadata surface.

## 0.2.1

CLI/MCP contract hardening release.

- Standardize read/filter status semantics across CLI and MCP tools: `all` and JSON `null` mean visible non-void transactions, while creation tools still require lifecycle statuses.
- Fix `export_transactions` and `export_ledger` so advertised account, date, entity, and status filters are actually applied.
- Add MCP safety annotations, parameter aliases, and the `tool_registry` reader for machine-readable schema, status, alias, and safety metadata.
- Add QFX/OFX statement preview support and make tagged/manual import batches visible to batch tooling.
- Replace misleading implementations for `detect_recurring`, `age_of_money`, posted-at search, and unmatched-transfer tolerance with persistence-backed behavior.
- Enable SQLite WAL mode and busy timeouts, and add concurrent read-only CLI smoke coverage.
- Add `clovis doctor --read-only-tools --quote <asset>` for local read-only tool diagnostics.

## 0.2.0

Schema v2 hardening release.

- Add schema version 2 with migration history, finalized journals, account default assets, and SQLite finalization triggers.
- Migrate schema v1 ledgers on open, preserving posted journals and old account `default_asset` annotations.
- Require direct SQL transaction writes to stage draft journals, insert balanced lines, then finalize.
- Make finalized journal lines immutable and block finalization/reopening across active closed periods.
- Clone scenario books into isolated active books with remapped accounts, journals, sources, rules, targets, recurrences, closes, lots, and annotations.
- Document the schema, ERD, persistence model, and direct SQL write protocol in Feynman-style language.
- Expand migration, direct-SQL, scenario, release smoke, and raw SQLite oracle coverage for the schema v2 contract.

## 0.1.9

SQLite oracle and workflow audit release.

- Add raw SQLite oracle coverage for every read-only MCP tool and generic CLI parity for those tools.
- Add synthetic CFO workflow regression coverage for statement processing, reconciliation, pending card imports, pending refresh, and batch commit/discard.
- Add exhaustive write-capable tool coverage across direct app calls, CLI `clovis tool`, and MCP stdio, including explicit write-mode coverage for dry-run mutators.
- Fix report projection bugs in balance sheet, net worth, cash flow, financial picture, budget status, cash projection, project balances, project month end, and holdings.
- Fix statement import/reconciliation bugs around duplicate rows, posted-vs-pending expected balances, non-cent assets, and amount conventions.
- Fix pending card expense direction so pending card charges reduce available cash.
- Fix transfer matching so valid pending transfer pairs are not missed due to random transaction ID ordering.
- Fix MCP signature/input validation drift for `apply_rollover`, `reconcile_statement`, and inline `import_ledger` data.

## 0.1.8

Capability gate removal release.

- Remove the MCP destructive capability gate.
- Remove the generic CLI destructive allow gate from help and enforcement.
- Keep old allow flags accepted as hidden no-ops for script compatibility.
- Keep file path sandboxing and dry-run defaults for bulk mutation tools.

## 0.1.7

Cash projection compatibility release.

- Keep liability subtraction explicit: `cash_projection` subtracts `liability_account_ids` when passed, but does not default to every liability account.

## 0.1.6

CFO projection correctness release.

- Make `cash_projection` honor `include_pending` and `include_planned`.
- Subtract passed liability accounts from available cash and return posted/pending/planned breakdowns.
- Bound planned projection rows to the requested month so stale prior-month planned payroll is excluded.
- Collapse overlapping budget targets before reporting `budget_status` totals, while surfacing shadowed rows.

## 0.1.5

Filesystem gate simplification release.

- Remove the extra `filesystem` capability requirement from MCP and generic CLI file tools.
- Keep file tools sandboxed by the active ledger directory or `CLOVIS_ALLOWED_ROOT`.
- Keep destructive tool gating through `CLOVIS_MCP_CAPABILITIES=destructive` and `--allow-destructive`.

## 0.1.4

CLI/MCP parity and help polish release.

- Add `account_balances` as a core-owned app/MCP/CLI balance projection.
- Add `clovis tools` and `clovis tool <name>` for full CLI parity with the app/MCP catalog.
- Move tool signatures to the app layer and keep MCP re-exports compatible.
- Replace the file tool root setting with shared `CLOVIS_ALLOWED_ROOT`.
- Improve CLI help with examples, safety notes, currency guidance, and status values.
- Default CLI CSV imports to `pending` for review before posting.
- Document how users update the npm package.

## 0.1.3

Default path alignment release.

- Set the npm CLI/MCP default ledger path to `~/.clovis/clovis.db`.
- Keep `CLOVIS_DB` and `--db` overrides unchanged for explicit deployments.
- Document the new default path in the README.

## 0.1.2

Public repository readiness release.

- Source CLI, package, and MCP server versions from package metadata.
- Re-enable npm provenance publishing for the public GitHub repository.
- Document npm installation, CLI usage, MCP setup, and package entrypoints.
- Add CI security audit and import-size hardening.

## 0.1.1

Release automation and package hardening.

- Publish the package through npm Trusted Publishing.
- Add explicit account/report currency handling with account default assets.
- Set the default CLI ledger path to `~/.cloviscomputing/clovis.db`.
- Tighten packed-package checks and public package metadata.

## 0.1.0

First public release.

- Local SQLite ledger engine with schema version 1.
- CLI for setup, accounts, transactions, imports, exports, and reports.
- MCP server for local agent workflows.
- Package entrypoints for `clovis`, `clovis/core`, `clovis/app`, and `clovis/mcp`.
- Contract coverage for every exposed app/MCP tool.
