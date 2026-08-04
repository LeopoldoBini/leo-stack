# leo-stack

Marketplace de plugins de Claude Code: el **stack opinado**, lo que solo tiene sentido junto con el pipeline AFK. Hoy es `host-orchestrator` y nada más. Lo que resuelve un problema por su cuenta vive en [`leo-tools`](https://github.com/LeopoldoBini/leo-tools), no acá — ese es el eje que decide el hogar. Los plugins viven en `plugins/<plugin>/`; el índice con versiones pinneadas es `.claude-plugin/marketplace.json`.

## Retiros y mudanzas

Nada se va sin registrarse. `DEFUNCIONES.md` explica con qué se reemplaza cada plugin retirado —o a qué marketplace se mudó— y con qué repos quedó deuda; el diff entre `~/.claude/plugins/installed_plugins.json` y el índice es lo que **detecta** al huérfano. Ese diff no distingue muerte de mudanza, así que ambas se anotan igual. Un huérfano que aparece en el diff y no está en el archivo es un error a reportar.

Antes de borrar, marca de rescate en el historial (tag `rescate/<hito>`) — recuperar una pieza es `git show <tag>:plugins/<plugin>/<archivo>`. Y **la cache pinneada no se toca antes de migrar el repo consumidor**: sacar un plugin del índice no rompe nada, borrar `~/.claude/plugins/cache/leo-stack/<plugin>/<versión>/` sí.

## Estándar de calidad

Un estándar único de autor para los tres marketplaces y los tres formatos (skills, comandos, agentes). Ocho reglas: seis duras, que verifica `scripts/check-estandar.sh`, y dos de juicio, que se ejercen al escribir.

**Las duras** — `bash scripts/check-estandar.sh` las reporta por archivo, y `scripts/test-check-estandar.sh` verifica que el gate siga detectando. Corren también en la Action de cada push, como red. El gate es el paso 0 del ritual de bump (`~/.claude/docs/plugin-version-bump.md`): toda modificación de un plugin ya pasa por ahí, y ese es el único chokepoint que se respeta de verdad.

1. Description ≤ 40 palabras: triggers y no manual, con la leading word al frente.
2. `disable-model-invocation: true` por defecto en skills y comandos; ser model-invocable exige una línea `model-invocable: <razón>` en el propio archivo.
3. Cero sediment: ninguna referencia a comando o path inexistente. Las menciones legítimas de lo que murió van en un acta (`docs/**`, `CHANGELOG.md`, `DEFUNCIONES.md`) o marcadas con `<!-- acta -->`.
4. Techo de cuerpo: 140 líneas en skills, comandos y README; lo que excede baja por la escalera a `docs/`. Los agentes están exentos —un agente es un system prompt completo, no una entrada de progressive disclosure— y `docs/` es el destino de la escalera, así que tampoco.
5. Single source of truth: nada duplicado entre dos archivos, y la entrada del índice copia exacta de `plugin.json` (versión y description).
8. Allowlist explícita de `tools` en todo **agente**. No aplica a skills ni comandos: la regla nace de la ley de costo por turno de un subagente, y una pieza de sesión principal no ahorra un token declarándola.

Las excepciones conscientes se declaran en `scripts/estandar-allowlist.txt` — comandos de upstream que referenciamos, comandos que retiramos, paths que viven en el repo consumidor. Mantener esa lista al día **es** parte del chequeo: cuando upstream renombra un comando, esa línea es el único lugar donde el redirect roto queda registrado.

**Las de juicio** — checklist de revisión al escribir o modificar una pieza; no se automatizan:

6. **Completion criterion por step**: cada paso cierra en algo checkable, no en "listo".
7. **Prompt the positive**: la prohibición solo como guardrail, y siempre apareada con qué hacer en su lugar. Un párrafo entero negando algo suele ser una regla dura sin usar — el gate de invocación en prosa es la regla 2 pidiendo el flag.

## Agent skills

### Issue tracker

Issues en GitHub Issues del repo (`LeopoldoBini/leo-stack`), operadas con el CLI `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

Los cinco labels canónicos por defecto: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` en la raíz del repo. See `docs/agents/domain.md`.
