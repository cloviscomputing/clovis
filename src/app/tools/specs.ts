import { handlers, installToolSpecMap } from "../tool-runtime.js";
import { bindToolGroup, defineTools, deriveToolHandlers, deriveToolNames, toolSpecMap } from "../tool-spec.js";
import { TOOL_CONTRACTS } from "./definitions.js";

export const TOOL_SPECS = defineTools(bindToolGroup(TOOL_CONTRACTS, handlers));
export const TOOL_SPEC_BY_NAME = toolSpecMap(TOOL_SPECS);
installToolSpecMap(TOOL_SPEC_BY_NAME);

export const TOOL_NAMES = deriveToolNames(TOOL_SPECS);
export const toolHandlers = deriveToolHandlers(TOOL_SPECS);
