#!/usr/bin/env node
// Stdio MCP executable. Ledger selection is environment-driven; file tools use
// the shared app layer for validation before touching disk.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mcpDbPathFromEnv } from "../app/context.js";
import { createClovisMcpServer } from "./tools.js";

mcpDbPathFromEnv();
const server = createClovisMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
