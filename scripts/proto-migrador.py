#!/usr/bin/env python3
"""PROTOTIPO DESECHABLE — no es código de producción.

Responde una sola pregunta del ticket #8: ¿qué puede *detectar* solo el migrador,
sin preguntarle nada al humano, y cómo se ve ese reporte?

Uso:  python3 scripts/proto-migrador.py [<path-del-repo> ...]
      (sin argumentos: recorre los 16 consumidores del inventario de #4)
"""

import json
import os
import subprocess
import sys

HOME = os.path.expanduser("~")
REGISTRY = f"{HOME}/.claude/plugins/installed_plugins.json"
MARKETPLACES = f"{HOME}/.claude/plugins/marketplaces"

# ── Veredictos de #6 ─────────────────────────────────────────────────────────
# accion: KEEP | MOVE | DIE | GLUE
VEREDICTO = {
    "host-orchestrator":    ("KEEP", "host-orchestrator (upgrade a 4.1.0)"),
    "engineering-workflow": ("DIE",  "<pegamento> + mattpocock-skills"),
    "sandcastle-max":       ("DIE",  "host-orchestrator v4"),
    "handoff":              ("DIE",  "mattpocock-skills:handoff"),
    "grill-me":             ("DIE",  "mattpocock-skills:grilling"),
    "caveman":              ("DIE",  "(sin reemplazo)"),
    "response-modes":       ("DIE",  "(sin reemplazo)"),
    "review-flow":          ("DIE",  "/analizar se muda a leo-tools; /revisar_trabajo -> mattpocock-skills:code-review"),
    "merge-orchestrator":   ("DIE",  "host-orchestrator v4 (ya huérfano)"),
    "interface-lens":       ("MOVE", "interface-lens@leo-tools"),
    "memory-flow":          ("MOVE", "memory-flow@leo-tools"),
    "yt-transcript":        ("MOVE", "yt-transcript@leo-tools"),
}

RENAME = {  # #11
    "toolkit-leopoldo": "leo-stack",
    "leopoldo-plugins": "leo-tools",
    "leopoldo-private-plugins": "leo-private",
}

ARTEFACTOS_MUERTOS = [
    (".sandcastle", "carpeta Docker/AFK pre-v4 (revisar .env antes de borrar)"),
]

PIPELINE_BLOCK = "<!-- engineering-workflow:pipeline:start"


def indices():
    out = {}
    for m in RENAME:
        p = f"{MARKETPLACES}/{m}/.claude-plugin/marketplace.json"
        if os.path.exists(p):
            d = json.load(open(p))
            out[m] = {x["name"]: x.get("version") for x in d.get("plugins", [])}
    return out


def instalados():
    """{repo_path: [(plugin, marketplace, version, scope)]}"""
    reg = json.load(open(REGISTRY))["plugins"]
    por_repo = {}
    for key, entradas in reg.items():
        plugin, _, mkt = key.partition("@")
        if mkt not in RENAME:
            continue
        for e in entradas:
            path = e.get("projectPath")
            if not path:
                continue
            por_repo.setdefault(path, []).append(
                (plugin, mkt, e.get("version"), e.get("scope"))
            )
    return por_repo


def enabled_flags(repo):
    flags = {}
    for f in (".claude/settings.json", ".claude/settings.local.json"):
        p = os.path.join(repo, f)
        if os.path.exists(p):
            try:
                d = json.load(open(p))
            except Exception:
                continue
            for k, v in (d.get("enabledPlugins") or {}).items():
                flags[k] = (v, f)
    return flags


def refs_marketplace(repo):
    """Referencias @<marketplace-viejo> en cualquier archivo trackeado (rename de #11)."""
    pats = "|".join(f"@{m}" for m in RENAME)
    try:
        r = subprocess.run(
            ["rg", "-l", "-e", pats, "--hidden", "-g", "!.git", repo],
            capture_output=True, text=True, timeout=20,
        )
        return [l.replace(repo + "/", "") for l in r.stdout.strip().splitlines() if l]
    except Exception:
        return []


def deps_textuales(repo):
    """Issues abiertas con 'Blocked by #N' en el body y 0 dependencias nativas (#10)."""
    try:
        r = subprocess.run(
            ["gh", "api", "repos/{owner}/{repo}/issues?state=open&per_page=100",
             "--jq", '[.[] | select(.pull_request == null) '
                     '| select(.body != null and (.body | test("(?i)blocked.?by:? *#"))) '
                     '| select((.issue_dependencies_summary.total_blocked_by // 0) == 0) '
                     '| {n: .number, t: .title}]'],
            cwd=repo, capture_output=True, text=True, timeout=30,
        )
        return json.loads(r.stdout or "[]")
    except Exception:
        return None  # sin remote gh / sin permisos


def diagnostico(repo, idx, inst):
    hallazgos = {"muere": [], "muda": [], "queda": [], "huerfano": [],
                 "flags": [], "artefactos": [], "refs": [], "deps": None}

    plugins = inst.get(repo, [])
    nombres = {p for p, _, _, _ in plugins}

    for plugin, mkt, ver, scope in plugins:
        en_indice = plugin in idx.get(mkt, {})
        vigente = idx.get(mkt, {}).get(plugin)
        accion, reemplazo = VEREDICTO.get(plugin, ("KEEP", "—"))
        etq = f"{plugin}@{mkt} {ver} ({scope})"
        if not en_indice:
            hallazgos["huerfano"].append(f"{etq} — no existe en el índice → {reemplazo}")
        elif accion == "DIE":
            hallazgos["muere"].append(f"{etq} → {reemplazo}")
        elif accion == "MOVE":
            nuevo = RENAME[{"interface-lens": "leopoldo-plugins",
                            "memory-flow": "leopoldo-plugins",
                            "yt-transcript": "leopoldo-plugins"}.get(plugin, mkt)]
            hallazgos["muda"].append(f"{etq} → {plugin}@{nuevo}")
        else:
            drift = "" if ver == vigente else f"  ⚠ drift: {ver} → {vigente}"
            nuevo_mkt = RENAME[mkt]
            hallazgos["queda"].append(f"{etq} → {plugin}@{nuevo_mkt}{drift}")

    for k, (v, origen) in enabled_flags(repo).items():
        plugin, _, mkt = k.partition("@")
        if mkt not in RENAME:
            continue
        if plugin not in nombres:
            hallazgos["flags"].append(f"{k} = {v} en {origen} — NO figura instalado acá")

    if not os.path.isdir(repo) or not os.listdir(repo):
        hallazgos["artefactos"].append("PATH FANTASMA: el directorio no existe o está vacío")
    else:
        for d, why in ARTEFACTOS_MUERTOS:
            p = os.path.join(repo, d)
            if os.path.exists(p):
                if d == ".sandcastle" and "sandcastle-max" not in nombres:
                    why += " — y sandcastle-max NO está instalado acá"
                hallazgos["artefactos"].append(f"{d}/ — {why}")
        cm = os.path.join(repo, "CLAUDE.md")
        if "host-orchestrator" in nombres:
            if not os.path.exists(cm):
                hallazgos["artefactos"].append("CLAUDE.md ausente y host-orchestrator instalado")
            elif PIPELINE_BLOCK not in open(cm, errors="ignore").read():
                hallazgos["artefactos"].append(
                    "CLAUDE.md sin bloque de pipeline (nunca corrió /init-workflow)")
        hallazgos["refs"] = refs_marketplace(repo)
        hallazgos["deps"] = deps_textuales(repo)

    return hallazgos


def reporte(repo, h):
    corto = repo.replace(HOME + "/Proyectos/", "")
    print(f"\n\033[1m━━ {corto}\033[0m")
    secciones = [
        ("MUERE",              h["muere"],      "\033[31m"),
        ("HUÉRFANO",           h["huerfano"],   "\033[31m"),
        ("SE MUDA",            h["muda"],       "\033[33m"),
        ("QUEDA",              h["queda"],      "\033[32m"),
        ("FLAG FANTASMA",      h["flags"],      "\033[33m"),
        ("ARTEFACTO MUERTO",   h["artefactos"], "\033[33m"),
    ]
    vacio = True
    for titulo, items, color in secciones:
        for it in items:
            vacio = False
            print(f"  {color}{titulo:<18}\033[0m {it}")
    if h["refs"]:
        print(f"  \033[36m{'REF @marketplace':<18}\033[0m {len(h['refs'])} archivo(s): "
              f"{', '.join(h['refs'][:4])}{' …' if len(h['refs']) > 4 else ''}")
        vacio = False
    if h["deps"]:
        vacio = False
        print(f"  \033[36m{'BACKFILL DEPS':<18}\033[0m {len(h['deps'])} issue(s) con "
              f"'Blocked by' textual y 0 dependencias nativas: "
              f"{', '.join('#' + str(d['n']) for d in h['deps'][:8])}")
    elif h["deps"] is None:
        print(f"  \033[90m{'BACKFILL DEPS':<18}\033[0m (no evaluable: sin gh/remote)")
    if vacio:
        print("  \033[90mnada que migrar\033[0m")


if __name__ == "__main__":
    idx, inst = indices(), instalados()
    repos = sys.argv[1:] or sorted(inst)
    print(f"\033[1mPROTOTIPO migrador — diagnóstico (dry-run, no toca nada)\033[0m")
    for r in repos:
        reporte(r, diagnostico(r, idx, inst))
    print()
