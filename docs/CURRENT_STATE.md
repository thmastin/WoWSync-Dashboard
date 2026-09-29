# Current WoWSync state

Last verified: 2026-09-29. Branch: `feature/dashboard-integration`.

## Operating state

- Omarchy DEV is operational under Unix identity `wowsync-dev`: writable DEV checkout, DEV Dashboard on loopback port 4174, and DEV-only Herdr control plane.
- Omarchy LIVE has not been cut over. Its Dashboard is inactive; there is no authoritative LIVE database, importer/receiver, MCP/tunnel, or production credential set there.
- The authoritative WoWSync database and normal capture path remain on Windows. Production Dashboard/MCP functionality has not yet been migrated to Omarchy.
- DEV Codex is authenticated and installed at `/opt/wowsync/dev-tools/codex` with its matching code-mode host. The DEV project configuration is `approval_policy = "never"`, `sandbox_mode = "workspace-write"`, network enabled. A fresh DEV CLI check confirmed the setting and verified access to DEV Herdr/Dashboard while LIVE and tested personal control listeners remained denied. Do not use `danger-full-access` or weaken the host boundary.
- UFW permits DEV-identity established TCP replies so DEV can use its own Dashboard; new connections to LIVE port 4173 and tested personal listeners remain denied over IPv4/IPv6. See [`OMARCHY_DEV_LIVE_ISOLATION.md`](OMARCHY_DEV_LIVE_ISOLATION.md).

## Product position and next milestone

The manual Windows → Omarchy DEV capture path has been proven end-to-end. This infrastructure slice adds a hidden Windows logon supervisor for the SSH forwards, persistent multi-product/account watcher, DPAPI-protected DEV and MCP tunnel credentials, durable health status, and an Omarchy systemd DEV target/operator. The exact real-Windows reboot, outage recovery, browser, and ChatGPT acceptance remains pending; see [`WINDOWS_CAPTURE_SETUP.md`](WINDOWS_CAPTURE_SETUP.md). Keep DEV and future LIVE configuration/data separate. No LIVE service, database or destination is changed. Later authoritative database migration, Windows LIVE destination switch, production credentials, and LIVE Dashboard/MCP cutover still require their separate human checkpoint.

The existing [`ROADMAP.md`](ROADMAP.md) tracks broader product work, including separate GearExport tasks; re-check its entries against current source before acting. It does not authorize edits to GearExport or BankCleanup.

## Development gates

The primary agent may inspect and change this DEV repository, run normal development commands and validation, and commit/push validated work to `feature/dashboard-integration`. It must not merge to `main`. Tate remains the gate for authoritative database migration, production credentials, Windows LIVE destination switch, destructive LIVE work, addon deployment/live-game validation (including `/reload`), and merge to `main`.

Preserve version isolation and data semantics: `OBSERVED`, `UNKNOWN`, `LAST_SEEN`, `DERIVED`; UNKNOWN is never zero, inaccessible data is never empty, and LAST_SEEN is never current. Keep Character Bank owned by character, Warband by account, and Guild Bank by guild. Quarantine ambiguous Hardcore/SSF version input.
