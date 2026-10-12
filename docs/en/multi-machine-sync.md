# Multi-machine config sync: how it works + onboarding a new computer

**English** ｜ [简体中文](../multi-machine-sync.md)
<!-- i18n-slot: append new-language links on the line above; convention: .agents/conventions/docs-writing.md -->

> Applies to the **local sync folder (localdir)** target of `modeldock sync setup` (Google Drive / iCloud / OneDrive / Nutstore sync folders…), with WebDAV differences at the end.
> This is a follow-along operational manual, not a design doc; for design trade-offs see [design-cloud-sync.md](../design-cloud-sync.md) (Chinese).

## 0. Build the mental model first (skip this and you will trip)

**ModelDock does not talk to drive APIs.** It only reads and writes files in an ordinary local directory (`src/sync/targets/localdir.ts` is 41 lines in total, pure `fs`). Upload/download is entirely the drive client's job.

So one sync is **two independent links** chained together — missing either one breaks the whole:

```
This machine's ModelDock  ──writes files──▶  Local folder (drive client watching)  ──drive client uploads──▶  Cloud
                                                                                             │
New computer's ModelDock ◀──reads files──   Local folder (drive client watching)  ◀──drive client downloads──┘
        ▲
        └── but this link only exists after you manually run sync setup ONCE on the new computer
```

**The most common misunderstanding**: "I set up Google Drive sync on machine A; machine B signs into the same account and sees that folder, so it should sync automatically."
**It won't.** The sync credentials live in `~/.modeldock/sync.json` on this machine, and that file **is deliberately excluded from sync** (credentials must not be carried back inside the package they protect). Machine B's ModelDock sits in `mode: off` — **it never even looks at that folder**.

---

## 1. The source machine's current setup (verbatim record)

### 1.1 Snapshot

| Item | Value | Where to check |
|---|---|---|
| Sync mode | `target` (drive-folder mode, not cloud-hub mode) | `modeldock sync status` |
| Target type | `localdir` | same, "Target: localdir · …" |
| Sync folder | `~/Library/CloudStorage/GoogleDrive-<your Google account>/My Drive/modeldock` | same, or `target.dir` in `~/.modeldock/sync.json` |
| This device's ID | `mdksync_7b34def3…` (`devid` in `sync.json`) | `modeldock sync status` |
| Current revision | rev 32 (+1 per push; blobs append-only) | same, "synced to revision N" |
| Passphrase cache | `sync.json`'s `key.{salt,hkdfSalt,encKey,macKey,verifier}` | don't hand-edit; re-derived from the passphrase on a new machine |
| Engine mount point | **inside the gateway process** (`remountSyncEngine`, `src/gateway/main.ts`) | auto-sync only exists while the gateway runs |
| Sync cadence | drive target: 120s ± 30%; local changes push after a 3s debounce | code constants, not configurable |

> Account details are masked per PII practice; for your machine's exact values trust the `modeldock sync status` output (the path contains your own email — don't copy this document verbatim).

### 1.2 What the sync folder looks like

```
<your chosen folder>/                        ← the dir you entered in sync setup
└── modeldock-sync/                          ← fixed subdirectory name (SYNC_DIRNAME)
    ├── manifest.json                        ← { rev, ts, byDevid, blobRef } — "who is the latest revision"
    └── blobs/
        ├── 1-mdksync_7b34def3….msync        ← encrypted envelopes, append-only, full history kept
        ├── 2-mdksync_7b34def3….msync
        └── …  32-mdksync_7b34def3….msync
```

- Each `.msync` is an **AES-256-GCM encrypted full config package** (plaintext keys inside), keyed from the passphrase — the drive provider only ever sees ciphertext.
- `manifest.json` is the single "current revision pointer"; its monotonically increasing `rev` provides the optimistic lock.

### 1.3 How this machine was set up (reproducible as-is)

1. Install **Google Drive for desktop**, sign in, create (or pick) a folder in the drive, e.g. `My Drive/modeldock`.
2. Install **ModelDock** (DMG / setup.exe / tar.gz — see [usage.md](usage.md) §2).
3. Run `modeldock sync setup`:
   - target type: **local sync folder (iCloud / OneDrive…)**;
   - folder: the **local path** of that folder on this machine;
   - set the **sync passphrase** (typed twice interactively, no echo).
   - The target was empty at the time → this machine pushed itself as **rev 1**, printing "✓ Multi-machine sync enabled".
4. Start the gateway (menu-bar tray / `ModelDock.app` / `modeldock gateway start`) — polling and instant push only exist while it runs.
5. From then on, every config change (add service, swap key, edit route) pushes a revision within 3 seconds; other machines catch up in a minute or two (120s ± 30% polling).

**The passphrase is the single critical secret** — keep a copy somewhere safe yourself. Forget it and the already-synced ciphertext is unrecoverable (no backdoor, no recovery codes).

---

## 2. What syncs, and what doesn't

Sync = one `syncdoc`: **services (providers, plaintext keys included) + routes (profiles) + custom presets + schedules**.

**Deliberately not synced ("machine state", independent per machine)**:

- Each client's attach state and the clients' own config files (the configs of claude-code / zcode / dsh… are never touched)
- Gateway port & forwarding settings, the active route, auto-start
- Request logs & usage statistics
- **`sync.json` itself** (sync credentials + device id — exactly what must not be synced, or machines would overwrite each other's credentials)

**Key migration rules** (`src/sync/collect.ts`):

| Key storage on this machine | Migrates to the new computer? |
|---|---|
| `keychain:` / `file:` / `secret-service:` / `plain:` | **Yes** — resolved to plaintext and sealed into the encrypted package; after setup the new machine re-stores them into its own keychain |
| `env:VAR` environment-variable reference | **No** — machine state; set the same-named env var yourself on the new computer |
| Unreadable on the exporting machine | **No** — the command prompts `modeldock provider set-key <id>` to fill it in |

All 9 services on this machine store keys as `file:` / `keychain:` — the first row, fully migrated; no re-entering keys on the new computer.

---

## 3. Onboarding the new computer: complete steps

### Pre-check (**skipping this is the most common failure cause**)

In your file manager, confirm this file is visible on the new computer:

```
<sync folder>/modeldock-sync/manifest.json
```

- **If you can't see it, stop**: Google Drive isn't installed properly / isn't the same account / is still on its first sync. Fix the drive first, then continue.
- The path **will differ** from the source machine (different username; Windows shows a virtual drive letter like `G:\My Drive\modeldock`, or `%USERPROFILE%\Google Drive\...`). Use the actual path on the new computer.

### Steps

**① Install Google Drive for desktop**, sign in with **the same account**, and wait for the `modeldock-sync/` directory to appear locally.

**② Install ModelDock itself** (the program does not migrate with sync — install it separately): download the package for your platform from Releases (or build from source, see [usage.md](usage.md) §2).

**③ Run setup once, pointing at that folder, entering the same passphrase:**

```bash
modeldock sync setup --target localdir --dir "<actual path on the new computer>"
# or run without arguments for the interactive picker (recommended, harder to mistype the path)
modeldock sync setup
```

Correct output:

```
✓ Joined multi-machine sync: /Users/…/My Drive/modeldock (applied revision 32 from other machines)
```

Note the word **"Joined"** — it means setup read the remote manifest, unlocked the latest package with your passphrase, and **wrote the config into this machine on the spot**. This step **does not need the gateway running**; it's usable as soon as it finishes.

**④ Start the gateway** (tray / `ModelDock.app` / `modeldock gateway start`). From here it's automatic in both directions: local changes push within 3 seconds, remote revisions pull within a minute or two.

**⑤ Verify:**

```bash
modeldock sync status
```

Expected:

```
Multi-machine sync · running
  Target: localdir · /Users/…/My Drive/modeldock
  This device: mdksync_xxxxxxxx…
  Synced to revision 32
  Last push / pull: …
```

Then open the Web console and confirm services, routes, and keys are all in place (this machine's keys should show "set").

> WebDAV targets (Nutstore / Nextcloud / Synology) follow the exact same flow — only step ③ changes to
> `modeldock sync setup --target webdav --url https://dav.jianguoyun.com/dav/ --dir modeldock --username <email> --password <app password>`.

---

## 4. Troubleshooting table

| Symptom | Meaning | Fix |
|---|---|---|
| `sync status` says multi-machine sync not enabled | the new computer never ran setup, `mode: off` | back to §3 step ③ |
| setup prints "✓ Enabled… (this machine's config pushed as revision 1)" instead of "Joined" | **a remote manifest exists but wasn't read** → wrong path / Drive not ready; this machine silently became an isolated island (looks fine locally, nothing actually syncs) | stop and re-check the path; if a `modeldock-sync/` was already created in the wrong place, delete that directory and re-run. **Don't expect changes made while isolated to ever arrive** |
| setup reports "passphrase doesn't match this sync target" | the passphrase isn't the source machine's one | re-run and enter the correct passphrase. This doesn't pollute the target; retry freely |
| "sync history blob missing (blobs/N-….msync)" | the drive **uploaded the manifest before the blob** — an upload-order race, not corrupted config | wait 1–2 minutes for the drive to finish, re-run `modeldock sync setup` or `sync status` and see if it self-heals |
| `sync status` says "waiting for the gateway to take over" | a normal notice, not a fault: `sync.json` is ready but the gateway isn't running | just start the gateway |
| status line / console shows a recent conflict | both machines changed things; the conflict was resolved as "remote wins" and the local side **was snapshotted** to `~/.modeldock/backups/sync-conflict-<timestamp>.json` | open the snapshot file, compare the differences, and re-apply them by hand on either machine. **No auto-merge** is a design decision (D6) |
| "sync.json is not valid JSON / unsupported version" | the local state file is corrupted | repair or delete `~/.modeldock/sync.json`, re-run setup |
| "target already has a newer revision on first push" | both machines ran setup on an empty target at the same time | re-run setup; let the machine that already has data go first |

---

## 5. Red lines (doing these causes trouble)

- **Don't** copy the source machine's `~/.modeldock/sync.json` to the new computer. It holds the source's `devid` and port/state bookkeeping — two machines would share one device identity, and conflict & state logic all break. New computers always go through `sync setup`.
- **Don't** point `--dir` at an empty or mistyped directory and keep using it (row 2 of the table above — a silent island).
- **Don't** edit the same batch of configs on two machines at the same time. Conflicts don't lose data (snapshots exist), but you merge the differences by hand.
- **Don't** hand-edit `modeldock-sync/manifest.json` or delete `blobs/`. Append-only blobs are the premise of history recovery.
- Sync has **nothing to do** with the gateway port: two machines each run their own 8687 without interference.
- Forgetting the passphrase = the ciphertext is unrecoverable. The passphrase exists only in your head and in the derived caches inside each machine's `sync.json`.

---

## 6. Other ways to move a config (comparison)

Sync is the "continuous two-way" option. For a **one-time migration** or a **same-LAN quick move**, the project ships lighter paths (see [usage.md](usage.md) §5 "Multi-machine sync & cloud management"):

| Method | Command / entry | Best for |
|---|---|---|
| Encrypted config package (file) | `modeldock config export` → `config import` | one-time migration & backup; WeChat / USB transfer |
| One-time LAN link | console "Phone Remote" panel → "Share config to nearby computers…" | migration on the same Wi-Fi; valid 10 minutes, void after one fetch |
| Nearby-computer picker | new machine "Import from another computer" → "Search nearby computers…" | same subnet, no copy-paste (UDP broadcast; the old machine confirms) |
| **Drive-based continuous sync** | `modeldock sync setup` (this document) | **many machines staying in lockstep; change once, all follow** |
| Cloud hub | `modeldock sync enroll --server … --code …` | self-hosted control plane, remote service switching from the phone ([deploy-cloud.md](deploy-cloud.md)) |
