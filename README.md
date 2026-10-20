# inhouse learn

Chat con IA para estudiar que corre entero en el navegador. Sin instalador ni servidor: abres https://miguelcoxcaballero.github.io/inhouselearn/ (o `index.html`), pegas tu API key de [OpenRouter](https://openrouter.ai/settings/keys) y eliges modelo. Pagas por tokens con tu saldo de OpenRouter.

## App Android

Hay una APK optimizada para el móvil: una capa nativa mínima (≈180 KB) alrededor de esta misma web, con el logo de la bombilla, pantalla completa, teclado que no tapa el cuadro de texto, botón Atrás, descargas, adjuntos y el inicio de sesión de Google en una Chrome Custom Tab. Cada cambio de la web llega a la app sin APK nueva.

- **Firma:** la misma clave permanente que Inhouse YouTube e Inhouse Instagram (certificado SHA-256 `7133a4b3e4b9f9c4d2fbbd38b7dd2d44c7b8d0d7d16568bfe3da74a09e7887b6`). La clave está solo en el secreto `EJEMPLO` de `youtube-calma`, así que la APK se firma allí (workflow *Sign Inhouse Learn*) y este repositorio la verifica y la publica. Nunca se sube una clave al repositorio.
- **Actualizaciones:** el actualizador común [Inhouse services updater](https://github.com/miguelcoxcaballero/inhouse-services-updater) (canales A/B en `updates/A.json` y `updates/B.json`, B por defecto). En la app: menú de perfil → «Actualizaciones».
- **Publicar:** en `youtube-calma`, *Sign Inhouse Learn* con el SHA del commit; después, aquí, *Android app → Run workflow* con «publish». Detalles, requisitos (URI de redirección de OAuth) y reglas en [android/README.md](android/README.md), [AGENTS.md](AGENTS.md) y [UPDATER.md](UPDATER.md).

## Modelos

No hay lista fija: el selector muestra en vivo todos los modelos de chat de OpenRouter, de todas las compañías, con su precio por millón de tokens (entrada / salida).

- **Recomendados ahora**: arriba salen los más usados esa semana en OpenRouter (`GET /api/v1/models?sort=top-weekly`). Cambian solos con el tiempo.
- **Buscador**: busca por nombre de modelo, compañía o ID. Con Enter se elige el primero.
- **Compañías**: chips con todas las compañías, ordenadas por uso.
- **Cualquier ID**: si escribes un ID completo (`compañía/modelo`) que no está en la lista, se puede usar igual.
- **Razonamiento**: cada modelo ofrece los niveles que admite según OpenRouter (no, mínimo, bajo, medio, alto, máximo) y empieza en el que OpenRouter usa por defecto.

La lista se guarda en el navegador para que el selector se abra al instante y se refresca cada hora. Un chat nuevo usa el último modelo que elegiste; la primera vez, el más usado de la semana.

## Motor: pi

El chat corre sobre [pi](https://github.com/earendil-works/pi): `@earendil-works/pi-ai` pone OpenRouter (API `openai-completions`), el streaming, el razonamiento y el cálculo de coste, y `@earendil-works/pi-agent-core` el bucle del agente con herramientas. Están empaquetados para el navegador en `vendor/pi-engine.js`, así que la web sigue siendo estática.

### Herramientas del agente

- **Ejecutar JavaScript** (`run_js`): en un Web Worker aparte, sin red ni acceso a la página, con 15 s de límite. Sirve para cálculos exactos, comprobar soluciones o generar datos.
- **Archivos del chat** (`write_file`, `read_file`, `edit_file`, `list_files`, `delete_file`): apuntes, esquemas, código o CSV que se guardan con el chat. Aparecen encima del cuadro de texto, se pueden abrir y se descargan todos en un ZIP.

Cada respuesta muestra los pasos con herramientas que ha dado (plegados). Si un modelo no admite herramientas, la petición se repite sin ellas.

### Recompilar el motor

```bash
cd engine
npm install --ignore-scripts
npm run build   # genera ../vendor/pi-engine.js
```

## Cómo funciona

- Las peticiones van directas del navegador a OpenRouter, con streaming. No hay servidor propio.
- La API key de OpenRouter se guarda en `localStorage` de tu navegador.
- **Uso** (el anillo junto a enviar): lo gastado con tu key hoy, esta semana, este mes y en total (`GET /api/v1/key`), y lo que te queda si la key tiene un límite de crédito. El saldo de toda la cuenta (`GET /api/v1/credits`) OpenRouter solo se lo da a una [key de gestión](https://openrouter.ai/settings/management-keys): si la pegas en el panel de uso, se usa solo para leer el saldo y se queda en este navegador.
- Adjuntos: PDF, Word, Excel y texto se extraen en el navegador; las imágenes se mandan al modelo si las admite y los PDF escaneados van como imágenes de sus páginas.
- Historial en el navegador. Si entras con Google (botón de arriba a la derecha), también se sincroniza en tu Google Drive.
- Guided Learning (modo tutor con mapa del temario y mini tests) sigue disponible.

Para el login de Google en la web de GitHub Pages, el origen `https://miguelcoxcaballero.github.io` tiene que estar en los orígenes de JavaScript autorizados del cliente OAuth, con los permisos `drive.file`, `userinfo.email` y `userinfo.profile`.

Nota: la key queda en el navegador, así que no la uses en ordenadores compartidos. En OpenRouter puedes ponerle un límite de gasto.
