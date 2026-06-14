import type { Row, ToolHandlers, ToolRuntimeContext } from "../tool-runtime.js";

export function accountHandlers(ctx: ToolRuntimeContext, handlers: ToolHandlers): Partial<ToolHandlers> {
  const {
    account,
    accountPublic,
    asset,
    explicitAsset,
    optionalDate,
    setAccountDefaultAsset
  } = ctx;
  return {

    // One handler per public tool. Handlers may compose other handlers, but
    // durable writes still flow through Ledger methods.
    create_asset: (ledger, args) => {
      const assetId = ledger.createAsset(args.symbol, args.asset_type ?? "currency", Number(args.decimals ?? args.scale ?? 2), args.name ?? "");
      return { ...ledger.getAsset(assetId)!, warning: ledger.getAssetBySymbol(args.symbol) ? undefined : undefined };
    },

    list_assets: (ledger, args) => ledger.listAssets().filter((row) => !args.asset_type || row.asset_type === args.asset_type),

    get_asset_by_symbol: (ledger, args) => ledger.getAssetBySymbol(args.symbol),

    update_asset: (ledger, args) => ledger.updateAsset(asset(ledger, args.asset_id), { symbol: args.symbol, name: args.name }),

    delete_asset: (ledger, args) => {
      const assetId = asset(ledger, args.asset_id);
      ledger.deleteAsset(assetId, Boolean(args.force));
      return { deleted: assetId };
    },

    migrate_asset_entries: (ledger, args) => {
      const fromId = asset(ledger, args.from_asset_id);
      const toId = asset(ledger, args.to_asset_id);
      const count = ledger.countEntriesByAsset(fromId);
      if (args.dry_run === false) return { from_asset_id: fromId, to_asset_id: toId, matched: ledger.migrateAssetEntries(fromId, toId), updated: count, dry_run: false };
      return { from_asset_id: fromId, to_asset_id: toId, matched: count, updated: 0, dry_run: true };
    },

    create_account: (ledger, args) => {
      const existing = ledger.findAccount(args.name);
      if (existing) {
        if ("default_asset_id" in args || "asset_id" in args) setAccountDefaultAsset(ledger, existing.id, args.default_asset_id ?? args.asset_id ?? null);
        return accountPublic(existing, ledger);
      }
      const parent = args.parent_id ? account(ledger, args.parent_id) : null;
      const accountId = ledger.createAccount(args.name, args.type, parent, args.code ?? "", args.color_hex ?? "#888888");
      setAccountDefaultAsset(ledger, accountId, args.default_asset_id ?? args.asset_id ?? null);
      return accountPublic(ledger.getAccount(accountId)!, ledger);
    },

    create_accounts: (ledger, args) => {
      const created: Row[] = [];
      const errors: Row[] = [];
      (args.accounts ?? []).forEach((row: Row, index: number) => {
        try {
          created.push(handlers.create_account(ledger, { name: row.name, type: row.type ?? row.account_type, parent_id: row.parent_id, code: row.code, color_hex: row.color_hex, default_asset_id: row.default_asset_id ?? row.asset_id }) as Row);
        } catch (error) {
          errors.push({ index, error: error instanceof Error ? error.message : String(error) });
        }
      });
      return { created: created.length, accounts: created, errors };
    },

    list_accounts: (ledger, args) => {
      let rows = ledger.listAccounts().map((row) => accountPublic(row, ledger));
      if (args.type) rows = rows.filter((row) => row.account_type === args.type);
      if (args.parent_id) {
        const parent = account(ledger, args.parent_id);
        rows = rows.filter((row) => row.parent_id === parent);
      }
      if (args.include_counts) {
        rows = rows.map((row) => ({
          ...row,
          transaction_count: ledger.countTransactionsByAccount(row.id)
        }));
      }
      if (args.tree) {
        const byParent = new Map<string | null, Row[]>();
        for (const row of rows) byParent.set(row.parent_id ?? null, [...(byParent.get(row.parent_id ?? null) ?? []), row]);
        const attach = (row: Row): Row => ({ ...row, children: (byParent.get(row.id) ?? []).map(attach) });
        return (byParent.get(null) ?? []).map(attach);
      }
      return rows;
    },

    get_account: (ledger, args) => {
      const row = ledger.getAccount(args.id);
      if (!row) throw new Error(`Account '${args.id}' not found`);
      return accountPublic(row, ledger);
    },

    get_account_by_name: (ledger, args) => {
      const row = ledger.findAccount(args.name);
      return row ? accountPublic(row, ledger) : null;
    },

    update_account: (ledger, args) => {
      const accountId = account(ledger, args.id);
      const updated = ledger.updateAccount(accountId, { name: args.name, type: args.type, parent_id: args.parent_id ? account(ledger, args.parent_id) : args.parent_id, code: args.code, color_hex: args.color_hex });
      if ("default_asset_id" in args || "asset_id" in args) setAccountDefaultAsset(ledger, accountId, args.default_asset_id ?? args.asset_id ?? null);
      return accountPublic(updated, ledger);
    },

    delete_account: (ledger, args) => {
      const accountId = account(ledger, args.id);
      ledger.deleteAccount(accountId);
      return { deleted: accountId };
    },

    merge_accounts: (ledger, args) => {
      const target = account(ledger, args.target);
      let moved = 0;
      for (const source of args.sources ?? []) {
        const sourceId = account(ledger, source);
        moved += ledger.moveEntriesBetweenAccounts(sourceId, target);
        if (args.delete_sources !== false) {
          try { ledger.deleteAccount(sourceId); } catch { /* source may still have children */ }
        }
      }
      return { target, sources: args.sources ?? [], moved };
    },

    create_price: (ledger, args) => ({ id: ledger.createPrice(asset(ledger, args.asset_id), asset(ledger, args.quote_id), args.rate, args.time), asset_id: asset(ledger, args.asset_id), quote_asset_id: asset(ledger, args.quote_id), rate: args.rate, time: args.time }),

    list_prices: (ledger) => ledger.listPrices(),

    get_price: (ledger, args) => ledger.queryPrice(asset(ledger, args.asset_id), asset(ledger, args.quote_id), optionalDate(args.as_of) ?? "9999-12-31"),

    init_defaults: (ledger, args) => {
      const assetId = args.asset_id ? explicitAsset(ledger, args.asset_id) : args.currency ? asset(ledger, null, args.currency) : null;
      if (!assetId) throw new Error("currency or asset_id is required for init_defaults");
      return ledger.initDefaults(args.template ?? "personal", assetId);
    },
  };
}
