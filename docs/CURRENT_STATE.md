# Current WoWSync state

Last verified: 2026-09-30. Branch: `feature/dashboard-integration`.

## Operating state

- Omarchy DEV is operational under Unix identity `wowsync-dev`: writable DEV checkout, DEV Dashboard on loopback port 4174, DEV-only Herdr control plane, and the externally accepted read-only MCP connection through tunnel `tunnel_6abd1086c3c08191a9bf6c1a64cc6787`. The earlier 15-tool connection and later 17-tool account/current-state and 19-tool snapshot-history contracts passed ChatGPT acceptance. The current 24-tool parity expansion is awaiting final external acceptance after DEV MCP reload. Windows sign-in continues to run the capture supervisor, SavedVariables watcher, and SSH forwarding; its old MCP tunnel was retired after Omarchy acceptance. See [`WINDOWS_CAPTURE_SETUP.md`](WINDOWS_CAPTURE_SETUP.md) and [`MCP_DEVELOPMENT.md`](MCP_DEVELOPMENT.md).
- Omarchy LIVE has not been cut over. Its Dashboard is inactive; there is no authoritative LIVE database, importer/receiver, MCP/tunnel, or production credential set there.
- The authoritative WoWSync database and normal capture path remain on Windows. Production Dashboard/MCP functionality has not yet been migrated to Omarchy.
- DEV Codex is authenticated and installed at `/opt/wowsync/dev-tools/codex` with its matching code-mode host. The DEV project configuration is `approval_policy = "never"`, `sandbox_mode = "workspace-write"`, network enabled. A fresh DEV CLI check confirmed the setting and verified access to DEV Herdr/Dashboard while LIVE and tested personal control listeners remained denied. Do not use `danger-full-access` or weaken the host boundary.
- UFW permits DEV-identity established TCP replies so DEV can use its own Dashboard; new connections to LIVE port 4173 and tested personal listeners remain denied over IPv4/IPv6. See [`OMARCHY_DEV_LIVE_ISOLATION.md`](OMARCHY_DEV_LIVE_ISOLATION.md).

## Product position and next milestone

The planned read-only MCP parity expansion is awaiting final external ChatGPT acceptance. Do not treat this code push as final external acceptance or as completion of the overall MCP project. Keep DEV and future cloud LIVE configuration/data separate. No Omarchy LIVE service or authoritative database migration was performed; any later cloud LIVE deployment, production credentials, Windows LIVE destination switch, and authoritative database move remain separate gated milestones.

The durable truth store at `D:\dev\wow-stuff\truth` was not available from Omarchy. This closeout is recorded only in project documentation; sync the accepted state to that store through the established truth-update workflow when it is available. Do not treat this repository as a duplicate authoritative truth store.

The existing [`ROADMAP.md`](ROADMAP.md) tracks broader product work, including separate GearExport tasks; re-check its entries against current source before acting. It does not authorize edits to GearExport or BankCleanup.

## Development gates

The primary agent may inspect and change this DEV repository, run normal development commands and validation, and commit/push validated work to `feature/dashboard-integration`. It must not merge to `main`. Tate remains the gate for authoritative database migration, production credentials, Windows LIVE destination switch, destructive LIVE work, addon deployment/live-game validation (including `/reload`), and merge to `main`.

Preserve version isolation and data semantics: `OBSERVED`, `UNKNOWN`, `LAST_SEEN`, `DERIVED`; UNKNOWN is never zero, inaccessible data is never empty, and LAST_SEEN is never current. Keep Character Bank owned by character, Warband by account, and Guild Bank by guild. Quarantine ambiguous Hardcore/SSF version input.
