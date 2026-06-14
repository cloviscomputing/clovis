import type { Ledger } from "../core/ledger.js";

type Row = Record<string, any>;

export function scenarioPublic(row: Row): Row {
  return { ...row, merged_at: null, discarded_at: row.closed_at ?? null };
}

export function createScenarioBranch(ledger: Ledger, name: string): Row {
  return scenarioPublic(ledger.createScenarioBook(name));
}

export function listScenarioBranches(ledger: Ledger): Row[] {
  return ledger.listScenarioBooks().map(scenarioPublic);
}

export function resolveOpenScenarioBranch(ledger: Ledger, ref: string): Row {
  const branch = ledger.getScenarioBook(ref);
  if (!branch) throw new Error(`Scenario '${ref}' not found`);
  if (branch.closed_at != null) throw new Error(`Scenario '${ref}' is discarded`);
  return branch;
}

export function discardScenarioBranch(ledger: Ledger, ref: string): { branch: Row; updated: number } {
  const branch = ledger.getScenarioBook(ref);
  if (!branch) throw new Error(`Scenario '${ref}' not found`);
  return { branch, updated: ledger.discardScenarioBook(ref) };
}
