# CLI command reference (commands)

**English** ｜ [简体中文](../../reference/commands.md)
<!-- i18n-slot: append new-language links on the line above; convention: .agents/conventions/docs-writing.md -->

> Quick lookup for every CLI command. Unlike [config-reference.md](./config-reference.md) (script-generated), this table is **maintained by hand** — the command surface is defined in `src/cli/index.ts`; update this table when the surface changes (a generator, mirroring config-reference, may replace it later).
> Option-level details and examples: [Usage guide §5](../guide/usage.md); common conventions (`--yes` skips confirmation, `--json` structured output) apply to most commands.

## Init & config

| Command | Purpose |
|---|---|
| `init [--yes]` | First-run wizard: detect → import existing configs → pick presets → start gateway → attach clients |
| `import --from all\|cc-switch\|claude\|dsh\|zcode\|… [--yes] [--no-with-profiles]` | Read-only onboarding of existing local configs (originals untouched) |
| `config edit` | Edit config.toml in `$EDITOR`, validated on save |
| `config export` / `config import <file>` | Export / import passphrase-encrypted config pack (.msync, manual cross-machine migration) |

## Providers & models

| Command | Purpose |
|---|---|
| `provider add [presetId] [--name/--base-url/--protocol/--auth/--key/--key-env/--no-fetch/--yes]` | Add an upstream (fetches models by default; can create a same-name profile) |
| `provider list` / `provider rm <id>` | List (masked) / remove (removes keys and referencing profiles) |
| `provider set-key <id> [--add]` | Replace key, hot-effective; `--add` appends to the multi-key pool |
| `model list [pid]` / `model refresh <pid>` | View / re-fetch model catalog |
| `model set <pid> <model> [--ctx/--max-out/--display/--cap]` | Edit model metadata (context / max output / display name / capabilities) |
| `model fallback <pid> <primary> <backup>` | Configure model-level failover mapping (price-gate validated) |
| `model catalog refresh` | Supplement unknown models from the models.dev community catalog |

## Routing

| Command | Purpose |
|---|---|
| `profile add [name] --provider/--model/--aliases/--tier` | Create a routing profile (aliases support `*` wildcards; tier label) |
| `profile use <name>` | Switch default route (hot-effective) |
| `profile list` / `profile rm <name>` | List / remove |

## Attach & runtime management

| Command | Purpose |
|---|---|
| `attach <harness> [--mode gateway\|file] [--profile] [--set-default] [--takeover-models] [--port] [--yes]` | Attach a client: diff preview → snapshot → write |
| `detach <harness> [--yes]` | Detach and restore (prefers restoring the latest attach snapshot) |
| `token <harness>` | Show the client's local gateway token |
| `harness route <id> [profile]` | Change route at runtime (protocol compatibility validated before write) |
| `harness direct <id> [profile]` | Switch to standalone direct mode (rescue channel: upstream URL + real key written into the client) |
| `harness gateway <id>` | Switch back to gateway mode |
| `harness restore <harness> [snapshotId] [--list]` | Restore client config from a snapshot |
| `env` | Print generic-env variables (fallback for any client reading env vars) |

## Gateway

| Command | Purpose |
|---|---|
| `gateway start [--port] [--daemon] [--debug]` | Start the gateway (foreground / background daemon; debug logging) |
| `gateway stop` | Stop the targeted instance (releases service ownership first to avoid restart tug-of-war) |
| `gateway install` / `gateway uninstall` | Register / remove the autostart system service |
| `gateway rotate-token` | Rotate the admin token (invalidates all existing logins) |
| `gateway status` | Gateway and instance status |
| `gateway log [-n] [-f] [--harness]` | Request logs (daily JSONL) |
| `ui` | Open the web console (token attached automatically) |

## Diagnostics

| Command | Purpose |
|---|---|
| `test [profile]` | Send one minimal streaming request upstream through the gateway (reachability & latency) |
| `doctor [--deep] [--fix] [--json]` | Health check: `--deep` real-request deep check, `--fix` tiered repair with auto re-verification, exit code 1 on bad items |
| `status` | Overview table |
| `mcp list` | Read-only MCP config inventory |

## Maintenance

| Command | Purpose |
|---|---|
| `adapter list` | Three-tier adapters and detection status |
| `sync setup/status/pause/enroll/resume` | Multi-machine config sync (WebDAV / local sync folder / cloud enrollment) |
| `update [--check/--yes/--token/--clean/--restore]` | Self-update; `--restore` swaps back to the previous version in seconds (no download) |
| `presets update` | Remote preset-library update (planned placeholder; presets ship with releases today) |
| `usage` | Usage-stats pointer (see the web console status line and the admin `/_modeldock/usage` endpoint) |
| `reset` | Restore all clients → stop gateway → clear config & secrets (snapshots and logs kept) |
| `uninstall` | Restore all → stop gateway → delete the entire data directory |

> The Dockmaster orchestrator command family (`sail` / `schedule` / `reconcile` etc.) belongs to this repo's dev toolchain (`.agents/`) and is not part of the product CLI.
