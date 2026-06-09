import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodTypeAny } from "zod";
import { callTool } from "../app/catalog.js";
import { TOOL_DEFINITIONS, type ToolDefinition, type ToolParameterDefinition } from "./signatures.js";

type Shape = Record<string, ZodTypeAny>;

function schemaForParameter(parameter: ToolParameterDefinition): ZodTypeAny {
  let schema: ZodTypeAny;
  switch (parameter[1]) {
    case "string":
      schema = z.string();
      break;
    case "number":
      schema = z.number();
      break;
    case "integer":
      schema = z.number().int();
      break;
    case "boolean":
      schema = z.boolean();
      break;
    case "object":
      schema = z.record(z.string(), z.any());
      break;
    case "array":
      schema = z.array(z.any());
      break;
    case "string[]":
      schema = z.array(z.string());
      break;
    case "integer[]":
      schema = z.array(z.number().int());
      break;
    case "object[]":
      schema = z.array(z.record(z.string(), z.any()));
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
  const server = new McpServer({ name: "clovis", version: "0.1.0" });
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
