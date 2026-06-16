# Clovis Trust Surface

This page lists the public proof a cautious user can inspect before installing
Clovis on financial data.

## Identity and Links

- npm package: <https://www.npmjs.com/package/clovis>
- Source repository: <https://github.com/cloviscomputing/clovis>
- Website: <https://cloviscomputing.com/>
- Security policy: <https://github.com/cloviscomputing/clovis/security/policy>
- Release runbook: [../RELEASING.md](../RELEASING.md)
- Security model: [security-model.md](security-model.md)
- Support policy: [../SUPPORT.md](../SUPPORT.md)

The package metadata points npm users back to the Clovis Computing website,
GitHub repository, issue tracker, support contact, license, and release
artifacts.

The GitHub organization verifies control of `cloviscomputing.com`, so the npm
package, GitHub repository, website, support mailbox, and security mailbox all
resolve back to the same domain owner.

## Security Contact

Security reports should use GitHub private vulnerability reporting or
<security@cloviscomputing.com>. The source copy of the web `security.txt` file
lives at [../.well-known/security.txt](../.well-known/security.txt) and should
be deployed verbatim to:

```text
https://cloviscomputing.com/.well-known/security.txt
```

The support and security mailboxes authenticate with SPF, DKIM, and DMARC.
DMARC starts in monitor mode so delivery can be observed before enforcement is
raised to quarantine or reject.

## Release Provenance

Releases are controlled by the repository, not a local npm publish:

- CI runs `npm run release:check` on pull requests and pushes to `main`.
- Publishing runs only from GitHub Release events.
- The publish workflow uses npm Trusted Publishing with OIDC and
  `npm publish --provenance`.
- Release tags are signed and verified before release status checks pass.
- `npm run release:status` verifies a clean tree, a signed release tag, the
  GitHub Release, npm dist-tags, and npm `gitHead` alignment.
- `npm run release:verify` installs the public npm package into a temporary
  consumer project, checks public imports, blocks deep imports, smoke-tests the
  CLI, and runs npm registry signature checks.

Useful commands after a release:

```sh
npm view clovis@latest version repository homepage bugs gitHead --json
npm audit signatures
npm run release:status
npm run release:verify
```

## Local Data Posture

Clovis is local-first. It does not ask for bank credentials, does not sync to a
hosted ledger service, and keeps records in a SQLite database controlled by the
user. The CLI, Node API, and MCP server share the same app tool catalog, safety
metadata, and ledger behavior.

Statement files are not automatically trusted. QFX, OFX, and CSV imports can be
previewed, planned, matched, reconciled, and committed only after review.
Mutating tools expose dry-run or preview paths where practical, and applied
ledger changes record operation audit rows with reversal support where the
operation is reversible.

## Known Limitations

- Clovis is bookkeeping software, not a bank, custodian, tax product, or hosted
  account-sync service.
- MCP clients are trusted local clients. The MCP server does not implement
  per-client authentication or per-tool authorization.
- File tools use ordinary filesystem permissions by default. Use
  `CLOVIS_FILE_POLICY=ledger-dir` or `CLOVIS_FILE_POLICY=roots` plus an OS
  sandbox, container, or dedicated user account when the process needs a hard
  filesystem boundary.
- CSV files are weaker evidence than QFX or OFX because they often lack stable
  transaction ids. Prefer QFX/OFX when available.
- Clovis has automated tests, dependency audit gates, release verification, and
  a first-party threat model, but it has not yet published an independent
  third-party security audit.

## Review Targets

The highest-value areas for independent review are statement parsing,
duplicate detection, filesystem policy, MCP mutation safety, destructive ledger
operations, SQLite migration/recovery behavior, package provenance, and
operation-audit reversibility.
