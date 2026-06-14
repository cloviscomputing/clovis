import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { redactToolPath, resolveToolWritePath } from "./filesystem.js";

type Row = Record<string, any>;

const BACKUP_SUFFIXES = new Set([".db", ".sqlite", ".sqlite3"]);

export function resolveBackupWritePath(ledgerPath: string, outputPath?: string | null): string | null {
  return outputPath ? resolveToolWritePath(ledgerPath, outputPath, BACKUP_SUFFIXES) : null;
}

function defaultBackupPreviewPath(ledgerPath: string): string {
  return join(dirname(ledgerPath), "backups", `${new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replaceAll(":", "-")}.db`);
}

export function backupPreview(ledgerPath: string, target: string | null, compact: boolean): Row {
  const previewTarget = target ?? defaultBackupPreviewPath(ledgerPath);
  return {
    dry_run: true,
    would_backup: true,
    path: target ? previewTarget : redactToolPath(ledgerPath, previewTarget),
    compact
  };
}

export function backupResultPublic(ledgerPath: string, result: Row, explicitTarget: boolean, compact: boolean): Row {
  return { ...result, path: explicitTarget ? result.path : redactToolPath(ledgerPath, result.path), compact };
}

export function listBackupFiles(ledgerPath: string): Row[] {
  const dir = join(dirname(ledgerPath), "backups");
  if (!existsSync(dir)) return [];
  const backups = new Map<string, { path: string; sidecars: Row[] }>();
  const sidecars: Array<{ parent: string; row: Row }> = [];
  for (const file of readdirSync(dir)) {
    const path = join(dir, file);
    const stat = statSync(path);
    if (!stat.isFile()) continue;
    const sidecar = file.match(/^(.+\.(?:db|sqlite|sqlite3))-(wal|shm)$/);
    if (sidecar) {
      sidecars.push({
        parent: join(dir, sidecar[1]),
        row: {
          type: sidecar[2],
          path: redactToolPath(ledgerPath, path),
          size_bytes: stat.size,
          modified_at: stat.mtime.toISOString()
        }
      });
      continue;
    }
    if (!BACKUP_SUFFIXES.has(extname(file))) continue;
    backups.set(path, { path, sidecars: [] });
  }
  for (const sidecar of sidecars) backups.get(sidecar.parent)?.sidecars.push(sidecar.row);
  return [...backups.values()]
    .sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs)
    .map((backup) => {
      const stat = statSync(backup.path);
      return {
        path: redactToolPath(ledgerPath, backup.path),
        size_bytes: stat.size,
        modified_at: stat.mtime.toISOString(),
        sidecars: backup.sidecars.sort((a, b) => String(a.type).localeCompare(String(b.type)))
      };
    });
}

export function backupStatus(ledgerPath: string): Row {
  const backups = listBackupFiles(ledgerPath);
  return { count: backups.length, latest: backups[0] ?? null };
}
