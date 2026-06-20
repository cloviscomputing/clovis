# Clovis Security Model

Clovis is local-first bookkeeping software. It gives people, scripts, and local
AI agents a bounded bookkeeping tool surface over a SQLite ledger. It does not
ask for bank credentials and does not run a hosted ledger service.

## Assets

The sensitive assets are:

- local SQLite ledger files and exported snapshots
- bank, card, brokerage, QFX, OFX, and CSV statement files
- derived financial reports and cash-flow projections
- MCP tool calls that can read or mutate the ledger
- backups and exported artifacts written by file tools

## Trust Boundaries

The operating system owns process, user, and filesystem isolation. Clovis
enforces ledger invariants, tool contracts, file-size limits, suffix checks,
overwrite protection, dry-run semantics, and operation audit records. It does
not replace OS sandboxing, containers, dedicated user accounts, or endpoint
security controls.

MCP clients are trusted local clients. The MCP server does not authenticate
individual clients or grant per-client capabilities. Run Clovis under the
identity and filesystem permissions you want the connected agent to have.

## Statement Imports

Statement files are treated as source facts, not trusted books. QFX and OFX are
preferred when available because stable ids improve duplicate detection. CSV is
supported, but banks often omit stable row ids, so date, amount, description,
and account matching matter more.

Imports can be previewed and planned before ledger rows are committed. Review
matched rows, duplicate candidates, stale pending rows, ambiguous rows, and
reconciliation differences before applying a statement plan.

## Ledger Mutation

The ledger engine enforces balanced double-entry journals per asset, SQLite
foreign keys, closed-period checks, and schema migrations. Mutating tools expose
dry-run or preview paths where practical. Applied ledger changes record
operation audit rows with structured diffs and reversal support where the
operation is reversible.

Destructive tools are marked in the tool registry with safety metadata. Agents
and callers should inspect `tool_registry`, prefer read-only tools first, and
use native dry-run or `preview_mutation` before applying broad changes.

## Filesystem Access

File tools default to ordinary filesystem permissions. Use
`CLOVIS_FILE_POLICY=ledger-dir` to keep file tools inside the ledger directory,
or `CLOVIS_FILE_POLICY=roots` with `CLOVIS_FILE_ROOTS=/path/a:/path/b` to allow
only specific roots. For a hard boundary, run the process in an OS sandbox,
container, VM, or dedicated user account.

## Release Integrity

Official npm releases are published by GitHub Actions through npm Trusted
Publishing. Release tags are signed. Post-publish verification checks the
GitHub Release, npm version, npm dist-tag, npm `gitHead`, public package
exports, CLI smoke behavior, MCP surface shape, and npm registry signatures.

## Known Limitations

- Clovis is not a bank, custodian, tax product, account-sync service, or hosted
  finance application.
- A local agent with access to the MCP server should be treated as capable of
  using the advertised Clovis tool surface.
- File policy reduces accidental file access but is not a substitute for OS
  isolation.
- CSV import safety depends on source quality and review because CSV often
  lacks stable transaction ids.
- No independent third-party security audit has been published yet.

## Reporting

Report vulnerabilities privately through GitHub security advisories or
<security@cloviscomputing.com>. Do not attach real statements, ledgers, account
numbers, balances, or personally identifying financial records to public issues.
