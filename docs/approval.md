# Aprobación de cambios

La sección «Aprobación de cambios» del menú **+** elige cuánto le preguntas al modelo antes
de que cambie algo. El modo es de cada chat (`chat.approvalMode`) y se guarda con él, también
en Drive. Con «Acceso total», el **+** lleva un punto rojo.

| Modo | Archivos del chat | Subir a GitHub (push, PR, comentario) |
| --- | --- | --- |
| **Preguntar** | Pide permiso | Pide permiso, una vez por subida |
| **Auto** | Los aprueba | Pide permiso, una vez por subida |
| **Acceso total** | Los aprueba | Los aprueba (con un aviso) |

Las lecturas nunca preguntan, y **preparar** cambios de GitHub tampoco: el modelo los prepara
con `github_edit_file` / `github_write_files` y los sube todos juntos en un solo commit.

## La tarjeta de aprobación

Las aprobaciones salen en una tarjeta **encima del cuadro de texto** (`dockApprove`,
`composer-dock.js`), no en un diálogo a pantalla completa: título, resumen (repositorio, rama,
mensaje del commit, PR) y cada archivo con sus líneas +/−. Mientras está abierta se puede
seguir escribiendo; en el hilo, el paso en curso dice «Esperando tu aprobación». Si el turno
se para, la tarjeta se cierra como «No». Si se sube a la rama principal, la tarjeta sale en rojo.

## Herramientas y qué se pregunta

| Herramienta | Cambio | «Preguntar» | «Auto» | «Acceso total» |
| --- | --- | --- | --- | --- |
| `run_js` | Calcula (sandbox sin red) | No | No | No |
| `run_js` | Guarda archivos (`writeFile`) | Sí | No | No |
| `write_file` / `edit_file` / `delete_file` | Archivos del chat | Sí | No | No |
| `read_file` / `list_files` / biblioteca | Lectura | No | No | No |
| `github_*` de lectura (`read_file`, `grep`, `list_files`, `ci_status`…) | Lectura | No | No | No |
| `github_edit_file` / `github_write_files` / `github_discard` | Preparar (no sube nada) | No | No | No |
| `github_push` / `github_create_pull_request` | Subir lo preparado en un commit | Sí | Sí | No |
| `github_comment` | Comentario | Sí | Sí | No |

Lo que el modelo deja preparado sin subir aparece encima del cuadro con «Subir en un commit»
(pulsarlo es la aprobación) y «Descartar».

## Dónde está

- `approval.js`: los tres modos, su sección del menú + y `approveChange`, que decide entre
  la tarjeta de aprobación y la aprobación sola.
- `composer-dock.js`: la tarjeta, los cambios preparados, la cola de mensajes y la
  actividad en vivo de las herramientas.
- `index.html`: guarda el modo con el chat (`normalizeStoredChat`) y envuelve las
  herramientas de archivos del chat (`approvalWorkspaceTools`).

## Probarlo a mano

1. Abre el **+**: abajo están los tres modos en una fila.
2. Elige «Preguntar» y pide al modelo que guarde un archivo: sale la tarjeta encima del
   cuadro y, si dices «No», no se guarda.
3. Con GitHub activo, pide un cambio en varios archivos y un PR: no pregunta nada hasta el
   final, y entonces sale una sola tarjeta con todos los archivos.
4. Elige «Acceso total»: el + lleva un punto rojo y las subidas se aprueban solas con un aviso.
