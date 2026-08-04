#!/usr/bin/env bash
#
# test-check-estandar.sh — verifica que el gate detecte. Un gate que solo sabe
# decir "verde" no es un gate, así que acá se le arma un marketplace que viola
# cada regla a propósito y se comprueba que las nombre todas.
#
# El fixture se construye en un temporal en vez de vivir comiteado: así el caso
# roto se lee como código (qué viola cada archivo y por qué) y no queda basura
# de 150 líneas en el repo.
#
#   uso: scripts/test-check-estandar.sh

set -uo pipefail

AQUI="$(cd "$(dirname "$0")" && pwd)"
GATE="$AQUI/check-estandar.sh"
REPO="$(git -C "$AQUI" rev-parse --show-toplevel)"

FALLOS=0
paso() { printf '  ✓ %s\n' "$1"; }
fallo() { printf '  ✗ %s\n' "$1"; FALLOS=$((FALLOS + 1)); }

# ---------------------------------------------- fixture: marketplace roto ----

ROTO="$(mktemp -d)"
trap 'rm -rf "$ROTO"' EXIT

mkdir -p "$ROTO/.claude-plugin" "$ROTO/plugins/roto/commands" "$ROTO/plugins/roto/agents" "$ROTO/plugins/roto/docs"

# R1 (description de 47 palabras), R2 (sin flag ni justificación),
# R3 (un comando que no existe y un path del plugin que no existe), R4 (cuerpo largo)
{
  printf -- '---\n'
  printf 'name: malo\n'
  printf 'description: Este comando existe para violar la primera regla del estándar y por eso su description se estira mucho más allá del techo de cuarenta palabras, acumulando cláusulas que no le dicen a nadie cuándo invocarlo ni qué superficie toca, que es exactamente lo que la regla quiere evitar cuando pide brevedad.\n'
  printf -- '---\n\n'
  printf '# /malo\n\n'
  printf 'Antes de correr esto, pasá por `/comando-que-no-existe` y leé `docs/fantasma.md`.\n\n'
  i=0
  while [ "$i" -lt 150 ]; do printf 'Línea de relleno número %s del cuerpo, para pasarse del techo.\n' "$i"; i=$((i + 1)); done
} > "$ROTO/plugins/roto/commands/malo.md"

# R8 (sin allowlist de tools). Description corta a propósito: un agente sano en R1.
{
  printf -- '---\n'
  printf 'name: pelado\n'
  printf 'description: Agente de prueba sin allowlist de tools — hereda la superficie completa.\n'
  printf 'model: opus\n'
  printf -- '---\n\n'
  printf 'Sos un agente de prueba.\n'
} > "$ROTO/plugins/roto/agents/pelado.md"

# R5 (bloque de prosa idéntico en dos archivos)
BLOQUE='El motor resuelve el tiering por nodo leyendo el model_map del repo, nunca por nombre de modelo.
Cada wave abre su rama integradora y la base se mergea antes de despachar la tanda siguiente.
El gate es un if puro sobre los números del validator: ninguna métrica empeora contra el baseline.
Una medición inválida nunca cuenta como éxito, porque el ratchet compara contra lo último verde.
La corrida entera termina en un único PR draft contra la base, para el botón verde del humano.'
printf '# Portada\n\n%s\n' "$BLOQUE" > "$ROTO/plugins/roto/README.md"
printf '# Notas\n\n%s\n' "$BLOQUE" > "$ROTO/plugins/roto/docs/notas.md"

# R1 sobre plugin.json + R5 (drift de versión contra el índice que la pinnea)
cat > "$ROTO/plugins/roto/plugin.json" <<'JSON'
{
  "name": "roto",
  "version": "2.0.0",
  "description": "Plugin de prueba cuya description también se pasa del techo de cuarenta palabras, estirándose con oraciones subordinadas que no agregan un solo dato accionable sobre cuándo conviene instalarlo, qué superficie toca en el repo consumidor, ni qué comando es su puerta de entrada real."
}
JSON

cat > "$ROTO/.claude-plugin/marketplace.json" <<'JSON'
{
  "name": "roto",
  "plugins": [
    { "name": "roto", "version": "1.0.0", "description": "Otra description distinta.", "source": "./plugins/roto" }
  ]
}
JSON

# ------------------------------------------------------------- ejecución ----

printf 'test-check-estandar\n\nmarketplace roto (debe fallar y nombrar las 6 reglas)\n'
SALIDA="$ROTO/salida.txt"
bash "$GATE" --repo "$ROTO" > "$SALIDA" 2>&1
CODIGO=$?

[ "$CODIGO" -eq 1 ] && paso "sale 1" || fallo "salió $CODIGO, se esperaba 1"

# Contra archivo y no contra un pipe: con `pipefail`, un `grep -q` que acierta
# temprano cierra el pipe y le hace creer al test que no encontró nada.
espera() {
  if grep -qF "$1" "$SALIDA"; then paso "$2"; else fallo "$2 — NO"; fi
}

for r in R1 R2 R3 R4 R5 R8; do espera "✗ $r" "$r detectada"; done
espera 'comando-que-no-existe' 'R3 nombra el comando inexistente'
espera 'docs/fantasma.md'      'R3 nombra el path inexistente'
espera 'versión 1.0.0'         'R5 nombra el drift contra el índice'

# El agente sano no debe arrastrar las reglas de las que está exento.
if awk '/agents\/pelado.md/ { d = 1; next } /^[^ ]/ { d = 0 } d' "$SALIDA" | grep -qE '✗ (R2|R4)'; then
  fallo "el agente arrastró R2 o R4, de las que está exento"
else
  paso "el agente queda exento de R2 y R4"
fi

printf '\nmarketplace real (debe salir limpio)\n'
bash "$GATE" --repo "$REPO" > /dev/null 2>&1
[ $? -eq 0 ] && paso "leo-stack sale 0" || fallo "leo-stack no está limpio — corré el gate a mano"

printf '\n──────────\n'
if [ "$FALLOS" -eq 0 ]; then
  printf 'test-check-estandar: todo en verde.\n'; exit 0
fi
printf 'test-check-estandar: %s comprobación(es) fallida(s).\n' "$FALLOS"; exit 1
