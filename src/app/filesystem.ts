import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";

// File tools are rooted beside the active ledger unless the host grants a
// narrower or broader root with CLOVIS_ALLOWED_ROOT.
function configuredRoot(ledgerPath: string): string {
  return realpathSync(resolve(process.env.CLOVIS_ALLOWED_ROOT || dirname(ledgerPath)));
}

function underRoot(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel));
}

function checkSuffix(path: string, suffixes?: Set<string>): void {
  if (suffixes && !suffixes.has(extname(path).toLowerCase())) throw new Error(`File suffix not allowed: ${extname(path)}`);
}

function maxFileBytes(): number {
  const value = Number(process.env.CLOVIS_MAX_FILE_BYTES || 10 * 1024 * 1024);
  if (!Number.isFinite(value) || value <= 0) throw new Error("CLOVIS_MAX_FILE_BYTES must be a positive number");
  return value;
}

export function assertToolDataSize(text: string): void {
  if (Buffer.byteLength(text, "utf8") > maxFileBytes()) throw new Error("Input data is too large");
}

function requestedPath(root: string, path: string): string {
  return resolve(isAbsolute(path) ? path : `${root}/${path}`);
}

export function resolveToolReadPath(ledgerPath: string, path: string, suffixes?: Set<string>): string {
  const root = configuredRoot(ledgerPath);
  const requested = requestedPath(root, path);
  if (!existsSync(requested)) throw new Error(`File not found: ${path}`);
  // Reads use realpath to collapse symlinks before the root check.
  const target = realpathSync(requested);
  if (!underRoot(target, root)) throw new Error(`Path escapes allowed root: ${path}`);
  checkSuffix(target, suffixes);
  const stat = statSync(target);
  if (!stat.isFile()) throw new Error(`Not a file: ${path}`);
  if (stat.size > maxFileBytes()) throw new Error(`File is too large: ${path}`);
  return target;
}

export function resolveToolWritePath(ledgerPath: string, path: string, suffixes?: Set<string>): string {
  const root = configuredRoot(ledgerPath);
  const requested = requestedPath(root, path);
  // Writes require an existing real parent and refuse overwrite, which avoids
  // following a final-path symlink or clobbering user data.
  const parent = realpathSync(dirname(requested));
  const target = resolve(parent, basename(requested));
  if (!underRoot(target, root)) throw new Error(`Path escapes allowed root: ${path}`);
  checkSuffix(target, suffixes);
  if (existsSync(target)) throw new Error(`Output file already exists: ${path}`);
  return target;
}

export function redactToolPath(ledgerPath: string, path?: string | null): string | null {
  if (!path) return null;
  try {
    const root = configuredRoot(ledgerPath);
    const target = existsSync(path) ? realpathSync(path) : resolve(path);
    if (underRoot(target, root)) return `.${relative(root, target) ? `/${relative(root, target)}` : ""}`;
  } catch {
    // Fall through to generic redaction.
  }
  return "<outside allowed root>";
}
