import { readFileSync } from "node:fs";

type PackageMetadata = { version?: string };

// Read package metadata at runtime so the CLI, MCP server, and package export
// cannot silently drift from the npm version being installed or published.
function packageVersion(): string {
  const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as PackageMetadata;
  if (!metadata.version) throw new Error("package.json version is missing");
  return metadata.version;
}

export const VERSION = packageVersion();
