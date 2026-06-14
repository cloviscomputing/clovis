import type { Ledger } from "../core/ledger.js";

export type ToolValueType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "string[]"
  | "integer[]"
  | "object[]";

export type ToolTypeDefinition = {
  type: ToolValueType;
  nullable?: boolean;
};

export type ToolParameterOptions = {
  nullable?: boolean;
  optional?: boolean;
  defaultValue?: string | number | boolean | null;
};

export type ToolParameterDefinition = readonly [
  name: string,
  type: ToolValueType,
  options?: ToolParameterOptions
];

export type ToolDefinition = {
  parameters: readonly ToolParameterDefinition[];
  returns: ToolTypeDefinition;
};

export type ToolSafetyAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

export type ToolRuntimeSafety = ToolSafetyAnnotations & {
  supportsDryRun: boolean;
  defaultDryRun: boolean;
};

export type ToolWorkflow =
  | "setup"
  | "read"
  | "transactions"
  | "statements"
  | "reports"
  | "budgets"
  | "maintenance"
  | "advanced";

export type ToolMutation = "read" | "write" | "dry-run" | "filesystem";

export type ToolArgs = Record<string, any>;
export type ToolHandler = (ledger: Ledger, args: ToolArgs) => unknown;

export type ToolSpec<Name extends string = string> = {
  name: Name;
  definition: ToolDefinition;
  safety: ToolRuntimeSafety;
  workflow: ToolWorkflow;
  mutation: ToolMutation;
  handler: ToolHandler;
};

export type ToolContract<Name extends string = string> = Omit<ToolSpec<Name>, "handler">;

export function defineToolGroup<const Contracts extends readonly ToolContract[]>(contracts: Contracts): Contracts {
  const seen = new Set<string>();
  for (const contract of contracts) {
    if (!contract.name) throw new Error("Tool contract name is required");
    if (seen.has(contract.name)) throw new Error(`Duplicate tool contract: ${contract.name}`);
    seen.add(contract.name);
    if (!contract.definition) throw new Error(`Tool '${contract.name}' is missing a definition`);
    if (!contract.safety) throw new Error(`Tool '${contract.name}' is missing safety annotations`);
  }
  return contracts;
}

export function bindToolGroup<const Contracts extends readonly ToolContract[]>(
  contracts: Contracts,
  handlers: Record<string, ToolHandler>
): Array<ToolSpec<Contracts[number]["name"]>> {
  return contracts.map((contract) => {
    const handler = handlers[contract.name];
    if (typeof handler !== "function") throw new Error(`Tool '${contract.name}' is missing a handler`);
    return { ...contract, handler };
  });
}

export function defineTools<const Specs extends readonly ToolSpec[]>(specs: Specs): Specs {
  const seen = new Set<string>();
  for (const spec of specs) {
    if (!spec.name) throw new Error("Tool spec name is required");
    if (seen.has(spec.name)) throw new Error(`Duplicate tool spec: ${spec.name}`);
    seen.add(spec.name);
    if (typeof spec.handler !== "function") throw new Error(`Tool '${spec.name}' is missing a handler`);
  }
  return specs;
}

export function toolSpecMap<const Specs extends readonly ToolSpec[]>(specs: Specs): Record<Specs[number]["name"], Specs[number]> {
  return Object.fromEntries(specs.map((spec) => [spec.name, spec])) as Record<Specs[number]["name"], Specs[number]>;
}

export function toolContractMap<const Contracts extends readonly ToolContract[]>(contracts: Contracts): Record<Contracts[number]["name"], Contracts[number]> {
  return Object.fromEntries(contracts.map((contract) => [contract.name, contract])) as Record<Contracts[number]["name"], Contracts[number]>;
}

export function deriveToolNames<const Specs extends readonly ToolSpec[]>(specs: Specs): Array<Specs[number]["name"]> {
  return specs.map((spec) => spec.name) as Array<Specs[number]["name"]>;
}

export function deriveToolDefinitionsFromContracts<const Contracts extends readonly ToolContract[]>(contracts: Contracts): Record<Contracts[number]["name"], ToolDefinition> {
  return Object.fromEntries(contracts.map((contract) => [contract.name, contract.definition])) as Record<Contracts[number]["name"], ToolDefinition>;
}

export function deriveToolDefinitions<const Specs extends readonly ToolSpec[]>(specs: Specs): Record<Specs[number]["name"], ToolDefinition> {
  return Object.fromEntries(specs.map((spec) => [spec.name, spec.definition])) as Record<Specs[number]["name"], ToolDefinition>;
}

export function deriveToolHandlers<const Specs extends readonly ToolSpec[]>(specs: Specs): Record<Specs[number]["name"], ToolHandler> {
  return Object.fromEntries(specs.map((spec) => [spec.name, spec.handler])) as Record<Specs[number]["name"], ToolHandler>;
}
