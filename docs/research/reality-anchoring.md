# ¿El reality anchoring rindió? Evidencia de uso de los probes

Research para la issue #12 del mapa wayfinder. Fecha de la corrida: **2026-08-03**.

## Pregunta

El *reality anchoring* — la regla de `/agent-brief` que obliga a validar cada referencia concreta (tabla.columna, endpoint, topic, key) contra `.sandcastle/probes/<name>.schema` antes de publicar el brief — ¿aportó valor medible, o fue un palo en la rueda?

La decisión que desbloquea: por el veredicto de la issue #6 `sandcastle-max` muere, pero `/sandcastle-probe-resources` es host-only y es el **único** productor del insumo del anchoring. Se rescata al plugin-pegamento nuevo (con directorio neutral, ej. `.probes/`) o muere con el resto del plugin.

## Método

Fuentes primarias, todas de primera mano (código del marketplace, disco de los repos consumidores, API de GitHub). Nada inferido de documentación secundaria.

1. **Código del anchoring** — lectura directa de:
   - `plugins/engineering-workflow/skills/agent-brief/SKILL.md` (líneas 42-52: el algoritmo de anclaje y sus tres salidas)
   - `plugins/engineering-workflow/skills/to-issues/SKILL.md` (líneas 69-74: el consumo desde `/to-issues`)
   - `plugins/sandcastle-max/commands/sandcastle-probe-resources.md` (la sonda completa)
   - `plugins/sandcastle-max/commands/sandcastle-dispatch-wave.md` (Level 1 host / Level 3 in-container)
   - `plugins/host-orchestrator/` completo (`grep -rn "sandcastle\|probes\|Real resources"`)
2. **Disco de los repos consumidores** — la lista de 16 repos sale de `docs/research/inventario-consumidores.md` (rama `research/inventario-consumidores`), re-derivada de `~/.claude/plugins/installed_plugins.json`. Sobre cada `projectPath`: `ls -la .sandcastle/`, `ls -la .sandcastle/probes/`, `stat -f %m` de cada archivo, `cat .sandcastle/resources.json`, `git log -- .sandcastle/probes .sandcastle/resources.json`.
3. **Briefs reales** — para los 12 repos consumidores con remote GitHub:
   - `gh issue list -R <repo> --state all --limit 1000 --json number,title,body,createdAt`
   - `gh api "repos/<repo>/issues/comments?per_page=100" --paginate` (los briefs de `/agent-brief` se publican como comentario; los de `/to-issues` >= 2.3.0 van inline en el body — se escanearon ambos)
   - Clasificación con un script Python sobre el corpus descargado: brief = body/comentario con encabezado `## Agent Brief` (regex `^#{1,4}\s*Agent Brief`); dentro de cada brief se aísla la sección `**Real resources:**` hasta el siguiente encabezado `**X:**` y se clasifica en (a) **degradada** si matchea `unverified…run /sandcastle-probe-resources`, (b) **anclada** si cita `.sandcastle/probes` en positivo, (c) **otra verificación** en cualquier otro caso.
4. **Incidentes de mismatch** — regex sobre bodies y comentarios de las 447 issues descargadas: `schema mismatch|no existe la columna|column .* does not exist|Invalid column name|relation .* does not exist|columna inexistente|tabla inexistente`, más `git log --since=2026-05-17 | grep -iE "schema|column|mismatch"` en los dos repos con más superficie de BD.

Corpus efectivamente analizado: **447 issues** y **814 comentarios** en 12 repos → **379 briefs** con `## Agent Brief`.

Repos **no verificables** por esta vía y excluidos explícitamente del conteo de briefs: `SC/sistemas/portal` (remote GitLab institucional, sin acceso `gh`), `SC/lab/portal-compras-explorer`, `leopoldo/home_lab`, `SC/saltacompra-aprende` (path muerto) — los cuatro sin remote GitHub. Ninguno de ellos tiene `.sandcastle/` en disco, así que no aportan probes.

---

## Evidencia 1 — Cuántos repos tienen probes, y qué tan viejos son

| Repo | `.sandcastle/` | `probes/` | Archivos `.schema` | Tamaño | Última corrida | Antigüedad al 2026-08-03 |
|---|---|---|---|---|---|---|
| `SC/servicios/saltacompra-bridge` | sí | **sí** | `stand-by-sql.schema`, `catalogo-psql.schema` | 82.001 B (1.690 líneas) + 3.648 B (62 líneas) | 2026-05-22 19:41 | **72 días** |
| `webs/terra-santa` | sí | **sí** | `convex-db.schema` | 1.139 B (40 líneas) | 2026-05-21 21:11 | **73 días** |
| `FB/fb-ingenieria-next` | sí | **sí** | **ninguno** (solo `.mandatory-resources`, 11 B) | — | 2026-05-21 17:55 | 73 días |
| `SC/…/App.SaltaCompra` | sí | no | — | — | — | — |
| `apps/pliego` | sí | no | — | — | — | — |
| Otros 11 repos del inventario | no | no | — | — | — | — |

Lecturas duras:

- **3 de 16 repos** (19%) tienen `.sandcastle/probes/`. **2 de 16** (12,5%) tienen al menos un archivo `.schema`.
- **1 de 16 repos** (6%) tiene un `.schema` que describe un recurso externo real: `saltacompra-bridge` (SQL Server stand-by + PostgreSQL de catálogo).
- El `.schema` de `terra-santa` **no es una sonda**: su `schema_introspect` en `.sandcastle/resources.json` es literalmente `if [ -f convex/schema.ts ]; then cat convex/schema.ts; ...` — copia un archivo versionado del propio repo. Aporte informativo sobre leer el archivo directo: **cero**.
- `fb-ingenieria-next` declara un recurso (`convex-dev`) **sin** `schema_introspect`, así que su directorio `probes/` nunca contuvo un schema. Directorio de valor cero, pero pagado.
- **Ninguna sonda se re-corrió nunca después del bootstrap.** Los mtimes son de mayo; el `git log -- .sandcastle/resources.json` muestra 3 commits de mantenimiento en el único repo serio (`a54ee20` 2026-05-20, `62154d1` 2026-05-20, `abb99cd` 2026-05-22, `8b4616b` 2026-05-26) y **ninguno** después del 26 de mayo. `saltacompra-bridge` acumuló **29 commits** posteriores a la última corrida de la sonda.

## Evidencia 2 — Cuántos briefs reales usaron el anchoring

379 briefs, 2026-05-04 → 2026-07-31. Clasificación de la sección `**Real resources:**`:

| Repo | Briefs | Sin sección RR | Con sección RR | Degradados (`run /sandcastle-probe-resources`) | **Anclados a un `.schema`** | Verificados por otra vía | `(unverified — closest match: X)` |
|---|---:|---:|---:|---:|---:|---:|---:|
| `sspc-salta/saltacompra-app` | 207 | 20 | 187 | 124 | 0 | 63 | 0 |
| `Cuenta-Norte/sopa-saas` | 39 | 0 | 39 | 39 | 0 | 0 | 0 |
| `Cuenta-Norte/pliego` | 36 | 36 | 0 | 0 | 0 | 0 | 0 |
| `LeopoldoBini/fb-ingenieria-next` | 27 | 11 | 16 | 16 | 0 | 0 | 0 |
| `sspc-salta/saltacompra-bridge` | 26 | 11 | 15 | 0 | **9** | 6 | 0 |
| `LeopoldoBini/mutantes-gym` | 15 | 0 | 15 | 15 | 0 | 0 | 0 |
| `sspc-salta/aprende-saltacompra` | 8 | 0 | 8 | 8 | 0 | 0 | 0 |
| `LeopoldoBini/terra-santa` | 8 | 0 | 8 | 0 | 0 | 8 | 0 |
| `LeopoldoBini/video-to-knowledge` | 7 | 0 | 7 | 7 | 0 | 0 | 0 |
| `sspc-salta/saltacompra-auth` | 6 | 0 | 6 | 6 | 0 | 0 | 0 |
| `sspc-salta/saltacompra-pagos` | 0 | — | — | — | — | — | — |
| `LeopoldoBini/voice-recorder` | 0 | — | — | — | — | — | — |
| **TOTAL** | **379** | **78** | **301** | **215** | **9** | **77** | **0** |

Los tres números que deciden:

1. **9 de 379 briefs (2,4%)** citan por nombre un archivo `.sandcastle/probes/<name>.schema` como fuente de verificación. Los 9 viven en **un solo repo**: `saltacompra-bridge`, issues **#23, #31, #33, #45, #46, #47, #48, #56, #58**. (Otros 6 briefs del mismo repo — #32, #34, #35, #36, #57, #59 — abren la sección con "verified." y listan columnas y cardinalidades reales sin citar el path; salieron del mismo cache pero no lo nombran, así que quedan contados como "otra vía".)
2. **215 de 301 secciones `**Real resources:**` (71%)** llevan el degradado canónico `(unverified — run /sandcastle-probe-resources to enable verification)`. Sumando los degradados en prosa libre (`sin .sandcastle/probes/ cacheados — símbolos verificados por lectura directa de origin/prd/prd-0019`, en `saltacompra-app` #443-#446, #450, #472-#476, #544, #545; `sin probes en .sandcastle/probes/` en `terra-santa` #2, #3, #6), la degradación real supera el **76%**.
3. **0 de 379 briefs** emitieron `(unverified — closest match: X; please confirm)`. Ese es el paso 4 del algoritmo de `agent-brief/SKILL.md:51` — el mecanismo que se supone *atrapa* una referencia falsa y ofrece la real. **Nunca se disparó, ni una vez, en tres meses.**

Nota de atribución sobre la columna "verificados por otra vía": la sección `**Real resources:**` sigue siendo útil sin sonda. `saltacompra-app` #443-#446 verifican símbolos "por lectura directa de `origin/prd/prd-0019`"; `saltacompra-bridge` #45-#48 verifican en vivo lo que el cache no cubre; `terra-santa` #7 lista los archivos markdown reales del repo. **77 briefs (26% de los que tienen sección) se anclaron a la realidad sin ninguna sonda.** El hábito de listar recursos concretos y declarar cómo se verificaron es lo que aporta; el archivo `.schema` es solo una de las formas de verificar, y la menos usada.

## Evidencia 3 — ¿Hay un caso rastreable de brief que apuntó a algo inexistente ANTES del anchoring y no después?

Sí, uno, y es el caso fuerte a favor. Timeline reconstruida de fuentes primarias:

| Fecha | Hecho | Fuente |
|---|---|---|
| 2026-05-13 | Se publican los briefs del Bundle 1 de `saltacompra-bridge` (issues #2-#8). Ninguno tiene sección `**Real resources:**` — el anchoring todavía no existía | 7 comentarios de brief, corpus `gh` |
| 2026-05-15 20:46 | Issue **#17**: `/ofertas` devuelve **HTTP 500** contra el stand-by real por **9 mismatches de schema** en `OfertasEndpoints.cs`, todos shippeados a `main` en los PRs #2, #4, #5 del Bundle 1. Cita textual: *"Los tests xUnit no lo agarraron porque son contra mocks; ninguno toca DB real"*. Entre los 9: `ADM.Proveedor` **no existe** (la canónica es `RPP.Proveedor`), `o.FormaPago` / `o.FormaEntrega` / `o.PlazoMantenimiento` / `o.GarantiaProducto` no existen, `o.Observaciones` es en realidad `OFE.Oferta.Observacion` (singular) | `gh issue view 17 -R sspc-salta/saltacompra-bridge` |
| 2026-05-15 | La issue #9 (deploy a prod) queda **bloqueada** por #17 | comentario en #9 |
| 2026-05-17 11:41 | `fix(ofertas): resolver schema mismatches contra stand-by real (#17) (#18)` | `git log` de `saltacompra-bridge` |
| 2026-05-17 16:47 | Commit **`54df852` "feat: cross-plugin reality anchoring for AFK briefs"** en este marketplace — nace el anchoring | `git log -- plugins/engineering-workflow/skills/agent-brief/SKILL.md` |
| 2026-05-18 15:12 | `216c807` bump del índice: `engineering-workflow → 2.3.0` + `sandcastle-max → 0.8.0` | `git log` |
| 2026-05-20 12:07 | `62154d1 chore(sandcastle): cachear schema EVA + pre-adj + pliego/oferta para briefs Bundle 2` — primer cache real de la flota | `git log` de `saltacompra-bridge` |
| 2026-05-20 → 2026-07-31 | Bundles 2, 3 y las waves de julio: 15 briefs con sección RR, 9 anclados al cache. **Cero issues nuevas de schema mismatch en toda la flota** | corpus `gh` |

El barrido de mismatches sobre las **447 issues + 814 comentarios** de los 12 repos devuelve **un único incidente**: la issue #17, del 2026-05-15, **dos días antes** de que existiera el anchoring, en el mismo repo que después fue el único usuario real de la sonda. En los 78 días posteriores, con 379 briefs publicados, **cero**.

**Pero la atribución es débil, y hay que decirlo.** El cache que existe hoy en `saltacompra-bridge` **no habría atrapado el bug de #17**: su `schema_introspect` filtra por una lista fija de esquemas (`EVA`, `ADJ`, `OFE`, `PLI`, `PC`, `PRO` + `dbo` con patrones `LIKE`) y el archivo cacheado contiene **0 líneas de `RPP.`** y **0 líneas de `ADM.`** — exactamente los dos esquemas de los mismatches #1, #2 y #9 de la issue. Verificado: `grep -c '^RPP\.' stand-by-sql.schema` → 0; `grep -c '^ADM\.' stand-by-sql.schema` → 0. Los briefs de julio (#45, #46) lo admiten en su propio texto: *"no cubiertos por el cache de probes — el cache solo incluye los esquemas PLI, OFE, EVA, ADJ y PC; verificados en vivo contra el stand-by productivo el 2026-07-30"*.

Lo que sí cambió después de #17 y es demostrable: **el equipo dejó de escribir briefs sin nombrar los recursos.** De los 26 briefs de `saltacompra-bridge`, los 11 sin sección RR son todos anteriores al 2026-05-20; los 15 posteriores la tienen. Y el brief #31 usa el cache como **contrato explícito** para el agente: *"si el shape real no coincide con las columnas listadas en la sección Real resources, BLOQUEAR con `<block-reason>SCHEMA_MISMATCH</block-reason>`. El cache fue verificado al momento de escribir este brief; si re-probó, alguien rompió algo."* Ese es el mecanismo que efectivamente funcionó — y no es el matcher del anchoring, es la disciplina de escribir el shape esperado en el brief.

También cuenta como valor real detectado por la sonda, y verificable en el texto de los briefs de `saltacompra-bridge` del 2026-05-21:

- #32: *"`UccProveedorGlobal` (**0 filas** — deprecada o sin populate): mismo shape, ignorar"* — el probe evitó que una wave implementara contra una tabla vacía.
- #33: *"los usuarios SaltaCompra del proveedor **NO** viven en `catalogoPSQL.Usuarios` (esa tabla tiene 1 sola fila y no tiene DNI)"* — refutación de una suposición del PRD antes de despachar.
- #35: *"`mv_sync_status` (1 fila — fila única global, no por proveedor)"* — cardinalidad real que cambiaba el diseño del slice.

Tres hallazgos accionables en una sola wave. Ese es el techo demostrado del mecanismo: **3 correcciones de diseño y 9 briefs anclados, en un repo, en tres meses.**

## Evidencia 4 — ¿Alguien aguas abajo consume el resultado?

- **`host-orchestrator` (el motor vivo, v4.1.0) no lee `.sandcastle/probes/` en ningún punto.** `grep -rn "sandcastle" plugins/host-orchestrator/` → **0 resultados**. `grep -rn "probes"` → **0**. Lo único emparentado es un principio textual en `plugins/host-orchestrator/agents/parallel-implementer.md:62` ("Real resources, not mocks (when reachable)") que no referencia ningún archivo de cache.
- Barrido sobre los **11 directorios `.host-orchestrator/`** vivos en disco (audit logs, `pipelines/`, `waves/`, `wt/`, `pilots/`): **0 archivos** mencionan `probes` o `Real resources`. Ninguna corrida del pipeline registró jamás una lectura del cache.
- El consumidor de Level 3 (`sandcastle-dispatch-wave.md:340`, el diff de schema dentro del container) **murió con el sustrato Docker**. El propio `CLAUDE.md` global lo declara: *"el host es el único sustrato: sandcastle/docker no existen"*. Es decir: **el fallback que el diseño prometía ya no existe**. La frase que sigue apareciendo en 215 briefs — *"el Level 3 probe del dispatcher lo va a atrapar en run-time"* — es hoy **falsa**: no hay dispatcher, no hay container, no hay Level 3.
- El único consumidor vivo del cache es la skill `agent-brief` de `engineering-workflow`, es decir: **el modelo leyendo un archivo de texto**. No hay ninguna verificación programática en ninguna parte del stack.

## Costo de mantenimiento del ciclo

Medido, no estimado:

| Concepto | Medición |
|---|---|
| Comandos a correr por repo para habilitarlo | `/sandcastle-init` (scaffold) → editar `resources.json` a mano (los `schema_introspect` son one-liners SQL de 500-1.500 caracteres con parsing de connection string embebido) → `/sandcastle-probe-resources` |
| Commits de mantenimiento del ciclo en el único repo que lo usó en serio | **4** (`a54ee20`, `62154d1`, `abb99cd`, `8b4616b`), todos entre 2026-05-20 y 2026-05-26 |
| Costo de contexto por brief anclado | `stand-by-sql.schema` = 82.001 bytes ≈ **20.500 tokens** que el brief-writer tiene que cargar y grepear por cada slice. El `catalogo-psql.schema` suma ~900 tokens más |
| Frecuencia de invalidación del cache | `App.SaltaCompra` acumuló **17 commits de migración DDL/DML** entre 2026-05-17 y 2026-08-03 (0022, 0023, 0024, 0027, 0028, 0030…) ≈ una invalidación cada **4-5 días** en el repo con más briefs de la flota (207) |
| Re-corridas efectivamente realizadas tras esas migraciones | **0** en toda la flota. Ninguna sonda se re-corrió después del bootstrap |
| Deuda de directorio | 3 repos con `.sandcastle/probes/` en disco; 2 de ellos (`fb-ingenieria-next`, `terra-santa`) con contenido de valor nulo. Además `.sandcastle/` completo y huérfano en 3 repos donde `sandcastle-max` ni siquiera está instalado (`fb-ingenieria-next`, `App.SaltaCompra`, `saltacompra-bridge`), según el inventario de la issue #4 |
| Costo del degradado | 215 briefs arrastran una instrucción `(unverified — run /sandcastle-probe-resources…)` que apunta a un comando de un plugin que en 13 de 16 repos **no está instalado**, y que promete un fallback de Level 3 **que ya no existe** |

El costo del cache no es correr la sonda (es barato y host-only, ~segundos). El costo es **el mantenimiento de la verdad**: un cache que nadie re-corre es peor que no tener cache, porque el brief dice "verificado" sobre un archivo de 72 días de antigüedad. `saltacompra-bridge` es el ejemplo: los briefs del 2026-07-30 citan `stand-by-sql.schema` como autoridad mientras el archivo tenía 69 días y el propio brief tuvo que salir a verificar en vivo lo que el cache no cubría.

---

## Veredicto: **MATAR** la sonda. **RESCATAR** la sección, no el mecanismo.

`/sandcastle-probe-resources` no se rescata al plugin-pegamento nuevo. Muere con `sandcastle-max`.

Justificación, en evidencia:

1. **Adopción real: 2,4%.** 9 briefs anclados de 379, en 1 repo de 16. Un mecanismo con 12,5% de penetración de repos y 2,4% de penetración de briefs no paga su superficie conceptual (un comando, un formato de archivo, un directorio por repo, una cláusula en dos skills de otro plugin y un párrafo de degradado en cada brief de la flota).
2. **El detector nunca detectó.** 0 de 379 briefs emitieron `(unverified — closest match: X)`. El paso del algoritmo que justifica el nombre "anchoring" — cotejar una referencia contra el schema y proponer la real — **no se ejecutó nunca**. Lo que sí funcionó fue que un humano/agente leyera el dump y escribiera columnas reales en el brief; eso no requiere un comando ni un formato de cache.
3. **El fallback prometido ya no existe.** Los 215 briefs degradados dicen que el Level 3 del dispatcher atrapará el mismatch en run-time. El dispatcher, el container y el Level 3 murieron con el sustrato Docker. La red de seguridad documentada es hoy una mentira en 215 issues.
4. **Nadie aguas abajo lo consume.** `host-orchestrator` v4 tiene 0 referencias a probes; los 11 `.host-orchestrator/` en disco tienen 0 menciones. El acoplamiento cruzado paga integración con un consumidor que no existe.
5. **El cache no cubrió el único incidente real.** El bug de la issue #17 vivía en `RPP.*` y `ADM.*`; el cache de `saltacompra-bridge` tiene 0 líneas de ambos esquemas. Rescatar la sonda no habría prevenido el caso que se usa para justificarla.
6. **La invalidación gana a la re-corrida por goleada.** 17 migraciones de schema en el repo más activo vs. 0 re-corridas de sonda en toda la flota. Un cache que nadie refresca degrada de "anclaje" a "afirmación falsa con timestamp".

### Lo que sí se rescata (y no cuesta nada rescatarlo)

La sección `**Real resources:**` **ya vive en `engineering-workflow`** (`skills/agent-brief/SKILL.md` + `skills/to-issues/SKILL.md`), no en `sandcastle-max`. Matar la sonda no la toca. Y es la parte que rindió: **77 briefs (26% de los que la tienen) se anclaron a la realidad sin ninguna sonda** — leyendo el schema Drizzle del repo (`saltacompra-app` #545), la rama del PRD (`#443-#446`), o consultando la BD en vivo (`saltacompra-bridge` #45-#48 el 2026-07-30). Los tres hallazgos de diseño más valiosos (tabla con 0 filas, tabla singleton, tabla sin la columna que el PRD asumía) los produjo **mirar el recurso**, no el formato del archivo donde quedó el dump.

### Condiciones de la muerte (lo que hay que hacer, no solo lo que hay que borrar)

1. **Reescribir el degradado en `agent-brief/SKILL.md:52` y `to-issues/SKILL.md:74`.** Sacar toda mención a `.sandcastle/probes/`, a `/sandcastle-probe-resources` y al "Level 3 probe del dispatcher" (que ya no existe). Reemplazar por la regla que la evidencia respalda: *toda referencia concreta a tabla/columna/endpoint/topic/key va en `**Real resources:**` junto con **cómo se verificó** (archivo del repo + `file:line`, query en vivo con fecha, o rama/PRD leído) y con fecha; si no se pudo verificar, marcarla `(sin verificar — confirmar al implementar)` y decir contra qué habría que verificarla.* Esa es exactamente la forma que los 77 briefs útiles ya usan de hecho.
2. **No crear `.probes/` neutral en el plugin-pegamento.** El directorio no es el problema del naming: es que el archivo se pudre. Si en algún momento reaparece la necesidad, la forma correcta es una verificación **en el momento del brief** (una query, un `grep` al schema versionado) con la fecha estampada en el brief, no un cache persistente que hay que re-correr.
3. **Preservar `.sandcastle/probes/stand-by-sql.schema` de `saltacompra-bridge` antes de cualquier limpieza** — es el único artefacto con valor residual (1.690 columnas del stand-by productivo). Moverlo a `docs/` de ese repo como snapshot fechado, o descartarlo conscientemente. Lo que **no** hay que hacer es dejarlo donde está fingiendo ser un cache vivo de 72 días.
4. **Barrer los `.sandcastle/` huérfanos** (`fb-ingenieria-next`, `terra-santa`, `pliego`, `App.SaltaCompra`, `saltacompra-bridge`), revisando antes los `.env` con secretos: `fb-ingenieria-next/.sandcastle/.env` y `saltacompra-bridge/.sandcastle/.env` están en `600` (este último con credenciales del stand-by productivo), y **`terra-santa/.sandcastle/.env` está en `644` — legible por cualquier usuario del sistema**. Migrar a Vaultwarden antes de borrar. Coincide con la recomendación de la issue #4.
5. **Si aparece un repo que reclame la sonda de nuevo**, la señal a mirar no es "¿tiene BD externa?" sino **"¿alguien va a re-correr la sonda después de cada migración?"**. La respuesta medida en tres meses de flota fue: no, ninguna vez. Sin esa disciplina, el anchoring no es un ancla — es un lastre con timestamp.

---

## Datos no verificables

- **Briefs en `SC/sistemas/portal`**: remote GitLab institucional (`gitlab-next.salta.gob.ar`), sin acceso vía `gh`. No verificable si tiene briefs; sí verificable que **no** tiene `.sandcastle/` ni `.host-orchestrator/` en disco, con lo cual no aporta probes.
- **Cuántas veces un agente AFK leyó efectivamente un `.schema` durante su corrida**: los `.host-orchestrator/` no registran lecturas de archivo, y los logs de `.sandcastle/logs/` de mayo no se parsearon línea por línea. Lo que sí es verificable es que 9 briefs citan el cache por nombre.
- **Cuántos mismatches fueron atrapados en run-time por el Level 3 del container antes de que muriera Docker**: los `wave-reports/` de mayo existen en disco pero no se auditaron en esta corrida; el barrido de issues no encontró ninguna issue de mismatch posterior al 2026-05-15, que es la señal que importa para la decisión.
