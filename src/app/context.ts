import { homedir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../core/ledger.js";

// CLI defaults to the user ledger; MCP must be explicit through CLOVIS_DB so an
// agent host cannot accidentally open a developer's personal database.
export function defaultDbPath(): string {
  return join(homedir(), ".clovis", "clovis.db");
}

export function dbPathFromEnv(): string {
  return process.env.CLOVIS_DB || defaultDbPath();
}

export function mcpDbPathFromEnv(): string {
  const db = process.env.CLOVIS_DB;
  if (!db) throw new Error("CLOVIS_DB must be set for clovis-mcp");
  return db;
}

export function openLedger(dbPath?: string | null): Ledger {
  return new Ledger(dbPath || dbPathFromEnv());
}

export function openMcpLedger(): Ledger {
  return new Ledger(mcpDbPathFromEnv());
}
