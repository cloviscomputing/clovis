// MCP entrypoint: server construction plus the structured tool contract used by
// hosts that want to inspect Clovis without launching stdio.
export { createClovisMcpServer } from "./tools.js";
export { normalizeToolInput, parameterAliasesForTool, STATUS_FILTER_VALUES, TOOL_DEFINITIONS, TOOL_SIGNATURES, toolAnnotations, toolSafety } from "../app/signatures.js";
export type { ToolDefinition, ToolParameterDefinition, ToolParameterOptions, ToolSafetyAnnotations, ToolSignatureName, ToolTypeDefinition, ToolValueType } from "../app/signatures.js";
