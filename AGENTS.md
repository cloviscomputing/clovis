# AGENTS.md

This file defines the repository rules for AI coding agents working on Clovis.
It is guidance for agents and reviewers; enforcement lives in CI and
the marked human-only block in `.github/CODEOWNERS`.

## Repository Shape

- `src/core` owns durable ledger state, schema, migrations, accounting
  invariants, SQLite persistence, audit, and export behavior.
- `src/app` owns tool orchestration, statement workflows, mutation oversight,
  filesystem access, validation, and higher-level ledger operations.
- `src/mcp` and `src/cli` are adapters over the app/core layers.
- Public imports must go through `clovis`, `clovis/core`, `clovis/app`, or
  `clovis/mcp`.

## Agent Boundaries

Agents may propose normal code, tests, and documentation changes when they stay
inside existing architecture and include appropriate verification.

Agents must not change paths inside the `agent-governance: human-only` block in
`.github/CODEOWNERS` unless a maintainer explicitly asks for that exact change.

All CODEOWNERS-covered paths need the listed owner review when branch
protection requires CODEOWNER approval.

## Ledger Safety Rules

- Never use real financial data in tests, fixtures, examples, issue comments,
  screenshots, logs, or documentation.
- Keep cash, liabilities, earmarks, income, expenses, transfers, and credit-card
  payments conceptually separate. Do not treat transfers or balance movement as
  spending.
- Mutating ledger behavior must preserve auditability and a reversal path.
- Statement import/reconciliation changes must preserve duplicate detection,
  pending-to-posted handling, stale pending review, and ambiguous-row review.
- MCP tool safety annotations matter. Keep read-only, mutating, destructive,
  and idempotent behavior explicit and aligned with implementation.

## Working Rules

- Read surrounding code before editing and follow the local patterns.
- Keep changes focused; do not mix formatting churn with behavior changes.
- Add or update tests for behavior changes, especially ledger mutation,
  statement workflows, MCP contracts, filesystem access, and release behavior.
- Run the narrowest useful check while iterating, then run
  `npm run release:check` before a PR is ready.
- Do not self-approve, merge, publish, change release workflows, or weaken tests
  to make a change pass.
- Do not add AI attribution footers or co-author trailers unless the maintainer
  asks for them.
