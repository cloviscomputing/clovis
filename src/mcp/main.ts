#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mcpDbPathFromEnv } from "../app/context.js";
import { createClovisMcpServer } from "./tools.js";

mcpDbPathFromEnv();
const server = createClovisMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);

