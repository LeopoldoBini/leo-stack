#!/bin/sh
#
# pipeline-read.sh — el lado de LECTURA del pipeline AFK v4 (leo-stack #10 §5).
#
#   uso: pipeline-read.sh scope  <tipo:valor> --rama <rama> [opciones]
#        pipeline-read.sh check  <tipo:valor> [opciones]
#        pipeline-read.sh intent <n> [opciones]
#
# POSIX sh usando SOLO `gh` — su `--jq` incorporado evita la dependencia de un jq
# externo, y `gh auth status` ya era precondición dura del pipeline.
#
# LECTURA, NO ESCRITURA. La asimetría es deliberada: en lectura el determinismo
# es gratis y el peor caso de un bug es una respuesta equivocada que el gate
# atrapa aguas abajo; en escritura, romper estado remoto no lo atrapa nadie. Toda
# mutación sigue siendo del serializador del motor (spec §3.2).
#
# Acá vive la ÚNICA implementación de la tabla de bucketing. El motor la consume
# por transporte (spec §3.4b): si la tabla viviera también en el JS, las dos
# copias divergirían sin que nadie se entere.
#
# Modo fixture (para el test): con HO_FIXTURE_DIR apuntando a un directorio, cada
# consulta devuelve el archivo homónimo en vez de llamar a `gh`. Límite declarado:
# las fixtures guardan la salida YA FILTRADA por `--jq`, así que el test ejercita
# la tabla de decisión —que es lo que puede divergir— y no las expresiones jq.
#
# Sale 0 si todo bien, 1 si `check` encuentra una precondición rota, 2 si el uso
# es inválido o falta una entrada.

set -u

SUB=""
ARG=""
SLUG=""
RAMA=""
DIR="."
LABEL_READY="ready-for-agent"
LABEL_AGENT_PR="afk-agent-pr"

# ------------------------------------------------------------------- uso ----

uso() {
  sed -n '3,10p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-2}"
}

muere() { printf 'pipeline-read: %s\n' "$1" >&2; exit "${2:-2}"; }

[ $# -ge 1 ] || uso 2
SUB="$1"; shift
case "$SUB" in
  -h|--help) uso 0 ;;
  scope|check|intent) ;;
  *) muere "subcomando desconocido: $SUB (probá -h)" ;;
esac

if [ $# -ge 1 ]; then
  case "$1" in -*) ;; *) ARG="$1"; shift ;; esac
fi

while [ $# -gt 0 ]; do
  case "$1" in
    --repo-slug) SLUG="${2:-}"; shift 2 ;;
    --rama)      RAMA="${2:-}"; shift 2 ;;
    --dir)       DIR="${2:-}";  shift 2 ;;
    --label-ready)    LABEL_READY="${2:-}";    shift 2 ;;
    --label-agent-pr) LABEL_AGENT_PR="${2:-}"; shift 2 ;;
    -h|--help)   uso 0 ;;
    *) muere "argumento desconocido: $1" ;;
  esac
done

[ -n "$ARG" ] || muere "$SUB necesita un argumento (probá -h)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# -------------------------------------------------------------- consulta ----

# consulta <fixture> <argv de gh...> — en modo fixture devuelve el archivo
# homónimo (vacío si no existe) y no toca la red.
#
# El candado de solo-lectura es estructural y no documental: `gh api` conmuta a
# POST en cuanto ve un `-f`, y el mismo endpoint que LEE las sub-issues, con
# POST, AGREGA una. Por eso toda consulta a la API lleva `--method GET` y acá se
# verifica que nadie lo haya olvidado. Y un `gh` que falla frena la corrida: una
# respuesta de error parseada como TSV produce buckets inventados, que es
# exactamente el modo de falla que este CLI existe para eliminar.
consulta() {
  nombre="$1"; shift
  if [ -n "${HO_FIXTURE_DIR:-}" ]; then
    [ -f "$HO_FIXTURE_DIR/$nombre" ] && cat "$HO_FIXTURE_DIR/$nombre"
    return 0
  fi
  case " $* " in
    *" api "*)
      case " $* " in
        *" --method GET "*) ;;
        *) muere "consulta a la API sin --method GET (sería escritura): $*" 3 ;;
      esac ;;
  esac
  # </dev/null obligatorio: `gh` lee stdin, y varias consultas corren dentro de
  # un `while read` — sin esto la primera se come la lista y el loop hace una
  # sola vuelta (una lista explícita de 6 issues devolvía 1).
  salida="$(gh "$@" </dev/null 2>&1)" || muere "gh falló en \"$nombre\": $(printf '%s' "$salida" | tr '\n' ' ' | cut -c1-200)"
  [ -n "$salida" ] && printf '%s\n' "$salida"
  return 0
}

if [ -z "$SLUG" ]; then
  if [ -n "${HO_FIXTURE_DIR:-}" ]; then
    SLUG="fixture/repo"
  else
    SLUG="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null)"
    [ -n "$SLUG" ] || muere "no pude resolver el repo (pasá --repo-slug <owner/repo>)"
  fi
fi

# Campos por issue, en orden: número, estado, labels, bloqueantes ABIERTOS
# (entero de GitHub, no prosa), total de sub-issues, número del padre, título,
# body aplanado. El body solo lo mira `check`; una sola consulta evita que dos
# lugares definan qué es "el issue".
CAMPOS_ISSUE='[ (.number|tostring), .state, ([.labels[].name]|join(",")),
  ((.issue_dependencies_summary.blocked_by // 0)|tostring),
  ((.sub_issues_summary.total // 0)|tostring),
  ((.parent_issue_url // "")|split("/")|last),
  ((.title // "")|gsub("[\t\n\r]";" ")),
  ((.body // "")|gsub("[\t\r]";" ")|gsub("\n";"\\n")) ] | @tsv'

CAMPOS_PR='[ (.number|tostring), .state, ((.merged_at != null)|tostring),
  .head.ref, ([.labels[].name]|join(",")),
  ((.body // "")|[scan("(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#([0-9]+)";"i")]|flatten|join(",")) ] | @tsv'

# ---------------------------------------------------------------- issues ----

# traer_issues <tipo:valor> → TSV en $TMP/issues
traer_issues() {
  tipo="${1%%:*}"
  valor="${1#*:}"
  : > "$TMP/issues"
  case "$tipo" in
    milestone)
      hito="$(consulta milestones api --method GET "repos/$SLUG/milestones" -f state=all -f per_page=100 \
                --jq '.[] | [(.number|tostring), .title] | @tsv' \
              | awk -F'\t' -v t="$valor" '$2 == t { print $1; exit }')"
      [ -n "$hito" ] || muere "milestone \"$valor\" no existe en $SLUG"
      consulta issues api --method GET "repos/$SLUG/issues" -f state=all -f per_page=100 -f milestone="$hito" \
        --paginate --jq ".[] | select(has(\"pull_request\")|not) | $CAMPOS_ISSUE" > "$TMP/issues"
      ;;
    label)
      consulta issues api --method GET "repos/$SLUG/issues" -f state=all -f per_page=100 -f labels="$valor" \
        --paginate --jq ".[] | select(has(\"pull_request\")|not) | $CAMPOS_ISSUE" > "$TMP/issues"
      ;;
    parent)
      padre="$(printf '%s' "$valor" | tr -d '#')"
      consulta issues api --method GET "repos/$SLUG/issues/$padre/sub_issues" -f per_page=100 \
        --paginate --jq ".[] | $CAMPOS_ISSUE" > "$TMP/issues"
      ;;
    *)
      # Lista explícita: "#42,#43" o "42,43". El scope llega literal del comando.
      # El \n final no es cosmético: sin él, `read` descarta el último número.
      printf '%s\n' "$1" | tr -d '# ' | tr ',' '\n' | while IFS= read -r n; do
        [ -n "$n" ] || continue
        consulta "issue-$n" api --method GET "repos/$SLUG/issues/$n" --jq "$CAMPOS_ISSUE"
      done > "$TMP/issues"
      ;;
  esac
}

# traer_prs — PRs que apuntan a la rama integradora, con su estado de merge
traer_prs() {
  : > "$TMP/prs"
  : > "$TMP/prestado"
  [ -n "$RAMA" ] || return 0
  consulta prs api --method GET "repos/$SLUG/pulls" -f state=all -f per_page=100 -f base="$RAMA" \
    --paginate --jq ".[] | $CAMPOS_PR" > "$TMP/prs"

  # mergeable y checks solo de los PRs ABIERTOS: son pocos (≤ max_parallel) y es
  # lo único que la lista de PRs no trae ya computado.
  awk -F'\t' '$2 == "open" { print $1 }' "$TMP/prs" | while IFS= read -r p; do
    est="$(consulta "pr-$p" pr view "$p" --repo "$SLUG" --json mergeable,statusCheckRollup \
             --jq '[ (.mergeable // "UNKNOWN"),
                     ([.statusCheckRollup[]? | select(.conclusion == "FAILURE" or .conclusion == "TIMED_OUT" or .conclusion == "CANCELLED" or .state == "FAILURE" or .state == "ERROR")] | length | tostring) ] | @tsv')"
    [ -n "$est" ] && printf '%s\t%s\n' "$p" "$est"
  done > "$TMP/prestado"
}

# ------------------------------------------------------------ JSON en awk ----

# Programa awk compartido: bucketea y emite el JSON del scope. Lee, en orden,
# prs · prestado · issues.
AWK_JSON='
function jesc(s,   r) {
  r = s
  gsub(/\\/, "\\\\", r); gsub(/"/, "\\\"", r)
  gsub(/\t/, " ", r);    gsub(/\r/, "", r)
  return r
}
function tiene(csv, l,   i, a, n) {
  n = split(csv, a, ",")
  for (i = 1; i <= n; i++) if (a[i] == l) return 1
  return 0
}
function tiene_prefijo(csv, p,   i, a, n) {
  n = split(csv, a, ",")
  for (i = 1; i <= n; i++) if (index(a[i], p) == 1) return 1
  return 0
}
'

# --------------------------------------------------------------- cmd_scope --

cmd_scope() {
  [ -n "$RAMA" ] || muere "scope necesita --rama <rama integradora>"
  traer_issues "$ARG"
  traer_prs

  # Lista de bloqueantes por issue: solo para las que el grafo marca bloqueadas.
  : > "$TMP/deps"
  awk -F'\t' '$4 + 0 > 0 { print $1 }' "$TMP/issues" | while IFS= read -r n; do
    # Solo los ABIERTOS: el endpoint lista todos los bloqueantes históricos, pero
    # el gate es el contador `blocked_by` del summary, que cuenta solo abiertos.
    # Listar los cerrados haría que el detalle y el array se contradigan.
    b="$(consulta "deps-$n" api --method GET "repos/$SLUG/issues/$n/dependencies/blocked_by" \
           --jq '[.[] | select(.state == "open") | .number] | join(",")')"
    printf '%s\t%s\n' "$n" "$b"
  done > "$TMP/deps"

  awk -F'\t' -v rama="$RAMA" -v lready="$LABEL_READY" -v lpr="$LABEL_AGENT_PR" "$AWK_JSON"'
  FILENAME ~ /prs$/ {
    pn = $1; pestado[pn] = $2; pmerged[pn] = ($3 == "true"); phead[pn] = $4; plabels[pn] = $5
    n = split($6, refs, ",")
    for (i = 1; i <= n; i++) if (refs[i] != "") liga[pn "|" refs[i]] = 1
    if (match($4, /^issue-[0-9]+$/)) liga[pn "|" substr($4, 7)] = 1
    orden[++np] = pn
    next
  }
  FILENAME ~ /prestado$/ { pmergeable[$1] = $2; pfail[$1] = $3 + 0; next }
  FILENAME ~ /deps$/     { deps[$1] = $2; next }
  {
    ni = ++cant
    num[ni] = $1; estado[ni] = $2; labels[ni] = $3
    bloq[ni] = $4 + 0; subtotal[ni] = $5 + 0; padre[ni] = $6; titulo[ni] = $7
    if ($6 != "") esPadre[$6] = 1
  }
  END {
    for (i = 1; i <= cant; i++) {
      n = num[i]
      prMerged = 0; prAbierto = 0; prNum = ""; prBranch = ""; prLabels = ""
      for (j = 1; j <= np; j++) {
        p = orden[j]
        if (!(p "|" n in liga)) continue
        if (pmerged[p]) { prMerged = 1; if (prNum == "") { prNum = p; prBranch = phead[p] } }
        else if (pestado[p] == "open") { prAbierto = 1; prNum = p; prBranch = phead[p]; prLabels = plabels[p] }
      }
      rojo = (pmergeable[prNum] == "CONFLICTING") || (pfail[prNum] > 0) || tiene(prLabels, "merge-blocked")

      if (prMerged) {
        b = "DONE"; d = "PR #" prNum " mergeado a " rama
      } else if (subtotal[i] > 0 || (n in esPadre)) {
        b = "SPEC"
        d = "issue padre (" (subtotal[i] > 0 ? subtotal[i] " sub-issues" : "apuntada por otra del scope") \
            ") — es el spec, no un slice: no se despacha"
      } else if (tiene_prefijo(labels[i], "agent-blocked")) {
        b = "HUMAN_GATED"; d = "label agent-blocked"
      } else if (prAbierto && tiene(prLabels, lpr) && !rojo) {
        b = "MERGE_READY"; d = "PR #" prNum " abierto y verde hacia " rama
      } else if (prAbierto) {
        b = "IN_REVIEW"
        d = "PR #" prNum " abierto pero " (tiene(prLabels, "merge-blocked") ? "con label merge-blocked" \
            : (pmergeable[prNum] == "CONFLICTING" ? "en conflicto" \
            : (pfail[prNum] > 0 ? pfail[prNum] " check(s) en rojo" : "sin label " lpr)))
      } else if (bloq[i] > 0) {
        b = "BLOCKED_BY_DEP"; d = bloq[i] " bloqueante(s) abierto(s) en el grafo nativo"
      } else if (tiene(labels[i], lready) || tiene(labels[i], "state/" lready)) {
        b = "IMPLEMENTABLE"; d = "label " lready ", sin PR, sin bloqueantes abiertos"
      } else if (estado[i] == "closed") {
        b = "HUMAN_GATED"; d = "issue cerrada sin PR mergeado hacia " rama " — el pipeline no la toca"
      } else {
        b = "HUMAN_GATED"; d = "sin regla aplicable: sin label " lready " y sin PR"
      }

      bucket[i] = b; detalle[i] = d
      cuenta[b]++
      if (b == "SPEC") specs[n] = 1
      if (padre[i] != "") specs[padre[i]] = 1
      if (b == "MERGE_READY" || b == "IN_REVIEW") { prOut[i] = prNum; brOut[i] = prBranch }
    }

    todo = (cuenta["MERGE_READY"] + cuenta["IMPLEMENTABLE"] + cuenta["IN_REVIEW"] == 0 && cuenta["DONE"] > 0)

    printf "{\n  \"all_done\": %s,\n  \"issues\": [\n", (todo ? "true" : "false")
    for (i = 1; i <= cant; i++) {
      printf "    {\"number\": %s, \"title\": \"%s\", \"bucket\": \"%s\"", num[i], jesc(titulo[i]), bucket[i]
      if (prOut[i] != "") printf ", \"pr_number\": %s, \"pr_branch\": \"%s\"", prOut[i], jesc(brOut[i])
      if (deps[num[i]] != "") printf ", \"blocked_by\": [%s]", deps[num[i]]
      if (padre[i] != "") printf ", \"parent\": %s", padre[i]
      printf ", \"detalle\": \"%s\"}%s\n", jesc(detalle[i]), (i < cant ? "," : "")
    }
    # Orden explícito en las dos salidas agregadas: `for (k in arr)` es
    # inespecificado en awk y un JSON que cambia de orden entre corridas no se
    # puede diffear ni fixturear.
    ns = 0
    for (s in specs) lista[++ns] = s + 0
    for (a = 2; a <= ns; a++) { v = lista[a]; b2 = a - 1
      while (b2 >= 1 && lista[b2] > v) { lista[b2 + 1] = lista[b2]; b2-- }
      lista[b2 + 1] = v }
    printf "  ],\n  \"specs\": ["
    for (a = 1; a <= ns; a++) printf "%s%s", (a > 1 ? ", " : ""), lista[a]
    printf "],\n  \"notas\": \"bucketeado por pipeline-read.sh sobre el grafo nativo de GitHub"
    printf " (%d issues", cant
    nb = split("DONE SPEC MERGE_READY IN_REVIEW BLOCKED_BY_DEP IMPLEMENTABLE HUMAN_GATED", ordenb, " ")
    for (a = 1; a <= nb; a++) if (cuenta[ordenb[a]] > 0) printf ", %s:%d", ordenb[a], cuenta[ordenb[a]]
    printf ")\"\n}\n"
  }
  ' "$TMP/prs" "$TMP/prestado" "$TMP/deps" "$TMP/issues"
}

# --------------------------------------------------------------- cmd_check --

cmd_check() {
  fallas=0

  if [ -z "${HO_FIXTURE_DIR:-}" ]; then
    if gh auth status >/dev/null 2>&1; then
      printf '  ok   gh autenticado\n'
    else
      printf '  FALLA gh no autenticado — corré: gh auth login\n'; fallas=$((fallas + 1))
    fi
  fi

  traer_issues "$ARG"
  total=$(wc -l < "$TMP/issues" | tr -d ' ')
  if [ "$total" -eq 0 ]; then
    printf '  FALLA el scope %s no resuelve a ninguna issue\n' "$ARG"; fallas=$((fallas + 1))
  else
    printf '  ok   scope %s → %s issue(s)\n' "$ARG" "$total"
  fi

  etiquetas="$(consulta labels api --method GET "repos/$SLUG/labels" -f per_page=100 --paginate --jq '.[].name')"
  for l in "$LABEL_READY" "$LABEL_AGENT_PR"; do
    if printf '%s\n' "$etiquetas" | grep -qxF "$l"; then
      printf '  ok   label "%s" existe en %s\n' "$l" "$SLUG"
    else
      printf '  FALLA label "%s" no existe en %s — el scope va a salir vacío\n' "$l" "$SLUG"
      fallas=$((fallas + 1))
    fi
  done

  # Deps en prosa sin edge nativo (#10 §3): el motor no tiene fallback textual,
  # así que un `Blocked by #N` que el grafo no conoce despacharía trabajo
  # bloqueado. Falla ruidoso ANTES de crear ramas, con el remedio en la mano.
  awk -F'\t' '
    $2 == "open" && $4 + 0 == 0 {
      body = $8
      while (match(body, /[Bb]locked[ -][Bb]y:?[ ]*#[0-9]+([ ]*,[ ]*#[0-9]+)*/)) {
        frag = substr(body, RSTART, RLENGTH)
        body = substr(body, RSTART + RLENGTH)
        n = split(frag, partes, /[^0-9]+/)
        for (i = 1; i <= n; i++) if (partes[i] != "") print $1 "\t" partes[i]
      }
    }' "$TMP/issues" | sort -u > "$TMP/prosa"

  if [ -s "$TMP/prosa" ]; then
    n=$(wc -l < "$TMP/prosa" | tr -d ' ')
    printf '  FALLA %s dependencia(s) declarada(s) en prosa sin edge nativo.\n' "$n"
    printf '        El motor lee el grafo, no el body: sin estos edges se despacha trabajo bloqueado.\n'
    printf '        Creálos y volvé a correr el check:\n'
    while IFS="$(printf '\t')" read -r hijo bloqueante; do
      id="$(consulta "id-$bloqueante" api --method GET "repos/$SLUG/issues/$bloqueante" --jq '.id')"
      printf '          gh api --method POST repos/%s/issues/%s/dependencies/blocked_by -F issue_id=%s   # #%s bloqueada por #%s\n' \
        "$SLUG" "$hijo" "${id:-<id-de-#$bloqueante>}" "$hijo" "$bloqueante"
    done < "$TMP/prosa"
    fallas=$((fallas + 1))
  else
    printf '  ok   ninguna dependencia en prosa huérfana del grafo nativo\n'
  fi

  printf '\n'
  if [ "$fallas" -eq 0 ]; then
    printf 'check: precondiciones en verde.\n'; return 0
  fi
  printf 'check: %s precondición(es) rota(s) — NO lances el pipeline.\n' "$fallas"
  return 1
}

# -------------------------------------------------------------- cmd_intent --

# seccion <archivo> <encabezado> — el cuerpo de una sección markdown, aplanado
seccion() {
  awk -v h="$2" '
    tolower($0) ~ "^#+[ ]+" tolower(h) "[ ]*$" { dentro = 1; next }
    dentro && /^#+[ ]+/ { dentro = 0 }
    dentro { gsub(/^[ \t]+|[ \t]+$/, ""); if (length($0)) print }
  ' "$1" | tr '\n' ' ' | sed 's/  */ /g; s/ $//'
}

cmd_intent() {
  n="$(printf '%s' "$ARG" | tr -d '#')"
  consulta "issue-$n" api --method GET "repos/$SLUG/issues/$n" --jq "$CAMPOS_ISSUE" > "$TMP/issue"
  [ -s "$TMP/issue" ] || muere "no pude leer la issue #$n en $SLUG"
  padre="$(cut -f6 "$TMP/issue")"

  printf '{\n'
  if [ -n "$padre" ]; then
    consulta "issue-$padre" api --method GET "repos/$SLUG/issues/$padre" --jq "$CAMPOS_ISSUE" > "$TMP/padre"
    # awk y no sed: `\n` en el reemplazo de sed no es un salto de línea en BSD.
    cut -f8 "$TMP/padre" | awk '{ gsub(/\\n/, "\n"); print }' > "$TMP/padre-body"
    fuera="$(seccion "$TMP/padre-body" 'Out of Scope')"
    testing="$(seccion "$TMP/padre-body" 'Testing Decisions')"
    printf '  "parent": {"n": %s, "title": "%s", "out_of_scope": "%s", "testing_decisions": "%s"},\n' \
      "$padre" \
      "$(cut -f7 "$TMP/padre" | sed 's/\\/\\\\/g; s/"/\\"/g')" \
      "$(printf '%s' "$fuera"   | sed 's/\\/\\\\/g; s/"/\\"/g')" \
      "$(printf '%s' "$testing" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  else
    printf '  "parent": null,\n'
  fi

  # ADRs: índice, no cuerpos — título y path, para que el agente abra el que le sirve.
  printf '  "adrs": ['
  primero=1
  if [ -d "$DIR/docs/adr" ]; then
    for a in "$DIR"/docs/adr/*.md; do
      [ -f "$a" ] || continue
      t="$(sed -n 's/^# \{1,\}//p' "$a" | head -1 | sed 's/\\/\\\\/g; s/"/\\"/g')"
      [ "$primero" -eq 1 ] || printf ', '
      printf '{"title": "%s", "path": "docs/adr/%s"}' "${t:-$(basename "$a" .md)}" "$(basename "$a")"
      primero=0
    done
  fi
  printf '],\n'

  # Puntero al prototipo: /prototype deja la rama en un comentario del issue.
  proto="$( { cut -f8 "$TMP/issue"; consulta "comments-$n" api --method GET "repos/$SLUG/issues/$n/comments" \
                -f per_page=100 --paginate --jq '.[].body'; } \
            | grep -oE 'prototype/[A-Za-z0-9._-]+' | head -1)"
  if [ -n "$proto" ]; then
    printf '  "prototype_branch": "%s"\n' "$proto"
  else
    printf '  "prototype_branch": null\n'
  fi
  printf '}\n'
}

case "$SUB" in
  scope)  cmd_scope ;;
  check)  cmd_check ;;
  intent) cmd_intent ;;
esac
