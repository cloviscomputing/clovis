import { existsSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { mcpDbPathFromEnv } from "./context.js";

function configuredRoot(): string {
  return resolve(process.env.CLOVIS_MCP_ALLOWED_ROOT || dirname(mcpDbPathFromEnv()));
}

function underRoot(path: string, root: string): boolean {
  const target = resolve(path);
  return target === root || target.startsWith(`${root}/`);
}

function checkSuffix(path: string, suffixes?: Set<string>): void {
  if (suffixes && !suffixes.has(extname(path).toLowerCase())) throw new Error(`File suffix not allowed: ${extname(path)}`);
}

function maxFileBytes(): number {
  return Number(process.env.CLOVIS_MCP_MAX_FILE_BYTES || 10 * 1024 * 1024);
}

export function resolveMcpReadPath(path: string, suffixes?: Set<string>): string {
  const root = configuredRoot();
  const target = resolve(isAbsolute(path) ? path : `${root}/${path}`);
  if (!underRoot(target, root)) throw new Error(`Path escapes allowed root: ${path}`);
  checkSuffix(target, suffixes);
  if (!existsSync(target)) throw new Error(`File not found: ${path}`);
  const stat = statSync(target);
  if (!stat.isFile()) throw new Error(`Not a file: ${path}`);
  if (stat.size > maxFileBytes()) throw new Error(`File is too large: ${path}`);
  return target;
}

export function resolveMcpWritePath(path: string, suffixes?: Set<string>): string {
  const root = configuredRoot();
  const target = resolve(isAbsolute(path) ? path : `${root}/${path}`);
  if (!underRoot(target, root)) throw new Error(`Path escapes allowed root: ${path}`);
  checkSuffix(target, suffixes);
  if (existsSync(target)) throw new Error(`Output file already exists: ${path}`);
  return target;
}

export function redactPath(path?: string | null): string | null {
  if (!path) return null;
  return resolve(path);
}

