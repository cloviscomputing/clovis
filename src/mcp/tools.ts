import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodTypeAny } from "zod";
import { callTool } from "../app/catalog.js";
import type { JsonValue } from "../app/json.js";
import { OPERATING_MANUAL_INSTRUCTIONS, OPERATING_MANUAL_RESOURCES, operatingManualMarkdown } from "../app/operating-manual.js";
import { TOOL_DEFINITIONS, normalizeToolInput, parameterAliasesForTool, toolAnnotations, type ToolDefinition, type ToolParameterDefinition } from "../app/signatures.js";
import { VERSION } from "../version.js";

type Shape = Record<string, ZodTypeAny>;
type StructuredContent = Record<string, JsonValue>;

// Runtime schemas are intentionally stricter than TypeScript metadata: dates,
// array sizes, and text sizes are bounded before tool handlers run.
const MAX_STRING_LENGTH = 4096;
const MAX_DATA_STRING_LENGTH = 10 * 1024 * 1024;
const MAX_ARRAY_LENGTH = 1000;

function isValidDateString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function isMonthParameter(name: string): boolean {
  return name === "month" || name.endsWith("_month");
}

function isDateParameter(name: string): boolean {
  return name === "date" || name === "as_of" || name === "through" || name === "date_from" || name === "date_to" || name.endsWith("_date");
}

function schemaForParameter(parameter: ToolParameterDefinition): ZodTypeAny {
  let schema: ZodTypeAny;
  const name = parameter[0];
  switch (parameter[1]) {
    case "string":
      if (name === "data") schema = z.string().max(MAX_DATA_STRING_LENGTH);
      else if (isDateParameter(name)) schema = z.string().refine(isValidDateString, `${name} must be a valid YYYY-MM-DD date`);
      else schema = z.string().max(MAX_STRING_LENGTH);
      break;
    case "number":
      schema = z.number();
      break;
    case "integer":
      if (name === "limit") schema = z.number().int().min(1).max(1000);
      else if (name === "offset" || name === "skip_rows" || name === "preview_rows" || name === "sample_limit" || name === "days" || name === "months") schema = z.number().int().min(0).max(10000);
      else if (isMonthParameter(name)) schema = z.number().int().min(1).max(12);
      else schema = z.number().int();
      break;
    case "boolean":
      schema = z.boolean();
      break;
    case "object":
      schema = z.record(z.string(), z.any());
      break;
    case "array":
      schema = z.array(z.any()).max(MAX_ARRAY_LENGTH);
      break;
    case "string[]":
      schema = z.array(z.string().max(MAX_STRING_LENGTH)).max(MAX_ARRAY_LENGTH);
      break;
    case "integer[]":
      schema = z.array(z.number().int()).max(MAX_ARRAY_LENGTH);
      break;
    case "object[]":
      schema = z.array(z.record(z.string(), z.any())).max(MAX_ARRAY_LENGTH);
      break;
  }
  if (parameter[2]?.nullable) schema = schema.nullable();
  if (parameter[2]?.optional) schema = schema.optional();
  return schema;
}

export function inputShapeFromDefinition(definition: ToolDefinition, name?: string): Shape {
  const shape: Shape = {};
  for (const parameter of definition.parameters) {
    shape[parameter[0]] = schemaForParameter(parameter);
  }
  if (name && !toolAnnotations(name).readOnlyHint && !shape.dry_run) {
    shape.dry_run = z.boolean().optional();
  }
  if (name) {
    const parameters = new Map(definition.parameters.map((parameter) => [parameter[0], parameter]));
    for (const [alias, target] of Object.entries(parameterAliasesForTool(name))) {
      const parameter = parameters.get(target);
      if (parameter) shape[alias] = schemaForParameter([alias, parameter[1], { ...parameter[2], optional: true }]);
    }
  }
  return shape;
}

export function inputSchemaFromDefinition(definition: ToolDefinition, name?: string): z.ZodObject<Shape> {
  return z.object(inputShapeFromDefinition(definition, name)).strict();
}

export function parseToolInput(name: string, input: Record<string, unknown> = {}): Record<string, unknown> {
  const definition = TOOL_DEFINITIONS[name as keyof typeof TOOL_DEFINITIONS];
  if (!definition) throw new Error(`Unknown tool: ${name}`);
  return normalizeToolInput(name, inputSchemaFromDefinition(definition, name).parse(input));
}

function structuredToolContent(result: unknown): StructuredContent {
  if (Array.isArray(result)) return { data: result as JsonValue[], count: result.length };
  if (result && typeof result === "object") return result as StructuredContent;
  return { value: result as JsonValue };
}

export function createClovisMcpServer(): McpServer {
  const server = new McpServer({ name: "clovis", version: VERSION }, { instructions: OPERATING_MANUAL_INSTRUCTIONS });
  for (const resource of OPERATING_MANUAL_RESOURCES) {
    server.registerResource(
      resource.name,
      resource.uri,
      { title: resource.title, description: resource.description, mimeType: "text/markdown" },
      async () => ({
        contents: [
          {
            uri: resource.uri,
            mimeType: "text/markdown",
            text: operatingManualMarkdown(resource.topic)
          }
        ]
      })
    );
  }
  for (const [name, definition] of Object.entries(TOOL_DEFINITIONS)) {
    (server as any).registerTool(
      name,
      { inputSchema: inputSchemaFromDefinition(definition, name), annotations: toolAnnotations(name) },
      async (input: Record<string, unknown>) => {
        const result = callTool(name, input ?? {});
        return {
          structuredContent: structuredToolContent(result),
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }
    );
  }
  return server;
}
