// Compatibility exports for public schemas. The workflow modules own each
// tool contract; this file only derives aggregate lookup maps.
import {
  deriveToolDefinitionsFromContracts,
  toolContractMap
} from "../tool-spec.js";
import { accountTools } from "./accounts.js";
import { budgetTools } from "./budgets.js";
import { maintenanceTools } from "./maintenance.js";
import { reportTools } from "./reports.js";
import { statementTools } from "./statements.js";
import { transactionTools } from "./transactions.js";

export const TOOL_CONTRACTS = [
  ...accountTools,
  ...transactionTools,
  ...statementTools,
  ...reportTools,
  ...budgetTools,
  ...maintenanceTools
] as const;

export const TOOL_CONTRACT_BY_NAME = toolContractMap(TOOL_CONTRACTS);
export const TOOL_DEFINITIONS = deriveToolDefinitionsFromContracts(TOOL_CONTRACTS);

export type ToolSignatureName = keyof typeof TOOL_DEFINITIONS;
