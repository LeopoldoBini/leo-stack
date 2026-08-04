---
name: init
description: Siembra en este repo el contrato de operación del pipeline AFK — bloque idempotente en `CLAUDE.md` (regla HITL + puntero `cc-afk`) y `.host-orchestrator/config.json`. Usage `/host-orchestrator:init`. Una vez por repo, al adoptar el plugin.
disable-model-invocation: true
---

# /host-orchestrator:init

Onboarding de un repo al pipeline AFK. Siembra **dos** artefactos —el bloque de operación en `CLAUDE.md` y el contrato `.host-orchestrator/config.json`— y deja el resto del repo intacto. Volver a correrlo refresca el bloque en su lugar.

Lo que el bloque le enseña a las sesiones futuras es una sola cosa que ningún cómputo puede suplir: **quién baja los slices HITL a `ready-for-human`**. El pipeline despacha solo lo que lleva `ready-for-agent`, así que ese filtro se ejerce al aprobar el breakdown o no se ejerce nunca.

## 1 — Ubicar la raíz y leer el estado

```bash
git rev-parse --show-toplevel          # raíz; sin git, usar el cwd y avisarlo
git remote show origin | sed -n 's/.*HEAD branch: //p'   # default branch
ls scripts/wave-validate.sh .host-orchestrator/config.json 2>/dev/null
```

Leé `CLAUDE.md` con la herramienta `Read` si existe. Anotá cuál de los tres casos aplica: **sin archivo**, **con marcadores** (`<!-- host-orchestrator:start -->`), **sin marcadores**.

**Cierra cuando:** tenés la ruta absoluta de `CLAUDE.md`, el default branch y los tres estados anotados.

## 2 — Sembrar el bloque en `CLAUDE.md`

Usá `Write` para un archivo nuevo y `Edit` para los otros dos casos — las herramientas de archivo dejan rastro auditable, que es lo que un sembrado idempotente necesita.

- **Sin archivo** → crealo con el bloque como único contenido.
- **Con marcadores** → reemplazá todo entre `<!-- host-orchestrator:start -->` y `<!-- host-orchestrator:end -->`, inclusive. El resto del archivo no se toca.
- **Sin marcadores** → apendeá el bloque al final, separado por una línea en blanco.

Si además aparece un bloque `<!-- engineering-workflow:pipeline:start -->` … `:end -->`, **borralo entero**: ese plugin se retiró y su bloque promete siete comandos que ya no existen (ver `DEFUNCIONES.md` del marketplace `leo-stack`). Decile a Leo que lo removiste.

El bloque, verbatim entre los marcadores:

````markdown
<!-- host-orchestrator:start -->
## Pipeline AFK (host-orchestrator)

Este repo se opera con `cc-afk '<scope>' [+Nk]` — el launcher de `/host-orchestrator:prd-pipeline`. El scope es una lista de issues, un `milestone:` o un `label:`; el orden de waves y las dependencias viven en los **bodies de las issues**, nunca en el comando.

**Al aprobar el breakdown de `/to-tickets`, clasificá cada slice.** Los que necesiten a un humano —decisión de producto, credencial o acceso que hay que gestionar, juicio visual, cambio irreversible— bajan a `ready-for-human`. El pipeline despacha solo lo que lleva `ready-for-agent`, y ese es el único momento en que alguien mira los slices de a uno: lo que pase de largo acá se despacha solo.

**Contrato de este repo:** `.host-orchestrator/config.json` — base branch, hook de validación, y los overrides de modelo/tier/effort que el repo quiera apartar de los defaults del motor.

### Refrescar
`/host-orchestrator:init` reemplaza lo que hay entre los marcadores y deja el resto del archivo como está.
<!-- host-orchestrator:end -->
````

**Cierra cuando:** `CLAUDE.md` contiene el bloque exactamente una vez, entre marcadores, y el contenido previo del archivo sigue ahí.

## 3 — Sembrar `.host-orchestrator/config.json`

Con el archivo ya presente, dejalo como está y pasá al paso 4 — el contrato del repo es de Leo, no del comando.

Si no existe, creá el directorio y escribí **solo lo que constataste en el paso 1**:

```json
{
  "base_branch": "<el default branch del remoto>",
  "validate_hook": "scripts/wave-validate.sh"
}
```

- `validate_hook` va únicamente si el script existe. Sin hook, el motor mide con su autodetect.
- **Los defaults del motor no se copian acá** (`model_map`, `role_tiers`, `role_efforts`, `labels`, `test_globs`, `applier_chunk`, `deny_paths`): congelar en cada repo un valor que el motor ya provee es la misma verdad en dos lugares, y el día que el default cambie estos archivos lo pisan en silencio. Cada clave se agrega cuando el repo quiere **apartarse** del default. El menú completo y qué significa cada clave: `docs/SPEC-v4-workflow-engine.md` §3.10.
- `base_branch` sí se pinnea aunque hoy coincida con el default del remoto: que la base del pipeline cambie porque alguien movió el default branch de GitHub es la clase de sorpresa que este archivo existe para evitar.

**Cierra cuando:** el archivo existe, parsea como JSON (`python3 -m json.tool`) y sus rutas apuntan a archivos reales.

## 4 — Reportar

Dos o tres líneas para Leo: cuál de los tres caminos tomó `CLAUDE.md` (creado / refrescado / apendeado) con su ruta absoluta, si sembró o respetó el config, y si removió un bloque de `engineering-workflow`. Cerrá con el comando de la primera corrida: `cc-afk 'label:ready-for-agent'`.

**Cierra cuando:** Leo sabe qué archivos cambiaron y cuál es el paso siguiente.

## Qué NO siembra

- **El bloque de pipeline de `engineering-workflow`** — existía en 3 de 15 repos y los 3 estaban podridos. El orden canónico de trabajo lo publica `mattpocock-skills` con `/setup-matt-pocock-skills` (tracker, labels, domain docs); acá solo vive lo que el pipeline AFK agrega encima.
- **`CONTEXT.md`** — lo crea `mattpocock-skills:domain-modeling`, que ya es su dueño.
- **Labels, milestones ni issues** — los crea Leo; este comando escribe dos archivos y nada remoto.
- **`scripts/wave-validate.sh`** — el hook de validación es del repo: qué mide y cómo lo mide no lo puede adivinar el plugin. Contrato de salida (`--json`): spec §3.3.
