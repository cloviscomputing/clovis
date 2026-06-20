# Releasing Clovis

This runbook is the source of truth for publishing the `clovis` npm package.
Official releases are published by GitHub Actions through npm Trusted
Publishing. Do not publish from a local machine except as an emergency manual
recovery path.

## Release Policy

- Stable releases are GitHub Releases that are not marked prerelease. They
  publish to npm with the `latest` dist-tag.
- Prereleases are GitHub Releases marked prerelease. They publish to npm with
  the `next` dist-tag.
- Release tags must be signed with a maintainer GPG or SSH signing key.
- Patch releases must not break public package exports, CLI command contracts,
  MCP tool signatures, or readable database migrations.
- Minor releases may add public APIs, tools, command flags, reports, and schema
  migrations, but existing 1.x public contracts should keep working unless the
  changelog documents a narrowly scoped compatibility exception.
- Breaking changes to public package exports, CLI command contracts, MCP tool
  signatures, or supported migration paths require a major release.
- The public package entrypoints are `clovis`, `clovis/core`, `clovis/app`, and
  `clovis/mcp`. Do not expose deep imports as public API.

## Pre-Release Checklist

Before bumping the version:

```sh
git status --short
npm run release:check
tmpdir=$(mktemp -d)
node dist/cli/main.js --db "$tmpdir/ledger.db" --format json init --currency CAD >/dev/null
node dist/cli/main.js --db "$tmpdir/ledger.db" --format json tool create_transaction \
  --json '{"date":"2026-06-01","amount":100,"from_account_id":"Salary","to_account_id":"Checking","description":"Release smoke","status":"posted"}' >/dev/null
node dist/cli/main.js --db "$tmpdir/ledger.db" --format json doctor --read-only-tools --quote CAD
```

Confirm:

- `CHANGELOG.md` has an entry for the version being released.
- Any schema, MCP, CLI, or package export changes are documented.
- The read-only doctor passes for status handling, registry metadata, export
  filters, integrity checks, and quote-report smoke coverage.
- `main` is green in GitHub Actions.
- npm Trusted Publishing is still configured for `cloviscomputing/clovis` and
  `.github/workflows/publish.yml`.
- The release tag is signed and verifiable with `git verify-tag v<version>`.

## Stable Release

```sh
npm version patch --sign-git-tag
git push origin main --follow-tags
VERSION=$(node -p "require('./package.json').version")
git verify-tag "v$VERSION"
gh release create "v$VERSION" --generate-notes
```

Wait for the `Publish` workflow to pass, then verify the public package:

```sh
npm run release:status
npm run release:verify
```

Use `npm version minor` instead of `npm version patch` only when the changelog
explicitly documents the compatibility impact.

For the first stable release from the `0.x` line, use:

```sh
npm version major --sign-git-tag
git push origin main --follow-tags
VERSION=$(node -p "require('./package.json').version")
git verify-tag "v$VERSION"
gh release create "v$VERSION" --generate-notes
```

## Prerelease

```sh
npm version prerelease --preid beta --sign-git-tag
git push origin main --follow-tags
VERSION=$(node -p "require('./package.json').version")
git verify-tag "v$VERSION"
gh release create "v$VERSION" --generate-notes --prerelease
```

The publish workflow will use npm's `next` dist-tag for prereleases. After the
workflow passes:

```sh
npm run release:status
npm run release:verify
npm view clovis dist-tags --json
```

## Verification Commands

`npm run release:check` is the local release gate. It runs dependency audit,
typecheck, build, tests, package dry-run, packed artifact allowlist checks, and
packed local path leak checks. On maintainer machines, if
`private/scan-private.mjs` exists, the gate also runs that gitignored private
scrub hook before tests. Keep account suffixes, private names, real merchants,
local workspace paths, and other non-public release-blocking patterns in that
private hook, not in tracked package files.

`node dist/cli/main.js ... doctor --read-only-tools --quote <asset>` is the
local tool-surface smoke check. Run it against a freshly initialized, seeded
ledger and, when possible, a representative real ledger before creating the
GitHub Release.

`npm run release:status` checks that the clean working tree, local tag, GitHub
Release, signed release tag, npm version, npm dist-tag, and npm `gitHead` all
agree.

`npm run release:verify` installs the published npm package into a temporary
consumer project and verifies:

- public package entrypoints import correctly
- deep imports are blocked
- package and CLI versions match
- a fresh CLI ledger can be initialized
- the MCP surface has at least the full v1 tool set and matching signatures
- npm registry signatures and attestations verify

Both commands default to the current `package.json` version. To check another
published version, pass it after `--`, for example
`npm run release:verify -- 0.1.2`.

## Failure Recovery

- If `release:check` fails before tagging, fix the issue and rerun it. Do not
  bump the version until the gate passes.
- If the GitHub Release was created but the Publish workflow failed before npm
  accepted the package, fix the issue, push a new commit, move the tag only if
  the package was not published, and recreate or rerun the release workflow.
- If npm accepted the package, that version is immutable. Fix forward with a
  new patch release; do not try to reuse the same version.
- If npm provenance fails, confirm the repository is public, the workflow has
  `id-token: write`, and npm Trusted Publishing still points to the Publish
  workflow for the `clovis` package.

## Repo Guardrails

- `main` requires the `test` status check.
- Force pushes and branch deletion are disabled on `main`.
- Publish runs are serialized with workflow concurrency.
- Releases publish only from GitHub Release events, never from ordinary pushes.
- The publish workflow uses `id-token: write` and `npm publish --provenance` for
  npm Trusted Publishing/OIDC provenance.
- Post-publish verification checks the npm `gitHead` against the local release
  tag, verifies the signed tag, installs the public package into a temporary
  project, and runs npm signature/attestation checks.
- Dependabot security updates, secret scanning, and push protection should stay
  enabled in GitHub repository settings.
