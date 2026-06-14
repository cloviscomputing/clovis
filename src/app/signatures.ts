// Signature helpers derive aliases, safety annotations, text signatures, and
// runtime schema hints from the public tool definitions.
import type {
  ToolDefinition,
  ToolParameterDefinition,
  ToolRuntimeSafety,
  ToolSafetyAnnotations,
  ToolTypeDefinition
} from "./tool-spec.js";
import { TOOL_CONTRACT_BY_NAME, TOOL_DEFINITIONS, type ToolSignatureName } from "./tools/definitions.js";

export { TOOL_DEFINITIONS };
export type { ToolSignatureName };

export type {
  ToolDefinition,
  ToolParameterDefinition,
  ToolParameterOptions,
  ToolRuntimeSafety,
  ToolSafetyAnnotations,
  ToolTypeDefinition,
  ToolValueType
} from "./tool-spec.js";


export const STATUS_FILTER_VALUES = ["posted", "pending", "planned", "void", "active", "combined", "all"] as const;

function parameterNames(definition: ToolDefinition): Set<string> {
  return new Set(definition.parameters.map((parameter) => parameter[0]));
}

export function toolAnnotations(name: string): ToolSafetyAnnotations {
  const safety = TOOL_CONTRACT_BY_NAME[name as ToolSignatureName]?.safety;
  return {
    readOnlyHint: safety?.readOnlyHint ?? false,
    destructiveHint: safety?.destructiveHint ?? false,
    idempotentHint: safety?.idempotentHint ?? false,
    openWorldHint: false
  };
}

export function toolSafety(name: string): ToolRuntimeSafety {
  const safety = TOOL_CONTRACT_BY_NAME[name as ToolSignatureName]?.safety;
  if (safety) return safety;
  return { ...toolAnnotations(name), supportsDryRun: true, defaultDryRun: false };
}

const SYNTHETIC_DRY_RUN_PARAMETER = ["dry_run", "boolean", { optional: true, defaultValue: false }] as const satisfies ToolParameterDefinition;

export function effectiveToolDefinition(name: string): ToolDefinition {
  const definition = TOOL_DEFINITIONS[name as ToolSignatureName];
  if (!definition) throw new Error(`Unknown tool: ${name}`);
  if (toolAnnotations(name).readOnlyHint || definition.parameters.some((parameter) => parameter[0] === "dry_run")) return definition;
  return { ...definition, parameters: [...definition.parameters, SYNTHETIC_DRY_RUN_PARAMETER] };
}

export function parameterAliasesForTool(name: string): Record<string, string> {
  const definition = TOOL_DEFINITIONS[name as ToolSignatureName];
  if (!definition) return {};
  const names = parameterNames(definition);
  const aliases: Record<string, string> = {};
  if (names.has("quote_asset_id")) {
    if (!names.has("currency")) aliases.currency = "quote_asset_id";
    if (!names.has("quote")) aliases.quote = "quote_asset_id";
    if (!names.has("quote_id")) aliases.quote_id = "quote_asset_id";
  }
  if (names.has("quote_id")) {
    if (!names.has("quote_asset_id")) aliases.quote_asset_id = "quote_id";
    if (!names.has("quote")) aliases.quote = "quote_id";
  }
  if (names.has("asset_id") && !names.has("asset")) aliases.asset = "asset_id";
  return aliases;
}

export function normalizeToolInput(name: string, input: Record<string, unknown> = {}): Record<string, unknown> {
  const aliases = parameterAliasesForTool(name);
  const normalized = { ...input };
  for (const [alias, target] of Object.entries(aliases)) {
    if (!(alias in normalized)) continue;
    if (target in normalized && normalized[target] !== normalized[alias]) {
      throw new Error(`Use either ${target} or ${alias}, not both`);
    }
    normalized[target] = normalized[alias];
    delete normalized[alias];
  }
  return normalized;
}

function typeDisplay(definition: ToolTypeDefinition): string {
  let rendered: string;
  switch (definition.type) {
    case "string": rendered = "string"; break;
    case "number": rendered = "number"; break;
    case "integer": rendered = "number"; break;
    case "boolean": rendered = "boolean"; break;
    case "object": rendered = "Record<string, unknown>"; break;
    case "array": rendered = "unknown[]"; break;
    case "string[]": rendered = "string[]"; break;
    case "integer[]": rendered = "number[]"; break;
    case "object[]": rendered = "Array<Record<string, unknown>>"; break;
  }
  return definition.nullable ? `${rendered} | null` : rendered;
}

function parameterType(parameter: ToolParameterDefinition): ToolTypeDefinition {
  return { type: parameter[1], nullable: parameter[2]?.nullable };
}

export function renderSignature(definition: ToolDefinition): string {
  const params = definition.parameters
    .map((parameter) => `${parameter[0]}${parameter[2]?.optional ? "?" : ""}: ${typeDisplay(parameterType(parameter))}`)
    .join(", ");
  return `(${params}) => ${typeDisplay(definition.returns)}`;
}

export const TOOL_SIGNATURES = Object.fromEntries(
  Object.keys(TOOL_DEFINITIONS).map((name) => [name, renderSignature(effectiveToolDefinition(name))])
) as { [Name in ToolSignatureName]: string };
