# Clovis SQLite Schema And Persistence Internals

This document describes the SQLite database format created by the Clovis ledger
engine. It is technical on purpose: the database is one of the public surfaces
of the package while Clovis is in the `0.x` line.

Source of truth:

- Schema constants: [`src/core/schema.ts`](../src/core/schema.ts)
- Ledger storage engine: [`src/core/ledger.ts`](../src/core/ledger.ts)
- Money scaling helpers: [`src/core/money.ts`](../src/core/money.ts)
- Accounting sign helpers: [`src/core/accounting.ts`](../src/core/accounting.ts)
- CLI/MCP app layer: [`src/app/catalog.ts`](../src/app/catalog.ts)

Current constants:

```ts
export const DEFAULT_BOOK_ID = "book_default";
export const SCHEMA_VERSION = 1;
```

Fresh databases are created directly at schema version 1. There is no migration
runner in this package version. `Ledger.initialize()` runs the full `DDL`,
inserts `meta('schema_version')`, and inserts the default actual book if it does
not already exist.

## Runtime Model

Clovis uses Node's built-in `node:sqlite` module:

```ts
this.db = new DatabaseSync(this.path, { readBigInts: true });
this.db.exec("PRAGMA foreign_keys = ON");
this.initialize();
```

The important consequences are:

- SQLite is the durable local store. A ledger is a single database file.
- Foreign keys are enabled on every `Ledger` connection. Without this pragma,
  SQLite accepts foreign key declarations but does not enforce them.
- `readBigInts: true` means SQLite `INTEGER` values are read as JavaScript
  `bigint`. This is necessary because money, share quantities, and exchange
  rates are stored as integers and may exceed JavaScript's safe `number` range.
- Multi-row writes use explicit `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` in
  the engine where atomicity matters.
- The schema uses no triggers and no views. Accounting invariants are enforced
  by `Ledger` before writes and audited by `integrityCheck()`.

CLI and MCP open the same `Ledger` class. The CLI defaults to
`~/.clovis/clovis.db`; MCP requires `CLOVIS_DB` so an agent host does not
accidentally open a developer's personal default ledger.

## Object Inventory

The schema has fourteen application tables:

| Table | Role |
| --- | --- |
| `meta` | Key/value database metadata, currently the schema version. |
| `books` | Actual and scenario book identities. |
| `assets` | Currencies, commodities, custom units, and securities. |
| `accounts` | Chart of accounts for a book. |
| `sources` | Import batches and other external source metadata. |
| `journals` | Transaction headers. |
| `journal_lines` | Balanced transaction legs. |
| `prices` | Time-stamped exchange/conversion rates. |
| `annotations` | Polymorphic tags and flexible metadata. |
| `rules` | Categorization/matching rules. |
| `targets` | Budgets and savings goals. |
| `recurrences` | Scheduled transactions. |
| `period_closes` | Closed accounting period checkpoints. |
| `lots` | Investment lot and cost-basis records. |

There are seven explicit indexes:

| Index | Definition | Purpose |
| --- | --- | --- |
| `idx_journals_book_date` | `journals(book_id, date, id)` | Chronological reads within a book. |
| `idx_journals_status` | `journals(status, date)` | Status-filtered transaction lists and reports. |
| `idx_lines_journal` | `journal_lines(journal_id)` | Load all lines for a transaction. |
| `idx_lines_account_asset` | `journal_lines(account_id, asset_id)` | Account/asset balance and register scans. |
| `idx_prices_pair_time` | `prices(book_id, asset_id, quote_asset_id, time)` | Latest price lookup by pair and time. |
| `idx_annotations_entity` | `annotations(entity_type, entity_id, key)` | Tag lookup by entity and key. |
| `idx_rules_type_status` | `rules(type, status, priority)` | Active rule evaluation in priority order. |

There are also two partial unique indexes on `targets`, documented in the
`targets` section.

## Relationship Map

The core accounting chain is:

```text
books
  |-- accounts
  |     `-- journal_lines -- journals -- sources
  |              |
  |              `-- assets
  |
  |-- targets
  |-- recurrences -- accounts
  |-- period_closes
  |-- lots -- assets
  `-- prices -- assets

annotations(entity_type, entity_id)
rules -- accounts
meta
```

`assets` are global rather than book-scoped. Most other business rows carry a
`book_id`. The current engine almost always writes to `DEFAULT_BOOK_ID`; scenario
books exist as named book records and branch tags, but report APIs explicitly
reject branch filters rather than pretending there is a separate scenario data
copy.

## Type And Value Conventions

SQLite has a simple type system, so Clovis relies on explicit conventions.

### Identifiers

Primary keys are `TEXT`. The engine generates IDs by prefixing a shortened UUID:

```text
asset_...
acct_...
batch_...
source_...
tx_...
line_...
price_...
ann_...
rule_...
budget_...
goal_...
sched_...
period_...
lot_...
```

The prefix is operationally useful when reading raw rows. It is not a foreign
key target by itself; the actual constraints use the full ID columns.

### Dates And Times

Dates are stored as `TEXT`.

- Transaction dates, recurrence dates, target dates, lot dates, and period close
  dates are `YYYY-MM-DD`.
- `created_at` and `posted_at` values are ISO timestamps such as
  `2026-06-10T14:23:11Z`.
- SQLite does not check date formats. The engine's `dateOnly()` and app
  validation functions check `YYYY-MM-DD` before writes.

The format is lexicographically sortable, which is why plain `ORDER BY date`
works for chronological reads.

### Money, Shares, And Quantities

All durable quantities are integers. A decimal value is converted to atomic
units using the related asset's `scale`.

Examples:

| Asset scale | Human amount | Stored integer |
| --- | ---: | ---: |
| CAD scale `2` | `12.34` | `1234` |
| JPY scale `0` | `500` | `500` |
| MSFT scale `8` | `1.25` shares | `125000000` |

`toAtomicUnits(value, scale)` parses decimal text/number input, pads or rounds
half-up at the asset scale, and returns `bigint`. `fromAtomicUnits(quantity,
scale)` renders a stored integer back to a decimal string.

The reason this design matters: floating point decimals are not stable enough
for a ledger. Storing atomic integers makes sums exact, makes balance checks
exact, and keeps all SQL aggregation deterministic.

### Sign Convention

`journal_lines.quantity` is signed. The engine treats positive values as an
increase in that account's raw ledger balance and negative values as a decrease.

Accounting presentation is separate:

- Asset and expense accounts have normal debit balances.
- Liability, equity, and income accounts have normal credit balances.
- `normalAmount(accountType, raw)` flips credit-normal accounts for reports.

This is why storage can stay simple while reports still show proper accounting
debit/credit semantics.

## Table Specifications

### `meta`

Purpose: database-level metadata.

| Column | Type | Constraint | Meaning |
| --- | --- | --- | --- |
| `key` | `TEXT` | `PRIMARY KEY` | Metadata key. |
| `value` | `TEXT` | `NOT NULL` | Metadata value. |

Current row:

```text
key = 'schema_version'
value = '1'
```

`value` is text even when it represents a number so future metadata can stay in
one small key/value table.

### `books`

Purpose: identify the actual ledger and scenario/branch records.

| Column | Type | Constraint | Meaning |
| --- | --- | --- | --- |
| `id` | `TEXT` | `PRIMARY KEY` | Book ID. Default actual book is `book_default`. |
| `name` | `TEXT` | `NOT NULL UNIQUE` | Human name. Default actual book is `Actual`. |
| `type` | `TEXT` | `NOT NULL CHECK(type IN ('actual', 'scenario'))` | Book kind. |
| `parent_id` | `TEXT` | `REFERENCES books(id)` | Parent book for scenarios. |
| `created_at` | `TEXT` | `NOT NULL` | Creation timestamp. |
| `closed_at` | `TEXT` | nullable | Scenario discard/close timestamp. |

Initialization inserts:

```text
id = 'book_default'
name = 'Actual'
type = 'actual'
parent_id = NULL
created_at = '1970-01-01T00:00:00Z'
```

Scenario books are currently lightweight metadata. `create_branch` inserts a
`books(type = 'scenario')` row. `merge_branch` records a `book` annotation with
key `merged_at`. `discard_branch` sets `closed_at`.

### `assets`

Purpose: define units of measure for money, commodities, custom units, and
securities.

| Column | Type | Constraint | Meaning |
| --- | --- | --- | --- |
| `id` | `TEXT` | `PRIMARY KEY` | Asset ID. |
| `symbol` | `TEXT` | `NOT NULL UNIQUE` | Normalized uppercase symbol, such as `CAD` or `MSFT`. |
| `type` | `TEXT` | `NOT NULL CHECK(type IN ('currency', 'commodity', 'custom', 'security'))` | Asset class. |
| `scale` | `INTEGER` | `NOT NULL CHECK(scale >= 0 AND scale <= 18 AND scale = CAST(scale AS INTEGER))` | Decimal places for atomic-unit conversion. |
| `name` | `TEXT` | `NOT NULL DEFAULT ''` | Human name. |

Assets are global because the same unit can appear in more than one book. The
engine normalizes symbols to uppercase and makes `createAsset()` idempotent by
symbol: asking for an existing symbol returns the existing asset ID.

### `accounts`

Purpose: chart of accounts inside a book.

| Column | Type | Constraint | Meaning |
| --- | --- | --- | --- |
| `id` | `TEXT` | `PRIMARY KEY` | Account ID. |
| `book_id` | `TEXT` | `NOT NULL`, `FOREIGN KEY(book_id) REFERENCES books(id)` | Owning book. |
| `name` | `TEXT` | `NOT NULL` | Human account name. |
| `type` | `TEXT` | `NOT NULL CHECK(type IN ('asset', 'liability', 'equity', 'income', 'expense'))` | Accounting type. |
| `parent_id` | `TEXT` | `FOREIGN KEY(parent_id, book_id) REFERENCES accounts(id, book_id)` | Parent account in the same book. |
| `code` | `TEXT` | `NOT NULL DEFAULT ''` | Optional chart code. |
| `color_hex` | `TEXT` | `NOT NULL DEFAULT '#888888'` | UI/display color. |
| `status` | `TEXT` | `NOT NULL DEFAULT 'active'` | Lifecycle marker. |

Additional constraints:

```sql
UNIQUE(id, book_id)
UNIQUE(book_id, name)
```

The composite `UNIQUE(id, book_id)` exists so other tables can reference an
account and the book together. This prevents a line in one book from pointing at
an account in another book.

SQLite does not prevent account parent cycles. The engine checks cycles in
`assertValidAccountParent()` during updates and reports cycles in
`integrityCheck()`.

Account default currency is not a column. It is stored as an annotation:

```text
entity_type = 'account'
entity_id = <account id>
key = 'default_asset'
value = <asset id>
```

This avoids forcing every account to have a currency while still allowing
currency inference when both sides of a transaction have the same default asset.

### `sources`

Purpose: import batches and external source metadata.

| Column | Type | Constraint | Meaning |
| --- | --- | --- | --- |
| `id` | `TEXT` | `PRIMARY KEY` | Source ID. Import batches use the `batch_` prefix. |
| `book_id` | `TEXT` | `NOT NULL REFERENCES books(id)` | Owning book. |
| `type` | `TEXT` | `NOT NULL` | Source type, for example `import`. |
| `label` | `TEXT` | `NOT NULL DEFAULT ''` | Human label. |
| `status` | `TEXT` | `NOT NULL DEFAULT 'open'` | Workflow status, such as `open`, `committed`, `rolled_back`, or `discarded`. |
| `created_at` | `TEXT` | `NOT NULL` | Creation timestamp. |
| `metadata_json` | `TEXT` | `NOT NULL DEFAULT '{}'` | JSON metadata string. |

Additional constraint:

```sql
UNIQUE(id, book_id)
```

`journals.source_id` can point to a source. Imports also tag transactions with
an `annotations` row keyed `import_batch`; `listTransactionIdsForSource()`
checks both places so older or alternate import paths can still be found.

### `journals`

Purpose: transaction header.

| Column | Type | Constraint | Meaning |
| --- | --- | --- | --- |
| `id` | `TEXT` | `PRIMARY KEY` | Transaction ID. |
| `book_id` | `TEXT` | `NOT NULL`, `FOREIGN KEY(book_id) REFERENCES books(id)` | Owning book. |
| `source_id` | `TEXT` | `FOREIGN KEY(source_id, book_id) REFERENCES sources(id, book_id)` | Optional import/source batch. |
| `date` | `TEXT` | `NOT NULL` | Economic transaction date, `YYYY-MM-DD`. |
| `posted_at` | `TEXT` | `NOT NULL` | Insertion timestamp, even for pending/planned rows. |
| `status` | `TEXT` | `NOT NULL CHECK(status IN ('posted', 'pending', 'planned', 'void'))` | Transaction lifecycle. |
| `description` | `TEXT` | `NOT NULL DEFAULT ''` | Payee/memo text. |
| `external_id` | `TEXT` | nullable | Optional source-provided row ID. |

Additional constraint:

```sql
UNIQUE(id, book_id)
```

Indexes:

```sql
CREATE INDEX idx_journals_book_date ON journals(book_id, date, id);
CREATE INDEX idx_journals_status ON journals(status, date);
```

Status semantics:

| Status | Meaning |
| --- | --- |
| `posted` | Accepted ledger transaction. Default for most reports. |
| `pending` | Imported or staged transaction awaiting review. |
| `planned` | Forecast or future transaction. |
| `void` | Soft-deleted transaction retained for audit/history. |

Most report helpers default to `posted`. Some app workflows use `active` to mean
`posted + pending`, and `combined` to mean `posted + pending + planned`. Direct
ledger reads can pass `status: null` to include every status except where a
method explicitly filters.

### `journal_lines`

Purpose: transaction legs. These rows are the actual accounting entries.

| Column | Type | Constraint | Meaning |
| --- | --- | --- | --- |
| `id` | `TEXT` | `PRIMARY KEY` | Line ID. |
| `book_id` | `TEXT` | `NOT NULL` | Owning book. |
| `journal_id` | `TEXT` | `NOT NULL` | Parent transaction. |
| `line_no` | `INTEGER` | `NOT NULL` | 1-based line number within the transaction. |
| `account_id` | `TEXT` | `NOT NULL` | Account affected by the line. |
| `asset_id` | `TEXT` | `NOT NULL REFERENCES assets(id)` | Unit of the line quantity. |
| `quantity` | `INTEGER` | `NOT NULL` | Signed integer atomic units. |
| `memo` | `TEXT` | `NOT NULL DEFAULT ''` | Optional line memo. |

Additional constraints:

```sql
UNIQUE(journal_id, line_no)
FOREIGN KEY(journal_id, book_id)
  REFERENCES journals(id, book_id)
  ON DELETE CASCADE
FOREIGN KEY(account_id, book_id)
  REFERENCES accounts(id, book_id)
```

Indexes:

```sql
CREATE INDEX idx_lines_journal ON journal_lines(journal_id);
CREATE INDEX idx_lines_account_asset ON journal_lines(account_id, asset_id);
```

The key invariant is not expressible as a normal SQLite `CHECK`: every
transaction must sum to zero per `asset_id`.

The engine enforces it before insert:

```text
for each journal:
  group lines by asset_id
  sum quantity within each asset
  every asset total must equal 0
```

This lets Clovis support multi-asset transactions without requiring all assets
to net together. For example, an FX transfer can have CAD lines that sum to zero
and USD lines that sum to zero in the same journal.

Hard-deleting a journal cascades to its lines. Voiding a journal only changes
`journals.status`; the lines remain durable.

### `prices`

Purpose: conversion rates between assets.

| Column | Type | Constraint | Meaning |
| --- | --- | --- | --- |
| `id` | `TEXT` | `PRIMARY KEY` | Price ID. |
| `book_id` | `TEXT` | `NOT NULL REFERENCES books(id)` | Owning book. |
| `asset_id` | `TEXT` | `NOT NULL REFERENCES assets(id)` | Source asset. |
| `quote_asset_id` | `TEXT` | `NOT NULL REFERENCES assets(id)` | Quote asset. |
| `rate_value` | `INTEGER` | `NOT NULL CHECK(rate_value > 0)` | Integer rate coefficient. |
| `rate_scale` | `INTEGER` | `NOT NULL CHECK(rate_scale >= 0 AND rate_scale <= 18 AND rate_scale = CAST(rate_scale AS INTEGER))` | Decimal places for `rate_value`. |
| `time` | `TEXT` | `NOT NULL` | Effective time/date string. |

Additional constraint:

```sql
UNIQUE(id, book_id)
```

Index:

```sql
CREATE INDEX idx_prices_pair_time
  ON prices(book_id, asset_id, quote_asset_id, time);
```

`rate_value` and `rate_scale` encode a decimal rate. A stored pair
`rate_value = 135`, `rate_scale = 2` means rate `1.35`.

When converting atomic source quantity to atomic quote quantity, the engine
accounts for both asset scales:

```text
quote_atomic =
  round(source_atomic * rate_value * 10^quote_scale
        / 10^(source_scale + rate_scale))
```

`queryPrice()` returns the latest direct price where `time <= as_of`.
`convertQuantity()` builds an in-memory graph of the latest price per pair,
adds inverse edges, and breadth-first searches for a conversion path. If no path
exists, reporting APIs return a missing conversion warning instead of silently
pretending the value is zero.

### `annotations`

Purpose: flexible metadata without schema churn.

| Column | Type | Constraint | Meaning |
| --- | --- | --- | --- |
| `id` | `TEXT` | `PRIMARY KEY` | Annotation ID. |
| `book_id` | `TEXT` | `NOT NULL REFERENCES books(id)` | Owning book. |
| `entity_type` | `TEXT` | `NOT NULL` | Entity namespace, such as `account`, `tx`, `book`, or `source`. |
| `entity_id` | `TEXT` | `NOT NULL` | Referenced entity ID. |
| `key` | `TEXT` | `NOT NULL` | Metadata key. |
| `value` | `TEXT` | `NOT NULL` | Metadata value. |

Index:

```sql
CREATE INDEX idx_annotations_entity
  ON annotations(entity_type, entity_id, key);
```

There is intentionally no foreign key on `entity_id` because the table is
polymorphic. This keeps tags generic, but it means SQLite cannot enforce that a
tag points at a real row. `integrityCheck()` knows the current entity namespaces
and reports orphan annotations.

Common keys:

| Entity | Key | Meaning |
| --- | --- | --- |
| `account` | `default_asset` | Default asset/currency for transaction inference and reports. |
| `tx` | `import_batch` | Import source/batch ID. |
| `tx` | `branch` | Scenario label attached to a transaction. |
| `tx` | `transfer` | Transfer matching state, such as `matched` or `unmatched`. |
| `tx` | `recategorize_batch` | Bulk recategorization batch ID. |
| `tx` | `recategorize_from` | Previous account for rollback. |
| `book` | `merged_at` | Scenario merge marker. |

Annotations are multi-valued. For singleton semantics, app helpers delete old
rows before writing replacements.

### `rules`

Purpose: categorization and matching rules.

| Column | Type | Constraint | Meaning |
| --- | --- | --- | --- |
| `id` | `TEXT` | `PRIMARY KEY` | Rule ID. |
| `book_id` | `TEXT` | `NOT NULL`, `FOREIGN KEY(book_id) REFERENCES books(id)` | Owning book. |
| `type` | `TEXT` | `NOT NULL` | Rule namespace, currently commonly `match`. |
| `account_id` | `TEXT` | `FOREIGN KEY(account_id, book_id) REFERENCES accounts(id, book_id)` | Target account for matching rules. |
| `pattern` | `TEXT` | `NOT NULL` | Pattern text. |
| `priority` | `INTEGER` | `NOT NULL DEFAULT 100` | Evaluation order. Lower numbers sort first. |
| `status` | `TEXT` | `NOT NULL DEFAULT 'active'` | Lifecycle marker. Deleted rules are soft-deleted. |
| `created_at` | `TEXT` | `NOT NULL` | Creation timestamp. |

Additional constraint:

```sql
UNIQUE(id, book_id)
```

Index:

```sql
CREATE INDEX idx_rules_type_status
  ON rules(type, status, priority);
```

The engine prevents duplicate active `type/account_id/pattern` rules by checking
before insert, but there is no unique index for that logical rule key. Deleting
a rule updates `status = 'deleted'`.

### `targets`

Purpose: store budgets and goals in one table.

| Column | Type | Constraint | Meaning |
| --- | --- | --- | --- |
| `id` | `TEXT` | `PRIMARY KEY` | Target ID. |
| `book_id` | `TEXT` | `NOT NULL`, `FOREIGN KEY(book_id) REFERENCES books(id)` | Owning book. |
| `type` | `TEXT` | `NOT NULL CHECK(type IN ('budget', 'goal'))` | Target kind. |
| `account_id` | `TEXT` | `NOT NULL`, `FOREIGN KEY(account_id, book_id) REFERENCES accounts(id, book_id)` | Account being budgeted or targeted. |
| `asset_id` | `TEXT` | `NOT NULL REFERENCES assets(id)` | Unit of `quantity`. |
| `quantity` | `INTEGER` | `NOT NULL CHECK((type = 'budget' AND quantity >= 0) OR (type = 'goal' AND quantity > 0))` | Budget amount or goal target in atomic units. |
| `period` | `TEXT` | `CHECK(period IS NULL OR period IN ('monthly', 'yearly'))` | Budget period. Usually null for goals. |
| `year` | `INTEGER` | nullable | Optional year-specific budget. |
| `month` | `INTEGER` | `CHECK(month IS NULL OR (month >= 1 AND month <= 12))` | Optional month-specific budget. |
| `rollover_rule` | `TEXT` | `NOT NULL DEFAULT ''` | Budget rollover marker, such as `full`. |
| `name` | `TEXT` | `NOT NULL DEFAULT ''` | Goal name. |
| `target_date` | `TEXT` | nullable | Goal target date. |
| `priority` | `INTEGER` | `NOT NULL DEFAULT 1` | Goal ordering. |
| `status` | `TEXT` | `NOT NULL DEFAULT 'active'` | Lifecycle marker. |

Additional constraint:

```sql
UNIQUE(id, book_id)
```

Partial unique indexes:

```sql
CREATE UNIQUE INDEX idx_targets_budget
  ON targets(
    book_id,
    type,
    account_id,
    asset_id,
    period,
    coalesce(year, -1),
    coalesce(month, -1)
  )
  WHERE type = 'budget';

CREATE UNIQUE INDEX idx_targets_goal
  ON targets(book_id, type, account_id, asset_id)
  WHERE type = 'goal';
```

The table is shared because budgets and goals have the same durable core:
`account_id`, `asset_id`, and `quantity`. Type-specific fields are nullable or
ignored depending on `type`.

Budgets:

- `quantity >= 0`.
- Unique by account, asset, period, year, and month.
- `year` and `month` may be null for generic budgets.
- The app layer computes the effective budget by choosing the most specific row
  and reporting shadowed rows.

Goals:

- `quantity > 0`.
- Unique by account and asset.
- App helpers restrict goals to asset accounts.

SQLite enforces the amount sign rules. The app layer enforces domain placement,
such as budgets belonging to expense accounts and goals belonging to asset
accounts.

### `recurrences`

Purpose: scheduled transaction templates.

| Column | Type | Constraint | Meaning |
| --- | --- | --- | --- |
| `id` | `TEXT` | `PRIMARY KEY` | Recurrence ID. |
| `book_id` | `TEXT` | `NOT NULL`, `FOREIGN KEY(book_id) REFERENCES books(id)` | Owning book. |
| `next_date` | `TEXT` | `NOT NULL` | Next scheduled date, `YYYY-MM-DD`. |
| `quantity` | `INTEGER` | `NOT NULL CHECK(quantity > 0)` | Positive atomic amount. |
| `from_account_id` | `TEXT` | `NOT NULL`, `FOREIGN KEY(from_account_id, book_id) REFERENCES accounts(id, book_id)` | Source account. |
| `to_account_id` | `TEXT` | `NOT NULL`, `FOREIGN KEY(to_account_id, book_id) REFERENCES accounts(id, book_id)` | Destination account. |
| `description` | `TEXT` | `NOT NULL DEFAULT ''` | Transaction description. |
| `frequency` | `TEXT` | `NOT NULL CHECK(frequency IN ('daily', 'weekly', 'monthly', 'yearly'))` | Schedule step. |
| `end_date` | `TEXT` | nullable | Optional stored end date. |
| `asset_id` | `TEXT` | `NOT NULL REFERENCES assets(id)` | Transaction asset. |
| `status` | `TEXT` | `NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'deleted'))` | Recurrence lifecycle. |

Additional constraint:

```sql
UNIQUE(id, book_id)
```

`process_scheduled` posts active recurrences whose `next_date` is on or before
the requested through date, then advances `next_date` by frequency. In the
current implementation, `end_date` is validated and stored but is not used as a
stop condition by `process_scheduled`.

### `period_closes`

Purpose: close accounting periods against mutation.

| Column | Type | Constraint | Meaning |
| --- | --- | --- | --- |
| `id` | `TEXT` | `PRIMARY KEY` | Period close ID. |
| `book_id` | `TEXT` | `NOT NULL REFERENCES books(id)` | Owning book. |
| `name` | `TEXT` | `NOT NULL` | Human checkpoint name. |
| `as_of` | `TEXT` | `NOT NULL` | Closed-through date, `YYYY-MM-DD`. |
| `description` | `TEXT` | nullable | Optional description. |
| `created_at` | `TEXT` | `NOT NULL` | Creation timestamp. |
| `reopened_at` | `TEXT` | nullable | Reopen timestamp. Null means still closed. |

Additional constraint:

```sql
UNIQUE(id, book_id)
```

Index:

```sql
CREATE INDEX idx_period_closes_book_as_of
  ON period_closes(book_id, as_of);
```

Before mutating a transaction dated `txDate`, the engine checks for an
unreopened close where `as_of >= txDate`. If such a row exists, the mutation is
rejected. This protects closed periods from transaction creation, voiding,
deletion, status changes, recategorization, entry flips, account-entry moves,
asset migrations, and JSON import.

Reopening does not delete the close row. It sets `reopened_at`, preserving the
history of the close and reopen.

### `lots`

Purpose: investment lot and cost basis records.

| Column | Type | Constraint | Meaning |
| --- | --- | --- | --- |
| `id` | `TEXT` | `PRIMARY KEY` | Lot ID. |
| `book_id` | `TEXT` | `NOT NULL`, `FOREIGN KEY(book_id) REFERENCES books(id)` | Owning book. |
| `account_id` | `TEXT` | `NOT NULL`, `FOREIGN KEY(account_id, book_id) REFERENCES accounts(id, book_id)` | Holding account. |
| `asset_id` | `TEXT` | `NOT NULL REFERENCES assets(id)` | Held security/asset. |
| `quantity` | `INTEGER` | `NOT NULL CHECK(quantity > 0)` | Lot quantity in asset atomic units. |
| `cost_asset_id` | `TEXT` | `NOT NULL REFERENCES assets(id)` | Cost currency/asset. |
| `cost_quantity` | `INTEGER` | `NOT NULL CHECK(cost_quantity > 0)` | Cost basis in cost-asset atomic units. |
| `opened_journal_id` | `TEXT` | `NOT NULL`, `FOREIGN KEY(opened_journal_id, book_id) REFERENCES journals(id, book_id)` | Opening transaction. |
| `closed_journal_id` | `TEXT` | `FOREIGN KEY(closed_journal_id, book_id) REFERENCES journals(id, book_id)` | Closing transaction. |
| `opened_at` | `TEXT` | `NOT NULL` | Opening date. |
| `closed_at` | `TEXT` | nullable | Closing date. |
| `status` | `TEXT` | `NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'closed'))` | Lot lifecycle. |
| `metadata_json` | `TEXT` | `NOT NULL DEFAULT '{}'` | JSON metadata string. |

Additional constraint:

```sql
UNIQUE(id, book_id)
```

`recordSecurityPurchase()` creates:

- a security asset with scale `8`
- a holding account named `<SYMBOL> Holdings`
- an expense account named `Investment Cost`
- a four-line balanced journal
- an open lot linked to that journal

The engine rejects generic transaction/account/asset mutations that would
invalidate linked lot history. `integrityCheck()` also verifies that open lot
totals match the current account/asset balance.

## Write Path Details

### Initialization

Opening a ledger performs these steps:

1. Resolve the database path. If a directory is provided, use `clovis.db` inside
   it.
2. Create the parent directory.
3. Open SQLite with `readBigInts: true`.
4. Enable foreign keys.
5. Execute the full DDL.
6. Insert `meta.schema_version = '1'` if absent.
7. Insert the default actual book if absent.

This makes opening an existing v1 database idempotent and makes opening a new
path create a usable empty ledger.

### Asset And Account Creation

Assets are created before accounts when a ledger is initialized through the app
layer. `init_defaults` requires an explicit currency or asset ID. Clovis does
not infer a default currency globally.

Default templates create common accounts and tag each account with
`default_asset`. That tag is later used by `transactionAsset()`:

```text
if asset_id is explicit:
  use it
else:
  read default_asset from both accounts
  require both to exist and match
```

If the two accounts have different defaults, the app rejects the transaction and
directs callers to use `fx_transfer`.

### Transaction Creation

The core transaction primitive is `postTx(date, status, description, lines)`.

For every transaction:

1. Validate `date` as `YYYY-MM-DD`.
2. Reject writes into closed periods.
3. Validate status as `posted`, `pending`, `planned`, or `void`.
4. Convert every line quantity to `bigint`.
5. Ensure every quantity is within SQLite signed 64-bit integer range.
6. Group by `asset_id` and require each asset's sum to equal zero.
7. Check every referenced account and asset exists.
8. `BEGIN IMMEDIATE`.
9. Insert one `journals` row.
10. Insert all `journal_lines` rows with 1-based `line_no`.
11. `COMMIT`, or `ROLLBACK` on error.

`recordTransaction()` is the common two-sided helper:

```text
from account: -absolute_amount
to account:   +absolute_amount
```

`post_journal_entry` and `recordMultiAssetJournalEntry()` allow arbitrary
balanced multi-line entries.

`fx_transfer` is represented as a normal multi-asset journal. For example:

```text
Checking CAD       -100 CAD
FX Clearing CAD    +100 CAD
FX Clearing USD    -73 USD
Brokerage USD      +73 USD
```

Each asset balances separately. The FX account is the bridge, not a special SQL
construct.

### Transaction Mutation

Mutation policy lives in the engine, not in triggers:

- `voidTx()` sets `journals.status = 'void'`.
- `deleteTx()` deletes related transaction annotations, then deletes the
  journal. Lines cascade through `ON DELETE CASCADE`.
- `updateTxStatus()` changes lifecycle status.
- `recategorizeTransaction()` updates matching `journal_lines.account_id`.
- `flipEntries()` multiplies all line quantities in selected transactions by
  `-1`.
- `moveEntriesBetweenAccounts()` rewrites all lines from one account to another.
- `migrateAssetEntries()` rewrites all lines from one asset to another.

Before sensitive mutations, the engine checks period closes and lot links. This
centralizes audit and safety behavior in one code path instead of scattering it
across SQL triggers.

### Balance Reads

Balances are sums over `journal_lines` joined to `journals`:

```sql
SELECT coalesce(sum(l.quantity), 0) AS total
FROM journal_lines l
JOIN journals t ON t.id = l.journal_id
WHERE l.account_id = ?
  AND l.asset_id = ?
  AND <status/date filters>
```

`balanceTree()` walks the account hierarchy and includes descendants only when
they have the same account type as the root. This avoids rolling an expense
child into an asset parent if a malformed hierarchy exists.

Reports then decide how to interpret the raw sum:

- Register and holdings views usually show raw quantities.
- Trial balance shows debit/credit splits.
- Balance sheet and income statement normalize credit-normal account types for
  accounting presentation.
- Quote-currency reports convert each asset independently and report missing
  conversion paths.

### Price Reads And Conversion

Price lookup is time-aware. For each pair, the engine uses the latest price at
or before the report date:

```sql
SELECT *
FROM prices
WHERE book_id = ?
  AND asset_id = ?
  AND quote_asset_id = ?
  AND time <= ?
ORDER BY time DESC, id DESC
LIMIT 1
```

For multi-hop conversion, the engine builds a graph from latest available pair
prices. It adds both forward and inverse edges, then breadth-first searches from
the source asset to the quote asset.

This gives useful behavior without storing every possible pair:

```text
EUR -> USD
USD -> CAD

can value EUR in CAD if both rates exist as of the report date.
```

If no path exists, the report returns `valuation_complete: false` and includes a
`missing_conversions` row. It does not silently substitute zero or one.

### Imports

Statement import lives in the app layer and writes normal ledger rows.

CSV flow:

1. Resolve the input path through the app filesystem sandbox.
2. Parse CSV with row and column limits.
3. Map date, amount, description, optional counterpart, and tags.
4. Resolve the statement account, counterpart account, and asset.
5. Compute a signed amount relative to the statement account.
6. Skip duplicates unless disabled.
7. Write normal two-line transactions.
8. Create a source batch if any rows were imported.
9. Attach the batch through both `journals.source_id` and an `import_batch`
   transaction annotation.

Duplicate detection uses this fingerprint:

```text
date | signed amount for statement account | lower(description)
```

Batch lifecycle:

- `commit_batch` changes selected pending transactions to posted.
- `rollback_import` voids transactions and marks the source `rolled_back`.
- `discard_batch` hard-deletes selected transactions only when `dry_run:false`.

### JSON Export And Import

`export_ledger` calls `Ledger.exportDocument()` and emits a JSON document with:

```text
format = "clovis-ledger-v1"
assets
accounts
sources
transactions
account_tags
prices
budgets
goals
branches
checkpoints
lots
scheduled_transactions
```

`import_ledger` validates the whole document before writing:

- supported format
- required IDs
- duplicate IDs within the document
- existing ID conflicts when preserving IDs
- account name conflicts
- account parent references and cycles
- asset/account/source/transaction references
- balanced transaction entries
- date formats
- quantity ranges
- default asset availability
- budget and goal uniqueness
- recurrence status/frequency
- lot references and positive quantities

Only after validation succeeds does it open one `BEGIN IMMEDIATE` transaction and
insert all sections. `dry_run:true` returns validation results without writing.

### Backups

`backup_now` uses SQLite's `VACUUM INTO ?`:

```sql
VACUUM INTO ?
```

This creates a compact, consistent copy of the current database file. By
default, backups are written under a `backups` directory next to the ledger.

## SQL Constraints Vs Engine Invariants

The schema deliberately splits responsibilities.

SQLite enforces:

| Area | Enforcement |
| --- | --- |
| Primary keys | Every table has a primary key. |
| Basic enums | `CHECK` constraints on asset type, account type, journal status, target type, recurrence frequency/status, lot status. |
| Basic sign rules | Positive prices, positive recurrence quantities, target type-specific quantity signs, positive lot quantities. |
| Book-scoped references | Composite foreign keys for accounts, sources, journals, lines, rules, recurrences, and lots. |
| Journal line cleanup | `journal_lines` cascade when a journal is hard-deleted. |
| Target uniqueness | Partial unique indexes for budgets and goals. |

The TypeScript engine enforces:

| Area | Enforcement |
| --- | --- |
| Balanced journals | Every transaction sums to zero per asset before insert/import. |
| Date format | `YYYY-MM-DD` validation for business dates. |
| Period locks | Mutating transactions in closed periods is rejected. |
| Parent cycles | Account hierarchy cycle checks. |
| Default asset policy | No global inferred currency; transaction asset inference requires matching account defaults. |
| Lot safety | Generic mutations are blocked when they would break investment lots. |
| Import safety | Dry runs, duplicate detection, full-document validation, and atomic inserts. |
| Report warnings | Missing price paths are surfaced as warnings instead of hidden. |
| Polymorphic tag integrity | Orphan annotations are detected and repairable. |

This split is intentional. SQLite is excellent at durable relational constraints.
The engine is better at domain rules that require grouping, graph walks, precise
error messages, dry-run behavior, or compatibility with imports.

## Why The Schema Is Shaped This Way

### `journals` And `journal_lines` Instead Of One Transaction Table

A single transaction can have more than two legs, and a single economic event can
touch more than one asset. A header/lines model is the standard durable shape
for double-entry ledgers because it supports:

- simple two-sided transfers
- split transactions
- imported statement rows
- opening balances
- FX transfers
- investment purchases
- future multi-leg workflows

The transaction header stores lifecycle and source metadata. The lines store the
accounting facts.

### Integer Quantities Instead Of Decimal Columns

SQLite has no fixed-precision decimal type. Storing money as `REAL` would make
balances vulnerable to floating-point error. Storing money as integer atomic
units means all ledger sums are exact.

The `assets.scale` column moves decimal interpretation to the asset definition.
That is why the same schema can store CAD cents, JPY whole units, securities
with 8 decimal places, and custom units.

### Per-Asset Balancing

The engine requires each asset to balance independently because adding different
assets together is meaningless at storage time. A transaction containing CAD and
USD is valid only if the CAD lines sum to zero and the USD lines sum to zero.
Valuation into a quote currency is a reporting concern handled through `prices`.

### Book IDs Everywhere, But One Default Book Today

Most domain tables include `book_id` so the format can isolate actual and
scenario data. The current engine writes normal operations to `book_default`.
Scenario support currently records scenario identities and tags rather than
maintaining a full branch copy of every table.

This keeps the v1 schema future-capable without pretending the current app has
full branch accounting semantics.

### Global Assets

Assets are global because units like `CAD`, `USD`, or `MSFT` are not owned by a
particular book. Book-scoped rows reference those shared assets. This avoids
duplicate asset definitions and makes conversion rates reusable inside the file.

### Polymorphic Annotations

Annotations are the escape hatch for metadata that should not become a schema
column yet. Examples include account default assets, import batch tags, transfer
matching markers, and branch tags.

The tradeoff is real: SQLite cannot foreign-key `annotations.entity_id` to
multiple tables. Clovis accepts that tradeoff and provides `integrityCheck()` and
`repair_integrity` for orphan detection and cleanup.

### Shared `targets` Table

Budgets and goals both mean "an account should be associated with an asset
quantity under some planning semantics." Keeping them in one table reduces
duplicate schema while partial unique indexes preserve each target type's real
uniqueness rule.

### Period Closes As Rows, Not Flags

Closing a period creates an append-style checkpoint row. Reopening sets
`reopened_at` rather than deleting the row. That gives the ledger an audit trail
of close/reopen events while keeping mutation checks simple.

### No Triggers

The database does not contain triggers for balance, period, or annotation
cleanup rules. The engine owns those policies so:

- errors can be precise and user-facing
- dry-run workflows can validate without writing
- JSON import can validate all rows before changing the database
- tests can exercise the same rules the CLI and MCP use

The cost is that direct SQL writes can bypass domain invariants. If you modify a
Clovis database outside the `Ledger` API, run `integrity_check` afterward and
expect the application to reject or misreport invalid data.

## Integrity And Repair

`integrityCheck()` returns `ok` plus structured problem lists:

| Field | Checks |
| --- | --- |
| `schema_version` | Reads `meta.schema_version`. |
| `imbalanced_transactions` | Re-runs per-asset journal balance checks. |
| `account_cycles` | Detects cycles in account parent links. |
| `orphan_annotations` | Detects known annotation entity types that point to missing rows. |
| `invalid_default_assets` | Detects account default-asset tags that point to missing accounts/assets. |
| `invalid_prices` | Checks positive rate values and valid rate scales. |
| `invalid_targets` | Checks budget/goal signs, periods, months, and goal target dates. |
| `duplicate_budgets` | Checks budget logical uniqueness. |
| `invalid_recurrences` | Checks quantities, frequencies, statuses, and dates. |
| `invalid_lots` | Checks lot references, signs, statuses, and open lot totals. |

`repair_integrity` currently repairs only orphan annotations and invalid
default-asset annotations. If run with `dry_run:false`, it creates a backup
first unless backup is explicitly disabled.

## Full Canonical DDL

This is copied from `src/core/schema.ts` for convenience. If this appendix and
the source ever disagree, the TypeScript source is authoritative.

```sql
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
  scale INTEGER NOT NULL CHECK(scale >= 0 AND scale <= 18 AND scale = CAST(scale AS INTEGER)),
  name TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('asset', 'liability', 'equity', 'income', 'expense')),
  parent_id TEXT,
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
```
