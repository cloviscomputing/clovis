import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, extname, isAbsolute, relative, resolve } from "node:path";

type RootSource = "ledger_dir" | "CLOVIS_ALLOWED_ROOT" | "CLOVIS_ALLOWED_ROOTS";

type RootSpec = {
  source: RootSource;
  configured: string;
};

type AllowedRoot = RootSpec & {
  path: string;
};

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return resolve(homedir(), path.slice(2));
  return path;
}

function rootSpecs(ledgerPath: string): RootSpec[] {
  const explicit: RootSpec[] = [];
  const single = process.env.CLOVIS_ALLOWED_ROOT?.trim();
  if (single) explicit.push({ source: "CLOVIS_ALLOWED_ROOT", configured: single });
  for (const value of (process.env.CLOVIS_ALLOWED_ROOTS ?? "").split(delimiter).map((part) => part.trim()).filter(Boolean)) {
    explicit.push({ source: "CLOVIS_ALLOWED_ROOTS", configured: value });
  }
  if (explicit.length > 0) return explicit;
  return [{ source: "ledger_dir", configured: dirname(ledgerPath) }];
}

function configuredRoots(ledgerPath: string): AllowedRoot[] {
  const seen = new Set<string>();
  const roots: AllowedRoot[] = [];
  for (const spec of rootSpecs(ledgerPath)) {
    let resolved: string;
    try {
      resolved = realpathSync(resolve(expandHome(spec.configured)));
      if (!statSync(resolved).isDirectory()) throw new Error("allowed root must be a directory");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Configured Clovis allowed root does not exist or cannot be read: ${spec.configured}\nSource: ${spec.source}\n${reason}`);
    }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    roots.push({ ...spec, path: resolved });
  }
  return roots;
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

function suggestedRootForPath(path: string): string {
  let current = resolve(path);
  while (!existsSync(current) && dirname(current) !== current) current = dirname(current);
  if (!existsSync(current)) return dirname(resolve(path));
  try {
    return statSync(current).isDirectory() ? current : dirname(current);
  } catch {
    return dirname(current);
  }
}

function suggestedRoots(ledgerPath: string, requested: string, roots: AllowedRoot[]): string {
  const existing = roots.map((root) => root.path);
  const suggested = suggestedRootForPath(requested);
  const all = [...existing, suggested].filter((value, index, values) => values.indexOf(value) === index);
  return all.join(delimiter);
}

function fileAccessError(ledgerPath: string, requested: string, roots: AllowedRoot[]): Error {
  const renderedRoots = roots.map((root) => `  - ${root.path} (${root.source})`).join("\n") || "  - <none>";
  return new Error([
    "Path is outside Clovis file access.",
    `Requested: ${requested}`,
    "Allowed roots:",
    renderedRoots,
    "Move the file under an allowed root or restart Clovis with:",
    `  CLOVIS_ALLOWED_ROOTS="${suggestedRoots(ledgerPath, requested, roots)}"`
  ].join("\n"));
}

function firstExistingReadPath(ledgerPath: string, path: string, roots: AllowedRoot[]): string {
  if (isAbsolute(path)) return resolve(path);
  for (const root of roots) {
    const requested = requestedPath(root.path, path);
    if (existsSync(requested)) return requested;
  }
  return requestedPath(roots[0]?.path ?? dirname(ledgerPath), path);
}

function rootForPath(path: string, roots: AllowedRoot[]): AllowedRoot | null {
  return roots.find((root) => underRoot(path, root.path)) ?? null;
}

export function resolveToolReadPath(ledgerPath: string, path: string, suffixes?: Set<string>): string {
  const roots = configuredRoots(ledgerPath);
  const requested = firstExistingReadPath(ledgerPath, path, roots);
  if (!existsSync(requested)) {
    if (isAbsolute(path) && !rootForPath(resolve(path), roots)) throw fileAccessError(ledgerPath, resolve(path), roots);
    throw new Error(`File not found: ${path}`);
  }
  // Reads use realpath to collapse symlinks before the root check.
  const target = realpathSync(requested);
  if (!rootForPath(target, roots)) throw fileAccessError(ledgerPath, target, roots);
  checkSuffix(target, suffixes);
  const stat = statSync(target);
  if (!stat.isFile()) throw new Error(`Not a file: ${path}`);
  if (stat.size > maxFileBytes()) throw new Error(`File is too large: ${path}`);
  return target;
}

export function resolveToolWritePath(ledgerPath: string, path: string, suffixes?: Set<string>): string {
  const roots = configuredRoots(ledgerPath);
  const baseRoot = roots[0]?.path ?? dirname(ledgerPath);
  const requested = requestedPath(baseRoot, path);
  // Writes require an existing real parent and refuse overwrite, which avoids
  // following a final-path symlink or clobbering user data.
  let parent: string;
  try {
    parent = realpathSync(dirname(requested));
  } catch {
    if (!rootForPath(resolve(dirname(requested)), roots)) throw fileAccessError(ledgerPath, requested, roots);
    throw new Error(`Output directory not found: ${dirname(requested)}`);
  }
  const target = resolve(parent, basename(requested));
  if (!rootForPath(target, roots)) throw fileAccessError(ledgerPath, target, roots);
  checkSuffix(target, suffixes);
  if (existsSync(target)) throw new Error(`Output file already exists: ${path}`);
  return target;
}

export function redactToolPath(ledgerPath: string, path?: string | null): string | null {
  if (!path) return null;
  try {
    const roots = configuredRoots(ledgerPath);
    const target = existsSync(path) ? realpathSync(path) : resolve(path);
    const root = rootForPath(target, roots);
    if (root) {
      const rel = relative(root.path, target);
      return rel ? `./${rel}` : ".";
    }
  } catch {
    // Fall through to generic redaction.
  }
  return "<outside allowed root>";
}

export function fileAccessStatus(ledgerPath: string): Record<string, unknown> {
  const specs = rootSpecs(ledgerPath);
  const roots: AllowedRoot[] = [];
  const errors: Array<Record<string, string>> = [];
  for (const spec of specs) {
    try {
      const path = realpathSync(resolve(expandHome(spec.configured)));
      if (!statSync(path).isDirectory()) throw new Error("allowed root must be a directory");
      if (!roots.some((root) => root.path === path)) roots.push({ ...spec, path });
    } catch (error) {
      errors.push({ source: spec.source, configured: spec.configured, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const ledgerDir = (() => {
    try {
      return realpathSync(resolve(dirname(ledgerPath)));
    } catch {
      return resolve(dirname(ledgerPath));
    }
  })();
  return {
    ledger_dir: ledgerDir,
    allowed_roots: roots.map((root) => root.path),
    roots,
    errors,
    max_file_bytes: maxFileBytes(),
    env: {
      CLOVIS_ALLOWED_ROOT: process.env.CLOVIS_ALLOWED_ROOT ?? null,
      CLOVIS_ALLOWED_ROOTS: process.env.CLOVIS_ALLOWED_ROOTS ?? null,
      CLOVIS_MAX_FILE_BYTES: process.env.CLOVIS_MAX_FILE_BYTES ?? null
    },
    configure: {
      env: "CLOVIS_ALLOWED_ROOT for one root, or CLOVIS_ALLOWED_ROOTS for multiple roots separated by the platform path delimiter",
      delimiter,
      example: `CLOVIS_ALLOWED_ROOTS="${[ledgerDir, resolve(homedir(), "Downloads"), resolve(homedir(), "Documents", "Finance")].join(delimiter)}"`
    }
  };
}
