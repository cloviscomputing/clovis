export const OPERATING_MANUAL_NAME = "Clovis Operating Manual";
export const OPERATING_MANUAL_VERSION = 1;

export const OPERATING_MANUAL_TOPICS = [
  "all",
  "statement_import",
  "reconciliation",
  "month_end",
  "runway",
  "categorization",
  "safety"
] as const;

export type OperatingManualTopic = typeof OPERATING_MANUAL_TOPICS[number];
type SectionTopic = Exclude<OperatingManualTopic, "all">;

export type OperatingManualGuide = {
  name: string;
  version: number;
  topic: OperatingManualTopic;
  summary: string;
  guidance: string[];
  recommended_tools: string[];
  warnings: string[];
};

type ManualSection = {
  topic: SectionTopic;
  title: string;
  summary: string;
  guidance: string[];
  recommended_tools: string[];
  warnings: string[];
};

type ManualResource = {
  name: string;
  uri: string;
  title: string;
  description: string;
  topic: OperatingManualTopic;
};

export const OPERATING_MANUAL_INSTRUCTIONS = [
  "Use live Clovis data as the source of truth; do not answer from old chat memory when a read-only tool can check the ledger.",
  "Prefer QFX or OFX statement files when available because stable statement ids make duplicate detection safer; CSV remains supported as a fallback.",
  "Create a statement plan before applying statement rows; inspect matches, pending-to-posted rows, stale pending rows, new rows, and ambiguous rows before committing.",
  "Do not treat transfers, credit-card payments, debt movement, or balance moves as spending. Keep cash, liabilities, earmarks, income, and expenses separate.",
  "Use read-only tools and dry-run-capable tools before mutating the ledger. Destructive or bulk tools should be run with explicit intent."
].join("\n");

const SECTIONS = {
  statement_import: {
    topic: "statement_import",
    title: "Statement Import",
    summary: "A statement file is a pile of bank facts. Clovis turns those facts into a review plan first, then writes pending or posted ledger transactions only when the plan is applied.",
    guidance: [
      "Use QFX or OFX when the bank offers it. Those files usually include stable ids such as FITID, which help Clovis recognize the same bank row later.",
      "Use CSV when QFX or OFX is unavailable, incomplete, or malformed. CSV works, but the bank often leaves out stable ids, so date, amount, and description matching matters more.",
      "Preview the file before importing. The preview answers: can Clovis read the file, which columns did it understand, and what rows will it create?",
      "Use refresh_statement when you need the safest path. It previews a plan by default; pass dry_run:false to stage an immutable plan that separates already-matched rows, pending rows to commit, true new rows, stale pending rows to void, and ambiguous rows that need review.",
      "Import direct rows as pending by default. Pending means the row is visible and useful, but not yet trusted as final bookkeeping.",
      "Before committing, reconcile against the statement and check duplicate candidates. A clean plan is boring: expected rows, expected balance, no unexplained extras.",
      "Commit only after review. If the import looks wrong, discard the batch or fix the mapping instead of posting bad rows and cleaning them up later."
    ],
    recommended_tools: [
      "file_access_status",
      "preview_import",
      "refresh_statement",
      "reconcile_statement_plan",
      "process_statement",
      "import_file",
      "find_pending_duplicates",
      "commit_batch",
      "discard_batch",
      "void_by_filter"
    ],
    warnings: [
      "Do not commit a fresh import just because parsing succeeded. Parsing only proves the file was readable.",
      "File tools use ordinary filesystem permissions. If a path fails, check the actual file path, suffix, file size, and operating-system permissions.",
      "If CSV descriptions change between exports, duplicate detection is weaker than QFX/OFX stable-id matching."
    ]
  },
  reconciliation: {
    topic: "reconciliation",
    title: "Reconciliation",
    summary: "Reconciliation is the part where Clovis proves that its ledger story agrees with an outside source, usually a bank or card statement.",
    guidance: [
      "Start from the source statement. The statement is the receipt for what the bank says happened.",
      "Compare statement rows with posted and pending ledger rows for the same account, date range, and currency.",
      "Treat duplicate candidates as questions, not automatic truth. Same date and amount can be a duplicate, but it can also be two real purchases.",
      "Use expected ending balance when you have it. Matching rows plus matching balance is much stronger than matching rows alone.",
      "Preserve transfer intent. A payment from Checking to Visa is not dining, rent, or shopping; it is debt movement between accounts.",
      "When reconciliation finds a mismatch, fix the narrowest cause: mapping, missing row, duplicate row, wrong account, wrong sign, or wrong status."
    ],
    recommended_tools: [
      "reconcile_statement_plan",
      "refresh_statement",
      "reconcile_diff",
      "reconcile_statement",
      "inspect_transaction",
      "list_transactions",
      "find_pending_duplicates",
      "integrity_check"
    ],
    warnings: [
      "A balanced journal can still be the wrong journal. Double-entry prevents broken math, not bad categorization.",
      "Do not resolve reconciliation mismatches by changing historical posted data unless you know which source fact was wrong.",
      "Transfers should explain movement between balance-sheet accounts; they should not inflate expense reports."
    ]
  },
  month_end: {
    topic: "month_end",
    title: "Month End",
    summary: "Month end is a snapshot exercise: what came in, what went out, what is still pending, what cash is spendable, and what obligations remain.",
    guidance: [
      "Separate assets from liabilities. Cash in Checking and debt on Visa are both real, but they answer different questions.",
      "Use liability-aware projections for credit cards and debt. Spendable cash is not the same thing as gross cash.",
      "Include earmarks and goals when explaining available money. Money can be present but already assigned.",
      "Check pending rows before judging the month. Pending card charges and imports can change the practical picture.",
      "Use budgets to explain variance, not just totals. A month-end answer should say which categories are driving the result.",
      "Run integrity checks before giving final numbers. If the ledger is structurally unhealthy, the report is not ready."
    ],
    recommended_tools: [
      "cash_projection",
      "project_month_end",
      "financial_picture",
      "financial_overview",
      "budget_summary",
      "budget_status",
      "pending_summary",
      "integrity_check"
    ],
    warnings: [
      "Do not call all cash spendable when liabilities or earmarks are waiting to be paid.",
      "Do not mix planned, pending, and posted rows without saying which universe the answer uses.",
      "Month-end projections are assumptions. State expected inflows, expected outflows, included accounts, and quote asset."
    ]
  },
  runway: {
    topic: "runway",
    title: "Cash Runway",
    summary: "Cash runway is how long spendable cash lasts under explicit burn assumptions. Clovis treats this as a conservative report, not a net-worth shortcut.",
    guidance: [
      "Start with cash_runway. It defaults to posted actual cash, deducts liabilities, excludes planned and pending rows, and keeps obvious investment accounts out of default spendable cash.",
      "Use include_pending:true or include_planned:true only when the answer should explicitly become a projection.",
      "Read the burn models separately: budget burn, trailing actual burn, fixed-obligation burn, and discretionary-adjusted burn answer different questions.",
      "Use cash_projection when you need the audit trail behind spendable cash: starting cash, liabilities, earmarks, remaining budget, and planned income.",
      "Remove earmarked money when it is not available for general spending. A tax reserve or rent reserve is not free cash.",
      "State the quote asset, included accounts, included statuses, and burn assumptions in the answer.",
      "Use scenarios for what-if work instead of rewriting actual history."
    ],
    recommended_tools: [
      "cash_runway",
      "cash_projection",
      "budget_summary",
      "spending_rate",
      "spending",
      "net_worth",
      "balance_sheet",
      "forecast",
      "compare_scenarios"
    ],
    warnings: [
      "Net worth is not runway. Illiquid investments and unpaid card balances can make net worth look better than cash reality.",
      "Planned paycheques are not current cash. If they are included, say that the answer is a projection.",
      "Missing currency conversions need severity. A tiny missing balance may be noise; a large missing balance can invalidate the answer.",
      "Average spend can hide annual or irregular obligations. Look for rent, taxes, insurance, subscriptions, and debt payments.",
      "Runway answers should be ranges when inputs are uncertain."
    ]
  },
  categorization: {
    topic: "categorization",
    title: "Categorization",
    summary: "Categorization names what a transaction means. The ledger already knows money moved; categories explain why it moved.",
    guidance: [
      "Categorize the economic event, not just the merchant string. A card payment is a transfer; a restaurant charge is dining.",
      "Use durable match rules only for stable merchants and stable meanings. A broad rule can silently corrupt future imports.",
      "Keep Uncategorized as a review queue, not a permanent home.",
      "Audit repeated descriptions before applying bulk changes. Repetition is a clue, not proof.",
      "Prefer dry-run recategorization first so you can see the affected rows.",
      "After bulk categorization, inspect totals and a sample of changed transactions."
    ],
    recommended_tools: [
      "audit_categorization",
      "apply_match_rules",
      "recategorize_transaction",
      "recategorize_by_pattern",
      "recategorize_by_patterns",
      "top_descriptions",
      "list_uncategorized",
      "inspect_transaction"
    ],
    warnings: [
      "Do not create catch-all rules that classify every unknown merchant as real spending.",
      "Do not categorize transfers, refunds, reimbursements, or credit-card payments as ordinary expenses without checking both sides.",
      "Bulk recategorization should be dry-run first unless the affected rows were already inspected."
    ]
  },
  safety: {
    topic: "safety",
    title: "Safety",
    summary: "Safety means Clovis should be useful to agents without making it easy for an agent to damage the ledger by accident.",
    guidance: [
      "Prefer read-only tools first. They are safe for discovery, diagnosis, and explanation.",
      "Read MCP annotations before routing calls. readOnlyHint, destructiveHint, and idempotentHint are machine-readable safety labels.",
      "Use dry-run-capable tools in preview mode before applying changes. The preview is the change request.",
      "Back up before destructive or broad edits. Backups are cheap compared with manual reconstruction.",
      "Use file_access_status when a statement path fails. It reports the current path policy, max file size, and relevant filesystem configuration.",
      "Run doctor or integrity checks after upgrades and before important month-end work."
    ],
    recommended_tools: [
      "tool_registry",
      "file_access_status",
      "backup_status",
      "backup_now",
      "integrity_check",
      "preview_commit"
    ],
    warnings: [
      "Destructive tools should not be called speculatively.",
      "A dry-run result is not a committed result. The caller must pass the explicit commit or dry_run:false argument to apply supported mutations.",
      "Clovis can organize bookkeeping facts, but it is not a bank, tax advisor, custody system, or substitute for professional review."
    ]
  }
} as const satisfies Record<SectionTopic, ManualSection>;

const TOPIC_SET = new Set<string>(OPERATING_MANUAL_TOPICS);

function normalizeTopic(value: unknown): OperatingManualTopic {
  if (value == null || value === "") return "all";
  const topic = String(value).trim().toLowerCase().replaceAll("-", "_");
  if (TOPIC_SET.has(topic)) return topic as OperatingManualTopic;
  throw new Error(`Unsupported operating manual topic '${String(value)}'. Use one of: ${OPERATING_MANUAL_TOPICS.join(", ")}`);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function allGuide(): OperatingManualGuide {
  const sections = Object.values(SECTIONS);
  return {
    name: OPERATING_MANUAL_NAME,
    version: OPERATING_MANUAL_VERSION,
    topic: "all",
    summary: "Clovis is a local-first bookkeeping system. The safe workflow is simple: read live ledger data, import statements as pending, reconcile before posting, keep transfers separate from spending, and use dry-runs before mutation.",
    guidance: [
      "Use live Clovis data as the source of truth. Old chat memory is context, not evidence.",
      "Prefer QFX or OFX imports when available because stable statement ids make repeat imports safer. Use CSV as the fallback.",
      "Pending rows are the review table. Posted rows are accounting history. Keep that line clear.",
      "Reconcile to outside statements before committing imported batches.",
      "Do not treat transfers, credit-card payments, debt movement, or balance moves as spending.",
      "For month-end and runway work, separate cash, liabilities, earmarks, income, expenses, and planned assumptions.",
      "Use MCP safety annotations, read-only tools, backups, and dry-runs before applying broad changes."
    ],
    recommended_tools: unique(sections.flatMap((section) => section.recommended_tools)),
    warnings: unique(sections.flatMap((section) => section.warnings))
  };
}

export function operatingManual(topicInput?: unknown): OperatingManualGuide {
  const topic = normalizeTopic(topicInput);
  if (topic === "all") return allGuide();
  const section = SECTIONS[topic];
  return {
    name: OPERATING_MANUAL_NAME,
    version: OPERATING_MANUAL_VERSION,
    topic,
    summary: section.summary,
    guidance: [...section.guidance],
    recommended_tools: [...section.recommended_tools],
    warnings: [...section.warnings]
  };
}

function renderSection(section: ManualSection): string {
  return [
    `## ${section.title}`,
    "",
    section.summary,
    "",
    "Guidance:",
    ...section.guidance.map((item) => `- ${item}`),
    "",
    "Recommended tools:",
    ...section.recommended_tools.map((tool) => `- \`${tool}\``),
    "",
    "Warnings:",
    ...section.warnings.map((item) => `- ${item}`)
  ].join("\n");
}

export function operatingManualMarkdown(topicInput?: unknown): string {
  const topic = normalizeTopic(topicInput);
  const intro = [
    `# ${OPERATING_MANUAL_NAME}`,
    "",
    "Clovis is a local-first bookkeeping system for people and agents. It keeps financial facts in a SQLite double-entry ledger and exposes a CLI, Node API, and MCP server over the same app catalog.",
    "",
    "The main idea is simple: let the ledger remember facts, let pending rows hold uncertainty, let reconciliation decide trust, and let reports explain only the universe they actually queried.",
    "",
    "This guide is operational guidance, not financial, tax, or legal advice."
  ].join("\n");
  if (topic !== "all") return `${intro}\n\n${renderSection(SECTIONS[topic])}\n`;
  return [
    intro,
    "",
    "## First Principles",
    "",
    "- Live Clovis data is the source of truth. Chat history is not.",
    "- Pending is review. Posted is history. Planned is intent.",
    "- QFX and OFX are preferred for imports when available because stable ids make duplicate detection safer. CSV remains supported.",
    "- Transfers move balances. Expenses consume money. Do not mix them.",
    "- Read-only and dry-run tools should come before mutation.",
    "",
    ...Object.values(SECTIONS).map(renderSection)
  ].join("\n\n") + "\n";
}

export const OPERATING_MANUAL_RESOURCES = [
  {
    name: "clovis_operating_manual",
    uri: "clovis://manual",
    title: OPERATING_MANUAL_NAME,
    description: "Full operational guide for using Clovis safely through CLI, app tools, and MCP.",
    topic: "all"
  },
  {
    name: "clovis_statement_import_manual",
    uri: "clovis://manual/statement-import",
    title: "Clovis Statement Import Manual",
    description: "Statement import workflow, QFX/OFX guidance, pending review, duplicate checks, and commit safety.",
    topic: "statement_import"
  },
  {
    name: "clovis_month_end_manual",
    uri: "clovis://manual/month-end",
    title: "Clovis Month-End Manual",
    description: "Month-end projection and reporting guidance for assets, liabilities, earmarks, pending rows, and budgets.",
    topic: "month_end"
  },
  {
    name: "clovis_runway_manual",
    uri: "clovis://manual/runway",
    title: "Clovis Cash Runway Manual",
    description: "Cash runway guidance for spendable cash, burn assumptions, projections, and scenario work.",
    topic: "runway"
  },
  {
    name: "clovis_safety_manual",
    uri: "clovis://manual/safety",
    title: "Clovis Safety Manual",
    description: "Agent safety guidance for read-only tools, dry-runs, backups, destructive tools, and file access.",
    topic: "safety"
  }
] as const satisfies readonly ManualResource[];
