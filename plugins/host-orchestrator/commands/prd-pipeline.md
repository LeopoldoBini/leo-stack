---
name: prd-pipeline
description: Lanza el pipeline AFK v4 — workflow determinístico que implementa, mergea y revisa las issues de un scope (milestone/label/parent/lista) sobre una rama integradora, con gate numérico y PR final draft. Usage `/prd-pipeline <scope> [+Nk]`.
disable-model-invocation: true
---

# /prd-pipeline

**Spec de referencia (leela ante cualquier duda):** `docs/SPEC-v4-workflow-engine.md` en este plugin — el motor es la materialización 1:1 de esa spec.

## Qué hace

Compone `args` y lanza **`Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/prd-pipeline.js", args })`**. Todo el pipeline (despacho continuo de implementaciones, carril de merge, revisión por PR mergeado, gates, PR final) corre determinístico dentro del workflow, en background. Vos (la sesión) sos el **orquestador T0**: tu único trabajo de juicio es el tiering por nodo y la supervisión; las reglas las ejecuta el script.

## Argumentos

- **Scope** (requerido, posicional): `milestone:<name>` | `label:<label>` | `parent:#N` | `#42,#43,...`
- **`+<N>k` / `+<N>m`** (opcional): hard cap de tokens **de output** de la corrida (el motor no ve el costo ponderado: el output fue ~1/5 del costo en octubre, spec §3.12) — va al `args.budgetTotal` (fuente primaria; la directiva del turno es solo fallback, demostró ser frágil). **Sin `+Nk`, la corrida va SIN tope** (default desde v4.0.8) — pasalo solo cuando quieras limitarla deliberadamente.
- **`--max-parallel=N`** (default 3): techo de carriles de implementación. Lo que frena es la cuota, no la máquina (medido 18/10: un carril continuo gasta ~4–7 %/h de la ventana de 5 h y ~1,3 %/h de la semanal); el vigía de cuota lo baja en caliente (§3.17). Nunca se abren más carriles que issues habilitadas.
- **`--dry-run`** (mostrar plan + args sin lanzar).

## Pasos (vos, la sesión T0)

### 1 — Pre-flight

```bash
git rev-parse --git-dir
git remote show origin | sed -n 's/.*HEAD branch: //p'   # default branch (fallback de base)
cat .host-orchestrator/config.json 2>/dev/null            # contrato del repo (§3.10, opcional)
ls scripts/wave-validate.sh 2>/dev/null
ls ~/.cache/claude-cuota.json 2>/dev/null                 # lectura de cuota de la statusline (vigía, §3.17)
date -Iseconds                                            # ts para args (el script no puede llamar Date.now)

sh "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-read.sh" check '<scope>'
```

El `check` es el gate de entrada: verifica `gh auth`, que el scope resuelva, que los labels existan y que toda dependencia declarada en el body tenga su edge nativo en el grafo — inline (`Blocked by: #N`) o en la sección `### Blocked by` con bullets, que es la que emite `to-tickets`. El motor lee el grafo y no tiene fallback textual: una dependencia que sólo vive en el body despacha la cadena entera en paralelo, cada capa contra piezas que no existen.

Según qué falle:

- **Edges faltantes** → el check imprime los `gh api …/dependencies/blocked_by` exactos. En corrida AFK autorizada los **ejecutás vos** —crear un edge es metadata reversible y el comando viene escrito— y lo anotás en el resumen para Leo. Supervisado: se los mostrás y esperás. Después volvés a correr el `check` hasta verde.
- **Cualquier otra falla** (auth, scope vacío, labels) → reportar BLOCKED con la salida y frenar.

**Nada se lanza hasta el verde**: todavía no se creó ninguna rama.

### 2 — Componer `args`

Defaults del config (todos opcionales): `base_branch` (default: default branch del remoto), `validate_hook`, `test_globs` (default `["**/*.test.*","**/*.spec.*"]`), `model_map` (default `{T0:'opus',T1:'opus',T2:'sonnet',T3:'haiku'}`), `role_tiers`, `role_efforts`, `applier_chunk`, `cuota_umbrales`, `labels` (default `{ready:'ready-for-agent', agentPr:'afk-agent-pr'}`), `deny_paths`, `required_checks`, `max_parallel`.

- **`rama`**: ANTES de computar nada: `git ls-remote origin 'refs/heads/prd/*' 'refs/heads/batch/*'` — si YA existe una rama integradora que corresponde a este scope (de una corrida anterior), **REUSALA con su nombre exacto**, no inventes una variante (aprendizaje Piloto 2: una rama redundante forkeada bloquea la corrida). Si no existe: `prd/<slug>` para milestone, `batch/<slug>` para label/parent/lista; slug = scope value en kebab-case.
- **`runLabel`**: `<rama sin prefijo>-<fecha corta>` (ej. `prd0016-0718`).
- **`tiers`** — TU decisión de diseño como T0, dentro de los rangos de la spec §3.1. Defaults del motor: **scout, validator y serializer en T3 (Haiku)**, implementer/resolver/reviewer/applier en T1. Guarda del motor: el validator corre en T2 mientras no vea que el hook trae los tests (leyendo la salida cruda del runner, Haiku puede dar un falso verde). Para volver lo mecánico a Sonnet, pasá `tiers: {scout:'T2', validator:'T2', serializer:'T2'}`; implementer en T2 solo si la tanda es remediación mecánica. Principio: **modelo mínimo suficiente**. Aplicá `role_tiers` del config si existe. Declarale a Leo la asignación elegida y por qué (2 líneas) ANTES de lanzar.
- **`issueTiers`** (opcional): si conocés issues puntuales triviales/críticas, override por número.
- **`efforts`** (opcional, del config `role_efforts`) — effort de razonamiento por rol. Defaults en el motor (§3.1b): scout/validator/**serializer** `low`, implementer/applier `medium`, resolver/reviewer `xhigh`. **No los toques para ahorrar tokens**: la autopsia de 4 corridas reales (2026-07-27) midió que el output pesa ~6% del costo y el resto es contexto releído (en octubre, con la revisión en xhigh, 17–26 %) — bajar efforts mueve eso y no más, y degradar al revisor cambia calidad de detección por un ahorro marginal (el gate es puramente numérico y la revisión por PR es la única: lo que el revisor no ve, no lo ve nadie). Usalo cuando el TRABAJO lo justifique, no la cuota.
- **`issueEfforts`** (opcional): override de effort por número de issue — el caso legítimo es una tanda de remediación mecánica (`{"312": "low"}`), igual que `issueTiers`.
- **`applierChunk`** (opcional, default 4): arreglos por tanda del aplicador de cada revisión. Con más arreglos que eso, el aplicador trabaja en tandas con contexto fresco sobre el mismo worktree (spec §3.7, «Applier por tandas»): un aplicador único de 491 turnos costó 115M de tokens leídos —39% de una corrida entera—.
- **`cuota`** (opcional): el path absoluto de `~/.cache/claude-cuota.json` si el pre-flight lo encontró. El scout lo lee en cada vuelta y el vigía del motor baja el paralelismo según la ventana de 5 h, la semanal y la velocidad de gasto (§3.17; umbrales en `cuotaUmbrales`, default `{umbral5h: 85, reservaSemanal: 10}`; `horizonteHoras` acorta la proyección, que por default llega al reinicio de cada ventana). Lo escribe la statusline de la sesión: sin `refreshInterval` en su config, la lectura envejece mientras la sesión espera al workflow.
- **`budgetTotal`**: del `+Nk` del comando si vino; **sin `+Nk` → `budgetTotal: null` (SIN tope)**. Decisión de Leo (22-jul, corrida PRD-0019: el tope +1000k cortó la corrida a 58 tokens del `minBudgetWave` dejando 2 slices y la revisión afuera — un tope "razonable" corta donde no debe). Con tope, debajo de `minBudgetWave` no se despacha trabajo nuevo y se termina lo que está en vuelo. NO le propongas un tope ni frenes esperando confirmación: lanzá sin cap e informale el costo estimado de referencia (`~150k × issues + 300k`, la regla vieja de 100k/issue quedó corta) para que sepa qué esperar. Con `+Nk` explícito el comportamiento no cambia: hard cap — es la forma deliberada de Leo de limitar una corrida.
- **`ts`**: el `date -Iseconds` del pre-flight.
- **`readCli`**: `${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-read.sh` **resuelto a path absoluto** — el script del Workflow no ve variables de entorno del plugin. Los demás scripts del plugin (`deps-al-dia.sh`, `mergear-pr.sh`) el motor los resuelve al lado de ese.
- **`scopeInicial`**: la salida de `pipeline-read.sh scope` de acá abajo, ya parseada a objeto. El motor la reusa como primera foto en vez de despachar un agente; `null` la saltea sin romper nada.

### 3 — Confirmar y lanzar

Con la rama ya resuelta, mirá el scope como lo va a ver el motor — misma tabla de bucketing, antes de gastar un token:

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-read.sh" scope '<scope>' --rama <rama> --base <base> [--cuota <cuota>]
```

Mostrale a Leo: los buckets de esa salida (cuántas IMPLEMENTABLE, MERGE_READY, bloqueadas), rama integradora, tiering elegido, budget. Las `SPEC` son las issues padre: no se despachan, son la intención contra la que revisa el revisor de cada PR. Con `--dry-run`: terminar acá.

Confirmado (o corrida AFK ya autorizada por el prompt inicial):

```
Workflow({
  scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/prd-pipeline.js",
  args: { ts, runLabel, repo: <pwd>, scope, base, rama, models, tiers, issueTiers,
          efforts, issueEfforts, applierChunk, readCli, scopeInicial,
          validateHook, testGlobs, denyPaths, requiredChecks, labels,
          maxParallel, cuota, cuotaUmbrales, budgetTotal, minBudgetWave: 300000 }
})
```

Corre en background: monitoreá con `/workflows`; los `log()` del script cuentan la historia. **Para bajar el paralelismo a mano, en caliente**, escribí el número en `.host-orchestrator/paralelo` del repo (el motor lo lee en cada vuelta; borrarlo devuelve el techo `maxParallel`). Al terminar, el reporte estructurado del workflow es tu materia prima para el resumen a Leo (status, PR final draft, bloqueadas, bugs anotados, `para_leo`).

### 4 — Después de un corte: corrida fresca (§3.5, §3.17)

Crash/kill → **relanzá fresco con los MISMOS args**: el scout deriva el estado real de GitHub (lo publicado no se reimplementa, lo mergeado no se remergea, lo mergeado sin la etiqueta `pipeline-revisado` se revisa) y los serializers son check-then-act. Lo que estaba en vuelo sin publicar se rehace; su worktree queda en disco. Con despacho continuo, `resumeFromRunId` reusa poco: el journal encadena las llamadas en orden de invocación y ese orden depende de quién terminó primero, así que después del primer evento en otro orden todo corre en vivo igual que una corrida fresca.

## Qué NO hace

- No crea issues (eso es `mattpocock-skills:to-tickets`, invocado por Leo).
- No mergea la rama integradora a la base: el PR final queda **draft** para el botón verde de Leo.
- No re-decide tiers en runtime: el tiering se pinnea al lanzar (idem efforts).
- No escribe en GitHub desde el pre-flight: `pipeline-read.sh` es solo lectura. Los edges que el `check` reclama los ejecuta el T0 con los comandos que el check imprime (paso 1), nunca el CLI.
- No revisa dos veces: cada PR mergeado tiene un revisor y un aplicador (§3.7), y esa es la única revisión —independiente de quien escribió el código, cuenta como la de ventana limpia—. Lo que encontró y lo que se aplicó queda comentado en el PR y en el reporte.

## Contrato por repo (opcional, `.host-orchestrator/config.json`)

Ver spec §3.10. Sin config → defaults. El contrato de salida del hook `scripts/wave-validate.sh --json` vive en la spec §3.3: si trae los tests, el validator los copia y no corre ninguna suite propia. **Medición inválida nunca es éxito.**

## Entrada AFK (`cc-afk` v4)

```bash
cc-afk() {
  [ -z "$*" ] && { echo "usage: cc-afk <scope> [+800k]"; return 1; }
  API_TIMEOUT_MS=1200000 BASH_DEFAULT_TIMEOUT_MS=300000 BASH_MAX_TIMEOUT_MS=1200000 \
    claude --dangerously-skip-permissions "/prd-pipeline $*"
}
```

Muertos vs v3: `/goal`, `CLAUDE_CODE_MAX_TURNS`, `AUTO_COMPACT_WINDOW`, `DISABLE_THINKING` — el loop ya no es de turnos. Sobreviven solo los timeouts. Supervisado (recomendado para corridas nuevas): sesión interactiva normal, sin `--dangerously-skip-permissions`. <!-- acta -->
