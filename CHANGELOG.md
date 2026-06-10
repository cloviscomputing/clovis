# Changelog

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
