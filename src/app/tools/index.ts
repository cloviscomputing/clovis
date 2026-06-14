import type { ToolDefinition, ToolHandler, ToolRuntimeSafety, ToolSpec } from "../tool-spec.js";
import { toolMutation, toolWorkflow } from "../tool-policy.js";

export function buildToolSpecs<Name extends string>(
  definitions: Record<Name, ToolDefinition>,
  handlers: Record<Name, ToolHandler>,
  safetyFor: (name: Name) => ToolRuntimeSafety
): ToolSpec<Name>[] {
  return Object.entries(definitions).map(([name, definition]) => {
    const toolName = name as Name;
    const safety = safetyFor(toolName);
    return {
      name: toolName,
      definition: definition as ToolDefinition,
      safety,
      workflow: toolWorkflow(toolName),
      mutation: toolMutation(toolName, safety),
      handler: handlers[toolName]
    };
  });
}
