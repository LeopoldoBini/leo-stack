#!/usr/bin/env python3
"""PROTOTIPO DESECHABLE (#8) — censo de la superficie de los 3 modos.

Modo SEMBRAR  : dónde hay que agregar `<plugin>@<nuevo>` junto al viejo.
Modo LIMPIAR  : qué rastros del nombre viejo quedan (settings + registro global + cache).
Modo REESCRIBIR: veredictos de #6 (muere / se muda / huérfano) + artefactos muertos.

Además puntúa candidatos a piloto contra los criterios del comentario de #8:
multi-marketplace (sembrado cruzado) y huérfanos (limpieza sin red del CLI).
"""

import json
import os
import subprocess
from collections import defaultdict

HOME = os.path.expanduser("~")
PLUGDIR = f"{HOME}/.claude/plugins"
RENAME = {
    "toolkit-leopoldo": "leo-stack",
    "leopoldo-plugins": "leo-tools",
    "leopoldo-private-plugins": "leo-private",
}
MUEREN = {"engineering-workflow", "sandcastle-max", "handoff", "grill-me",
          "caveman", "response-modes", "review-flow", "merge-orchestrator"}
MUDAN = {"interface-lens", "memory-flow", "yt-transcript"}


def indices():
    out = {}
    for m in RENAME:
        p = f"{PLUGDIR}/marketplaces/{m}/.claude-plugin/marketplace.json"
        if os.path.exists(p):
            out[m] = {x["name"] for x in json.load(open(p)).get("plugins", [])}
    return out


def settings_files():
    """Todo settings*.json bajo ~ que mencione @<marketplace-viejo>."""
    pats = "|".join(f"@{m}" for m in RENAME)
    r = subprocess.run(
        ["rg", "-l", "-e", pats, "--hidden", "--glob", "**/settings*.json",
         "--glob", "!**/node_modules/**", HOME],
        capture_output=True, text=True, timeout=180,
    )
    return sorted(set(l for l in r.stdout.splitlines() if l))


def contar_refs(paths):
    """(total_refs, refs_por_marketplace, archivos_por_marketplace)"""
    total, por_mkt, arch = 0, defaultdict(int), defaultdict(set)
    for p in paths:
        try:
            txt = open(p, errors="ignore").read()
        except Exception:
            continue
        for m in RENAME:
            n = txt.count(f"@{m}")
            if n:
                total += n
                por_mkt[m] += n
                arch[m].add(p)
    return total, dict(por_mkt), {k: len(v) for k, v in arch.items()}


def registro():
    reg = json.load(open(f"{PLUGDIR}/installed_plugins.json"))["plugins"]
    claves = {k: v for k, v in reg.items() if k.partition("@")[2] in RENAME}
    instal = sum(len(v) for v in claves.values())
    return claves, instal


def perfil_repos(claves, idx):
    repos = defaultdict(lambda: {"mkts": set(), "plugins": [], "huerfanos": [],
                                 "mueren": [], "mudan": []})
    for k, entradas in claves.items():
        plugin, _, mkt = k.partition("@")
        for e in entradas:
            path = e.get("projectPath")
            if not path:
                continue
            r = repos[path]
            r["mkts"].add(mkt)
            r["plugins"].append((plugin, mkt, e.get("version")))
            if plugin not in idx.get(mkt, set()):
                r["huerfanos"].append(f"{plugin}@{mkt}")
            elif plugin in MUEREN:
                r["mueren"].append(f"{plugin}@{mkt}")
            elif plugin in MUDAN:
                r["mudan"].append(f"{plugin}@{mkt}")
    return repos


def artefactos(path):
    out = []
    if not os.path.isdir(path) or not os.listdir(path):
        return ["PATH FANTASMA"]
    if os.path.exists(os.path.join(path, ".sandcastle")):
        out.append(".sandcastle/")
    for f in (".claude/settings.json", ".claude/settings.local.json"):
        fp = os.path.join(path, f)
        if os.path.exists(fp):
            try:
                d = json.load(open(fp))
            except Exception:
                out.append(f"{f} ILEGIBLE")
                continue
            inst = {p for p, _, _ in PERFIL[path]["plugins"]} if path in PERFIL else set()
            for k, v in (d.get("enabledPlugins") or {}).items():
                if k.partition("@")[2] in RENAME and k.partition("@")[0] not in inst:
                    out.append(f"flag fantasma {k}={v}")
            if d.get("extraKnownMarketplaces"):
                for m in d["extraKnownMarketplaces"]:
                    if m in RENAME:
                        out.append(f"extraKnownMarketplaces:{m}")
    return out


if __name__ == "__main__":
    idx = indices()
    sf = settings_files()
    total_refs, por_mkt, arch_mkt = contar_refs(sf)
    claves, instal = registro()
    PERFIL = perfil_repos(claves, idx)

    print("\033[1m═══ SUPERFICIE GLOBAL ═══\033[0m")
    print(f"  settings*.json con refs @viejo : {len(sf)}")
    print(f"  referencias @viejo totales     : {total_refs}   {por_mkt}")
    print(f"  archivos por marketplace       : {arch_mkt}")
    print(f"  claves en installed_plugins    : {len(claves)}  ({instal} instalaciones)")
    print(f"  repos con projectPath          : {len(PERFIL)}")
    fuera = [p for p in sf if "/Proyectos/" not in p and f"{HOME}/.claude" not in p]
    print(f"  settings fuera de ~/Proyectos  : {len(sf) - len([p for p in sf if '/Proyectos/' in p])} "
          f"→ {[p.replace(HOME + '/', '') for p in sf if '/Proyectos/' not in p][:6]}")

    print("\n\033[1m═══ CANDIDATOS A PILOTO ═══\033[0m")
    filas = []
    for path, r in PERFIL.items():
        arts = artefactos(path)
        score = (len(r["mkts"]), len(r["huerfanos"]), len(r["mueren"]) + len(r["mudan"]), len(arts))
        filas.append((score, path, r, arts))
    filas.sort(key=lambda f: (-f[0][0], -f[0][1], -f[0][2], -f[0][3]))
    print(f"  {'repo':<52} {'mkts':>4} {'huérf':>5} {'baja':>4} {'arte':>4}  detalle")
    for (mk, hu, ba, ar), path, r, arts in filas[:14]:
        corto = path.replace(f"{HOME}/Proyectos/", "").replace(HOME, "~")
        det = " · ".join(r["huerfanos"] + arts)[:70]
        print(f"  {corto:<52} {mk:>4} {hu:>5} {ba:>4} {ar:>4}  {det}")
