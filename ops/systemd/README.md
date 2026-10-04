# ops/systemd

**Current host state:** the exact-SHA deployment infrastructure is on its feature branch for
review. Privileged bootstrap and topology migration have not happened. Active DEV Dashboard/MCP
still execute from `/home/wowsync-dev/src/WoWSync-Dashboard`. The `releases/current` paths below
describe the intended topology after the separately reviewed same-SHA migration. The live tunnel
ID remains inline in the installed MCP unit; this known drift is separate from release promotion.

Reconstructed systemd unit definitions for the Omarchy DEV runtime
(`wowsync-dev` user). Agent work remains in the developer checkout
`/home/wowsync-dev/src/WoWSync-Dashboard`; Dashboard and MCP code run from the stable
`/home/wowsync-dev/releases/current` pointer. These are
tracked here so the DEV host's service topology is reviewable and
reproducible from the repo, not only discoverable by `systemctl cat` on the
live host.

Units:

- `wowsync-dev.target` — umbrella target; on **start**, `Requires=`/`After=` only pull in
  `wowsync-dev-dashboard.service` (not mcp-tunnel or herdr — starting the target does not by
  itself start either of those two).
- `wowsync-dev-dashboard.service` + `wowsync-dev-dashboard.service.d/` —
  the DEV dashboard web server (port 4174), launched from the active SHA release.
  The `90-wowsync-dev-target.conf`
  drop-in supplies `PartOf=wowsync-dev.target`; a separate, untracked
  `capture.conf` drop-in exists live (`EnvironmentFile=/etc/wowsync/dev/capture.env`)
  and is intentionally out of scope here.
- `wowsync-dev-mcp-tunnel.service` — runs `tunnel-client` (MCP control-plane
  tunnel), which spawns the MCP server from the active SHA release as its stdio child.
  The real tunnel ID
  is sourced at runtime from `/etc/wowsync/dev/mcp-tunnel.env` via
  `CONTROL_PLANE_TUNNEL_ID` (tunnel-client's own native env var for
  `--control-plane.tunnel-id`) rather than being inlined on the command line.
  See `wowsync-dev-mcp-tunnel.env.example`. **This unit declares
  `PartOf=wowsync-dev.target` on itself** — unlike the start-direction relationship above, this
  means `systemctl stop`/`restart wowsync-dev.target` *does* stop/restart this service too (the
  same mechanism the dashboard drop-in uses). Start-dependency and `PartOf=` are different
  systemd relationships; this unit only opts into the latter.
- `wowsync-dev-herdr.service` — runs `/usr/bin/herdr server`; has no
  `PartOf=`/target relationship in either direction, matching live — stopping the target does not
  stop herdr. It continues to use the developer/source checkout and is not part of application
  promotion.

Application releases are complete SHA-pinned trees under
`/home/wowsync-dev/releases/<full-sha>`; `current` is switched atomically.
The SQLite database and other mutable runtime state stay under
`/var/lib/wowsync-dev`. See `docs/OPERATIONS_RUNBOOK.md` for the canonical
prepare/promote/rollback command and the one-time path migration procedure.
The migration script changes only source-path strings in the installed Dashboard
and MCP units, preserving the current live tunnel-ID argument and all other
unit settings; it reloads systemd but does not restart services.

Credential and tunnel-ID *values* are never committed here — only path
references and a placeholder `.example` file.
