# Clovis

Clovis is the official TypeScript implementation of the Clovis local
bookkeeping engine for Node.js. It provides a CLI, a package API, an MCP
server, and a SQLite-backed ledger that runs without a cloud account.

This package is the local ledger implementation. It is not a hosted service and
not just a protocol document. The durable public surfaces are:

- the SQLite schema created by the ledger engine
- the package exports under `clovis`, `clovis/core`, `clovis/app`, and
  `clovis/mcp`
- the `clovis` CLI
- the `clovis-mcp` server and its MCP tool signatures

Future Clovis apps are expected to read and write the same local database
format through this package or through the schema it owns.

## Status

The database format is versioned. The current schema is `SCHEMA_VERSION = 1`.
Fresh databases are created directly with this schema. Ledger JSON snapshots can
be exported and imported with `export_ledger` and `import_ledger`.

The schema is intended to be a product contract, not a throwaway cache. Patch
and minor releases should continue to read schema v1 databases. If a future
release needs a schema change, it should ship a documented upgrade path before
Clovis applications depend on it.

## Financial Records

Clovis is designed for local bookkeeping records, but you should treat any
financial database with care:

- keep backups of your ledger file
- review imported or pending transactions before posting them
- reconcile against source statements
- run `npm run release:check` before release builds

The engine enforces balanced double-entry journals per asset, stores quantities
as integers using each asset's scale, uses SQLite foreign keys, supports period
closes, and ships with a contract test row for every MCP tool. It is not a bank,
custody system, tax filing product, or substitute for professional review.

## Install

```sh
npm install -g clovis
```

## CLI

```sh
clovis --db ./ledger.db init
clovis --db ./ledger.db --format json account list
clovis --db ./ledger.db txn add --date 2026-06-01 --amount 100 \
  --desc "Owner contribution" --from "<equity-account-id>" --to "<checking-id>" \
  --status posted
```

## MCP

```sh
CLOVIS_DB=./ledger.db clovis-mcp
```

`clovis-mcp` requires `CLOVIS_DB`. File-based MCP tools are limited to the
ledger directory by default. Set `CLOVIS_MCP_ALLOWED_ROOT` to allow imports,
exports, and backups under another local directory.

## Package API

`npm install clovis` installs one package. Import the surface you need through
an explicit public entrypoint:

```ts
import { Ledger } from "clovis/core";

const ledger = new Ledger("./ledger.db");
ledger.initDefaults("personal");
ledger.close();
```

```ts
import { callTool, TOOL_NAMES } from "clovis/app";
import { createClovisMcpServer, TOOL_SIGNATURES } from "clovis/mcp";
```

The top-level `clovis` entrypoint is intentionally small:

```ts
import { Ledger, SCHEMA_VERSION } from "clovis";
```

Use `clovis/core` for ledger engine APIs, schema constants, money helpers, and
accounting primitives. Use `clovis/app` for the shared tool dispatcher and tool
name contract. Use `clovis/mcp` for MCP server creation and MCP tool metadata.
Files under `dist/` and `src/` are package internals and are not public import
paths.

## Data Model

The accounting core is deliberately small:

```text
assets
accounts
journals
journal_lines
prices
```

`journals` stores transaction headers. `journal_lines` stores the balanced
legs. Every journal must sum to zero for each `asset_id`; `quantity` is stored
in atomic units using the related asset `scale`.

```text
books
  |-- accounts
  |     |-- journal_lines -- journals -- sources
  |     |        |
  |     |        `-- assets
  |     |
  |     |-- targets
  |     |-- lots -- assets
  |     `-- recurrences -- accounts
  |
  |-- prices -- assets
  `-- period_closes

annotations(entity_type, entity_id)
rules -- accounts
audit_events(entity_type, entity_id)
meta
```

Support tables keep workflow concerns out of the journal core:

- `books`: actual and scenario books.
- `sources`: import batches and source metadata.
- `annotations`: tags and flexible entity metadata.
- `rules`: categorization rules.
- `targets`: budgets and goals.
- `recurrences`: scheduled transactions.
- `period_closes`: closed accounting periods.
- `lots`: investment lots and cost basis.
- `audit_events`: audit event records.
- `meta`: schema version and database metadata.

## Release Checks

```sh
npm run release:check
```

The release check runs typecheck, build, the full test suite, package dry-run,
runtime artifact scan, and wording/local path scan. The test suite includes a
contract row for every MCP tool exposed by the package.
