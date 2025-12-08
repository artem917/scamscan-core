# Changelog

## v0.3.0 – 2025-12-08

### Added
- WHOIS/RDAP aggregation with ApiNinjas primary lookup and rdap.org fallback, including normalized domain age, registrar and status fields.
- Telegram bot beta with auto type detection, junk-text filtering, soft usage tracking, feedback buttons and admin feedback logging.
- Deployment helper script and local storage for daily usage and PRO users.

### Changed
- URL and content analysis heuristics for scam wording and exposed wallets on landing pages.
- Wallet analysis service and common formatter to consume the new normalized API response shape.
- Web checker UI and API messages to show softer WHOIS quota warnings instead of hard failures.

### Fixed
- Edge cases where WHOIS quota errors from ApiNinjas were treated as fatal and hid RDAP fallback results.
