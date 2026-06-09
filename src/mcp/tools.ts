import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodTypeAny } from "zod";
import { callTool } from "../app/catalog.js";
import { TOOL_SIGNATURES } from "./signatures.js";

type Shape = Record<string, ZodTypeAny>;

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (const ch of value) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "[" || ch === "(" || ch === "{") depth += 1;
    if (ch === "]" || ch === ")" || ch === "}") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function schemaFor(annotation: string, optional: boolean): ZodTypeAny {
  const nullable = /\bNone\b/.test(annotation);
  let schema: ZodTypeAny;
  if (/^int\b/.test(annotation)) schema = z.number().int();
  else if (/^float\b/.test(annotation)) schema = z.number();
  else if (/^bool\b/.test(annotation)) schema = z.boolean();
  else if (/^dict\b/.test(annotation)) schema = z.record(z.string(), z.any());
  else if (/^list\[str\]/.test(annotation)) schema = z.array(z.string());
  else if (/^list\[dict\]/.test(annotation)) schema = z.array(z.record(z.string(), z.any()));
  else if (/^list\b/.test(annotation)) schema = z.array(z.any());
  else schema = z.string();
  if (nullable) schema = schema.nullable();
  if (optional) schema = schema.optional();
  return schema;
}

export function inputShapeFromSignature(signature: string): Shape {
  const params = signature.slice(signature.indexOf("(") + 1, signature.lastIndexOf(")"));
  const shape: Shape = {};
  for (const part of splitTopLevel(params)) {
    const [left, ...defaultParts] = part.split("=");
    const optional = defaultParts.length > 0;
    const [nameRaw, annotationRaw = "str"] = left.split(":");
    const name = nameRaw.trim();
    if (!name) continue;
    shape[name] = schemaFor(annotationRaw.trim(), optional);
  }
  return shape;
}

export function createClovisMcpServer(): McpServer {
  const server = new McpServer({ name: "clovis", version: "0.1.0" });
  for (const [name, signature] of Object.entries(TOOL_SIGNATURES)) {
    (server as any).tool(
      name,
      inputShapeFromSignature(signature),
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
