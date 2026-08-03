#!/usr/bin/env bash
# ytt.sh — extrae el transcript de un video de YouTube a un archivo central.
#
#   ytt.sh <url|id> [--no-audio] [--force] [--lang xx] [--whisper]
#
# Cascada de vías (en orden):
#   1. Captions oficiales/automáticas vía yt-dlp, formato json3   ← la que funciona
#   2. Fallback: descarga de audio + faster-whisper large-v3 local
#
# Salida: $YT_TRANSCRIPTS_DIR (default ~/Documents/Transcripts)
#   INDEX.md
#   <fecha>__<canal>__<titulo>__<id>/
#       transcript.txt  transcript_timestamped.txt  transcript.srt
#       audio.mp3  meta.json
#
# Notas de campo (por qué el script hace lo que hace):
#   - El yt-dlp de Homebrew trae Deno para resolver el n-challenge de YouTube;
#     el instalado por pip en un env conda NO, y falla con "Sign in to confirm
#     you're not a bot". Por eso se prefiere /opt/homebrew/bin/yt-dlp.
#   - Bajar audio exige cookies del navegador. Safari las bloquea por SIP
#     (Operation not permitted) → se usa Chrome.
#   - La API timedtext sin firma devuelve 200 con 0 bytes desde ~2025: muerta.
#     Las URLs firmadas que emite `yt-dlp -J` sí sirven.

set -uo pipefail

ROOT="${YT_TRANSCRIPTS_DIR:-$HOME/Documents/Transcripts}"
WHISPER_ENV="${YT_WHISPER_ENV:-video-to-knowledge}"
WHISPER_MODEL="${YT_WHISPER_MODEL:-large-v3}"
COOKIE_BROWSER="${YT_COOKIE_BROWSER:-chrome}"

die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
say() { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok()  { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn(){ printf '\033[33m!\033[0m %s\n' "$*" >&2; }

# reindex — regenera INDEX.md desde los meta.json existentes. Nunca hace append:
# se reconstruye entero, así que correrlo de más es inofensivo y borrar una carpeta
# a mano se refleja solo. Se llama también cuando el video ya estaba extraído, para
# que un summary.md agregado después quede marcado en el índice.
reindex() {
  [ -d "$ROOT" ] || return 0
  python3 - "$ROOT" <<'PY'
import json, os, sys
root = sys.argv[1]
rows = []
for name in sorted(os.listdir(root)):
    p = os.path.join(root, name, "meta.json")
    if not os.path.isfile(p): continue
    try: m = json.load(open(p))
    except Exception: continue
    rows.append((m.get("upload_date", ""), m, name))
rows.sort(key=lambda r: r[0], reverse=True)

def esc(s): return str(s).replace("|", "\\|")
def hms(s):
    s = s or 0
    return f"{s//3600}:{s//60%60:02d}:{s%60:02d}" if s >= 3600 else f"{s//60}:{s%60:02d}"

total = sum(r[1].get("words") or 0 for r in rows)
out = ["# Transcripts", "",
       f"{len(rows)} video{'s' if len(rows) != 1 else ''} · {total:,} palabras".replace(",", "."),
       "", "| Fecha | Canal | Título | Dur. | Palabras | Vía | Carpeta |",
       "|---|---|---|---|---|---|---|"]
for date, m, name in rows:
    mark = "📝 " if os.path.isfile(os.path.join(root, name, "summary.md")) else ""
    out.append(
        f"| {date} | {esc(m.get('channel',''))} | {mark}[{esc(m.get('title',''))}]({m.get('url','')}) "
        f"| {hms(m.get('duration_seconds'))} | {m.get('words',0)} | {m.get('method','')} "
        f"| [`{name}`](./{name.replace(' ', '%20')}/) |")
out += ["", "---", "_📝 = con resumen. Generado por `/yt-transcript` "
        "(plugin yt-transcript, marketplace leo-stack)._"]
open(os.path.join(root, "INDEX.md"), "w").write("\n".join(out) + "\n")
print(f"  INDEX.md: {len(rows)} entradas")
PY
}

# --- args ---------------------------------------------------------------
URL=""; NO_AUDIO=0; FORCE=0; LANG_PREF=""; FORCE_WHISPER=0
while [ $# -gt 0 ]; do
  case "$1" in
    --no-audio) NO_AUDIO=1 ;;
    --force)    FORCE=1 ;;
    --whisper)  FORCE_WHISPER=1 ;;
    --lang)     shift; LANG_PREF="${1:-}" ;;
    -h|--help)  sed -n '2,14p' "$0"; exit 0 ;;
    -*)         die "opción desconocida: $1" ;;
    *)          URL="$1" ;;
  esac
  shift
done
[ -n "$URL" ] || die "uso: ytt.sh <url|id> [--no-audio] [--force] [--lang xx] [--whisper]"
case "$URL" in http*) ;; *) URL="https://www.youtube.com/watch?v=$URL" ;; esac

# yt-dlp de Homebrew primero (trae Deno para el n-challenge)
YTDLP=""
for c in /opt/homebrew/bin/yt-dlp /usr/local/bin/yt-dlp "$(command -v yt-dlp 2>/dev/null)"; do
  [ -x "$c" ] && { YTDLP="$c"; break; }
done
[ -n "$YTDLP" ] || die "yt-dlp no encontrado. Instalá con: brew install yt-dlp"

# yt() — corre yt-dlp anónimo y, si falla, reintenta con las cookies del navegador.
# YouTube devuelve 429 / "Sign in to confirm you're not a bot" cuando ve muchas
# peticiones anónimas seguidas; con una sesión real deja de tratarnos como bot.
# Una vez que las cookies funcionan quedan pegadas para el resto de la corrida.
COOKIES_ON=0
yt() {
  if [ "$COOKIES_ON" -eq 0 ]; then
    "$YTDLP" --no-warnings "$@" 2>/dev/null && return 0
    warn "YouTube rechazó la petición anónima; reintentando con cookies de ${COOKIE_BROWSER}…"
  fi
  if "$YTDLP" --no-warnings --cookies-from-browser "$COOKIE_BROWSER" "$@" 2>/dev/null; then
    COOKIES_ON=1; return 0
  fi
  return 1
}

# --- metadata -----------------------------------------------------------
# Ojo: yt-dlp NO interpreta secuencias de escape en --print, así que el separador
# tiene que ser un TAB real ($'\t'), no la cadena literal "\t" — con comillas
# simples todos los campos vuelven pegados en uno solo.
say "Resolviendo metadata…"
META_RAW="$(yt --skip-download \
  --print $'%(id)s\t%(title)s\t%(uploader)s\t%(upload_date)s\t%(duration)s\t%(language)s\t%(view_count)s\t%(webpage_url)s' \
  "$URL" | tail -1)"
[ -n "$META_RAW" ] || die "no se pudo leer la metadata: video privado/borrado, o YouTube nos está limitando (429).
  Remedios: esperá unos minutos, abrí YouTube en ${COOKIE_BROWSER} con sesión iniciada,
  o probá otro navegador con YT_COOKIE_BROWSER=brave|firefox|chrome"

IFS=$'\t' read -r VID TITLE CHANNEL UPDATE DURATION VLANG VIEWS WURL <<<"$META_RAW"
# si el separador no llegó, el título se habría comido todos los campos
case "$TITLE" in *"\\t"*) die "parseo de metadata roto (yt-dlp devolvió los campos sin separar)";; esac
[ -n "$VID" ] || die "no se pudo determinar el ID del video"
[ "$VLANG" = "NA" ] && VLANG="en"

slug() {
  printf '%s' "$1" \
    | iconv -f utf-8 -t ascii//TRANSLIT 2>/dev/null || printf '%s' "$1"
}
mkslug() {
  slug "$1" | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' | cut -c1-"${2:-60}"
}
DATE_FMT="$(printf '%s' "$UPDATE" | sed -E 's/^([0-9]{4})([0-9]{2})([0-9]{2})$/\1-\2-\3/')"
[ "$DATE_FMT" = "NA" ] || [ -z "$DATE_FMT" ] && DATE_FMT="$(date +%F)"
DIR="$ROOT/${DATE_FMT}__$(mkslug "$CHANNEL" 30)__$(mkslug "$TITLE" 60)__${VID}"

ok "$TITLE"
printf '  canal: %s · %02d:%02d · %s\n' "$CHANNEL" $((DURATION/60)) $((DURATION%60)) "$DATE_FMT"

if [ -f "$DIR/transcript.txt" ] && [ "$FORCE" -eq 0 ]; then
  ok "Ya existe: $DIR"
  reindex   # refresca el índice: puede haberse agregado un summary.md después
  echo "  (usá --force para re-extraer)"
  printf '%s\n' "$DIR" > /tmp/ytt-last-dir
  echo "$DIR"
  exit 0
fi
mkdir -p "$DIR" || die "no se pudo crear $DIR"

METHOD=""

# --- vía 1: captions ----------------------------------------------------
if [ "$FORCE_WHISPER" -eq 0 ]; then
  say "Vía 1: captions oficiales…"
  SUBLANGS="${LANG_PREF:-${VLANG}-orig,${VLANG},en-orig,en,es-orig,es}"
  # -P en vez de (cd …): un subshell perdería el COOKIES_ON que setea yt()
  yt --skip-download -P "$DIR" \
     --write-auto-subs --write-subs --sub-langs "$SUBLANGS" \
     --sub-format json3 -o '%(id)s.%(ext)s' "$URL" >/dev/null

  if ls "$DIR/$VID".*.json3 >/dev/null 2>&1; then
    python3 - "$DIR" "$VID" <<'PY'
import json, glob, os, re, sys
d, vid = sys.argv[1], sys.argv[2]
# preferí la pista manual sobre la automática si hay varias; si no, la primera
cands = sorted(glob.glob(os.path.join(d, f"{vid}.*.json3")))
best, ev = None, []
for f in cands:
    try: data = json.load(open(f))
    except Exception: continue
    e = [x for x in data.get("events", []) if "segs" in x]
    if len(e) > len(ev): best, ev = f, e
if not ev:
    sys.exit(3)

segs = []
for e in ev:
    t = "".join(s.get("utf8", "") for s in e["segs"]).replace("\n", " ").strip()
    if t:
        segs.append((e.get("tStartMs", 0), e.get("dDurationMs") or 0, t))

txt = re.sub(r"\s+", " ", " ".join(t for _, _, t in segs)).strip()
open(os.path.join(d, "transcript.txt"), "w").write(txt)
open(os.path.join(d, "transcript_timestamped.txt"), "w").write(
    "\n".join(f"[{m//60000:02d}:{m//1000%60:02d}] {t}" for m, _, t in segs))

def ts(ms):
    h, ms = divmod(ms, 3600000); m, ms = divmod(ms, 60000); s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"
cues = []
for i, (st, dur, t) in enumerate(segs):
    en = st + (dur or 2000)
    if i + 1 < len(segs): en = min(en, segs[i+1][0])
    if en <= st: en = st + 900
    cues.append(f"{i+1}\n{ts(st)} --> {ts(en)}\n{t}\n")
open(os.path.join(d, "transcript.srt"), "w").write("\n".join(cues))

for f in cands: os.remove(f)
print(f"  {len(txt.split())} palabras · {len(segs)} segmentos")
PY
    [ $? -eq 0 ] && [ -s "$DIR/transcript.txt" ] && METHOD="captions"
  fi
  [ -n "$METHOD" ] && ok "Captions extraídas" || warn "Sin captions utilizables"
fi

# --- audio (necesario para whisper; opcional si ya hay captions) --------
need_audio() { [ -z "$METHOD" ] || [ "$NO_AUDIO" -eq 0 ]; }
if need_audio && [ ! -f "$DIR/audio.mp3" ]; then
  say "Descargando audio…"
  # el audio prácticamente siempre exige cookies: se piden de entrada
  COOKIES_ON=1
  yt -f bestaudio -P "$DIR" \
     -x --audio-format mp3 -o 'audio.%(ext)s' "$URL" >/dev/null \
    && ok "audio.mp3 ($(du -h "$DIR/audio.mp3" 2>/dev/null | cut -f1))" \
    || warn "No se pudo bajar el audio (¿Chrome sin sesión de YouTube? probá otro navegador con YT_COOKIE_BROWSER)"
fi

# --- vía 2: whisper local ----------------------------------------------
if [ -z "$METHOD" ]; then
  [ -f "$DIR/audio.mp3" ] || die "sin captions y sin audio: no hay de dónde transcribir"
  command -v mamba >/dev/null 2>&1 || die "sin captions y mamba no está disponible para el fallback Whisper"
  say "Vía 2: Whisper local ($WHISPER_MODEL, puede tardar varios minutos)…"
  mamba run -n "$WHISPER_ENV" python - "$DIR" "$WHISPER_MODEL" <<'PY'
import os, sys
from faster_whisper import WhisperModel
d, model = sys.argv[1], sys.argv[2]
m = WhisperModel(model, device="cpu", compute_type="int8")
segs, _ = m.transcribe(os.path.join(d, "audio.mp3"), vad_filter=True, beam_size=5)
L = [(s.start, s.end, s.text.strip()) for s in segs]
open(os.path.join(d, "transcript.txt"), "w").write(" ".join(t for _, _, t in L))
open(os.path.join(d, "transcript_timestamped.txt"), "w").write(
    "\n".join(f"[{int(a)//60:02d}:{int(a)%60:02d}] {t}" for a, _, t in L))
def ts(x):
    h, x = divmod(x, 3600); m, x = divmod(x, 60); s = int(x)
    return f"{int(h):02d}:{int(m):02d}:{s:02d},{int((x-s)*1000):03d}"
open(os.path.join(d, "transcript.srt"), "w").write(
    "\n".join(f"{i+1}\n{ts(a)} --> {ts(b)}\n{t}\n" for i, (a, b, t) in enumerate(L)))
print(f"  {sum(len(t.split()) for _,_,t in L)} palabras · {len(L)} segmentos")
PY
  [ $? -eq 0 ] && [ -s "$DIR/transcript.txt" ] || die "Whisper falló"
  METHOD="whisper"
  ok "Transcripto con Whisper"
fi

[ "$NO_AUDIO" -eq 1 ] && rm -f "$DIR/audio.mp3"

# --- meta.json ----------------------------------------------------------
python3 - "$DIR" "$VID" "$TITLE" "$CHANNEL" "$DATE_FMT" "$DURATION" "$VLANG" "$VIEWS" "$WURL" "$METHOD" <<'PY'
import json, os, sys
d, vid, title, ch, date, dur, lang, views, url, method = sys.argv[1:11]
txt = open(os.path.join(d, "transcript.txt")).read()
def num(x):
    try: return int(x)
    except Exception: return None
json.dump({
    "id": vid, "title": title, "channel": ch, "upload_date": date,
    "duration_seconds": num(dur), "language": lang, "view_count": num(views),
    "url": url, "method": method, "words": len(txt.split()), "chars": len(txt),
    "files": sorted(f for f in os.listdir(d) if not f.startswith(".")),
}, open(os.path.join(d, "meta.json"), "w"), ensure_ascii=False, indent=2)
PY

# --- INDEX.md ------------------------------------------------------------
reindex

printf '%s\n' "$DIR" > /tmp/ytt-last-dir
ok "Guardado en: $DIR"
echo "$DIR"
