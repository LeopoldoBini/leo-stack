#!/usr/bin/env bash
#
# check-estandar.sh — gate de las reglas duras del estándar de calidad de autor
# (leo-stack #9 §2, extendido por #10 §7). Corre sobre `plugins/**` de cualquiera
# de los tres marketplaces; el allowlist vive junto al script, en el repo que se
# audita, así que cada marketplace declara sus propias excepciones.
#
#   uso: scripts/check-estandar.sh [--repo <dir>] [-v] [-h]
#
# Sale 0 si no hay violaciones, 1 si las hay, 2 si no encuentra qué auditar.
#
# Reglas verificadas — las cinco duras de #9 más la octava de #10:
#
#   R1  description ≤ 40 palabras            skills, comandos, agentes, plugin.json
#   R2  disable-model-invocation: true       skills, comandos (agentes exentos)
#   R3  cero sediment                        todo .md del plugin
#   R4  techo de cuerpo: 140 líneas          skills, comandos, README (agentes y docs exentos)
#   R5  single source of truth               todo .md del plugin + índice vs plugin.json
#   R8  allowlist explícita de tools         agentes
#
# Las reglas 6 (completion criterion por step) y 7 (prompt the positive) son de
# juicio y no se automatizan: viven como checklist de revisión en el CLAUDE.md
# del marketplace.
#
# Dos límites declarados, para que nadie lea un verde como más de lo que es:
#   - el sediment se busca en los .md; las cadenas del motor (`workflows/*.js`)
#     las verifica el runtime, no este script;
#   - los flags (`--dry-run`, `--max-waves`) no tienen índice contra el cual
#     contrastarlos, así que quedan a la revisión humana.

set -uo pipefail

MAX_PALABRAS_DESC=40
MAX_LINEAS_CUERPO=140
MIN_LINEAS_DUP=5

VERBOSE=0
REPO=""

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:-}"; shift 2 ;;
    -v|--verbose) VERBOSE=1; shift ;;
    -h|--help) sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'argumento desconocido: %s (probá -h)\n' "$1" >&2; exit 2 ;;
  esac
done

if [ -z "$REPO" ]; then
  REPO="$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null || pwd)"
fi
REPO="${REPO%/}"

[ -d "$REPO/plugins" ] || { printf 'no hay %s/plugins — nada que auditar\n' "$REPO" >&2; exit 2; }

ALLOWLIST="$REPO/scripts/estandar-allowlist.txt"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

VIOLACIONES=0
ARCHIVO_ACTUAL=""

# ---------------------------------------------------------------- reporte ----

# falla <archivo> <regla> <mensaje>
falla() {
  if [ "$ARCHIVO_ACTUAL" != "$1" ]; then
    ARCHIVO_ACTUAL="$1"
    printf '\n%s\n' "${1#$REPO/}"
  fi
  printf '  ✗ %-3s %s\n' "$2" "$3"
  VIOLACIONES=$((VIOLACIONES + 1))
}

# ok <archivo> <regla> <mensaje> — solo en modo verbose
ok() {
  [ "$VERBOSE" -eq 1 ] || return 0
  if [ "$ARCHIVO_ACTUAL" != "$1" ]; then
    ARCHIVO_ACTUAL="$1"
    printf '\n%s\n' "${1#$REPO/}"
  fi
  printf '  ✓ %-3s %s\n' "$2" "$3"
}

# ------------------------------------------------------------- allowlist ----

# seccion_allowlist <nombre> — imprime los ítems de una sección
seccion_allowlist() {
  [ -f "$ALLOWLIST" ] || return 0
  awk -v s="[$1]" '
    $0 == s { dentro=1; next }
    /^\[/    { dentro=0 }
    dentro   { sub(/#.*/, ""); gsub(/^[[:space:]]+|[[:space:]]+$/, ""); if (length($0)) print }
  ' "$ALLOWLIST"
}

seccion_allowlist externos  | sort -u > "$TMP/externos"
seccion_allowlist retirados | sort -u > "$TMP/retirados"
seccion_allowlist paths     | sort -u > "$TMP/paths"

# ------------------------------------------------------- inventario del repo --

find "$REPO/plugins" -name '*.md' -type f | sort > "$TMP/md"
find "$REPO/plugins" -name plugin.json -type f | sort > "$TMP/plugin-json"

# Universo de comandos vivos: los .md de commands/ de todos los plugins del repo,
# con y sin namespace. Ese es "el índice" contra el que #9 manda contrastar.
: > "$TMP/comandos"
while IFS= read -r f; do
  case "$f" in
    */commands/*)
      base="$(basename "$f" .md)"
      plugin="$(printf '%s' "$f" | sed -E 's#.*/plugins/([^/]+)/commands/.*#\1#')"
      printf '%s\n%s:%s\n' "$base" "$plugin" "$base" >> "$TMP/comandos"
      ;;
  esac
done < "$TMP/md"
sort -u -o "$TMP/comandos" "$TMP/comandos"

# ------------------------------------------------------------- utilidades ----

# clase <archivo> → comando | agente | skill | portada | doc
clase() {
  case "$1" in
    */commands/*.md)  printf 'comando' ;;
    */agents/*.md)    printf 'agente' ;;
    */SKILL.md)       printf 'skill' ;;
    */README.md)      printf 'portada' ;;
    *)                printf 'doc' ;;
  esac
}

# es_acta <archivo> — un archivo cuyo punto ES hablar de lo que murió
es_acta() {
  case "$1" in
    */docs/*|*/CHANGELOG.md|*/DEFUNCIONES.md) return 0 ;;
    *) return 1 ;;
  esac
}

# fm_valor <archivo> <clave> — valor del frontmatter, con líneas de continuación
fm_valor() {
  awk -v k="$2" '
    NR == 1 && $0 == "---" { fm = 1; next }
    fm && $0 == "---" { exit }
    fm && index($0, k ":") == 1 { cap = 1; sub("^" k ":[[:space:]]*", ""); if (length($0)) print; next }
    fm && cap && /^[[:space:]]+[^[:space:]]/ { sub(/^[[:space:]]+/, ""); print; next }
    fm && cap { exit }
  ' "$1"
}

# tiene_frontmatter <archivo>
tiene_frontmatter() { [ "$(head -1 "$1")" = "---" ]; }

# cuerpo <archivo> — el archivo sin su frontmatter
cuerpo() {
  awk 'NR == 1 && $0 == "---" { fm = 1; next }
       fm && $0 == "---" { fm = 0; visto = 1; next }
       !fm { print }' "$1"
}

# sin_actas <archivo> — blanquea lo marcado como acta, preservando la numeración
# de líneas. Dos formas: `<!-- acta -->` al final de una línea con contenido marca
# esa línea sola; solo en su renglón, abre una región que cierra `<!-- /acta -->`.
sin_actas() {
  awk '
    /<!--[[:space:]]*\/acta[[:space:]]*-->/ { dentro = 0; print ""; next }
    /<!--[[:space:]]*acta[[:space:]]*-->[[:space:]]*$/ {
      solo = $0
      sub(/<!--[[:space:]]*acta[[:space:]]*-->[[:space:]]*$/, "", solo)
      gsub(/[[:space:]]/, "", solo)
      if (length(solo) == 0) dentro = 1
      print ""; next
    }
    { if (dentro) print ""; else print }' "$1"
}

# en_lista <item> <archivo-lista> — match exacto o por glob
en_lista() {
  while IFS= read -r patron; do
    case "$1" in $patron) return 0 ;; esac
  done < "$2"
  return 1
}

# ================================================================ R1, R2, R4, R8 --

while IFS= read -r f; do
  c="$(clase "$f")"

  # --- R1: description ≤ 40 palabras -----------------------------------------
  case "$c" in
    comando|agente|skill)
      if tiene_frontmatter "$f"; then
        desc="$(fm_valor "$f" description)"
        if [ -z "$desc" ]; then
          falla "$f" R1 "sin description en el frontmatter"
        else
          n=$(printf '%s' "$desc" | wc -w | tr -d ' ')
          if [ "$n" -gt "$MAX_PALABRAS_DESC" ]; then
            falla "$f" R1 "description de $n palabras (máx $MAX_PALABRAS_DESC)"
          else
            ok "$f" R1 "description de $n palabras"
          fi
        fi
      else
        falla "$f" R1 "sin frontmatter — una pieza $c lo necesita"
      fi
      ;;
  esac

  # --- R2: disable-model-invocation por defecto ------------------------------
  case "$c" in
    comando|skill)
      flag="$(fm_valor "$f" disable-model-invocation | tr -d ' ')"
      if [ "$flag" = "true" ]; then
        ok "$f" R2 "disable-model-invocation: true"
      elif grep -qiE '^[[:space:]]*(<!--[[:space:]]*)?model-invocable:' "$f"; then
        ok "$f" R2 "model-invocable con justificación declarada"
      else
        falla "$f" R2 "falta disable-model-invocation: true (o una línea 'model-invocable: <razón>' que lo justifique)"
      fi
      ;;
  esac

  # --- R4: techo de cuerpo ---------------------------------------------------
  case "$c" in
    comando|skill|portada)
      n=$(cuerpo "$f" | wc -l | tr -d ' ')
      if [ "$n" -gt "$MAX_LINEAS_CUERPO" ]; then
        falla "$f" R4 "cuerpo de $n líneas (techo $MAX_LINEAS_CUERPO) — lo que excede baja por la escalera a docs/"
      else
        ok "$f" R4 "cuerpo de $n líneas"
      fi
      ;;
  esac

  # --- R8: allowlist explícita de tools --------------------------------------
  # Nace de la ley de costo por turno de un subagente: cada tool no usada paga
  # system prompt en cada turno. Por eso NO aplica a skills ni comandos (#20),
  # que corren en la sesión principal y no ahorran un token declarándola.
  if [ "$c" = agente ]; then
    tools="$(fm_valor "$f" tools | tr -d ' ')"
    if [ -n "$tools" ]; then
      ok "$f" R8 "tools: $tools"
    else
      falla "$f" R8 "sin allowlist de tools en el frontmatter — un agente sin declararla hereda la superficie completa"
    fi
  fi
done < "$TMP/md"

# ====================================================== R1 sobre plugin.json --

while IFS= read -r pj; do
  desc="$(jq -r '.description // ""' "$pj" 2>/dev/null)"
  if [ -z "$desc" ]; then
    falla "$pj" R1 "sin description"
  else
    n=$(printf '%s' "$desc" | wc -w | tr -d ' ')
    if [ "$n" -gt "$MAX_PALABRAS_DESC" ]; then
      falla "$pj" R1 "description de $n palabras (máx $MAX_PALABRAS_DESC)"
    else
      ok "$pj" R1 "description de $n palabras"
    fi
  fi
done < "$TMP/plugin-json"

# ==================================================================== R3 -----
# Sediment: toda referencia a un comando o path que no existe. Dos filtros que
# el grep ingenuo no tiene y costaron un ticket cada uno: los cierres de tag XML
# (`</promise>`) y las rutas absolutas (`/dev/null`) no son comandos (#23), y un
# acta menciona muertos porque ese es su trabajo (#21).

while IFS= read -r f; do
  acta=0; es_acta "$f" && acta=1
  sin_actas "$f" > "$TMP/limpio"

  # --- comandos ---
  # Una invocación se escribe al principio de la línea o después de un espacio,
  # backtick, comilla o paréntesis. Exigirlo (en vez de excluir caso por caso)
  # descarta de un saque los cierres de tag XML (`</promise>`), los fragmentos de
  # ruta (`wf_*/agent-*.jsonl`) y los patrones de rama (`<slug>/issue-<N>`).
  awk '{
    resto = $0
    off = 0
    while (match(resto, /\/[a-z][a-z0-9-]+(:[a-z][a-z0-9-]+)?/)) {
      abs = off + RSTART
      pre = (abs == 1) ? "" : substr($0, abs - 1, 1)
      tok = substr(resto, RSTART + 1, RLENGTH - 1)
      post = substr(resto, RSTART + RLENGTH, 1)
      off += RSTART + RLENGTH - 1
      resto = substr(resto, RSTART + RLENGTH)
      if (abs != 1 && pre !~ /[[:space:]("'"'"'`\[]/) continue
      if (post == "/") continue                 # /dev/null y amigos: es un path
      if (tok ~ /-$/) continue                  # fragmento, no nombre
      if (length(tok) < 3) continue
      print NR "\t" tok
    }
  }' "$TMP/limpio" 2>/dev/null \
  | while IFS="$(printf '\t')" read -r ln cmd; do
      corto="${cmd##*:}"

      if grep -qxF "$cmd" "$TMP/comandos" || grep -qxF "$corto" "$TMP/comandos"; then
        continue
      fi
      if grep -qxF "$corto" "$TMP/externos"; then
        continue
      fi
      if grep -qxF "$corto" "$TMP/retirados"; then
        [ "$acta" -eq 1 ] && continue
        printf '%s\t%s\t%s\n' "$f" "$ln" "RETIRADO /$cmd" >> "$TMP/sediment"
        continue
      fi
      printf '%s\t%s\t%s\n' "$f" "$ln" "DESCONOCIDO /$cmd" >> "$TMP/sediment"
    done

  # --- paths ---
  # Solo sobre los archivos que describen al plugin. El prompt de un agente
  # habla del repo consumidor por diseño (`src/foo/bar.ts`, `app/CLAUDE.md`),
  # así que ahí un path que no resuelve acá es lo esperado, no sediment.
  case "$(clase "$f")" in agente) continue ;; esac

  grep -noE '(^|[^A-Za-z0-9_./-])[A-Za-z0-9_.][A-Za-z0-9_./-]*\.(md|js|json|sh|py|ts|yml|yaml)\b' "$TMP/limpio" 2>/dev/null \
  | while IFS= read -r hit; do
      ln="${hit%%:*}"
      p="$(printf '%s' "${hit#*:}" | sed -E 's#^[^A-Za-z0-9_.]##')"
      case "$p" in
        *://*|*github.com*|*.*.*.*) continue ;;    # URLs y globs de tres puntos
      esac
      en_lista "$p" "$TMP/paths" && continue
      plugin_root="$(printf '%s' "$f" | sed -E 's#(.*/plugins/[^/]+)/.*#\1#')"
      [ -e "$plugin_root/$p" ] && continue
      [ -e "$REPO/$p" ] && continue
      [ -e "$(dirname "$f")/$p" ] && continue
      # Referencia por nombre suelto: vale si el archivo existe en algún lado
      # del repo. `merge-resolver.md` nombra una pieza real aunque no diga dónde.
      case "$p" in
        */*) : ;;
        *) [ -n "$(find "$REPO" -name "$p" -not -path '*/.git/*' -print -quit)" ] && continue ;;
      esac
      printf '%s\t%s\t%s\n' "$f" "$ln" "PATH $p" >> "$TMP/sediment"
    done
done < "$TMP/md"

if [ -f "$TMP/sediment" ]; then
  sort -u -t"$(printf '\t')" -k1,1 -k3,3 "$TMP/sediment" | sort -t"$(printf '\t')" -k1,1 -k2,2n > "$TMP/sediment-orden"
  while IFS="$(printf '\t')" read -r f ln msg; do
    falla "$f" R3 "línea $ln — $msg"
  done < "$TMP/sediment-orden"
fi

# ==================================================================== R5 -----
# Single source of truth. Dos formas: bloques de prosa idénticos entre dos
# archivos, y el drift clásico entre plugin.json y el índice que lo pinnea.

: > "$TMP/ventanas"
while IFS= read -r f; do
  awk -v F="$f" -v N="$MIN_LINEAS_DUP" '
    {
      l = $0
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", l)
      gsub(/[[:space:]]+/, " ", l)
      if (length(l) < 40) next
      n++; buf[n] = l; num[n] = NR
      if (n >= N) {
        s = buf[n - N + 1]
        for (i = n - N + 2; i <= n; i++) s = s " ¶ " buf[i]
        if (length(s) >= 250) print s "\t" F "\t" num[n - N + 1]
      }
    }' "$f" >> "$TMP/ventanas"
done < "$TMP/md"

sort "$TMP/ventanas" \
| awk -F'\t' '{ if ($1 == prev && $2 != prevf) print prevf "\t" prevl "\t" $2 "\t" $3; prev = $1; prevf = $2; prevl = $3 }' \
| awk -F'\t' '!visto[$1 "|" $3]++' > "$TMP/dups"

while IFS="$(printf '\t')" read -r f1 l1 f2 l2; do
  [ -n "${f1:-}" ] || continue
  falla "$f1" R5 "$MIN_LINEAS_DUP+ líneas idénticas a ${f2#$REPO/}:$l2 (desde la línea $l1)"
done < "$TMP/dups"

INDICE="$REPO/.claude-plugin/marketplace.json"
if [ -f "$INDICE" ]; then
  while IFS= read -r pj; do
    nombre="$(jq -r '.name // ""' "$pj")"
    [ -n "$nombre" ] || continue
    ver_p="$(jq -r '.version // ""' "$pj")"
    desc_p="$(jq -r '.description // ""' "$pj")"
    ver_i="$(jq -r --arg n "$nombre" '.plugins[] | select(.name == $n) | .version // ""' "$INDICE")"
    desc_i="$(jq -r --arg n "$nombre" '.plugins[] | select(.name == $n) | .description // ""' "$INDICE")"
    if [ -z "$ver_i" ]; then
      falla "$INDICE" R5 "$nombre no está en el índice — un plugin sin entrada no se instala"
    else
      [ "$ver_p" = "$ver_i" ] || falla "$INDICE" R5 "$nombre: versión $ver_i en el índice contra $ver_p en plugin.json — el índice pinnea, así que gana el desactualizado"
      [ "$desc_p" = "$desc_i" ] || falla "$INDICE" R5 "$nombre: la description del índice difiere de la de plugin.json"
    fi
  done < "$TMP/plugin-json"
fi

# =================================================================== cierre --

piezas=$(wc -l < "$TMP/md" | tr -d ' ')
printf '\n──────────\n'
if [ "$VIOLACIONES" -eq 0 ]; then
  printf 'check-estandar: %s archivos auditados en %s — sin violaciones.\n' "$piezas" "${REPO##*/}"
  printf 'Las reglas 6 y 7 (completion criterion, prompt the positive) son de revisión: ver CLAUDE.md.\n'
  exit 0
fi
printf 'check-estandar: %s violación(es) en %s archivos auditados.\n' "$VIOLACIONES" "$piezas"
printf 'Excepciones conscientes se declaran en scripts/estandar-allowlist.txt o con <!-- acta --> … <!-- /acta -->.\n'
exit 1
