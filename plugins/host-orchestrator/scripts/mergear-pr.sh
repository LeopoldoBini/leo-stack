#!/usr/bin/env bash
#
# mergear-pr.sh — mergea un PR a la rama integradora en exactamente el commit que
# el motor midió (spec §3.17). Lo corre el serializer de integrar cuando el árbol
# del PR, ya actualizado con la integradora, es el aprobado.
#
#   uso: mergear-pr.sh <worktree> <repo> <rama> <pr> <branch>
#
# Pasos, cada uno solo si el anterior salió: push del commit del worktree a la
# branch del PR → soltar el worktree (`gh pr merge --delete-branch` falla si la
# branch sigue checkouteada) → `gh pr merge --squash --match-head-commit <commit>`.
#
# Recién pusheado, GitHub tarda en recalcular el PR y responde «Base branch was
# modified» (6 veces en 2,5 h en registro-1018: cada vez el PR quedaba
# merge-blocked y la cadena trabada hasta que alguien lo mergeaba a mano). Ante
# ESE error se espera (5, 10, 20 y 30 s) y se reintenta con el mismo commit, solo
# si la punta remota de la integradora sigue dentro de la historia del PR: si se
# movió de verdad (o no se puede leer), no se reintenta, porque el árbol que
# entraría ya no es el medido.
#
# La última línea la decide el estado que GitHub reporta del PR, no la salida de
# `gh pr merge` (que puede fallar después de mergear, al borrar la branch):
# MERGEADO (sale 0) o NO_MERGEADO (sale 1). Sale 2 si faltan argumentos.

set -uo pipefail

[ $# -eq 5 ] || { echo "uso: mergear-pr.sh <worktree> <repo> <rama> <pr> <branch>" >&2; exit 2; }
WT=$1 REPO=$2 RAMA=$3 PR=$4 BRANCH=$5

veredicto() {
  if [ "$(cd "$REPO" && gh pr view "$PR" --json state --jq .state 2>/dev/null)" = MERGED ]; then
    echo MERGEADO
    exit 0
  fi
  echo NO_MERGEADO
  exit 1
}

cd "$WT" || veredicto
H=$(git rev-parse HEAD) || veredicto
git push origin "HEAD:$BRANCH" || veredicto
{ cd "$REPO" && git worktree remove --force "$WT" && git worktree prune; } || veredicto

for ESPERA in 5 10 20 30 FIN; do
  SALIDA=$(gh pr merge "$PR" --squash --delete-branch --match-head-commit "$H" 2>&1)
  echo "$SALIDA"
  case "$SALIDA" in
    *'Base branch was modified'*) ;;
    *) break ;;
  esac
  [ "$ESPERA" = FIN ] && break
  echo "mergear-pr: GitHub todavía no recalculó el PR #$PR — reintento en ${ESPERA}s con el mismo commit"
  sleep "$ESPERA"
  PUNTA=$(git ls-remote origin "refs/heads/$RAMA" | cut -f1)
  if [ -z "$PUNTA" ]; then
    echo "mergear-pr: no se pudo leer $RAMA en origin — no se reintenta"
    break
  fi
  if ! git merge-base --is-ancestor "$PUNTA" "$H" 2>/dev/null; then
    echo "mergear-pr: $RAMA se movió desde que se midió el PR — no se reintenta"
    break
  fi
done
veredicto
