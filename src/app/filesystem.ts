import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";

function ledgerDir(ledgerPath: string): string {
  try {
    return realpathSync(resolve(dirname(ledgerPath)));
  } catch {
    return resolve(dirname(ledgerPath));
  }
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

function readCandidatePaths(ledgerPath: string, path: string): string[] {
  if (isAbsolute(path)) return [resolve(path)];
  const besideLedger = resolve(ledgerDir(ledgerPath), path);
  const fromCwd = resolve(path);
  return besideLedger === fromCwd ? [besideLedger] : [besideLedger, fromCwd];
}

export function resolveToolReadPath(ledgerPath: string, path: string, suffixes?: Set<string>): string {
  const requested = readCandidatePaths(ledgerPath, path).find((candidate) => existsSync(candidate));
  if (!requested) throw new Error(`File not found: ${path}`);
  const target = realpathSync(requested);
  checkSuffix(target, suffixes);
  const stat = statSync(target);
  if (!stat.isFile()) throw new Error(`Not a file: ${path}`);
  if (stat.size > maxFileBytes()) throw new Error(`File is too large: ${path}`);
  return target;
}

export function resolveToolWritePath(ledgerPath: string, path: string, suffixes?: Set<string>): string {
  const requested = isAbsolute(path) ? resolve(path) : resolve(ledgerDir(ledgerPath), path);
  let parent: string;
  try {
    parent = realpathSync(dirname(requested));
  } catch {
    throw new Error(`Output directory not found: ${dirname(requested)}`);
  }
  const target = resolve(parent, basename(requested));
  checkSuffix(target, suffixes);
  if (existsSync(target)) throw new Error(`Output file already exists: ${path}`);
  return target;
}

export function redactToolPath(ledgerPath: string, path?: string | null): string | null {
  if (!path) return null;
  const target = existsSync(path) ? realpathSync(path) : resolve(path);
  const root = ledgerDir(ledgerPath);
  const rel = relative(root, target);
  if (rel === "") return ".";
  if (rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel)) return `./${rel}`;
  return target;
}

export function fileAccessStatus(ledgerPath: string): Record<string, unknown> {
  return {
    mode: "unrestricted",
    path_policy: "File tools can read or write requested paths that the operating system permits.",
    ledger_dir: ledgerDir(ledgerPath),
    errors: [],
    max_file_bytes: maxFileBytes(),
    env: {
      CLOVIS_MAX_FILE_BYTES: process.env.CLOVIS_MAX_FILE_BYTES ?? null
    },
    configure: {
      env: "No Clovis path configuration is used.",
      note: "Use operating-system permissions, container sandboxing, or agent runtime policy when you need a hard filesystem boundary."
    }
  };
}
