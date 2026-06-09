# Clovis

[![npm version](https://img.shields.io/npm/v/clovis?label=npm)](https://www.npmjs.com/package/clovis)
[![latest](https://img.shields.io/npm/v/clovis/latest?label=latest)](https://www.npmjs.com/package/clovis)
[![CI](https://github.com/cloviscomputing/clovis/actions/workflows/ci.yml/badge.svg)](https://github.com/cloviscomputing/clovis/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/clovis)](LICENSE)
[![node](https://img.shields.io/node/v/clovis)](package.json)

Clovis is a local-first bookkeeping package for Node.js. It provides a SQLite
ledger engine, package APIs, a command-line interface, and an optional MCP
server for local agent workflows.

Clovis is not a hosted service, sync service, or app UI. The public surfaces are:

- the SQLite schema created by the ledger engine
- the package exports under `clovis`, `clovis/core`, `clovis/app`, and
  `clovis/mcp`
- the `clovis` CLI
- the `clovis-mcp` server and its MCP tool signatures

This package currently defines the local database format while the project is in
the `0.x` line.

## Status

The database format is versioned. The current schema is `SCHEMA_VERSION = 1`.
Fresh databases are created directly with this schema. Ledger JSON snapshots can
be exported and imported with `export_ledger` and `import_ledger`.

`0.1.0` is the first public release. Clovis is designed for long-running local
bookkeeping workflows while the public API and database format settle during the
`0.x` line.

The schema is a versioned local data format, but the package is still pre-1.0.
Patch releases should continue to read schema v1 databases. Minor releases may
revise the format and should document the upgrade path.

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

## Currency Model

Clovis does not infer a default currency. Setup requires an explicit currency,
and accounts created by `init_defaults` are tagged with a `default_asset`.
Account APIs expose `default_asset_id` and `default_asset_symbol`.

Transactions may omit `asset_id` only when both accounts have the same
`default_asset`. Cross-currency movement should use `fx_transfer`. Reports that
present converted totals require an explicit `quote_asset_id` or CLI `--quote`
value, and report missing conversions when prices are unavailable.

## Install

Clovis is distributed as the public npm package `clovis`.

```sh
npm install -g clovis
```

Use the global install for the CLI and MCP server:

```sh
clovis --help
CLOVIS_DB=./ledger.db clovis-mcp
```

Use a project install when embedding the ledger engine, app dispatcher, or MCP
server in another Node.js application:

```sh
npm install clovis
```

You can also run the CLI without a global install:

```sh
npx clovis --help
```

## CLI

The CLI covers common setup, account, transaction, import/export, and report
flows. The broader tool surface is available through `clovis/app` and
`clovis-mcp`.

By default, the CLI stores its ledger at `~/.clovis/clovis.db`. Use
`--db` or `CLOVIS_DB` to choose another database path.

```sh
clovis --db ./ledger.db init --currency CAD
clovis --db ./ledger.db --format json account list
```

Record a posted transaction between two accounts that share the same account
currency:

```sh
clovis --db ./ledger.db txn add --date 2026-06-01 --amount 100 \
  --desc "Owner contribution" --from "<equity-account-id>" --to "<checking-id>" \
  --status posted
```

Run reports with an explicit quote currency:

```sh
clovis --db ./ledger.db report balance-sheet --quote CAD
clovis --db ./ledger.db report income-statement --year 2026 --month 6 --quote CAD
```

Import a CSV statement into an existing account. If `--currency` is omitted,
the import uses the account `default_asset`; pass `--currency` when the file
needs to create or use a different explicit asset.

```sh
clovis --db ./ledger.db import --file ./statement.csv \
  --account "<checking-id>" --counterpart "<uncategorized-id>"
```

## MCP

Start the MCP server against a specific local ledger database:

```sh
CLOVIS_DB=./ledger.db clovis-mcp
```

`clovis-mcp` requires `CLOVIS_DB`. File-based MCP tools are limited to the
ledger directory by default. Set `CLOVIS_MCP_ALLOWED_ROOT` to allow imports,
exports, and backups under another local directory.

MCP file operations and destructive operations are disabled unless explicitly
enabled:

```sh
CLOVIS_MCP_CAPABILITIES=filesystem clovis-mcp
CLOVIS_MCP_CAPABILITIES=filesystem,destructive clovis-mcp
```

Use `filesystem` for local file import/export/backup tools. Use `destructive`
for delete, rollback, hard state transition, and non-dry-run bulk mutation
tools.

Example local MCP configuration:

```json
{
  "mcpServers": {
    "clovis": {
      "command": "clovis-mcp",
      "env": {
        "CLOVIS_DB": "/absolute/path/to/ledger.db",
        "CLOVIS_MCP_CAPABILITIES": "filesystem"
      }
    }
  }
}
```

## Package API

`npm install clovis` installs one package. Import the surface you need through
an explicit public entrypoint:

```ts
import { Ledger } from "clovis/core";

const ledger = new Ledger("./ledger.db");
const cad = ledger.createAsset("CAD", "currency", 2, "Canadian Dollar");
ledger.initDefaults("personal", cad);
ledger.close();
```

Use `clovis/app` to call the same tool catalog exposed by MCP:

```ts
import { Ledger } from "clovis/core";
import { callTool } from "clovis/app";

const ledger = new Ledger("./ledger.db");
callTool("init_defaults", { template: "personal", currency: "CAD" }, ledger);
const accounts = callTool("list_accounts", {}, ledger);
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
Account default currencies are stored as account `default_asset` annotations and
exported in ledger snapshots.

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
- `meta`: schema version and database metadata.

## License

Clovis is licensed under AGPL-3.0-or-later. See [LICENSE](LICENSE).

You can freely use, modify, and distribute Clovis under the AGPL. If you run a
modified version as part of a network service, the AGPL requires you to offer
the corresponding source to users who interact with it over the network.

Commercial licenses are available for teams that need to embed Clovis in a
proprietary product without AGPL obligations.

## Release Checks

```sh
npm run release:check
```

The release check runs dependency audit, typecheck, build, the full test suite,
package dry-run, packed-package artifact checks, and packed-package local path
leak checks. The test suite includes a contract row for every MCP tool exposed
by the package.

Official npm releases are published by GitHub Actions through npm Trusted
Publishing. See [RELEASING.md](RELEASING.md) for the full release runbook,
dist-tag policy, post-publish verification commands, and failure recovery steps.
