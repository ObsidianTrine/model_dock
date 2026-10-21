# ModelDock Usage Guide

**English** ｜ [简体中文](../usage.md)
<!-- i18n-slot: append new-language links on the line above; convention: .agents/conventions/docs-writing.md -->

> In one line: collect the base_url + key of every AI harness (Claude Code / ZCode / dsh / Codex / …) into ModelDock; each harness points at the local gateway once, and from then on switching providers or model mappings is one command, effective immediately.

**Contents**: [1. Core concepts in three minutes](#1-core-concepts-in-three-minutes) · [2. Installation & build](#2-installation--build) · [3. First steps (recommended path)](#3-first-steps-recommended-path) · [4. What attach does to each harness](#4-what-attach-does-to-each-harness) · [5. Daily usage](#5-daily-usage) · [5.5 Web console](#55-web-console) · [6. Restore & uninstall (fully reversible)](#6-restore--uninstall-fully-reversible) · [7. Config file reference (~/.modeldock/)](#7-config-file-reference-modeldock) · [8. Gateway & ports](#8-gateway--ports) · [9. Troubleshooting](#9-troubleshooting) · [10. Implementation status (v1.0.0)](#10-implementation-status-v100)

## 1. Core concepts in three minutes

```
provider (upstream credentials: base_url + key + model catalog)
   ↓
profile (a route: which provider + default model + model alias mapping)
   ↓
harness (how each client attaches: claude-code / zcode / dsh / codex / opencode / mimo-code / mimo-desktop / workbuddy / generic-env)
```

- **Gateway mode (default)**: the harness config only ever contains `http://127.0.0.1:8687` + a local token; the real key never leaves ModelDock. Switching providers changes ModelDock's routing — harness configs stay untouched.
- **Non-invasive**: before you run `attach`, ModelDock is **read-only** on your existing harness configs; writes to client configs (attach / switching) are auto-snapshotted beforehand (`config.toml` itself is protected by locking + atomic writes), and `detach` / `restore` revert anytime.

## 2. Installation & build

### Download a standalone package (no Node.js needed)

Download the package for your platform from [Releases](https://github.com/ObsidianTrine/model_dock/releases). Per-platform forms:

- **Windows**: `modeldock-<version>-win32-x64-setup.exe` setup wizard (optional install path, automatic PATH & shortcuts, uninstall restores and cleans up); for a portable install use `modeldock-<version>-win32-x64.zip` — extract and run.
- **macOS**: `modeldock-<version>-darwin-<arch>.dmg` drag-and-drop install (next section); command-line users can extract the `.tar.gz` and run `chmod +x modeldock && sudo mv modeldock /usr/local/bin/`.
- **Linux**: `modeldock-<version>-linux-<arch>.tar.gz`, extract and move into a PATH directory.

SHA256 checksums for every artifact ship as `SHA256SUMS` on the Release.

### macOS graphical install (DMG, macOS 13.0+)

Download `modeldock-<version>-darwin-x64.dmg` (Intel) or `modeldock-<version>-darwin-arm64.dmg` (Apple Silicon) from [Releases](https://github.com/ObsidianTrine/model_dock/releases); open the DMG and drag **ModelDock** into **Applications** to install.

- **First launch**: in Applications, right-click → Open → Open (the standard way to allow an unnotarized app; needed once only). If it says the app is "damaged", run `xattr -dr com.apple.quarantine /Applications/ModelDock.app` once.
- **Daily use**: double-clicking ModelDock starts the gateway in the background, opens the Web console in a standalone app window, and installs the `modeldock` CLI into `/usr/local/bin` (one admin authorization prompt when needed; declined once, it won't nag again). The full CLI then works directly in the terminal. After closing the console window the menu-bar tray stays resident — return to the console anytime from the tray; "Quit" in the tray stops the gateway.
- **Uninstall**: drag ModelDock to the Trash, then run `modeldock uninstall` — stops the gateway and removes the CLI entry, **keeping your config and keys**; reinstalling reconnects automatically. To wipe config and keys too and restore every client, run `modeldock uninstall --purge`.

### Build from source

```bash
git clone https://github.com/ObsidianTrine/model_dock.git
cd model_dock
npm install
npm run build          # TypeScript compile, output in dist/
npm link               # register the modeldock command globally
modeldock --help

# Build a standalone executable (current platform)
npm run build:sea

# Cross-compile for a specific platform
npm run build:sea -- --target linux-x64
npm run build:sea -- --target darwin-arm64
```

Dev mode: `npm run dev -- <command>` (equivalent to running the source with tsx).

## 3. First steps (recommended path)

### Option A: one-command wizard

```bash
modeldock init
```

The wizard, in order: detects local harnesses → lists existing providers discovered from cc-switch / Claude Code / Codex / dsh / ZCode / OpenCode / MiMo Code / WorkBuddy / claude-code-router / Crush / Gemini CLI (tick to import, keys included) → adds from the preset library if there's nothing to import → picks the default route → starts the gateway in the background → attaches each harness (showing the diff at every step). `--yes` runs fully unattended.

### Option B: migrate from cc-switch (recommended if you use it today)

```bash
modeldock import --from cc-switch   # absorb Volcano / DeepSeek / Xiaomi MiMo profiles (the original library stays read-only)
modeldock profile list              # inspect the import result
modeldock profile use <name>        # set the default route
modeldock gateway start --daemon    # start the gateway (127.0.0.1:8687)
modeldock attach claude-code        # take over Claude Code: diff → confirm → auto snapshot
modeldock test                      # end-to-end connectivity self-test
```

After migrating, **quit cc-switch (or stop its local proxy)** so the two sides don't edit `~/.claude/settings.json` at the same time.

`import` covers more than cc-switch: `--from` accepts all / cc-switch / claude / dsh / zcode / codex / opencode / mimocode / workbuddy / ccr / crush / gemini — upstreams configured in Codex, OpenCode, MiMo Code (shared with the desktop app), WorkBuddy, claude-code-router, Crush, and Gemini CLI relays are absorbed read-only as well. Channels on a self-hosted one-api / new-api site are pulled over its admin API:

```bash
modeldock import --from oneapi --url https://your-site --token <system access token>
```

Generate the token under one-api "Personal settings → System access token" (new-api has the same entry); only OpenAI-compatible / Anthropic channels are imported — Azure, native Gemini, and other protocols ModelDock cannot reach directly are skipped with the reason shown.

### Option C: configure manually, step by step

```bash
modeldock provider add                       # fuzzy-search the preset library → pick one → paste key, URL filled in
modeldock provider add deepseek-anthropic    # or specify a preset id directly
modeldock profile add my-route --provider deepseek-anthropic --model deepseek-chat \
  --aliases "claude-sonnet-*=deepseek-chat,claude-opus-*=deepseek-reasoner"
modeldock profile use my-route
modeldock gateway start --daemon
modeldock attach claude-code
```

## 4. What attach does to each harness

| harness | command | what attach does | what you do next |
|---|---|---|---|
| Claude Code | `modeldock attach claude-code [--takeover-models]` | Changes only `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` in `~/.claude/settings.json`, every other field untouched; `--takeover-models` (optional) migrates the `DEFAULT_*_MODEL` mappings into the profile and removes them from the file | Restart Claude Code |
| ZCode | `modeldock attach zcode` | **Adds** a modeldock provider entry to `~/.zcode/v2/provider_config.json` (hot-reloaded, effective immediately), existing entries untouched; a legacy `builtin:modeldock` entry in `config.json` from older versions is cleaned up automatically on attach | Select the ModelDock provider once in ZCode settings |
| dsh | `modeldock attach dsh [--set-default]` | Adds a modeldock provider to `~/.dsh/settings.yaml` (apiKeyEnv indirect reference), token written into `.credentials.yaml`; `--set-default` also switches agent-default-model | Restart dsh |
| Codex | `modeldock attach codex [--set-default]` | Creates/edits `~/.codex/config.toml` to register the modeldock provider (wire_api=chat) | `export MODELRDOCK_CODEX_TOKEN=$(modeldock token codex)` into `~/.zshrc` (once) |
| OpenCode | `modeldock attach opencode` | Adds `provider.modeldock` to `~/.config/opencode/opencode.json` (OpenAI-compatible `/v1`) | Restart OpenCode |
| MiMo Code | `modeldock attach mimo-code` | Registers the modeldock provider in `~/.config/mimocode/mimocode.jsonc` (or `.json`, `MIMOCODE_HOME` overrides) and writes model declarations per the current route; supports auto-install (npm `@mimo-ai/cli`) | Restart MiMo Code; verify with `mimo models` |
| WorkBuddy | `modeldock attach workbuddy` | Writes the current route's model entry array into `~/.workbuddy-ai/models.json` (multi-candidate detection; same format as the UI's "Add model"), your existing custom entries preserved | WorkBuddy hot-reloads while running; restart it if the model list doesn't refresh |
| Anything else | `modeldock attach generic-env` then `eval "$(modeldock env)"` | Writes no files | Source the env output into your shell |

attach can be re-run safely (idempotent update). View a harness's token: `modeldock token <harness>`.

## 5. Daily usage

```bash
modeldock ui                      # ★ open the local Web console (browser logs in automatically)
modeldock profile use <name>      # ★ switch provider: in gateway mode new requests go through the new route immediately, harness untouched
modeldock gateway install         # ★ auto-start on boot (resident): registers a system service, launches on login, restarts on crash
modeldock status                  # overview: gateway / active profile / where each harness points
modeldock test [profile]          # connectivity self-test: key, model names, streaming, latency in one go
modeldock doctor                  # full checkup; --fix applies fixes (sensitive ones confirm per item), --json for machines
modeldock gateway log -f          # live request logs (metadata only, prompts never logged)
modeldock gateway log --harness claude-code
modeldock config export           # move computers: export a passphrase-encrypted package (services/routes/presets/schedules, keys included); defaults to modeldock-config-<date>-<time>.msync, -o for a custom path
modeldock config import <file>    # import on the new computer: preview what will be replaced → confirm → auto-backup then apply
modeldock sync setup              # multi-machine auto-sync: target = WebDAV drive / local sync folder, changes converge both ways
modeldock sync status             # sync status: target / last push-pull / conflicts (sync pause / resume pauses this machine)
modeldock update                  # one-command upgrade: download → SHA256 verify → replace → auto-restart gateway
```

> UI language: output and errors are Chinese by default; add `--lang en` to any command for English, set the environment variable `MODELRDOCK_LANG=en`, or write `language = "en"` in config.toml to persist (the background gateway follows the same language).

### Version updates (one-command upgrade)

```bash
modeldock update --check          # check for a new version only (summary + release-page link), no install
modeldock update                  # check → confirm → download & verify → replace → auto-restart gateway (anonymous works for public repos, no token needed)
modeldock update --token <token>  # optional: save a GitHub access token (fine-grained, Contents read-only; stored in the system secure store) — only required when the update source is a private repo; configuring it raises the anonymous rate limit from 60/h to 5,000/h
modeldock update --clean          # clean leftovers from the previous version (ModelDock.app.old / *.old)
```

After a release you never manually download and reinstall again: `modeldock update` does it in one command. Before installing it verifies the downloaded package's SHA256 (the checksum list always comes from GitHub official; large downloads can go through a mirror); the gateway briefly interrupts during replacement and is brought back up in its original state afterwards (on macOS, an app launched from ModelDock.app reopens the app and tray automatically). Update source / token / mirror are recorded under `~/.modeldock/` (config.toml `[update]` section + secure key storage; `mirror` defaults to the gh-proxy → ghfast → official fallback chain, set an empty array to disable) — see `docs/design-auto-update.md` (Chinese).

> Prefer not to type commands? When the gateway discovers a new version while running, a copyable notice pops up in the console's bottom-right corner and an amber "Update available vX.Y.Z" badge appears in the top bar — click it for a centered update card (version / package size / release-notes body, with a "See the full notes on GitHub" link at the bottom) and upgrade in one click; the page reconnects automatically afterwards; failures immediately explain why; "Don't remind me for this version" opts out; with no new version the UI stays silent (manual check via `modeldock update --check`, or the macOS menu bar / Windows tray "Check for updates…" — the tray dialog shows the curated summary (first paragraph + key bullets + N changes in total) with "Update now" to upgrade in place, or "Open release page" to read every item). The gateway also silently checks once at startup (no repeats within 24 hours; failures stay quiet).

## 5.5 Web console

Open `http://127.0.0.1:8687/_modeldock/ui` in a browser, or simply:

```bash
modeldock ui
```

**Opening the page auto-detects legacy configs**: if any of cc-switch / Claude Code / Codex / dsh / ZCode / OpenCode / MiMo Code / WorkBuddy / claude-code-router / Crush / Gemini CLI already has provider configs, a "🧲 Legacy config detected — move it in with one click" banner appears at the top — one click imports everything (keys move in securely, the original software is unaffected, already-imported items are deduplicated and never re-prompted; "Not now" hides the banner).

The UI is three steps with **no new concepts to learn**:

- **① Add a model service**: click a provider card (DeepSeek / Zhipu GLM / Kimi / Volcano Ark / Xiaomi MiMo / OpenAI / more…), paste the API key, done. The endpoint fills itself in, the model list fetches itself, and the key stays on this machine; official docs are linked.
- **② My services**: click "Apply" to switch globally — every attached client immediately uses the new service, with zero changes to their configs. Each service supports "Speed test" and "Edit" (rename / change endpoint / swap key).
- **③ Attach your AI clients**: for Claude Code / ZCode / dsh / Codex / OpenCode / MiMo Code click "One-click attach" — client not installed? "Install" right in the panel (works even without Node.js on the machine — downloads a managed runtime and attaches, mainland mirror accelerated; runs the official install command, or gives manual guidance), then attach. The dialog explains in plain language what will change and that it's reversible; after confirmation it writes and backs up automatically; restart the client to take effect. "Detach & restore" anytime. Other clients choose "Generic env vars" — after attaching, one-click copy of the standard `ANTHROPIC_*` / `OPENAI_*` variables to paste into any client that accepts a custom endpoint, routing them through the gateway.

The top of the page shows the current service and model — the "In use" status card above "My services" is the single source of truth (large service name, model, and a colored source chip, with "Next failover: <service>" on the card's right edge — who is serving now and where traffic goes on failure, layered at a glance), and service-card badges, the mobile page, and model lists all agree with it (manual pin > schedule window > default route); when a scheduled window matches but is not in effect (pinned, target offline, or circuit-broken), the schedule pill says why. The first row holds two dropdowns, "Current" and "Next switch": picking in "Current" pins the service manually (same effect as "Apply" on a service card, and it takes precedence over the scheduled switcher's automation); "Next switch" pins which service to switch to when the primary is unreachable — choose "Auto · <service name>" to hand control back to the program. With neither a configured fallback chain nor the "automatic fallback chain" toggle, it reads "Auto · no fallback service", meaning a primary failure switches to nothing — add one under "Failover order" in the service's edit page. Manually pinned services still fall through to backups automatically on failure. **Recent request logs live permanently at the bottom of the page** — when a client errors, look here first for the cause. Once a service exists, "Add model service" collapses into a floating ＋ button at the bottom right, opening a dialog on click. The top bar switches between Auto / Dark / Light themes (dark by default, choice remembered); "中文 | EN" toggles the UI language, with server-side messages such as errors and client cards following along.

Two productivity switches:

- **Scheduled switching (⏰)**: switch between services automatically by time of day — e.g. route to DeepSeek during its off-peak half-price window (00:30–08:30) and to your main service the rest of the time; statutory holidays are discounted all day on DeepSeek, so add a "statutory holiday" window that prefers it all day. Effective days support every day / weekdays (Mon–Fri plus make-up workdays) / weekends / statutory holidays; the calendar is fetched and updated automatically from the State Council announcements — no manual maintenance; windows may cross midnight. Auto-routing as a whole is one master toggle (on = enabled); settings save as you change them, every request is evaluated in real time, so edits take effect immediately, and the panel also shows the nearest statutory holidays.
- **Auto-start on boot**: registers the system service in one click from settings (macOS LaunchAgent / Linux systemd / Windows startup folder) — the gateway launches on login and restarts on crash, always-on so clients never disconnect.

The auto-routing row also has two failover-related toggles: "Temporary failure → fallback" = when the primary returns 429 rate-limiting or 503 unavailability, automatically retry via the fallback (default on); **"Automatic fallback chain" (default on) = failover works even without a manually configured chain** — when the primary is unreachable, rate-limited, or out of quota (e.g. DeepSeek returning 402 out of balance), the other enabled services automatically join the switching candidates, ordered by schedule, priority, and measured latency (up to 3); model names pass through unchanged — change models in the client. A manually configured "Failover order" always runs before the auto tail.

**Menu bar / tray resident**: the macOS menu bar and Windows system tray have a permanent ModelDock icon — open the console, open in browser, toggle auto-start, open the log directory; closing the console window keeps the gateway running, and "Quit" stops the gateway and exits the tray.

**Phone compact console (LAN)**: off by default. The "Phone Remote" toggle at the top of the console — the main switch turns it on / off with one click, and the arrow on the right expands / collapses the QR panel (turning it off uses the "Turn off phone remote" button inside the panel). With the phone on the same LAN, scan to open the compact page: view the current service and status, switch services, adjust auto-routing (same controls and values as the desktop console, plus which service is actually in use right now); the "Config sync" card can export a passphrase-encrypted config package to your phone, then upload and import it from another computer — moving configs across networks without a USB stick (the page only carries ciphertext and previews for confirmation; it never shows keys); the footer guides you to "Keep it on your phone's home screen" — added to the home screen it opens as a standalone fullscreen window with the ModelDock icon (opened inside WeChat it first suggests switching to a browser). You can also open `http://<machine-IP>:8787` directly in the phone browser. It can also be enabled directly in config.toml:

```toml
[lan]
enabled = true
# port = 8787   # default 8787, auto-increments if taken
```

The compact page only exposes status viewing, service switching, routing adjustment, and config sync; admin credentials are never sent to it; the main gateway still listens on `127.0.0.1` only, never exposed externally.

Security: the console is reachable from this machine only; reading needs no password, and write operations require a "same-origin browser request" (so other web pages can't secretly drive your local gateway) — **there is no admin-token concept and no password to type**.

### Model catalog (auto-fetched, prefilled, hand-editable)

```bash
modeldock model list                     # input context / max output / capabilities / source for each model
modeldock model refresh <id>             # auto-fetch from the upstream /v1/models
modeldock model set <provider> <model> --ctx 262144 --max-out 32768   # edit metadata by hand
modeldock model set <provider> <model> --cap reasoning,vision         # edit capability flags by hand
```

- **Vision** is an optional model capability: in the console's "Edit service → model table" there's a checkbox column after context / max output — checked means the model accepts images; well-known vision models (GPT / Claude / Gemini / Kimi-K3 / GLM-5.3-Flash etc.) come pre-checked, and ids with date suffixes (like `kimi-k3-260701`) are recognized by base name. Attaching dsh declares the image-input modality accordingly.
- **Display names**: when a model has a display name separate from its ID (returned by the vendor or shipped in the preset, e.g. "DeepSeek V4 Pro"), the edit / add service model tables show it in small text under the model ID; hidden when identical to the ID or absent. Names returned when fetching models are saved along with "Apply selected", and attached clients (dsh / workbuddy etc.) show them in their model lists too.
- **Reasoning levels need no configuration**: attaching dsh declares them per its official four levels (off / low / medium / high), so the thinking level you pick in dsh is no longer rejected (previously hand-written models were all judged "thinking level not supported").

### Key rotation

```bash
modeldock provider set-key <id>          # hidden input; or --key-env MY_VAR
```

### Multi-machine sync & cloud management (advanced)

Keep the same config across computers:

```bash
modeldock sync setup             # target = WebDAV drive (Nutstore etc.) or local sync folder (Google Drive etc.), set a sync passphrase
modeldock sync status            # target / revision / last push-pull / errors & conflicts; sync pause / resume pauses this machine
```

- Changes converge both ways automatically: new services, key swaps, route edits — other computers follow on their own; conflicts auto-snapshot both sides so nothing is lost. When the target already has data, a newly enrolled computer converges to the latest automatically; sync status shows as a small badge in the console top bar (normal: "Config sync · on"; conflict / error / paused recolors it as a warning — the conflict hint clears once your local changes have pushed back successfully; hover for the sync target, revision, and recent push-pull details; config and administration happen on the computer via the CLI).
- Guard the sync passphrase carefully — if forgotten, the ciphertext is unrecoverable.
- **New computer**: the drive client syncing files over is only "transport"; the new computer must still run `modeldock sync setup` once (same target, same passphrase) to enroll and converge. Complete steps (pre-checks & troubleshooting table): [multi-machine-sync.md](multi-machine-sync.md).

**Move computers on the same LAN — no drive, no file copying**: on the old computer's console, expand the "Phone Remote" QR panel and click **"Share config to nearby computers…"** to generate a link (valid 10 minutes, void after one fetch); on the new computer's console, from the "My services" empty state click **"Import from another computer…"**, paste the link, preview what will be replaced, confirm — done. The link carries a one-time passphrase; treat it like a key and send it only to the intended recipient.

No link? Use a config package: on the old computer, click **"Export config package"** on a service card to generate a passphrase-protected encrypted file (same capability as the `config export` command), send it to the new computer via WeChat / USB, then pick the file and enter the passphrase under "Import from another computer…"; a brand-new computer can also enable "Phone remote" — scan the new computer's QR code into the phone console and import the package stored on the phone (use a system browser; WeChat's built-in browser can't pick files; on iPhone the exported package lands in Files → Downloads).

**No copy-paste: pick from nearby computers**: in the new computer's "Import from another computer" dialog click **"Search nearby computers…"** — ModelDock computers on the same network with "Phone remote" enabled list automatically; clicking one starts the pull; the old computer shows a confirmation card (displaying the requester's hostname) — click **"Allow pull"** and the config arrives for preview and confirmation. Discovery runs over the local network (UDP broadcast, never through an external server); if your router has client isolation enabled the search comes up empty — use the link or file method above instead.

You can also self-host a cloud hub for unified multi-device management (advanced): deploy the control plane on a cloud server (one-page runbook: [deploy-cloud.md](deploy-cloud.md)), then enroll computers with `modeldock sync enroll --server http://<IP>:18443 --code <pairing code>`; open the cloud address in a browser (best on the phone), paste the consoleToken to log in, and you can view all devices, switch services per-device or in bulk (effective within 1 minute), and generate new pairing codes. Enrolled devices heartbeat their service catalogs up, so the switch dropdown automatically lists every service the target machine actually has.

## 6. Restore & uninstall (fully reversible)

```bash
modeldock restore claude-code --list     # list all snapshots for that harness
modeldock restore claude-code <id>       # restore to any snapshot (it snapshots first too, so this is undoable)
modeldock detach claude-code             # detach = restore to the pre-attach state
modeldock uninstall                      # uninstall: stop gateway → remove auto-start/CLI entry; config & keys kept, reinstall reconnects
modeldock uninstall --purge              # full wipe: restore clients → stop gateway → delete ~/.modeldock and stored keys
modeldock reset                          # reset config: restore clients → stop gateway → delete config & keys (snapshots & logs kept)
modeldock reset --deep                   # clean data: all of the above + delete logs, sync state and local caches (snapshots still kept)
```

> The menu bar / tray icon also has "Clean up data…": after a confirmation dialog it is equivalent to `modeldock reset --deep` — the exact same cleanup logic as the CLI.

## 7. Config file reference (~/.modeldock/)

```
config.toml    main config: providers / profiles / harness / adapter_packs / gateway
secrets.json   key storage (macOS Keychain, Windows DPAPI encryption, Linux Secret Service; falls back to 0600 plaintext only without a keyring; existing plaintext migrates automatically at startup)
sync.json      multi-machine sync state (sync target / passphrase cache / cloud enrollment info, maintained by sync)
gateway.json   gateway runtime state (pid / actual port / admin token, maintained by the gateway)
backups/       snapshots of every write operation (<harness>/<timestamp>-<operation>/, rolling 20 by default, adjustable via config backup.keep, minimum 1)
logs/          gateway request logs (daily JSONL, metadata only)
```

`config.toml` example (directly hand-editable; `modeldock config edit` opens an editor and validates):

```toml
version = 1
active_profile = "ark-coding"

[providers.ark_coding]
base_url = "https://ark.cn-beijing.volces.com/api/coding"
protocol = "anthropic"            # anthropic | openai
auth_style = "bearer"             # bearer | x-api-key
key_ref = "file:ark_coding"       # also keychain: <id> / env:<VAR>
proxy = "direct"                  # direct | env | http://127.0.0.1:7890 (clash)

[providers.ark_coding.models.deepseek-v4-flash]
display_name = "DeepSeek V4 Flash"
context_window = 131072           # input context
max_output = 8192                 # max output
capabilities = ["tools", "reasoning"]
source = "preset"                 # preset | fetched | manual

[profiles.ark-coding]
provider = "ark_coding"
default_model = "deepseek-v4-flash"
aliases = { "claude-sonnet-*" = "deepseek-v4-flash", "claude-opus-*" = "glm-5-3" }

[harness.claude-code]
mode = "gateway"
route = "default"                 # follows active_profile; or pin a specific profile name
token = "mdk_..."

# zero-code way to onboard a new harness (L2 declarative pack)
[adapter_packs.opencode]
format = "json"                   # json | toml | yaml
config_file = "~/.config/opencode/opencode.json"
upsert = { "$.provider.modeldock.baseURL" = "{base_url}", "$.provider.modeldock.apiKey" = "{token}" }
```

Variable templates: `{token}` `{port}` `{base_url}` `{base_url_openai}`. Then `modeldock attach opencode` takes over.

## 8. Gateway & ports

- Default `127.0.0.1:8687`, accessible from this machine only; if the port is taken it auto-increments and prints the actual port (attach writes the actual port).
- Resident: `modeldock gateway install` registers auto-start on boot (launch on login + crash auto-restart on macOS/Linux; `gateway uninstall` removes it); `gateway status` shows the auto-start state and detects a stale launch path registered in the service (e.g. after an nvm upgrade).
- Presets for overseas upstreams (OpenAI / Anthropic / Gemini…) default to `proxy = "env"`, reading the `HTTPS_PROXY` environment variable, clash-compatible; domestic upstreams connect directly.
- Admin endpoints: `/_modeldock/health` and read endpoints need no auth locally; write operations require a same-origin request or the admin token (gateway.json, used by the CLI automatically). Visiting `http://127.0.0.1:8687` in a browser redirects to the Web console.

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| harness reports 401 | wrong token: verify with `modeldock status`, re-run attach; for codex check `MODELRDOCK_CODEX_TOKEN` |
| upstream 401/403 | key invalid: `modeldock provider set-key <id>` |
| upstream 404 model | `modeldock model refresh <id>` to fetch models, or switch profile |
| suspected context overflow | check the model's ctx with `modeldock model list`; switch to a longer-context model |
| gateway down, all harnesses broken | with auto-start installed (`gateway install`) it comes back automatically; otherwise `modeldock gateway start --daemon`; emergency `modeldock detach <harness>` returns to direct mode immediately |
| ZCode not using the gateway | attach only registered the provider — you must also select it once in ZCode settings |
| config broken | `modeldock config edit` or `modeldock restore` |

## 10. Implementation status (2026-10-18 baseline; refresh with the version number at release)

Implemented: every command listed in this document; the gateway (dual-protocol passthrough / model rewriting / SSE / hot reload / error translation / proxies / request-level failover + circuit breaking: manual fallback chain first, automatic fallback chain as tail, auto-switch on quota exhaustion); snapshot restore (retention controlled by `backup.keep`); preset library of 20 (with multi-protocol endpoints and 2026 model parameters); import from four sources; L2 declarative packs; Web console (§5.5, incl. one-click migration, "Current / Next switch" dual-slot dropdowns at the top, client "Install & attach" (works without Node.js, managed runtime + mainland mirror), scheduled switching (auto weekday / weekend / statutory-holiday / make-up day detection, State Council calendar), dark theme); **dual-slot routing ("Current" / "Next switch", manual pin takes precedence over automation, failover always on)**; **phone compact console (LAN 8787 + QR code: status viewing / service switching / routing adjustment / config sync, same data as the desktop; PWA home-screen resident)**; **encrypted config export/import (`config export` / `config import`, full-package AES-256-GCM passphrase encryption, phone QR code as courier)**; **multi-machine auto-sync (`sync setup/status/pause/resume`, WebDAV / local sync folders, two-way convergence + conflict snapshots)**; **cloud hub (self-hosted control plane, see docs/deploy-cloud.md: pairing-code enrollment / heartbeat / cloud phone page managing devices & remote switching)**; **menu bar tray (macOS menu bar / Windows tray: open console / check updates / clean data, quit stops the gateway)**; **secure key storage (macOS Keychain / Windows DPAPI / Linux Secret Service, machine-id-bound encryption fallback without a keyring, automatic plaintext migration)**; **auto-start residency (`gateway install`, macOS LaunchAgent / Linux systemd / Windows startup folder)**; **one-command upgrade (`modeldock update`: GitHub Releases check + SHA256 verify + per-platform replace + gateway auto-restart, mac swaps the whole .app / win silent installer / bare binary replaced in place; console top-bar "update available" badge + one-click dialog + auto-reconnect, tray "Check for updates" menu, silent check at startup with 24h TTL)**; cross-platform support (Linux / macOS / Windows); single-file executables (SEA) and per-platform installers (macOS DMG drag-and-drop / Windows setup wizard, double-click auto-installs the CLI); GitHub Actions automated packaging & release.

Verification status: TypeScript compiles; 817 product tests all green (65 files: store / backup / util / adapters / gateway / install / autostart / cliinstall / lan / schedule / sync / cloud / i18n / update suites, incl. Web endpoints, the phone console and the cloud control plane; 6 more skipped per platform); the agent-workflow suite (.agents/ orchestrator and guard hooks) runs separately via `npm run test:workflow` (140 tests); CLI binary smoke-tested; cross-platform tests pass on Windows / Linux / macOS. Real-harness attach integration is left for you to run on your own machine — for first use, keep the diff confirmation, and run `modeldock test` / `modeldock doctor` first.

Planned (M2/M3): L3 external plugins, remote preset-library updates, management-plane "strict mode" (token required even for read endpoints), anthropic↔openai protocol conversion; usage statistics evaluated and dropped; cloud-sync M4 refinements (recovery codes / device revocation / optional passphrase-cache switch) and real-VPS acceptance of the cloud control plane proceed per the detailed design (Phase 2).
