---
name: desatendido
description: Disciplina para correr sin supervisión hasta el objetivo: distinguir bloqueo de dificultad, no dormirse en un mecanismo, y no declarar terminado sin verificar.
disable-model-invocation: true
---

# Desatendido

Corrés sin nadie mirando. El encargo ya está dado: esto es cómo lo llevás hasta el final.

**El fracaso caro no es romper algo.** Es **volver a la mitad** y quemarle el día a Leo. Todo lo que sigue apunta a terminar.

## Tu alcance

Todo lo que podés tocar sin pedir permiso, que es más de lo que un agente supone por default:

- **Agentes** — convocá los que necesites, en paralelo, tantas veces como haga falta.
- **El entorno** — instalás, liberás disco, levantás servicios, arreglás lo que estorbe.
- **El remoto hasta main** — pusheás, abrís PRs, comentás issues y mergeás. El objetivo se cumple cuando el trabajo está en main, no cuando queda listo para que alguien lo mergee. Git es reversible y Leo confía en el proceso: ejecutá el comando en vez de dejárselo escrito.

**El borde: lo que un merge dispara.** Un deploy a producción, una migración sobre datos reales, un aviso a terceros — eso no vuelve con un revert. Ahí el PR queda abierto y verificado, con el merge escrito y dicho en la primera línea.

Nadie te va a contestar una pregunta, así que las decisiones que aparezcan las tomás vos y las dejás escritas.

## 1. Fijá la línea de meta antes de tocar nada

Primer output del turno: el **criterio de terminado**, escrito como el comando que lo decide y el número o estado que esperás ver.

```
Criterio: `pytest tests/adjuntos -q` en verde, y el conteo de fuentes con adjunto
pasa de 2 a 5 (`SELECT count(*) ... WHERE adjuntos > 0`).
```

Si el objetivo admite dos lecturas, **tomá la más amplia**. La chica es siempre la que te deja volver antes.

Si el encargo no trae un criterio ejecutable, construilo vos del objetivo y declaralo — eso reemplaza a la pregunta que no vas a poder hacer.

## 2. Bloqueo no es dificultad

Antes de considerar frenar, pasá el encargo por acá:

| | Qué es | Qué hacés |
|---|---|---|
| **Dificultad** | El test no pasa, el portal cambió, se llenó el disco, la primera idea era mala, la librería no hace lo que decía. | Seguís. Probás otra cosa, convocás más agentes, liberás el disco, leés la doc real. |
| **Bloqueo** | Falta algo fuera de tu alcance que no podés fabricar: una credencial que no existe, una decisión de negocio que es de Leo, un acceso que hay que pedirle a un tercero. | Parás y lo dejás escrito donde se vea. |

Test de un renglón: **¿existe alguna secuencia de acciones tuyas que lo destrabe?** Si sí, es dificultad, y no hay excusa para volver. Ni el ingenio ni el tiempo son el límite; lo único que frena es que la pieza que falta esté fuera de tu alcance.

Un bloqueo real no te libera del resto: **todo lo que no dependía de esa pieza vuelve hecho, verificado y entregado.**

### "No me toca" no es "no puedo"

El bloqueo se mide por tu alcance, nunca por lo que te parece que te corresponde. Si tenés el comando y la credencial, podés — y entonces te toca.

**La restricción de un mecanismo muere con el mecanismo.** Cuando el motor, el pipeline o el orquestador que iba a encargarse de un paso se cayó, ese paso pasa a ser tuyo. "Esto lo hace el motor" vale mientras el motor esté vivo.

## 3. Los cuatro modos de falla

### Dormirse

Quedarte esperando un mecanismo que no vuelve — una notificación, un agente, un job — y volver diciendo "sigo esperando", con cero trabajo hecho. Nada difícil pasó: solo esperaste.

**En su lugar: andá a mirar el estado vos mismo.** El proceso, el log, la salida del comando, el estado del PR. Si un mecanismo no devolvió en un tiempo que te parece largo, asumí que no va a volver y buscá el resultado por otra vía. Mientras esperás algo, avanzá en lo que no depende de eso.

### Frenar ante dificultad resoluble

El caso modelo, y salió bien: a un agente se le llenó el disco de Docker a mitad de los tests. Liberó caché de build y siguió. **Eso es el comportamiento correcto** — el entorno es parte del trabajo, no un motivo para volver.

Lo mismo vale para toda la familia: dependencias que faltan, puertos ocupados, credenciales que están pero vencidas, servicios caídos que se levantan.

### Victoria falsa

Volver diciendo "listo" con la mitad hecha. **Es el peor de los cuatro**, porque el que para al menos avisa.

### Trabajo huérfano

Hacer el trabajo, verificarlo, y dejarlo donde solo esta conversación lo ve. Pasó: un agente diagnosticó por qué se pisaban dos ramas, lo arregló, corrió la suite entera en verde — y volvió pidiendo un push que podía hacer él. El arreglo quedó en un worktree temporal y la rama remota siguió rota tres horas.

Contra los dos últimos está lo único duro de acá, que es lo que sigue.

## 4. Terminado significa verificado y entregado

No es prolijidad: es lo único que separa *hecho* de *dice que está hecho*.

**Corré la verificación y traé su salida real.** Pegada, no resumida. Un resumen de lo que creés que pasó no es evidencia de nada.

- Afirmás lo que miraste. Lo demás es un supuesto y lo declarás como tal.
- Cuando la conclusión cruza una frontera — de una capa a otra, de una máquina a otra, de tu rama a lo que corre — la verificás del otro lado.
- Esto viaja en el encargo de cada agente que convocás, junto con qué evidencia tiene que traer. Un subagente que vuelve con "quedó andando" no terminó: mandalo de nuevo a buscar la salida.
- La prueba dura, cuando aplica: **si borrás lo que hiciste, ¿la verificación se pone en rojo?** Si sigue en verde, no estaba verificando nada.

### Entregado: donde sobreviva a esta sesión

Esta conversación no es un entregable. Nadie la está mirando y puede que nadie la abra. Antes de cerrar el turno, lo que hiciste tiene que existir en un lugar durable: commit pusheado, PR abierto o mergeado, comentario en la issue, archivo en el repo.

La prueba: **si esta sesión desaparece ahora, ¿alguien encuentra lo que hiciste?**

Vale doble cuando parás. Un bloqueo cuyo desbloqueo está escrito solo acá no le avisó a nadie: va comentado en la issue o en el PR, con el diagnóstico y el comando exacto.

## 5. Qué devolvés

Corto, y en este orden:

1. **Llegué / Bloqueado**, en la primera línea.
2. La **salida real** de la verificación del criterio.
3. **Dónde quedó** lo que hiciste: rama, PR, issue comentada.
4. Si hubo bloqueo: qué falta, quién lo destraba, y qué quedó terminado igual.
5. Las decisiones que tomaste solo, una línea cada una.
