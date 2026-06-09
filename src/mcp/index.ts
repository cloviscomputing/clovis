// MCP entrypoint: server construction plus the structured tool contract used by
// hosts that want to inspect Clovis without launching stdio.
export { createClovisMcpServer } from "./tools.js";
export { TOOL_DEFINITIONS, TOOL_SIGNATURES } from "./signatures.js";
export type { ToolDefinition, ToolParameterDefinition, ToolParameterOptions, ToolSignatureName, ToolTypeDefinition, ToolValueType } from "./signatures.js";
