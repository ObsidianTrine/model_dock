# ModelDock cloud control-plane deployment runbook (M3)

**English** ｜ [简体中文](../deploy-cloud.md)
<!-- i18n-slot: append new-language links on the line above; convention: .agents/conventions/docs-writing.md -->

> Corresponds to the detailed design `docs/design-cloud-sync.md` §7.7 (Chinese). The server has zero third-party dependencies (`node:http` + `node:sqlite`, Node ≥22.5; deploy machines standardized on Node 24 LTS) — same stack and tests as the main repository.

| Doc property | Content |
|---|---|
| Cloud address | **`203.0.113.10:18443` [PLACEHOLDER IP (RFC 5737 documentation-reserved range) — after buying the VPS, search & replace with the real address throughout]** |
| Deploy machine | Alibaba Cloud ECS 2C2G ¥99/year tier (renewal same price; Tencent Lighthouse comparable), Ubuntu 24.04 LTS |
| Data directory | `/var/lib/modeldock-cloud` (systemd `StateDirectory`) |
| Ports | only TCP `18443` (example port, changeable) + SSH 22 (restricted to your IP) |
| Status | runbook ready and shipped with v1.0.0; **pending execution** (no VPS yet, confirmed 2026-10-11) — after purchase execute section by section from §1, replacing the placeholder IP throughout |

> **Shared infrastructure**: this VPS will later double as the **auto-update source** (`docs/design-auto-update.md` M3, Chinese) — reserve the update-source port / reverse proxy at deploy time; TLS certificate decisions are shared with the control plane (an open question shared by both detailed designs).

---

## 1. Purchase & initialization

1. Buy the ECS (nearest region), system image Ubuntu 24.04 LTS; the security group allows only: SSH (22, your IP only) + TCP `18443`.
2. SSH key login, passwords disabled (`PasswordAuthentication no`); run nothing else on the server.

## 2. Run

```bash
git clone <this repository> modeldock && cd modeldock
# Install Node 24 LTS (NodeSource or nvm)
npm ci && npm run build
node dist/cloud/main.js --port 18443 --host 0.0.0.0 --data /var/lib/modeldock-cloud
```

- First start generates a `consoleToken` written to `/var/lib/modeldock-cloud/cloud.json` (0600) and printed to stdout — **this is the cloud console login credential; store it in a password manager immediately**.
- Rate limiting defaults to 60 req/min per IP (detailed design §7.2); to adjust, add `--rate-limit <req/min>`.
- A domain is not required (bare IP + port, no ICP filing); switch to Let's Encrypt TLS later when adding a domain.
- The firewall opens only 18443; self-check with `curl http://127.0.0.1:18443/`.

## 3. systemd residency

`/etc/systemd/system/modeldock-cloud.service`:

```ini
[Unit]
Description=ModelDock Cloud control plane
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node /root/modeldock/dist/cloud/main.js --port 18443 --host 0.0.0.0 --data /var/lib/modeldock-cloud
Restart=always
RestartSec=3
StateDirectory=modeldock-cloud
# StateDirectory guarantees /var/lib/modeldock-cloud exists; ExecStart's --data points at the same directory explicitly
# Adjust the Node path to your environment (which node)

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now modeldock-cloud
journalctl -u modeldock-cloud -f
```

## 4. Daily backup (crontab)

```cron
30 4 * * * /usr/bin/node /root/modeldock/dist/cloud/main.js --backup --data /var/lib/modeldock-cloud >> /var/log/modeldock-cloud-backup.log 2>&1
```

`--backup` uses SQLite `VACUUM INTO` to snapshot online into `<data>/backups/`, automatically keeping the most recent 14.

**Restore**: `systemctl stop modeldock-cloud` → overwrite the data directory's `cloud.db` with one of the snapshots and delete any `cloud.db-wal` / `cloud.db-shm` leftovers in the same directory (under WAL mode, old logs must not mix with a new database) → `systemctl start modeldock-cloud`. `cloud.json` (consoleToken) is not in the database — leave it untouched and console login is unaffected; devices enrolled after the snapshot point return to the snapshot state and need to re-pair.

## 5. Upgrading

```bash
cd /root/modeldock && git pull && npm ci && npm run build && systemctl restart modeldock-cloud
```

API v1 evolves backward-compatibly; breaking changes move to `/v2`.

## 6. Security checklist

- Exactly one business port exposed; SSH key login with passwords disabled; `cloud.json` 0600; no other services on the server.
- **Residual risk of the plaintext-HTTP phase**: the token can be replayed by an on-path listener — but what they read is only ciphertext (E2E encryption as the safety net), and writes are limited by ts monotonicity + HMAC to "no forged new content". TLS is the top-priority upgrade (see §7).
- Console token brute-force protection: 60 req/min rate limit; high-entropy token; HttpOnly + SameSite=Strict cookie.

## 7. Transport encryption roadmap

- The M3 launch permits IP+HTTP (E2E encryption as the safety net).
- v1.1 upgrade: self-signed / IP SAN certificate (ZeroSSL issues IP certificates) or domain + ICP filing + Let's Encrypt. After TLS, clients just switch `sync enroll --server https://…` to the https address.

## 8. Changing the server address (replace the placeholder IP after purchase)

- **Server side**: `--port`/`--host`/`--data` are all injected by parameters at deploy time, zero hardcoding in code; replace `203.0.113.10` in this document and the systemd unit with the real IP.
- **Clients** (every computer): `modeldock sync enroll --server http://<real IP>:18443 --code XXXX-XXXX` to re-enroll (new server = new consoleToken = new pairing code, a brand-new enrollment; for the same machine changing IP / domain / protocol with the data directory migrated, editing `cloud.url` in `~/.modeldock/sync.json` directly also works).
- **Data migration**: copy the whole `/var/lib/modeldock-cloud` directory (cloud.db and cloud.json included) — the consoleToken stays unchanged and devices need no re-pairing.

## 9. Client onboarding (acceptance path)

1. Console (phone or desktop browser at `http://<IP>:18443/`) → paste the consoleToken to log in → generate a pairing code.
2. On the computer: `modeldock sync enroll --server http://<IP>:18443 --code XXXX-XXXX`, enter the sync passphrase.
3. The phone console should show the device online (180s heartbeat window); switching the service on a device takes effect on that machine within ≤1 minute (detailed design D4, minute-level semantics).
4. Unplug the cloud (temporarily block 18443 in the firewall): both computers' gateways keep working unaffected; sync resumes automatically after recovery.
