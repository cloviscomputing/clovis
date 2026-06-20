import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, extname, isAbsolute, relative, resolve } from "node:path";

type FilePolicyMode = "unrestricted" | "ledger-dir" | "roots";

const FILE_POLICY_MODES = new Set<FilePolicyMode>(["unrestricted", "ledger-dir", "roots"]);

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

function positiveByteLimit(name: string, fallback: number): number {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function maxFileBytes(): number {
  return positiveByteLimit("CLOVIS_MAX_FILE_BYTES", 10 * 1024 * 1024);
}

function maxLedgerImportBytes(): number {
  return positiveByteLimit("CLOVIS_MAX_LEDGER_IMPORT_BYTES", Number(process.env.CLOVIS_MAX_FILE_BYTES || 100 * 1024 * 1024));
}

export function assertToolDataSize(text: string, maxBytes = maxFileBytes()): void {
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("Input data is too large");
}

export function assertLedgerImportSize(text: string): void {
  assertToolDataSize(text, maxLedgerImportBytes());
}

function readCandidatePaths(ledgerPath: string, path: string): string[] {
  if (isAbsolute(path)) return [resolve(path)];
  const besideLedger = resolve(ledgerDir(ledgerPath), path);
  const fromCwd = resolve(path);
  return besideLedger === fromCwd ? [besideLedger] : [besideLedger, fromCwd];
}

function configuredFilePolicy(): FilePolicyMode {
  const mode = String(process.env.CLOVIS_FILE_POLICY ?? "unrestricted").trim() || "unrestricted";
  if (!FILE_POLICY_MODES.has(mode as FilePolicyMode)) throw new Error(`Invalid CLOVIS_FILE_POLICY: ${mode}`);
  return mode as FilePolicyMode;
}

function realPolicyRoots(): string[] {
  const roots = String(process.env.CLOVIS_FILE_ROOTS ?? "")
    .split(delimiter)
    .map((root) => root.trim())
    .filter(Boolean);
  if (roots.length === 0) throw new Error("CLOVIS_FILE_ROOTS must contain at least one root when CLOVIS_FILE_POLICY=roots");
  return roots.map((root) => realpathSync(resolve(root)));
}

function isWithinRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel));
}

function allowedRoots(ledgerPath: string): string[] {
  const policy = configuredFilePolicy();
  if (policy === "unrestricted") return [];
  if (policy === "ledger-dir") return [ledgerDir(ledgerPath)];
  return realPolicyRoots();
}

function assertPathAllowed(ledgerPath: string, target: string, action: "read" | "write"): void {
  const roots = allowedRoots(ledgerPath);
  if (roots.length === 0) return;
  if (roots.some((root) => isWithinRoot(root, target))) return;
  throw new Error(`File ${action} denied by CLOVIS_FILE_POLICY=${configuredFilePolicy()}: ${target}`);
}

export function resolveToolReadPath(ledgerPath: string, path: string, suffixes?: Set<string>, maxBytes = maxFileBytes()): string {
  const requested = readCandidatePaths(ledgerPath, path).find((candidate) => existsSync(candidate));
  if (!requested) throw new Error(`File not found: ${path}`);
  const target = realpathSync(requested);
  assertPathAllowed(ledgerPath, target, "read");
  checkSuffix(target, suffixes);
  const stat = statSync(target);
  if (!stat.isFile()) throw new Error(`Not a file: ${path}`);
  if (stat.size > maxBytes) throw new Error(`File is too large: ${path}`);
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
  assertPathAllowed(ledgerPath, target, "write");
  checkSuffix(target, suffixes);
  if (existsSync(target)) throw new Error(`Output file already exists: ${path}`);
  return target;
}

export function readToolTextFile(ledgerPath: string, path: string, suffixes?: Set<string>): { path: string; text: string } {
  const target = resolveToolReadPath(ledgerPath, path, suffixes);
  const text = readFileSync(target, "utf8");
  assertToolDataSize(text);
  return { path: target, text };
}

export function readLedgerImportFile(ledgerPath: string, path: string): { path: string; text: string } {
  const target = resolveToolReadPath(ledgerPath, path, new Set([".json"]), maxLedgerImportBytes());
  const text = readFileSync(target, "utf8");
  assertLedgerImportSize(text);
  return { path: target, text };
}

export function writeToolTextFile(ledgerPath: string, path: string, text: string, suffixes?: Set<string>): string {
  const target = resolveToolWritePath(ledgerPath, path, suffixes);
  writeFileSync(target, text, "utf8");
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
  const errors: string[] = [];
  let mode: FilePolicyMode = "unrestricted";
  let roots: string[] = [];
  try {
    mode = configuredFilePolicy();
    roots = mode === "ledger-dir" ? [ledgerDir(ledgerPath)] : mode === "roots" ? realPolicyRoots() : [];
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return {
    mode,
    path_policy: mode === "unrestricted"
      ? "File tools can read or write requested paths that the operating system permits."
      : mode === "ledger-dir"
        ? "File tools can read or write only inside the ledger directory."
        : "File tools can read or write only inside CLOVIS_FILE_ROOTS.",
    ledger_dir: ledgerDir(ledgerPath),
    roots,
    errors,
    max_file_bytes: maxFileBytes(),
    max_ledger_import_bytes: maxLedgerImportBytes(),
    env: {
      CLOVIS_FILE_POLICY: process.env.CLOVIS_FILE_POLICY ?? null,
      CLOVIS_FILE_ROOTS: process.env.CLOVIS_FILE_ROOTS ?? null,
      CLOVIS_MAX_FILE_BYTES: process.env.CLOVIS_MAX_FILE_BYTES ?? null,
      CLOVIS_MAX_LEDGER_IMPORT_BYTES: process.env.CLOVIS_MAX_LEDGER_IMPORT_BYTES ?? null
    },
    configure: {
      env: "Set CLOVIS_FILE_POLICY=ledger-dir or CLOVIS_FILE_POLICY=roots with CLOVIS_FILE_ROOTS to restrict file tools.",
      note: "The default is CLOVIS_FILE_POLICY=unrestricted for local agent workflows; use OS permissions, container sandboxing, or this policy when you need a hard filesystem boundary."
    }
  };
}
