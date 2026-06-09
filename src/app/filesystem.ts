import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { mcpDbPathFromEnv } from "./context.js";

function configuredRoot(): string {
  return realpathSync(resolve(process.env.CLOVIS_MCP_ALLOWED_ROOT || dirname(mcpDbPathFromEnv())));
}

function underRoot(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel));
}

function checkSuffix(path: string, suffixes?: Set<string>): void {
  if (suffixes && !suffixes.has(extname(path).toLowerCase())) throw new Error(`File suffix not allowed: ${extname(path)}`);
}

function maxFileBytes(): number {
  const value = Number(process.env.CLOVIS_MCP_MAX_FILE_BYTES || 10 * 1024 * 1024);
  if (!Number.isFinite(value) || value <= 0) throw new Error("CLOVIS_MCP_MAX_FILE_BYTES must be a positive number");
  return value;
}

export function assertMcpDataSize(text: string): void {
  if (Buffer.byteLength(text, "utf8") > maxFileBytes()) throw new Error("Input data is too large");
}

function requestedPath(root: string, path: string): string {
  return resolve(isAbsolute(path) ? path : `${root}/${path}`);
}

export function resolveMcpReadPath(path: string, suffixes?: Set<string>): string {
  const root = configuredRoot();
  const requested = requestedPath(root, path);
  if (!existsSync(requested)) throw new Error(`File not found: ${path}`);
  const target = realpathSync(requested);
  if (!underRoot(target, root)) throw new Error(`Path escapes allowed root: ${path}`);
  checkSuffix(target, suffixes);
  const stat = statSync(target);
  if (!stat.isFile()) throw new Error(`Not a file: ${path}`);
  if (stat.size > maxFileBytes()) throw new Error(`File is too large: ${path}`);
  return target;
}

export function resolveMcpWritePath(path: string, suffixes?: Set<string>): string {
  const root = configuredRoot();
  const requested = requestedPath(root, path);
  const parent = realpathSync(dirname(requested));
  const target = resolve(parent, basename(requested));
  if (!underRoot(target, root)) throw new Error(`Path escapes allowed root: ${path}`);
  checkSuffix(target, suffixes);
  if (existsSync(target)) throw new Error(`Output file already exists: ${path}`);
  return target;
}

export function redactPath(path?: string | null): string | null {
  if (!path) return null;
  try {
    const root = configuredRoot();
    const target = existsSync(path) ? realpathSync(path) : resolve(path);
    if (underRoot(target, root)) return `.${relative(root, target) ? `/${relative(root, target)}` : ""}`;
  } catch {
    // Fall through to generic redaction.
  }
  return "<outside allowed root>";
}
