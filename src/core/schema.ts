export const DEFAULT_BOOK_ID = "book_default";
export const SCHEMA_VERSION = 1;

export const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
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
  scale INTEGER NOT NULL CHECK(scale >= 0),
  name TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('asset', 'liability', 'equity', 'income', 'expense')),
  parent_id TEXT REFERENCES accounts(id),
  code TEXT NOT NULL DEFAULT '',
  color_hex TEXT NOT NULL DEFAULT '#888888',
  status TEXT NOT NULL DEFAULT 'active',
  UNIQUE(book_id, name)
);
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS journals (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id),
  source_id TEXT REFERENCES sources(id),
  date TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('posted', 'pending', 'planned', 'void')),
  description TEXT NOT NULL DEFAULT '',
  external_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_journals_book_date ON journals(book_id, date, id);
CREATE INDEX IF NOT EXISTS idx_journals_status ON journals(status, date);
CREATE TABLE IF NOT EXISTS journal_lines (
  id TEXT PRIMARY KEY,
  journal_id TEXT NOT NULL REFERENCES journals(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  quantity INTEGER NOT NULL,
  memo TEXT NOT NULL DEFAULT '',
  UNIQUE(journal_id, line_no)
);
CREATE INDEX IF NOT EXISTS idx_lines_journal ON journal_lines(journal_id);
CREATE INDEX IF NOT EXISTS idx_lines_account_asset ON journal_lines(account_id, asset_id);
CREATE TABLE IF NOT EXISTS prices (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  quote_asset_id TEXT NOT NULL REFERENCES assets(id),
  rate_value INTEGER NOT NULL,
  rate_scale INTEGER NOT NULL CHECK(rate_scale >= 0),
  time TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prices_pair_time ON prices(book_id, asset_id, quote_asset_id, time);
CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_annotations_entity ON annotations(entity_type, entity_id, key);
CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  account_id TEXT REFERENCES accounts(id),
  pattern TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rules_type_status ON rules(type, status, priority);
CREATE TABLE IF NOT EXISTS targets (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('budget', 'goal')),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  quantity INTEGER NOT NULL,
  period TEXT,
  year INTEGER,
  month INTEGER,
  rollover_rule TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  target_date TEXT,
  priority INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_targets_budget ON targets(type, account_id, asset_id, period, year, month)
  WHERE type = 'budget';
CREATE UNIQUE INDEX IF NOT EXISTS idx_targets_goal ON targets(type, account_id, asset_id)
  WHERE type = 'goal';
CREATE TABLE IF NOT EXISTS recurrences (
  id TEXT PRIMARY KEY,
  next_date TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  from_account_id TEXT NOT NULL REFERENCES accounts(id),
  to_account_id TEXT NOT NULL REFERENCES accounts(id),
  description TEXT NOT NULL DEFAULT '',
  frequency TEXT NOT NULL,
  end_date TEXT,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE IF NOT EXISTS period_closes (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id),
  name TEXT NOT NULL,
  as_of TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  reopened_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_period_closes_book_as_of ON period_closes(book_id, as_of);
CREATE TABLE IF NOT EXISTS lots (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  quantity INTEGER NOT NULL,
  cost_asset_id TEXT NOT NULL REFERENCES assets(id),
  cost_quantity INTEGER NOT NULL,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  at TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}'
);
`;

