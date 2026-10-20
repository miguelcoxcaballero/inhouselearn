# inhouse learn

Chat con IA que corre entero en el navegador. Sin instalador, sin servidor: abres `index.html` (o la URL de GitHub Pages), pegas tu API key de [OpenRouter](https://openrouter.ai/settings/keys) y eliges modelo.

## Modelos

Precio en USD por millón de tokens (entrada / salida), según OpenRouter.

| Compañía | Modelo | Precio |
| --- | --- | --- |
| DeepSeek | DeepSeek V4.1 Flash (por defecto) | $0.30 / $1.20 |
| Z.ai | GLM-5.3 FlashX | $0.37 / $1.25 |
| Z.ai | GLM-5.3 Prime | $2.80 / $8.80 |
| MiniMax | MiniMax M3.1 Flash | gratis |
| Claude | Haiku 5.5 / Sonnet 5.5 / Opus 5.5 | $0.10 / $0.50 · $2 / $10 · $4 / $20 |
| OpenAI | GPT-6 Luna / GPT-6 Sol | $0.10 / $0.50 · $2 / $10 |
| Otro | Cualquier ID de [openrouter.ai/models](https://openrouter.ai/models) | — |

Los precios cambian; el saldo real y el gasto se ven en el donut junto al botón de enviar.

## Cómo funciona

- Las peticiones van directas del navegador a `https://openrouter.ai/api/v1/chat/completions` con streaming.
- La API key se guarda en `localStorage` de tu navegador. No pasa por ningún servidor propio.
- Razonamiento configurable por chat (`auto`, `low`, `medium`, `high`).
- Adjuntos: PDF, Word, Excel y texto se extraen en el navegador; las imágenes se mandan al modelo si las admite.
- Historial en el navegador. Google Drive es opcional: si inicias sesión, se sincroniza allí.
- Guided Learning (modo tutor con mapa del temario y mini tests) sigue disponible.

Nota: la key queda en el navegador, así que no la uses en ordenadores compartidos. En OpenRouter puedes ponerle un límite de gasto.
