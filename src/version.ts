import { readFileSync } from "node:fs";

type PackageMetadata = { version?: string };

function packageVersion(): string {
  const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as PackageMetadata;
  if (!metadata.version) throw new Error("package.json version is missing");
  return metadata.version;
}

export const VERSION = packageVersion();
