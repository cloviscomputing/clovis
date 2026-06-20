# Contributing

## Development

```sh
npm install
npm run typecheck
npm test
npm run release:check
```

The package is ESM-only and requires Node.js `>=26.3.0`.

## Project Boundaries

- `src/core` owns durable ledger state, schema, accounting invariants, and SQLite writes.
- `src/app` owns the tool dispatcher and higher-level workflows.
- `src/cli` and `src/mcp` are transport adapters over the app/core layers.
- Public imports must go through `clovis`, `clovis/core`, `clovis/app`, or `clovis/mcp`.

Run `npm run release:check` before opening a release PR.
