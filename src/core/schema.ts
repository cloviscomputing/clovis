export const DEFAULT_BOOK_ID = "book_default";
export const SCHEMA_VERSION = 4;

export const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS migration_history (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK(type IN ('actual', 'scenario')),
  parent_id TEXT REFERENCES books(id),
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK(type IN ('currency', 'commodity', 'custom', 'security')),
  scale INTEGER NOT NULL CHECK(scale >= 0 AND scale <= 18 AND scale = CAST(scale AS INTEGER)),
  name TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('asset', 'liability', 'equity', 'income', 'expense')),
  parent_id TEXT,
  default_asset_id TEXT REFERENCES assets(id),
  code TEXT NOT NULL DEFAULT '',
  color_hex TEXT NOT NULL DEFAULT '#888888',
  status TEXT NOT NULL DEFAULT 'active',
  UNIQUE(id, book_id),
  UNIQUE(book_id, name),
  FOREIGN KEY(book_id) REFERENCES books(id),
  FOREIGN KEY(parent_id, book_id) REFERENCES accounts(id, book_id)
);
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id),
  type TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(id, book_id)
);
CREATE TABLE IF NOT EXISTS journals (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  source_id TEXT,
  date TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  finalized_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('posted', 'pending', 'planned', 'void')),
  description TEXT NOT NULL DEFAULT '',
  external_id TEXT,
  UNIQUE(id, book_id),
  FOREIGN KEY(book_id) REFERENCES books(id),
  FOREIGN KEY(source_id, book_id) REFERENCES sources(id, book_id)
);
CREATE INDEX IF NOT EXISTS idx_journals_book_date ON journals(book_id, date, id);
CREATE INDEX IF NOT EXISTS idx_journals_status ON journals(status, date);
CREATE TABLE IF NOT EXISTS journal_lines (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  journal_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  quantity INTEGER NOT NULL,
  memo TEXT NOT NULL DEFAULT '',
  UNIQUE(journal_id, line_no),
  FOREIGN KEY(journal_id, book_id) REFERENCES journals(id, book_id) ON DELETE CASCADE,
  FOREIGN KEY(account_id, book_id) REFERENCES accounts(id, book_id)
);
CREATE INDEX IF NOT EXISTS idx_lines_journal ON journal_lines(journal_id);
CREATE INDEX IF NOT EXISTS idx_lines_account_asset ON journal_lines(account_id, asset_id);
CREATE TABLE IF NOT EXISTS prices (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  quote_asset_id TEXT NOT NULL REFERENCES assets(id),
  rate_value INTEGER NOT NULL CHECK(rate_value > 0),
  rate_scale INTEGER NOT NULL CHECK(rate_scale >= 0 AND rate_scale <= 18 AND rate_scale = CAST(rate_scale AS INTEGER)),
  time TEXT NOT NULL,
  UNIQUE(id, book_id)
);
CREATE INDEX IF NOT EXISTS idx_prices_pair_time ON prices(book_id, asset_id, quote_asset_id, time);
CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_annotations_entity ON annotations(entity_type, entity_id, key);
CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  type TEXT NOT NULL,
  account_id TEXT,
  pattern TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  UNIQUE(id, book_id),
  FOREIGN KEY(book_id) REFERENCES books(id),
  FOREIGN KEY(account_id, book_id) REFERENCES accounts(id, book_id)
);
CREATE INDEX IF NOT EXISTS idx_rules_type_status ON rules(type, status, priority);
CREATE TABLE IF NOT EXISTS targets (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('budget', 'goal')),
  account_id TEXT NOT NULL,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  quantity INTEGER NOT NULL CHECK((type = 'budget' AND quantity >= 0) OR (type = 'goal' AND quantity > 0)),
  period TEXT CHECK(period IS NULL OR period IN ('monthly', 'yearly')),
  year INTEGER,
  month INTEGER CHECK(month IS NULL OR (month >= 1 AND month <= 12)),
  rollover_rule TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  target_date TEXT,
  priority INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  UNIQUE(id, book_id),
  FOREIGN KEY(book_id) REFERENCES books(id),
  FOREIGN KEY(account_id, book_id) REFERENCES accounts(id, book_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_targets_budget ON targets(book_id, type, account_id, asset_id, period, coalesce(year, -1), coalesce(month, -1))
  WHERE type = 'budget';
CREATE UNIQUE INDEX IF NOT EXISTS idx_targets_goal ON targets(book_id, type, account_id, asset_id)
  WHERE type = 'goal';
CREATE TABLE IF NOT EXISTS recurrences (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  next_date TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  from_account_id TEXT NOT NULL,
  to_account_id TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  frequency TEXT NOT NULL CHECK(frequency IN ('daily', 'weekly', 'monthly', 'yearly')),
  end_date TEXT,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'deleted')),
  UNIQUE(id, book_id),
  FOREIGN KEY(book_id) REFERENCES books(id),
  FOREIGN KEY(from_account_id, book_id) REFERENCES accounts(id, book_id),
  FOREIGN KEY(to_account_id, book_id) REFERENCES accounts(id, book_id)
);
CREATE TABLE IF NOT EXISTS period_closes (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id),
  name TEXT NOT NULL,
  as_of TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  reopened_at TEXT,
  UNIQUE(id, book_id)
);
CREATE INDEX IF NOT EXISTS idx_period_closes_book_as_of ON period_closes(book_id, as_of);
CREATE TABLE IF NOT EXISTS lots (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  cost_asset_id TEXT NOT NULL REFERENCES assets(id),
  cost_quantity INTEGER NOT NULL CHECK(cost_quantity > 0),
  opened_journal_id TEXT NOT NULL,
  closed_journal_id TEXT,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'closed')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(id, book_id),
  FOREIGN KEY(book_id) REFERENCES books(id),
  FOREIGN KEY(account_id, book_id) REFERENCES accounts(id, book_id),
  FOREIGN KEY(opened_journal_id, book_id) REFERENCES journals(id, book_id),
  FOREIGN KEY(closed_journal_id, book_id) REFERENCES journals(id, book_id)
);
CREATE TABLE IF NOT EXISTS statement_plans (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  source_id TEXT,
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned', 'applied', 'discarded')),
  statement_kind TEXT NOT NULL DEFAULT '',
  file_name TEXT NOT NULL DEFAULT '',
  file_sha256 TEXT NOT NULL DEFAULT '',
  expected_balance INTEGER,
  planned_balance INTEGER NOT NULL,
  applied_balance INTEGER,
  created_at TEXT NOT NULL,
  applied_at TEXT,
  discarded_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(id, book_id),
  FOREIGN KEY(book_id) REFERENCES books(id),
  FOREIGN KEY(account_id, book_id) REFERENCES accounts(id, book_id),
  FOREIGN KEY(source_id, book_id) REFERENCES sources(id, book_id)
);
CREATE INDEX IF NOT EXISTS idx_statement_plans_account_status ON statement_plans(book_id, account_id, status, created_at);
CREATE TABLE IF NOT EXISTS statement_plan_rows (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  row_index INTEGER NOT NULL,
  date TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  external_id TEXT,
  row_hash TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('matched', 'pending_to_commit', 'new_posted', 'new_pending', 'stale_pending_to_void', 'ambiguous', 'ignored')),
  matched_journal_id TEXT,
  created_journal_id TEXT,
  counterpart_account_id TEXT,
  reason TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(plan_id, row_index),
  FOREIGN KEY(book_id) REFERENCES books(id),
  FOREIGN KEY(plan_id, book_id) REFERENCES statement_plans(id, book_id) ON DELETE CASCADE,
  FOREIGN KEY(matched_journal_id, book_id) REFERENCES journals(id, book_id),
  FOREIGN KEY(created_journal_id, book_id) REFERENCES journals(id, book_id),
  FOREIGN KEY(counterpart_account_id, book_id) REFERENCES accounts(id, book_id)
);
CREATE INDEX IF NOT EXISTS idx_statement_plan_rows_plan_action ON statement_plan_rows(plan_id, action, row_index);
CREATE INDEX IF NOT EXISTS idx_statement_plan_rows_hash ON statement_plan_rows(book_id, row_hash);
CREATE TABLE IF NOT EXISTS ledger_operations (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'applied' CHECK(status IN ('applied', 'reversed')),
  created_at TEXT NOT NULL,
  reversed_at TEXT,
  reversed_by_operation_id TEXT,
  reverses_operation_id TEXT,
  input_json TEXT NOT NULL DEFAULT '{}',
  preview_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(id, book_id),
  FOREIGN KEY(book_id) REFERENCES books(id),
  FOREIGN KEY(reversed_by_operation_id, book_id) REFERENCES ledger_operations(id, book_id),
  FOREIGN KEY(reverses_operation_id, book_id) REFERENCES ledger_operations(id, book_id)
);
CREATE INDEX IF NOT EXISTS idx_ledger_operations_type_status ON ledger_operations(book_id, operation_type, status, created_at);
CREATE TABLE IF NOT EXISTS ledger_operation_rows (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  row_index INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('insert', 'update', 'delete', 'correction', 'reverse')),
  before_hash TEXT,
  after_hash TEXT,
  before_json TEXT,
  after_json TEXT,
  correction_journal_id TEXT,
  reverse_journal_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(operation_id, row_index),
  FOREIGN KEY(book_id) REFERENCES books(id),
  FOREIGN KEY(operation_id, book_id) REFERENCES ledger_operations(id, book_id) ON DELETE CASCADE,
  FOREIGN KEY(correction_journal_id, book_id) REFERENCES journals(id, book_id),
  FOREIGN KEY(reverse_journal_id, book_id) REFERENCES journals(id, book_id)
);
CREATE INDEX IF NOT EXISTS idx_ledger_operation_rows_operation ON ledger_operation_rows(operation_id, row_index);
CREATE TRIGGER IF NOT EXISTS trg_statement_plans_no_identity_update
BEFORE UPDATE OF book_id, account_id, asset_id, statement_kind, file_name, file_sha256, expected_balance, planned_balance, metadata_json, created_at ON statement_plans
BEGIN
  SELECT RAISE(ABORT, 'statement plan identity is immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_statement_plans_status_transition
BEFORE UPDATE OF status ON statement_plans
WHEN OLD.status != NEW.status
BEGIN
  SELECT CASE
    WHEN OLD.status != 'planned'
    THEN RAISE(ABORT, 'statement plan status is final')
  END;
  SELECT CASE
    WHEN NEW.status NOT IN ('applied', 'discarded')
    THEN RAISE(ABORT, 'invalid statement plan status transition')
  END;
  SELECT CASE
    WHEN NEW.status = 'applied' AND NEW.applied_at IS NULL
    THEN RAISE(ABORT, 'applied statement plan requires applied_at')
  END;
  SELECT CASE
    WHEN NEW.status = 'discarded' AND NEW.discarded_at IS NULL
    THEN RAISE(ABORT, 'discarded statement plan requires discarded_at')
  END;
END;
CREATE TRIGGER IF NOT EXISTS trg_statement_plans_no_delete
BEFORE DELETE ON statement_plans
BEGIN
  SELECT RAISE(ABORT, 'statement plans are audit records');
END;
CREATE TRIGGER IF NOT EXISTS trg_statement_plan_rows_no_semantic_update
BEFORE UPDATE OF book_id, plan_id, row_index, date, quantity, description, external_id, row_hash, action, matched_journal_id, counterpart_account_id, reason, metadata_json ON statement_plan_rows
BEGIN
  SELECT RAISE(ABORT, 'statement plan rows are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_statement_plan_rows_created_once
BEFORE UPDATE OF created_journal_id ON statement_plan_rows
WHEN OLD.created_journal_id IS NOT NULL OR NEW.created_journal_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'created_journal_id can only be set once');
END;
CREATE TRIGGER IF NOT EXISTS trg_statement_plan_rows_no_delete
BEFORE DELETE ON statement_plan_rows
BEGIN
  SELECT RAISE(ABORT, 'statement plan rows are audit records');
END;
CREATE TRIGGER IF NOT EXISTS trg_ledger_operations_no_identity_update
BEFORE UPDATE OF book_id, tool_name, operation_type, created_at, reverses_operation_id, input_json, preview_json, result_json, metadata_json ON ledger_operations
BEGIN
  SELECT RAISE(ABORT, 'ledger operations are audit records');
END;
CREATE TRIGGER IF NOT EXISTS trg_ledger_operations_status_transition
BEFORE UPDATE OF status ON ledger_operations
WHEN OLD.status != NEW.status
BEGIN
  SELECT CASE
    WHEN OLD.status != 'applied' OR NEW.status != 'reversed'
    THEN RAISE(ABORT, 'invalid ledger operation status transition')
  END;
  SELECT CASE
    WHEN NEW.reversed_at IS NULL OR NEW.reversed_by_operation_id IS NULL
    THEN RAISE(ABORT, 'reversed ledger operation requires reversal metadata')
  END;
END;
CREATE TRIGGER IF NOT EXISTS trg_ledger_operations_no_delete
BEFORE DELETE ON ledger_operations
BEGIN
  SELECT RAISE(ABORT, 'ledger operations are audit records');
END;
CREATE TRIGGER IF NOT EXISTS trg_ledger_operation_rows_no_update
BEFORE UPDATE ON ledger_operation_rows
BEGIN
  SELECT RAISE(ABORT, 'ledger operation rows are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_ledger_operation_rows_no_delete
BEFORE DELETE ON ledger_operation_rows
BEGIN
  SELECT RAISE(ABORT, 'ledger operation rows are audit records');
END;
CREATE TRIGGER IF NOT EXISTS trg_journals_no_finalized_insert
BEFORE INSERT ON journals
WHEN NEW.finalized_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'insert journal as draft, then finalize');
END;
CREATE TRIGGER IF NOT EXISTS trg_journals_finalize_requires_lines
BEFORE UPDATE OF finalized_at ON journals
WHEN OLD.finalized_at IS NULL AND NEW.finalized_at IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM journal_lines
      WHERE book_id = NEW.book_id AND journal_id = NEW.id
    )
    THEN RAISE(ABORT, 'finalized journal must have lines')
  END;
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM (
        SELECT asset_id, sum(quantity) AS total
        FROM journal_lines
        WHERE book_id = NEW.book_id AND journal_id = NEW.id
        GROUP BY asset_id
        HAVING total != 0
      )
    )
    THEN RAISE(ABORT, 'finalized journal must balance per asset')
  END;
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM period_closes
      WHERE book_id = NEW.book_id
        AND reopened_at IS NULL
        AND as_of >= NEW.date
      LIMIT 1
    )
    THEN RAISE(ABORT, 'journal date is in a closed period')
  END;
END;
CREATE TRIGGER IF NOT EXISTS trg_journals_reopen_guard
BEFORE UPDATE OF finalized_at ON journals
WHEN OLD.finalized_at IS NOT NULL AND NEW.finalized_at IS NULL
BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM period_closes
      WHERE book_id = OLD.book_id
        AND reopened_at IS NULL
        AND as_of >= OLD.date
      LIMIT 1
    )
    THEN RAISE(ABORT, 'cannot reopen journal in a closed period')
  END;
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM lots
      WHERE book_id = OLD.book_id
        AND (opened_journal_id = OLD.id OR closed_journal_id = OLD.id)
      LIMIT 1
    )
    THEN RAISE(ABORT, 'cannot reopen journal linked to investment lots')
  END;
END;
CREATE TRIGGER IF NOT EXISTS trg_lines_no_insert_finalized
BEFORE INSERT ON journal_lines
WHEN EXISTS (
  SELECT 1 FROM journals
  WHERE book_id = NEW.book_id
    AND id = NEW.journal_id
    AND finalized_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'cannot insert lines on finalized journal');
END;
CREATE TRIGGER IF NOT EXISTS trg_lines_no_update_finalized
BEFORE UPDATE ON journal_lines
WHEN EXISTS (
  SELECT 1 FROM journals
  WHERE book_id = OLD.book_id
    AND id = OLD.journal_id
    AND finalized_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'cannot update lines on finalized journal');
END;
CREATE TRIGGER IF NOT EXISTS trg_lines_no_delete_finalized
BEFORE DELETE ON journal_lines
WHEN EXISTS (
  SELECT 1 FROM journals
  WHERE book_id = OLD.book_id
    AND id = OLD.journal_id
    AND finalized_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'cannot delete lines on finalized journal');
END;
`;
