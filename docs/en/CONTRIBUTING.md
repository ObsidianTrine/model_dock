# Contributing

**English** ｜ [简体中文](../../CONTRIBUTING.md)
<!-- i18n-slot: append new-language links on the line above; convention: .agents/conventions/docs-writing.md -->

Thanks for your interest in contributing to ModelDock! Before opening a PR, please read [AGENTS.md](../../AGENTS.md) (engineering conventions and hard constraints, maintained in Chinese — required reading for AI agents too).

## Development environment

- Node.js >= 22, npm

```bash
git clone https://github.com/ObsidianTrine/model_dock.git
cd model_dock
npm install
```

## Common commands

| Task | Command |
|------|------|
| Run tests | `npm test` (must pass after any change under `src/**`) |
| Build | `npm run build` |
| Run from source | `npm run dev -- <cmd>` |
| Local gateway | `scripts/run_dev.bat` (Win) / `scripts/run_dev.sh` (mac/Linux) |

## AI autonomous pipeline

Tasks with clear goals and machine-checkable acceptance criteria can be handed to the local autonomous pipeline (task cards in, merged code out): give a one-line intent or write a task card → code, tests and independent review run automatically → you approve the merge. For the quick start and full usage (spec trio, nightly inspection, scheduled runs, release proposals), see [docs/ai-pipeline-guide.md](../ai-pipeline-guide.md) (Chinese).

## Submitting PRs

1. Branch from `develop`; for multi-agent parallel development use `node .agents/scripts/feature-branch.mjs start <task-id>` (see AGENTS.md, "Multi-agent parallel development")
2. Run `npm test` after your changes — all green before submitting
3. **Docs sync**: changed user-visible behavior? Update CHANGELOG / README per [.agents/conventions/docs-writing.md](../../.agents/conventions/docs-writing.md) (user perspective, one topic per item)
4. Commit messages explain "what changed & why" (Chinese is fine; `feat:` / `fix:` / `docs:` prefixes appreciated)
5. Open the PR describing the motivation and test coverage

## Reporting issues

- Bugs / feature requests: use the [issue templates](https://github.com/ObsidianTrine/model_dock/issues/new/choose)
- **Security vulnerabilities: do not open a public issue** — see [SECURITY.md](SECURITY.md)

## Releases

The release process lives in [docs/RELEASE_CHECKLIST.md](../RELEASE_CHECKLIST.md) (maintainer-facing, Chinese).
