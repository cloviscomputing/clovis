# Security Policy

## Supported Versions

Security fixes are prioritized for the latest published release. During the
pre-1.0 line, fixes are considered for the latest `0.x` release only unless a
maintainer explicitly announces broader support in the release notes.

## Reporting a Vulnerability

Please report security issues privately through one of these routes:

- GitHub private vulnerability reporting:
  <https://github.com/cloviscomputing/clovis/security/advisories/new>
- Email: <security@cloviscomputing.com>

Use the security route for issues involving statement parsing, ledger mutation,
MCP/file access, release provenance, dependency compromise, or anything that
could expose or corrupt financial records.

Do not publish exploit details until a fix or mitigation is available.

Expected response target: acknowledgement within 3 business days, followed by a
fix plan, mitigation, or request for more detail when the report is actionable.

## Local Data

Clovis stores financial records in a local SQLite database. Keep backups, protect
ledger files with normal operating-system permissions, and review imported data
before posting it.

Do not send real statements, ledgers, or exported snapshots in public issues.
If a report needs sample data, redact account numbers, names, transaction
descriptions, balances, and institution identifiers unless a maintainer asks for
a safer private exchange.
