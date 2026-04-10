# ScamScan Public Core

This folder is the safe open-source boundary for ScamScan.

Goal:
- keep the project genuinely open-source
- share useful analysis code and public integration building blocks
- avoid publishing a near-complete hosted SaaS clone

The intended public package lives in:
- `scamscan-api/`

Build a clean publishable snapshot with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build_public_release.ps1
```

Publish from:
- `_release\scamscan-core-public\`

Do not publish this whole working folder as-is.
It may contain local tooling and private operational artifacts.

Managed SaaS layers stay outside this boundary:
- web app and UI glue
- bot and extension clients
- auth/session management
- credits, billing, invoices, payment watchers
- watchlists, user data, recurring monitoring
- AI analysis layer
- external intel sync/storage
- production scoring calibration and anti-abuse logic

Read:
- `OPEN_SOURCE_BOUNDARY.md`
- `PUBLIC_RELEASE_CHECKLIST.md`
