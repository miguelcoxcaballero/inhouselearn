# inhouse learn

Chat con IA para estudiar que corre entero en el navegador. Sin instalador ni servidor: abres https://miguelcoxcaballero.github.io/inhouselearn/ (o `index.html`) y tienes dos opciones:

- **Gemini**: entras con Google (o pegas una API key de AI Studio) y usas la capa gratuita de la API de Gemini. Sin coste, con límites de uso.
- **OpenRouter**: pegas tu API key de [OpenRouter](https://openrouter.ai/settings/keys) y pagas por tokens el modelo que elijas.

## Gemini (cuenta de Google)

Va por la API oficial de Gemini (`generativelanguage.googleapis.com`), la misma que usa el proveedor `google` de pi, con su capa gratuita. Hay dos formas de usarla:

- **Con tu sesión de Google**: la app llama con el token del login. Gasta la cuota del proyecto de Google Cloud del cliente OAuth de la app.
- **Con una API key de [AI Studio](https://aistudio.google.com/apikey)** (opcional, en el selector de modelo): gasta la cuota de tu propia key y no hace falta iniciar sesión.

La lista de modelos sale de la propia API al entrar. La capa gratuita tiene límites por minuto y por día que dependen del modelo; algunos (como los Pro) pueden no tenerla y piden activar la facturación.

Requisitos en Google Cloud (proyecto del cliente OAuth) para usarlo con la sesión de Google:

- El origen `https://miguelcoxcaballero.github.io` en los orígenes de JavaScript autorizados del cliente OAuth.
- La **Generative Language API** activada en ese proyecto.
- La pantalla de consentimiento con los permisos `cloud-platform`, `drive.file`, `userinfo.email` y `userinfo.profile`.

Antes se usaba Code Assist (el backend de Gemini CLI). pi lo quitó en su versión 0.71 y Google no lo permite para apps de terceros, así que ya no se usa.

## Modelos de OpenRouter

Precio en USD por millón de tokens (entrada / salida), según OpenRouter.

| Compañía | Modelo | Precio |
| --- | --- | --- |
| DeepSeek | DeepSeek V4.1 Flash (por defecto) | $0.15 / $0.60 ($0.30 / $1.20 en hora punta*) |
| Z.ai | GLM-5.3 FlashX | $0.37 / $1.25 |
| Z.ai | GLM-5.3 Prime | $2.80 / $8.80 |
| MiniMax | MiniMax M3.1 Flash | gratis |
| Claude | Haiku 5.5 / Sonnet 5.5 / Opus 5.5 | $0.10 / $0.50 · $2 / $10 · $4 / $20 |
| OpenAI | GPT-6 Luna / GPT-6 Sol | $0.10 / $0.50 · $2 / $10 |
| Kimi | Kimi K2.7 Code | $0.67 / $3.35 |
| Otro | Cualquier ID de [openrouter.ai/models](https://openrouter.ai/models) | — |

\* De lunes a viernes, de 01:00 a 04:00 y de 06:00 a 10:00 UTC.

Los precios cambian; el saldo real y el gasto se ven en el anillo junto al botón de enviar.

## Motor: pi

El chat corre sobre [pi](https://github.com/earendil-works/pi): `@earendil-works/pi-ai` pone los proveedores, el streaming, el razonamiento y el cálculo de coste, y `@earendil-works/pi-agent-core` el bucle del agente con herramientas. Están empaquetados para el navegador en `vendor/pi-engine.js`, así que la web sigue siendo estática.

- OpenRouter usa la API `openai-completions` de pi con los metadatos de su catálogo (niveles de razonamiento y precios por modelo). Los modelos que no están en el catálogo se completan con el listado público de OpenRouter.
- Gemini usa una API propia de pi (`engine/src/gemini-api.js`) sobre la API de Gemini, con los conversores de Google de pi-ai. Se llama con fetch para poder autenticar con el token de Google o con una API key.

### Herramientas del agente

- **Ejecutar JavaScript** (`run_js`): en un Web Worker aparte, sin red ni acceso a la página, con 15 s de límite. Sirve para cálculos exactos, comprobar soluciones o generar datos.
- **Archivos del chat** (`write_file`, `read_file`, `edit_file`, `list_files`, `delete_file`): apuntes, esquemas, código o CSV que se guardan con el chat. Aparecen encima del cuadro de texto, se pueden abrir y se descargan todos en un ZIP.

Cada respuesta muestra los pasos con herramientas que ha dado (plegados).

### Recompilar el motor

```bash
cd engine
npm install --ignore-scripts
npm run build   # regenera src/catalog.json y ../vendor/pi-engine.js
```

## Cómo funciona

- Las peticiones van directas del navegador a OpenRouter o a Google, con streaming. No hay servidor propio.
- La API key de OpenRouter y el token de Google se guardan en `localStorage` de tu navegador.
- Razonamiento configurable por chat; cada modelo ofrece los niveles que admite según pi (no, mínimo, bajo, medio, alto).
- Adjuntos: PDF, Word, Excel y texto se extraen en el navegador; las imágenes se mandan al modelo si las admite y los PDF escaneados van como imágenes de sus páginas.
- Historial en el navegador. Si entras con Google, también se sincroniza en Drive.
- Guided Learning (modo tutor con mapa del temario y mini tests) sigue disponible.

Nota: la key queda en el navegador, así que no la uses en ordenadores compartidos. En OpenRouter puedes ponerle un límite de gasto.
