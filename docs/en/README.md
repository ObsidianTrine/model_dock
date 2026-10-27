# ModelDock

**English** ｜ [简体中文](../../README.md)
<!-- i18n-slot: append new-language links on the line above (e.g. ｜ [日本語](../ja/README.md)); convention: .agents/conventions/docs-writing.md -->

[![test](https://github.com/ObsidianTrine/model_dock/actions/workflows/test.yml/badge.svg)](https://github.com/ObsidianTrine/model_dock/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)

**A local model configuration hub + API gateway**: one config keeps every AI harness in check (Claude Code, ZCode, dsh, Codex, OpenCode, MiMo Code, MiMo Desktop, WorkBuddy…) — attach once, switch anytime, keys kept in one place.

- **Gateway mode (default)**: point each harness at `http://127.0.0.1:8687` once — switching providers / model mappings then happens entirely on the ModelDock side, takes effect immediately, and real upstream keys never appear in harness config files.
- **Flexible routing**: scheduled switching changes services by time of day (off-peak / peak / holidays, statutory holidays recognized automatically); a single client can pin its own service/model, or go "direct" to reach the upstream without the gateway; when the primary service is unreachable, rate-limited, or out of quota, traffic automatically fails over to other enabled services (automatic fallback chain).
- **Non-invasive**: before you run `attach`, ModelDock writes nothing to your existing harnesses; writes to client configs (attach / switching) are auto-snapshotted (`config.toml` itself is protected by locking + atomic writes), and `detach` / `restore` revert in one command.
- **Key security**: upstream keys live in the platform's secure backend (macOS Keychain / Windows DPAPI / Linux Secret Service, with a machine-bound-encryption fallback when no keyring exists); existing plaintext keys migrate automatically.
- **Always-on reliability**: `gateway install` registers auto-start on boot (macOS LaunchAgent / Linux systemd with crash auto-restart; Windows registry Run key for login auto-start) — a dead gateway no longer disconnects your clients.
- **Menu bar / tray resident**: a permanent macOS menu bar / Windows system tray entry — open the console, open in browser, switch service / change default model / attach or detach clients, toggle auto-start, view logs, clean up data in one click; closing the console window keeps the gateway running; "Lightweight mode" collapses every window and leaves only the tray resident; "Quit" in the tray stops it.
- **Check it from your phone**: scan the QR code on the same LAN to open a compact console — view status, switch services, adjust auto-routing, and keep it on your phone's home screen as an app; the main gateway still listens on this machine only (off by default; one-click enable via the "Phone Remote" button at the top of the console).
- **Portable config**: `modeldock config export` exports a passphrase-encrypted config package (services, routes, custom presets, schedules — keys included) in one command; on a new computer `modeldock config import` brings everything over. On the same LAN it's even simpler — the new computer's console "Import from another computer" discovers nearby machines, the old computer taps "Allow", done, no copy-paste; the phone console can also carry packages via QR export/import.
- **Multi-machine auto-sync**: `modeldock sync setup` targets a WebDAV drive or a local sync folder — service / key / route changes across your computers converge automatically in both directions, and conflicts never lose data; advanced users can self-host a cloud hub ([deploy-cloud.md](deploy-cloud.md)) to manage all devices from one phone page and switch services remotely.
- **One-command upgrade**: `modeldock update` checks and installs new versions — download, SHA256 verification, replacement, and gateway auto-restart in one command, no more manual downloads from the Releases page; the Web console top bar and the tray menu also surface new versions with release notes and a link, upgradeable right in the UI.
- **Extensible**: built-in adapters (Claude Code / ZCode / dsh / Codex / OpenCode / MiMo Code / MiMo Desktop / WorkBuddy / generic env) + declarative adapter packs (onboard new harnesses with zero code).

## Quick start

### Option 1: Windows setup wizard (recommended for Windows)

Download `modeldock-<version>-win32-x64-setup.exe` from [Releases](https://github.com/ObsidianTrine/model_dock/releases) and double-click to install: optionally pick the install path; PATH and Start-menu / desktop shortcuts are written automatically (shortcuts launch the tray program — double-click for the console, no black command-line window); uninstalling restores all client configs and cleans up.

> The installer is not code-signed; when SmartScreen prompts the first time, click "More info → Run anyway". Portable users can download `modeldock-<version>-win32-x64.zip`, extract it, and double-click `modeldock.exe` — the first double-click installs the `modeldock` command into PATH automatically; open a new terminal and it works. You can also double-click `ModelDockTray.exe` to reach the console without a terminal window.

### Option 2: macOS drag-and-drop install (DMG, macOS 13.0+)

Download `modeldock-<version>-darwin-x64.dmg` (Intel) or `modeldock-<version>-darwin-arm64.dmg` (Apple Silicon) from [Releases](https://github.com/ObsidianTrine/model_dock/releases):

1. Open the DMG and drag **ModelDock** into the **Applications** folder
2. First launch: in Applications, **right-click → Open → Open** (the standard way to allow an unnotarized app; after that double-click works normally). If it says the app is "damaged", run `xattr -dr com.apple.quarantine /Applications/ModelDock.app` once in a terminal
3. Double-click ModelDock: the gateway starts in the background (`127.0.0.1:8687`), the Web console opens in a standalone app window, and the `modeldock` CLI installs itself (one admin authorization prompt may appear, used to write to `/usr/local/bin`); after closing the console window the menu-bar tray stays resident — return to the console anytime from the tray, and "Quit" in the tray stops the gateway

> Uninstall: drag ModelDock to the Trash, then run `modeldock uninstall` — stops the gateway and removes the CLI entry, **keeping your config and keys**; reinstalling reconnects automatically. To wipe everything (including restoring all clients), run `modeldock uninstall --purge`.

### Option 3: Linux / command-line install (tar.gz, no Node.js needed)

| Platform | File |
|------|------|
| Linux x64 | `modeldock-<version>-linux-x64.tar.gz` |
| Linux ARM64 | `modeldock-<version>-linux-arm64.tar.gz` |
| macOS Intel | `modeldock-<version>-darwin-x64.tar.gz` |
| macOS Apple Silicon | `modeldock-<version>-darwin-arm64.tar.gz` |

```bash
tar xzf modeldock-<version>-<platform>.tar.gz
chmod +x modeldock
sudo mv modeldock /usr/local/bin/     # or any other directory on your PATH
modeldock init
```

> SHA256 checksums for every artifact ship as `SHA256SUMS` on the Release.

> The gateway can also be managed from the command line: `modeldock gateway start --daemon` / `modeldock gateway stop`; `modeldock gateway install` registers auto-start on boot (launches on login, restarts on crash).

### Build from source (Node.js ≥22)

```bash
git clone https://github.com/ObsidianTrine/model_dock.git
cd model_dock && npm ci && npm run build
node dist/cli.js init     # first-run wizard; for development use `npm run dev -- <command>` to run the source directly
```

### Manual equivalent flow

```bash
modeldock provider add            # pick from the preset library (Volcano Ark / DeepSeek / GLM / Kimi / MiMo / OpenAI…), paste your key
modeldock profile use <name>      # set the default route
modeldock gateway start           # start the local gateway (127.0.0.1:8687)
modeldock attach claude-code      # take over Claude Code (shows the diff first; writes after confirmation with an automatic snapshot)
```

## Daily use

```bash
modeldock status                # overview: gateway / active profile / attach status per harness
modeldock test                  # end-to-end connectivity self-test (key / models / streaming / latency)
modeldock doctor                # per-harness health check; --fix applies fixes (sensitive ones confirm), --json for machines
modeldock gateway log -f        # gateway request logs (prompts are never logged)
modeldock profile use <name>    # switch provider — instant in gateway mode, zero harness changes
modeldock gateway install       # auto-start on boot (resident): launches on login, restarts on crash
modeldock update                # one-command upgrade: download → verify → replace → auto-restart gateway (--check to look only)
modeldock model refresh <id>    # fetch the upstream model list automatically
modeldock config export         # move to a new computer: export a passphrase-encrypted package (services/routes/presets/schedules, keys included); default name has date-time, -o for a custom path
modeldock config import <file>  # import on the new computer: preview what will be replaced → confirm → auto-backup then apply
modeldock sync setup            # multi-machine auto-sync: target = WebDAV drive / local sync folder, changes converge both ways
modeldock detach <harness>      # restore the pre-attach original config
modeldock reset                 # reset config (snapshots kept, re-init later); --deep also clears logs, sync state and caches
modeldock uninstall             # uninstall the program (config & keys kept); --purge wipes everything including config
```

> Web console: with the gateway running, run `modeldock ui` (or open `http://127.0.0.1:8687` in a browser) — overview dashboard, one-click route switching, scheduled switching (change services by time of day / statutory holidays), new profiles, key replacement, one-click migration of legacy configs, client "Install & attach" (installs even without Node.js on the machine, downloading a managed runtime), live logs; on the same LAN, phones can scan a QR code for the compact console.

> Bilingual UI: CLI output and errors are Chinese by default; `modeldock --lang en` (anywhere in the command) switches to English. You can also set `MODELRDOCK_LANG=en`, or write `language = "en"` in config.toml to persist; the Web console toggles Chinese/English in the top bar anytime, and server-side messages such as errors follow along.

## Documentation

- **Usage guide: [usage.md](usage.md)** (full config & daily-operation walkthrough)
- Design doc: [docs/design.md](../design.md) (architecture, ADRs, threat model — Chinese)
- New computer & multi-machine sync: [multi-machine-sync.md](multi-machine-sync.md) (complete steps & troubleshooting for sync-folder onboarding)
- Cloud deployment: [deploy-cloud.md](deploy-cloud.md) (self-hosted cloud sync hub runbook)
- Changelog: [CHANGELOG.md](CHANGELOG.md)

## Security

The gateway listens on `127.0.0.1` only and is not remotely accessible (by design); upstream keys live only in the local secure backend, and only local tokens appear in harness configs; request logs record metadata only, never prompts. Full threat model and security design: [design doc §9](../design.md#9-安全设计) (Chinese). Found a security vulnerability? Please report it privately via the [security policy](SECURITY.md).

## Contributing

Issues are welcome for bug reports and feature requests. Before submitting a PR, please read the [contributing guide](CONTRIBUTING.md) and [AGENTS.md](../../AGENTS.md) (engineering conventions and hard constraints, maintained in Chinese), and make sure `npm test` passes.

## Maintainer

[@ObsidianTrine](https://github.com/ObsidianTrine)

## License

[MIT](../../LICENSE) © ObsidianTrine
