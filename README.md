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
