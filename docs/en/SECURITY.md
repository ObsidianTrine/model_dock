# Security Policy

**English** ｜ [简体中文](../../SECURITY.md)
<!-- i18n-slot: append new-language links on the line above; convention: .agents/conventions/docs-writing.md -->

Thank you for helping make ModelDock safer. **Please do not report security vulnerabilities in public issues.**

## Supported versions

Only the **latest release** receives security fixes; please upgrade before reporting on older versions.

## How to report

**Preferred channel: [GitHub Security Advisories (private report)](https://github.com/ObsidianTrine/model_dock/security/advisories/new)** — no public issues, no exposed details.

When reporting, please include:

- A description of the vulnerability and its impact (what can be obtained, what can be done)
- Reproduction steps or a PoC (**redact carefully — never include real API keys**)
- Affected versions / operating systems / install methods

## Response & disclosure

- Acknowledged and assessment started within **48 hours**
- After the fix, we coordinate disclosure timing with you (public by default within **90 days**)
- Public disclosure credits you in the release notes (if you wish to be named)

## Scope

**In scope**:

- Storage & leakage of upstream API keys (platform secure backend, secrets file, logs, API responses)
- Gateway authentication & management plane (admin token, cookies, same-origin checks, audit logs)
- Injection, privilege, or credential-leak issues in client config write / restore (attach, detach, snapshot restore)

**Out of scope**:

- Problems in the upstream providers themselves
- Attacks requiring prior local-user privileges (the gateway listens on `127.0.0.1` only — no remote exposure surface)
- Generic vulnerabilities in dependencies (please report those upstream; still tell us if they actually affect ModelDock)

Security design and the full threat model: [docs/design.md](../design.md) (Chinese).
