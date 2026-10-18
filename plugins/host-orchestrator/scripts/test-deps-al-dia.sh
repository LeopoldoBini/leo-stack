#!/usr/bin/env bash
#
# test-deps-al-dia.sh — ejercita deps-al-dia.sh contra un repo git de juguete.
#
# Los package managers son falsos: scripts en el PATH que anotan desde qué
# carpeta y con qué argumentos los llamaron. Una instalación es una línea nueva
# en ese registro; "no se tocó nada" es que el registro no crezca.
#
#   uso: scripts/test-deps-al-dia.sh

set -uo pipefail

AQUI="$(cd "$(dirname "$0")" && pwd)"
DEPS="$AQUI/deps-al-dia.sh"

FALLOS=0
paso()  { printf '  ✓ %s\n' "$1"; }
fallo() { printf '  ✗ %s\n' "$1"; FALLOS=$((FALLOS + 1)); }
afirma() { local d="$1"; shift; if "$@"; then paso "$d"; else fallo "$d — NO"; fi; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
REPO="$TMP/repo"
BIN="$TMP/bin"
export REGISTRO="$TMP/instalaciones"
: > "$REGISTRO"

mkdir -p "$BIN"
# bun queda afuera a propósito: es el manager "no instalado en esta máquina".
for m in npm pnpm yarn; do
  cat > "$BIN/$m" <<EOF
#!/usr/bin/env bash
[ -f "\${FALLA_MANAGER:-/nada}" ] && { echo "$m: error simulado" >&2; exit 1; }
echo "$m \$PWD \$*" >> "\$REGISTRO"
mkdir -p node_modules
EOF
  chmod +x "$BIN/$m"
done
PATH="$BIN:/usr/bin:/bin"
export PATH

instalaciones() { wc -l < "$REGISTRO" | tr -d ' '; }
correr() { bash "$DEPS" "$REPO" > "$TMP/salida" 2>&1; }

mkdir -p "$REPO/web" "$REPO/mixto" "$REPO/test/fixtures/viejo" "$REPO/tools/bunapp"
for d in . web mixto tools/bunapp; do echo '{}' > "$REPO/$d/package.json"; done
echo '{"v":1}' > "$REPO/package-lock.json"
echo 'lockfileVersion: 9' > "$REPO/web/pnpm-lock.yaml"
echo '{}' > "$REPO/mixto/package-lock.json"
echo 'x' > "$REPO/mixto/yarn.lock"
echo 'x' > "$REPO/test/fixtures/viejo/yarn.lock"
echo 'x' > "$REPO/tools/bunapp/bun.lock"
echo 'sin trackear' > "$REPO/suelto.lock"
printf 'node_modules/\n' > "$REPO/.gitignore"
git -C "$REPO" init -q
git -C "$REPO" add -A
git -C "$REPO" -c user.email=t@t -c user.name=t commit -qm base

printf 'test-deps-al-dia\n\nprimera corrida: sin marca, instala\n'
correr; rc=$?
afirma 'sale 0'                                      [ "$rc" -eq 0 ]
afirma 'npm ci en la raíz'                           grep -qxF "npm $REPO ci --no-audit --no-fund" "$REGISTRO"
afirma 'pnpm congelado en web/'                      grep -qxF "pnpm $REPO/web install --frozen-lockfile" "$REGISTRO"
afirma 'la carpeta con dos managers no se toca'      sh -c "! grep -q mixto '$REGISTRO'"
afirma '…y se reporta como ambigua'                  grep -q 'mixto/ ambiguo' "$TMP/salida"
afirma 'el lockfile de una fixture no se instala'    grep -q 'test/fixtures/viejo/ sin package.json' "$TMP/salida"
afirma 'un manager ausente se reporta y no falla'    grep -q 'tools/bunapp/ bun no está instalado' "$TMP/salida"
afirma 'deja la marca con el hash del lockfile'      grep -q "^npm $(git -C "$REPO" hash-object package-lock.json)" "$REPO/node_modules/.ho-lockfile"

printf '\nsegunda corrida: nada cambió\n'
antes="$(instalaciones)"
correr
afirma 'no reinstala'                                [ "$(instalaciones)" -eq "$antes" ]
afirma 'dice que está al día'                        grep -q '^deps-al-dia: ./ al día (npm)' "$TMP/salida"

printf '\nel lockfile cambia (un merge lo trajo)\n'
echo '{"v":2}' > "$REPO/package-lock.json"
antes="$(instalaciones)"
correr
afirma 'reinstala solo la raíz'                      [ "$(instalaciones)" -eq $((antes + 1)) ]
afirma 'la marca sigue al lockfile nuevo'            grep -q "^npm $(git -C "$REPO" hash-object package-lock.json)" "$REPO/node_modules/.ho-lockfile"

printf '\nla instalación falla\n'
echo '{"v":3}' > "$REPO/package-lock.json"
touch "$TMP/falla"
FALLA_MANAGER="$TMP/falla" bash "$DEPS" "$REPO" > "$TMP/salida" 2>&1; rc=$?
afirma 'sale 1'                                      [ "$rc" -eq 1 ]
afirma 'nombra la carpeta y el manager'              grep -q 'FALLÓ la instalación (npm)' "$TMP/salida"
afirma 'no deja marca: la próxima reintenta'         sh -c "! grep -q \"\$(git -C '$REPO' hash-object package-lock.json)\" '$REPO/node_modules/.ho-lockfile'"
rm -f "$TMP/falla"
antes="$(instalaciones)"
correr
afirma 'y la próxima corrida reintenta'              [ "$(instalaciones)" -eq $((antes + 1)) ]

printf '\nfuera de un repo git\n'
bash "$DEPS" "$TMP/bin" > "$TMP/salida" 2>&1; rc=$?
afirma 'sale 2'                                      [ "$rc" -eq 2 ]

printf '\n──────────\n'
if [ "$FALLOS" -eq 0 ]; then
  printf 'test-deps-al-dia: todo en verde.\n'; exit 0
fi
printf 'test-deps-al-dia: %s comprobación(es) fallida(s).\n' "$FALLOS"; exit 1
