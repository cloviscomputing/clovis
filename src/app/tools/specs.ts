import { handlers, installToolSpecMap } from "../tool-runtime.js";
import { defineTools, deriveToolHandlers, deriveToolNames, toolSpecMap } from "../tool-spec.js";
import { toolSafety } from "../signatures.js";
import { TOOL_DEFINITIONS } from "./definitions.js";
import { buildToolSpecs } from "./index.js";

export const TOOL_SPECS = defineTools(buildToolSpecs(TOOL_DEFINITIONS, handlers, toolSafety));
export const TOOL_SPEC_BY_NAME = toolSpecMap(TOOL_SPECS);
installToolSpecMap(TOOL_SPEC_BY_NAME);

export const TOOL_NAMES = deriveToolNames(TOOL_SPECS);
export const toolHandlers = deriveToolHandlers(TOOL_SPECS);
