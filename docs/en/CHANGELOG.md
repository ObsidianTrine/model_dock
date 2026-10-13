# Changelog

**English** ｜ [简体中文](../../CHANGELOG.md)
<!-- i18n-slot: append new-language links on the line above; convention: .agents/conventions/docs-writing.md -->

This file records ModelDock's version history. The format follows [Keep a Changelog](https://keepachangelog.com/en-US/1.1.0/).

## [1.1.0] - 2026-10-13

"Moving house" is consolidated into one Config package entry, existing configs can be re-imported anytime, and dev-sandbox operations no longer touch the production instance.

### Added

- **One "Config package" entry for import & export**: the former "Export package" button on the status row becomes "Config package", opening one dialog with export and import directions. Export offers three ways — Nearby computers (shows LAN reachability, with a one-click enable of the mobile console so the other computer can pull directly), Export a link (10-minute one-time), and Export package file; import is no longer "gone after first use", and a list of what will be imported is shown for confirmation before anything is replaced. The share-link entry also moves out of the mobile-console panel into the open.
- **Re-import existing configs anytime**: after clicking "Not now" on the legacy-config banner, the import entry used to disappear from the UI entirely; the add-service dialog now has "Import existing configs from local apps…" with checkboxes for the services to bring in.
- **Paste share links on mobile too**: the mobile console's package import accepts a pasted share link in addition to picking a file (the link carries its own passphrase, used automatically).
- **One-click import now covers far more apps**: legacy-config import grows from 4 sources to 11 — newly supported are Codex CLI, OpenCode, MiMo Code (shared with the MiMo desktop app), WorkBuddy, claude-code-router, Crush, and Gemini CLI relays; Codex / Gemini profiles in newer cc-switch versions are no longer missed. The first-run wizard and the web banner pick them up automatically.
- **Import channels from one-api / new-api**: `modeldock import --from oneapi --url <site> --token <system access token>` bulk-moves channels from your self-hosted relay site into ModelDock (generate the token under "Personal settings → System access token" on the site); only OpenAI-compatible / Anthropic channels are imported — ones ModelDock cannot reach directly (Azure, native Gemini, etc.) are skipped with the reason shown.

### Fixed

- **Menu bar icon rendering fixed (macOS)**: the tray icon's "M" mark previously showed white blotches/holes; it now uses a round-stroke mark from the same source as the app icon, staying clean on any menu bar background.
- **CLI commands respond faster**: CLI commands no longer load unused networking and interactive components at startup, so everyday commands produce results sooner.
- **The dev sandbox no longer affects production**: resetting/cleaning data, uninstalling, or installing start-at-login inside the dev sandbox (`scripts/run_dev`) could previously reach the production instance — deleting production's OS-keychain keys (showing up as sudden 401s), killing the production gateway process, or removing the `modeldock` command-line entry. Sandbox keys are now stored entirely inside the sandbox directory and never touch the OS keychain; start-at-login registers under a separate label; machine-wide process sweeps and command-line entry operations in the sandbox only ever affect the sandbox itself.
- **The tray's "Cleanup finished" dialog keeps its buttons reachable (macOS)**: after cleaning data, the dialog shows only the conclusion lines with buttons always on screen; the full process output is saved to "~/Library/Logs/ModelDock" (a timestamped log file) — click "View full log" in the dialog to open it. Previously the entire execution output was stuffed into the dialog, pushing the buttons off-screen.
- **Failed cleanups show the error directly**: the result dialog now distinguishes success from failure; on failure it shows the error from the end of the output and the same "View full log" entry — previously failures were also titled "Cleanup finished", with errors buried in long output.
- **Key changes take effect immediately**: after swapping a service key from the CLI (or on another instance), the running gateway previously kept using the stale key until restart — showing up as sudden 401s; config hot-reload now refreshes keys along with the rest.
- **Long-context requests forward faster**: for services with a default model, every request body was fully parsed to decide whether to rewrite the model name — large bodies (long conversations can reach several MB) slowed other concurrent streams on the same instance; requests whose model name needs no rewrite now pass straight through.
- **Concurrent config writes from multiple ModelDock processes no longer overwrite each other**: the config write lock now verifies ownership and secret-file writes gained a cross-process lock; a corrupted config or secrets file yields an actionable "how to fix" message instead of an internal error.
- **A broken custom presets file no longer crashes startup**: a malformed `presets.json` now produces an error naming the problem; a mis-classification of some clients' "supports image input" capability is fixed.
- **Detaching dsh no longer removes your own config entries**: an index miscalculation on detach could previously delete adjacent user entries or leave stale config; also fixed the importer dropping all results when a single dsh patch file is corrupt.
- **One-command updates are more robust**: an update subprocess exiting abnormally no longer wedges the "updating" state or takes the gateway down; on Windows, running from a PATH copy no longer attempts a silent self-copy (previously failing silently on every double-click).
- **Sync watcher errors no longer take the gateway down**: an async error from file watching used to become an uncaught exception killing the gateway process; it is now recorded in the sync state and self-heals next cycle.
- **CLI and web console "add service" behave identically**: the two paths were separate implementations with subtle drift (service ID derivation, gateway port resolution); they are now one implementation.
- **Windows polish**: path display correctly abbreviates to `~`; `config edit` opens even when the editor path contains special characters; dsh-related copy follows the UI language.
- **"One-command update" fixed for Windows installer users**: `modeldock update` previously misidentified an installer-based install as a bare binary and replaced the main program with a raw zip download — leaving the uninstaller registration stale and the tray app un-updated; the install shape is now detected correctly and updates go through the installer's silent mode.
- **No more leftover upstream keys in client config after switching direct → gateway**: with an x-api-key style upstream (e.g. official Anthropic), the real upstream key written into settings.json in direct mode previously stayed there after switching back to gateway mode; it is now removed on switch, returning key custody to the gateway.
- **Model switching follows again after re-attaching a direct client**: running attach again on a client currently in direct mode (doctor also suggests this) previously left direct model mappings that overrode the gateway's model rewriting — "I switched services but the model didn't change"; re-attaching now cleans up direct leftovers automatically.
- **All-day schedule windows no longer lose the last minute**: an all-day window written as 00:00–23:59 was previously judged inactive during 23:59:00–23:59:59 each day, falling requests back to the default service; that minute is now included, treating 23:59 as "end of day".
- **dsh no longer rewritten when nothing changed**: scheduled switches / periodic re-calibration previously rewrote dsh config and produced meaningless snapshots every time, eating into the rolling snapshot budget; unchanged content is now skipped.
- **Weak sync passphrases get a warning**: a passphrase shorter than 8 characters or all digits now shows a non-blocking hint suggesting a mix of letters, digits and symbols.
- **Detach & cleanup no longer dump long config-diff records**: when restoring clients, ModelDock's internal leftover-config cleanup now prints only the result line — that diff preview belongs to the confirmation step and is no longer echoed in non-interactive runs and dialogs; confirmation-needed flows such as attach still display it as usual.
- **The update-check dialog body is capped**: overlong release notes are truncated automatically instead of stretching the dialog off-screen.

## [1.0.0] - 2026-10-11

ModelDock's first public release: bring every AI client's upstream configuration into a local gateway for unified hosting — switching services, automatic failover, and key custody all happen in one place, with zero changes to client configs.

### Changed

- **Updates no longer require a configured token**: `modeldock update` can now check for and install new versions anonymously (the repository is public); previously it refused to update without a GitHub token. The token is now optional — only needed when the update source points to a private repository; configuring it raises the query rate limit from 60/hour to 5,000/hour.
- **Update downloads go through mirror acceleration**: downloads try gh-proxy → ghfast → GitHub official in order, making them faster and more reliable on Chinese networks; the SHA256 verification list always comes from GitHub official — mirrors only accelerate, never participate in integrity verification. Customize via `[update] mirror` in config.toml, or set it empty to disable.
- **More providers ship with built-in model catalogs**: presets for Alibaba Cloud Bailian (Qwen3.8 series), SiliconFlow (popular hosted models), and Xiaomi MiMo (v2.6 series) now include default model lists — pick models right after adding a service, no need to click "Fetch models" first; Zhipu z.ai adds GLM-5.3-FlashX.
- **Node version requirements surface immediately**: when installing an AI client whose dependencies require a newer Node than yours (npm EBADENGINE warning), the install result names the required version and offers two paths — upgrade the system Node and "Re-detect", or set `MODELRDOCK_NODE_VERSION` to a higher version and reinstall; previously this warning was buried in the install log and only surfaced when the installed client wouldn't run.
- **The add-service dialog now matches the edit page width**: both shells use the same dialog width variant (680px), so the fetch panel's search box spans the full row on the add page too and "Existing" badges are no longer clipped at the right edge; previously the add dialog was 60px narrower with a half-width search box. Styles are now defined in one place — future width tweaks touch one spot.
- **The /model picker lists only your gateway models**: after attaching Claude Code in gateway mode, the picker lists exactly the models you fetched and filtered for the current service (display name + source service); built-in tiers like Opus / Sonnet no longer appear, with a fixed "Default" entry kept at all times; switching services rewrites the list automatically — reopen a session to see the new one. Detaching restores the config; your own allowlists / curated tables are unaffected.
- **The direct-mode model picker works out of the box**: attaching Claude Code in direct mode makes the /model picker list all of that service's models (1M-context models labeled), writing only the necessary config; switching direct services rewrites the model config to the new service's models, leaving no stale model names behind.
- **The gateway implements /v1/models locally**: it returns the current service's model catalog (display name + model ID) instead of proxying the request upstream — the upstream catalog isn't the one you filtered, and the upstream may not implement the endpoint at all; any client with model discovery enabled gets its list from here, following pinned routes and manual switches.

- **Installed clients can be uninstalled in one click**: npm-based clients (Claude Code / Codex / dsh / OpenCode) get an "Uninstall" button on their "Installed, not attached" cards, completing the lifecycle symmetrically with "Install & attach" — sandbox instances uninstall only the sandbox copy, real-machine instances explicitly uninstall from the global environment; attached clients must detach first, and the empty config written during install is cleaned up together with the uninstall.
- **Claude Code works out of the box in gateway mode**: client configs no longer need any model environment variables pre-written — built-in model names emitted by Claude Code (claude-sonnet-*, etc.) are rewritten by the gateway to the current service's default model; previously such names passed through untouched and requests failed outright.
- **Switch services, models follow instantly**: whichever service a manual switch / scheduled switch / failover lands on, Claude Code's requests automatically use that service's models — zero client-config changes, no restart needed, and running sessions pick up the new service immediately — the model change happens gateway-side, not client-side.

- **Service IDs are easier to recognize**: adding a service derives the ID from the vendor's short name (e.g. deepseek, deepseek-2), so names with protocol suffixes like deepseek-anthropic-4 no longer appear; already-added services keep their names, unaffected.
- **Adding a service no longer fetches models on its own**: providers with complete built-in catalogs (like DeepSeek) no longer fetch models in the background when added, and the success message no longer tacks on "model list not fetched"; click "Fetch models" whenever you want.
- **Clients installed in the dev sandbox no longer touch the real machine**: clicking "Install & attach" in the dev-sandbox console for npm-based clients (Claude Code / Codex / dsh / OpenCode) really downloads and installs, but entirely inside the sandbox — the real machine's global environment and installed clients are untouched; to start over, just delete the sandbox directory.
- **Clients the sandbox can't install say so**: clients whose install method is a third-party script (like the MiMoCode official installer) are no longer executed inside the sandbox — they are clearly reported as unsupported with manual-install guidance, so a test install can't quietly write to the real machine.
- **Toasts no longer cover the "Add model service" button**: success / error toasts moved to the bottom-left of the page, so the bottom-right ＋ and pagination buttons stay clickable; the phone compact console mirrors this.
- **The "dev sandbox" badge is unmistakable**: the header's dev-sandbox marker now uses an amber warning style (outline + light fill) instead of drowning in status text; it works in both themes and both UI languages.

### Fixed

- **Kimi model parameters filled in**: adding a Kimi / Moonshot service now ships complete parameters for K2.7-Code, K2.7-Code Highspeed, and K2.6 (max output 32K, etc.), with the same "supports image input" badge as K3 — previously these had blank parameters and vision had to be checked manually; existing services can click "Fetch models" to update.
- **Uninstalling in the sandbox resets the card state**: after uninstalling npm-based clients (Claude Code / Codex) in the dev sandbox, the card correctly returns to "Not installed" and can be reinstalled — previously the same command on the host machine made the sandbox believe it was still "Installed", so uninstalling looked like it never happened.
- **In-dialog errors are no longer blurred by the overlay**: the fetch-models validation and failure messages in the add / edit dialogs, and every failure message of the update dialog, now appear in the dialog's bottom-left corner; the "Copied" feedback for copying a link in the share dialog now flips on the button and the address entry instead — previously these messages ran to the page's bottom-left and got smeared by the dialog's frosted overlay.
- **The status pills follow the language switch**: the row of status pills ("Auto routing / failover-to-fallback / automatic fallback chain / auto-start / phone remote") previously stayed Chinese no matter what; they now switch immediately when you change the language, in both directions.

- **Manually typed model names no longer get lost**: model names typed into the "New model ID" box while adding a service now take effect on save even without clicking the inline "Add" button; previously they were silently dropped and even triggered one unnecessary auto-fetch.

- **DeepSeek is just called DeepSeek**: picking DeepSeek when adding a service no longer appends "(Anthropic compatible)" — the preset ships all three protocol endpoints, so the name needn't be pinned to one protocol.
- **Three endpoint fields, each its own**: add / edit service protocol endpoints are now three stacked rows — Anthropic API, OpenAI API (/v1), Responses API (/responses) — fill whichever the vendor supports; custom services no longer need to pick a "default endpoint" protocol first.
- **Model parameters can follow upstream updates**: after fetching models in the edit dialog, entries whose parameters differ from the fetched list are marked "Updatable" — click "Apply selected" to sync context / max output / vision from the fetched data, no more delete-and-recreate or manual typing.
- **You choose what gets updated**: entries with matching parameters are skipped automatically; unchecked rows stay as they are, and parameters the upstream didn't return are never cleared.
- **Result messages stay readable**: apply results now show in the edit dialog's bottom-left corner instead of behind its frosted overlay.
- **In-dialog errors are no longer invisible**: fetch-models failures, saved-key read failures, and similar now display in the dialog's bottom-left corner; the duplicated title in the add-service dialog is gone too.
- **Overlong model IDs no longer wreck the table**: model lists and fetch results in the edit service dialog ellipsize overlong IDs per column (hover for the full text), and numeric columns stay aligned; if the dialog is too narrow, it pans horizontally inside.
- **"Existing" rows in fetched lists render correctly**: fetched entries matching the list below previously rendered as a broken row with number boxes pushed outside (the hint text was missing a quote and swallowed an inline badge); they now render on a single line with the full hint on hover, correct in both UI languages.
- **Table headers re-stick on scroll**: in the edit / add service model tables, fetch results, and the failover table, headers stick to the top of the dialog while scrolling and hand off after each table's last row — each table sticks its own header; a previous UI fix had accidentally broken this.
- **Fallback services default to passing the model name through**: picking a new fallback in the failover order now defaults "Model used" to "pass through the original model name" instead of jumping to that service's default model; pick a rewrite manually when you want one.
- **Request-log headers stay visible while scrolling**: logs longer than one screen scroll inside the card with headers (time / client / service…) pinned at the top; short lists keep the scrollbar-free look.
- **The Windows installer speaks the system language**: the setup wizard and uninstall prompts follow the system language — Simplified Chinese on Chinese Windows (bundled official Chinese language pack), English fallback on other languages.
- **The edit dialog no longer pre-fills the wrong plan's endpoint**: when one vendor has multiple plans (e.g. Volcano's Coding Plan vs Agent Plan), the edit dialog matches the preset by service endpoint instead of filling in another plan's URL.
- **Detaching a direct connection succeeds on the first try**: fixed an error when detaching direct mode and restoring the original config.
- **The "Add model service" button's tooltip is fully visible**: the tooltip on the bottom-right ＋ is no longer covered by the pagination button next to it.
- **The Windows dev restart script starts normally**: fixed `scripts/run_dev.bat` failing to start with a spurious `"was unexpected at this time"` batch parsing error.

### Gateway & routing

- **Local API gateway**: every AI harness points its base_url at `http://127.0.0.1:8687` once — from then on, switching providers and adjusting model mappings happen on the ModelDock side, instantly, with zero client-config changes and no real upstream keys in client config files.
- **Multi-protocol forwarding**: the upstream protocol is recognized per service (Anthropic / OpenAI-compatible, etc.); SSE streaming passthrough, token usage accounting (accurate across multi-byte characters split over chunk boundaries), upstream connection reuse, and HTTP proxy support (including authenticated proxies).
- **Automatic failover**: when the primary service is unreachable, rate-limited (429), or out of quota (402), traffic switches to a backup automatically — manually configured fallback chains take priority; without one, candidates are auto-generated from schedules, priority, and measured latency (automatic fallback chain); exhausted / failing services are briefly circuit-broken instead of being hammered repeatedly.
- **Scheduled switching**: services change automatically by time of day, with separate behavior for weekdays / weekends / statutory holidays (built-in Chinese holiday calendar, make-up workdays counted as weekdays, windows crossing midnight counted from the start day); the console and the phone show the same "current / next window" view.
- **Client pinning & direct mode**: a single harness can pin its own service or model; or a client can go "direct", reaching the upstream without the gateway.

### Harness onboarding

- **Built-in adapters**: Claude Code, ZCode, dsh, Codex, OpenCode, MiMo Code, MiMo Desktop, WorkBuddy, generic env — `modeldock attach <harness>` shows the diff first and writes after confirmation; `detach` / `restore` revert to the pre-attach config in one step.
- **Zero writes before attach**: existing client configs are read-only until you attach; every write is auto-snapshotted for rollback anytime.
- **Declarative adapter packs**: the `[adapter_packs.*]` section of `config.toml` onboards new clients with zero code.
- **One-click client install**: works even without Node.js on the machine — a managed Node runtime is downloaded and added to PATH (regional mirror or official source); dsh and MiMoCode get guided auto-install.

### Keys & security

- **Centralized key custody**: upstream keys go into the platform's secure backend (macOS Keychain / Windows DPAPI / Linux Secret Service), with a machine-bound-encryption fallback when no keyring exists; existing plaintext migrates automatically; management surfaces never return key plaintext.
- **Console access security**: admin operations require login; tokens can be rotated anytime (`modeldock gateway rotate-token`); login survives restarts, with device memory support.
- **Local-only boundary**: the gateway listens on `127.0.0.1` only — never open to the LAN / remote; request logs record metadata only, never prompts.
- **Safe writes**: config writes are atomic (temp file + rename, 0600) with automatic snapshots beforehand.

### Config migration & multi-machine sync

- **Encrypted config package**: `modeldock config export / import` — a passphrase-encrypted full-package migration of services, routes, custom presets, and schedules, keys included; filenames carry a timestamp; consistent across the browser / phone / CLI entry points.
- **LAN direct transfer**: one-time share links (passphrase hidden in a link fragment, valid for 10 minutes, void after one fetch) and "nearby computers" discovery for point-and-click import.
- **Multi-machine auto-sync**: `modeldock sync setup` connects a WebDAV drive or a local sync folder (Google Drive / iCloud / OneDrive / Nutstore…); local changes push within 3 seconds and the remote catches up within minutes; conflicts auto-snapshot so nothing is lost.
- **Cloud hub (optional)**: self-host a VPS control plane that aggregates each machine's service catalog; manage all devices from a single phone page and switch services remotely.
- **Existing-config migration**: auto-discovers and imports existing cc-switch / Claude Code / dsh / ZCode configs (keys come along).

### Operations & upgrades

- **Auto-start on boot**: `modeldock gateway install` registers a resident service (macOS LaunchAgent / Linux systemd / Windows startup folder) — launches on login, restarts on crash.
- **One-command upgrade**: `modeldock update` does download → SHA256 verification → replace → gateway auto-restart in one command (`--check` to look without installing); menu bar / tray / Web console surface new versions with update summaries.
- **Tray resident**: a macOS menu bar / Windows tray entry — open the console, toggle auto-start, view logs, clean up data in one click (equivalent to `modeldock reset --deep`).
- **Diagnostics & import commands**: `modeldock status` overview, `test` end-to-end connectivity self-test, `doctor` per-harness checkup with fix suggestions, `logs -f` live logs, `import` existing-config import.

### Web console

- **Desktop console** (`modeldock ui` or the gateway homepage): overview dashboard, one-click route switching, schedule editor, new profiles, key replacement, provider preset library (built-in presets + `~/.modeldock/presets.json` custom extension), endpoints auto-prefilled by protocol (Anthropic / OpenAI / Responses), online upstream model catalog fetching with limit auto-fill (built-in library of 220+ providers and 8,000+ models, refreshed every 7 days), live logs, auto-routing panel, dark / light theme switching.
- **Phone compact console**: open by scanning a QR code on the same LAN (add to the home screen as an app) — view status, switch services, adjust auto-routing, and export / import config packages as a cross-network courier.

### Internationalization

- CLI output, errors, help, and gateway messages are fully bilingual: Chinese by default, with `--lang en` / the `MODELRDOCK_LANG` environment variable / `config.toml language` for persistence; the Web console top bar switches anytime.

---
[Unreleased]: https://github.com/ObsidianTrine/model_dock/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/ObsidianTrine/model_dock/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/ObsidianTrine/model_dock/releases/tag/v1.0.0
