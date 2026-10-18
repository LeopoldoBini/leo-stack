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

printf '\nscope con el trabajo terminado (y milestone resuelto por prefijo)\n'
# El título real del milestone es "PRD-0016 — Checkout end-to-end" y el scope se
# escribe con el código pelado: sin matcheo por prefijo, esto moría en el pre-flight.
HO_FIXTURE_DIR="$FIX/completo" sh "$CLI" scope milestone:PRD-0016 --rama prd/prd-0016 > "$SALIDA" 2>&1
espera '"all_done": true' 'all_done verdadero: todo DONE y al menos una DONE'
espera 'resuelto por prefijo' 'avisa por stderr que resolvió el milestone por prefijo'

printf '\nscope con un prefijo de milestone ambiguo\n'
HO_FIXTURE_DIR="$FIX/mixto" sh "$CLI" scope milestone:PRD-001 --rama prd/x > "$SALIDA" 2>&1
CODIGO=$?
[ "$CODIGO" -eq 2 ] && paso "sale 2: no elige uno en silencio" || fallo "salió $CODIGO, se esperaba 2"
espera 'es ambiguo, 2 títulos empiezan igual' 'nombra los candidatos en vez de adivinar'

# ------------------------------------------------ check: deps sin edge nativo --

printf '\ncheck sobre un repo heredado (deps en prosa)\n'
HO_FIXTURE_DIR="$FIX/prosa" sh "$CLI" check 'label:ready-for-agent' > "$SALIDA" 2>&1
CODIGO=$?
[ "$CODIGO" -eq 1 ] && paso "sale 1: no se lanza el pipeline" || fallo "salió $CODIGO, se esperaba 1"

espera 'dependencia(s) declarada(s) en el body' 'nombra el problema'
espera 'issues/301/dependencies/blocked_by -F issue_id=900099' 'imprime el remedio exacto para #99'
espera 'issues/301/dependencies/blocked_by -F issue_id=900098' 'imprime el remedio exacto para #98'
no_espera 'issues/302/dependencies'            '#302, que ya tiene edge nativo, no se reporta'
espera 'label "afk-agent-pr" existe'           'chequea los labels que definen el scope'

# El formato que emite to-tickets: heading + bullets. Era invisible para el check
# y dio verde con el grafo VACÍO en la corrida prd-0030-0818 (7 issues en cadena).
espera 'issues/303/dependencies/blocked_by -F issue_id=900594' 've el "### Blocked by" de un brief (#594)'
espera 'issues/303/dependencies/blocked_by -F issue_id=900595' 've el segundo bullet de la sección (#595)'
no_espera 'issue_id=<id-de-#2>'                'el "2" de "APIMarkeyV2" no es una referencia'
no_espera 'issues/303/dependencies/blocked_by -F issue_id=900999' 'el heading siguiente cierra la sección: #999 queda afuera'

# Contra el grafo REAL y no contra el contador: #304 tiene 1 edge y declara 2.
espera 'issues/304/dependencies/blocked_by -F issue_id=900096' 'reporta el edge que falta de una issue ya bloqueada'
no_espera 'issues/304/dependencies/blocked_by -F issue_id=900097' 'no repite el edge que #304 ya tiene'

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

# ------------------------- scope: datos del despacho continuo (spec §3.17) --

printf '\nscope con --base y la perilla de paralelismo\n'
CHECKOUT="$(mktemp -d)"
mkdir -p "$CHECKOUT/.host-orchestrator"
HO_FIXTURE_DIR="$FIX/mixto" sh "$CLI" scope milestone:PRD-0016 --rama prd/prd-0016 --dir "$CHECKOUT" > "$SALIDA" 2>&1
no_espera 'base_por_integrar'        'sin --base no informa la base'
no_espera '"paralelo"'               'sin el archivo no pide paralelismo'
no_espera 'No such file'             'sin el archivo no ensucia la salida'
printf '3\n' > "$FIX/mixto/compare"
printf '2\n' > "$CHECKOUT/.host-orchestrator/paralelo"
HO_FIXTURE_DIR="$FIX/mixto" sh "$CLI" scope milestone:PRD-0016 --rama prd/prd-0016 --base main --dir "$CHECKOUT" > "$SALIDA" 2>&1
espera '"base_por_integrar": 3,'     'con --base dice cuántos commits de la base faltan'
espera '"paralelo": 2,'              'lee la perilla del vigía de cuota'
printf '0\n' > "$CHECKOUT/.host-orchestrator/paralelo"
HO_FIXTURE_DIR="$FIX/mixto" sh "$CLI" scope milestone:PRD-0016 --rama prd/prd-0016 --base main --dir "$CHECKOUT" > "$SALIDA" 2>&1
no_espera '"paralelo"'               'un cero no es un paralelismo: se ignora'
printf '{"five":{"used_percentage":18,"resets_at":1792367400},"week":{"used_percentage":46,"resets_at":1792792800},"at":1792353708.705587}\n' > "$CHECKOUT/cuota.json"
HO_FIXTURE_DIR="$FIX/mixto" sh "$CLI" scope milestone:PRD-0016 --rama prd/prd-0016 --cuota "$CHECKOUT/cuota.json" > "$SALIDA" 2>&1
espera '"cuota": {"cinco_h": 18, "cinco_h_reinicia": 1792367400, "semanal": 46, "semanal_reinicia": 1792792800, "medida": 1792353708, "leida": ' 'traduce la lectura de la statusline'
printf 'medio escrito {"five":{' > "$CHECKOUT/cuota.json"
HO_FIXTURE_DIR="$FIX/mixto" sh "$CLI" scope milestone:PRD-0016 --rama prd/prd-0016 --cuota "$CHECKOUT/cuota.json" > "$SALIDA" 2>&1
no_espera '"cuota"'                  'una lectura ilegible no sale'
python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$SALIDA" && paso 'la salida sigue siendo JSON válido' || fallo 'la salida no parsea'
rm -f "$FIX/mixto/compare"; rm -rf "$CHECKOUT"

printf '\nscope: un PR mergeado dice si ya pasó por la revisión del pipeline\n'
HO_FIXTURE_DIR="$FIX/mixto" sh "$CLI" scope milestone:PRD-0016 --rama prd/prd-0016 > "$SALIDA" 2>&1
espera '"number": 101, "title": "Slice A: carrito", "bucket": "DONE", "pr_number": 201, "pr_branch": "issue-101", "revisado": false' 'DONE trae su PR y que todavía no se revisó'
CON_ETIQUETA="$(mktemp -d)"
cp "$FIX/mixto/"* "$CON_ETIQUETA/"
sed 's/^201	closed	true	issue-101	afk-agent-pr	/201	closed	true	issue-101	afk-agent-pr,pipeline-revisado	/' "$FIX/mixto/prs" > "$CON_ETIQUETA/prs"
HO_FIXTURE_DIR="$CON_ETIQUETA" sh "$CLI" scope milestone:PRD-0016 --rama prd/prd-0016 > "$SALIDA" 2>&1
espera '"pr_number": 201, "pr_branch": "issue-101", "revisado": true' 'con la etiqueta pipeline-revisado, revisado'
no_espera '"pr_number": 202, "pr_branch": "issue-102", "revisado"' 'un PR abierto no lleva revisado'
rm -rf "$CON_ETIQUETA"

# -------------------- scope: lo que necesita el carril de merge (spec §3.17) --

printf '\nscope con un PR en conflicto, uno de arreglos y una issue con dos PRs\n'
HO_FIXTURE_DIR="$FIX/despacho" sh "$CLI" scope milestone:PRD-0016 --rama prd/prd-0016 > "$SALIDA" 2>&1
bucket 102 MERGE_READY
espera 'en conflicto: lo resuelve el carril de merge'                 'un conflicto con la rama va al carril de merge, no a Leo'
bucket 103 IN_REVIEW
espera '"arreglos": [{"pr_number": 210, "pr_branch": "review/run-pr201", "bucket": "MERGE_READY", "de": 201}]' 'los PRs de arreglos salen aparte, con el PR revisado'
espera '"number": 101, "title": "Slice A: carrito", "bucket": "DONE", "pr_number": 201' 'DONE nombra el PR mergeado aunque haya otro abierto'

# ------------------------------------- push-auth: qué puede publicar el push --
# El motor veda .github/workflows/** salvo que esta salida diga que se puede
# (spec §3.16). Lo que se prueba es la clasificación; el token nunca se imprime.

push_auth() { HO_FIXTURE_DIR="$FIX/$1" sh "$CLI" push-auth > "$SALIDA" 2>&1 || fallo "push-auth $1 no salió 0"; }

printf '\npush-auth: cómo se autentica el push\n'
push_auth push-ssh
espera '{"via": "ssh", "tipo": "no-aplica", "scopes": null}'                    'ssh: no hay scopes que mirar'
push_auth push-clasico
espera '{"via": "https", "tipo": "clasico", "scopes": "gist, read:org, repo, workflow"}' 'token clásico: trae sus scopes'
no_espera 'gho_falso'                                                            'el token no aparece en la salida'
push_auth push-sin-workflow
espera '"scopes": "gist, read:org, repo"}'                                       'clásico sin workflow: lo dice tal cual'
push_auth push-fino
espera '{"via": "https", "tipo": "fine-grained", "scopes": null}'               'fine-grained: scopes no verificables'
push_auth push-sin-credencial
espera '"tipo": "sin-credencial"'                                                'sin credencial: no pregunta, lo reporta'

printf '\n──────────\n'
if [ "$FALLOS" -eq 0 ]; then
  printf 'test-pipeline-read: todo en verde.\n'; exit 0
fi
printf 'test-pipeline-read: %s comprobación(es) fallida(s).\n' "$FALLOS"; exit 1
