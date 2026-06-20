#!/usr/bin/env node
// Local, dependency-free guard for AI-agent PR boundaries.
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const knownAiAgentActors = new Set([
  "github-copilot[bot]",
  "copilot-swe-agent[bot]",
  "claude[bot]",
  "claude-code[bot]",
  "codex[bot]",
  "openai-codex[bot]",
  "cursor[bot]",
  "devin-ai-integration[bot]",
  "sweep-ai[bot]",
  "openhands[bot]"
]);

const dependencyBotActors = new Set([
  "dependabot[bot]",
  "renovate[bot]"
]);

const humanOnlyPatterns = [
  "AGENTS.md",
  ".github/**",
  "scripts/check-agent-governance.mjs",
  "scripts/release-*.mjs",
  "package.json",
  "package-lock.json",
  "RELEASING.md",
  "SECURITY.md",
  "docs/security-model.md",
  "docs/trust.md"
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function runGit(args, allowFailure = false) {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0 && !allowFailure) {
    fail(`git ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result.status === 0 ? result.stdout.trim() : "";
}

function gitSucceeds(args) {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "ignore", "ignore"]
  });
  return result.status === 0;
}

function readJsonIfPresent(filePath) {
  if (!filePath || !existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`Failed to parse ${filePath}: ${error.message}`);
  }
}

function normalizePath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function patternToRegex(pattern) {
  const normalized = normalizePath(pattern).replace(/^\//, "");
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += escapeRegex(char);
    }
  }
  return new RegExp(`${source}$`);
}

function matchingPatterns(filePath, patterns) {
  const normalized = normalizePath(filePath);
  return patterns.filter((pattern) => patternToRegex(pattern).test(normalized));
}

function splitGitFiles(output) {
  return output
    .split(/\r?\n/)
    .map((line) => normalizePath(line.trim()))
    .filter(Boolean);
}

function uniqueFiles(...fileLists) {
  return Array.from(new Set(fileLists.flat().filter(Boolean)));
}

function ensureCommit(commit) {
  return commit ? gitSucceeds(["cat-file", "-e", `${commit}^{commit}`]) : false;
}

function changedFilesFromGitHubEvent(event) {
  const pr = event.pull_request;
  if (!pr) return [];

  const baseSha = pr.base?.sha;
  const headSha = pr.head?.sha;
  const baseRef = pr.base?.ref;

  if (baseSha && !ensureCommit(baseSha) && baseRef) {
    runGit(["fetch", "--no-tags", "origin", baseRef], true);
  }

  const head = headSha && ensureCommit(headSha) ? headSha : "HEAD";
  if (!baseSha || !ensureCommit(baseSha)) return [];

  return splitGitFiles(runGit(["diff", "--name-only", "--diff-filter=ACDMRTUXB", `${baseSha}...${head}`]));
}

function getChangedFiles(event) {
  const explicit = process.env.AGENT_GOVERNANCE_CHANGED_FILES;
  if (explicit) return splitGitFiles(explicit.replaceAll(",", "\n"));

  const fromEvent = changedFilesFromGitHubEvent(event);
  if (fromEvent.length > 0) return fromEvent;

  const baseRef = process.env.GITHUB_BASE_REF;
  if (baseRef) {
    runGit(["fetch", "--no-tags", "origin", baseRef], true);
    const mergeBase = runGit(["merge-base", "HEAD", `origin/${baseRef}`], true);
    if (mergeBase) {
      return splitGitFiles(runGit(["diff", "--name-only", "--diff-filter=ACDMRTUXB", `${mergeBase}...HEAD`]));
    }
  }

  const base = runGit(["rev-parse", "--verify", "origin/main"], true) ? "origin/main...HEAD" : "HEAD";
  return uniqueFiles(
    splitGitFiles(runGit(["diff", "--name-only", "--diff-filter=ACDMRTUXB", base], true)),
    splitGitFiles(runGit(["diff", "--name-only", "--diff-filter=ACDMRTUXB", "--cached"], true)),
    splitGitFiles(runGit(["diff", "--name-only", "--diff-filter=ACDMRTUXB"], true)),
    splitGitFiles(runGit(["ls-files", "--others", "--exclude-standard"], true))
  );
}

function labelNames(event) {
  const labels = event.pull_request?.labels ?? event.issue?.labels ?? [];
  return labels.map((label) => typeof label === "string" ? label : label.name).filter(Boolean);
}

function detectAiAgent(event) {
  const actor = process.env.GITHUB_ACTOR || event.sender?.login || "";
  const lowerActor = actor.toLowerCase();
  const extraActors = (process.env.AGENT_GOVERNANCE_EXTRA_ACTORS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (dependencyBotActors.has(lowerActor)) {
    return { actor, detected: false, signals: [`dependency bot actor: ${actor}`] };
  }

  const signals = [];
  if (knownAiAgentActors.has(lowerActor) || extraActors.includes(lowerActor)) {
    signals.push(`AI agent actor: ${actor}`);
  }
  if (/\[bot\]$/.test(lowerActor) && /(copilot|claude|codex|cursor|devin|sweep|openhands|aider|sourcegraph|amp)/.test(lowerActor)) {
    signals.push(`AI-like bot actor pattern: ${actor}`);
  }

  const title = event.pull_request?.title || event.issue?.title || "";
  const body = event.pull_request?.body || event.issue?.body || "";
  const text = `${title}\n${body}`;
  for (const pattern of [
    /generated with (claude|codex|copilot|cursor|devin)/i,
    /\b(openai codex|claude code|copilot coding agent|ai-generated|ai generated)\b/i,
    /co-authored-by:.*(claude|codex|copilot|cursor|devin|\[bot\])/i
  ]) {
    if (pattern.test(text)) signals.push(`PR text marker: ${pattern.source}`);
  }

  for (const label of labelNames(event).map((value) => value.toLowerCase())) {
    if (["ai-agent", "ai-generated", "agent", "copilot", "codex", "claude"].includes(label)) {
      signals.push(`PR label: ${label}`);
    }
  }

  return { actor, detected: signals.length > 0, signals };
}

function formatMatches(matches) {
  return matches.map(({ file, patterns }) => `- ${file} (${patterns.join(", ")})`).join("\n");
}

const event = readJsonIfPresent(process.env.GITHUB_EVENT_PATH);
const humanOnlyPolicy = { patterns: humanOnlyPatterns, source: "scripts/check-agent-governance.mjs" };
const changedFiles = getChangedFiles(event);
const detection = detectAiAgent(event);
const blockedMatches = changedFiles
  .map((file) => ({ file, patterns: matchingPatterns(file, humanOnlyPolicy.patterns) }))
  .filter((match) => match.patterns.length > 0);

if (detection.detected && blockedMatches.length > 0) {
  fail([
    "AI-agent PRs may not change human-only governance paths.",
    "",
    `Actor: ${detection.actor || "(unknown)"}`,
    "Signals:",
    ...detection.signals.map((signal) => `- ${signal}`),
    "",
    "Blocked files:",
    formatMatches(blockedMatches),
    "",
    "Ask a maintainer to make these changes from a human-owned branch."
  ].join("\n"));
}

console.log(`agent governance: loaded ${humanOnlyPolicy.patterns.length} human-only pattern(s) from ${humanOnlyPolicy.source}`);
console.log(`agent governance: inspected ${changedFiles.length} changed file(s)`);
if (detection.detected) {
  console.log(`agent governance: detected AI-agent contribution from ${detection.actor || "(unknown)"}`);
  for (const signal of detection.signals) console.log(`agent governance signal: ${signal}`);
} else {
  console.log(`agent governance: no AI-agent contribution detected for actor ${detection.actor || "(local)"}`);
}
