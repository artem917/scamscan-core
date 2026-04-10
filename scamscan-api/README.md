# ScamScan Public Core API

This package is the safe open-source core of ScamScan.

It is intentionally a library-style package, not the hosted ScamScan service.

## Included

- chain analyzers for EVM, Solana, TON, TRON, and Bitcoin
- wallet analysis orchestration
- website content analysis helpers
- WHOIS/domain analysis helpers
- normalization/config helpers
- local denylist helper

## Not Included

- web app
- browser extension
- Telegram/bot clients
- auth/session middleware
- credits/billing/invoices
- payment watchers
- watchlists and recurring monitoring
- AI analysis layer
- external intel sync/storage
- managed anti-abuse and production calibration

## Use Case

Use this package when you want ScamScan-style building blocks inside:
- internal tools
- backend workers
- research scripts
- custom fraud/risk pipelines

Do not treat it as a drop-in replacement for the hosted ScamScan product.

## Quick Start

```bash
npm install
cp .env.example .env
```

Example:

```js
const core = require("./src");

// domain and wallet helpers
console.log(core.detectType("https://example.org"));
console.log(core.detectChain("0x0000000000000000000000000000000000000000"));
```

## Exported Modules

- `analyzeWallet`
- `analyzeWebsiteContent`
- `fetchDomainWhois`
- `analyzeWhois`
- `scanNetwork`
- `checkHoneypot`
- `simulateTradingPaths`
- `getTokenMetaViaRpc`
- `getContractControl`
- `fetchDexLiquiditySummary`
- `fetchExplorerHolderSummary`
- `analyzeSolanaAddressOnChain`
- `analyzeTronAddressOnChain`
- `analyzeTonAddress`
- `analyzeTonAddressOnChain`
- `analyzeBtcAddressOnChain`
- `detectType`
- `detectChain`
- `RPC_PROVIDERS`

## Note

If you publish code from the main working service tree, keep the managed modules private.
The boundary is documented in:

- `../OPEN_SOURCE_BOUNDARY.md`

