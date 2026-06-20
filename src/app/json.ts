import { assertSafeNumber, fromAtomicUnits } from "../core/money.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

// Core keeps money and quantities as bigint. Public JSON can only emit safe
// numbers, so this is the last-mile guard before CLI/MCP responses leave.
export function publicize(value: unknown, path = "value"): JsonValue {
  if (typeof value === "bigint") return assertSafeNumber(value, path);
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value as JsonValue;
  }
  if (Array.isArray(value)) return value.map((item, index) => publicize(item, `${path}[${index}]`));
  if (typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = publicize(item, `${path}.${key}`);
    }
    return out;
  }
  return String(value);
}

export function stringifyPublic(value: unknown, space = 2): string {
  return JSON.stringify(publicize(value), null, space);
}

export function safeJson(value: unknown): Record<string, any> {
  if (value == null || value === "") return {};
  if (typeof value === "object") return value as Record<string, any>;
  try {
    const parsed = JSON.parse(String(value));
    return typeof parsed === "object" && parsed != null ? parsed as Record<string, any> : {};
  } catch {
    return {};
  }
}

export function addDisplayFields<T extends Record<string, unknown>>(row: T, quantityKey: string, assetScale: number, displayKey = "amount_display"): T {
  const value = row[quantityKey];
  if (typeof value === "bigint") {
    row[displayKey as keyof T] = Number(fromAtomicUnits(value, assetScale)) as T[keyof T];
  }
  return row;
}
