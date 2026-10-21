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
