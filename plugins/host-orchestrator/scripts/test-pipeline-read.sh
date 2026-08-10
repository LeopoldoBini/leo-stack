#!/usr/bin/env bash
#
# test-pipeline-read.sh — ejercita la tabla de bucketing, la detección del spec
# y el falla-ruidoso de dependencias, contra las fixtures de `scripts/fixtures/`.
#
# Las fixtures viven comiteadas (y no en un temporal como las del gate del
# marketplace) porque acá el caso ES el dato: son la salida ya filtrada de `gh`,
# el mismo TSV que el CLI recibe en producción. Leerlas al lado del test es
# leer el contrato.
#
#   uso: scripts/test-pipeline-read.sh

set -uo pipefail

AQUI="$(cd "$(dirname "$0")" && pwd)"
CLI="$AQUI/pipeline-read.sh"
FIX="$AQUI/fixtures"

FALLOS=0
paso()  { printf '  ✓ %s\n' "$1"; }
fallo() { printf '  ✗ %s\n' "$1"; FALLOS=$((FALLOS + 1)); }

SALIDA="$(mktemp)"
trap 'rm -f "$SALIDA"' EXIT

# espera <patrón> <qué se comprueba> — contra archivo, no contra un pipe: con
# `pipefail` un `grep -q` que acierta temprano cierra el pipe y miente.
espera()    { if grep -qF "$1" "$SALIDA"; then paso "$2"; else fallo "$2 — NO"; fi; }
no_espera() { if grep -qF "$1" "$SALIDA"; then fallo "$2 — apareció"; else paso "$2"; fi; }

# bucket <issue> <bucket esperado>
bucket() {
  if grep -qF "\"number\": $1, " "$SALIDA" && \
     grep -F "\"number\": $1, " "$SALIDA" | grep -qF "\"bucket\": \"$2\""; then
    paso "#$1 → $2"
  else
    fallo "#$1 → $2 — quedó: $(grep -F "\"number\": $1, " "$SALIDA" | sed -E 's/.*"bucket": "([A-Z_]+)".*/\1/')"
  fi
}

# ------------------------------------------- scope: las siete reglas juntas ---

printf 'test-pipeline-read\n\nscope sobre la fixture mixta (una issue por bucket)\n'
HO_FIXTURE_DIR="$FIX/mixto" sh "$CLI" scope milestone:PRD-0016 --rama prd/prd-0016 > "$SALIDA" 2>&1
[ $? -eq 0 ] || fallo "el CLI no salió 0"

bucket 100 SPEC
bucket 101 DONE
bucket 102 MERGE_READY
bucket 103 IN_REVIEW
bucket 104 BLOCKED_BY_DEP
bucket 105 IMPLEMENTABLE
bucket 106 HUMAN_GATED
bucket 107 HUMAN_GATED

espera '"all_done": false'        'all_done falso con trabajo accionable pendiente'
espera '"specs": [100]'           'el spec padre se detecta estructuralmente'
espera '"blocked_by": [99]'       'los bloqueantes se listan por número, no por prosa'
espera '"pr_number": 202'         'el PR accionable viaja con la issue'
espera '"parent": 100'            'el puntero al spec padre viaja por issue'

# El spec lleva el mismo label que los slices (upstream se lo pone a todo): si la
# detección estructural fallara, entraría a la wave como trabajo implementable.
no_espera '"number": 100, "title": "Spec: checkout end-to-end", "bucket": "IMPLEMENTABLE"' \
          'el spec no se despacha como slice'

# La lista explícita se recorre issue por issue, y ahí viven dos trampas de sh
# que costaron una corrida real cada una: `gh` se come el stdin del `while read`,
# y un `printf` sin \n final hace que `read` descarte el último número. Las dos
# se ven solo con 3+ issues, y las dos degradan en silencio (menos scope, no error).
printf '\nscope por lista explícita\n'
HO_FIXTURE_DIR="$FIX/lista" sh "$CLI" scope '#105,#106,#107' --rama prd/x > "$SALIDA" 2>&1
bucket 105 IMPLEMENTABLE
bucket 106 IMPLEMENTABLE
bucket 107 IMPLEMENTABLE
espera '(3 issues' 'la lista no pierde issues por el camino'

# Una cadena A←B←C avanzaba un eslabón por corrida (leo-stack #26): el summary
# de GitHub cuenta abierto a un bloqueante cuyo PR ya mergeó a la integradora,
# porque la issue recién cierra con el PR final a la default branch. El descuento
# aplica solo a bloqueantes DEL scope; los de afuera siguen bloqueando.
printf '\nscope en cadena: bloqueante con PR mergeado a la integradora\n'
HO_FIXTURE_DIR="$FIX/cadena" sh "$CLI" scope '#110,#111,#112,#113' --rama prd/x > "$SALIDA" 2>&1
bucket 110 DONE
bucket 111 IMPLEMENTABLE
bucket 112 BLOCKED_BY_DEP
bucket 113 BLOCKED_BY_DEP
espera 'bloqueantes ya mergeados a prd/x'      'el detalle dice por qué #111 quedó libre'
espera '1 ya mergeado(s) a prd/x, descontado(s)' 'el detalle de #113 descuenta el hecho y conserva el vivo'
espera '"all_done": false'                     'all_done falso: la cadena destrabada sigue siendo trabajo'

printf '\nscope con el trabajo terminado\n'
HO_FIXTURE_DIR="$FIX/completo" sh "$CLI" scope milestone:PRD-0016 --rama prd/prd-0016 > "$SALIDA" 2>&1
espera '"all_done": true' 'all_done verdadero: todo DONE y al menos una DONE'

# ------------------------------------------------ check: deps sin edge nativo --

printf '\ncheck sobre un repo heredado (deps en prosa)\n'
HO_FIXTURE_DIR="$FIX/prosa" sh "$CLI" check 'label:ready-for-agent' > "$SALIDA" 2>&1
CODIGO=$?
[ "$CODIGO" -eq 1 ] && paso "sale 1: no se lanza el pipeline" || fallo "salió $CODIGO, se esperaba 1"

espera 'dependencia(s) declarada(s) en prosa'  'nombra el problema'
espera 'issues/301/dependencies/blocked_by -F issue_id=900099' 'imprime el remedio exacto para #99'
espera 'issues/301/dependencies/blocked_by -F issue_id=900098' 'imprime el remedio exacto para #98'
no_espera 'issues/302/dependencies'            '#302, que ya tiene edge nativo, no se reporta'
espera 'label "afk-agent-pr" existe'           'chequea los labels que definen el scope'

# ---------------------------------------------------- intent: índices, no cuerpos --

printf '\nintent de un slice con spec padre\n'
HO_FIXTURE_DIR="$FIX/intent" sh "$CLI" intent 401 --dir "$FIX/intent" > "$SALIDA" 2>&1
[ $? -eq 0 ] || fallo "el CLI no salió 0"

espera '"parent": {"n": 400'                   'resuelve el spec padre por el grafo'
espera 'Reembolsos parciales'                  'trae el Out of Scope del padre'
espera 'el puerto PasarelaDePago se testea'    'trae los seams del Testing Decisions'
espera '"path": "docs/adr/0007-pasarela.md"'   'indexa los ADRs por título y path'
espera '"prototype_branch": "prototype/checkout-fsm"' 'levanta el puntero al prototipo'
no_espera 'Stripe como PSP'                    'no arrastra secciones que nadie pidió'

printf '\n──────────\n'
if [ "$FALLOS" -eq 0 ]; then
  printf 'test-pipeline-read: todo en verde.\n'; exit 0
fi
printf 'test-pipeline-read: %s comprobación(es) fallida(s).\n' "$FALLOS"; exit 1
