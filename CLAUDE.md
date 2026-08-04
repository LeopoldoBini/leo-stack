# leo-stack

Marketplace de plugins de Claude Code: el **stack opinado**, lo que solo tiene sentido junto con el pipeline AFK. Hoy es `host-orchestrator` y nada más; el plugin-pegamento nace acá. Lo que resuelve un problema por su cuenta vive en [`leo-tools`](https://github.com/LeopoldoBini/leo-tools), no acá — ese es el eje que decide el hogar. Los plugins viven en `plugins/<plugin>/`; el índice con versiones pinneadas es `.claude-plugin/marketplace.json`.

## Retiros y mudanzas

Nada se va sin registrarse. `DEFUNCIONES.md` explica con qué se reemplaza cada plugin retirado —o a qué marketplace se mudó— y con qué repos quedó deuda; el diff entre `~/.claude/plugins/installed_plugins.json` y el índice es lo que **detecta** al huérfano. Ese diff no distingue muerte de mudanza, así que ambas se anotan igual. Un huérfano que aparece en el diff y no está en el archivo es un error a reportar.

Antes de borrar, marca de rescate en el historial (tag `rescate/<hito>`) — recuperar una pieza es `git show <tag>:plugins/<plugin>/<archivo>`. Y **la cache pinneada no se toca antes de migrar el repo consumidor**: sacar un plugin del índice no rompe nada, borrar `~/.claude/plugins/cache/leo-stack/<plugin>/<versión>/` sí.

## Agent skills

### Issue tracker

Issues en GitHub Issues del repo (`LeopoldoBini/leo-stack`), operadas con el CLI `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

Los cinco labels canónicos por defecto: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` en la raíz del repo. See `docs/agents/domain.md`.
