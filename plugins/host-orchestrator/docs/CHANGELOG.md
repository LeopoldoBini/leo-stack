# Changelog — host-orchestrator

Historial extraído de la description del `plugin.json` (que lo acumulaba en violación del estándar de descriptions ≤ 40 palabras). Detalle técnico de cada mecanismo: la spec (`SPEC-v4-workflow-engine.md`).

## 4.10.0 (2026-08-25)

**La doctrina de implementación deja de vivir solo adentro del pipeline: nace `implementer`, hermano suelto de `parallel-implementer`.** Misma disciplina —criterios de aceptación numerados, red-green de a uno, la regla de bronce, recursos vivos chequeados contra lo real en el momento, los antipatrones de test que no se embarcan—, pero recibe un encargo en prosa y devuelve un informe en prosa. Sin worktree, sin issue de GitHub, sin sobre XML. Declara `effort: xhigh`, que pisa el de la sesión que lo convoca, así que una sesión en `high` puede pedirle un tramo de implementación sin subir su propio dial.

Se escribió con voz propia en vez de bajar la disciplina compartida a un doc que ambos apunten. La razón es la misma que exime a los agentes del techo de 140 líneas: un agente es un system prompt entero, presente en cada uno de sus turnos, no una entrada de progressive disclosure. Un doc leído al arrancar compite con cada archivo que abre después y se diluye justo cuando llega el cuarto criterio de aceptación. El chequeo de duplicación del estándar es lo que fuerza que la voz propia sea real y no un copiar-pegar con el nombre cambiado.

**Las tres descriptions se reescribieron como conjunto, porque son el único enrutador que hay.** No existe forma de marcar un agente como no invocable por el modelo —el campo no existe para agentes, y por eso el estándar los exime de la regla— así que lo único que decide a quién convoca una sesión es lo que cada description dice de sí misma. Las dos del pipeline arrancan ahora con `Engine-invoked only`, la nueva declara al frente que su entrada es prosa. Ninguna toca el cuerpo de los agentes que ya funcionaban.

## 4.9.1 (2026-08-25)

**`/desatendido` pasa por la vara de `writing-for-agents`, que 4.9.0 se había salteado.** Cuatro arreglos de redacción, sin cambio de doctrina.

El encabezado decía "los tres modos de falla" sobre cuatro. El alcance del agente estaba partido en dos lugares a treinta líneas de distancia —los agentes arriba, el remoto adentro de la tabla de bloqueos—, así que sube a una sección propia que junta agentes, entorno y remoto bajo una palabra, *alcance*, que la sección 2 después recluta gratis en su definición de bloqueo. La distinción bloqueo/dificultad se queda solo con lo que clasifica. Y los cross-refs por número —"la sección 4"— pasan a nombre, que no se rompe al reordenar.

## 4.9.0 (2026-08-25)

**`/desatendido` aprende del primer uso real, que salió mal por un hueco del propio skill.** Una corrida en el devbox terminó con el agente diagnosticando y arreglando un choque entre dos ramas —suite entera en verde, verificado por él mismo— y devolviendo el resultado como un comando para que Leo lo copiara. Tres horas de espera por un push que el agente tenía a mano.

**El hueco: la sección 2 medía el bloqueo por capacidad y nunca por permiso.** El agente no dijo "no puedo", dijo "no me toca" — aplicando fuera de contexto una regla del pipeline cuyo motor ya estaba muerto. Ahora la sección lo nombra: la restricción de un mecanismo muere con el mecanismo, y la mano del agente llega hasta main. El único borde es lo que un merge dispara y no vuelve con un revert: deploy a producción, migración sobre datos reales, aviso a terceros.

**El segundo hueco: verificar no era entregar.** La sección 4 pasa a ser "verificado y entregado", con su propia prueba —si esta sesión desaparece ahora, ¿alguien encuentra lo que hiciste?— porque en desatendido la conversación no la lee nadie. Se suma un cuarto modo de falla, el trabajo huérfano, con el caso real adentro.

## 4.8.2 (2026-08-24)

**El consejo a Leo sale del skill y sube al README.** Era material humano dentro de un documento que lee un agente: no cambiaba su comportamiento —para cuando lo lee, el encargo ya está dado— y decía desde el lado del que pide lo mismo que la sección 1 ya resuelve desde el lado del que ejecuta. Vive donde se consulta antes de invocar, sin pagar contexto en cada corrida.

## 4.8.1 (2026-08-24)

**`/desatendido` pierde la sección que reponía el flujo del pipeline** (aislar, commits locales, PR sin mergear). Sobrevivía por herencia, no por necesidad: el skill sirve igual en un repo sin pipeline, y esas cuatro reglas ataban la metodología a una forma de trabajo que no siempre aplica. Quedan cinco secciones; el eje —bloqueo no es dificultad, terminado significa verificado— no se toca.

## 4.8.0 (2026-08-24)

**Skill `/desatendido` — la receta de trabajo autónomo sin supervisión.** Destilada de una instrucción que Leo dio a mano y funcionó, más lo que ya estaba curado en la disciplina del implementer. Es metodología pura: no despacha nada, no depende del motor, y corre igual en la Mac que en la devbox.

El reencuadre: el fracaso caro no es un agente que rompe algo —eso lo absorbe un PR sin mergear— sino uno que vuelve a la mitad. Así que el skill va sobre terminación, no sobre contención. El eje es una distinción que reemplaza a todos los gates: **bloqueo no es dificultad**. Un test que no pasa, un portal que cambió o un disco lleno son trabajo; lo único que justifica volver es que falte una pieza fuera del alcance del agente y que no pueda fabricar. Y lo único duro adentro es que terminado significa verificado, con la salida real pegada.

Sin caps, sin gates y sin configuración: decisión explícita. Donde parecería faltar un freno, la respuesta es criterio mejor escrito.

Del plugin se roba la disciplina de cerrar una pieza —aislar, criterio de terminado que se ejecuta, commits locales, PR sin mergear— fuera del flujo del pipeline.

## 4.7.0 (2026-08-24)

**`effort: xhigh` en `parallel-implementer` y `merge-resolver`.** El esfuerzo no se hereda de la sesión que lanza el pipeline —solo el modelo—, así que los dos agentes venían corriendo en el default `high` sin importar en qué estuviera el orquestador: un escalón por debajo sin que se notara en ninguna corrida. La doc de Anthropic recomienda `xhigh` para coding y trabajo agéntico, que es exactamente lo que hace el implementer (TDD e iteración contra criterios de aceptación); y el resolver decide sobre lo que ningún test atrapa, porque un merge mal resuelto entra a la integradora en verde.

Sin cambios de modelo: los dos siguen en Opus.

## 4.6.0 (2026-08-22)

Siete afinados de la corrida `prd-0030-0818` (App.SaltaCompra, 7 issues en cadena de 5 eslabones, PR #609). La corrida terminó DONE: esto es afinado, no rescate — y el `resumeFromRunId` que la destrabó repuso 74 agentes de caché sin re-trabajo.

**El grave — el `check` era ciego al formato que emite `to-tickets`** (leo-stack #27). Los 7 briefs declaraban sus dependencias como sección `### Blocked by` + bullets, el grafo nativo estaba VACÍO y el check dio verde: sin la intervención manual del T0, el motor despachaba la cadena entera en paralelo, cada capa contra piezas inexistentes. Ahora lee los dos formatos —inline y sección—, extrae las referencias token por token (partir por no-dígitos convertía el `2` de `APIMarkeyV2` en una issue) y compara contra la **lista real de edges**, no contra el contador del summary, que daba por chequeada a una issue con un edge y dos dependencias declaradas. Fixtures `prosa` extendidas. Spec §3.13b.

**Guardia de cierre: agotar `maxWaves` ya no tira la corrida.** Un eslabón serial cuesta dos waves, así que 5 eslabones con `maxWaves=10` consumieron el tope justo al terminar de implementar y la corrida murió BLOCKED con las 7 issues DONE, sin review fleet ni PR final. Al agotarse el tope corre un scout más: si el scope quedó completo, sigue a Review y cierre; si no, el status es `WAVE_CAP` con el piso a usar. Del lado del comando, ese piso —`2 × eslabones_seriales + 2`— se calcula antes de lanzar. Spec §3.14.

**Dos fricciones del serializer, de fábrica.** El worktree efímero del PR se suelta ANTES del merge: `--delete-branch` borra también la copia local y falla si la branch sigue checkouteada (dos PRs de la corrida se resolvieron a mano). Y la resolución del merge-resolver se pushea en el acto —el camino del refresh ya lo hacía, el del PR no—; si el push falla, el PR queda `merge-blocked` conservando el worktree, único lugar donde vive esa resolución.

**Tres menores:** `milestone:PRD-0030` resuelve por prefijo el título real `PRD-0030 — Informe de …` (ambigüedad = muerte con la lista de candidatos, nunca elección silenciosa); el scope viaja como una sola descripción legible, así que un `args.scope` string deja de imprimir `undefined:undefined` en el banner, en el packet del resolver, en el prompt del juez y en el **título del PR final** (que en esta corrida salió bien sólo porque el serializer improvisó uno propio); y las issues DONE que ve cualquier scout alimentan el `Closes #` del PR final, no sólo las que publicó la corrida.

**Proceso:** en corrida AFK autorizada, los edges que el `check` reclama los ejecuta el T0 —metadata reversible, con el comando ya escrito— y lo reporta. Supervisado, los muestra y espera.

## 4.5.0 (2026-08-10)

**Bloqueante saldado en la integradora** (leo-stack #26, expuesto por la corrida `ready-for-agent-0809` de omega-radar): un bloqueante del scope con PR mergeado a la rama integradora se descuenta del gate de dependencias aunque GitHub lo siga contando abierto — su código ya está en la base desde la que branchea el dependiente, y la issue recién cierra con el PR final a la default branch. Sin el descuento, un scope en cadena A←B←C avanzaba un eslabón por corrida y por botón verde. Bloqueantes fuera del scope siguen rigiéndose por el grafo tal cual. Fixture `cadena` en el test. Spec §3.13.

## 4.4.1 (2026-08-07)

Tres bugs cazados en la corrida real 16-17-0806 (cuenta-norte, primera con `all_done` por scopeInicial):

- **`pipeline-read.sh`: un `gh` caído dentro de un `pipe|while` se tragaba el error** — `muere` mataba solo al subshell y el scope seguía vacío con exit 0; el motor leía "0 issues" y frenaba BLOCKED sin causa visible. La lista explícita y el loop de PRs abiertos pasan a `for` en el shell principal (fail-loud), y un token no numérico en la lista muere con mensaje claro.
- **Motor: `args.scope` como string rompía el scout.** `SCOPE_ARG` asumía `{type, value}` y con el string literal del comando quedaba `"undefined:undefined"` (que el CLI convertía en el "0 issues" de arriba — los dos bugs encadenados). Ahora acepta ambas formas.
- **Motor: `all_done` en la wave 1 salteaba la captura de baseline** y el gate de los fixes de la review reventaba con `baseMetrics` null. La review recaptura baseline sobre la integradora si falta. De paso: `denyPaths`/`requiredChecks` en null ya no revientan (`??= []`).

## 4.4.0 (2026-08-04)

**El pipeline deja de tener contrato propio: consume los artefactos de la suite de Matt tal como salen** (leo-stack #10, ejecutado en #24). Detalle de cada mecanismo en la spec §3.13.

Breaking para quien escribiera briefs: **el `## Agent Brief` muere**. El contrato es el body del ticket, y la intención sube por la escalera al spec padre. No había gate que perder — la regla `IMPLEMENTABLE` nunca chequeó que existiera un brief, así que una issue sin él ya se despachaba igual y bloqueaba recién con un worktree quemado.

Pieza nueva: **`scripts/pipeline-read.sh`** (POSIX sh, solo `gh`), el lado de lectura del pipeline, con test y fixtures. `scope` bucketea sobre el grafo nativo de GitHub, `check` corre las precondiciones y `intent <issue>` devuelve la escalera de intención (spec padre, índice de ADRs, rama de prototipo). Se corre a mano antes de lanzar: hasta hoy, lo que el pipeline iba a hacer era invisible hasta que el scout reportaba. Solo lectura, con candado verificado en código — `gh api` conmuta a POST en cuanto ve un `-f`, y el mismo endpoint que lee las sub-issues, con POST, agrega una.

En consecuencia: el **scout pasa a transporte** (corre el CLI y devuelve stdout; la wave 1 reusa el pre-fetch de T0 y no despacha agente), las **dependencias y el spec padre salen del grafo nativo** sin fallback textual —con un `check` que falla ruidoso e imprime los `gh api` exactos en los repos heredados—, el **spec no se despacha** (bucket `SPEC`, detectado estructuralmente), el **anclaje a evidencia real pasa a runtime** (`recursos_verificados` con cómo y cuándo, `RESOURCE_UNREACHABLE` si no se llega, y la verificación viaja al body del PR), y la **review fleet gana el eje Spec**: un reviewer sobre el diff integrado completo, con el scope creep ruteado a HUMANO y nunca a APLICAR.

Bug de paso, en la fleet: la lente se pegaba a cada finding *después* de filtrar los reviewers muertos, así que un reviewer caído corría los índices y etiquetaba mal todo lo que seguía.

## 4.3.1 (2026-08-04)

Dos marcadores `<!-- acta -->` para el gate del estándar (leo-stack #25): las menciones de `/parallel-implement-wave`, `/merge-orchestrate` y `/goal` en el README y en `/prd-pipeline` son historia declarada, no sediment vivo. Sin cambios de comportamiento.

## 4.3.0 (2026-08-04)

Comando nuevo **`/init`** — onboarding de un repo al pipeline AFK, nacido a estándar (leo-stack #23). Es lo que sobrevive de `/init-workflow` del retirado `engineering-workflow`: el bloque de pipeline de siete pasos muere (existía en 3 de 15 repos, los 3 podridos; el orden canónico lo publica `mattpocock-skills` con `/setup-matt-pocock-skills`) y queda la pieza que ningún cómputo suple — **la regla HITL**: al aprobar el breakdown de `/to-tickets`, los slices que necesiten humano bajan a `ready-for-human`, porque el motor despacha solo lo que lleva `ready-for-agent` (leo-stack #10 §8).

Siembra dos artefactos y nada más: un bloque idempotente en `CLAUDE.md` con marcadores propios (`<!-- host-orchestrator:start -->`) que además remueve el bloque huérfano de `engineering-workflow` si lo encuentra, y `.host-orchestrator/config.json` con lo que el comando constata del repo — `base_branch` y `validate_hook`. Los defaults del motor (`model_map`, `role_tiers`, `role_efforts`, `labels`, `test_globs`, `applier_chunk`, `deny_paths`) **no se copian**: cada clave se agrega el día que el repo quiere apartarse, porque congelarlas en 39 repos es la misma verdad en 40 lugares.

## 4.2.0 (2026-08-04)

Retiro de los dos comandos standalone `/parallel-implement-wave` y `/merge-orchestrate` (971 de las ~1.070 líneas de comandos): el motor v4 nunca los invocó y sus gates evaluaban contra infra borrada en v4.0.0. Reemplazo y rescate: `DEFUNCIONES.md` del marketplace, tag `rescate/comandos-standalone`. Además, el plugin entero pasa al estándar de calidad (leo-stack #9/#21): descriptions ≤ 40 palabras, `disable-model-invocation: true` en `/prd-pipeline` (reemplaza el gate en prosa), README reducido a portada, sediment de la spec corregido (§4 tabla de migración, §6.5 presupuesto), constraints del `parallel-implementer` reformulados en positivo.

## 4.1.0

Control de effort por rol y por issue (`role_efforts` → `args.efforts`, `args.issueEfforts`) + tres recortes de costo derivados de la autopsia de 4 corridas reales (2026-07-27) que midió tokens por rol en los transcripts de agentes: el costo escala con turnos × contexto acumulado, NO con el effort (output por corrida 187k-457k vs cache read 47M-215M; apagar todo el razonamiento de los 13 reviewers ahorraría ~6%).

- **Applier por tandas** (§3.7c, `applier_chunk`, default 4): el applier único de la corrida prd0019-0722 corrió 491 turnos con el contexto creciendo de 44k a 462k → 115M de tokens leídos, 39% de esa corrida en UN agente; ahora la tanda 1 crea el worktree aislado y las siguientes hacen cd con contexto fresco, acumulando aplicadas/falladas (tanda muerta → sus fixes van a `humano`).
- **Diff pre-filtrado por unidad** (§3.7b): cada reviewer hace `git diff -- <paths de su unidad>` en vez del diff integrado completo (fallback `.`), sin tocar cobertura.
- **Disciplina de contexto** en implementer y applier: reporters silenciosos, tests del área mientras se itera, no releer archivos ya leídos, leer rangos (un implementer de 269 turnos costó 79M, más que los 13 reviewers juntos).

Defaults de effort: scout/validator/serializer `low`, implementer/applier `medium`, resolver/particionador/reviewer/judge `high` — la fleet NO se recorta para ahorrar: el gate es puramente numérico y el judge no recupera falsos negativos.

## 4.0.8

Sin `+Nk` la corrida va SIN tope (`budgetTotal: null`) — el T0 ya no propone/espera un tope; `+Nk` queda como hard cap deliberado (decisión Leo 22-jul tras la corrida PRD-0019, donde +1000k cortó a 58 tokens del `minBudgetWave` dejando 2 slices y la review fleet afuera; regla de referencia de costo actualizada a ~150k×issues+300k).

## 4.0.7

El serializer del PR final draft comenta `@coderabbitai review` (CodeRabbit skipea drafts y bases no-default; el trigger manual fuerza la review externa sobre el PR integrador y el T0 triagea las observaciones — calibrado en la corrida 296-...-0720, donde el triage manual destapó 2 bugs funcionales).

## 4.0.6

Fix del medidor baseline — el paso 0 (`git pull --ff-only` de la rama integradora) corría en el cwd del repo (checkout de master) en vez del worktree de integración; con la integradora adelantada por merges propios el pull "diverge" y abortaba el wave (corrida 296-...-0720). Ahora el pull hace cd al worktree primero.

## 4.0.5

Engine workflow renombrado a `prd-pipeline-engine` — la colisión de nombre con el comando `/prd-pipeline` hacía que el slash resolviera al workflow pelado con el scope crudo (guard lo frenaba, pero costaba un ciclo). Misma corrida (289-...-0720): whitelist cerrada de metrics por código en TODA medición (`args.metricKeys`, default `typecheck_errors`), contrato de path canónico del worktree de merge con remoción segura de checkouts duplicados, y limpieza obligatoria del worktree del implementer post-PR.

## 4.0.2

Fix: custom subagents despachados con nombres plugin-qualified (`host-orchestrator:parallel-implementer` / `host-orchestrator:merge-resolver`) — los nombres sin calificar no resolvían, `parallel()` se tragaba el throw a null, y los wave loops giraban re-scouteando sin implementar nunca (apareció en la primera corrida v4 real). Además: `args` falla rápido con error claro si el orquestador T0 pasa el scope crudo en vez de componer el objeto.

## 4.0.0 (BREAKING)

El motor del pipeline pasa a ser un Workflow script determinístico (`workflows/prd-pipeline.js`, lanzado por el nuevo comando `/prd-pipeline`) — las reglas corren como código JS, los agentes solo implementan/miden/resuelven. Gate = `if` puro sobre los números del validator (ratchet genérico: ninguna métrica empeora vs baseline de wave, ningún test antes-verde pasa a rojo, el diff debe tocar tests; medición inválida NUNCA es éxito). Política de rama integradora: crea `prd/<milestone>` (o `batch/<slug>`), los PRs de issues le apuntan, la base se mergea antes de cada wave, la corrida termina en UN PR draft a la base para el botón verde de Leo. Toda mutación remota serializada por agentes serializer idempotentes (check-then-act, keyed por identidad de trabajo, audit-logged). Tiers de capacidad T0-T3 en vez de nombres de modelos (mapeo solo en `model_map` del config del repo); la sesión que lanza es el orquestador T0 y pinnea el tier de cada nodo en diseño. Review fleet nativa (partición → reviewers → judge → applier → gate). Resume via journal del Workflow: `resumeFromRunId` solo si nada cambió a mano, corrida fresca siempre segura. Spec grillada 2026-07-16, validada por Piloto 1 ratchet-TS 2026-07-17 (6/6 criterios, 3 resumes sin mutaciones duplicadas). REMOVIDOS: `/afk-pipeline`, `/goal` wrapping, `state.json`, `PROGRESS.md`, andamiaje de env vars de `cc-afk` (solo sobreviven los timeouts de Bash/API).
