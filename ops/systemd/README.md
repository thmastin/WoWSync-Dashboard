# ops/systemd

Reconstructed systemd unit definitions for the live Omarchy DEV runtime
(`wowsync-dev` user, `/home/wowsync-dev/src/WoWSync-Dashboard`). These are
tracked here so the DEV host's service topology is reviewable and
reproducible from the repo, not only discoverable by `systemctl cat` on the
live host.

Units:

- `wowsync-dev.target` — umbrella target; currently `Requires=`/`After=` only
  `wowsync-dev-dashboard.service` (not mcp-tunnel or herdr — that is the
  live target's actual scope, not an oversight).
- `wowsync-dev-dashboard.service` + `wowsync-dev-dashboard.service.d/` —
  the DEV dashboard web server (port 4174). The `90-wowsync-dev-target.conf`
  drop-in supplies `PartOf=wowsync-dev.target`; a separate, untracked
  `capture.conf` drop-in exists live (`EnvironmentFile=/etc/wowsync/dev/capture.env`)
  and is intentionally out of scope here.
- `wowsync-dev-mcp-tunnel.service` — runs `tunnel-client` (MCP control-plane
  tunnel), which spawns the MCP server as its stdio child. The real tunnel ID
  is sourced at runtime from `/etc/wowsync/dev/mcp-tunnel.env` via
  `CONTROL_PLANE_TUNNEL_ID` (tunnel-client's own native env var for
  `--control-plane.tunnel-id`) rather than being inlined on the command line.
  See `wowsync-dev-mcp-tunnel.env.example`.
- `wowsync-dev-herdr.service` — runs `/usr/bin/herdr server`; intentionally
  has no `PartOf=`/target relationship, matching live.

Credential and tunnel-ID *values* are never committed here — only path
references and a placeholder `.example` file.
