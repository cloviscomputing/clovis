#!/usr/bin/env node
// User-path package verification. Unlike release:check, this installs from the
// public registry into an empty consumer project and exercises the published API.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options
  }).trim();
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = process.argv[2] ?? pkg.version;
if (!version) fail("package.json version is missing");

const dir = mkdtempSync(join(tmpdir(), "clovis-release-verify-"));
try {
  writeFileSync(join(dir, "package.json"), "{\"type\":\"module\"}\n", "utf8");
  run("npm", ["install", `clovis@${version}`, "--ignore-scripts", "--no-audit", "--no-fund", "--silent"], { cwd: dir, timeout: 120_000 });

  // Public exports are the package contract. Deep dist imports must stay
  // blocked so internal files can change without creating accidental APIs.
  const apiCheck = join(dir, "api-check.mjs");
  writeFileSync(apiCheck, [
    "import { Ledger as TopLevelLedger, SCHEMA_VERSION, VERSION } from 'clovis';",
    "import { Ledger } from 'clovis/core';",
    "import { TOOL_NAMES, TOOL_SIGNATURES } from 'clovis/app';",
    "import { createClovisMcpServer } from 'clovis/mcp';",
    "if (TopLevelLedger !== Ledger) throw new Error('top-level Ledger export drifted');",
    `if (VERSION !== ${JSON.stringify(version)}) throw new Error(\`unexpected package version ${"${VERSION}"}\`);`,
    "if (SCHEMA_VERSION !== 2) throw new Error(`unexpected schema version ${SCHEMA_VERSION}`);",
    "if (TOOL_NAMES.length < 134) throw new Error(`unexpected MCP tool count ${TOOL_NAMES.length}`);",
    "if (Object.keys(TOOL_SIGNATURES).length !== TOOL_NAMES.length) throw new Error('tool signature count drift');",
    "let deepImportBlocked = false;",
    "try { await import('clovis/dist/core/ledger.js'); }",
    "catch (error) { deepImportBlocked = error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'; }",
    "if (!deepImportBlocked) throw new Error('deep import was not blocked');",
    "const ledger = new Ledger('./api.db');",
    "const assetId = ledger.createAsset('CAD', 'currency', 2, 'Canadian Dollar');",
    "ledger.initDefaults('personal', assetId);",
    "ledger.close();",
    "console.log(JSON.stringify({ version: VERSION, schemaVersion: SCHEMA_VERSION, tools: TOOL_NAMES.length, signatures: Object.keys(TOOL_SIGNATURES).length, server: Boolean(createClovisMcpServer()), deepImportBlocked }));"
  ].join("\n"), "utf8");

  const api = JSON.parse(run(process.execPath, [apiCheck], { cwd: dir }));
  if (api.version !== version) fail(`installed API version mismatch: expected ${version}, got ${api.version}`);
  if (api.schemaVersion !== 2) fail(`unexpected schema version ${api.schemaVersion}`);
  if (api.tools < 134 || api.signatures !== api.tools) fail(`unexpected MCP surface: ${JSON.stringify(api)}`);
  if (!api.server || !api.deepImportBlocked) fail(`public API smoke failed: ${JSON.stringify(api)}`);

  const binDir = join(dir, "node_modules", ".bin");
  const cliVersion = run(join(binDir, "clovis"), ["--version"], { cwd: dir });
  if (cliVersion !== version) fail(`CLI version mismatch: expected ${version}, got ${cliVersion}`);

  const cliInit = JSON.parse(run(join(binDir, "clovis"), ["--db", join(dir, "smoke.db"), "--format", "json", "init", "--currency", "CAD"], { cwd: dir }));
  if (!cliInit.ok || cliInit.data?.accounts_created !== 12) fail(`CLI init smoke failed: ${JSON.stringify(cliInit)}`);

  const cliTools = JSON.parse(run(join(binDir, "clovis"), ["--db", join(dir, "smoke.db"), "--format", "json", "tools"], { cwd: dir }));
  if (cliTools.count !== api.tools) fail(`CLI tool list drift: ${JSON.stringify(cliTools)}`);

  const cliTool = JSON.parse(run(join(binDir, "clovis"), ["--db", join(dir, "smoke.db"), "--format", "json", "tool", "account_balances", "--json", "{\"account_type\":\"asset\",\"hide_zero\":false}"], { cwd: dir }));
  if (!cliTool.ok || !Array.isArray(cliTool.data) || cliTool.data.length === 0) fail(`CLI generic tool smoke failed: ${JSON.stringify(cliTool)}`);

  run("npm", ["audit", "signatures"], { cwd: dir, timeout: 60_000 });
  console.log(JSON.stringify({ ok: true, version, schemaVersion: api.schemaVersion, tools: api.tools, cliInit: cliInit.data.accounts_created }, null, 2));
} finally {
  if (process.env.CLOVIS_KEEP_RELEASE_VERIFY_DIR !== "1") rmSync(dir, { recursive: true, force: true });
}
