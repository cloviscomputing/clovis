#!/usr/bin/env node
// Stdio MCP executable. Ledger selection is environment-driven; file tools use
// the shared app layer for validation before touching disk.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mcpDbPathFromEnv } from "../app/context.js";
import { VERSION } from "../version.js";
import { createClovisMcpServer } from "./tools.js";

if (process.argv.includes("--version") || process.argv.includes("-V")) {
  console.log(VERSION);
  process.exit(0);
}

mcpDbPathFromEnv();
const server = createClovisMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
