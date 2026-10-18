#!/usr/bin/env bash
#
# deps-al-dia.sh — deja las dependencias de un checkout iguales a lo que dice su
# lockfile (spec §3.3).
#
# Antes el Setup instalaba solo si faltaba node_modules y el baseline no
# reinstalaba nunca: un merge que cambiaba el lockfile dejaba la integradora
# midiendo con dependencias viejas. Ahora cada carpeta con lockfile trackeado
# guarda, al instalar, una marca con el hash de ese lockfile; si el lockfile
# cambió (o no hay marca), se reinstala congelado con el manager de ese
# lockfile y se renueva la marca. Si no cambió, no se toca nada.
#
#   uso: deps-al-dia.sh [<dir>]          (default: el directorio actual)
#
# Managers: package-lock.json → npm ci · pnpm-lock.yaml → pnpm --frozen-lockfile
# · yarn.lock → yarn --immutable (berry) o --frozen-lockfile (v1) · bun.lock(b)
# → bun --frozen-lockfile.
#
# No se tocan, y se reportan: una carpeta con lockfiles de dos managers (el gate
# ya la marca como lockfiles_ajenos, §3.3), una carpeta sin package.json (el
# lockfile de una fixture de test no es un proyecto a instalar) y una cuyo
# manager no está instalado en esta máquina. Ninguna de las tres puede dar un
# falso verde: si los tests necesitaban esas dependencias, salen rojos.
#
# Una línea por carpeta a stdout. Sale 0 si todo quedó al día o se salteó con
# razón, 1 si una instalación que correspondía falló (sin marca nueva: la próxima
# corrida reintenta), 2 si <dir> no es un repo git.

set -uo pipefail

DIR="${1:-.}"
cd "$DIR" 2>/dev/null || { echo "deps-al-dia: no existe $DIR" >&2; exit 2; }
git rev-parse --show-toplevel >/dev/null 2>&1 || { echo "deps-al-dia: $DIR no es un repo git" >&2; exit 2; }

MARCA=node_modules/.ho-lockfile

manager_de() {
  case "${1##*/}" in
    package-lock.json)  echo npm ;;
    pnpm-lock.yaml)     echo pnpm ;;
    yarn.lock)          echo yarn ;;
    bun.lockb|bun.lock) echo bun ;;
  esac
}

instalar() { # <manager> — desde la carpeta del lockfile
  case "$1" in
    npm)  npm ci --no-audit --no-fund ;;
    pnpm) pnpm install --frozen-lockfile ;;
    yarn) if [ -f .yarnrc.yml ] || [ -f "$(git rev-parse --show-toplevel)/.yarnrc.yml" ]
          then yarn install --immutable
          else yarn install --frozen-lockfile
          fi ;;
    bun)  bun install --frozen-lockfile ;;
  esac
}

LOCKS="$(git ls-files -- '*package-lock.json' '*pnpm-lock.yaml' '*yarn.lock' '*bun.lockb' '*bun.lock')"
if [ -z "$LOCKS" ]; then
  echo "deps-al-dia: sin lockfiles trackeados — nada que instalar"
  exit 0
fi

FALLAS=0
LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

while IFS= read -r carpeta; do
  propios="$(printf '%s\n' "$LOCKS" | awk -v c="$carpeta" '{ d = $0; sub(/[^\/]*$/, "", d); if (d == c) print }')"
  managers="$(while IFS= read -r l; do manager_de "$l"; done <<< "$propios" | sort -u)"
  donde="${carpeta:-./}"
  if [ "$(printf '%s\n' "$managers" | wc -l | tr -d ' ')" -gt 1 ]; then
    echo "deps-al-dia: $donde ambiguo — lockfiles de $(echo "$managers" | tr '\n' ' ')— no se instala"
    continue
  fi
  manager="$managers"
  if [ ! -f "${donde}package.json" ]; then
    echo "deps-al-dia: $donde sin package.json — es un lockfile suelto (¿fixture?), no se instala"
    continue
  fi
  if ! command -v "$manager" >/dev/null 2>&1; then
    echo "deps-al-dia: $donde $manager no está instalado en esta máquina — no se instala"
    continue
  fi
  hash="$(while IFS= read -r l; do git hash-object -- "$l"; done <<< "$propios" | tr '\n' ' ')"
  esperado="$manager $hash"
  if [ -f "$donde$MARCA" ] && [ "$(cat "$donde$MARCA")" = "$esperado" ]; then
    echo "deps-al-dia: $donde al día ($manager)"
    continue
  fi
  if (cd "$donde" && instalar "$manager") > "$LOG" 2>&1; then
    mkdir -p "$donde${MARCA%/*}" && printf '%s' "$esperado" > "$donde$MARCA"
    echo "deps-al-dia: $donde instalado ($manager, el lockfile cambió o no había marca)"
  else
    echo "deps-al-dia: $donde FALLÓ la instalación ($manager): $(tail -5 "$LOG" | tr '\n' ' ' | cut -c1-300)"
    FALLAS=$((FALLAS + 1))
  fi
done <<< "$(printf '%s\n' "$LOCKS" | sed -E 's#[^/]*$##' | sort -u)"

[ "$FALLAS" -eq 0 ]
