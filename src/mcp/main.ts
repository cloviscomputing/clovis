#!/usr/bin/env node
// Stdio MCP executable. All ledger selection and filesystem permissions are
// environment-driven so hosts can sandbox the server before launch.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mcpDbPathFromEnv } from "../app/context.js";
import { createClovisMcpServer } from "./tools.js";

mcpDbPathFromEnv();
const server = createClovisMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
