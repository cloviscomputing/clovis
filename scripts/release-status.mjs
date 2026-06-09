#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options
  }).trim();
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readJson(command, args) {
  return JSON.parse(run(command, args));
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = process.argv[2] ?? pkg.version;
const tag = `v${version}`;

if (!version) fail("package.json version is missing");

const dirty = run("git", ["status", "--porcelain"]);
if (dirty) fail(`Working tree is dirty:\n${dirty}`);

const head = run("git", ["rev-parse", "HEAD"]);
let tagCommit;
try {
  tagCommit = run("git", ["rev-parse", `${tag}^{commit}`]);
} catch {
  fail(`Missing git tag ${tag}`);
}
if (head !== tagCommit) fail(`HEAD ${head} does not match ${tag} commit ${tagCommit}`);

const npmInfo = readJson("npm", ["view", `clovis@${version}`, "version", "gitHead", "dist-tags", "--json"]);
if (npmInfo.version !== version) fail(`npm version mismatch: expected ${version}, got ${npmInfo.version}`);
if (npmInfo.gitHead !== tagCommit) fail(`npm gitHead mismatch: expected ${tagCommit}, got ${npmInfo.gitHead}`);
if (npmInfo["dist-tags"]?.latest !== version && npmInfo["dist-tags"]?.next !== version) {
  fail(`npm dist-tags do not point to ${version}: ${JSON.stringify(npmInfo["dist-tags"] ?? {})}`);
}

const release = readJson("gh", ["release", "view", tag, "--json", "tagName,isDraft,isPrerelease,publishedAt,url"]);
if (release.tagName !== tag) fail(`GitHub release tag mismatch: expected ${tag}, got ${release.tagName}`);
if (release.isDraft) fail(`${tag} is still a draft release`);

console.log(JSON.stringify({
  ok: true,
  version,
  tag,
  commit: tagCommit,
  npmDistTags: npmInfo["dist-tags"],
  githubRelease: release.url,
  prerelease: release.isPrerelease
}, null, 2));
