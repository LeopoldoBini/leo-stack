---
description: Extrae el transcript de un video de YouTube al archivo central (~/Documents/Transcripts) y escribe un resumen
argument-hint: <url|id> [--no-audio] [--force] [--whisper] [--no-summary]
allowed-tools: Bash, Read, Write
---

# /yt-transcript

Extraé el transcript del video indicado y guardalo en el archivo central del usuario.

**Argumentos recibidos:** `$ARGUMENTS`

## Procedimiento

### 1. Ejecutar el extractor

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/ytt.sh" <argumentos, sin --no-summary>
```

`--no-summary` es un flag de **este comando**, no del script: filtralo antes de pasar los
argumentos. El resto (`--no-audio`, `--force`, `--whisper`, `--lang xx`) va tal cual.

El script imprime la carpeta destino en su última línea y también la deja en
`/tmp/ytt-last-dir`. Es idempotente: si el video ya fue transcripto no lo re-descarga
(salvo `--force`).

Si falla, leé el mensaje de error y aplicá el remedio que corresponda:

| Síntoma | Causa | Remedio |
|---|---|---|
| `Sign in to confirm you're not a bot` | yt-dlp sin resolvedor del n-challenge | Usar el de Homebrew (`brew install yt-dlp`), no el de pip |
| `Operation not permitted … Cookies.binarycookies` | SIP bloquea las cookies de Safari | `YT_COOKIE_BROWSER=chrome` (default) o `brave`/`firefox` |
| `HTTP Error 429` | Rate-limit de YouTube | Esperar unos minutos; no reintentar en loop |
| `no se pudo leer la metadata` | Video privado, borrado o con restricción de edad | Informar al usuario; no insistir |
| Whisper tarda mucho | `large-v3` en CPU ≈ tiempo real | Es esperable; avisar y esperar, o `YT_WHISPER_MODEL=medium` |

### 2. Escribir el resumen

Salvo que el usuario haya pasado `--no-summary` **o que `summary.md` ya exista y no se haya
usado `--force`**:

1. Leé `transcript_timestamped.txt` de la carpeta destino.
2. Escribí `summary.md` en esa misma carpeta con esta estructura:

```markdown
# <título del video>

<canal> · <duración> · <fecha> · [ver video](<url>)

## De qué va
<2-3 oraciones: la tesis del video, no un catálogo de temas>

## Puntos clave
- **<concepto>** — <qué dice y por qué importa> `[MM:SS]`
- …

## Detalles accionables
<comandos, nombres de herramientas, versiones, pasos concretos que el video menciona.
Omití esta sección si el video no es técnico.>

## Vale la pena si
<a quién le sirve este video y a quién no>
```

Reglas para el resumen:
- Escribilo **en español**, aunque el video esté en otro idioma.
- Anclá los puntos clave con timestamps `[MM:SS]` reales tomados del transcript.
- Sintetizá con tus palabras; citá textual solo frases sueltas cuando la formulación
  exacta importe. No reproduzcas el transcript, que ya está en `transcript.txt`.
- Priorizá lo que el video afirma sobre lo que menciona al pasar.

### 3. Regenerar el índice y reportar

Después de escribir `summary.md`, volvé a correr el bloque de INDEX del script para que la
entrada quede marcada con 📝:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/ytt.sh" "<id del video>"   # idempotente, solo refresca el índice
```

Cerrá con un reporte breve: título, duración, cantidad de palabras, **vía usada**
(`captions` o `whisper`) y la ruta de la carpeta. Ofrecé abrirla con `open <dir>`.
No vuelques el transcript completo en la respuesta.

## Notas

- Destino configurable con `YT_TRANSCRIPTS_DIR` (default `~/Documents/Transcripts`).
- Otras variables: `YT_WHISPER_ENV`, `YT_WHISPER_MODEL`, `YT_COOKIE_BROWSER`.
- Si el usuario pasa varias URLs, procesalas una por una y hacé un solo reporte final.
- Si no pasó ninguna URL, pedísela en vez de adivinar.
