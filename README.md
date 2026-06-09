# Clovis

Clovis is a local-first bookkeeping CLI, MCP server, and TypeScript ledger
engine for Node.js. It stores ledger data in SQLite through Node's built-in
`node:sqlite` module and runs without a cloud account.

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

```ts
import { Ledger } from "clovis/core";

const ledger = new Ledger("./ledger.db");
ledger.initDefaults("personal");
ledger.close();
```

Fresh databases are created directly with the TypeScript schema. Ledger JSON
snapshots can be exported and imported with `export_ledger` and
`import_ledger`.

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
