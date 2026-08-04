# Changelog — host-orchestrator

Historial extraído de la description del `plugin.json` (que lo acumulaba en violación del estándar de descriptions ≤ 40 palabras). Detalle técnico de cada mecanismo: la spec (`SPEC-v4-workflow-engine.md`).

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
