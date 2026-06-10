import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodTypeAny } from "zod";
import { callTool } from "../app/catalog.js";
import { TOOL_DEFINITIONS, type ToolDefinition, type ToolParameterDefinition } from "../app/signatures.js";
import { VERSION } from "../version.js";

type Shape = Record<string, ZodTypeAny>;

// Runtime schemas are intentionally stricter than TypeScript metadata: dates,
// array sizes, and text sizes are bounded before tool handlers run.
const MAX_STRING_LENGTH = 4096;
const MAX_DATA_STRING_LENGTH = 10 * 1024 * 1024;
const MAX_ARRAY_LENGTH = 1000;

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
      else if (isDateParameter(name)) schema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, `${name} must be YYYY-MM-DD`);
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

export function inputShapeFromDefinition(definition: ToolDefinition): Shape {
  const shape: Shape = {};
  for (const parameter of definition.parameters) {
    shape[parameter[0]] = schemaForParameter(parameter);
  }
  return shape;
}

export function createClovisMcpServer(): McpServer {
  const server = new McpServer({ name: "clovis", version: VERSION });
  for (const [name, definition] of Object.entries(TOOL_DEFINITIONS)) {
    (server as any).tool(
      name,
      inputShapeFromDefinition(definition),
      async (input: Record<string, unknown>) => {
        const result = callTool(name, input ?? {});
        return {
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
