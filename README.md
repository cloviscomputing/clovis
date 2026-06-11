# Clovis

[![npm version](https://img.shields.io/npm/v/clovis?label=npm)](https://www.npmjs.com/package/clovis)
[![latest](https://img.shields.io/npm/v/clovis/latest?label=latest)](https://www.npmjs.com/package/clovis)
[![CI](https://github.com/cloviscomputing/clovis/actions/workflows/ci.yml/badge.svg)](https://github.com/cloviscomputing/clovis/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/clovis)](LICENSE)
[![node](https://img.shields.io/node/v/clovis)](package.json)

Clovis is a local-first bookkeeping toolkit for people and agents that need a
durable SQLite ledger instead of a hosted finance app. It ships as one npm
package with a double-entry ledger engine, a CLI, Node.js APIs, and an MCP
server for local agent workflows.

Use Clovis when you want to:

- keep financial records in a local SQLite database you control
- import CSV, QFX, or OFX bank statements for review
- run reports and exports from a scriptable CLI
- expose a finance-safe tool surface to local MCP clients
- embed a versioned bookkeeping engine in another Node.js project

Clovis is not a bank, custody system, sync service, tax product, or app UI. The
public surfaces are:

- the SQLite schema created by the ledger engine
- the package exports under `clovis`, `clovis/core`, `clovis/app`, and
  `clovis/mcp`
- the `clovis` CLI
- the `clovis-mcp` server and its MCP tool signatures

The project is public and pre-1.0. The package currently defines the local
database format while the API and schema settle during the `0.x` line.

## Status

The database format is versioned. The current schema is `SCHEMA_VERSION = 2`.
Fresh databases are created directly with schema v2. Schema v1 ledgers are
migrated on open. Ledger JSON snapshots can be exported and imported with
`export_ledger` and `import_ledger`.

Patch releases in the `0.x` line should keep reading schema v1 and v2
databases, preserve public package entrypoints, and avoid removing MCP tools.
Minor releases may revise behavior or database shape, but the changelog should
document the compatibility impact and upgrade path.

## Financial Records

Clovis is designed for local bookkeeping records, but you should treat any
financial database with care:

- keep backups of your ledger file and exported snapshots
- review imported or pending transactions before posting them
- reconcile against source statements
- run `clovis doctor --read-only-tools --quote <asset>` after upgrades

The engine enforces balanced double-entry journals per asset, stores quantities
as integers using each asset's scale, uses SQLite foreign keys, supports period
closes, and ships with contract coverage for every CLI/MCP tool. It is not a
substitute for professional review.

## Currency Model

Clovis does not infer a default currency. Setup requires an explicit currency,
and accounts created by `init_defaults` store it in `accounts.default_asset_id`.
Account APIs expose `default_asset_id` and `default_asset_symbol`.

Transactions may omit `asset_id` only when both accounts have the same
`default_asset`. Cross-currency movement should use `fx_transfer`. Reports that
present converted totals require an explicit `quote_asset_id` or CLI `--quote`
value, and report missing conversions when prices are unavailable.
Tool inputs accept asset ids or symbols for `asset_id` and `quote_asset_id`.
For quote-style tools, `currency`, `quote`, and `quote_id` are aliases for
`quote_asset_id` unless the tool already defines one of those names for another
purpose.

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

## Quickstart

Create a local ledger, add one posted transaction, run a report, and exercise
the read-only diagnostic suite:

```sh
clovis --db ./ledger.db init --currency CAD
clovis --db ./ledger.db txn add \
  --date 2026-06-01 \
  --amount 100 \
  --desc "Opening cash" \
  --from "Opening Balances" \
  --to "Checking" \
  --status posted
clovis --db ./ledger.db report balance-sheet --quote CAD
clovis --db ./ledger.db doctor --read-only-tools --quote CAD
```

By default, the CLI stores its ledger at `~/.clovis/clovis.db`. Use `--db` or
`CLOVIS_DB` whenever you want an explicit database file.

## Update

After a new version is published to npm, update the global CLI and MCP server
with:

```sh
npm install -g clovis@latest
clovis --version
```

Update a project dependency with:

```sh
npm install clovis@latest
```

If your `package.json` semver range already accepts the latest version, you can
also run:

```sh
npm update clovis
```

For one-off use without installing globally:

```sh
npx clovis@latest --help
```

MCP hosts that point to the global `clovis-mcp` binary should be restarted
after the global package is updated.

## CLI

The CLI covers common setup, account, transaction, import/export, and report
flows. The complete app tool catalog is also available through `clovis tool`.

```sh
clovis --db ./ledger.db init --currency CAD
clovis --db ./ledger.db --format json account list
clovis --db ./ledger.db --format json account balances --type asset
```

Record a posted transaction between two accounts that share the same account
currency. Account arguments may be ids or resolvable account names:

```sh
clovis --db ./ledger.db txn add --date 2026-06-01 --amount 100 \
  --desc "Owner contribution" --from "Opening Balances" --to "Checking" \
  --status posted
```

Run reports with an explicit quote currency:

```sh
clovis --db ./ledger.db report balance-sheet --quote CAD
clovis --db ./ledger.db report income-statement --year 2026 --month 6 --quote CAD
```

Import a CSV, QFX, or OFX statement into an existing account. If `--currency`
is omitted, the import uses the account `default_asset`; pass `--currency`
when the file needs to create or use a different explicit asset. CLI imports
default to `pending` so rows can be reviewed before posting.

```sh
clovis --db ./ledger.db import --file ./statement.csv \
  --account "Checking" --counterpart "Uncategorized"
```

Export filtered transaction rows:

```sh
clovis --db ./ledger.db export \
  --account "Checking" \
  --from 2026-06-01 \
  --to 2026-06-30 \
  --status all \
  --output ./checking-june.csv
```

For full CLI parity with the app and MCP catalog, call any public tool by name:

```sh
clovis --db ./ledger.db --format json tools
clovis --db ./ledger.db --format json tool account_balances \
  --json '{"account_type":"asset"}'
clovis --db ./ledger.db --format json tool import_transactions --stdin < args.json
```

Read/filter tools accept these status filters:

- `posted`, `pending`, `planned`, and `void` select one lifecycle status.
- `active` means `posted + pending`.
- `combined` means `posted + pending + planned`.
- `all` means all visible non-void transactions.

In JSON tool calls, explicit `null` is treated like `all` for read/filter
status.
Creation tools still require a real lifecycle status: `posted`, `pending`,
`planned`, or `void`.

File tools only read or write inside configured roots. By default the only root
is the directory that contains the ledger database. Set `CLOVIS_ALLOWED_ROOT`
for one workspace folder, or `CLOVIS_ALLOWED_ROOTS` for multiple folders
separated by your platform path delimiter, `:` on macOS/Linux and `;` on
Windows.

```sh
CLOVIS_ALLOWED_ROOTS="$HOME/Desktop/CFO:$HOME/Downloads" \
  clovis --db ~/.clovis/clovis.db tool file_access_status
```

Agents can call `file_access_status`, or inspect the `file_access` block in
`tool_registry`, before asking for a statement path. If a path is blocked,
Clovis reports the requested path, the allowed roots, and an example
`CLOVIS_ALLOWED_ROOTS` value to restart with.

Bulk mutation tools default to dry-run and require `dry_run:false` in the tool
arguments to apply changes:

```sh
clovis --db ./ledger.db tool backup_now
clovis --db ./ledger.db tool void_by_filter \
  --json '{"status":"planned","date_to":"2026-05-31"}'
clovis --db ./ledger.db tool void_by_filter \
  --json '{"status":"planned","date_to":"2026-05-31","dry_run":false}'
```

Run a built-in read-only smoke pass against a ledger with:

```sh
clovis --db ./ledger.db doctor --read-only-tools --quote CAD
```

The doctor checks the tool registry, status semantics, filtered exports,
integrity, and quote-report paths without mutating the ledger.

## MCP

Start the MCP server against a specific local ledger database:

```sh
CLOVIS_DB=./ledger.db clovis-mcp
```

`clovis-mcp` requires `CLOVIS_DB`. File-based MCP tools are limited to the
ledger directory by default. Set `CLOVIS_ALLOWED_ROOT` for one allowed folder,
or `CLOVIS_ALLOWED_ROOTS` for multiple folders, to allow imports, exports, and
backups under local workspace directories. MCP and CLI tools share the same
catalog and behavior: bulk mutation tools preview by default, and callers must
pass `dry_run:false` or an equivalent commit argument to apply changes.
MCP tools include safety annotations such as `readOnlyHint`,
`destructiveHint`, and `idempotentHint`. The `tool_registry` tool returns the
full shared schema, rendered signatures, parameter aliases, status convention,
file-access configuration, and safety metadata through the normal MCP tool-call
path.

Example local MCP configuration:

```json
{
  "mcpServers": {
    "clovis": {
      "command": "clovis-mcp",
      "env": {
        "CLOVIS_DB": "/absolute/path/to/ledger.db",
        "CLOVIS_ALLOWED_ROOTS": "/absolute/finance/path:/absolute/downloads/path"
      }
    }
  }
}
```

On Windows, separate `CLOVIS_ALLOWED_ROOTS` entries with `;` instead of `:`.

## Package API

`npm install clovis` installs one package. Import through an explicit public
entrypoint:

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
import { callTool, TOOL_NAMES, TOOL_SIGNATURES } from "clovis/app";
import { createClovisMcpServer } from "clovis/mcp";
```

The top-level `clovis` entrypoint is intentionally small:

```ts
import { Ledger, SCHEMA_VERSION } from "clovis";
```

Use `clovis/core` for ledger engine APIs, schema constants, money helpers, and
accounting primitives. Use `clovis/app` for the shared tool dispatcher, tool
name contract, signatures, and tool metadata. Use `clovis/mcp` for MCP server
creation.
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
Account default currencies are stored in `accounts.default_asset_id` and
exported in ledger snapshots. Older `default_asset` annotations are migrated and
remain readable for compatibility.

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
- `migration_history`: applied schema upgrades.

For the complete SQLite schema, persistence flow, and design rationale, see
[docs/sqlite-schema.md](docs/sqlite-schema.md).

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
leak checks. The test suite includes a contract row for every app/MCP tool
exposed by the package.

Official npm releases are published by GitHub Actions through npm Trusted
Publishing. See [RELEASING.md](RELEASING.md) for the full release runbook,
dist-tag policy, post-publish verification commands, and failure recovery steps.
