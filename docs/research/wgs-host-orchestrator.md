# Auditoría `writing-great-skills` sobre `host-orchestrator` v4.1.0

**Issue:** [#5](https://github.com/LeopoldoBini/toolkit-leopoldo/issues/5) · **Fecha:** 2026-08-01

**Fuentes primarias**

- El estándar: `~/.claude/plugins/cache/claude-plugins-official/mattpocock-skills/1.2.0/skills/productivity/writing-great-skills/` — `SKILL.md` (83 líneas) + `GLOSSARY.md` (201 líneas) + `agents/openai.yaml`. Citado abajo como **WGS:SKILL §X** y **WGS:GLOSSARY §Término**.
- El ejemplo vivo: los 17 skills de `mattpocock-skills/1.2.0/skills/engineering/` + `productivity/` (medidos: longitud de cuerpo, longitud y forma de `description`, uso de archivos disclosed).
- El auditado: `plugins/host-orchestrator/` v4.1.0 — 3 comandos, 2 agents, README, spec, `plugin.json`. **No hay `skills/`** (decisión explícita del README:248).
- Frontmatter de comandos: `plugin-dev/skills/command-development/references/frontmatter-reference.md` (confirma que los comandos soportan `disable-model-invocation` y `argument-hint`).

**Límite de alcance:** forma y disciplina de skill-writing. Cero propuestas sobre el motor de orquestación; lo funcional que apareció está aislado al final.

---

## 1. El estándar destilado — checklist accionable

### A. Invocación

| # | Regla | Fuente |
|---|---|---|
| A1 | La presencia de `description` **es** el eje de invocación: con description = model-invoked (el agente y otros skills lo alcanzan, y paga **context load** en cada turno); `disable-model-invocation: true` = user-invoked (solo el humano lo tipea, cero context load, la description pasa a ser human-facing). | WGS:SKILL §Invocation; GLOSSARY §Description |
| A2 | Elegir model-invocation **solo** si el agente debe alcanzarlo por su cuenta, o si otro skill debe. Si solo dispara a mano → user-invoked y no se paga nada. | WGS:SKILL §Invocation |
| A3 | Cuando los user-invoked se multiplican más allá de lo que el humano recuerda (**cognitive load**), la cura es un **router skill**, no volverlos model-invoked. | WGS:SKILL §Invocation |

### B. La `description`

| # | Regla | Fuente |
|---|---|---|
| B1 | Hace dos trabajos: decir qué es, y listar las **branches** que deben dispararlo. Nada más. | WGS:SKILL §Writing the description |
| B2 | **Front-load la leading word** — ahí es donde hace su trabajo de invocación. | ídem |
| B3 | **Un trigger por branch.** Sinónimos que renombran la misma branch son **duplication**; colapsarlos. | ídem |
| B4 | **Cortar la identidad que ya está en el cuerpo.** La description es triggers + la cláusula "when another skill needs…". | ídem |
| B5 | Cada palabra es context load ⇒ la description se poda **más duro** que el cuerpo. | ídem |
| B5b | *Norma empírica (engineering/ de Matt, 17 skills):* mediana **26 palabras**, mínimo 12, máximo 70 (`code-review`, y es el outlier). Ninguna lleva flags, usage ni changelog. | medición propia |

### C. Jerarquía de información

| # | Regla | Fuente |
|---|---|---|
| C1 | Escalera de tres peldaños: (1) **step in-skill**, (2) **reference in-skill**, (3) **reference disclosed** detrás de un context pointer. Un skill puede ser todo steps, todo reference, o ambos. | WGS:SKILL §Information hierarchy |
| C2 | Cada step termina en un **completion criterion**: *checkable* (¿el agente distingue hecho de no-hecho?) y, donde importa, *exhaustivo* ("cada modelo modificado contabilizado"). Un criterio vago invita **premature completion**. | ídem; GLOSSARY §Completion Criterion |
| C3 | **Progressive disclosure**: inline lo que TODA branch necesita; detrás del pointer lo que solo ALGUNAS alcanzan. No es optimización de tokens: es cómo se protege la jerarquía. | WGS:SKILL §Information hierarchy; GLOSSARY §Progressive Disclosure |
| C4 | La **redacción** del context pointer —no su destino— decide cuándo y con qué fiabilidad el agente alcanza el material. Pointer débil sobre material must-have = bug de varianza. | GLOSSARY §Context Pointer |
| C5 | **Co-location**: definición, reglas y caveats de un concepto bajo un mismo heading; leer una parte trae a sus vecinas. | WGS:SKILL §Information hierarchy |
| C6 | **Sprawl** es falla en sí: largo, aunque cada línea esté viva y sea única. Cura: bajar reference por la escalera y partir por branch/secuencia. | GLOSSARY §Sprawl |
| C6b | *Norma empírica:* cuerpos de SKILL.md de Matt entre 7 y 140 líneas (mediana ≈ 78); el archivo disclosed más largo del repo es 207 líneas. | medición propia |

### D. Granularidad — cuándo partir

| # | Regla | Fuente |
|---|---|---|
| D1 | **Corte por invocación**: partir un model-invoked cuando hay una **leading word** distinta que deba dispararlo sola. Se paga context load. | WGS:SKILL §When to split |
| D2 | **Corte por secuencia**: partir una corrida de steps cuando los **post-completion steps** visibles tientan al agente a apurar el actual. | ídem |

### E. Pruning

| # | Regla | Fuente |
|---|---|---|
| E1 | **Single source of truth**: cada significado en un solo lugar autoritativo. | WGS:SKILL §Pruning |
| E2 | **Relevance**: ¿la línea todavía incide en lo que el skill hace? Se pierde por no incidir nunca, o por quedar stale. Acumulación de stale = **sediment**. | WGS:SKILL §Pruning; GLOSSARY §Sediment |
| E3 | **No-op test, oración por oración**: ¿cambia el comportamiento respecto del default? Si no, se borra la oración entera — no se recorta. Ser agresivo. | WGS:SKILL §Pruning |

### F. Leading words

| # | Regla | Fuente |
|---|---|---|
| F1 | Concepto compacto ya presente en el pretraining, con el que el agente piensa mientras corre el skill. Se repite **como token, nunca como oración**: así acumula definición distribuida. | WGS:SKILL §Leading words; GLOSSARY §Leading Word |
| F2 | Sirve dos veces: en el cuerpo ancla **ejecución**; en la description ancla **invocación** (más aún si la misma palabra vive en tus prompts y tu código). | ídem |
| F3 | Acuñar palabra propia funciona solo si se define; una palabra inventada no recluta priors — se paga en tokens de definición lo que una pretrained da gratis. | GLOSSARY §Leading Word |
| F4 | Buscar activamente **restatements que una leading word retira**: una tríada deletreada en tres sitios, una description gastando una oración en gesticular una idea. | WGS:SKILL §Leading words |

### G. Failure modes a diagnosticar

**Premature completion**, **duplication**, **sediment**, **sprawl**, **no-op** y **negation** (WGS:SKILL §Failure modes). Dos que pesan en esta auditoría:

- **Negation** — dirigir por prohibición contraproduce: *don't think of an elephant* nombra al elefante y lo vuelve más disponible. Cura: **prompt the positive**. Una prohibición se gana el lugar solo como guardrail duro imposible de formular en positivo, y aun así se la aparea con qué hacer en su lugar.
- **Sediment** — capas viejas que se asientan porque agregar se siente seguro y borrar riesgoso. Destino por defecto de cualquier skill sin disciplina de pruning.

---

## 2. Hallazgos por archivo

Notación: **[ALTA/MEDIA/BAJA]** severidad · **RETOQUE** (edición local, sin repensar la estructura) vs **REESCRITURA** (hay que rehacer la pieza).

### 2.1 `plugin.json` — description

**Cumple:** `name` y `version` correctos y consistentes con el marketplace.

**Viola:**

| Hallazgo | Regla | Sev. | Arreglo |
|---|---|---|---|
| La `description` es un **changelog acumulado de ~950 palabras** (v4.0.0 → v4.1.0 apiladas en un solo párrafo, con fechas, IDs de corrida, conteos de turnos y tokens). Es el caso de libro de **sediment**: cada versión agregó su capa y ninguna se removió. | E2, C6 | **ALTA** | **REESCRITURA** (barata): description = 1-2 líneas de qué es el plugin; el changelog se muda a `CHANGELOG.md`. |
| Duplica material que ya vive en SPEC §3.1b, §3.7b, §3.7c y en `commands/prd-pipeline.md` (autopsia de costos, defaults de effort, decisión del budget). Tres fuentes de verdad para la misma doctrina. | E1, B4 | ALTA | ídem |
| Es identidad + historia, cero trigger. | B1, B4 | MEDIA | ídem |

> Matiz honesto: la description de `plugin.json` no se carga en el contexto por turno como la de un skill, así que el costo es de mantenimiento y legibilidad, no de context load. Pero E1/E2 aplican igual, y es el artefacto más degradado del plugin.

### 2.2 `commands/prd-pipeline.md` (95 líneas) — el mejor ciudadano del plugin

**Cumple (y vale nombrarlo):**

- Cuerpo de 95 líneas, dentro de la norma C6b. Steps numerados 1→4, cada uno con criterio operable ("fallos de precondición → BLOCKED y frenar", "con `--dry-run`: terminar acá").
- **Progressive disclosure real**: no inlinea el motor; apunta al SPEC como external reference y cita secciones (§3.1, §3.3, §3.5, §3.10) — C1/C3 bien resueltos.
- **Leading words fuertes y consistentes** (F1/F2): *T0 / tiers*, *rama integradora*, *gate*, *wave*, *review fleet*, *hard cap*, *botón verde de Leo*, *modelo mínimo suficiente*. Son palabras que Leo efectivamente usa en sus prompts — exactamente el mecanismo que el estándar describe.
- "Qué NO hace" acotado a 4 bullets, cada uno delimitando alcance real (no es no-op).

**Viola:**

| Hallazgo | Regla | Sev. | Arreglo |
|---|---|---|---|
| `description` de **82 palabras** (3× la mediana de Matt) que mezcla identidad, usage, sintaxis de scope, semántica del `+Nk` y rol del T0. La mitad es manual, no trigger. Existe `argument-hint` en el frontmatter de comandos justamente para el usage. | B1, B4, B5 | **ALTA** | **RETOQUE**: description → 1 línea con la leading word al frente (*pipeline AFK* / *rama integradora*); usage → `argument-hint`; el resto ya está en el cuerpo. |
| `description` dice "reemplaza a `/afk-pipeline`" — comando borrado en v4.0.0. Sediment en el lugar más caro. | E2 | MEDIA | RETOQUE: borrar. |
| El gate ⛔ (línea 10) se implementa como **prosa negada** ("STOP NOW", "do not create branches, do not launch any Workflow") cuando existe la palanca mecánica `disable-model-invocation: true`. Es negation-steering donde el frontmatter da garantía. | G-Negation, A1 | MEDIA | **RETOQUE**: agregar el flag + dejar una línea positiva ("lo invoca Leo"). *Verificar antes* que `cc-afk` (prompt inicial del CLI) siga funcionando — el flag bloquea la herramienta `SlashCommand`, no el input del usuario. |
| Los bullets `efforts`, `budgetTotal` y `applierChunk` de §2 cargan la **justificación histórica completa** (autopsia de 4 corridas, fecha, corrida PRD-0019, "491 turnos costó 115M", "cortó a 58 tokens del minBudgetWave"). Todo eso ya vive en SPEC §3.1b/§3.7c: duplication que además infla el rango de esa doctrina en la escalera. | E1, C1 | MEDIA | RETOQUE: dejar la regla operativa + pointer al § de la spec. Recorta ~12 líneas del step. |
| §"Entrada AFK (`cc-afk` v4)" + "Muertos vs v3" (líneas 85-95): documenta el `~/.zshrc` del usuario dentro del comando. No cambia el comportamiento del agente cuando el comando corre (**no-op**), no incide en la tarea (**relevance**), y duplica README:194-211. | E3, E2, E1 | MEDIA | RETOQUE: borrar; vive en README y en el CLAUDE.md global. |
| Pointer al SPEC redactado como "leela ante cualquier duda" — condición difusa sobre material must-have. | C4 | BAJA | RETOQUE: redactar la condición ("antes de componer `args`, leé §3.1 y §3.10"). |

### 2.3 `commands/parallel-implement-wave.md` (561 líneas) — el peor archivo

**Cumple:** steps numerados 1→9 con criterios de corte claros (el gate de validación es explícitamente bloqueante); tabla de flags con defaults; sección "What this command does NOT do" que delimita alcance real.

**Viola:**

| Hallazgo | Regla | Sev. | Arreglo |
|---|---|---|---|
| **Sprawl severo: 561 líneas**, 4× el skill más largo de Matt (140) y 2,7× el archivo disclosed más largo (207). Aunque cada línea estuviera viva, el largo es la falla. | C6, C6b | **ALTA** | **REESCRITURA** vía escalera. |
| El grueso del archivo es **reference en el peldaño 1**: bloques bash de push/PR/labels/cleanup (≈180 líneas), plantillas de comment a issues, tabla ASCII de preview, formato del reporte final, y una sección entera de "Audit log format reference" (§, 18 líneas) que nadie necesita mientras despacha. Todo eso son ramas que solo algunas corridas alcanzan. | C1, C3 | **ALTA** | **REESCRITURA**: bajar a `reference/` (p. ej. `validate-cascade.md`, `audit-log.md`, `report-format.md`) con pointers redactados. El cuerpo debería quedar en el orden de 120-150 líneas. |
| **Gate ⛔ con condición inalcanzable** (líneas 12-13): habilita la invocación si el usuario tipeó `/afk-pipeline` (borrado en v4.0.0) o si hay una sesión `/goal`-wrapped con `.host-orchestrator/pipelines/*.state.json` (borrados en v4.0.0). El gate más importante del archivo tiene la mitad de sus condiciones evaluando contra un mundo que ya no existe. | E2 | **ALTA** | RETOQUE: reemplazar por `disable-model-invocation: true` + una línea positiva. |
| Duplicación cruzada con `merge-orchestrate.md`: el bloque pre-flight + stash (≈25 líneas) y la **cascada de validación con autodetección de package manager** (≈30 líneas) son casi idénticos en los dos comandos. Dos fuentes de verdad para una sola regla. | E1 | **ALTA** | **REESCRITURA** parcial: extraer a un reference compartido del plugin, apuntado desde ambos. |
| Step 5 replica el contrato del subagente ("Follow your system prompt's 5 sections exactly" + la lista de las 5). El contrato ya vive en `agents/parallel-implementer.md`; peor, la referencia es **por número de sección**, y el agente hoy tiene 9 — cualquier reordenamiento la rompe en silencio. | E1, C4 | MEDIA | RETOQUE: el prompt compuesto pasa solo el contexto por-issue; la disciplina la aporta el system prompt. |
| El "Reading order" del prompt compuesto (Step 5) duplica §6 del agente, línea por línea. | E1 | MEDIA | RETOQUE: borrar del comando. |
| `description` de 60 palabras: identidad + usage + 5 flags. | B1, B4, B5 | MEDIA | RETOQUE: trigger de 1 línea + `argument-hint`. |
| Duplica de README: tabla de flags, bloque de ejemplos, descripción del audit log. | E1 | MEDIA | RETOQUE (lado README, §2.7). |
| Cierre: "a future `/host-pipeline` command (same plugin) will cover that" — comando que nunca existió; lo que llegó fue `/prd-pipeline`. | E2 | BAJA | RETOQUE. |

*(Nota: las referencias a `/review-fleet` **no** son stale — el skill existe en `engineering-workflow`. Verificado.)*

### 2.4 `commands/merge-orchestrate.md` (410 líneas)

**Cumple:** buena **co-location** en "When to use / When NOT to use" (un heading, criterio y contra-criterio juntos — C5); orden topológico con tie-break determinístico y aborto explícito en ciclo (criterio checkable, C2); "Error handling" agrupado en un solo lugar.

**Viola:**

| Hallazgo | Regla | Sev. | Arreglo |
|---|---|---|---|
| **Sprawl: 410 líneas**, con la misma anatomía que 2.3 — bash de mutación, plantillas de reporte y casos de error inline en el peldaño 1. | C6, C1, C3 | **ALTA** | **REESCRITURA** vía escalera. |
| Gate ⛔ idéntico y con la misma condición 2 inalcanzable (`/afk-pipeline`, `.state.json`). | E2 | **ALTA** | RETOQUE (mismo fix que 2.3). |
| El "packet template" de §6.5 reproduce el schema XML de salida **completo** y la prohibición "Do NOT execute `git push`…" que ya están en `agents/merge-resolver.md`; el mismo schema aparece una tercera vez en README:114. **Tres fuentes de verdad** para un contrato de output. | E1 | **ALTA** | **REESCRITURA** de §6.5: el comando pasa datos, el agente define el contrato. |
| El bloque pre-flight+stash y la cascada de validación duplicados con 2.3 (mismo hallazgo, contado una vez). | E1 | ALTA | REESCRITURA compartida. |
| `description` de 74 palabras que narra el algoritmo entero (intent cascade → topo sort → worktree → subagente → XML). | B1, B4, B5 | MEDIA | RETOQUE. |
| §"Tip" (3 líneas): "Start with `--dry-run` to see the planned order" — ya está en la tabla de flags y en Examples. Duplication + no-op. | E1, E3 | BAJA | RETOQUE: borrar. |

### 2.5 `agents/parallel-implementer.md` (213 líneas)

**Cumple — y en un punto es ejemplar:**

- **§4 "Self-check obligatorio" es un completion criterion de manual** (C2): checkable *y* exhaustivo — "por cada criterio de aceptación, nombrá el test **y** el `file:line`", "por cada capa tocada, listá los archivos", typecheck+tests verdes con output capturado. Es exactamente la defensa que el estándar prescribe contra **premature completion**, y está escrita antes del punto de salida (`COMPLETE`), donde muerde.
- **Leading words** de primera (F1): *vertical slice*, *red-green*, *envelope*, *carcass test*. Todas pretrained o autoexplicativas, repetidas como token.
- Los 7 anti-patterns son un **peer-set plano legítimo** (C1 lo bendice explícitamente) y están bien co-locados con la bronze rule que los gobierna.

**Viola:**

| Hallazgo | Regla | Sev. | Arreglo |
|---|---|---|---|
| **§5 "Hard constraints (read three times)": la misma prohibición escrita literalmente tres veces** ("Triple statement #1/#2/#3 — what you NEVER do"), ≈20 líneas, más un cuarto eco en §8 y §9. Es el cruce exacto de los dos failure modes que el estándar más castiga: **negation** (todo el bloque nombra al elefante — *push*, *gh pr create*, *gh pr merge* — y lo repite hasta hacerlo la idea más disponible del prompt) y **duplication** (el estándar dice repetir el **token**, nunca el **significado**: eso es "el inverso accidental de una leading word"). | G-Negation, G-Duplication, F1, F4 | **ALTA** | **REESCRITURA** de la sección: colapsar a una leading word repetida como token — *el host es dueño de toda mutación remota; vos producís commits y el envelope* — más **un** guardrail duro apareado con qué hacer en su lugar (`BLOCKED` + `OUT_OF_SCOPE`). De ~20 líneas a ~4. |
| `description`: "**Used only by `/parallel-implement-wave`**" es falso desde v4.0.0 — el motor `workflows/prd-pipeline.js` también lo despacha (`host-orchestrator:parallel-implementer`). Una description stale que además subdeclara el alcance del agente. | E2, B1 | MEDIA | RETOQUE. |
| `description` de 60 palabras con mecánica de output y conteo de anti-patterns; es un resumen del cuerpo, no un trigger. | B4, B5 | MEDIA | RETOQUE. |
| "Opus 4.8" hardcodeado en el cuerpo (línea 8) y en `model: opus` — pero desde v4 el modelo lo pinnea el T0 vía tiers/`model_map`, y el README dice que el modelo explícito por nodo **override**ea el frontmatter. Decisión duplicada en dos lugares, con el del cuerpo ya stale. | E1, E2 | MEDIA | RETOQUE: sacar el nombre del modelo del cuerpo. |
| §6 "Reading order" duplicado con el prompt compuesto del comando (contado en 2.3). | E1 | MEDIA | RETOQUE. |
| §9 "Tone": "Concise, technical, honest" es no-op (el default ya lo hace); lo que sigue —preferir BLOCKED a un COMPLETE frágil— sí incide, pero ya está dicho en §4. | E3, E1 | BAJA | RETOQUE: borrar la primera oración, fusionar el resto en §4. |
| A 213 líneas está por encima de la norma C6b. Los dos ejemplos XML de §7 (≈55 líneas) son la reference más disclosable. | C6, C3 | BAJA-MEDIA | RETOQUE opcional: `envelope.md`. |

### 2.6 `agents/merge-resolver.md` (109 líneas)

**Cumple:**

- Tamaño en norma (109 líneas).
- **Es la única `description` del plugin que hace trabajo de invocación** como pide B1: cierra con "Use when orchestrating serial squash-merges of multiple PRs and you need each merge decision to be aware of intent and prior merges in the same wave" — una branch, un trigger.
- Los **5 criterios de no-regresión** son reference plana bien co-locada, gobernada por una regla de desempate sharp ("when in doubt, prefer `INCOMPATIBLE`… a blocked PR is recoverable; a silently broken merge is not") — criterio de decisión checkable, no exhortación.
- El nombre "5 no-regression criteria" funciona como leading word: el output los cita **por número**, así que la palabra vuelve como token en la ejecución (F1/F2).

**Viola:**

| Hallazgo | Regla | Sev. | Arreglo |
|---|---|---|---|
| §"What you must NOT do": 5 prohibiciones puras seguidas, sin contrapartida positiva, que además ya están dichas en el packet del comando (§6.5) y en el cuerpo ("The host executes… you do NOT push"). | G-Negation, E1 | MEDIA | RETOQUE: colapsar a 1-2 líneas en positivo + el guardrail de secretos (ese sí es irreductible, y ya viene apareado con qué hacer: HOLD + `CODEBASE_UNEXPECTED`). |
| `description` de **83 palabras** — la más larga del plugin. La cláusula de trigger es buena; las 60 palabras de mecánica que la preceden son identidad ya presente en el cuerpo. | B4, B5 | MEDIA | RETOQUE: conservar la cláusula "Use when…", podar el resto. |
| Schema XML duplicado con el comando y el README (contado en 2.4). | E1 | ALTA | REESCRITURA del lado del comando. |
| §"Tone": "Concise, technical, decisive" — no-op. | E3 | BAJA | RETOQUE. |

### 2.7 `README.md` (288 líneas)

No es un skill: no paga context load y su público es humano. El estándar aplica igual como disciplina de **pruning** y **single source of truth** (E1/E2), no como palanca de predictibilidad.

| Hallazgo | Regla | Sev. | Arreglo |
|---|---|---|---|
| §"Migration from `merge-orchestrator` v0.1.0" (18 líneas, incluye instrucciones de `plugin uninstall`) sobrevive intacta en v4.1.0, tres majors después. **Sediment** textual. | E2 | MEDIA | RETOQUE: borrar (o mover a CHANGELOG). |
| Duplica: los 5 criterios de no-regresión (agent), los 7 anti-patterns parafraseados (agent), las dos tablas de flags (comandos), los dos bloques de Examples (comandos), la función `cc-afk` (`prd-pipeline.md`), los principios v4 (SPEC). Seis significados con dos o tres fuentes de verdad. | E1 | MEDIA | RETOQUE: reemplazar cada duplicado por un pointer de una línea. |
| "Opus 4.8" ×3 y "Haiku/Sonnet/Opus" como modelos concretos, contra la doctrina de tiers del propio README (línea 18). | E2, E1 | BAJA | RETOQUE. |

**Cumple:** el árbol de archivos, el "Decision tree — when to use what" y la sección "Composition with the rest of `toolkit-leopoldo`" son buen material de orientación humana que no está en ningún otro lado — no tocar.

### 2.8 `docs/SPEC-v4-workflow-engine.md` (260 líneas)

**Cumple — es el mejor ejemplo de la escalera en todo el plugin:** external reference genuina (GLOSSARY §External Reference), fuera del cuerpo de cualquier comando, con secciones numeradas y citables (§3.1b, §3.7c) que los comandos y el `plugin.json` usan como pointer. C1/C3 bien resueltos.

| Hallazgo | Regla | Sev. | Arreglo |
|---|---|---|---|
| §6.5 dice "Presupuesto ✅ RESUELTO: **tope SIEMPRE**", contradicho por v4.0.8 (sin `+Nk` la corrida va sin tope). El comando declara que el motor es "la materialización 1:1 de esa spec": quien siga el pointer encuentra la regla vieja. Es el peor lugar posible para el sediment, porque el pointer está bien redactado y el agente **sí** llega. | E2, C4 | MEDIA | RETOQUE: actualizar §6.5. |
| §6 se sigue titulando "Preguntas abiertas (para el grilling)" con los 7 puntos tachados y resueltos; §5.3 anuncia "Siguiente corrida real: PRD-0016… candidata a primera corrida AFK" cuando ya hubo varias (prd0019-0722, 296-0720, 289-0720); el cierre habla de "este DRAFT". | E2 | BAJA | RETOQUE: renombrar §6 a "Decisiones cerradas", actualizar §5, sacar "DRAFT". |

### 2.9 Ausencia de `skills/` — veredicto sobre la decisión

El README:248 declara: *"No `skills/`. No auto-invocation by phrase. The slash commands are the only entry points by design."*

**Contra el estándar, la decisión es correcta pero la implementación elige la palanca débil.** El eje A1/A2 dice que la elección se materializa en la **presencia o ausencia de `description` model-facing**: lo que solo dispara el humano se marca `disable-model-invocation: true` y deja de ser alcanzable. `host-orchestrator` quiere exactamente eso, pero lo persigue con tres párrafos ⛔ de prosa negada dentro de los cuerpos — que el modelo lee **después** de haber decidido invocar, y que son negation-steering en el sentido literal del estándar. El frontmatter de comandos soporta el flag (verificado en `plugin-dev/.../frontmatter-reference.md`, §`disable-model-invocation`, con "destructive operations" y "commands requiring user judgment" como casos de uso canónicos). Cambiar de palanca es **RETOQUE**, y retira de paso ~30 líneas de negación repartidas en tres archivos.

Segundo punto: con 3 comandos user-invoked el **cognitive load** todavía es manejable, así que A3 (router skill) no aplica hoy. Vale registrarlo como umbral: si el plugin crece a 5-6 entradas, el estándar pide un router, no volverlas model-invocables.

---

## 3. Veredicto global

**Estado:** el plugin acierta en lo estructural difícil —jerarquía de información con una spec external genuina, leading words fuertes y consistentes, un completion criterion ejemplar en el implementer— y falla sistemáticamente en lo barato: descriptions que son manuales en vez de triggers, sediment de tres majors sin podar, y prohibiciones repetidas donde el estándar pide una palabra positiva.

**Recuento:** 37 hallazgos únicos (las duplicaciones cruzadas se cuentan una sola vez) — **11 ALTA, 18 MEDIA, 8 BAJA**. Por tipo de arreglo: **30 RETOQUE, 7 REESCRITURA**, y de esas 7 solo 3 son trabajo real (bajar los dos comandos standalone por la escalera y extraer la cascada de validación compartida); las otras 4 son reescrituras de pocas líneas (description de `plugin.json`, §5 del implementer, packet §6.5 de `merge-orchestrate`).

**Esfuerzo total estimado:** ~1 sesión de trabajo. Los ítems 1-4 de abajo (≈2 h) capturan las 10 severidades ALTA salvo el sprawl; el ítem 5 es el medio día restante.

**Por dónde empezar** — orden por bloqueo/valor, no por tamaño:

1. **Sediment que miente** (≈30 min, RETOQUE) — la condición 2 de los gates ⛔ en `parallel-implement-wave` y `merge-orchestrate` evalúa contra artefactos borrados en v4.0.0; SPEC §6.5 contradice v4.0.8; "reemplaza a `/afk-pipeline`" en la description de `prd-pipeline`; `/host-pipeline`; "Used only by `/parallel-implement-wave`". Va primero porque es la única categoría donde la forma degradada **desinforma** al agente en runtime.
2. **Cambiar la palanca del gate** (≈30 min, RETOQUE) — `disable-model-invocation: true` en los 3 comandos + una línea positiva; borrar los tres párrafos ⛔. Verificar antes que `cc-afk` (prompt inicial del CLI) no se vea afectado. Cumple la regla del marketplace con garantía mecánica en vez de con exhortación.
3. **Las 6 descriptions** (≈45 min, RETOQUE) — 5 frontmatters + `plugin.json`. Objetivo: ≤30 palabras, leading word al frente, usage a `argument-hint`, changelog a `CHANGELOG.md`. Es donde el estándar exige la poda más dura y donde hoy está el peor ratio señal/ruido del plugin.
4. **La triple negación del implementer** (≈20 min, REESCRITURA acotada) — §5 de ~20 líneas a ~4, en positivo, con la leading word repetida como token. Único hallazgo con impacto plausible en el comportamiento del agente, no solo en la higiene.
5. **La escalera en los dos comandos maratónicos** (≈medio día, REESCRITURA) — `parallel-implement-wave` (561) y `merge-orchestrate` (410) a un orden de 120-150 líneas cada uno, bajando bash de mutación, plantillas de reporte y formato de audit log a `reference/`, con la cascada de validación y el pre-flight+stash extraídos **una sola vez** y compartidos. Va último porque es el más caro y el único que toca cómo se lee el archivo entero — conviene hacerlo sobre un texto ya podado por 1-4.

**Sobre el README (≈30 min, RETOQUE):** se puede intercalar en cualquier momento; no afecta al agente, solo al mantenimiento.

---

## 4. Fuera de alcance (funcional)

Anotado sin desarrollar, por el límite del ticket:

1. **Los gates de los dos comandos standalone tienen una condición muerta que cambia el comportamiento efectivo.** La condición 2 habilitaba la invocación dentro de una corrida AFK `/goal`-wrapped; ese sustrato no existe desde v4.0.0. Arreglar la *forma* (borrar la condición) deja el comando invocable **solo** por tipeo directo de Leo. Si algún flujo dependía de esa segunda puerta, es una decisión funcional de Leo, no de esta auditoría.
2. **Granularidad del plugin:** con `/prd-pipeline` cubriendo waves de implementación y merge, queda por decidir si `/parallel-implement-wave` y `/merge-orchestrate` siguen siendo entradas de primera clase o pasan a reference del motor. El corte D1 del estándar da vocabulario para discutirlo, pero retirar un comando es decisión de producto.
3. **Verificación pendiente antes de aplicar el punto 2 del plan:** confirmar empíricamente que `claude --dangerously-skip-permissions "/prd-pipeline …"` (el prompt inicial de `cc-afk`) sigue resolviendo el comando con `disable-model-invocation: true` puesto. El flag bloquea la herramienta `SlashCommand`, no el input del usuario, pero conviene medirlo en vez de asumirlo.
4. **Doctrina de effort/budget:** varios hallazgos proponen mover justificaciones históricas del comando a la spec. Eso es reubicación de texto, no cambio de defaults; los valores (`role_efforts`, `applier_chunk`, `budgetTotal: null`) quedan donde están.
