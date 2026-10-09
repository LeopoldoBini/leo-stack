# host-orchestrator

Orquestación host-side del pipeline AFK completo. **v4: el motor es un Workflow script determinístico** — las reglas corren como código JS (loops, condiciones, gates numéricos); los agentes solo implementan, miden y resuelven.

Punto de entrada: **`/prd-pipeline`** (invocación explícita de Leo, nunca del modelo).

```
/prd-pipeline milestone:PRD-0016          # sin tope (default)
/prd-pipeline label:slice/checkout +500k  # +Nk = hard cap deliberado
/prd-pipeline "#42,#43,#44" --dry-run     # plan + args, sin lanzar
```

**`/desatendido`** es la pieza suelta del plugin: la disciplina con la que un agente lleva un encargo hasta el final sin nadie mirando. No despacha nada ni depende del motor — sirve igual en la Mac que en la devbox, con pipeline o sin él. La invoca Leo junto con el encargo, y el objetivo que le dé tiene que ser **verificable**: no «mejorá los pliegos» sino «que estas cinco fuentes tengan sus adjuntos, probado con el conteo antes y después». Sin un *llegar* comprobable el agente inventa su propia línea de meta, siempre más cerca que la de Leo.

**`/probar <PR#|issue#|módulo> [--romper]`** usa la app de verdad en un navegador, con el agente `tester`, y devuelve criterio por criterio `visto-andar` / `visto-fallar` / `no-pude-probar`, cada uno con su captura. Existe porque typecheck, tests y review miran el código y nadie miraba la pantalla. Necesita la receta de arranque del repo (bloque `probador` del config, spec §3.10b): sin ella contesta que falta, en vez de adivinar contra qué ambiente se conecta la app.

Antes de la primera corrida en un repo: **`/init`** — siembra el bloque de operación en `CLAUDE.md` (regla HITL + puntero `cc-afk`) y el `.host-orchestrator/config.json`. Una vez por repo, idempotente.

## Fuentes de verdad (sin duplicación acá)

| Qué | Dónde |
|---|---|
| La spec del motor: arquitectura, roles/tiers, gate ratchet, serializers, resume, review fleet | `docs/SPEC-v4-workflow-engine.md` |
| El motor ejecutable | `workflows/prd-pipeline.js` |
| Cómo lanzar (pre-flight, args, tiering T0, `cc-afk`) | `commands/prd-pipeline.md` |
| Qué se siembra al adoptar el plugin en un repo, incluida la regla de dependencias entre tickets (pocas waves anchas) | `commands/init.md` |
| Disciplina de los subagentes | `agents/parallel-implementer.md`, `agents/merge-resolver.md` |
| Cómo trabaja un agente sin nadie mirando, dentro o fuera del pipeline | `skills/desatendido/SKILL.md` |
| Probar en la app: el rol, la receta de arranque y el contrato que usará el motor | `agents/tester.md`, `skills/probar/SKILL.md` — spec §3.10b y §3.15 |
| El lado de lectura, corrible a mano antes de lanzar | `scripts/pipeline-read.sh` — spec §3.13b |
| Contrato por repo (opcional, con defaults) | `.host-orchestrator/config.json` — spec §3.10 |
| Historial de versiones | `docs/CHANGELOG.md` |

## Estructura

```
host-orchestrator/
├── plugin.json
├── .mcp.json                              # navegador headless y aislado del tester
├── README.md                              # esta portada
├── docs/
│   ├── SPEC-v4-workflow-engine.md         # la spec (grillada + pilotos 1 y 2)
│   └── CHANGELOG.md                       # historial por versión
├── workflows/
│   └── prd-pipeline.js                    # EL MOTOR v4
├── commands/
│   ├── prd-pipeline.md                    # /prd-pipeline — lanza el motor
│   └── init.md                            # /init — onboarding del repo
├── skills/
│   ├── desatendido/
│   │   └── SKILL.md                       # /desatendido — correr sin supervisión
│   └── probar/
│       └── SKILL.md                       # /probar — usar la app con el tester
├── scripts/
│   ├── pipeline-read.sh                   # scope · check · intent (solo lectura)
│   ├── test-pipeline-read.sh              # su test, contra fixtures/
│   ├── gate-cache.sh                      # el hook con caché por árbol de git
│   ├── test-gate-cache.sh                 # su test, contra un repo de juguete
│   └── fixtures/                           # salida de gh ya filtrada, un caso por directorio
└── agents/
    ├── parallel-implementer.md            # TDD vertical slice; nunca pushea
    ├── merge-resolver.md                  # 5 criterios de no-regresión; recomienda
    ├── implementer.md                     # TDD sobre un encargo en prosa, fuera del pipeline
    ├── measurer.md                        # typecheck + suite, solo números
    └── tester.md                          # usa la app en un navegador; sin edición
```

Antes de lanzar, el scope se puede mirar como lo va a ver el motor —misma tabla de bucketing, sin gastar un token—: `sh scripts/pipeline-read.sh scope milestone:PRD-0016 --rama prd/prd-0016`.

Los comandos standalone `/parallel-implement-wave` y `/merge-orchestrate` se retiraron en 4.2.0 — ver `DEFUNCIONES.md` del marketplace y el tag `rescate/comandos-standalone`. <!-- acta -->

## Requisitos

- `gh` CLI autenticado (PRs, issues, labels).
- Repo git con la base branch trackeando un remoto.
- Acceso a los modelos que nombre el `model_map` del repo (default: opus/opus/sonnet/haiku).
- Para `/probar`: Node con `npx` (el navegador del tester es `@playwright/mcp`, que trae su Chromium) y la receta del repo.
- Issues con label `ready-for-agent` (o el que declare el config) como scope de entrada.

---

Built for Claude Code. Author: Leopoldo Bini. License: MIT.
