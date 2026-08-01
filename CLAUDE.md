# toolkit-leopoldo

Marketplace de plugins de Claude Code (host-orchestrator, memory-flow, shared-language, yt-transcript…). Los plugins viven en `plugins/<plugin>/`; el índice con versiones pinneadas es `.claude-plugin/marketplace.json`.

## Agent skills

### Issue tracker

Issues en GitHub Issues del repo (`LeopoldoBini/toolkit-leopoldo`), operadas con el CLI `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

Los cinco labels canónicos por defecto: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` en la raíz del repo. See `docs/agents/domain.md`.
