# Defunciones

Registro de lo que se retiró de `leo-stack` y con qué se reemplaza.

**Roles separados.** El *quién* es computado: lo que figura en `~/.claude/plugins/installed_plugins.json` y ya no está en `.claude-plugin/marketplace.json` **es** un huérfano — autoridad siempre veraz, cero mantenimiento. El *con qué* es este archivo: el mapeo al reemplazo, que ningún cómputo puede inferir. Un huérfano que aparece en el diff y no está acá **es un error a reportar**, no un caso a resolver improvisando.

**El censo se toma al matar.** Cada entrada nace con la lista de repos que tenían el plugin instalado ese día, como pendientes tachables. El barrido que los visita es el migrador; hasta entonces la cache pinneada los sostiene corriendo su copia local.

> ⚠️ **La cache no se toca antes de migrar el repo.** Borrar `~/.claude/plugins/cache/leo-stack/<plugin>/<versión>/` es lo único que rompe de verdad: sacar el plugin del índice, no.

**Marca de rescate:** `rescate/pre-reconstruccion` — último punto del historial donde los seis plugins retirados en la reconstrucción viven enteros. Recuperar una pieza es `git show rescate/pre-reconstruccion:plugins/<plugin>/<archivo>`, no arqueología.

---

## 2026-08-03 — Reconstrucción como overlay fino sobre `mattpocock-skills`

Decidido en [Veredicto por plugin](https://github.com/LeopoldoBini/leo-stack/issues/6), con la mecánica de [Mecánica de deprecación sin ruptura](https://github.com/LeopoldoBini/leo-stack/issues/7). Ejecutado en [Retirar los 6 plugins que mueren y partir review-flow](https://github.com/LeopoldoBini/leo-stack/issues/19).

### `engineering-workflow` 2.9.0 → `mattpocock-skills` + plugin-pegamento

Fork de la suite de Matt que quedó superado: la auditoría [fork vs upstream](https://github.com/LeopoldoBini/leo-stack/issues/3) midió 8 de 16 piezas ya cubiertas por upstream 1.2.0, con la suite reestructurada entera (sync selectivo inviable).

Redirects pieza por pieza:

| Pieza | Reemplazo |
|---|---|
| `/to-prd` | `mattpocock-skills:to-spec` |
| `/to-issues` | `mattpocock-skills:to-tickets` |
| `/triage` | `mattpocock-skills:triage` |
| `/tdd-vertical` | `mattpocock-skills:tdd` |
| `/diagnose` | `mattpocock-skills:diagnosing-bugs` |
| `/deep-modules` | `mattpocock-skills:codebase-design` |
| `/prototype` | `mattpocock-skills:prototype` |
| `/grill-with-docs` | `mattpocock-skills:grilling` + `mattpocock-skills:domain-modeling` |
| `/context-bootstrap` | plugin-pegamento (nace en [#23](https://github.com/LeopoldoBini/leo-stack/issues/23)) |
| `/init-workflow` | plugin-pegamento (nace en [#23](https://github.com/LeopoldoBini/leo-stack/issues/23)) |
| `/agent-brief` | **sin reemplazo** — el `## Agent Brief` era duplicación del spec padre y sale del pipeline por [Sinergia pipeline](https://github.com/LeopoldoBini/leo-stack/issues/10) §1; el body del ticket es el contrato |
| `/zoom-out` | **sin reemplazo** — upstream lo borró por desuso |
| `/review-fleet` | `host-orchestrator` v4 (ya portado al motor); se pierde el modo interactivo report-only |

Repos damnificados (15):

- [ ] `Proyectos/apps/fastfood_saas`
- [ ] `Proyectos/apps/mutantes-gym`
- [ ] `Proyectos/apps/pliego`
- [ ] `Proyectos/apps/video-to-knowledge`
- [ ] `Proyectos/apps/voice-recorder`
- [ ] `Proyectos/FB/fb-ingenieria-next`
- [ ] `Proyectos/leopoldo/home_lab`
- [ ] `Proyectos/SC/lab/portal-compras-explorer`
- [ ] `Proyectos/SC/servicios/saltacompra-auth`
- [ ] `Proyectos/SC/servicios/saltacompra-bridge`
- [ ] `Proyectos/SC/sistemas/portal`
- [ ] `Proyectos/SC/sistemas/saltacompra/satelites/App.SaltaCompra`
- [ ] `Proyectos/SC/sistemas/saltacompra/satelites/saltacompra-aprende`
- [ ] `Proyectos/SC/sistemas/saltacompra/satelites/saltacompra-pagos`
- [ ] `Proyectos/webs/terra-santa`

### `sandcastle-max` → `host-orchestrator` v4

El host es el único sustrato: los 7 comandos de dispatch/build/merge sobre Docker no tienen a qué apuntar, y el motor v4 no tiene una sola referencia a sandcastle. La sonda `/sandcastle-probe-resources` era el único candidato a sobrevivir y **murió** en [¿El reality anchoring rindió?](https://github.com/LeopoldoBini/leo-stack/issues/12): sobre 379 briefs reales, 2,4 % se ancló a un cache, ninguna sonda se re-corrió nunca y el paso que atrapa una referencia falsa se ejecutó 0 veces. El requisito de anclaje sobrevive como chequeo en runtime (`RESOURCE_UNREACHABLE`), no como snapshot.

Se preserva `stand-by-sql.schema` como snapshot fechado, según #12.

Repos damnificados: **ninguno** — sin instalaciones registradas ni menciones en `settings*.json`.

> Retirado en `c4b4d71`, antes de que existiera este archivo. La marca de rescate lo cubre igual: en `rescate/pre-reconstruccion` el plugin está entero.

### `handoff` 1.0.0 → `mattpocock-skills:handoff`

Repos damnificados:

- [ ] instalación de scope **user** (global, sin `projectPath`)
- [ ] `Proyectos/SC/servicios/saltacompra-bridge` (habilitado en `settings.json`)

### `grill-me` 1.0.0 → `mattpocock-skills:grilling`

Repos damnificados:

- [ ] instalación de scope **user** (global, sin `projectPath`)
- [ ] `Proyectos/SC/servicios/saltacompra-bridge` (habilitado en `settings.json`)
- [ ] `Proyectos/SC/sistemas/saltacompra/satelites/App.SaltaCompra` (habilitado en `settings.json`)

### `caveman` 1.0.0 → sin reemplazo

Output style de estilo cavernícola. Muere sin reemplazo: no hay nada que instalar en su lugar.

Repos damnificados: **ninguno** — sin instalaciones registradas ni menciones en `settings*.json`.

### `response-modes` 1.0.0 → sin reemplazo

Los dos output styles (`caveman`, `no-tldr`) mueren con él.

Repos damnificados:

- [ ] `Proyectos/apps/fastfood_saas` (habilitado en `settings.json`)

### `review-flow` — `/revisar_trabajo` y `revisor_de_trabajo` → `mattpocock-skills:code-review`

El plugin se parte: `/analizar` sobrevive y se muda a `leo-tools` ([#20](https://github.com/LeopoldoBini/leo-stack/issues/20)) por ser un checkpoint pre-ejecución que interpreta dictado por voz, sin equivalente upstream. El comando `/revisar_trabajo` y su agente mueren acá.

El nombre `review-flow` muere con ellos: la mitad que lo justificaba ya no existe, así que `/analizar` no se lleva la caja — viaja en una nueva, `voice-checkpoint@leo-tools` (ver la mudanza más abajo).

Repos damnificados: **ninguno** — sin instalaciones registradas ni menciones en `settings*.json`.

---

## 2026-08-04 — Mudanza a `leo-tools`

Estos cuatro **no mueren: cambian de marketplace**. Figuran acá porque el diff que detecta huérfanos no distingue una muerte de una mudanza —quien los tenga instalados de `leo-stack` los ve igual de ausentes en el índice—, y lo que ningún cómputo puede inferir es justamente lo que este archivo aporta: la dirección nueva.

Bajan por el criterio de pertenencia de [Criterio de pertenencia](https://github.com/LeopoldoBini/leo-stack/issues/2) — resuelven un problema por su cuenta, sin depender del pipeline AFK, y ese es el eje que separa `leo-stack` de `leo-tools`. Decidido en [Veredicto por plugin](https://github.com/LeopoldoBini/leo-stack/issues/6), ejecutado en [Mudar interface-lens, memory-flow, yt-transcript y /analizar a leo-tools](https://github.com/LeopoldoBini/leo-stack/issues/20).

| Plugin | Dirección nueva | Nota |
|---|---|---|
| `interface-lens` 1.0.0 | `interface-lens@leo-tools` 1.1.0 | descriptions a estándar; los tres skills con `disable-model-invocation` |
| `memory-flow` 2.0.0 | `memory-flow@leo-tools` 2.1.0 | idem, sin cambios de comportamiento |
| `yt-transcript` 1.0.0 | `yt-transcript@leo-tools` 1.1.0 | idem, sin cambios de comportamiento |
| `review-flow` 2.0.0 (`/analizar`) | **`voice-checkpoint@leo-tools` 1.0.0** | caja nueva: el nombre viejo prometía un flujo de review que murió arriba |

Migrar es reinstalar desde el marketplace nuevo:

```bash
claude plugin install <plugin>@leo-tools --scope project
```

Repos damnificados:

- [ ] `Proyectos/SC/sistemas/saltacompra/satelites/saltacompra-pagos` — `interface-lens@leo-stack` 1.0.0, scope project, habilitado en `settings.json`

Los otros tres: **ninguno** — sin instalaciones registradas ni menciones en `settings*.json` (censo por las dos fuentes, según la lección de [#19](https://github.com/LeopoldoBini/leo-stack/issues/19)).

> Sin marca de rescate nueva: `rescate/pre-reconstruccion` ya tiene a los cuatro enteros, y la copia viva está en `leo-tools`. Una mudanza no necesita red — la pieza no desaparece de ningún lado.

---

## 2026-08-04 — Retiro de los dos comandos standalone de `host-orchestrator`

`/parallel-implement-wave` y `/merge-orchestrate` se retiran en `host-orchestrator` 4.2.0 — comandos dentro de un plugin que sigue vivo, así que el diff de huérfanos **no los detecta**: quien actualice el plugin simplemente deja de verlos. Figuran acá por el mapeo al reemplazo, que es lo que este archivo aporta.

Decidido en [Estándar de calidad: orden y profundidad de la reescritura](https://github.com/LeopoldoBini/leo-stack/issues/9), ejecutado en [host-orchestrator a estándar](https://github.com/LeopoldoBini/leo-stack/issues/21). Los motivos: eran 971 de las ~1.070 líneas de comandos del plugin, el motor v4 nunca los invocó (sus dos `agentType:` apuntan a los **agentes**, que se quedan), y sus gates evaluaban contra infra borrada en v4.0.0 (`/goal`, `state.json`).

| Pieza | Reemplazo |
|---|---|
| `/parallel-implement-wave` | `/prd-pipeline` (motor v4: impl wave paralela dentro del pipeline) |
| `/merge-orchestrate` | `/prd-pipeline` (motor v4: merge wave serial dentro del pipeline) |
| Modo "wave sin merge" | **sin reemplazo** — recuperarlo sería un `--solo-implement` del motor, fuera del mapa de la reconstrucción |

Los agentes `parallel-implementer` y `merge-resolver` **no mueren**: son el músculo del motor v4.

Repos damnificados: **ninguno que migre** — el plugin sigue en el índice; los 10 repos con `host-orchestrator` instalado reciben el retiro con el `claude plugin update` normal.

**Marca de rescate:** `rescate/comandos-standalone` — `git show rescate/comandos-standalone:plugins/host-orchestrator/commands/<archivo>`.

---

## Retroactivas

### 2026 (fecha exacta desconocida) — `merge-orchestrator` 0.1.0 → `host-orchestrator`

Primera entrada retroactiva, y el caso que motivó este archivo: desapareció del índice sin dejar rastro, y dos repos siguieron con el plugin habilitado sin poder actualizarlo jamás. El zombi silencioso es el daño real de retirar sin registrar — no la ruptura, que la cache pinneada evita.

Repos damnificados (verificado 2026-08-03: ambos ya limpios, barridos por el rename de [#16](https://github.com/LeopoldoBini/leo-stack/issues/16); sin entradas en `installed_plugins.json` ni menciones en `.claude/`):

- [x] `Proyectos/FB/fb-ingenieria-next`
- [x] `Proyectos/webs/terra-santa`
