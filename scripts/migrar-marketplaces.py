#!/usr/bin/env python3
"""Migrador del rename de marketplaces (#17, artefacto A de #8).

Herramienta de un solo uso para el rename de #16:
  toolkit-leopoldo -> leo-stack, leopoldo-plugins -> leo-tools,
  leopoldo-private-plugins -> leo-private.

Stdlib pura. Se ejecuta desde una COPIA fuera de ~/.claude/plugins/
(el paso 4 de #16 borra el directorio donde este archivo vive).

Subcomandos (dry-run por defecto; nada se escribe sin --apply):

  censo                        universo completo, basura marcada
  sembrar   [--apply] [--repo P]   agrega <plugin>@<nuevo> junto al viejo
  limpiar   [--apply] [--repo P]   borra rastros del nombre viejo
  verificar [--repo P] [--load]    0 refs @viejo / pares sembrados / carga real
  restaurar <snapshot-dir> [--apply]   vuelve todo bit a bit al snapshot

Antes del primer --apply de sembrar/limpiar se toma un snapshot propio de
todos los archivos que se van a tocar (los settings viven en 39 repos, fuera
del árbol que respalda #16) más los dos registros globales.
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime

HOME = os.path.expanduser("~")
PLUGDIR = os.path.join(HOME, ".claude", "plugins")
REGISTRY = os.path.join(PLUGDIR, "installed_plugins.json")
KNOWN = os.path.join(PLUGDIR, "known_marketplaces.json")
SNAPROOT = os.path.join(HOME, ".claude", "migrador-snapshots")

RENAME = {
    "toolkit-leopoldo": "leo-stack",
    "leopoldo-plugins": "leo-tools",
    "leopoldo-private-plugins": "leo-private",
}
NEW_REPO = {
    "leo-stack": "LeopoldoBini/leo-stack",
    "leo-tools": "LeopoldoBini/leo-tools",
    "leo-private": "LeopoldoBini/leo-private",
}
VIEJOS = set(RENAME)
NUEVOS = set(RENAME.values())

# clases de basura (#8): se marcan en el censo y se excluyen de todo --apply
RE_FECHA = re.compile(r"(20\d{6}|20\d{2}-\d{2}-\d{2})$")


def es_basura(path):
    if "/.sandcastle/" in path:
        return "worktree .sandcastle/"
    if "/.archive/" in path:
        return "directorio .archive/"
    for seg in path.split(os.sep):
        if RE_FECHA.search(seg):
            return f"copia fechada ({seg})"
    return None


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def leer_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def detectar_formato(path):
    """(indent, newline_final) para reescribir sin ensuciar el diff."""
    txt = open(path, encoding="utf-8", errors="ignore").read()
    m = re.search(r"\n(\s+)\S", txt)
    indent = len(m.group(1)) if m and "\t" not in m.group(1) else 2
    return indent, txt.endswith("\n")


def escribir_json(path, data):
    indent, nl = detectar_formato(path)
    txt = json.dumps(data, indent=indent, ensure_ascii=False)
    if nl:
        txt += "\n"
    with open(path, "w", encoding="utf-8") as f:
        f.write(txt)


# ── universo ─────────────────────────────────────────────────────────────────

def repo_de(settings_path):
    d = os.path.dirname(settings_path)
    return os.path.dirname(d) if os.path.basename(d) == ".claude" else d


def raices_barrido():
    """~/Proyectos + todo projectPath del registro que caiga fuera. Barrer $HOME
    entero choca con los directorios protegidos de macOS (TCC); $HOME como
    projectPath (scope user) se cubre chequeando ~/.claude/settings*.json."""
    raices = [os.path.join(HOME, "Proyectos")]
    reg = leer_json(REGISTRY)["plugins"]
    for clave, entradas in reg.items():
        if clave.partition("@")[2] not in VIEJOS:
            continue
        for e in entradas:
            p = e.get("projectPath")
            if not p or not os.path.isdir(p) or os.path.realpath(p) == HOME:
                continue
            if not any(os.path.realpath(p).startswith(os.path.realpath(r) + os.sep)
                       or os.path.realpath(p) == os.path.realpath(r) for r in raices):
                raices.append(p)
    return raices


def barrido_settings():
    """Todos los settings*.json con refs @viejo. rg con --no-ignore:
    los settings.local.json están gitignoreados y sin la bandera se pierden 24
    archivos (#8). Se excluye ~/.claude/plugins: cache y clones de marketplace
    no son consumidores."""
    pats = "|".join(f"@{m}" for m in VIEJOS)
    cmd = ["rg", "-l", "--no-ignore", "--hidden", "-e", pats,
           "--glob", "**/settings*.json",
           "--glob", "!**/node_modules/**",
           "--glob", "!**/.git/**",
           "--glob", "!**/.claude/plugins/**",
           "--glob", "!**/migrador-snapshots/**",
           ] + raices_barrido()
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if r.returncode not in (0, 1):
        sys.exit(f"rg falló: {r.stderr.strip()[:500]}")
    hallados = set(l for l in r.stdout.splitlines() if l)
    for n in ("settings.json", "settings.local.json"):
        p = os.path.join(HOME, ".claude", n)
        if os.path.exists(p) and contar_refs(p):
            hallados.add(p)
    return sorted(hallados)


def registro():
    """{repo: {clave_vieja: [instalaciones]}} solo para los 3 marketplaces."""
    reg = leer_json(REGISTRY)["plugins"]
    por_repo = {}
    for clave, entradas in reg.items():
        if clave.partition("@")[2] not in VIEJOS:
            continue
        for e in entradas:
            p = e.get("projectPath")
            if p:
                por_repo.setdefault(p, {}).setdefault(clave, []).append(e)
    return por_repo


def universo():
    """Unión settings-sweep + registro. [(repo, [settings], en_registro, basura)]"""
    sw = barrido_settings()
    reg = registro()
    repos = {}
    for f in sw:
        repos.setdefault(repo_de(f), []).append(f)
    for r in reg:
        repos.setdefault(r, [])
    out = []
    for r in sorted(repos):
        out.append((r, sorted(repos[r]), r in reg, es_basura(r)))
    return out, reg


def filtrar_repo(univ, repo_filtro):
    if not repo_filtro:
        return [u for u in univ if not u[3]]
    rf = os.path.realpath(os.path.expanduser(repo_filtro))
    sel = [u for u in univ if os.path.realpath(u[0]) == rf]
    if not sel:
        sys.exit(f"--repo {repo_filtro}: no está en el universo")
    if sel[0][3]:
        sys.exit(f"--repo {repo_filtro}: marcado como basura ({sel[0][3]}), no se toca")
    return sel


def indices_marketplace():
    """{marketplace_viejo: {plugins del índice}} — para detectar huérfanos:
    un plugin instalado que ya no existe en el índice no se siembra (no hay
    nada que cargue con el nombre nuevo) y se limpia en seco (#7)."""
    conocidos = leer_json(KNOWN) if os.path.exists(KNOWN) else {}
    out = {}
    for viejo, nuevo in RENAME.items():
        for clave in (viejo, nuevo):
            loc = (conocidos.get(clave) or {}).get("installLocation")
            if not loc:
                loc = os.path.join(PLUGDIR, "marketplaces", clave)
            man = os.path.join(loc, ".claude-plugin", "marketplace.json")
            if os.path.exists(man):
                out[viejo] = {p["name"] for p in leer_json(man).get("plugins", [])}
                break
        else:
            out[viejo] = set()
    return out


def contar_refs(path):
    txt = open(path, encoding="utf-8", errors="ignore").read()
    return {m: txt.count(f"@{m}") for m in VIEJOS if f"@{m}" in txt}


# ── snapshot / restaurar ─────────────────────────────────────────────────────

def tomar_snapshot(archivos):
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = os.path.join(SNAPROOT, f"snap-{ts}")
    os.makedirs(dest)
    manifest = {}
    for a in sorted(set(archivos) | {REGISTRY, KNOWN}):
        if not os.path.exists(a):
            continue
        copia = os.path.join(dest, a.lstrip("/"))
        os.makedirs(os.path.dirname(copia), exist_ok=True)
        shutil.copy2(a, copia)
        manifest[a] = sha256(a)
    with open(os.path.join(dest, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    print(f"snapshot: {dest}  ({len(manifest)} archivos)")
    return dest


def cmd_restaurar(args):
    snap = os.path.expanduser(args.snapshot)
    manifest = leer_json(os.path.join(snap, "manifest.json"))
    pendientes = []
    for orig, h in manifest.items():
        actual = sha256(orig) if os.path.exists(orig) else "(ausente)"
        if actual != h:
            pendientes.append(orig)
    if not pendientes:
        print("nada que restaurar: todo coincide con el snapshot")
        return
    for orig in pendientes:
        copia = os.path.join(snap, orig.lstrip("/"))
        print(f"{'RESTAURA' if args.apply else 'restauraría'}  {orig}")
        if args.apply:
            shutil.copy2(copia, orig)
    if args.apply:
        mal = [o for o, h in manifest.items() if sha256(o) != h]
        print("verificación bit a bit: " + ("OK" if not mal else f"FALLÓ en {mal}"))
    else:
        print(f"\n(dry-run: {len(pendientes)} archivo(s); agregá --apply)")


# ── censo ────────────────────────────────────────────────────────────────────

def cmd_censo(_args):
    univ, reg = universo()
    tot_refs, tot_files = 0, 0
    print(f"{'repo':<72} {'settings':>8} {'refs':>5}  clase")
    for repo, files, en_reg, basura in univ:
        refs = sum(sum(contar_refs(f).values()) for f in files)
        if not basura:
            tot_refs += refs
            tot_files += len(files)
        clase = ("BASURA: " + basura if basura else
                 ("registro" if en_reg else "solo-limpiar"))
        corto = repo.replace(HOME, "~")
        fantasma = "" if os.path.isdir(repo) else "  [PATH FANTASMA]"
        print(f"{corto:<72} {len(files):>8} {refs:>5}  {clase}{fantasma}")
    limpios = [u for u in univ if not u[3]]
    print(f"\nuniverso: {len(limpios)} repos ({sum(1 for u in limpios if u[2])} "
          f"en registro, {sum(1 for u in limpios if not u[2])} solo-limpiar) · "
          f"{tot_files} settings · {tot_refs} refs @viejo · "
          f"{len(univ) - len(limpios)} entradas de basura excluidas")


# ── sembrar ──────────────────────────────────────────────────────────────────

def sembrar_en(data, indices):
    """Devuelve (cambios, avisos, data). No pisa claves existentes; los
    huérfanos (fuera del índice) no se siembran — no hay nada que cargue."""
    cambios, avisos = [], []
    ep = data.get("enabledPlugins") or {}
    nuevo_ep = {}
    for k, v in ep.items():
        nuevo_ep[k] = v
        plugin, _, mkt = k.partition("@")
        if mkt in RENAME:
            if plugin not in indices.get(mkt, set()):
                avisos.append(f"⚠ {k}: huérfano (no existe en el índice) — "
                              "no se siembra; lo borra limpiar")
                continue
            knuevo = f"{plugin}@{RENAME[mkt]}"
            if knuevo not in ep:
                nuevo_ep[knuevo] = v
                cambios.append(f"+ enabledPlugins.{knuevo} = {json.dumps(v)}")
    if cambios:
        data["enabledPlugins"] = nuevo_ep
    ekm = data.get("extraKnownMarketplaces") or {}
    for m in list(ekm):
        if m in RENAME and RENAME[m] not in ekm:
            ekm[RENAME[m]] = {"source": {"source": "github",
                                         "repo": NEW_REPO[RENAME[m]]}}
            cambios.append(f"+ extraKnownMarketplaces.{RENAME[m]}")
    return cambios, avisos, data


def cmd_sembrar(args):
    univ, reg = universo()
    indices = indices_marketplace()
    sel = filtrar_repo(univ, args.repo)
    plan, avisos_tot = [], []
    for repo, files, en_reg, _ in sel:
        if not en_reg:
            continue  # sin instalación no hay nada que cargue: solo-limpiar
        for f in files:
            try:
                data = leer_json(f)
            except Exception as e:
                print(f"⚠ {f}: JSON ilegible ({e}) — se saltea")
                continue
            cambios, avisos, data = sembrar_en(data, indices)
            avisos_tot += avisos
            if cambios:
                plan.append((f, cambios, data))
    for a in avisos_tot:
        print(a)
    if not plan:
        print("nada que sembrar (todo ya sembrado o fuera de alcance)")
        return
    for f, cambios, _ in plan:
        print(f"\n{f.replace(HOME, '~')}")
        for c in cambios:
            print(f"  {c}")
    print(f"\n{len(plan)} archivo(s), {sum(len(c) for _, c, _ in plan)} entrada(s)")
    if not args.apply:
        print("(dry-run: agregá --apply para escribir)")
        return
    tomar_snapshot([f for f, _, _ in plan])
    for f, _, data in plan:
        escribir_json(f, data)
    print("sembrado aplicado")


# ── limpiar ──────────────────────────────────────────────────────────────────

def limpiar_en(data, instalados_aqui, indices):
    """Borra claves @viejo. Una clave instalada y viva en el índice solo se
    borra con su contraparte @nuevo ya sembrada; los huérfanos (fuera del
    índice) se borran en seco (#7) — no hay contraparte posible."""
    cambios, avisos = [], []
    ep = data.get("enabledPlugins") or {}
    for k in list(ep):
        plugin, _, mkt = k.partition("@")
        if mkt not in RENAME:
            continue
        contraparte = f"{plugin}@{RENAME[mkt]}"
        vivo = plugin in indices.get(mkt, set())
        if k in instalados_aqui and vivo and contraparte not in ep:
            avisos.append(f"⚠ {k}: instalado y SIN contraparte {contraparte} — "
                          "no se borra (sembrar primero)")
            continue
        del ep[k]
        sufijo = "  (huérfano, remoción seca)" if not vivo and k in instalados_aqui else ""
        cambios.append(f"- enabledPlugins.{k}{sufijo}")
    ekm = data.get("extraKnownMarketplaces") or {}
    for m in list(ekm):
        if m in RENAME:
            if RENAME[m] not in ekm and any(
                    k.endswith("@" + m) for k in ep):
                avisos.append(f"⚠ extraKnownMarketplaces.{m}: aún referenciado")
                continue
            del ekm[m]
            cambios.append(f"- extraKnownMarketplaces.{m}")
    return cambios, avisos, data


def cmd_limpiar(args):
    univ, reg = universo()
    indices = indices_marketplace()
    sel = filtrar_repo(univ, args.repo)
    plan, avisos_tot = [], []
    for repo, files, en_reg, _ in sel:
        instalados_aqui = set(reg.get(repo, {}))
        for f in files:
            try:
                data = leer_json(f)
            except Exception as e:
                print(f"⚠ {f}: JSON ilegible ({e}) — se saltea")
                continue
            cambios, avisos, data = limpiar_en(data, instalados_aqui, indices)
            avisos_tot += avisos
            if cambios:
                plan.append((f, cambios, data))

    # registro global: instalaciones @viejo de los repos seleccionados
    reg_full = leer_json(REGISTRY)
    reg_plan = []
    repos_sel = {os.path.realpath(r) for r, _, _, _ in sel}
    for clave in list(reg_full["plugins"]):
        if clave.partition("@")[2] not in VIEJOS:
            continue
        quedan = []
        for e in reg_full["plugins"][clave]:
            p = e.get("projectPath")
            if p and os.path.realpath(p) in repos_sel:
                reg_plan.append(f"- installed_plugins: {clave}  ({p.replace(HOME, '~')})")
            else:
                quedan.append(e)
        if len(quedan) != len(reg_full["plugins"][clave]):
            if quedan:
                reg_full["plugins"][clave] = quedan
            else:
                del reg_full["plugins"][clave]
                reg_plan.append(f"- installed_plugins: clave {clave} queda vacía y se elimina")

    # carpetas cache/<viejo> y marketplaces/<viejo>: solo en corrida completa
    dirs = []
    if not args.repo:
        for m in VIEJOS:
            for base in ("cache", "marketplaces"):
                d = os.path.join(PLUGDIR, base, m)
                if os.path.exists(d):
                    dirs.append(d)

    if not plan and not reg_plan and not dirs:
        print("nada que limpiar" + (f" en {args.repo}" if args.repo else ""))
        return
    for f, cambios, _ in plan:
        print(f"\n{f.replace(HOME, '~')}")
        for c in cambios:
            print(f"  {c}")
    for c in reg_plan:
        print(c)
    for d in dirs:
        print(f"- rm -rf {d.replace(HOME, '~')}")
    for a in avisos_tot:
        print(a)
    if not args.apply:
        print(f"\n(dry-run: agregá --apply para escribir)")
        return

    if dirs:
        conocidos = set(leer_json(KNOWN))
        faltan = NUEVOS - conocidos
        if faltan:
            sys.exit(f"ABORTA: marketplaces nuevos sin registrar ({', '.join(faltan)}) "
                     "— borrar los directorios viejos ahora dejaría todo sin resolver")
        aqui = os.path.realpath(os.path.dirname(os.path.abspath(__file__)))
        if aqui.startswith(os.path.realpath(PLUGDIR)):
            sys.exit("ABORTA: el script corre desde ~/.claude/plugins/ y la limpieza "
                     "borra ese árbol — ejecutalo desde una copia afuera")
    tomar_snapshot([f for f, _, _ in plan])
    for f, _, data in plan:
        escribir_json(f, data)
    if reg_plan:
        escribir_json(REGISTRY, reg_full)
    for d in dirs:
        shutil.rmtree(d)
    print("limpieza aplicada")


# ── verificar ────────────────────────────────────────────────────────────────

def cmd_verificar(args):
    univ, reg = universo()
    indices = indices_marketplace()
    if args.repo:
        rf = os.path.realpath(os.path.expanduser(args.repo))
        sel = [u for u in univ if os.path.realpath(u[0]) == rf]
        if not sel:
            # repo ya limpio: no aparece en el universo (que nace de refs @viejo)
            files = [p for n in ("settings.json", "settings.local.json")
                     if os.path.exists(p := os.path.join(rf, ".claude", n))]
            sel = [(rf, files, True, None)]
        elif sel[0][3]:
            sys.exit(f"--repo {args.repo}: marcado como basura ({sel[0][3]})")
    else:
        sel = [u for u in univ if not u[3]]
    problemas = 0

    for repo, files, en_reg, _ in sel:
        for f in files:
            refs = contar_refs(f)
            if refs:
                problemas += 1
                print(f"✘ refs @viejo en {f.replace(HOME, '~')}: {refs}")
    for repo, files, en_reg, _ in sel:
        if not en_reg:
            continue
        for f in files:
            try:
                ep = leer_json(f).get("enabledPlugins") or {}
            except Exception:
                continue
            for k in ep:
                plugin, _, mkt = k.partition("@")
                if mkt in RENAME and f"{plugin}@{RENAME[mkt]}" not in ep:
                    if plugin not in indices.get(mkt, set()):
                        print(f"· {k}: huérfano sin contraparte (lo borra limpiar) "
                              f"en {f.replace(HOME, '~')}")
                        continue
                    problemas += 1
                    print(f"✘ {k} sin contraparte @{RENAME[mkt]} en {f.replace(HOME, '~')}")

    if args.load:
        for repo, _, en_reg, _ in sel:
            if not en_reg or not os.path.isdir(repo):
                continue
            r = subprocess.run(["claude", "plugin", "list", "--json"],
                               cwd=repo, capture_output=True, text=True, timeout=120)
            try:
                plugins = json.loads(r.stdout)
            except Exception:
                problemas += 1
                print(f"✘ claude plugin list falló en {repo.replace(HOME, '~')}: "
                      f"{(r.stderr or r.stdout)[:200]}")
                continue
            for p in plugins:
                mkt = p.get("marketplace", "")
                if mkt in VIEJOS or mkt in NUEVOS:
                    estado = p.get("status", p.get("enabled"))
                    marca = "✔" if str(estado) in ("enabled", "True", "true") else "✘"
                    if marca == "✘":
                        problemas += 1
                    print(f"{marca} {repo.replace(HOME, '~')}: "
                          f"{p.get('name')}@{mkt} → {estado}")

    if problemas:
        sys.exit(f"\nverificar: {problemas} problema(s)")
    print("verificar: OK — cero refs @viejo, pares completos"
          + (" y carga verificada" if args.load else ""))


# ── main ─────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("censo")
    for nombre in ("sembrar", "limpiar"):
        s = sub.add_parser(nombre)
        s.add_argument("--apply", action="store_true")
        s.add_argument("--repo", help="limitar a un solo repo (pilotos)")
    v = sub.add_parser("verificar")
    v.add_argument("--repo")
    v.add_argument("--load", action="store_true",
                   help="además corre `claude plugin list --json` por repo")
    r = sub.add_parser("restaurar")
    r.add_argument("snapshot")
    r.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    {"censo": cmd_censo, "sembrar": cmd_sembrar, "limpiar": cmd_limpiar,
     "verificar": cmd_verificar, "restaurar": cmd_restaurar}[args.cmd](args)


if __name__ == "__main__":
    main()
