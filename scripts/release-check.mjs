#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

const root = process.cwd();

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function walk(path, files = []) {
  if (!existsSync(path)) return files;
  const stat = statSync(path);
  if (stat.isFile()) {
    files.push(path);
    return files;
  }
  for (const entry of readdirSync(path)) {
    if ([".git", "node_modules", ".DS_Store"].includes(entry)) continue;
    walk(join(path, entry), files);
  }
  return files;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function scanBlockedFiles() {
  const blockedSuffixes = new Set([".py", ".pyi"]);
  const blockedNames = new Set(["pyproject.toml", "requirements.txt", "requirements-dev.txt"]);
  const files = walk(root);
  const hits = files.filter((file) => blockedSuffixes.has(extname(file)) || blockedNames.has(file.split(/[\\/]/).at(-1) ?? ""));
  if (hits.length) fail(`Blocked runtime artifacts found:\n${hits.join("\n")}`);
}

function scanLocalLeaks() {
  const blocked = [
    { label: ["project", "-clovis"].join(""), pattern: new RegExp(["project", "-clovis"].join(""), "i") },
    { label: ["/", "Users"].join(""), pattern: new RegExp(["/", "Users"].join("")) }
  ];
  const scanRoots = ["README.md", "package.json", "src", "tests", "dist", "scripts"];
  const textExts = new Set([".ts", ".js", ".mjs", ".json", ".md", ".map"]);
  const hits = [];
  for (const scanRoot of scanRoots) {
    for (const file of walk(join(root, scanRoot))) {
      if (!textExts.has(extname(file))) continue;
      const text = readFileSync(file, "utf8");
      for (const item of blocked) {
        if (item.pattern.test(text)) hits.push(`${file}: ${item.label}`);
      }
    }
  }
  if (hits.length) fail(`Blocked local path leakage found:\n${hits.join("\n")}`);
}

run("npm", ["run", "typecheck"]);
run("npm", ["test"]);
run("npm", ["run", "pack:check"]);
scanBlockedFiles();
scanLocalLeaks();
console.log("release check passed");
