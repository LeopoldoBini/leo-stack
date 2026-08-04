# host-orchestrator

Orquestación host-side del pipeline AFK completo. **v4: el motor es un Workflow script determinístico** — las reglas corren como código JS (loops, condiciones, gates numéricos); los agentes solo implementan, miden y resuelven.

Punto de entrada: **`/prd-pipeline`** (invocación explícita de Leo, nunca del modelo).

```
/prd-pipeline milestone:PRD-0016          # sin tope (default)
/prd-pipeline label:slice/checkout +500k  # +Nk = hard cap deliberado
/prd-pipeline "#42,#43,#44" --dry-run     # plan + args, sin lanzar
```

Antes de la primera corrida en un repo: **`/init`** — siembra el bloque de operación en `CLAUDE.md` (regla HITL + puntero `cc-afk`) y el `.host-orchestrator/config.json`. Una vez por repo, idempotente.

## Fuentes de verdad (sin duplicación acá)

| Qué | Dónde |
|---|---|
| La spec del motor: arquitectura, roles/tiers, gate ratchet, serializers, resume, review fleet | `docs/SPEC-v4-workflow-engine.md` |
| El motor ejecutable | `workflows/prd-pipeline.js` |
| Cómo lanzar (pre-flight, args, tiering T0, `cc-afk`) | `commands/prd-pipeline.md` |
| Qué se siembra al adoptar el plugin en un repo | `commands/init.md` |
| Disciplina de los subagentes | `agents/parallel-implementer.md`, `agents/merge-resolver.md` |
| El lado de lectura, corrible a mano antes de lanzar | `scripts/pipeline-read.sh` — spec §3.13b |
| Contrato por repo (opcional, con defaults) | `.host-orchestrator/config.json` — spec §3.10 |
| Historial de versiones | `docs/CHANGELOG.md` |

## Estructura

```
host-orchestrator/
├── plugin.json
├── README.md                              # esta portada
├── docs/
│   ├── SPEC-v4-workflow-engine.md         # la spec (grillada + pilotos 1 y 2)
│   └── CHANGELOG.md                       # historial por versión
├── workflows/
│   └── prd-pipeline.js                    # EL MOTOR v4
├── commands/
│   ├── prd-pipeline.md                    # /prd-pipeline — lanza el motor
│   └── init.md                            # /init — onboarding del repo
├── scripts/
│   ├── pipeline-read.sh                   # scope · check · intent (solo lectura)
│   ├── test-pipeline-read.sh              # su test, contra fixtures/
│   └── fixtures/                           # salida de gh ya filtrada, un caso por directorio
└── agents/
    ├── parallel-implementer.md            # TDD vertical slice; nunca pushea
    └── merge-resolver.md                  # 5 criterios de no-regresión; recomienda
```

Antes de lanzar, el scope se puede mirar como lo va a ver el motor —misma tabla de bucketing, sin gastar un token—: `sh scripts/pipeline-read.sh scope milestone:PRD-0016 --rama prd/prd-0016`.

Los comandos standalone `/parallel-implement-wave` y `/merge-orchestrate` se retiraron en 4.2.0 — ver `DEFUNCIONES.md` del marketplace y el tag `rescate/comandos-standalone`. <!-- acta -->

## Requisitos

- `gh` CLI autenticado (PRs, issues, labels).
- Repo git con la base branch trackeando un remoto.
- Acceso a los modelos que nombre el `model_map` del repo (default: fable/opus/sonnet/haiku).
- Issues con label `ready-for-agent` (o el que declare el config) como scope de entrada.

---

Built for Claude Code. Author: Leopoldo Bini. License: MIT.
