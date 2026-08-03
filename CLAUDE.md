# leo-stack

Marketplace de plugins de Claude Code: el **stack opinado**, lo que solo tiene sentido junto con el pipeline AFK. Núcleo `host-orchestrator`, más `interface-lens`, `memory-flow`, `review-flow` y `yt-transcript`. Los plugins viven en `plugins/<plugin>/`; el índice con versiones pinneadas es `.claude-plugin/marketplace.json`.

## Retiros

Nada se retira sin registrarse. `DEFUNCIONES.md` explica con qué se reemplaza cada plugin retirado y con qué repos quedó deuda; el diff entre `~/.claude/plugins/installed_plugins.json` y el índice es lo que **detecta** al huérfano. Un huérfano que aparece en el diff y no está en el archivo es un error a reportar.

Antes de borrar, marca de rescate en el historial (tag `rescate/<hito>`) — recuperar una pieza es `git show <tag>:plugins/<plugin>/<archivo>`. Y **la cache pinneada no se toca antes de migrar el repo consumidor**: sacar un plugin del índice no rompe nada, borrar `~/.claude/plugins/cache/leo-stack/<plugin>/<versión>/` sí.

## Agent skills

### Issue tracker

Issues en GitHub Issues del repo (`LeopoldoBini/leo-stack`), operadas con el CLI `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

Los cinco labels canónicos por defecto: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` en la raíz del repo. See `docs/agents/domain.md`.
