# Open-Source Boundary

This boundary is designed to let ScamScan stay open-source without handing out a turnkey hosted clone.

## Safe To Publish

These are good public-core candidates:
- chain analyzers
- URL/domain parsing helpers
- content-analysis heuristics
- WHOIS helpers
- denylist helpers without hosted user state
- normalization/error helpers

## Keep Private / Managed

Do not publish these from the working service tree:
- `scamscan-core/scamscan-agent/`
- `scamscan-web/`
- `scamscan-bot/`
- `scamscan-extension/`
- `scamscan-api/src/routes/auth.js`
- `scamscan-api/src/routes/credits.js`
- `scamscan-api/src/routes/me.js`
- `scamscan-api/src/routes/admin.js`
- `scamscan-api/src/routes/watchlist.js`
- `scamscan-api/src/middleware/auth.js`
- `scamscan-api/src/credits/`
- `scamscan-api/src/services/aiAnalyzer.js`
- `scamscan-api/src/services/apiKeyStore.js`
- `scamscan-api/src/services/cacheStore.js`
- `scamscan-api/src/services/creditsDb.js`
- `scamscan-api/src/services/demoSnapshots.js`
- `scamscan-api/src/services/externalIntelService.js`
- `scamscan-api/src/services/paymentService.js`
- `scamscan-api/src/services/paymentWatcherService.js`
- `scamscan-api/src/services/usageStore.js`
- `scamscan-api/src/services/watchlistStore.js`
- any real `.env`, databases, logs, backups, exports, or internal tooling

Working-tree only artifacts that must never go into a public release:
- `.venv/`
- `node_modules/`
- `tmp/`
- local Git clones or mirrors
- archives, context packs, exports, and debug dumps

## Product Rule

Public core should be a library-style package, not a drop-in hosted service.

That means:
- expose reusable analysis modules
- avoid shipping the production Express app
- avoid shipping user/account/payment state
- avoid shipping monetization and operator tooling

## Why

If you publish the web, auth, billing, watchlist, monitoring, and API orchestration layers together, a technical buyer can rebuild a very similar hosted service.

If you publish only the analysis core, the open-source promise stays real while the managed product still has a moat.
