#!/usr/bin/env bash
#
# test-gate-cache.sh — ejercita la caché del gate contra un repo git de juguete.
#
# El hook falso cuenta sus corridas en un archivo fuera del repo: un hit es que
# el contador NO suba. Así se prueba la caché por su efecto y no por el mensaje
# que imprime.
#
#   uso: scripts/test-gate-cache.sh

set -uo pipefail

AQUI="$(cd "$(dirname "$0")" && pwd)"
CACHE="$AQUI/gate-cache.sh"

FALLOS=0
paso()  { printf '  ✓ %s\n' "$1"; }
fallo() { printf '  ✗ %s\n' "$1"; FALLOS=$((FALLOS + 1)); }
# afirma <qué se comprueba> <comando...>
afirma() { local d="$1"; shift; if "$@"; then paso "$d"; else fallo "$d — NO"; fi; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
REPO="$TMP/repo"
CUENTA="$TMP/corridas"
ERR="$TMP/stderr"

# El hook emite el status que diga HOOK_STATUS (default ok) y suma una corrida.
mkdir -p "$REPO/scripts"
cat > "$REPO/scripts/hook.sh" <<'EOF'
#!/usr/bin/env bash
echo x >> "$CUENTA"
printf '{"status":"%s","metrics":{"ts_errors":0},"tests":{"failed":0,"failing_test_files":[]}}\n' "${HOOK_STATUS:-ok}"
EOF
chmod +x "$REPO/scripts/hook.sh"
git -C "$REPO" init -q
git -C "$REPO" add -A
git -C "$REPO" -c user.email=t@t -c user.name=t commit -qm base
export CUENTA

corridas() { [ -f "$CUENTA" ] && wc -l < "$CUENTA" | tr -d ' ' || echo 0; }
# medir <dir> — corre el hook a través de la caché; deja stderr en $ERR
medir() { (cd "$1" && bash "$CACHE" scripts/hook.sh --json) 2> "$ERR"; }
# espera_corridas <n> <qué se comprueba>
espera_corridas() {
  if [ "$(corridas)" -eq "$1" ]; then paso "$2"; else fallo "$2 — el hook corrió $(corridas) vez/veces, se esperaba $1"; fi
}

printf 'test-gate-cache\n\nmismo árbol\n'
SAL1="$(medir "$REPO")"
espera_corridas 1 'la primera medición corre el hook'
SAL2="$(medir "$REPO")"
espera_corridas 1 'la segunda sobre el mismo árbol es hit: el hook no corre'
afirma 'el hit devuelve la salida original' [ "$SAL1" = "$SAL2" ]
afirma 'avisa hit por stderr' grep -q 'hit' "$ERR"
case "$SAL2" in *gate-cache*) fallo 'el aviso se coló en stdout' ;; *) paso 'stdout lleva solo la salida del hook' ;; esac

printf '\nargumentos distintos\n'
(cd "$REPO" && bash "$CACHE" scripts/hook.sh --otro) > /dev/null 2>&1
espera_corridas 2 'otros args sobre el mismo árbol son otra clave'

printf '\nárbol distinto\n'
echo cambio > "$REPO/nuevo.txt"
git -C "$REPO" add -A
git -C "$REPO" -c user.email=t@t -c user.name=t commit -qm cambio
medir "$REPO" > /dev/null
espera_corridas 3 'un commit que cambia el árbol es miss'

printf '\nworktree sucio\n'
echo sucio > "$REPO/suelto.txt"
medir "$REPO" > /dev/null
medir "$REPO" > /dev/null
espera_corridas 5 'con cambios sin commitear corre siempre y no cachea'
afirma 'dice por qué no cachea' grep -q 'sucio' "$ERR"
rm "$REPO/suelto.txt"

printf '\nmedición fallida\n'
echo otro > "$REPO/nuevo.txt"
git -C "$REPO" -c user.email=t@t -c user.name=t commit -qam error
HOOK_STATUS=error medir "$REPO" > /dev/null
HOOK_STATUS=error medir "$REPO" > /dev/null
espera_corridas 7 'status error no se cachea: se vuelve a medir'
medir "$REPO" > /dev/null
medir "$REPO" > /dev/null
espera_corridas 8 'el primer ok sobre ese árbol sí se cachea'

printf '\nTTL\n'
HO_GATE_CACHE_TTL=0 medir "$REPO" > /dev/null
espera_corridas 9 'con TTL 0 toda entrada está vencida'
afirma 'la caché vive en el git-common-dir' [ -n "$(ls "$REPO/.git/host-orchestrator/gate-cache/")" ]
for f in "$REPO"/.git/host-orchestrator/gate-cache/*; do
  sed -i.bak '1s/^[0-9]*/1/' "$f" && rm -f "$f.bak"   # la fecha a 1970
done
medir "$REPO" > /dev/null
espera_corridas 10 'una entrada más vieja que el TTL por defecto (6 h) vence'
afirma 'avisa que la entrada venció' grep -q 'vencida' "$ERR"

printf '\ncompartida entre worktrees\n'
git -C "$REPO" worktree add -q "$TMP/otro-wt" HEAD 2> /dev/null
medir "$TMP/otro-wt" > /dev/null
espera_corridas 10 'otro worktree del mismo repo, mismo árbol: hit'

printf '\napagada\n'
HO_GATE_CACHE=off medir "$REPO" > /dev/null
espera_corridas 11 'HO_GATE_CACHE=off corre el hook aunque haya entrada'

printf '\n──────────\n'
if [ "$FALLOS" -eq 0 ]; then
  printf 'test-gate-cache: todo en verde.\n'; exit 0
fi
printf 'test-gate-cache: %s comprobación(es) fallida(s).\n' "$FALLOS"; exit 1
