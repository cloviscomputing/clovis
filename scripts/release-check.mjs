#!/usr/bin/env node
// Local release gate. Keep this stricter than a plain test run: it validates
// source correctness, package contents, and accidental local-path leakage.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

const root = process.cwd();

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
    shell: process.platform === "win32"
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout ?? "";
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function allowedPackedFile(file) {
  // The npm package should contain only runtime artifacts and user-facing docs.
  // Source, tests, local data, and private operational files must never ride
  // along in a published tarball.
  return file === "README.md" ||
    file === "RELEASING.md" ||
    file === "SECURITY.md" ||
    file === "SUPPORT.md" ||
    file === "CONTRIBUTING.md" ||
    file === "CHANGELOG.md" ||
    file === "LICENSE" ||
    file === "package.json" ||
    (file.startsWith("docs/") && file.endsWith(".md")) ||
    (file.startsWith("dist/") && (file.endsWith(".js") || file.endsWith(".d.ts") || file.endsWith(".js.map")));
}

function scanPackedPackage() {
  const output = run("npm", ["pack", "--dry-run", "--json"], true);
  const [packed] = JSON.parse(output);
  const files = packed.files.map((file) => file.path);
  const unexpected = files.filter((file) => !allowedPackedFile(file));
  if (unexpected.length) fail(`Unexpected files in packed package:\n${unexpected.join("\n")}`);

  const textExts = new Set([".ts", ".js", ".mjs", ".json", ".md", ".map"]);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const repositoryName = String(pkg.repository?.url ?? "").match(/\/([^/]+?)(?:\.git)?$/)?.[1] ?? "";
  const allowedNames = new Set([pkg.name, repositoryName].filter(Boolean).map((value) => String(value).toLowerCase()));
  const localNames = [basename(dirname(root)), basename(root)]
    .filter((value) => value && !allowedNames.has(value.toLowerCase()));
  const blockedText = [
    { label: "checkout path", pattern: new RegExp(escapeRegExp(root)) },
    { label: "absolute user path", pattern: /\/Users/ },
    ...localNames.map((value) => ({ label: "local workspace name", pattern: new RegExp(escapeRegExp(value), "i") }))
  ];
  const leaks = [];
  for (const file of files) {
    if (!textExts.has(extname(file))) continue;
    const text = readFileSync(join(root, file), "utf8");
    for (const item of blockedText) {
      if (item.pattern.test(text)) leaks.push(`${file}: ${item.label}`);
    }
  }
  if (leaks.length) fail(`Blocked local path leakage in packed package:\n${leaks.join("\n")}`);
}

function runPrivateScrubIfPresent() {
  const scrub = join(root, "private", "scan-private.mjs");
  if (!existsSync(scrub)) {
    console.log("private scrub skipped: private/scan-private.mjs not present");
    return;
  }
  run(process.execPath, [
    scrub,
    ".github",
    "src",
    "tests",
    "docs",
    "scripts",
    "README.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "SUPPORT.md",
    "RELEASING.md",
    "package.json"
  ]);
}

run("npm", ["run", "security:audit"]);
run("npm", ["run", "typecheck"]);
runPrivateScrubIfPresent();
run("npm", ["test"]);
scanPackedPackage();
console.log("release check passed");
