---
name: probar
description: Prueba un PR, una issue o un módulo usando la app de verdad en un navegador, con el agente tester. Devuelve criterio por criterio visto-andar / visto-fallar / no-pude-probar, con captura.
disable-model-invocation: true
---

# /probar

```
/probar <PR#|issue#|módulo> [--romper]
```

Armás el encargo, se lo das al agente `host-orchestrator:tester` y le devolvés a Leo lo que vio. Vos no probás nada: el valor del tester es que el veredicto sale de alguien que no escribió el código ni armó el encargo con una conclusión en mente.

## 1. La receta

Leé el bloque `probador` de `.host-orchestrator/config.json` en la raíz del repo (contrato: `docs/SPEC-v4-workflow-engine.md` §3.10b del plugin).

Sin archivo o sin bloque: no despachás. Le contestás a Leo que este repo todavía no tiene receta de arranque y que sin ella el tester no puede levantar la app sin adivinar contra qué se conecta.

**Cierra cuando:** tenés el bloque `probador` entero, o le contestaste a Leo que falta.

## 2. Qué probar

Según el argumento:

- **Número** → `gh pr view <N> --json number,title,body,headRefOid,closingIssuesReferences`. Si no es un PR, `gh issue view <N> --json number,title,body`.
  - **PR**: los criterios son los de aceptación de las issues que cierra; si no cierra ninguna, los que promete el cuerpo del PR.
  - **Issue**: los criterios de aceptación de su cuerpo.
  - Sin una lista explícita, escribila vos desde el texto: cada criterio es algo que un usuario hace en pantalla y lo que tiene que ver después. Lo que no se ve en pantalla (un log, una tabla, un job) no entra; anotalo como fuera de alcance.
  - Modo `criterios`.
- **Palabra** (`checkout`, `panel`, `tienda`…) → modo `recorrido` sobre ese módulo.
- **`--romper`** → modo `romper`, acotado a lo anterior.

**Cierra cuando:** tenés el modo y, en `criterios`, una lista numerada donde cada ítem nombra una acción y su resultado visible.

## 3. El checkout

El tester levanta la app desde una copia aparte, nunca desde la carpeta de Leo: la receta puede pisar archivos de entorno locales.

```bash
corrida="$(basename "$(git rev-parse --show-toplevel)")-$(date +%m%d-%H%M)"
git fetch origin
git worktree add --detach "/tmp/probador-$corrida" <commit>
```

`<commit>`: el `headRefOid` del PR (`git fetch origin pull/<N>/head` antes); para issue o módulo, `origin/<base_branch>` del config, o la rama default del remoto.

**Cierra cuando:** el worktree existe en el commit correcto (`git -C /tmp/probador-$corrida rev-parse HEAD`).

## 4. Despachar

Un solo `Agent`, `subagent_type: "host-orchestrator:tester"`, con este encargo:

```
checkout: /tmp/probador-<corrida>
corrida: <corrida>
modo: criterios | recorrido | romper
receta: <el bloque probador, tal cual>
criterios: <la lista numerada>      (o el módulo, en recorrido/romper)
```

Pasale los criterios como el usuario los viviría, sin pistas de dónde está el código ni de cuál creés que es el resultado.

**Cierra cuando:** volvió el informe del tester, con su sección **Resultado**.

## 5. Limpiar

```bash
git worktree remove --force "/tmp/probador-<corrida>"
```

Las capturas no viven en el worktree: quedan en `~/.cache/probador/<corrida>/`.

**Cierra cuando:** `git worktree list` ya no muestra el worktree.

## 6. El parte para Leo

Leo no lee código. En español, corto, en este orden:

1. Si algo dio `visto-fallar`, eso primero, en una línea por criterio, con lo que se vio.
2. La tabla del tester: `criterio | estado | captura`, con los paths absolutos.
3. Los `no-pude-probar`, con el motivo en palabras de todos los días (no levantó, faltó login, faltan datos).
4. Lo que el tester anotó fuera de los criterios, si hay.

Copiá los estados del tester tal cual. Si su informe y una captura no coinciden, decilo; no lo corrijas.
