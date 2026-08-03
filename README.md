# leo-stack

Marketplace de plugins de Claude Code: **el stack opinado**, lo que solo tiene sentido junto con el pipeline AFK. Lo que se agarra suelto vive en [`leo-tools`](https://github.com/LeopoldoBini/leo-tools); lo de dominio laboral, en `leo-private`.

El criterio de admisión es el eje de interdependencia: un plugin entra acá si no se explica solo. Lo que la [suite de Matt Pocock](https://github.com/mattpocock/skills) ya cubre no se re-forkea — se consume desde el plugin oficial `mattpocock-skills`, y este marketplace queda como overlay fino encima.

## Plugins

| Plugin | Qué hace |
|---|---|
| **host-orchestrator** | El motor del pipeline AFK: `/prd-pipeline` orquesta el despacho de waves, la review fleet y el merge sobre el host, como Workflow determinista. Núcleo del stack. |
| **interface-lens** | Juzgar, diseñar y construir interfaces con psicología UX y brújula ética. |
| **memory-flow** | `/revisar_memoria`: barrido batch de la memoria por-archivo, con propuestas de graduación a `CLAUDE.md` / `CONTEXT.md`. |
| **review-flow** | `/analizar`: checkpoint pre-ejecución para dictados por voz e instrucciones ambiguas. |
| **yt-transcript** | Transcripción de videos de YouTube a un archivo central, con resumen en español y timestamps anclados. |

## Instalación

```bash
/plugin marketplace add LeopoldoBini/leo-stack
/plugin install host-orchestrator@leo-stack
```

Los plugins se instalan por proyecto. Si la UI bloquea una reinstalación cross-project ([bug #14202](https://github.com/anthropics/claude-code/issues/14202)):

```bash
claude plugin install <plugin>@leo-stack --scope project
```

## Reconstrucción en curso

El marketplace está siendo reconstruido como overlay fino: seis plugins ya se retiraron y cuatro piezas se mudan a `leo-tools`. El recorrido completo — qué queda, qué muere, con qué se reemplaza y en qué orden — vive en el mapa [leo-stack como overlay fino sobre mattpocock-skills](https://github.com/LeopoldoBini/leo-stack/issues/1).

Lo retirado no desaparece sin rastro: [`DEFUNCIONES.md`](DEFUNCIONES.md) registra cada muerte con su reemplazo nombrado y el censo de repos que la tenían instalada. Y el tag `rescate/pre-reconstruccion` marca el último punto del historial donde todo vive entero:

```bash
git show rescate/pre-reconstruccion:plugins/<plugin>/<archivo>
```

## Atribución

Partes de este trabajo derivan de [mattpocock/skills](https://github.com/mattpocock/skills) (MIT, Copyright © Matt Pocock). Ver `LICENSE`.

## Licencia

MIT — ver `LICENSE`.
