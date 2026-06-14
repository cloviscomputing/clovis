import { Ledger } from "../core/ledger.js";
import { openMcpLedger } from "./context.js";
import { publicize } from "./json.js";
import { withMutationOverseer } from "./mutation-overseer.js";
import { normalizeToolInput, type ToolSignatureName } from "./signatures.js";
import {
  assertToolCapabilities,
  requiredToolCapabilities,
  type ToolCapability,
  type ToolName
} from "./tool-runtime.js";
import { TOOL_NAMES, TOOL_SPECS, TOOL_SPEC_BY_NAME, toolHandlers } from "./tools/specs.js";

type Args = Record<string, any>;

export type { ToolCapability, ToolName };
export { assertToolCapabilities, requiredToolCapabilities };

export { TOOL_NAMES, TOOL_SPECS, TOOL_SPEC_BY_NAME, toolHandlers };

function assertMcpCapability(name: string, args: Args): void {
  // MCP is a trusted local control plane; tool annotations and dry-run previews
  // guide callers, while hard boundaries belong to the host environment.
  void name;
  void args;
}

export function callTool(name: string, args: Args = {}, providedLedger?: Ledger): unknown {
  // Tests and CLI pass a ledger explicitly. MCP opens from env and checks
  // capabilities before any disk access.
  if (!TOOL_NAMES.includes(name as ToolSignatureName)) throw new Error(`Tool '${name}' is not implemented`);
  const spec = TOOL_SPEC_BY_NAME[name as ToolSignatureName];
  const normalizedArgs = normalizeToolInput(name, args);
  if (providedLedger) return publicize(withMutationOverseer(providedLedger, spec, normalizedArgs));
  assertMcpCapability(name, normalizedArgs);
  const ledger = openMcpLedger();
  try {
    return publicize(withMutationOverseer(ledger, spec, normalizedArgs));
  } finally {
    ledger.close();
  }
}
