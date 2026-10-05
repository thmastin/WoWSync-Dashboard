# DEV Codex package repair

> Historical installation record. `wowsync-codex` is an optional host convenience, not part of the
> development or deployment workflow: agents work in ordinary workspaces and deploy to DEV only with
> `wowsync-dev-deploy` (see [`OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md#deploying-to-dev)).

Inspected and applied by the host administrator on 2026-09-30. The active
`/opt/wowsync/dev-tools/codex` now resolves to the complete pinned npm package
at `codex-npm-0.157.1/bin/codex`. The existing launcher remains host-managed at
`/usr/local/bin/wowsync-codex` and is not tracked in this repository. Do not
repeat the apply procedure below; it is retained as the installation record.

## Findings

- `/usr/local/bin/wowsync-codex` switches to `wowsync-dev`, enters the DEV
  checkout, and executes `/opt/wowsync/dev-tools/codex`, forwarding arguments.
  It does not inject `--no-daemon` and needs no change.
- Installed version: 0.157.1. The package contains its manifest, resources,
  path templates, native CLI, and matching code-mode host.
- Starting that binary with a temporary, unauthenticated `CODEX_HOME` reproduced:
  `this CLI has no complete local package; install a packaged Codex CLI or use the standalone installer`.
- OpenAI's [CLI installation guide](https://learn.chatgpt.com/docs/codex/cli)
  documents installation/update; its [npm update example](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex)
  uses `npm install -g @openai/codex@latest`. Pinning the existing 0.157.1
  isolates this repair to packaging rather than a version upgrade.
- Staged with npm under ignored `node_modules/.wowsync-codex-repair/package`,
  with lifecycle scripts disabled. The platform package includes
  `codex-package.json`, `bin/`, `codex-resources/`, and `codex-path/`.
  SHA-256 of both executables matches the current installation:

  ```text
  codex: 3e2584f3f3829a43a0495011a1cecb2facbe64a2403e2b682351fd9c2983f970
  codex-code-mode-host: 67b86142bac5cead11b8420cf32d3a2bf88c8868d71733f351ed7c5d95a953e0
  ```

The staged package passed package discovery. In the validated launched
session, `wowsync-codex --version` reported 0.157.1,
`wowsync-codex login status` reported `Logged in using ChatGPT`, and shell
execution worked as `wowsync-dev` in the DEV checkout. The explicit
daemon-version probe from this nested execution environment could not connect
to the control socket because the sandbox denied access. Host daemon
start/resume/fork checks remain pending; do not infer their result from the
successful launcher, authentication, or shell checks. No credentials were
copied into the temporary test home.

## Original administrator apply procedure (historical)

Historical procedure, already applied. It installed a separate npm prefix
under DEV tools, retained the old executable for rollback, and kept the
existing launcher path. It did not modify DEV authentication/config, LIVE,
personal Codex, firewall, groups, or sudo rules. The checks were designed to
refuse to overwrite an earlier repair or backup.

```bash
set -euo pipefail
test "$(id -u)" -eq 0
base=/opt/wowsync/dev-tools
release="$base/codex-npm-0.157.1"
test ! -e "$release"
test ! -e "$base/codex.standalone-0.157.1"
test ! -L "$base/codex"
test -x "$base/codex"
test -x "$base/codex-code-mode-host"
npm_config_dir=$(mktemp -d)
trap 'rm -rf -- "$npm_config_dir"' EXIT
touch "$npm_config_dir/user.npmrc" "$npm_config_dir/global.npmrc"
NPM_CONFIG_USERCONFIG="$npm_config_dir/user.npmrc" \
NPM_CONFIG_GLOBALCONFIG="$npm_config_dir/global.npmrc" \
  npm install --global --prefix "$release" \
  --cache "$base/npm-cache" --ignore-scripts --no-audit --no-fund \
  @openai/codex@0.157.1
vendor="$release/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl"
test -f "$vendor/codex-package.json"
test -d "$vendor/codex-resources"
test -d "$vendor/codex-path"
cmp "$base/codex" "$vendor/bin/codex"
cmp "$base/codex-code-mode-host" "$vendor/bin/codex-code-mode-host"
chown -R root:root "$release"
chmod -R go-w "$release"
mv "$base/codex" "$base/codex.standalone-0.157.1"
ln -s codex-npm-0.157.1/bin/codex "$base/codex"
```

The active code-mode host is now the matching host inside the complete package;
the original adjacent host remains available for rollback. For future updates,
stage another complete pinned prefix and validate it before switching the
launcher target. Do not run a personal/global npm update as a shortcut.

Rollback from the administrator shell, after exiting new DEV sessions and
stopping their DEV daemon: verify the symlink points to the release above,
remove only that symlink, and move `codex.standalone-0.157.1` back to `codex`.
The original pair will again require `--no-daemon`. Keep the packaged release
until no running DEV processes depend on it.

## Remaining host verification

Run through the existing launcher from the normal host terminal:

```bash
wowsync-codex --version
wowsync-codex app-server daemon start
wowsync-codex app-server daemon version
wowsync-codex --no-alt-screen -m gpt-6-luna -c model_reasoning_effort=medium
```

In that fresh session, inspect `/status` and ask it to run `id -un` and `pwd`.
Require `wowsync-dev`, the DEV checkout, approval `never`, and sandbox
`workspace-write`. Confirm an actual shell tool response, not just a textual
answer. Record this test session's ID, then exit and test explicitly by ID:

```bash
wowsync-codex resume TEST_SESSION_ID
wowsync-codex fork TEST_SESSION_ID
```

Require restored history for resume and a distinct session ID with inherited
history for fork; run another shell probe in each. Do not use `--last`, which
could select unrelated work. None of these commands should need `--no-daemon`.
Verify the daemon belongs to `wowsync-dev`; retain the existing host isolation
checks described in OMARCHY_DEV_LIVE_ISOLATION.md. Do not claim completion until
the host daemon and all three session paths have passed.
