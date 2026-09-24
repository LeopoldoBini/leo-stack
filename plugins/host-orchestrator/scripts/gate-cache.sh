#!/usr/bin/env bash
#
# gate-cache.sh — corre el hook de validación del repo con caché por árbol de git.
#
# El mismo árbol se medía hasta 3 veces por wave (gate de la issue, gate del PR
# sin cambios, baseline de la wave siguiente) y cada corrida del hook puede
# costar minutos (autopsia cn-radar-al-dia-0921, 2026-09-21). El resultado de
# medir depende del contenido del árbol, no del commit ni del worktree: la clave
# es `HEAD^{tree}` + los argumentos, y la caché vive en el git-common-dir, así
# que la comparten todos los worktrees del repo.
#
#   uso: gate-cache.sh <hook> [args...]      (desde adentro del repo a medir)
#
# Cachea solo si el worktree está limpio (`git status --porcelain` vacío: con
# cambios sin commitear el árbol no describe lo que se mide) y si la salida
# trae status "ok" (una medición fallida se reintenta, nunca se recuerda).
# stdout es la salida del hook tal cual; hit/miss va a stderr.
#
#   HO_GATE_CACHE_TTL   segundos de vida de una entrada (default 21600 = 6 h)
#   HO_GATE_CACHE=off   apaga la caché: corre el hook directo

set -uo pipefail

if [ $# -lt 1 ]; then
  echo "uso: gate-cache.sh <hook> [args...]" >&2
  exit 2
fi

avisar() { echo "gate-cache: $*" >&2; }

if [ "${HO_GATE_CACHE:-}" = off ]; then
  avisar "apagada (HO_GATE_CACHE=off)"
  exec "$@"
fi

ARBOL="$(git rev-parse 'HEAD^{tree}' 2>/dev/null)" || {
  avisar "miss — fuera de un repo git o sin HEAD, corre sin caché"
  exec "$@"
}
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  avisar "miss — worktree sucio, corre sin caché"
  exec "$@"
fi

TTL="${HO_GATE_CACHE_TTL:-21600}"
DIR="$(git rev-parse --path-format=absolute --git-common-dir)/host-orchestrator/gate-cache"
mkdir -p "$DIR" || exec "$@"
CLAVE="$(printf '%s\n' "$ARBOL" "$@" | git hash-object --stdin)"
ENTRADA="$DIR/$CLAVE"
AHORA="$(date +%s)"

# Formato de la entrada: primera línea "<epoch> <exit code>", después la salida.
if [ -f "$ENTRADA" ]; then
  read -r CUANDO RC < "$ENTRADA"
  case "$CUANDO$RC" in *[!0-9]*|'') CUANDO=0 ;; esac   # entrada ilegible = vencida
  if [ $((AHORA - CUANDO)) -lt "$TTL" ]; then
    avisar "hit — árbol ${ARBOL:0:12}, medido hace $((AHORA - CUANDO)) s"
    tail -n +2 "$ENTRADA"
    exit "$RC"
  fi
  avisar "miss — entrada vencida (TTL ${TTL} s)"
else
  avisar "miss — árbol ${ARBOL:0:12} sin medir"
fi

SALIDA="$(mktemp "$DIR/.tmp.XXXXXX")"
trap 'rm -f "$SALIDA" "$SALIDA.e"' EXIT
"$@" > "$SALIDA"
RC=$?
cat "$SALIDA"

if grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' "$SALIDA"; then
  { echo "$AHORA $RC"; cat "$SALIDA"; } > "$SALIDA.e" && mv "$SALIDA.e" "$ENTRADA"
else
  avisar "no cachea — la salida no trae status ok"
fi
exit "$RC"
