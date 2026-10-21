# Aprobación de cambios

El botón del compositor (junto al selector de modelo) elige cuánto le preguntas al modelo
antes de que cambie algo. El modo es de cada chat (`chat.approvalMode`) y se guarda con él,
también en Drive.

| Modo | Archivos del chat | GitHub (commits, PR, comentarios) |
| --- | --- | --- |
| **Preguntar** | Pide permiso | Pide permiso |
| **Auto** | Los aprueba | Pide permiso |
| **Acceso total** | Los aprueba | Los aprueba (con un aviso) |

Las lecturas nunca preguntan. En «Acceso total» cada cambio automático se avisa con un aviso,
para que siempre sepas qué se ha tocado.

## Herramientas y qué se pregunta

| Herramienta | Cambio | Pregunta en «Preguntar» | Pregunta en «Auto» | Pregunta en «Acceso total» |
| --- | --- | --- | --- | --- |
| `run_js` | Calcula (sandbox sin red) | No | No | No |
| `run_js` | Guarda archivos (`writeFile`) | Sí | No | No |
| `write_file` / `edit_file` / `delete_file` | Archivos del chat | Sí | No | No |
| `read_file` / `list_files` | Lectura | No | No | No |
| `search_library` / `read_library` | Biblioteca del chat | No | No | No |
| `github_*` de lectura | Ver repos, leer, buscar | No | No | No |
| `github_commit_files` / `github_edit_file` | Commit | Sí | Sí | No |
| `github_create_pull_request` / `github_comment` | PR y comentarios | Sí | Sí | No |

## Dónde está

- `approval.js`: los tres modos, el botón y su menú, y la puerta de entrada
  (`approveChange`) que decide entre el diálogo de confirmación y la aprobación sola.
- `approval.css`: el botón y el menú (en el móvil, solo el icono).
- `index.html`: carga el módulo, guarda el modo con el chat (`normalizeStoredChat`) y
  envuelve las herramientas de archivos del chat (`approvalWorkspaceTools`).

## Reglas

- Toda escritura de GitHub pasa por `ctx.confirm()` (`engine/src/github.js`): con «Preguntar»
  o «Auto» la ve el usuario con sus archivos y las líneas +/−; con «Acceso total» se aprueba
  sola y se avisa.
- Las herramientas de archivos del chat (`write_file`, `edit_file`, `delete_file`) solo
  preguntan en «Preguntar». `run_js` pregunta si su código guarda archivos.
- El modelo recibe el modo en el prompt del sistema (`approvalPromptText`) para que sepa si
  va a tener que pedir permiso.

## Accesibilidad

- El botón es un `<button>` real, con `aria-haspopup="listbox"` y `aria-expanded`; el menú es
  una lista de opciones con `role="option"` y `aria-selected`.
- El menú se cierra con Escape y con un clic fuera, y el botón Atrás de la app Android lo
  cierra antes de salir de la app.
- El icono del botón cambia con el modo (escudo, rayo, candado abierto) y su color avisa:
  ámbar para «Preguntar», verde para «Auto» y rojo para «Acceso total».
- En el móvil el botón se queda solo con el icono; el menú se abre a pantalla casi completa
  desde abajo, como el de modelos.

## Probarlo a mano

1. Abre un chat y pulsa el botón del compositor: salen los tres modos con su descripción.
2. Elige «Preguntar» y pide al modelo que guarde un archivo: sale el diálogo y, si lo
   rechazas, no se guarda.
3. Elige «Acceso total» y pide un commit en GitHub: se aprueba solo y sale un aviso.
4. Cambia de chat: el botón muestra el modo de ese chat, no el del anterior.
