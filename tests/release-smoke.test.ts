import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { TOOL_NAMES } from "../src/app/index.js";

// These tests exercise the package the way consumers do: built MCP stdio,
// packed tarball install, public exports, and installed binaries.
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function withMcpClient(command: string, args: string[], cwd: string, db: string, root: string, fn: (client: Client) => Promise<void>): Promise<void> {
  const transport = new StdioClientTransport({
    command,
    args,
    cwd,
    env: { ...process.env, CLOVIS_DB: db, CLOVIS_MCP_ALLOWED_ROOT: root },
    stderr: "pipe"
  });
  const client = new Client({ name: "clovis-release-smoke", version: "0.0.0" });
  try {
    await client.connect(transport);
    await fn(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

describe("release smoke", () => {
  it("serves the full MCP tool list over stdio from built output", async () => {
    const dir = tempDir("clovis-mcp-smoke-");
    await withMcpClient(process.execPath, ["dist/mcp/main.js"], process.cwd(), join(dir, "ledger.db"), dir, async (client) => {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
      const result = await client.callTool({ name: "init_defaults", arguments: { template: "personal", currency: "USD" } });
      const text = (result.content[0] as { text: string }).text;
      expect(JSON.parse(text).accounts_created).toBeGreaterThan(0);
    });
  }, 30_000);

  it("installs the packed tarball and runs public exports plus both bins", async () => {
    const dir = tempDir("clovis-pack-smoke-");
    const packageVersion = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version as string;
    const packOut = execFileSync("npm", ["pack", "--pack-destination", dir, "--json"], { cwd: process.cwd(), encoding: "utf8", timeout: 60_000 });
    const packed = JSON.parse(packOut)[0] as { filename: string };
    const tarball = join(dir, packed.filename);
    const project = join(dir, "consumer");
    writeFileSync(join(dir, "package.json"), "{\"type\":\"module\"}\n", "utf8");
    execFileSync("npm", ["install", tarball, "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: dir, stdio: "pipe", timeout: 120_000 });

    const apiCheck = join(dir, "api-check.mjs");
    writeFileSync(apiCheck, [
      "import { Ledger as TopLevelLedger, SCHEMA_VERSION, VERSION } from 'clovis';",
      "import { Ledger } from 'clovis/core';",
      "import { TOOL_NAMES } from 'clovis/app';",
      "import { createClovisMcpServer, TOOL_SIGNATURES } from 'clovis/mcp';",
      "if (TopLevelLedger !== Ledger) throw new Error('top-level Ledger export drifted');",
      "let deepImportBlocked = false;",
      "try { await import('clovis/dist/core/ledger.js'); }",
      "catch (error) { deepImportBlocked = error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'; }",
      "if (!deepImportBlocked) throw new Error('deep import was not blocked');",
      "const ledger = new Ledger('./api.db');",
      "const assetId = ledger.createAsset('USD', 'currency', 2, 'US Dollar');",
      "ledger.initDefaults('personal', assetId);",
      "ledger.close();",
      "console.log(JSON.stringify({ tools: TOOL_NAMES.length, signatures: Object.keys(TOOL_SIGNATURES).length, schemaVersion: SCHEMA_VERSION, version: VERSION, server: Boolean(createClovisMcpServer()), deepImportBlocked }));"
    ].join("\n"), "utf8");
    const api = JSON.parse(execFileSync(process.execPath, [apiCheck], { cwd: dir, encoding: "utf8" }));
    expect(api).toEqual({ tools: TOOL_NAMES.length, signatures: TOOL_NAMES.length, schemaVersion: 1, version: packageVersion, server: true, deepImportBlocked: true });

    const binDir = join(dir, "node_modules", ".bin");
    expect(execFileSync(join(binDir, "clovis"), ["--version"], { cwd: dir, encoding: "utf8" }).trim()).toBe(packageVersion);
    const cli = JSON.parse(execFileSync(join(binDir, "clovis"), ["--db", join(dir, "cli.db"), "--format", "json", "init", "--currency", "USD"], { cwd: dir, encoding: "utf8" }));
    expect(cli.ok).toBe(true);
    expect(cli.data.accounts_created).toBeGreaterThan(0);

    await withMcpClient(join(binDir, "clovis-mcp"), [], dir, join(project, "mcp.db"), project, async (client) => {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    });
  }, 120_000);
});
