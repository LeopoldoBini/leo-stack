export const meta = {
  // ⚠️ NO 'prd-pipeline': colisionaría con el COMANDO commands/prd-pipeline.md y el
  // slash command puede resolver al workflow pelado → recibe el scope crudo en vez
  // del objeto args compuesto por T0 (pasó en la corrida 289-...-0720). La única
  // entrada que se llama prd-pipeline es el comando; este script se lanza por scriptPath.
  name: 'prd-pipeline-engine',
  description: 'MOTOR INTERNO del pipeline AFK — NO invocar por nombre: la entrada es el comando /prd-pipeline, que compone args (scope/tiers/rama/budget) como orquestador T0 y lo lanza por scriptPath',
  phases: [
    { title: 'Setup' },
    { title: 'Despacho', detail: 'carriles de implementación' },
    { title: 'Merge', detail: 'carril serial' },
    { title: 'Revisión', detail: 'un revisor y un aplicador por PR mergeado' },
    { title: 'Cierre' },
  ],
}

// ============================================================================
// host-orchestrator v4 — motor genérico Workflow-nativo (spec: docs/SPEC-v4-workflow-engine.md)
//
// Principios (no negociables):
//  - Las REGLAS son código JS. El gate es un `if` sobre números de un validator.
//    CERO decisiones de gate tomadas por un modelo.
//  - Toda mutación remota corre en serializers, de a uno (candado, §3.17),
//    check-then-act, idempotentes por identidad de TRABAJO (PR/issue), no de branch (§3.2).
//  - Despacho continuo (§3.17): P carriles de implementación, un carril de merge
//    serial y uno de revisión; cada evento vuelve a leer el estado de GitHub.
//  - Tiering pinneado: TODO agent() lleva model explícito resuelto de args (§3.1).
//  - Sin Date.now(): timestamps entran por args; el audit log lo estampa el serializer.
//
// args = {
//   ts: string ISO (inyectado por el comando al lanzar),
//   runLabel: string,
//   repo: path absoluto del repo de la sesión,
//   scope: { type: 'milestone'|'label'|'parent'|'list', value: string },
//   base: 'master',                       // base_branch del config
//   rama: 'prd/<slug>' | 'batch/<slug>',  // rama integradora (la computa el comando)
//   models: { T0, T1, T2, T3 },           // model_map del config
//   tiers: { scout, validator, serializer, implementer, resolver, reviewer, applier }
//                                         // (opcional; defaults en TIER_DEFAULT: lo mecánico en T3),
//   issueTiers: { '<n>': 'T2', ... },     // override por issue (opcional)
//   readCli: path absoluto de scripts/pipeline-read.sh (lo resuelve el comando
//                                         desde ${CLAUDE_PLUGIN_ROOT}),
//   scopeInicial: <salida de `pipeline-read.sh scope` del pre-fetch de T0> | null,
//   validateHook: 'scripts/wave-validate.sh' | null,
//   testGlobs: ['**/*.test.*', ...],
//   denyPaths: [],                        // ratchets/guards ortogonales (§3.10)
//   requiredChecks: [],                   // checks de CI a esperar (vacío = no esperar)
//   labels: { ready: 'ready-for-agent', agentPr: 'afk-agent-pr' },
//   maxParallel: 3,                       // techo de carriles de implementación
//   cuota: '~/.cache/claude-cuota.json' | null, // lectura de rate_limits de la statusline (§3.17)
//   cuotaUmbrales: { umbral5h: 85, reservaSemanal: 10 },
//   budgetTotal: number|null, minBudgetWave: 300000, // mínimo de output para despachar trabajo nuevo
//   testsRojosPreexistentes: []           // paths conocidos (opcional, informativo)
// }
// ============================================================================

// ─── NÚCLEO PURO ───────────────────────────────────────────────────────────
// Reglas del motor sin efectos: no llaman agent(), no leen args ni loguean. Las
// extrae y las prueba tests/motor.test.mjs evaluando SOLO este bloque, así que
// una referencia a algo de afuera revienta el test en vez de pasar en silencio.
// ───────────────────────────────────────────────────────────────────────────

// ---------------------------------------------------------------------------
// EL GATE (§3.3): función pura. Acá y solo acá se decide pasa/no-pasa.
// ---------------------------------------------------------------------------
function gate(med, base, { exigirTests = true, vedados = [] } = {}) {
  const motivos = []
  // `deMedicion`: el gate no pudo decir nada del código. Quien lo llama no le pide al
  // implementer que "arregle" eso: es un problema del medidor, para Leo.
  if (!med) return { pass: false, deMedicion: true, motivos: ['validator murió'] }
  if (med.status !== 'ok') return { pass: false, deMedicion: true, motivos: [`medición inválida: ${med.error ?? 'sin detalle'}`] }
  if (med.limpio === false) motivos.push('el worktree medido tiene cambios sin commitear: lo medido no es lo que se publicaría')
  // ratchet genérico: ninguna métrica empeora (convención "menor es mejor")
  for (const k of Object.keys(base.metrics ?? {})) {
    const b = base.metrics[k]
    const c = med.metrics?.[k]
    if (typeof c !== 'number') motivos.push(`métrica ${k} no reportada`)
    else if (c > b) motivos.push(`${k} empeoró (${b} → ${c})`)
  }
  if (!(med.tests_failed <= base.tests_failed))
    motivos.push(`tests rojos subieron (${base.tests_failed} → ${med.tests_failed})`)
  const nuevosRojos = (med.failing_test_files ?? []).filter(
    (f) => !(base.failing_test_files ?? []).includes(f)
  )
  if (nuevosRojos.length > 0) motivos.push(`tests antes-verdes ahora rojos: ${nuevosRojos.join(', ')}`)
  const lockNuevos = (med.lockfiles_ajenos ?? []).filter((f) => !(base.lockfiles_ajenos ?? []).includes(f))
  if (lockNuevos.length > 0) motivos.push(`lockfiles de package managers distintos en la misma carpeta: ${lockNuevos.join(', ')}`)
  if (exigirTests) {
    if (med.diff_toca_tests !== true) motivos.push('el diff no agrega ni modifica ningún test (anti "slice sin tests")')
    if (med.tests_del_diff_verdes !== true) motivos.push('tests tocados por el diff no están todos verdes')
  }
  // Los paths vedados (deny_paths del repo + lo que el token no puede publicar) se
  // hacen cumplir acá, no solo en el prompt: un diff que los toca no se publica. Lo
  // pide quien mide un diff propio (el de la issue, el de los arreglos de una revisión).
  if (vedados.length) {
    if (!Array.isArray(med.archivos_del_diff)) return { pass: false, deMedicion: true, motivos: ['el medidor no reportó los archivos del diff: no se puede verificar los paths vedados'] }
    const tocados = tocaVedados(med.archivos_del_diff, vedados)
    if (tocados.length) motivos.push(`el diff toca paths vedados: ${tocados.join(', ')} — sacá esos cambios`)
  }
  return { pass: motivos.length === 0, motivos }
}

// Patrón de path vedado → ¿lo toca este archivo? `**` = cualquier cosa, `*` =
// cualquier cosa menos `/`, sin comodines = ese archivo o esa carpeta entera.
function tocaVedados(archivos, patrones) {
  const reglas = patrones.map((p) => {
    if (!p.includes('*')) {
      const sinBarra = p.replace(/\/+$/, '')
      return (f) => f === sinBarra || f.startsWith(`${sinBarra}/`)
    }
    const literal = (x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`^${p.split('**').map((s) => s.split('*').map(literal).join('[^/]*')).join('.*')}$`)
    return (f) => re.test(f)
  })
  return archivos.filter((f) => reglas.some((r) => r(f)))
}

// ¿El token con el que se pushea puede publicar `.github/workflows/**`? (§3.16)
// GitHub rechaza el push entero si trae un cambio ahí y el token no tiene el scope
// `workflow` (clásico) o el permiso Workflows (fine-grained). Solo el clásico deja
// verificarlo: sus scopes vienen en el header X-OAuth-Scopes. Lo que no se puede
// verificar se veda — un ticket que necesita tocar CI lo hace Leo a mano; dejarlo
// pasar costó seis implementaciones de #207 (corrida 1017b).
function vetoDeWorkflows(token) {
  if (!token) return { vedar: true, motivo: 'el setup no reportó cómo se autentica el push' }
  if (token.via === 'ssh') return { vedar: false, motivo: 'push por ssh: sin restricción de workflows' }
  if (token.tipo === 'clasico' && typeof token.scopes === 'string') {
    return token.scopes.split(/[,\s]+/).includes('workflow')
      ? { vedar: false, motivo: 'token clásico con scope workflow' }
      : { vedar: true, motivo: `token clásico sin scope workflow (tiene: ${token.scopes || 'ninguno'})` }
  }
  return { vedar: true, motivo: `push ${token.via ?? '?'} con token ${token.tipo ?? 'desconocido'}: el permiso de workflows no se puede verificar` }
}
const VETO_WORKFLOWS = '.github/workflows/**'

// Registro de trabajo de la corrida (§3.16). Invariante: un trabajo —implementar
// la issue N (clave `i<N>`) o mergear el PR M (`pr<M>`)— se intenta UNA vez por
// corrida, salvo un hecho nuevo. El único hecho nuevo que el motor puede ver es
// que alguien sacó la etiqueta con la que él mismo lo bloqueó: el scout vuelve a
// ofrecerlo y el registro dice que su último acto fue bloquearlo. Cualquier otra
// vuelta (publicación rechazada, implementer muerto, merge fallido sin etiqueta)
// es el mismo trabajo pidiendo repetirse igual: va para Leo, no se despacha.
function crearRegistro() {
  const r = new Map()
  const entrada = (clave) => r.get(clave) ?? r.set(clave, { intentos: 0, bloqueadoPorMotor: false }).get(clave)
  return {
    // 'despachar' | 'para_leo'
    decidir: (clave) => (!r.has(clave) || r.get(clave).bloqueadoPorMotor ? 'despachar' : 'para_leo'),
    intento(clave, datos = {}) {
      const e = entrada(clave)
      Object.assign(e, datos, { intentos: e.intentos + 1, bloqueadoPorMotor: false })
    },
    // Solo después de que la etiqueta quedó puesta: si el serializer falló, la
    // vuelta del trabajo se lee como lo que es, una repetición sin hecho nuevo.
    bloqueado(clave, datos = {}) {
      Object.assign(entrada(clave), datos, { bloqueadoPorMotor: true })
    },
    // Datos para el comentario de Leo (worktree, último resultado); no cuenta intento.
    anotar(clave, datos) {
      Object.assign(entrada(clave), datos)
    },
    dato: (clave) => r.get(clave),
  }
}

// ---------------------------------------------------------------------------
// Lockfiles ajenos (§3.3): dos package managers con lockfile trackeado en la misma
// carpeta. El validator solo transporta `git ls-files`; la regla vive acá, en código.
// Origen: autopsia cn-radar-al-dia-0921 (2026-09-21) — el applier corrió `npm install`
// en un repo pnpm y coló dos package-lock.json que ningún gate numérico vio.
// ---------------------------------------------------------------------------
const MANAGER_DE_LOCKFILE = {
  'package-lock.json': 'npm',
  'yarn.lock': 'yarn',
  'pnpm-lock.yaml': 'pnpm',
  'bun.lockb': 'bun',
  'bun.lock': 'bun',
}
function lockfilesAjenos(paths) {
  const porCarpeta = {}
  for (const p of paths ?? []) {
    const corte = p.lastIndexOf('/') + 1
    const manager = MANAGER_DE_LOCKFILE[p.slice(corte)]
    if (manager) (porCarpeta[p.slice(0, corte)] ??= []).push({ p, manager })
  }
  return Object.values(porCarpeta)
    .filter((l) => new Set(l.map((x) => x.manager)).size > 1)
    .flatMap((l) => l.map((x) => x.p))
    .sort()
}
const GLOBS_LOCKFILE = Object.keys(MANAGER_DE_LOCKFILE).map((n) => `'*${n}'`).join(' ')

// Lo que el gate compara de una medición: el baseline de una wave o de la review.
const aBaseline = (med) => ({
  metrics: med.metrics,
  tests_failed: med.tests_failed,
  failing_test_files: med.failing_test_files,
  lockfiles_ajenos: med.lockfiles_ajenos,
})

// Memoria de mediciones por árbol de git (§3.3). Medir depende del contenido del
// árbol, no del commit ni del worktree: el mismo árbol se medía hasta tres veces
// (gate de la issue, gate pre-merge, baseline siguiente) y en 1017b 27 de 42
// mediciones repitieron uno ya medido (~160 min). Se guarda la parte que es del
// árbol; lo del diff (tests_del_diff, archivos_del_diff) es de cada medición.
const PARTE_DEL_ARBOL = ['metrics', 'tests_failed', 'failing_test_files', 'tests_fuente', 'lockfiles']
const esIdDeGit = (x) => typeof x === 'string' && /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(x)
function crearMemoria() {
  const m = new Map()
  return {
    arboles: () => [...m.keys()],
    // Solo status ok sobre un árbol limpio: con cambios sin commitear el árbol no
    // describe lo que se midió, y una medición rota se repite, nunca se recuerda.
    guardar(med) {
      if (med?.status !== 'ok' || med.ya_medido || med.limpio !== true || !esIdDeGit(med.arbol)) return false
      m.set(med.arbol, JSON.stringify(Object.fromEntries(PARTE_DEL_ARBOL.map((k) => [k, med[k]]))))
      return true
    },
    // Una respuesta `ya_medido` + lo guardado de ese árbol. null si el motor no
    // lo tiene: el medidor se equivocó, y eso es una medición inválida.
    completar(med) {
      if (!m.has(med?.arbol) || med.limpio !== true) return null
      return { ...med, ...JSON.parse(m.get(med.arbol)) }
    },
    // Un árbol cuyo gate falló no se recuerda: si el rojo fue espurio, la próxima vez
    // (un reintento, o Leo destrabándolo) se vuelve a medir en vez de reusar el rojo.
    olvidar(arbol) {
      m.delete(arbol)
    },
    // La medición guardada de un árbol, lista para el gate; null si no está.
    medicion(arbol) {
      if (!m.has(arbol)) return null
      const g = JSON.parse(m.get(arbol))
      return { status: 'ok', arbol, limpio: true, ...g, lockfiles_ajenos: lockfilesAjenos(g.lockfiles) }
    },
  }
}

// ¿Se puede mergear sin volver a medir un PR cuyo árbol, ya actualizado con la
// integradora, resulte `arbol`? Sí, si ese árbol está medido y pasa el gate de
// no-regresión contra `base` (§3.17). Devuelve el árbol aprobado o null. Al agente
// le llega UNO, y la comparación la hace el shell: con una lista, un error del modelo
// podía prestarle a un árbol rojo la aprobación de otro (revisión de 4.15.0).
function arbolAprobado(memoria, base, arbol) {
  if (!esIdDeGit(arbol)) return null
  const med = memoria.medicion(arbol)
  return med && gate(med, base, { exigirTests: false }).pass ? arbol : null
}

// Tiers por rol (§3.1, 4.16.0). Lo mecánico corre en T3 (Haiku) por defecto y
// `args.tiers` lo sube sin editar el motor. Guarda: sin los tests del hook, el
// validator lee la salida cruda del runner de tests, y ahí Haiku puede leer un falso
// verde; con T3 pedido y sin tests del hook comprobados, el validator corre en T2.
const TIER_DEFAULT = { scout: 'T3', validator: 'T3', serializer: 'T3', implementer: 'T1', resolver: 'T1', reviewer: 'T1', applier: 'T1' }
function tierEfectivo(rol, tiers, { testsDelHook = false } = {}) {
  const t = tiers?.[rol] ?? TIER_DEFAULT[rol]
  return rol === 'validator' && t === 'T3' && testsDelHook !== true ? 'T2' : t
}

// Candado (§3.17): las mutaciones remotas pasan de a una, en orden de llegada,
// aunque las pidan carriles distintos. Una que falla no traba a las siguientes.
function crearCandado() {
  let cola = Promise.resolve()
  return {
    con(fn) {
      const turno = cola.then(() => fn())
      cola = turno.then(() => undefined, () => undefined)
      return turno
    },
  }
}

// Timbre: cualquier trabajo que termina despierta al despachador. Un aviso sin
// nadie esperando queda guardado, para no perderse entre dos esperas.
function crearTimbre() {
  let guardado = false
  let despertar = null
  return {
    avisar() {
      if (despertar) {
        const d = despertar
        despertar = null
        d()
      } else guardado = true
    },
    esperar() {
      if (guardado) {
        guardado = false
        return Promise.resolve()
      }
      return new Promise((r) => { despertar = r })
    },
  }
}

// Vigía de cuota (§3.17). Lee lo que la statusline dejó de rate_limits —ventana de
// 5 h y semanal— y baja el paralelismo en caliente, nunca por debajo de 1:
//  - arriba del umbral de 5 h, o de 100 − reserva en la semanal: un carril;
//  - con la velocidad medida —% gastado por carril-hora desde la primera lectura de
//    la ventana, con al menos `minCarrilHoras` de datos—: los carriles que llegan al
//    fin del horizonte sin pasar el tope. El horizonte es el reinicio de la ventana,
//    o `horizonteHoras` si es más corto (para la semanal es una decisión de Leo: hasta
//    el reinicio es lo conservador y con el gasto del 18/10 deja casi siempre 1 carril).
// Lo que no sabe no lo inventa: sin lectura, con la ventana vencida o sin datos de
// velocidad, no baja por eso. Una lectura vieja (la statusline dejó de escribir) no
// se usa: se mantiene la última decisión, en vez de leer "sin límite" en un dato
// congelado. Las horas salen de la lectura (`leida`, la hora del scout): el motor no
// tiene reloj. `enCurso(n)`: los carriles que corren desde ahora hasta la próxima.
function crearVigia({ umbral5h = 85, reservaSemanal = 10, minCarrilHoras = 0.5, maxVejezSeg = 600, horizonteHoras = null } = {}) {
  const ventanas = { cinco_h: { tope: umbral5h, ancla: null }, semanal: { tope: 100 - reservaSemanal, ancla: null } }
  let previa = null // { leida, carriles }
  let carriles = 0
  let ultima = null // la última decisión tomada con una lectura usable
  return {
    enCurso(n) {
      carriles = n
    },
    // lectura: { cinco_h, cinco_h_reinicia, semanal, semanal_reinicia, medida, leida }
    leer(l, max) {
      if (!l || typeof l.cinco_h !== 'number' || typeof l.semanal !== 'number' || typeof l.leida !== 'number')
        return { P: max, motivo: 'sin lectura de cuota' }
      if (previa && l.leida > previa.leida) {
        const horas = (l.leida - previa.leida) / 3600
        for (const v of Object.values(ventanas)) if (v.ancla) v.ancla.carrilHoras += previa.carriles * horas
      }
      previa = { leida: Math.max(l.leida, previa?.leida ?? 0), carriles }
      const vejez = typeof l.medida === 'number' ? l.leida - l.medida : 0
      if (vejez > maxVejezSeg)
        return { P: Math.min(ultima?.P ?? max, max), motivo: `lectura de cuota de hace ${Math.round(vejez / 60)} min (¿la statusline dejó de escribir?): se mantiene ${ultima ? `la última decisión, ${ultima.P}` : 'el techo'}` }
      let P = max
      const motivos = []
      for (const [k, v] of Object.entries(ventanas)) {
        const usado = l[k]
        const reinicia = l[`${k}_reinicia`]
        if (!(reinicia > l.leida)) {
          v.ancla = null // ventana vencida: la lectura ya no dice nada de la actual
          continue
        }
        if (!v.ancla || v.ancla.reinicia !== reinicia || usado < v.ancla.usado) v.ancla = { reinicia, usado, carrilHoras: 0 }
        if (usado >= v.tope) {
          P = 1
          motivos.push(`${k} al ${usado}% (tope ${v.tope}%)`)
          continue
        }
        const { carrilHoras } = v.ancla
        if (carrilHoras >= minCarrilHoras && usado > v.ancla.usado) {
          const porCarrilHora = (usado - v.ancla.usado) / carrilHoras
          const horas = Math.min((reinicia - l.leida) / 3600, horizonteHoras ?? Infinity)
          const caben = Math.max(1, Math.floor((v.tope - usado) / (porCarrilHora * horas)))
          if (caben < P) {
            P = caben
            motivos.push(`${k} al ${usado}%, ${porCarrilHora.toFixed(1)}%/h por carril y ${Math.round(horas)} h de horizonte: ${caben} carril(es) para no pasar ${v.tope}%`)
          }
        }
      }
      ultima = { P: Math.min(P, max) }
      return { P: ultima.P, motivo: motivos.join('; ') || `5 h al ${l.cinco_h}%, semanal al ${l.semanal}%: sin límite` }
    },
  }
}

// Carpeta de un worktree que crea el motor (§3.10c). El prefijo `wf_` es el
// contrato con el repo: los worktrees de los agentes de Claude Code ya caen en
// `wf_*`/`agent-*`, y un repo que aísla recursos compartidos por worktree (la base
// de tests de Radar, por ejemplo) reconoce esos prefijos. Con `pr-N` a secas, el
// gate pre-merge medía contra la base compartida y dio un rojo falso (1017b).
const carpetaDeWorktree = (repo, nombre) => `${repo}/.host-orchestrator/wt/wf_${nombre.replace(/\//g, '-')}`

// Texto que escribió un modelo o una persona (un motivo, el título de una issue, el
// resumen de un implementer) dentro de un comando de shell (§3.2): siempre entre
// comillas simples, con la comilla simple escapada acá. Entre comillas dobles, un
// backtick o un `$(` lo ejecuta el shell —bash y zsh— y el texto llega mutilado.
const comillasSimples = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const entreComillas = (s) => comillasSimples(String(s).replace(/\s*\n\s*/g, ' '))
// Un texto de varias líneas a un archivo temporal ($F), sin heredoc ni delimitador que
// el texto pueda imitar: una línea por argumento de printf, cada una entre comillas simples.
const textoAArchivo = (texto) => `F=$(mktemp) && printf '%s\\n' ${String(texto).split('\n').map(comillasSimples).join(' ')} > "$F"`

// Marcar una issue para Leo (§3.16): etiqueta y comentario, con el motivo entre comillas simples.
function comandoDeMarcarIssue({ repo, issue, comentario }) {
  return `cd ${repo} && gh issue edit ${issue} --add-label agent-blocked && gh issue comment ${issue} --body ${entreComillas(comentario)}`
}

// Publicar una branch como PR (§3.2): push y PR en un comando; el título va entre
// comillas simples y el cuerpo por archivo.
function comandoDePublicarPr({ worktree, branch, base, labels, titulo, cuerpo, conHead = false }) {
  return `cd ${worktree} && git push -u origin ${branch} && ${textoAArchivo(cuerpo)} && gh pr create --base ${base}${conHead ? ` --head ${branch}` : ''}${labels.map((l) => ` --label ${l}`).join('')} --title ${entreComillas(titulo)} --body-file "$F"`
}

// El PR final (§3.2), draft de la integradora hacia la base: título y cuerpo los arma
// el motor, como en los demás PRs. Un PR final abierto o mergeado (uno cerrado sin
// mergear no cuenta) ya es el trabajo hecho: el comando no crea otro.
const prFinalExistente = (base, rama) => `gh pr list --head ${rama} --base ${base} --state all --json number,state --jq '.[] | select(.state != "CLOSED") | "\\(.number) \\(.state)"'`
function comandoDePrFinal({ dir, base, rama, titulo, cuerpo }) {
  return `cd ${dir} && E=$(${prFinalExistente(base, rama)}) && if [ -n "$E" ]; then echo "YA_EXISTE $E"; else ${textoAArchivo(cuerpo)} && gh pr create --draft --base ${base} --head ${rama} --title ${entreComillas(titulo)} --body-file "$F"; fi`
}

// Un PR final que ya estaba abierto (un relanzamiento sobre la misma rama): se le suman
// los `Closes #` que le falten, sin tocar el resto de su cuerpo.
function comandoDeSumarCloses({ dir, base, rama, issues }) {
  return `cd ${dir} && P=$(gh pr list --head ${rama} --base ${base} --state open --json number --jq '.[0].number') && [ -n "$P" ] && F=$(mktemp) && gh pr view "$P" --json body --jq .body > "$F" && S=0 && for N in ${issues.join(' ')}; do grep -qE '(^|[^0-9A-Za-z])Closes #'"$N"'([^0-9]|$)' "$F" || { printf 'Closes #%s\\n' "$N" >> "$F"; S=1; }; done && if [ "$S" = 1 ]; then gh pr edit "$P" --body-file "$F"; else echo SIN_CAMBIOS; fi`
}

// Marcar un PR para Leo (§3.16). La etiqueta y el comentario van adentro de un `case`
// sobre el estado que reporta GitHub: a un PR MERGED no se le pone nada, aunque el
// agente que corre el comando se equivoque.
function comandoDeMarcarPr({ repo, pr, comentario }) {
  return `cd ${repo} && case "$(gh pr view ${pr} --json state --jq .state)" in MERGED) echo YA_MERGEADO ;; OPEN|CLOSED) gh pr edit ${pr} --add-label merge-blocked && gh pr comment ${pr} --body ${entreComillas(comentario)} && echo MARCADO ;; *) echo ESTADO_ILEGIBLE ;; esac`
}

// ─── FIN DEL NÚCLEO PURO ───────────────────────────────────────────────────

// §3.12.1 — args puede llegar objeto o string JSON según cómo se invoque el tool.
// GUARDA: el orquestador T0 DEBE componer el objeto args (paso 2 de commands/prd-pipeline.md:
// scope, models, tiers, rama, base, budgetTotal, ...). Pasar el scope crudo ("milestone:X +800k")
// como string NO es válido — se rechaza acá con un mensaje claro en vez de un JSON.parse críptico.
function parseArgs(a) {
  if (a && typeof a === 'object') return a
  if (typeof a === 'string') {
    const s = a.trim()
    if (!s.startsWith('{')) {
      throw new Error(
        `prd-pipeline: args inválido. Recibí el scope crudo (${JSON.stringify(s.slice(0, 60))}) en vez del objeto args. ` +
          `El orquestador T0 debe COMPONER args (scope/models/tiers/rama/base/budgetTotal/...) siguiendo el paso 2 de commands/prd-pipeline.md, ` +
          `no pasar la directiva del comando literal.`
      )
    }
    return JSON.parse(s)
  }
  throw new Error(`prd-pipeline: args ausente o de tipo no soportado (${typeof a}). Componé el objeto args (ver commands/prd-pipeline.md).`)
}
const A = parseArgs(args)
// Args opcionales que el motor recorre sin re-chequear: null → default vacío
// (corrida 16-17-0806: `A.denyPaths.length` con null reventó a mitad de wave).
A.denyPaths ??= []
A.requiredChecks ??= []

const M = A.models
const T = { ...TIER_DEFAULT, ...(A.tiers ?? {}) }
const MAX_P = A.maxParallel ?? 3

// §3.1b — EFFORT por rol (config `role_efforts` → args.efforts; override por issue en
// args.issueEfforts). El costo de una corrida escala con turnos × contexto acumulado,
// no con el effort: la mayor parte es contexto releído (caché). El output —lo único que
// mueve el effort— pesó ~6% en la autopsia de julio (App.SaltaCompra, sin review en xhigh)
// y 17–26% del costo ponderado en las corridas de octubre sobre Radar, con la revisión en
// xhigh. Por eso: los roles EJECUTORES (scout/validator/serializer: corren comandos) van a
// 'low' —no razonan, ejecutan—, y los roles de JUICIO (reviewer/resolver) van a 'xhigh'
// (2026-10-09): ahí el error es asimétrico (lo que el revisor no ve no lo ve nadie
// después, el gate es puramente numérico), y subirles el effort encarece el output,
// que es la parte chica de la cuenta.
const EFFORT_DEFAULT = {
  scout: 'low',
  validator: 'low',
  serializer: 'low',
  implementer: 'medium',
  resolver: 'xhigh',
  reviewer: 'xhigh',
  applier: 'medium',
}
const E = { ...EFFORT_DEFAULT, ...(A.efforts ?? {}) }
const effortDeIssue = (n) => A.issueEfforts?.[String(n)] ?? E.implementer
const REPO = A.repo
const RAMA = A.rama
const BASE = A.base
const WT_INTEGRACION = carpetaDeWorktree(REPO, RAMA)
const wtDePr = (prNum) => carpetaDeWorktree(REPO, `pr-${prNum}`)
const AUDIT_LOG = `${REPO}/.host-orchestrator/waves/${A.runLabel}.log`

// §3.12.3 — budget por args (fuente primaria), fallback directiva, log de fuente.
// OJO, el freno ve solo OUTPUT: `budget.spent()` cuenta tokens de output de la sesión y
// sus workflows, y `agent()` no le devuelve al script el usage de cada agente (ni input
// ni caché), así que el motor no puede frenar por costo ponderado. En las corridas de
// octubre el output fue 17–26% del costo: un tope `+800k` deja pasar ~4-5 veces eso en
// costo real. El tope es un freno de output, no de plata (§3.12, punto 6).
const BUDGET_TOTAL = A.budgetTotal ?? budget.total
const restante = () => (BUDGET_TOTAL ? Math.max(0, BUDGET_TOTAL - budget.spent()) : Infinity)

// §3.4b — el scope viaja literal al CLI de lectura, que es el único lugar donde
// vive la tabla de bucketing. Acá no se traduce a flags de gh: dos traducciones
// del mismo scope divergen sin que nadie se entere.
// Acepta el string literal del comando ('#16,#17' | 'milestone:X') o el objeto
// {type, value}. Con string, `.type` era undefined y SCOPE_ARG quedaba
// "undefined:undefined" — el CLI devolvía scope vacío y la corrida moría BLOCKED.
const SCOPE_ARG =
  typeof A.scope === 'string'
    ? A.scope
    : A.scope.type === 'list'
      ? A.scope.value
      : `${A.scope.type}:${A.scope.value}`

// Descripción LEGIBLE del scope, derivada una sola vez. Con `args.scope` string,
// `A.scope.type/.value` da "undefined:undefined", y eso viajaba al banner, al packet
// del merge-resolver, al prompt del judge y al TÍTULO del PR final. En la corrida
// prd-0030-0818 el serializer improvisó un título correcto por su cuenta: salió bien
// de casualidad, y una desviación silenciosa del prompt no es una salvaguarda.
const SCOPE_DESC = typeof A.scope === 'string' ? A.scope : `${A.scope.type}:${A.scope.value}`

// Sin el CLI no hay bucketing, y un `sh undefined` daría issues vacío que el
// motor leería como "nada accionable" — un scope entero salteado en silencio.
const READ_CLI = A.readCli
if (!READ_CLI) {
  throw new Error(
    `prd-pipeline: falta args.readCli. El comando debe resolver \${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-read.sh ` +
      `a path absoluto y pasarlo en args (paso 2 de commands/prd-pipeline.md): el script del Workflow no ve esa variable.`
  )
}

// Los demás scripts del plugin viven al lado del CLI de lectura: un solo path
// resuelto por el comando alcanza para todos.
const SCRIPTS = READ_CLI.replace(/\/[^/]*$/, '')
// §3.3 — deps al día: reinstala (congelado, con el manager del lockfile) solo si
// el lockfile cambió respecto de lo instalado. Lo corre todo el que va a trabajar
// o medir sobre un árbol: el Setup, el implementer, el applier y el validator.
const DEPS_CLI = `${SCRIPTS}/deps-al-dia.sh`
const DEPS = (donde) => `bash ${DEPS_CLI} ${donde}`
// §3.17 — el merge de un PR aprobado: push, soltar la branch y mergear el commit
// medido, reintentando solo mientras GitHub no recalculó el PR. Última línea:
// MERGEADO | NO_MERGEADO, según el estado que GitHub reporta.
const MERGEAR_CLI = `${SCRIPTS}/mergear-pr.sh`

// Todo agente del motor sale con un tipo propio y solo las tools de su rol (§3.11):
// como agente genérico del Workflow arrancaba con todo el catálogo de la sesión (dos
// Playwright MCP, context7, listados de skills): ~42K tokens de prompt antes de hacer
// nada. Los tres roles mecánicos (scout, validator, serializer) corren como
// `operador`, solo Bash; medido en la Mac como sesión `claude -p --agent`: operador
// 12K, sesión con todas las tools 33K. El revisor solo lee, el aplicador edita sin
// browser ni docs, y el reintento de una issue es trabajo de implementer: su tipo.
const OPERADOR = 'host-orchestrator:operador'
const IMPLEMENTER = 'host-orchestrator:parallel-implementer'
const REVISOR = 'host-orchestrator:revisor'
const APLICADOR = 'host-orchestrator:aplicador'
// ¿La última medición trajo los tests del hook? Decide el tier del validator (§3.1).
let testsDelHook = false

// Package manager (autopsia cn-radar-al-dia-0921, 2026-09-21): el applier corrió
// `npm install` en un repo pnpm y coló dos package-lock.json. Una sola redacción para
// todo agente que instala dependencias; el gate lo respalda con lockfiles_ajenos (§3.3).
const REGLA_DEPS = `Dependencias: usá el package manager que indica el lockfile existente de cada carpeta (pnpm-lock.yaml → pnpm, yarn.lock → yarn, package-lock.json → npm, bun.lock/bun.lockb → bun). El único lockfile que se crea o se modifica es el de ese manager.`

// ---------------------------------------------------------------------------
// Schemas — los agentes reportan HECHOS y NÚMEROS; los veredictos son del script
// ---------------------------------------------------------------------------
const SCOUT_SCHEMA = {
  type: 'object',
  required: ['issues', 'all_done'],
  properties: {
    all_done: { type: 'boolean' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['number', 'title', 'bucket'],
        properties: {
          number: { type: 'integer' },
          title: { type: 'string' },
          bucket: {
            type: 'string',
            enum: ['DONE', 'SPEC', 'MERGE_READY', 'IN_REVIEW', 'IMPLEMENTABLE', 'BLOCKED_BY_DEP', 'HUMAN_GATED'],
          },
          pr_number: { type: 'integer' },
          pr_branch: { type: 'string' },
          revisado: { type: 'boolean', description: 'solo en DONE: el PR mergeado ya tiene la etiqueta pipeline-revisado' },
          blocked_by: { type: 'array', items: { type: 'integer' } },
          parent: { type: 'integer', description: 'issue del spec padre, por grafo nativo' },
          detalle: { type: 'string' },
        },
      },
    },
    specs: { type: 'array', items: { type: 'integer' }, description: 'issues padre del scope: la intención contra la que se revisa' },
    base_por_integrar: { type: 'integer', description: 'solo si el comando lo imprimió' },
    paralelo: { type: 'integer', description: 'solo si el comando lo imprimió' },
    cuota: {
      type: 'object',
      description: 'solo si el comando lo imprimió, tal cual',
      properties: {
        cinco_h: { type: 'number' },
        cinco_h_reinicia: { type: 'number' },
        semanal: { type: 'number' },
        semanal_reinicia: { type: 'number' },
        medida: { type: 'number' },
        leida: { type: 'number' },
      },
    },
    notas: { type: 'string' },
  },
}

const MEDICION_SCHEMA = {
  type: 'object',
  required: ['status', 'metrics', 'tests_failed', 'failing_test_files', 'lockfiles', 'arbol', 'limpio'],
  properties: {
    status: { type: 'string', enum: ['ok', 'error'] },
    arbol: { type: 'string', description: 'salida de git rev-parse HEAD^{tree}, tal cual' },
    commit: { type: 'string', description: 'salida de git rev-parse HEAD, tal cual' },
    limpio: { type: 'boolean', description: '¿git status --porcelain salió vacío?' },
    ya_medido: { type: 'boolean', description: 'true solo si el árbol estaba en la lista de ya medidos y salteaste la medición' },
    error: { type: 'string' },
    metrics: { type: 'object', additionalProperties: { type: 'integer' } },
    tests_failed: { type: 'integer' },
    failing_test_files: { type: 'array', items: { type: 'string' } },
    tests_fuente: { type: 'string', enum: ['hook', 'suite'], description: 'de dónde salieron tests_failed/failing_test_files' },
    lockfiles: { type: 'array', items: { type: 'string' }, description: 'salida de git ls-files del paso de lockfiles, tal cual' },
    // mecánica del diff contra la rama integradora (solo cuando se pide):
    diff_toca_tests: { type: 'boolean' },
    tests_del_diff: { type: 'array', items: { type: 'string' }, description: 'archivos del diff que matchean testGlobs' },
    tests_del_diff_verdes: { type: 'boolean' },
    archivos_del_diff: { type: 'array', items: { type: 'string' }, description: 'salida de git diff --name-only del paso del diff, tal cual' },
  },
}

const IMPL_SCHEMA = {
  type: 'object',
  required: ['worktree', 'branch', 'resumen'],
  properties: {
    worktree: { type: 'string', description: 'pwd absoluto del worktree' },
    branch: { type: 'string' },
    resumen: { type: 'string' },
    bugs_reales: { type: 'array', items: { type: 'string' } },
    recursos_verificados: {
      type: 'array',
      items: { type: 'string' },
      description: 'anclaje a evidencia real: un recurso vivo por línea, con CÓMO se verificó y CUÁNDO',
    },
    bloqueado: { type: 'string', description: 'solo si el ticket es inimplementable: por qué' },
  },
}

const SERIALIZER_SCHEMA = {
  type: 'object',
  required: ['status', 'detalle'],
  properties: {
    status: { type: 'string', enum: ['ok', 'ya_estaba', 'blocked'] },
    pr_number: { type: 'integer' },
    detalle: { type: 'string' },
  },
}

// El setup reporta además cómo se autentica el push (pipeline-read.sh push-auth):
// el motor decide con eso si veda `.github/workflows/**` (§3.16).
const SETUP_SCHEMA = {
  ...SERIALIZER_SCHEMA,
  properties: {
    ...SERIALIZER_SCHEMA.properties,
    token: {
      type: 'object',
      description: 'el JSON de pipeline-read.sh push-auth, tal cual',
      properties: { via: { type: 'string' }, tipo: { type: 'string' }, scopes: { description: "string con los scopes, o null: tal cual lo imprimió" } },
    },
    commit: { type: 'string', description: 'git rev-parse HEAD de la integradora, tal cual' },
    arbol: { type: 'string', description: "git rev-parse 'HEAD^{tree}' de la integradora, tal cual" },
  },
}

// Lo que reporta un serializer que deja la integradora en un estado nuevo (refresh,
// integrar un PR): commit y árbol, para que el motor sepa si ese árbol ya está medido.
const DE_LA_INTEGRADORA = {
  commit_integracion: { type: 'string', description: 'git rev-parse HEAD de la integradora, tal cual' },
  arbol_integracion: { type: 'string', description: "git rev-parse 'HEAD^{tree}' de la integradora, tal cual" },
}
const REFRESCO_SCHEMA = { ...SERIALIZER_SCHEMA, properties: { ...SERIALIZER_SCHEMA.properties, ...DE_LA_INTEGRADORA } }
// Marcar un PR: el motor decide por la línea que imprimió el shell, no por el status
// ('ya_estaba' también puede leerse como "la etiqueta ya estaba").
const MARCA_PR_SCHEMA = {
  ...SERIALIZER_SCHEMA,
  required: [...SERIALIZER_SCHEMA.required, 'salida'],
  properties: { ...SERIALIZER_SCHEMA.properties, salida: { type: 'string', description: 'la última línea que imprimió el comando del paso 1, tal cual' } },
}
const INTEGRAR_SCHEMA = {
  type: 'object',
  required: ['status', 'mergeado', 'detalle'],
  properties: {
    status: { type: 'string', enum: ['ok', 'ya_estaba', 'conflicto', 'blocked'] },
    mergeado: { type: 'boolean' },
    arbol: { type: 'string', description: "git rev-parse 'HEAD^{tree}' del worktree del PR después del paso 4, tal cual" },
    limpio: { type: 'boolean' },
    pr_number: { type: 'integer' },
    detalle: { type: 'string' },
    ...DE_LA_INTEGRADORA,
  },
}

const RESOLVER_SCHEMA = {
  type: 'object',
  required: ['action', 'resolution', 'resumen'],
  properties: {
    action: { type: 'string', enum: ['MERGE', 'HOLD', 'ABORT'] },
    resolution: { type: 'string', enum: ['RESOLVED', 'INCOMPATIBLE', 'NOT_NEEDED'] },
    resumen: { type: 'string' },
  },
}

// Un revisor por PR mergeado (§3.7, 4.16.0): encuentra y decide en el mismo turno.
const REVISION_SCHEMA = {
  type: 'object',
  required: ['hallazgos', 'resumen'],
  properties: {
    resumen: { type: 'string', description: 'qué se revisó y cómo, en 2-3 líneas' },
    hallazgos: {
      type: 'array',
      items: {
        type: 'object',
        required: ['titulo', 'ubicacion', 'severidad', 'por_que', 'decision', 'razon'],
        properties: {
          titulo: { type: 'string' },
          ubicacion: { type: 'string', description: 'file:line' },
          severidad: { type: 'string', enum: ['alta', 'media', 'baja'] },
          por_que: { type: 'string' },
          fix: { type: 'string', description: 'el arreglo concreto (obligatorio si decision = aplicar)' },
          decision: { type: 'string', enum: ['aplicar', 'humano', 'seguimiento'] },
          razon: { type: 'string', description: 'por qué esa decisión, en una línea' },
        },
      },
    },
  },
}

const APPLIER_SCHEMA = {
  type: 'object',
  required: ['worktree', 'branch', 'aplicados', 'fallados', 'resumen'],
  properties: {
    worktree: { type: 'string', description: 'pwd absoluto' },
    branch: { type: 'string' },
    aplicados: { type: 'array', items: { type: 'string' }, description: 'títulos de los arreglos aplicados y commiteados' },
    fallados: {
      type: 'array',
      items: { type: 'object', properties: { titulo: { type: 'string' }, motivo: { type: 'string' } } },
      description: 'los que se revirtieron o no se pudieron aplicar, con el motivo',
    },
    resumen: { type: 'string' },
  },
}

// ---------------------------------------------------------------------------
// §3.12.2 — llamar(): agent() endurecido. Intento 1 byte-idéntico (preserva el
// cache del resume); intento 2 cache-bustea el label y exige verificar estado.
// ---------------------------------------------------------------------------
async function llamar(makePrompt, opts, intentos = 2) {
  for (let i = 1; i <= intentos; i++) {
    const prompt =
      i === 1
        ? makePrompt('')
        : makePrompt(
            `\n\n(REINTENTO ${i}: el intento anterior terminó sin reportar su resultado estructurado. Parte del trabajo puede estar YA HECHO — verificá el estado real antes de cada acción. Tu ÚLTIMO acto es SIEMPRE el reporte estructurado.)`
          )
    const o = i === 1 ? opts : { ...opts, label: `${opts.label}~r${i}` }
    try {
      const r = await agent(prompt, o)
      if (r) return r
      log(`⚠ ${opts.label}: intento ${i} devolvió null`)
    } catch (e) {
      log(`⚠ ${opts.label}: intento ${i} falló: ${String(e).slice(0, 160)}`)
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Validator (T económico, effort low): ejecuta y cuenta. Jamás opina. (§3.12.4)
//
// Autopsia cn-radar-al-dia-0921 (2026-09-21), dos correcciones:
//  - CADA comando lleva su `cd <donde> &&`: el cwd de Bash se resetea entre llamadas.
//    Un validator corrió bats desde la raíz del repo principal en vez del worktree del
//    PR, midió un rojo que no existía y pisó el verde del hook: 2 bloqueos falsos, ~2 h.
//  - Si el hook ya trae los tests (contrato §3.3), el validator los copia y NO corre
//    ninguna suite: 17 de 37 validadores re-corrían tests pesados por su cuenta.
// Cada árbol se mide UNA vez por corrida (§3.3): el validator reporta su id, el motor
// guarda la medición y, si el árbol ya está en la memoria, el validator saltea la
// medición y el motor completa con lo guardado.
// ---------------------------------------------------------------------------
// `esperado`: el árbol que el motor cree que hay en `donde` y ya tiene medido (el del
// gate de la issue para su PR, el del último PR mergeado para la integradora). Va UNO,
// nunca la lista de la memoria, y la comparación la hace el shell: si el modelo pudiera
// elegir un id de una lista, un error suyo le prestaría a un árbol rojo la medición de
// otro verde. El motor además acepta `ya_medido` solo si el árbol reportado es ése.
function medir(donde, faseTag, etiqueta, { conDiff = false, pull = false, esperado = null } = {}) {
  const en = `cd ${donde} &&`
  const tierUsado = tierEfectivo('validator', T, { testsDelHook })
  const conocido = esIdDeGit(esperado) && memoria.medicion(esperado) ? esperado : null
  // Con el árbol ya medido solo queda lo del diff; las dependencias hacen falta
  // únicamente si hay que correr los tests del diff (sin hook).
  const yaMedido = conocido
    ? `\n1a. ${en} case "$(git rev-parse 'HEAD^{tree}')" in ${conocido}) echo YA_MEDIDO ;; *) echo MEDIR ;; esac
   → si imprimió YA_MEDIDO y limpio es true: ya_medido = true, metrics = {}, tests_failed = 0, failing_test_files = [], lockfiles = [], y SALTEÁ ${
        conDiff && !A.validateHook ? 'los pasos 2 a 4 (el 1b sí, el 5 sí)' : conDiff ? 'los pasos 1b a 4 (el 5 sí)' : 'todos los pasos que siguen'
      }: el motor ya tiene esa medición. Si imprimió MEDIR, seguí normal y ya_medido = false.`
    : ''
  const hook = A.validateHook
    ? `2. ${en} ${A.validateHook} --json   (timeout 420000)
   → status distinto de 'ok' → reportá su campo error y status:'error'; NO sigas.
   → status:'ok' → copiá su objeto metrics tal cual.
   → si trae tests.failed (entero) y tests.failing_test_files (lista): tests_failed = tests.failed, failing_test_files = tests.failing_test_files tal cual, tests_fuente = 'hook', y SALTEÁ el paso 3: el hook ya corrió la suite.`
    : `2. ${en} <typecheck del repo> — autodetectá el runtime por el lockfile (timeout 420000).
   → reportá metrics = {"typecheck_errors": <conteo>}; si el comando crashea sin errores parseables: status:'error' (un output vacío JAMÁS es 0).`
  const suite = `3. ${A.validateHook ? "Solo si el paso 2 no te dio tests_fuente='hook': " : ''}${en} <suite de tests del repo> (timeout 420000) → tests_failed = conteo de tests fallidos, failing_test_files = paths de archivos de test con fallas, relativos a la raíz del repo; tests_fuente = 'suite'. Todo verde → 0 y lista vacía.`
  const diff = conDiff
    ? `5. Mecánica del diff contra origin/${RAMA} (timeout 120000):
   ${en} git fetch origin && git diff --name-only --no-renames origin/${RAMA}...HEAD
   → archivos_del_diff = esa lista tal cual; tests_del_diff = los que matchean ${JSON.stringify(A.testGlobs)}; diff_toca_tests = ¿hay alguno?
   → ${A.validateHook ? "si tests_fuente='hook': NO los corras, el motor deriva tests_del_diff_verdes de la salida del hook. Si no: " : ''}${en} <runner con SOLO los archivos de test del diff> → tests_del_diff_verdes = ¿todos verdes? (sin tests en el diff → false)`
    : ''
  const pre = pull ? `0. ${en} git fetch origin && git pull --ff-only origin ${RAMA}\n` : ''
  return llamar(
    (suf) => `Sos un MEDIDOR. Ejecutá EXACTAMENTE estos comandos en orden y reportá NÚMEROS por schema. No opines, no arregles nada, no edites ningún archivo (el paso 1b instala dependencias: eso sí).
Cada comando empieza con \`${en}\`: escribilo así en CADA llamada a Bash, porque el directorio no persiste entre llamadas y un comando corrido desde otro lado mide otro árbol.

${pre}1. ${en} git rev-parse --show-toplevel HEAD 'HEAD^{tree}' && git status --porcelain | head -5
   → la primera línea tiene que ser ${donde} (o su ruta real); otro repo → status:'error'. commit = la segunda línea y arbol = la tercera, copiadas TAL CUAL; limpio = ¿no salió nada después?${yaMedido}
1b. ${en} ${DEPS('.')}   (timeout 600000) → pone las dependencias iguales al lockfile; reinstala solo si cambió. Es lo único que este paso escribe, y solo en node_modules. Sale ≠ 0 → status:'error' con su salida en 'error'.
${hook}
${suite}
4. ${en} git ls-files -- ${GLOBS_LOCKFILE}   → lockfiles = una línea por entrada, tal cual (sin salida → lista vacía).
${diff}
Si un comando no puede correr: status:'error' con el mensaje en 'error'.${suf}`,
    { label: `validator:${etiqueta}`, phase: faseTag, model: M[tierUsado], effort: E.validator, agentType: OPERADOR, schema: MEDICION_SCHEMA }
  ).then((crudo) => {
    let r = crudo
    // La guarda del tier, sin llegar una medición tarde: si en T3 el hook no trajo los
    // tests, este medidor leyó la salida cruda del runner y su número no se usa.
    if (tierUsado === 'T3' && r?.status === 'ok' && !r.ya_medido && r.tests_fuente !== 'hook') {
      testsDelHook = false
      r = { ...r, status: 'error', error: 'medición en T3 sin los tests del hook (leyó la salida cruda del runner): se repite en T2' }
    }
    if (r?.ya_medido) {
      r =
        r.arbol === conocido
          ? (memoria.completar(r) ?? { ...r, status: 'error', error: `el medidor dijo "ya medido" sobre el árbol ${r.arbol} con cambios sin commitear` })
          : { ...r, status: 'error', error: `el medidor dijo "ya medido" sobre el árbol ${r.arbol}, que no es el esperado (${conocido ?? 'ninguno'})` }
    }
    // §3.3 — el contrato de metrics es CERRADO: solo las claves de la whitelist
    // (args.metricKeys, default typecheck_errors), CON o SIN hook. Un validator que
    // sobre-reporta claves extra (p.ej. los conteos de tests del paso 3 mezclados en
    // metrics por el baseline) hace exigir al ratchet métricas que las demás
    // mediciones nunca pidieron (y tests_passed invierte "menor es mejor").
    // Ya reincidió 2 veces (corrida 289-...-0720): normalizar SIEMPRE, en código.
    const KEYS = A.metricKeys ?? ['typecheck_errors']
    if (r && r.metrics) r.metrics = Object.fromEntries(KEYS.map((k) => [k, r.metrics[k]]))
    if (r) r.lockfiles_ajenos = lockfilesAjenos(r.lockfiles)
    // §3.3 (4.12.1) — con los tests del hook, los del diff no se re-corren: el hook ya
    // corrió la suite entera, así que un test del diff está verde si no figura entre los
    // rojos. La regla vive acá, no en el prompt. Sin tests en el diff → false, como antes.
    if (r && conDiff && r.tests_fuente === 'hook') {
      const delDiff = r.tests_del_diff ?? []
      r.tests_del_diff_verdes = delDiff.length > 0 && !delDiff.some((f) => (r.failing_test_files ?? []).includes(f))
    }
    // La guarda del tier (§3.1): Haiku mide solo cuando la última medición mostró
    // que el hook trae los tests; una que vuelve a 'suite' lo devuelve a T2.
    if (r?.status === 'ok' && !r.ya_medido) testsDelHook = Boolean(A.validateHook) && r.tests_fuente === 'hook'
    if (r && memoria.guardar(r)) log(`medición ${etiqueta}: árbol ${r.arbol.slice(0, 12)} guardado (${memoria.arboles().length} en memoria)`)
    else if (crudo?.ya_medido && r?.status === 'ok') log(`medición ${etiqueta}: árbol ${r.arbol.slice(0, 12)} ya medido — sin re-medir`)
    return r
  })
}

// §3.3 — "medición inválida nunca es éxito", pero tampoco es un rojo del código:
// antes de frenar (ABORT del baseline, merge-blocked del PR, reintento del
// implementer) se re-mide UNA vez. En 1018 un gate cayó por timeout del medidor y
// el PR quedó bloqueado con el código sano.
async function medirFirme(donde, faseTag, etiqueta, opciones = {}) {
  const m = await medir(donde, faseTag, etiqueta, opciones)
  if (m?.status === 'ok') return m
  log(`⚠ medición ${etiqueta} inválida (${m?.error ?? 'validator murió'}) → se re-mide una vez, entera`)
  return medir(donde, faseTag, `${etiqueta}~m2`, { ...opciones, esperado: null })
}

// ---------------------------------------------------------------------------
// Serializer (§3.2): ÚNICA vía de mutación remota. Check-then-act, secuencial.
// ---------------------------------------------------------------------------
const SERIALIZER_BASE = `Sos el SERIALIZADOR de mutaciones remotas (git-officer) del pipeline ${A.runLabel}. Sos IDEMPOTENTE: esta corrida puede ser una reanudación — antes de CADA acción verificás si ya está hecha (check-then-act); si ya está, constatás y seguís. La identidad del trabajo es su PR/issue, NO la branch (las branches se borran al mergear: chequeá PRs mergeados, no existencia de branch). Nunca implementás ni juzgás código.
PROHIBIDO: usar el tool Monitor, o terminar tu turno "esperando" algo — tu turno termina ÚNICAMENTE con el reporte estructurado emitido. Si esperás checks de CI: SOLO los requeridos por nombre (${JSON.stringify(A.requiredChecks)}; lista vacía = no esperes ninguno), con un loop foreground de Bash (timeout 600000); checks advisory se IGNORAN.
AUDIT LOG: por cada mutación que EJECUTES (no las constatadas) apendeá una línea a ${AUDIT_LOG}: "$(date -Iseconds) ${A.runLabel} <contexto> <accion> <resultado>" (mkdir -p si hace falta).\n\n`

// §3.17 — el CANDADO: con varios carriles, dos serializers podrían pedir mutar a la
// vez (publicar una issue mientras el carril de merge integra un PR). Todos pasan por
// acá, de a uno, en orden de llegada. No hay otra forma de llamar a un serializer.
const candado = crearCandado()
function serializar(tarea, etiqueta, faseTag, schema = SERIALIZER_SCHEMA) {
  const estados = schema.properties.status.enum.map((x) => `'${x}'`).join(' | ')
  return candado.con(() =>
    llamar((suf) => SERIALIZER_BASE + tarea + `\n\nDevolvé por schema: status (${estados}), pr_number si aplica, detalle (1-2 líneas).${suf}`, {
      label: `serializer:${etiqueta}`,
      phase: faseTag,
      model: M[tierEfectivo('serializer', T)],
      effort: E.serializer,
      agentType: OPERADOR,
      schema,
    })
  )
}

// ---------------------------------------------------------------------------
// Scout (§3.4b): TRANSPORTE, no juicio. El bucketing lo computa pipeline-read.sh
// sobre el grafo nativo de GitHub; acá sólo hace falta un turno con shell, porque
// el script del Workflow no tiene ninguna.
// ---------------------------------------------------------------------------
function scoutear(etiqueta, faseTag) {
  return llamar(
    (suf) => `Sos un TRANSPORTE (${etiqueta}, corrida ${A.runLabel}), no un analista. Corré EXACTAMENTE este comando y devolvé su salida por el output estructurado, tal cual:

cd ${REPO} && sh ${READ_CLI} scope '${SCOPE_ARG}' --rama ${RAMA} --base ${BASE} --label-ready ${A.labels.ready} --label-agent-pr ${A.labels.agentPr}${A.cuota ? ` --cuota ${A.cuota}` : ''}

El comando emite exactamente el schema que tenés que reportar (all_done, issues con su bucket y detalle, specs, y si aparecen base_por_integrar, paralelo y cuota, notas). Copialo: no re-bucketees, no "corrijas" un bucket que te parezca raro, no agregues issues, no opines sobre el código. Si sale con código distinto de 0, reportá issues vacío, all_done false y su stderr en 'notas'.${suf}`,
    { label: `scout:${etiqueta}`, phase: faseTag, model: M[tierEfectivo('scout', T)], effort: E.scout, agentType: OPERADOR, schema: SCOUT_SCHEMA }
  )
}

// ---------------------------------------------------------------------------
// merge-resolver (agentType del plugin): recomienda; el serializer ejecuta.
// ---------------------------------------------------------------------------
function resolver(packet, etiqueta, faseTag) {
  return llamar(
    (suf) => `${packet}

IMPORTANTE: reportá tu recomendación por el output estructurado (schema), no por XML. Vos NO pusheás, NO mergeás, NO llamás gh con mutaciones — si resolvés conflictos, dejá los archivos resueltos y commiteados LOCALMENTE en el worktree indicado.${suf}`,
    {
      label: `resolver:${etiqueta}`,
      phase: faseTag,
      model: M[T.resolver],
      effort: E.resolver,
      agentType: 'host-orchestrator:merge-resolver',
      schema: RESOLVER_SCHEMA,
    }
  )
}

// ===========================================================================
// FASE: Setup — rama integradora + worktree local de integración
// ===========================================================================
phase('Setup')
log(
  `▶ ${A.runLabel} — scope ${SCOPE_DESC} — rama ${RAMA} sobre ${BASE} — ` +
    `budget ${BUDGET_TOTAL ? Math.round(BUDGET_TOTAL / 1000) + 'k de output' : 'SIN TOPE'}` +
    `${A.budgetTotal ? ' (por args)' : budget.total ? ' (por directiva)' : ''} — ts=${A.ts}`
)
log(`tiers: ${Object.keys(TIER_DEFAULT).map((r) => `${r}=${T[r]}→${M[T[r]]}`).join(' ')} (validator en T3 solo con los tests del hook)`)
log(`efforts: ${Object.entries(E).map(([r, e]) => `${r}=${e}`).join(' ')} — hasta ${MAX_P} carril(es)${A.cuota ? `, vigía de cuota sobre ${A.cuota}` : ''}`)

const ETIQUETAS_DEL_MOTOR = ['agent-blocked', 'merge-blocked', 'review-fix', 'pipeline-revisado']
const setup = await serializar(
  `Preparar la rama integradora del pipeline:
1. cd ${REPO} && git fetch origin
2. CHECK: ¿existe origin/${RAMA}? → si no: git branch ${RAMA} origin/${BASE} && git push -u origin ${RAMA} (contexto audit: setup)
3. CHECK: ¿existe el worktree local ${WT_INTEGRACION}? → si existe: dentro de él git pull --ff-only. Si no:
   a. Si la branch ${RAMA} ya está checkouteada en OTRO worktree (git worktree list; típico: el path de versiones anteriores del motor, sin el prefijo wf_), movelo: git worktree move <ese path> ${WT_INTEGRACION}.
   b. Si no: git worktree add ${WT_INTEGRACION} ${RAMA} (trackeando origin/${RAMA}).
4. ${DEPS(WT_INTEGRACION)}   → deja las dependencias iguales al lockfile (reinstala solo si cambió). Sale ≠ 0 → status 'blocked' con su salida.
5. cd ${WT_INTEGRACION} && sh ${READ_CLI} push-auth   → imprime un JSON de una línea (cómo se autentica el push a origin; nunca imprime el token): copialo TAL CUAL en el campo token.
6. cd ${REPO} && gh label list --limit 300 --json name --jq '.[].name'   → para cada una de ${ETIQUETAS_DEL_MOTOR.join(', ')} que NO aparezca: gh label create <nombre> (contexto audit: setup-labels).
7. cd ${WT_INTEGRACION} && git rev-parse HEAD 'HEAD^{tree}'   → commit = la primera línea, arbol = la segunda, TAL CUAL.`,
  'setup-rama',
  'Setup',
  SETUP_SCHEMA
)
if (!setup || setup.status === 'blocked') {
  log(`✖ setup falló: ${setup?.detalle ?? 'serializer murió'} — ABORT`)
  return { status: 'ABORT', fase: 'setup', detalle: setup?.detalle ?? 'serializer murió' }
}

// §3.16 — lo que el token no puede publicar se veda de entrada (prompt + gate).
const vetoPush = vetoDeWorkflows(setup.token)
const VEDADOS = vetoPush.vedar ? [...new Set([...A.denyPaths, VETO_WORKFLOWS])] : A.denyPaths
log(`push: ${vetoPush.motivo}${vetoPush.vedar ? ` → ${VETO_WORKFLOWS} vedado` : ''}`)
const DENY = VEDADOS.length
  ? `\nPATHS VEDADOS (ratchets/guards del repo y lo que el token de push no puede publicar — NO los toques ni "mejores" nada ahí; el gate rechaza un diff que los toque): ${VEDADOS.join(', ')}`
  : ''
const registro = crearRegistro()
const memoria = crearMemoria()

// ===========================================================================
// DESPACHO CONTINUO (§3.17)
//
// Tres carriles alimentados por un despachador:
//  - implementación: hasta P issues a la vez, cada una en su worktree, desde el
//    commit de la integradora que estaba vigente al despacharla;
//  - merge: serial, un PR por vez; integrar = actualizar la rama y, si el árbol que
//    queda ya está medido en verde, mergear en el mismo agente;
//  - revisión: serial, un revisor + un aplicador por PR mergeado; los arreglos salen
//    como PR nuevo a la cola de merge.
// Cada vez que algo termina, el despachador vuelve a leer GitHub (scout) y llena los
// carriles libres. No hay barrera: una implementación de 70 min no frena a nadie.
// El estado sale de GitHub en cada vuelta y toda mutación es check-then-act, así que
// matar y relanzar no rehace lo publicado.
// ===========================================================================
const trabajos = [] // un registro por implementación
const mergesReporte = []
const revisiones = [] // un registro por PR revisado: qué encontró el revisor, qué aplicó el aplicador
const bugsReales = []
const bloqueadas = []
const pendientes = []
// Issues con PR mergeado a la integradora → `Closes #` y lista del PR final: n → { titulo, pr }.
const cerradas = new Map()
const anotarCerrada = (n, titulo, pr) => cerradas.set(n, { titulo: titulo ?? cerradas.get(n)?.titulo, pr: pr ?? cerradas.get(n)?.pr })
const seguimientos = []
const humanos = []
const avisos = [] // cosas que el motor vio salir mal y no puede deshacer
const specsDelScope = new Set()
let inReviewUltimo = []
let allDone = false
let fatal = null
let sinBudget = false
let P = MAX_P

const timbre = crearTimbre()
const vigia = crearVigia(A.cuotaUmbrales ?? {})
const enVuelo = new Set() // issues implementándose
const colaMerge = []
const enMerge = new Set() // claves pr<M> en la cola o integrándose
const colaRevision = []
const revisadosEnCorrida = new Set()
// PR de arreglos → PR revisado, y la revisión en espera de que esos arreglos entren
// (o queden para Leo) para registrarse y llevar la etiqueta pipeline-revisado.
const arregloDe = new Map()
const revisionPorArreglo = new Map()
let carrilMerge = null
let carrilRevision = null
// Reloj lógico: cada trabajo que termina avanza `eventos`. Una foto del scout pedida
// antes de que algo termine puede mostrarlo en su estado viejo; `terminoEn` deja
// reconocer esas entradas y no actuar sobre ellas.
let eventos = 0
const terminoEn = {}
let refrescos = 0
let baseMovida = true
let base = null // { commit, arbol, metricas } — la integradora vigente, medida
// Mientras el carril de merge puede estar moviendo la integradora (un integrar que
// mergea, un refresh) y todavía no fijó la base nueva, no se despacha nada: un scout
// de ese momento puede ver un bloqueante DONE con `base` todavía sin su código, y la
// dependiente saldría de una base que no lo tiene (revisión de 4.16.0).
let integradoraEnMovimiento = 0
async function moviendoIntegradora(fn) {
  integradoraEnMovimiento++
  try {
    return await fn()
  } finally {
    integradoraEnMovimiento--
  }
}
// El árbol que el motor midió (y aprobó) para cada PR: el del gate de su issue, el de
// los arreglos de una revisión, o el que midió al integrarlo. Es el `esperado` de la
// próxima integración: si el árbol actualizado da ése, se mergea sin volver a medir.
const arbolPorPr = new Map()

const presupuestoOk = () => !BUDGET_TOTAL || restante() >= A.minBudgetWave
const algoEnVuelo = () => enVuelo.size > 0 || carrilMerge !== null || carrilRevision !== null || colaMerge.length > 0 || colaRevision.length > 0

const registrarScout = (s) => {
  for (const x of s?.specs ?? []) specsDelScope.add(x)
  for (const i of s?.issues ?? []) if (i.bucket === 'DONE') anotarCerrada(i.number, i.title, i.pr_number)
}

function terminar(clave) {
  terminoEn[clave] = ++eventos
  timbre.avisar()
}

// Un trabajo suelto: corre sin bloquear al despachador y, pase lo que pase, avisa al
// terminar. Ningún error de un carril tira la corrida entera.
function suelto(clave, fn) {
  return fn()
    .catch((e) => log(`⚠ ${clave}: ${String(e).slice(0, 200)}`))
    .finally(() => terminar(clave))
}

// La integradora vigente. `confirmado`: el mismo agente reportó, de la salida del shell,
// que el árbol mergeado es el aprobado y que la integradora quedó en ése (con squash
// son el mismo). Ahí la base sale de la memoria sin despachar a nadie. Si no, se mide,
// declarando como esperado lo que el serializer dijo: el shell del medidor lo verifica.
// `vigilar`: el cambio no pasó por la aprobación del motor (un merge no confirmado). Si
// la integradora quedó peor que antes, la corrida se frena: adoptar esa medición como
// base haría que ningún gate posterior vea la regresión.
async function fijarBase(commit, arbol, etiqueta, { confirmado = false, vigilar = false } = {}) {
  const conocida = confirmado && esIdDeGit(arbol) ? memoria.medicion(arbol) : null
  if (conocida && esIdDeGit(commit)) {
    base = { commit, arbol, metricas: aBaseline(conocida) }
    log(`base ${etiqueta}: árbol ${arbol.slice(0, 12)} ya medido — sin re-medir`)
    return true
  }
  const med = await medirFirme(WT_INTEGRACION, 'Merge', `base-${etiqueta}`, { pull: true, esperado: arbol })
  if (med?.status !== 'ok') {
    log(`⚠ base ${etiqueta} inválida (${med?.error ?? 'validator murió'})${base ? ' — los gates siguen contra la anterior' : ''}`)
    return false
  }
  if (vigilar && base) {
    const g = gate(med, base.metricas, { exigirTests: false })
    if (!g.pass) {
      fatal = `la integradora empeoró con un merge que el motor no aprobó (${etiqueta}): ${g.motivos.join('; ')}`
      avisos.push(fatal)
      log(`■ ${fatal} — no se despacha nada más; Leo tiene que mirar`)
    }
  }
  base = { commit: med.commit, arbol: med.arbol, metricas: aBaseline(med) }
  log(
    `base ${etiqueta}: ${Object.entries(med.metrics).map(([k, v]) => `${k}=${v}`).join(' ')} testsRojos=${med.tests_failed}` +
      ` (tests por ${med.tests_fuente ?? '?'})${med.lockfiles_ajenos.length ? ` lockfilesAjenos=${med.lockfiles_ajenos.join(',')}` : ''}`
  )
  return true
}

// --- Marcar para Leo (§3.16): etiqueta + comentario + lista de bloqueadas -----
// El registro queda "bloqueado por el motor" solo si la etiqueta se puso: así,
// si después alguien la saca, la vuelta del trabajo es un hecho nuevo.
async function marcarIssue(n, motivo, fase, worktree) {
  const r = await serializar(
    `La issue #${n} queda para Leo: ${motivo}.
1. CHECK: si la issue ya tiene la etiqueta agent-blocked y un comentario de la corrida ${A.runLabel} con este motivo: 'ya_estaba' y TERMINÁ.
2. Etiqueta y comentario, con este comando tal cual y entero (el motivo va entre comillas simples: el shell no interpreta nada de lo que dice) (contexto audit: issue-${n}-blocked):
   ${comandoDeMarcarIssue({ repo: REPO, issue: n, comentario: `pipeline ${A.runLabel}: ${motivo}.${worktree ? ` Worktree conservado: ${worktree}` : ''}` })}${
      worktree ? `\n3. CONSERVÁ el worktree ${worktree}: tiene el trabajo commiteado y no está en ningún otro lado. No lo limpies.` : ''
    }`,
    `block-i${n}`,
    fase
  )
  if (r && r.status !== 'blocked') registro.bloqueado(`i${n}`, { ultimo: motivo })
  bloqueadas.push(`#${n} ${motivo}${worktree ? ` (worktree: ${worktree})` : ''}`)
  return r
}

// Devuelve { mergeado: true } si GitHub reporta el PR MERGED: entonces no se marcó
// nada, y quien llama decide cómo darlo por integrado.
async function marcarPr(prNum, motivo, fase, { conservar = null } = {}) {
  const comentario = `${motivo} (pipeline ${A.runLabel})${conservar ? ` — worktree conservado, si quedó: ${conservar}` : ''}`
  const r = await serializar(
    `El PR #${prNum} queda para Leo: ${motivo}.
1. Etiqueta y comentario, con este comando tal cual y entero: los pone solo si GitHub no reporta el PR como MERGED (contexto audit: pr-${prNum}-blocked).
   ${comandoDeMarcarPr({ repo: REPO, pr: prNum, comentario })}
   → salida = la última línea que imprimió, tal cual.
   → YA_MERGEADO: el PR ya entró; no se etiqueta ni se comenta por ninguna otra vía. status 'ya_estaba' y TERMINÁ.
   → MARCADO: hacé el paso 2 y reportá status 'ok'. Cualquier otra salida (ESTADO_ILEGIBLE, un error de gh): status 'blocked' con esa salida tal cual.
2. ${conservar ? `Si existe el worktree ${conservar}, CONSERVALO: es la evidencia, o el único lugar donde vive el trabajo.` : `Si existe el worktree ${wtDePr(prNum)}, limpialo (git worktree remove --force + git worktree prune).`}`,
    `block-pr${prNum}`,
    fase,
    MARCA_PR_SCHEMA
  )
  if (r?.status === 'ya_estaba' && r.salida === 'YA_MERGEADO') {
    log(`PR #${prNum}: GitHub lo reporta MERGED — no se marca para Leo (iba a quedar por: ${motivo})`)
    return { ...r, mergeado: true }
  }
  if (r && r.status !== 'blocked') registro.bloqueado(`pr${prNum}`, { ultimo: motivo })
  mergesReporte.push({ pr: prNum, resultado: 'merge-blocked', motivo })
  if (arregloDe.has(prNum)) {
    humanos.push({ titulo: `los arreglos de la revisión del PR #${arregloDe.get(prNum)} (PR #${prNum}) quedaron merge-blocked`, decision_necesaria: motivo })
    await cerrarRevisionDeArreglos({ pr: prNum, de: arregloDe.get(prNum) }, `bloqueados, para Leo (merge-blocked: ${motivo})`)
  }
  return r
}

// ---------------------------------------------------------------------------
// Carril de implementación
// ---------------------------------------------------------------------------
async function implementarConGate(iss, b) {
  const tier = A.issueTiers?.[String(iss.number)] ?? T.implementer
  const esfuerzo = effortDeIssue(iss.number)
  const desde = esIdDeGit(b?.commit) ? b.commit : `origin/${RAMA}`
  // Una branch por intento (§3.16): la del intento anterior sigue en su worktree conservado.
  const intento = registro.dato(`i${iss.number}`)?.intentos ?? 1
  const branch = intento > 1 ? `issue-${iss.number}-v${intento}` : `issue-${iss.number}`
  log(`dispatched implementer:#${iss.number} (${tier}→${M[tier]}, effort ${esfuerzo}) desde ${desde.slice(0, 12)}${intento > 1 ? ` — intento ${intento}, branch ${branch}` : ''}`)
  const impl = await llamar(
    (suf) => `Implementá la issue #${iss.number} ("${iss.title}") del repo en tu worktree AISLADO (tu cwd). No salgas de él.

PASO 0 (obligatorio — la base la fija el motor y se toma del REMOTO, §3.11):
  git fetch origin && git checkout -B ${branch} ${desde}
  ${DEPS('.')}   (deja las dependencias iguales al lockfile; reinstala solo si cambió)
  Si tu slice cambia dependencias: ${REGLA_DEPS}
PASO 1: leé el contrato — es el BODY del ticket: gh issue view ${iss.number} (gh solo LECTURA: prohibida toda mutación remota).
PASO 2: subí la escalera de intención: sh ${READ_CLI} intent ${iss.number} --dir ${REPO}
  Te devuelve, del spec padre, el '## Out of Scope' (lo que NO tenés que construir) y el '## Testing Decisions' con los SEAMS pre-acordados —testeá ahí y no donde te resulte cómodo—, más el índice de ADRs y la rama del prototipo si hay. Abrí solo lo que tu slice consume.
PASO 3: implementá el slice vertical con tu disciplina TDD completa (roja→verde por criterio de aceptación).${DENY}
PASO 4: verificate con el typecheck y los tests de TU ÁREA: los archivos de test que agregaste o tocaste y los del módulo que cambiaste. La suite completa NO: la corre un medidor aparte apenas terminás, y esperarla minutos vence la caché de tu contexto (en 1017b, 32 reescrituras de 200-300K tokens). Las pruebas contra proveedores o recursos reales que el repo pide al tocar algo (lo dice su CLAUDE.md; por ejemplo, una variable que las habilita) sí son tuyas: el medidor no las corre.
PASO 5: git add -A && git commit (mensaje descriptivo). NO pushees, NO gh pr create — el pipeline publica por vos.
Si un error destapa un BUG REAL preexistente: NO lo arregles, anotalo en bugs_reales.
Si el ticket es inimplementable/ambiguo: explicalo en 'bloqueado' y NO inventes.
Todo recurso vivo que tu slice nombre (tabla, endpoint, topic, variable de entorno) va verificado contra el recurso REAL desde este worktree, y cada verificación se reporta en 'recursos_verificados' con CÓMO la hiciste y CUÁNDO. Si no llegás al recurso: 'bloqueado' con RESOURCE_UNREACHABLE, no un mock que finge.

DISCIPLINA DE CONTEXTO (no es cosmético: tu contexto se re-envía entero en CADA turno, así que
lo que arrastrás lo pagás N veces — medido 2026-07-27: un implementer de 269 turnos costó 79M de
tokens leídos, más que 13 reviewers juntos):
  - Corré typecheck y tests con el reporter MÁS SILENCIOSO que tenga el runner (p.ej. --reporter=dot,
    -q, --quiet) y filtrá la salida a lo accionable (\`| tail -40\`, \`grep -A5 -i 'fail\\|error'\`).
    NUNCA vuelques suites verdes completas ni logs de build enteros.
  - Mientras iterás en rojo, corré SOLO los tests del archivo/área que estás tocando.
  - No releas un archivo que ya leíste: editá con el contenido que ya tenés en contexto.
  - No hagas \`cat\` de archivos largos ni \`git diff\` completos para "chequear": leé rangos.

Reportá por el output estructurado (schema; no XML): worktree = pwd absoluto, branch, resumen, bugs_reales, bloqueado.${suf}`,
    {
      label: `implementer:#${iss.number}`,
      phase: 'Despacho',
      model: M[tier],
      effort: esfuerzo,
      isolation: 'worktree',
      agentType: IMPLEMENTER,
      schema: IMPL_SCHEMA,
    }
  )
  if (!impl) return { issue: iss.number, gate: 'ERROR', motivos: ['implementer murió'] }
  if (impl.bloqueado) return { issue: iss.number, gate: 'FAIL', motivos: [`ticket: ${impl.bloqueado}`], impl }

  let med = await medirFirme(impl.worktree, 'Despacho', `i${iss.number}`, { conDiff: true })
  let g = gate(med, b.metricas, { vedados: VEDADOS })
  // Si el gate no pudo medir, reintentar al implementer es mandarlo a arreglar el medidor.
  if (g.deMedicion) return { issue: iss.number, titulo: iss.title, gate: 'MEDICION', motivos: g.motivos, impl }
  if (!g.pass) {
    if (med?.arbol) memoria.olvidar(med.arbol)
    log(`gate FAIL #${iss.number} (${g.motivos.join(' | ')}) → reintento 1/1`)
    await llamar(
      (suf) => `Sos el implementer de la issue #${iss.number} en tu SEGUNDO y ÚLTIMO intento. Tu trabajo está en ${impl.worktree} (branch ${impl.branch}): ése es tu worktree, no tu cwd, así que cada comando empieza con \`cd ${impl.worktree} &&\`.
El gate (comparación numérica contra la integradora de la que partiste) falló por:
${g.motivos.map((m) => `  - ${m}`).join('\n')}
Corregí ESO con las mismas reglas (solo tu slice, TDD, sin mutaciones remotas, tests de tu área y no la suite completa, commit local al final).
Reportá por el output estructurado (schema; no XML): worktree = ${impl.worktree}, branch, resumen.${suf}`,
      { label: `retry:#${iss.number}`, phase: 'Despacho', model: M[tier], effort: esfuerzo, agentType: IMPLEMENTER, schema: IMPL_SCHEMA }
    )
    med = await medirFirme(impl.worktree, 'Despacho', `i${iss.number}-retry`, { conDiff: true })
    g = gate(med, b.metricas, { vedados: VEDADOS })
    if (g.deMedicion) return { issue: iss.number, titulo: iss.title, gate: 'MEDICION', motivos: g.motivos, impl }
    if (!g.pass && med?.arbol) memoria.olvidar(med.arbol)
  }
  log(`gate ${g.pass ? 'PASS' : 'FAIL'} #${iss.number}${g.pass ? '' : ` (${g.motivos.join(' | ')})`}`)
  return { issue: iss.number, titulo: iss.title, gate: g.pass ? 'PASS' : 'FAIL', motivos: g.motivos, impl, arbol: g.pass ? med.arbol : null }
}

const PIE_DE_PR = `PR del pipeline ${A.runLabel}. 🤖 Generated with [Claude Code](https://claude.com/claude-code)`

async function publicarIssue(r) {
  const recursos = r.impl.recursos_verificados ?? []
  // El cuerpo lo arma el motor; el serializer lo publica tal cual, por archivo.
  const cuerpo = [
    `Closes #${r.issue}`,
    '',
    r.impl.resumen ?? '',
    // Es el anclaje a evidencia real: cómo se verificó y cuándo.
    ...(recursos.length ? ['', '## Recursos verificados', ...recursos.map((v) => `- ${v}`)] : []),
    '',
    PIE_DE_PR,
  ].join('\n')
  const comando = comandoDePublicarPr({ worktree: r.impl.worktree, branch: r.impl.branch, base: RAMA, labels: [A.labels.agentPr], titulo: r.titulo ?? `issue #${r.issue}`, cuerpo })
  const publicar = (intento, extra = '') =>
    serializar(
      `Publicar el trabajo de la issue #${r.issue} (worktree ${r.impl.worktree}, branch ${r.impl.branch}):
1. CHECK identidad de trabajo: ¿hay PR (abierto O mergeado) de la branch ${r.impl.branch}? → mergeado: 'ya_estaba'; abierto: constatá que esté al día y saltá a 4.
2. Push y PR, con este comando tal cual y entero (título y cuerpo ya armados, entre comillas simples y por archivo: el shell no interpreta nada de lo que dicen) (contexto audit: issue-${r.issue}-pr-create):
   ${comando}
3. VERIFICÁ: gh pr view ${r.impl.branch} --json number,state → el PR existe; su número va en pr_number.
4. Si el PR quedó abierto sin problemas: limpiá el worktree OBLIGATORIAMENTE (git worktree remove --force + git worktree prune) — un checkout residual de la branch bloquea el worktree del merge. Solo conservalo si el push o el PR fallaron.
Si el push o el PR fallan: status 'blocked' con el mensaje de error TAL CUAL en detalle.${extra}`,
      intento === 1 ? `publish-i${r.issue}` : `publish-i${r.issue}~p${intento}`,
      'Despacho'
    )
  let pub = await publicar(1)
  // §3.16 — a lo sumo UN reintento, y de la publicación sola: el trabajo ya está
  // hecho y medido. Lo que rechaza el remoto dos veces no lo arregla reimplementar.
  if (pub?.status === 'blocked') {
    log(`publish #${r.issue}: blocked (${pub.detalle}) → reintento de solo la publicación`)
    pub = await publicar(2, `\n\nINTENTO 2 de la publicación: el anterior terminó 'blocked' (${pub.detalle}). El trabajo ya está commiteado en el worktree: no se reimplementa nada. Verificá qué quedó hecho (push, PR) antes de cada paso y completá solo lo que falta.`)
  }
  log(`publish #${r.issue}: ${pub?.status ?? 'serializer murió'} ${pub?.pr_number ? `→ PR #${pub.pr_number}` : ''}`)
  if (pub?.status === 'blocked') {
    // Si Leo la destraba (arregla el token, por ejemplo), corresponde volver a publicar
    // este worktree, no reimplementar: queda anotado.
    registro.anotar(`i${r.issue}`, { publicable: { titulo: r.titulo, impl: r.impl, arbol: r.arbol } })
    await marcarIssue(r.issue, `publicación bloqueada dos veces: ${pub.detalle}`, 'Despacho', r.impl.worktree)
    return
  }
  if (pub?.pr_number && esIdDeGit(r.arbol)) arbolPorPr.set(pub.pr_number, r.arbol)
  // Publicado, el worktree se limpia: un comentario posterior ya no puede nombrarlo.
  registro.anotar(`i${r.issue}`, { ultimo: pub ? `publicado (${pub.status})` : 'la publicación no devolvió resultado', ...(pub ? { worktree: null, publicable: null } : {}) })
}

function despacharIssue(iss) {
  const n = iss.number
  const b = base // la integradora de la que parte, y contra la que la mide su gate
  enVuelo.add(n)
  registro.intento(`i${n}`, { ultimo: 'el implementer no devolvió resultado' })
  suelto(`i${n}`, async () => {
    try {
      // Destrabada una publicación bloqueada, se republica su worktree: el trabajo ya
      // estaba hecho y medido (al integrarlo, el motor vuelve a mirar la no-regresión).
      const p = registro.dato(`i${n}`)?.publicable
      if (p) log(`#${n} destrabada: se republica el worktree conservado ${p.impl.worktree}, sin reimplementar`)
      const r = p ? { issue: n, titulo: p.titulo, gate: 'PASS', motivos: [], impl: p.impl, arbol: p.arbol } : await implementarConGate(iss, b)
      trabajos.push({ issue: r.issue, gate: r.gate, motivos: r.motivos })
      bugsReales.push(...(r.impl?.bugs_reales ?? []).map((x) => `[#${r.issue}] ${x}`))
      if (r.impl?.worktree) registro.anotar(`i${n}`, { worktree: r.impl.worktree })
      if (r.gate === 'PASS') await publicarIssue(r)
      else if (r.gate === 'FAIL') await marcarIssue(n, `gate FAIL tras el reintento: ${(r.motivos ?? []).join('; ')}`, 'Despacho', r.impl?.worktree)
      else if (r.gate === 'MEDICION') await marcarIssue(n, `el medidor no pudo medir (problema del medidor, no del código): ${(r.motivos ?? []).join('; ')}`, 'Despacho', r.impl?.worktree)
      else registro.anotar(`i${n}`, { ultimo: (r.motivos ?? []).join('; ') })
    } finally {
      enVuelo.delete(n)
    }
  })
}

// ---------------------------------------------------------------------------
// Carril de merge (serial)
// ---------------------------------------------------------------------------
async function refrescar() {
  const n = refrescos + 1
  const r = await serializar(
    `Refresh de la rama integradora: traer origin/${BASE} a ${RAMA} (merge, nunca rebase).
1. cd ${WT_INTEGRACION} && git fetch origin && git pull --ff-only origin ${RAMA}
2. cd ${WT_INTEGRACION} && git merge --no-edit origin/${BASE}
   - Sin conflicto (o ya al día): push si hubo merge nuevo (contexto audit: refresh-${n}) y status 'ok' (o 'ya_estaba').
   - CON CONFLICTO: NO resuelvas. git merge --abort y status 'blocked' con la lista de archivos en conflicto en detalle.
3. cd ${WT_INTEGRACION} && git rev-parse HEAD 'HEAD^{tree}' → commit_integracion = la primera línea, arbol_integracion = la segunda, TAL CUAL.`,
    `refresh-${n}`,
    'Merge',
    REFRESCO_SCHEMA
  )
  refrescos++
  baseMovida = false
  if (r?.status === 'blocked') {
    log(`refresh ${n} conflictúa (${r.detalle}) → merge-resolver`)
    const v = await resolver(
      `## Workspace
Worktree: ${WT_INTEGRACION} (rama ${RAMA}, worktree local de integración). Tarea: mergear origin/${BASE} en ${RAMA}.
Corré vos: cd ${WT_INTEGRACION} && git merge origin/${BASE} — y resolvé los conflictos EN LOS ARCHIVOS.

## Intent packet
Rama integradora del pipeline ${A.runLabel} (scope ${SCOPE_DESC}): acumula los PRs de las issues del scope. ${BASE} trae trabajo externo al pipeline. Criterio: preservar AMBAS intenciones; ante incompatibilidad semántica real, ABORT + INCOMPATIBLE.

## Conflicto reportado
${r.detalle}`,
      `refresh-${n}`,
      'Merge'
    )
    if (v?.action !== 'MERGE' || v.resolution === 'INCOMPATIBLE') {
      fatal = `refresh ${BASE}→${RAMA} incompatible: ${v?.resumen ?? 'resolver murió'}`
      log(`■ ${fatal} — no se despacha nada más; Leo tiene que mirar`)
      return
    }
    const push = await serializar(
      `El merge-resolver dejó resuelto y commiteado el merge de origin/${BASE} en ${WT_INTEGRACION}. Verificá que el merge esté cerrado (sin conflict markers, working tree limpio) y pusheá ${RAMA} (contexto audit: refresh-resolved-${n}). Si el árbol NO está limpio: status 'blocked'. Al final: cd ${WT_INTEGRACION} && git rev-parse HEAD 'HEAD^{tree}' → commit_integracion, arbol_integracion TAL CUAL.`,
      `refresh-push-${n}`,
      'Merge',
      REFRESCO_SCHEMA
    )
    if (!push || push.status === 'blocked') {
      fatal = `refresh resuelto sin publicar: ${push?.detalle ?? 'serializer murió'}`
      log(`■ ${fatal}`)
      return
    }
    await fijarBase(push.commit_integracion, push.arbol_integracion, `refresh-${n}`)
    return
  }
  if (r) await fijarBase(r.commit_integracion, r.arbol_integracion, `refresh-${n}`)
}

function promptIntegrar(item, aprobado) {
  const wt = wtDePr(item.pr)
  return `Integrar el PR #${item.pr} (branch ${item.branch}${item.esFix ? `, arreglos de la revisión del PR #${item.de}` : `, issue #${item.issue}`}) a ${RAMA}. Las decisiones ya las tomó el motor: están en los pasos 3 y 5 como comandos de shell que imprimen qué hacer. Vos ejecutás lo que imprimen y verificás contra GitHub.
1. cd ${REPO} && git fetch origin   (si git dice que otro proceso tiene un lock, esperá unos segundos y repetilo una vez)
2. CHECK: gh pr view ${item.pr} --json state → si ya dice MERGED: hacé el paso 6, status 'ya_estaba', mergeado true, y TERMINÁ.
3. Worktree del PR en ${wt} — EXACTAMENTE ese path (el medidor mide ahí):
   a. Si ya existe: cd ${wt} && git pull --ff-only origin ${item.branch} (si falla: status 'blocked' con el error).
   b. Si no existe, liberá la branch si quedó checkouteada en otro worktree (un leftover del implementer), con este comando tal cual:
      cd ${REPO} && W=$(git worktree list --porcelain | awk -v b="branch refs/heads/${item.branch}" '/^worktree /{w=substr($0,10)} $0==b{print w}'); if [ -z "$W" ]; then echo LIBRE; elif [ -z "$(git -C "$W" status --porcelain)" ] && git merge-base --is-ancestor "$(git -C "$W" rev-parse HEAD)" origin/${item.branch}; then git worktree remove --force "$W" && git worktree prune && echo LIBERADA; else echo "OCUPADA $W"; fi
      → OCUPADA: ese worktree tiene trabajo que no está en el remoto. NO lo toques: status 'blocked' con esa línea.
   c. Si no existe: git worktree add ${wt} ${item.branch}
4. cd ${wt} && git merge --no-edit origin/${RAMA} → CON conflicto: git merge --abort, status 'conflicto' con los archivos en detalle, y TERMINÁ. NO resuelvas.
5. cd ${wt} && git status --porcelain | head -5 && case "$(git rev-parse 'HEAD^{tree}')" in ${aprobado ?? 'NINGUNO'}) echo MERGEAR ;; *) echo NO_MERGEAR ;; esac && git rev-parse 'HEAD^{tree}'
   → arbol = la última línea, TAL CUAL; limpio = ¿el status --porcelain no imprimió nada?
   → Si imprimió MERGEAR y limpio es true, este comando, tal cual, con timeout 300000 (push, soltar la branch y mergear exactamente ese commit; si una parte falla, no sigue; si GitHub todavía no recalculó el PR, espera y reintenta él solo):
      bash ${MERGEAR_CLI} ${wt} ${REPO} ${RAMA} ${item.pr} ${item.branch}
      (contexto audit: pr-${item.pr}-merge). Su última línea decide: MERGEADO → hacé el paso 6, status 'ok', mergeado true. NO_MERGEADO → status 'blocked' con el error que imprimió, tal cual; no reintentes el merge por tu cuenta.
   → Si imprimió NO_MERGEAR (o limpio es false): NO pushees ni mergees. status 'ok', mergeado false: el motor mide ese árbol y decide.
6. cd ${WT_INTEGRACION} && git pull --ff-only origin ${RAMA} && git rev-parse HEAD 'HEAD^{tree}' → commit_integracion = la primera línea, arbol_integracion = la segunda, TAL CUAL.`
}

// Después de un merge. `confirmado`: el agente reportó, del shell, que mergeó el árbol
// aprobado y que la integradora quedó en ése; ahí la base sale de la memoria. Si no
// —un árbol que no era el aprobado, o un 'ya_estaba' que el motor no esperaba—, la
// base se mide y se vigila: si la integradora empeoró, la corrida se frena.
async function integrado(item, r, aprobado) {
  const confirmado = r.status === 'ok' && aprobado !== null && r.arbol === aprobado && r.arbol_integracion === aprobado
  if (!confirmado && r.status === 'ok') {
    const aviso = `PR #${item.pr}: el agente mergeó el árbol ${r.arbol}, que no es el aprobado por el motor (${aprobado ?? 'ninguno'})`
    avisos.push(aviso)
    log(`⚠ ${aviso}`)
  }
  log(`merge PR #${item.pr}: ${r.status}`)
  mergesReporte.push({ pr: item.pr, resultado: r.status === 'ya_estaba' ? 'ya_estaba' : 'mergeado' })
  registro.anotar(`pr${item.pr}`, { ultimo: `merge ${r.status}` })
  if (!item.esFix) anotarCerrada(item.issue, item.titulo, item.pr)
  await fijarBase(r.commit_integracion, r.arbol_integracion, `pr${item.pr}`, { confirmado, vigilar: !confirmado })
  if (item.esFix) await cerrarRevisionDeArreglos(item, `mergeados en el PR #${item.pr}`)
  else encolarRevision({ pr: item.pr, issue: item.issue, titulo: item.titulo })
}

async function integrarPr(item) {
  const clave = `pr${item.pr}`
  const wt = wtDePr(item.pr)
  // Con la corrida frenada no se registra el intento: un PR sano que vuelve en la foto
  // siguiente no es "una repetición sin hecho nuevo" para marcarle a Leo.
  if (fatal) return
  if (baseMovida) await moviendoIntegradora(refrescar)
  if (fatal) return
  registro.intento(clave, { ultimo: 'integración empezada y no terminada' })
  // Un PR que GitHub reporta MERGED no queda para Leo: entró —lo mergeó el agente sin
  // reportarlo, o alguien a mano— y se da por integrado como un merge que el motor no
  // aprobó: la base se mide y se vigila. Desde que empieza la marca hasta fijar esa base
  // la integradora está en movimiento: un scout de ese hueco vería al bloqueante DONE.
  const paraLeo = (motivo) =>
    moviendoIntegradora(async () => {
      const m = await marcarPr(item.pr, motivo, 'Merge', { conservar: wt })
      if (m?.mergeado) await integrado(item, { status: 'ya_estaba' }, null)
    })
  for (let intento = 1; intento <= 3; intento++) {
    const aprobado = base ? arbolAprobado(memoria, base.metricas, arbolPorPr.get(item.pr)) : null
    // Mientras corre un integrar que puede mergear, y hasta fijar la base, la
    // integradora está en movimiento: el despachador no despacha.
    integradoraEnMovimiento++
    let r
    try {
      r = await serializar(promptIntegrar(item, aprobado), intento === 1 ? `integrar-pr${item.pr}` : `integrar-pr${item.pr}~i${intento}`, 'Merge', INTEGRAR_SCHEMA)
      if (r?.mergeado) await integrado(item, r, aprobado)
    } finally {
      integradoraEnMovimiento--
    }
    if (!r) {
      log(`⚠ integrar PR #${item.pr}: el serializer murió — si el scout lo vuelve a ofrecer, queda para Leo`)
      return
    }
    if (r.status === 'blocked') {
      await paraLeo(`integración bloqueada: ${r.detalle}`)
      return
    }
    if (r.status === 'conflicto') {
      log(`PR #${item.pr} conflictúa con ${RAMA} (${r.detalle}) → merge-resolver`)
      const v = await resolver(
        `## Workspace
Worktree: ${wt} (branch ${item.branch}). Tarea: mergear origin/${RAMA} en la branch del PR #${item.pr} — corré el merge y resolvé conflictos EN LOS ARCHIVOS, commiteados localmente.

## Intent packet
${item.esFix ? `PR de arreglos de la revisión del PR #${item.de}: gh pr view ${item.pr}.` : `Issue #${item.issue}: ${item.titulo}. El contrato ES el body del ticket: gh issue view ${item.issue} — y el PR: gh pr view ${item.pr}.
Si el diff parece exceder lo que el ticket pide, subí un peldaño de la escalera de intención antes de decidir:
  sh ${READ_CLI} intent ${item.issue} --dir ${REPO}
te devuelve el '## Out of Scope' y el '## Testing Decisions' del spec padre — la evidencia que tus criterios 1 y 4 necesitan.`}
Aplicá tus 5 criterios de no-regresión.

## Conflicto reportado
${r.detalle}`,
        `pr${item.pr}`,
        'Merge'
      )
      if (v?.action !== 'MERGE' || v.resolution === 'INCOMPATIBLE') {
        await paraLeo(`merge-resolver: ${v?.resolution ?? 'resolver murió'} — ${v?.resumen ?? 'sin veredicto'}`)
        return
      }
      continue // la resolución quedó commiteada en el worktree: el árbol nuevo se mide y se integra
    }
    if (r.mergeado) return // integrado(): base, revisión y registro
    // El árbol que quedó no está aprobado: se mide (el medidor verifica con su shell
    // que es el que el serializer reportó) y el gate decide en código.
    const med = await medirFirme(wt, 'Merge', `pr${item.pr}`, { esperado: r.arbol })
    const g = gate(med, base?.metricas ?? { metrics: {}, tests_failed: 0, failing_test_files: [], lockfiles_ajenos: [] }, { exigirTests: false })
    if (!g.pass) {
      if (med?.arbol) memoria.olvidar(med.arbol)
      await paraLeo(`gate de no-regresión contra ${RAMA}: ${g.motivos.join('; ')}`)
      return
    }
    arbolPorPr.set(item.pr, med.arbol)
  }
  await paraLeo('la integración no convergió en tres intentos (el árbol cambió entre medición y merge)')
}

function encolarMerge(item) {
  if (item.esFix && item.de) arregloDe.set(item.pr, item.de)
  enMerge.add(`pr${item.pr}`)
  colaMerge.push(item)
  asegurarCarriles()
}

// ---------------------------------------------------------------------------
// Carril de revisión (serial): un revisor y un aplicador por PR mergeado (§3.7)
// ---------------------------------------------------------------------------
function encolarRevision(item) {
  if (revisadosEnCorrida.has(item.pr)) return
  revisadosEnCorrida.add(item.pr)
  colaRevision.push(item)
  asegurarCarriles()
}

function registroComoTexto(rev) {
  const h = rev.hallazgos ?? []
  const lineas = h.map((x) => `- [${x.decision}] ${x.titulo} (${x.ubicacion}, ${x.severidad}): ${x.razon}`)
  return [
    `Revisión del pipeline ${A.runLabel}: ${h.length} hallazgo(s) — ${h.filter((x) => x.decision === 'aplicar').length} a aplicar, ${h.filter((x) => x.decision === 'humano').length} para Leo, ${h.filter((x) => x.decision === 'seguimiento').length} de seguimiento.`,
    ...lineas,
    rev.aplicados.length ? `Aplicados: ${rev.aplicados.join('; ')}.` : '',
    rev.fallados.length ? `No aplicados: ${rev.fallados.map((f) => `${f.titulo} (${f.motivo})`).join('; ')}.` : '',
    rev.pr_arreglos ? `Arreglos en el PR #${rev.pr_arreglos}: ${rev.arreglos_estado ?? 'pendientes'}.` : '',
  ].filter(Boolean).join('\n')
}

async function revisarPr(item) {
  if (!presupuestoOk()) {
    pendientes.push(`revisión del PR #${item.pr} (budget)`)
    revisiones.push({ pr: item.pr, issue: item.issue, estado: 'salteada por budget', hallazgos: null, aplicados: [], fallados: [], pr_arreglos: null })
    return
  }
  const rev = await llamar(
    (suf) => `Sos el REVISOR del PR #${item.pr} (issue #${item.issue}: ${item.titulo}), ya mergeado a ${RAMA} por el pipeline ${A.runLabel}. Sos la única revisión que va a tener este código: nadie lo vuelve a mirar después, y el gate solo cuenta números (typecheck, tests). SOLO LEÉS.
1. Lo que entró: cd ${REPO} && gh pr diff ${item.pr}
   Para el contexto, leé los archivos en el estado del merge, no en un working tree (otro carril del pipeline los está moviendo): cd ${REPO} && git fetch origin && C=$(gh pr view ${item.pr} --json mergeCommit --jq .mergeCommit.oid) && git show "$C:<path>" (rangos, no archivos enteros).
2. La intención: gh issue view ${item.issue} (el contrato) y sh ${READ_CLI} intent ${item.issue} --dir ${REPO} (el '## Out of Scope' y el '## Testing Decisions' del spec padre). GLOSSARY.md (o CONTEXT.md) y docs/adr/ en el mismo commit, si existen.
3. Revisá con tres lentes, en ese orden: correctitud y seguridad (bugs, OWASP, manejo de errores, datos que se pierden o se duplican); arquitectura (módulos profundos, seams, contratos entre capas); spec (lo pedido y solo eso: requisitos incumplidos y scope creep).
4. Decidí cada hallazgo:
   - aplicar: SOLO bug real, seguridad, requisito incumplido o contrato roto, con un arreglo local que no cambia la forma de nada compartido. Escribí el arreglo concreto en fix.
   - humano: el arreglo cambia la forma de una respuesta, un payload o un tipo compartido entre capas (el consumidor puede tener su propia copia de los tipos y el typecheck no ve la rotura); o es scope creep (algo que ni el ticket ni el spec pidieron: "borrá esto" no lo ejecuta un aplicador solo); o necesita una decisión.
   - seguimiento: debajo del umbral — estilo, refactor, nombres, docs, redundancias.
   Un falso positivo no se reporta. Lista vacía si no hay nada real: no inventes hallazgos para justificarte.
Reportá por schema: resumen y hallazgos.${suf}`,
    { label: `revisor:pr${item.pr}`, phase: 'Revisión', model: M[T.reviewer], effort: E.reviewer, agentType: REVISOR, schema: REVISION_SCHEMA }
  )
  const registroRev = { pr: item.pr, issue: item.issue, resumen: rev?.resumen ?? null, hallazgos: rev?.hallazgos ?? null, aplicados: [], fallados: [], pr_arreglos: null }
  revisiones.push(registroRev)
  if (!rev) {
    humanos.push({ titulo: `la revisión del PR #${item.pr} no corrió`, decision_necesaria: 'revisarlo a mano o relanzar: el PR quedó sin la etiqueta pipeline-revisado' })
    return
  }
  for (const h of rev.hallazgos) {
    if (h.decision === 'seguimiento') seguimientos.push({ pr: item.pr, titulo: h.titulo, ubicacion: h.ubicacion, razon: h.razon })
    if (h.decision === 'humano') humanos.push({ titulo: `[PR #${item.pr}] ${h.titulo}`, decision_necesaria: `${h.razon} (${h.ubicacion})` })
  }
  const aplicar = rev.hallazgos.filter((h) => h.decision === 'aplicar')
  log(`revisión PR #${item.pr}: ${rev.hallazgos.length} hallazgo(s), ${aplicar.length} a aplicar`)
  if (aplicar.length) await aplicarArreglos(item, aplicar, registroRev)
  // Con arreglos publicados, el registro espera a que entren (o queden para Leo): la
  // etiqueta pipeline-revisado dice "revisado y resuelto", y un relanzamiento la lee.
  if (registroRev.pr_arreglos) revisionPorArreglo.set(registroRev.pr_arreglos, registroRev)
  else await registrarRevision(item.pr, registroRev)
}

// Registro durable, en el PR revisado: lo que encontró el revisor, lo que aplicó el
// aplicador y qué pasó con sus arreglos. `rev` null: la revisión fue de una corrida
// anterior y solo se sabe el destino de sus arreglos.
async function registrarRevision(prRevisado, rev, nota = '') {
  const texto = rev ? registroComoTexto(rev) : `Revisión de una corrida anterior del pipeline. ${nota}`
  await serializar(
    `Registrar la revisión del PR #${prRevisado}:
1. CHECK: gh pr view ${prRevisado} --json labels → si ya tiene la etiqueta pipeline-revisado: 'ya_estaba' y TERMINÁ.
2. Escribí este texto TAL CUAL en un archivo temporal con un heredoc ENTRECOMILLADO (así el shell no ejecuta nada de lo que diga) y comentá con él:
   F=$(mktemp) && cat > "$F" <<'FIN_DEL_REGISTRO_PIPELINE'
${texto}
FIN_DEL_REGISTRO_PIPELINE
   y después: gh pr comment ${prRevisado} --body-file "$F" (contexto audit: review-pr-${prRevisado}-registro)
3. gh pr edit ${prRevisado} --add-label pipeline-revisado`,
    `registro-revision-pr${prRevisado}`,
    'Revisión'
  )
}

// Los arreglos de una revisión entraron o quedaron para Leo: se cierra su registro.
async function cerrarRevisionDeArreglos(item, estado) {
  const rev = revisionPorArreglo.get(item.pr) ?? null
  revisionPorArreglo.delete(item.pr)
  const de = rev?.pr ?? item.de ?? arregloDe.get(item.pr)
  if (!de) return
  if (rev) rev.arreglos_estado = estado
  await registrarRevision(de, rev, `Arreglos en el PR #${item.pr}: ${estado}.`)
}

async function aplicarArreglos(item, aplicar, registroRev) {
  const b = base // la integradora con el PR revisado ya adentro
  const desde = esIdDeGit(b?.commit) ? b.commit : `origin/${RAMA}`
  const rama = `review/${A.runLabel}-pr${item.pr}`
  const CHUNK = A.applierChunk ?? 4
  const tandas = []
  for (let i = 0; i < aplicar.length; i += CHUNK) tandas.push(aplicar.slice(i, i + CHUNK))
  let apl = null
  for (const [idx, tanda] of tandas.entries()) {
    const primera = idx === 0
    const paso0 = primera
      ? `PASO 0: git fetch origin && git checkout -B ${rama} ${desde} && ${DEPS('.')}`
      : `PASO 0: cd ${apl.worktree} — worktree YA preparado por la tanda anterior (branch ${apl.branch}, ${apl.aplicados.length} arreglo(s) ya commiteados). NO hagas checkout, NO resetees, NO toques los commits previos.`
    const r = await llamar(
      (suf) => `Sos el APLICADOR de la revisión del PR #${item.pr}${tandas.length > 1 ? ` — tanda ${idx + 1} de ${tandas.length}` : ''}.${primera ? ' Trabajás en tu worktree AISLADO (tu cwd).' : ''}
${paso0}
Aplicá EN ORDEN estos arreglos que decidió el revisor (y SOLO estos):
${tanda.map((f, i) => `${i + 1}. [${f.ubicacion}] ${f.titulo} → ${f.fix ?? f.por_que}`).join('\n')}
Por cada uno: aplicá, corré build/tests del área tocada; si rompe, REVERTILO (no "fixes forward") y anotalo en fallados con el motivo.${DENY}
${REGLA_DEPS} Trabajás con las dependencias ya instaladas: reinstalar corresponde solo cuando el arreglo mismo es de dependencias.
Al final: git add -A && git commit. NO pushees, NO gh.

DISCIPLINA DE CONTEXTO (tu contexto se re-envía entero en CADA turno: lo que arrastrás lo pagás N veces):
  - Tests/build con el reporter más silencioso del runner (--reporter=dot, -q) y filtrá a lo accionable
    (\`| tail -40\`, \`grep -A5 -i 'fail\\|error'\`). Nunca vuelques suites verdes ni logs de build enteros.
  - Corré SOLO los tests del área que tocás, no la suite completa: el pipeline la mide aparte después.
  - No releas archivos que ya leíste; editá con lo que ya tenés en contexto. Leé rangos, no archivos enteros.

Reportá por schema: worktree (pwd absoluto), branch, aplicados (títulos de ESTA tanda), fallados, resumen.${suf}`,
      {
        label: `aplicador:pr${item.pr}${tandas.length > 1 ? `-t${idx + 1}` : ''}`,
        phase: 'Revisión',
        model: M[T.applier],
        effort: E.applier,
        ...(primera ? { isolation: 'worktree' } : {}),
        agentType: APLICADOR,
        schema: APPLIER_SCHEMA,
      }
    )
    if (!r) {
      registroRev.fallados.push(...tanda.map((f) => ({ titulo: f.titulo, motivo: 'la tanda del aplicador no corrió' })))
      break
    }
    apl = primera ? { ...r } : { ...apl, aplicados: [...apl.aplicados, ...(r.aplicados ?? [])], fallados: [...apl.fallados, ...(r.fallados ?? [])] }
    registroRev.aplicados.push(...(r.aplicados ?? []))
    registroRev.fallados.push(...(r.fallados ?? []))
  }
  if (!apl || registroRev.aplicados.length === 0) return
  const med = await medirFirme(apl.worktree, 'Revisión', `arreglos-pr${item.pr}`, { conDiff: true })
  const g = gate(med, b?.metricas ?? { metrics: {}, tests_failed: 0, failing_test_files: [], lockfiles_ajenos: [] }, { exigirTests: false, vedados: VEDADOS })
  if (!g.pass) {
    humanos.push({ titulo: `los arreglos de la revisión del PR #${item.pr} no pasaron el gate`, decision_necesaria: `revisar ${apl.worktree}: ${g.motivos.join('; ')}` })
    registroRev.fallados.push(...registroRev.aplicados.map((t) => ({ titulo: t, motivo: 'el conjunto no pasó el gate' })))
    registroRev.aplicados = []
    return
  }
  const cuerpoArreglos = [`Arreglos de la revisión del PR #${item.pr}:`, ...registroRev.aplicados.map((t) => `- ${t}`), '', PIE_DE_PR].join('\n')
  const pub = await serializar(
    `Publicar los arreglos de la revisión del PR #${item.pr} (worktree ${apl.worktree}, branch ${apl.branch}):
1. CHECK identidad de trabajo: ¿hay PR (abierto o mergeado) de la branch ${apl.branch}? → reportá su número en pr_number ('ya_estaba') y saltá a 4.
2. Push y PR, con este comando tal cual y entero (título y cuerpo ya armados, entre comillas simples y por archivo) (contexto audit: review-pr-${item.pr}-create):
   ${comandoDePublicarPr({ worktree: apl.worktree, branch: apl.branch, base: RAMA, labels: [A.labels.agentPr, 'review-fix'], titulo: `revisión del PR #${item.pr}: arreglos (${A.runLabel})`, cuerpo: cuerpoArreglos, conHead: true })}
3. VERIFICÁ: gh pr view ${apl.branch} --json number,state → su número va en pr_number.
4. Si el PR existe: git worktree remove --force ${apl.worktree} && git worktree prune. Si el push o el PR fallaron: conservá el worktree y status 'blocked' con el error tal cual.`,
    `publish-arreglos-pr${item.pr}`,
    'Revisión'
  )
  if (pub?.pr_number && pub.status !== 'blocked') {
    registroRev.pr_arreglos = pub.pr_number
    if (esIdDeGit(med.arbol)) arbolPorPr.set(pub.pr_number, med.arbol)
    log(`revisión PR #${item.pr}: arreglos en el PR #${pub.pr_number} → cola de merge`)
    encolarMerge({ pr: pub.pr_number, branch: apl.branch, titulo: `arreglos de la revisión del PR #${item.pr}`, esFix: true, de: item.pr })
  } else {
    humanos.push({ titulo: `los arreglos de la revisión del PR #${item.pr} no se publicaron`, decision_necesaria: `${pub?.detalle ?? 'el serializer murió'} — worktree ${apl.worktree}` })
  }
}

async function correrCarril(cola, fn, clave) {
  while (cola.length) {
    const item = cola.shift()
    try {
      await fn(item)
    } catch (e) {
      log(`⚠ ${clave(item)}: ${String(e).slice(0, 200)}`)
    }
    if (clave(item).startsWith('pr')) enMerge.delete(clave(item))
    terminar(clave(item))
  }
}

function asegurarCarriles() {
  if (!carrilMerge && colaMerge.length)
    carrilMerge = correrCarril(colaMerge, integrarPr, (x) => `pr${x.pr}`).finally(() => {
      carrilMerge = null
      timbre.avisar()
    })
  if (!carrilRevision && colaRevision.length)
    carrilRevision = correrCarril(colaRevision, revisarPr, (x) => `rev${x.pr}`).finally(() => {
      carrilRevision = null
      timbre.avisar()
    })
}

// ---------------------------------------------------------------------------
// El despachador
// ---------------------------------------------------------------------------
phase('Despacho')
let estado = null // DONE | BLOCKED | BUDGET_CUT | ABORT
let detalleFinal = ''
let vuelta = 0
let foto = null
let fotoPedida = 0
let fotoRefrescos = 0
while (true) {
  vuelta++
  fotoPedida = eventos
  fotoRefrescos = refrescos
  if (vuelta === 1 && A.scopeInicial) {
    foto = A.scopeInicial
    log('scout inicial: pre-fetch de T0 (sin agente)')
  } else foto = await scoutear(`d${vuelta}`, 'Despacho')
  if (!foto) {
    if (algoEnVuelo()) {
      log(`⚠ scout ${vuelta} murió — se reintenta con el próximo evento`)
      await timbre.esperar()
      continue
    }
    estado = 'ABORT'
    detalleFinal = 'el scout murió sin nada en vuelo'
    break
  }
  registrarScout(foto)
  const buckets = {}
  for (const i of foto.issues ?? []) (buckets[i.bucket] ??= []).push(i)
  log(`scout ${vuelta}: ${(foto.issues ?? []).length} issues — ${Object.entries(buckets).map(([b, l]) => `${b}:${l.length}`).join(' ')}`)
  for (const i of buckets.HUMAN_GATED ?? []) bloqueadas.push(`#${i.number} HUMAN_GATED: ${i.detalle ?? i.title}`)
  inReviewUltimo = (buckets.IN_REVIEW ?? []).map((i) => `#${i.number} IN_REVIEW (PR #${i.pr_number ?? '?'}): ${i.detalle ?? i.title} — requiere intervención humana antes de re-correr`)
  // Si un refresh terminó mientras corría este scout, su dato de la base ya es viejo.
  if (fotoRefrescos === refrescos) baseMovida = typeof foto.base_por_integrar === 'number' ? foto.base_por_integrar > 0 : true

  // --- Paralelismo en caliente: el menor entre maxParallel, la perilla y el vigía.
  const cuota = vigia.leer(foto.cuota, MAX_P)
  const nuevoP = Math.min(MAX_P, foto.paralelo ?? MAX_P, cuota.P)
  if (nuevoP !== P || vuelta === 1) log(`paralelismo: ${nuevoP} carril(es)${foto.paralelo ? ` (perilla: ${foto.paralelo})` : ''} — cuota: ${cuota.motivo}`)
  P = nuevoP

  // --- Arranque: la integradora al día con la base y medida, antes de despachar nada.
  if (!base) {
    if (baseMovida) await moviendoIntegradora(refrescar)
    if (!fatal && !base) await fijarBase(setup.commit, setup.arbol, 'inicial')
    if (!base) {
      estado = fatal ? 'BLOCKED' : 'ABORT'
      detalleFinal = fatal ?? 'la integradora no se pudo medir (medición inválida nunca es éxito)'
      break
    }
    continue // una foto nueva, ya con la base fijada
  }

  // --- PRs a la cola de merge: los de las issues y los de arreglos de revisión que el
  // scout ve listos y nadie está integrando. Con la corrida frenada, ninguno.
  for (const a of foto.arreglos ?? []) if (a.de) arregloDe.set(a.pr_number, a.de)
  for (const a of (foto.arreglos ?? []).filter((x) => x.bucket === 'IN_REVIEW'))
    inReviewUltimo.push(`PR #${a.pr_number} (arreglos de la revisión del PR #${a.de ?? '?'}) en IN_REVIEW — requiere intervención humana`)
  const listos = [
    ...(buckets.MERGE_READY ?? []).map((iss) => ({ pr: iss.pr_number, issue: iss.number, branch: iss.pr_branch, titulo: iss.title })),
    ...(foto.arreglos ?? []).filter((a) => a.bucket === 'MERGE_READY').map((a) => ({ pr: a.pr_number, branch: a.pr_branch, esFix: true, de: a.de, titulo: `arreglos de la revisión del PR #${a.de ?? '?'}` })),
  ]
  for (const item of fatal ? [] : listos) {
    const clave = `pr${item.pr}`
    if (enMerge.has(clave) || terminoEn[clave] > fotoPedida) continue
    if (registro.decidir(clave) === 'para_leo') {
      const m = await marcarPr(item.pr, `volvió a MERGE_READY en la misma corrida sin un hecho nuevo (último intento: ${registro.dato(clave).ultimo})`, 'Merge', { conservar: wtDePr(item.pr) })
      // Entró entre la foto y la marca: el carril de merge lo ve MERGED y fija la base.
      if (m?.mergeado) encolarMerge(item)
      continue
    }
    encolarMerge(item)
  }

  // --- PRs mergeados sin revisar (de esta corrida o de una anterior que se cortó).
  // Sin el dato, se revisa (revisar de más es caro; saltear una revisión, peor). Uno
  // cuyos arreglos todavía no entraron no se revisa de nuevo: se registra al entrar.
  const conArreglosPendientes = new Set([...arregloDe.values()])
  for (const iss of buckets.DONE ?? [])
    if (iss.pr_number && iss.revisado !== true && !enMerge.has(`pr${iss.pr_number}`) && !conArreglosPendientes.has(iss.pr_number))
      encolarRevision({ pr: iss.pr_number, issue: iss.number, titulo: iss.title })

  // --- Implementación: llenar los carriles libres, nunca más que lo habilitado.
  const ofrecidas = (buckets.IMPLEMENTABLE ?? []).filter((i) => !enVuelo.has(i.number) && !(terminoEn[`i${i.number}`] > fotoPedida))
  const vuelven = ofrecidas.filter((i) => registro.decidir(`i${i.number}`) === 'para_leo')
  const nuevas = ofrecidas.filter((i) => registro.decidir(`i${i.number}`) === 'despachar')
  for (const iss of vuelven) {
    const d = registro.dato(`i${iss.number}`)
    await marcarIssue(iss.number, `volvió a IMPLEMENTABLE en la misma corrida sin un hecho nuevo (último resultado: ${d.ultimo})`, 'Despacho', d.worktree)
  }
  if (!sinBudget && !presupuestoOk()) {
    sinBudget = true
    log(`■ budget: quedan ${Math.round(restante() / 1000)}k < ${Math.round(A.minBudgetWave / 1000)}k mínimos — no se despacha trabajo nuevo; se termina lo que está en vuelo`)
  }
  // Con la integradora en movimiento (un merge sin base fijada todavía) no se despacha:
  // el carril de merge toca el timbre después de fijar la base.
  if (!sinBudget && !fatal && integradoraEnMovimiento === 0) {
    const libres = Math.max(0, P - enVuelo.size)
    for (const iss of nuevas.slice(0, libres)) despacharIssue(iss)
    if (nuevas.length > libres) log(`${nuevas.length - libres} issue(s) habilitada(s) esperan carril (P=${P}): ${nuevas.slice(libres).map((i) => `#${i.number}`).join(' ')}`)
  } else if (nuevas.length && (sinBudget || fatal)) pendientes.push(...nuevas.map((i) => `#${i.number} sin despachar (${fatal ? 'corrida frenada' : 'budget'})`))
  asegurarCarriles()
  // El vigía mide la velocidad por carril-hora: le cuenta lo que queda corriendo
  // desde ahora hasta la próxima lectura, ya con lo recién despachado.
  vigia.enCurso(enVuelo.size + (carrilRevision ? 1 : 0))

  // --- ¿Terminó? Solo con una foto posterior al último evento y nada en vuelo.
  if (!algoEnVuelo()) {
    if (eventos !== fotoPedida) continue // algo terminó mientras corría el scout: otra foto
    if (fatal) estado = 'BLOCKED'
    else if (foto.all_done) {
      allDone = true
      estado = 'DONE'
    } else if (sinBudget) estado = 'BUDGET_CUT'
    else {
      estado = 'BLOCKED'
      log(`■ BLOCKED: sin trabajo accionable (${(buckets.BLOCKED_BY_DEP ?? []).length} por deps, ${(buckets.HUMAN_GATED ?? []).length} humanas, ${(buckets.IN_REVIEW ?? []).length} in-review) — Leo tiene que intervenir`)
    }
    detalleFinal = fatal ?? ''
    break
  }
  await timbre.esperar()
}

// ===========================================================================
// FASE: Cierre — PR draft rama → base + reporte (con la cola de revisión vacía)
// ===========================================================================
phase('Cierre')
let prFinal = null
if (allDone) {
  const issuesCierre = [...cerradas.keys()]
  // El cuerpo lo arma el motor con lo que ya sabe (§3.2); el serializer lo publica tal cual,
  // por archivo. Los títulos y razones de seguimiento los escribió el revisor.
  const cuerpo = [
    `Scope ${SCOPE_DESC}, pipeline ${A.runLabel}: rama ${RAMA} hacia ${BASE}, ${issuesCierre.length} issue(s) con su PR mergeado a la integradora.`,
    ...(issuesCierre.length
      ? [
          '',
          '## Issues cerradas',
          ...issuesCierre.map((n) => {
            const d = cerradas.get(n)
            return `- #${n}${d.titulo ? ` ${d.titulo}` : ''}${d.pr ? ` — PR #${d.pr}` : ''}`
          }),
          '',
          // Los PRs por issue fueron contra la integradora, donde GitHub ignora el "Closes":
          // este PR, que va a la base, es el único lugar donde el autocierre surte efecto.
          ...issuesCierre.map((n) => `Closes #${n}`),
        ]
      : []),
    ...(revisiones.length
      ? [
          '',
          '## Revisión por PR',
          'Un revisor y, si hizo falta, un aplicador por PR; el detalle está comentado en cada PR.',
          ...revisiones.map((r) =>
            r.hallazgos === null
              ? `- PR #${r.pr}: ${r.estado ?? 'la revisión no corrió'}`
              : `- PR #${r.pr}: ${r.hallazgos.length} hallazgo(s), ${r.aplicados.length} aplicado(s)${r.fallados.length ? `, ${r.fallados.length} sin aplicar` : ''}${r.pr_arreglos ? ` (arreglos en el PR #${r.pr_arreglos}: ${r.arreglos_estado ?? 'pendientes'})` : ''}`
          ),
        ]
      : []),
    ...(seguimientos.length
      ? [
          '',
          '## Sugerencias de seguimiento',
          'La revisión las dejó debajo del umbral de aplicar: no se aplicaron.',
          ...seguimientos.map((r) => `- [PR #${r.pr}] ${r.titulo}${r.ubicacion ? ` (${r.ubicacion})` : ''}: ${r.razon}`),
        ]
      : []),
    '',
    'PR integrador para botón verde de Leo. 🤖 Generated with [Claude Code](https://claude.com/claude-code)',
  ].join('\n')
  const cierre = await serializar(
    `Cerrar el pipeline: PR draft de ${RAMA} hacia ${BASE}. El título y el cuerpo ya los armó el motor: van entre comillas simples y por archivo, y el shell no interpreta nada de lo que dicen.
1. cd ${WT_INTEGRACION} && git pull --ff-only
2. El PR draft, con este comando tal cual y entero (contexto audit: pr-final-create). Él mismo chequea la identidad de trabajo: si ya hay un PR final abierto o mergeado (uno cerrado sin mergear no cuenta), no crea otro e imprime YA_EXISTE <número> <estado>.
   ${comandoDePrFinal({ dir: WT_INTEGRACION, base: BASE, rama: RAMA, titulo: `${SCOPE_DESC} — pipeline ${A.runLabel}`, cuerpo })}
   → Si creó el PR: su número va en pr_number, status 'ok'.
   → Si imprimió YA_EXISTE: ese número va en pr_number (con dos líneas, el de la que dice OPEN), status 'ya_estaba'.${
      issuesCierre.length
        ? ` Si dice OPEN, sumale los "Closes #" que le falten con este comando, tal cual y entero (contexto audit: pr-final-closes):
   ${comandoDeSumarCloses({ dir: REPO, base: BASE, rama: RAMA, issues: issuesCierre })}`
        : ''
    }
3. Sobre el PR (nuevo o 'ya_estaba', si está ABIERTO): gh pr comment <numero> --body "@coderabbitai review" — CodeRabbit skipea drafts y bases no-default por config, el comentario fuerza la review externa; el T0 triagea sus observaciones después (contexto audit: pr-final-coderabbit). Idempotencia: si el PR ya tiene un comentario "@coderabbitai review", no dupliques.`,
    'pr-final',
    'Cierre'
  )
  prFinal = cierre?.pr_number ?? null
}

const reporte = {
  status: estado,
  corrida: A.runLabel,
  ts_lanzamiento: A.ts,
  scope: A.scope,
  rama: RAMA,
  pr_final_draft: prFinal,
  detalle: detalleFinal || undefined,
  trabajos,
  merges: mergesReporte,
  revisiones,
  // Cada scout re-anota las HUMAN_GATED: sin deduplicar, la misma línea salía una vez por vuelta.
  bloqueadas: [...new Set(bloqueadas)],
  pendientes,
  bugs_reales_para_issues: bugsReales,
  seguimientos,
  avisos,
  para_leo: [
    ...humanos.map((h) => `[revisión] ${h.titulo}: ${h.decision_necesaria}`),
    ...avisos,
    ...new Set(bloqueadas),
    ...inReviewUltimo,
  ],
  // Solo output (ver BUDGET_TOTAL): el costo real está en /workflows y en los transcripts.
  tokens_output: budget.spent(),
}
log(
  `■ fin ${A.runLabel}: ${reporte.status}${prFinal ? ` · PR final draft #${prFinal}` : ''} · ${trabajos.length} implementación(es), ${mergesReporte.length} merge(s), ${revisiones.length} revisión(es)` +
    ` · bloqueadas=${reporte.bloqueadas.length} · bugs anotados=${bugsReales.length} · output ${Math.round(budget.spent() / 1000)}k`
)
return reporte
