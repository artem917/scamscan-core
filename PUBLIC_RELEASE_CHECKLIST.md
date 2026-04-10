# Public Release Checklist

Use this checklist before publishing any ScamScan open-source snapshot.

## Publish From The Clean Release Folder

Do not publish directly from the working tree.

Build the publishable snapshot first:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build_public_release.ps1
```

Publish only the contents of:

- `_release\scamscan-core-public\`

## Never Publish These Paths

- `scamscan-agent/`
- any `.env` file
- any `.venv/`, `node_modules/`, `tmp/`, `logs/`, `data/`
- local exports, backups, archives, or context packs
- any hosted UI, bot, extension, billing, auth, watchlist, or AI service code

## Quick Verification

Before publishing, manually confirm that the release folder contains only:

- `.gitignore`
- `README.md`
- `OPEN_SOURCE_BOUNDARY.md`
- `PUBLIC_RELEASE_CHECKLIST.md`
- `scamscan-api/`

## Boundary Rule

Public release must stay a library-style analysis core.

It must not be a turnkey hosted ScamScan clone.
