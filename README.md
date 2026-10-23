# inhouse learn

Chat con IA para estudiar que corre entero en el navegador. Sin instalador ni servidor: abres https://miguelcoxcaballero.github.io/inhouselearn/ (o `index.html`), pegas tu API key de [OpenRouter](https://openrouter.ai/settings/keys) y eliges modelo. Pagas por tokens con tu saldo de OpenRouter.

## App Android

Hay una APK optimizada para el móvil: una capa nativa mínima (≈180 KB) alrededor de esta misma web, con el logo de la bombilla, pantalla completa, teclado que no tapa el cuadro de texto, botón Atrás, descargas, adjuntos y el inicio de sesión de Google en una Chrome Custom Tab. Cada cambio de la web llega a la app sin APK nueva.

- **Firma:** la misma clave permanente que Inhouse YouTube e Inhouse Instagram (certificado SHA-256 `7133a4b3e4b9f9c4d2fbbd38b7dd2d44c7b8d0d7d16568bfe3da74a09e7887b6`). La clave está solo en el secreto `EJEMPLO` de `youtube-calma`, así que la APK se firma allí (workflow *Sign Inhouse Learn*) y este repositorio la verifica y la publica. Nunca se sube una clave al repositorio.
- **Actualizaciones:** el actualizador común [Inhouse services updater](https://github.com/miguelcoxcaballero/inhouse-services-updater) (canales A/B en `updates/A.json` y `updates/B.json`, B por defecto). En la app: menú de perfil → «Actualizaciones».
- **Publicar:** en `youtube-calma`, *Sign Inhouse Learn* con el SHA del commit; después, aquí, *Android app → Run workflow* con «publish». Detalles y reglas en [android/README.md](android/README.md), [AGENTS.md](AGENTS.md) y [UPDATER.md](UPDATER.md).

## Modelos

No hay lista fija: el selector muestra en vivo todos los modelos de chat de OpenRouter, de todas las compañías, con su precio por millón de tokens (entrada / salida).

- **Recomendados ahora**: arriba salen los más usados esa semana en OpenRouter (`GET /api/v1/models?sort=top-weekly`). Cambian solos con el tiempo.
- **Buscador**: busca por nombre de modelo, compañía o ID. Con Enter se elige el primero.
- **Compañías**: chips con todas las compañías, ordenadas por uso.
- **Cualquier ID**: si escribes un ID completo (`compañía/modelo`) que no está en la lista, se puede usar igual.
- **Razonamiento**: cada modelo ofrece los niveles que admite según OpenRouter (no, mínimo, bajo, medio, alto, máximo) y empieza en el que OpenRouter usa por defecto.
- **Filtros** (botón «Filtros» junto al buscador): Gratis, Razona, Imágenes, Audio, Vídeo, Archivos y Herramientas, combinables, a partir de lo que OpenRouter publica de cada modelo (precio, `reasoning`, `input_modalities`, `supported_parameters`); **inteligencia mínima** con un deslizador; y orden por populares, más inteligentes o más baratos.
- **Inteligencia**: el velocímetro de cada modelo marca el *Intelligence Index* de [Artificial Analysis](https://artificialanalysis.ai/) tal como lo publica OpenRouter en su listado (`benchmarks.artificial_analysis.intelligence_index`), con el número debajo. No hay ninguna lista escrita a mano: cualquier modelo nuevo trae su puntuación en cuanto OpenRouter la publica, y la escala (rojo, amarillo, verde) va de 0 a la mejor puntuación de la lista redondeada a la decena, así que crece sola.
- **Precio**: arriba en rojo el de salida (el caro) y abajo en verde el de entrada, en dólares por millón de tokens.

La lista se guarda en el navegador para que el selector se abra al instante y se refresca cada hora. Un chat nuevo usa el último modelo que elegiste; la primera vez, el más usado de la semana.

## Motor: pi

El chat corre sobre [pi](https://github.com/earendil-works/pi): `@earendil-works/pi-ai` pone OpenRouter (API `openai-completions`), el streaming, el razonamiento y el cálculo de coste, y `@earendil-works/pi-agent-core` el bucle del agente con herramientas. Están empaquetados para el navegador en `vendor/pi-engine.js`, así que la web sigue siendo estática.

### Herramientas del agente

- **Ejecutar JavaScript** (`run_js`): en un Web Worker aparte, sin red ni acceso a la página, con 15 s de límite. Sirve para cálculos exactos, comprobar soluciones o generar datos.
- **Archivos del chat** (`write_file`, `read_file`, `edit_file`, `list_files`, `delete_file`): apuntes, esquemas, código o CSV que se guardan con el chat. Aparecen encima del cuadro de texto, se pueden abrir y se descargan todos en un ZIP.

- **Aprendizaje guiado** (`set_course_plan`, `quiz`, `final_exam`, en `engine/src/guided.js`): solo en ese modo; ver más abajo.

Cada respuesta muestra los pasos con herramientas que ha dado (plegados). Si un modelo no admite herramientas, la petición se repite sin ellas (salvo en el aprendizaje guiado, que las necesita).

## Aprobación de cambios

En el menú **+**, «Aprobación de cambios» decide cuánto le preguntas al modelo antes de que cambie algo. El modo es de cada chat y se guarda con él (también en Drive):

- **Preguntar**: pide permiso para escribir o borrar archivos del chat y para subir a GitHub.
- **Auto**: los archivos del chat se guardan sin preguntar; cada subida a GitHub se pregunta una vez, con todos sus archivos.
- **Acceso total**: no pregunta nada, tampoco en GitHub (el + lleva un punto rojo).

Las aprobaciones salen en una tarjeta encima del cuadro de texto, no a pantalla completa. Las lecturas nunca preguntan, y en GitHub el modelo prepara todos los cambios y los sube juntos en un solo commit; lo que deje preparado aparece encima del cuadro con «Subir en un commit» y «Descartar». Al pulsar «Subir en un commit» el propio botón se convierte en la pantalla de carga: spinner, «Subiendo N archivos…» y una barra que avanza; si el commit entra, el botón se queda un instante en «Subido» con su tilde y la tarjeta desaparece, y si algo falla vuelve a estar listo para reintentar con el error en un aviso. Detalles en `docs/approval.md`.

## Mientras el modelo trabaja

- Puedes seguir escribiendo: **Enter** pone el mensaje en la cola (encima del cuadro) y sale solo cuando termina la respuesta anterior. **Parar** deja la cola en pausa («Seguir» la reanuda).
- **Ahora** en un mensaje de la cola (o **Ctrl/Cmd+Enter**) lo mete en el trabajo en curso: entra en cuanto acaba el paso actual, sin cancelar nada, y el modelo sigue con eso.
- En el hilo se ve qué está haciendo en cada momento (leyendo un archivo, buscando, preparando un cambio, subiendo…), con el tiempo y los pasos ya hechos.

## Aprendizaje guiado

El botón del birrete convierte el chat en un curso. La lógica la lleva la app (`guided.js`), no el modelo:

1. **Plan**: eliges nivel y duración, dices el tema (o subes apuntes) y el tutor llama a `set_course_plan`. El plan sale como una ruta: unidades con su emoji, lecciones numeradas con minutos estimados y objetivos que se despliegan, y el examen al final. Debajo, «Empezar el curso» y ajustes de un toque (más fácil, más corto, más a fondo, más práctico).
2. **Lecciones**: una barra arriba enseña el curso, la lección actual y el progreso, y se despliega en el mapa del temario (con «Saltar» si ya la dominas). La primera explicación de cada lección y cada repaso traen siempre una vista interactiva. Debajo de cada respuesta hay respuestas rápidas: Sigue, Muéstramelo, Otro ejemplo, No lo entiendo, Ponme a prueba.
3. **Mini test** por lección (`quiz`): corrección al momento con explicación. Con un 70 % se aprueba y se pasa a la siguiente; si no, el tutor vuelve a explicar justo lo que fallaste y repite el test con preguntas nuevas.
4. **Examen final** (`final_exam`) de todo el curso, con nota por lección, y repaso final. Se puede repetir.

Cada petición manda al modelo el estado del curso y una única tarea concreta («enseña L3», «llama a `final_exam` ahora»), así que no se pierde ni se olvida el examen. Si se salta un paso, la app se lo recuerda con un aviso oculto y lo vuelve a pedir. Todo (plan, notas, respuestas) se guarda con el chat y se sincroniza en Drive.

## Vistas visuales e interactivas en el chat

El modelo puede responder con un bloque ```` ```visual ```` (JSON) y el chat lo dibuja como tarjeta interactiva (`visuals.js`): gráficas de funciones con deslizadores y lecturas en vivo, fórmulas para jugar con sus variables, gráficos de barras, líneas, tarta y dispersión, tarjetas de memoria (con «La sé» / «Repasar»), soluciones paso a paso, líneas de tiempo, comparativas, preguntas rápidas e ideas clave. Los bloques ```` ```mermaid ```` se dibujan como diagramas (mermaid se carga solo la primera vez). Las expresiones las calcula un intérprete propio, nunca `eval`. El LaTeX dentro del JSON se acepta tal como lo escriben los modelos (`\frac`, `\(x^2\)`, sin escapar). En el aprendizaje guiado, «Muéstramelo» (debajo de la última respuesta) pide una vista; en el chat normal no hay botón: basta con pedírsela.

### Fotos y vistas previas mientras responde

Además de las tarjetas, el modelo puede enseñar **imágenes** dentro de la respuesta y, sobre todo, **vistas previas de verdad** de un cambio de interfaz:

- **`image`** (y `gallery`, de 2 a 6): una foto, un mapa, una ilustración o una figura, con pie y crédito. La imagen llega por URL `https`, por `data:image` o dibujada en SVG por el propio modelo: el SVG se limpia con DOMPurify y el `src` pasa una lista blanca, así que `javascript:` y los atributos pegados no entran. Si una imagen no carga, queda el enlace en vez de un hueco roto.
- **`preview`**: el HTML y el CSS que propone el modelo, dibujados en un `iframe` con `sandbox=""` (sin scripts y sin poder tocar la página; ni siquiera puede leer el `contentDocument`). Sirve para lo que pedías: «cámbiame esta tarjeta» y verla antes de tocar nada, con `device: "phone"` o `"desktop"`, su altura y una nota de qué cambia. **No es una captura de la app**: es lo que habría que construir, renderizado de verdad con sus estilos.
- Aparecen **a medida que contesta**: cada bloque se sustituye en cuanto se cierra, así que ponerlos detrás de cada párrafo deja ver el progreso sin esperar al final. La app le pide al modelo que los reparta así cuando pides ver algo o cuando el tema lo pide, y que nunca invente URLs de imágenes.

### Ejercicios en el chat

Seis tipos más en los que el alumno hace algo (`practice.js`): **emparejar** (términos con definiciones), **ordenar** (pasos o fechas), **clasificar** (elementos en grupos), **completar huecos** (con desplegables), **estimar** (adivinar un número con un deslizador y ver el real) y **verdadero o falso**. El modelo los escribe con la respuesta en su sitio natural y la tarjeta los baraja (siempre igual para la misma tarjeta). En cada petición la app le dice al modelo qué tipos ha usado ya en ese chat para que vaya variando.

### Sin pistas en las respuestas

En los mini tests, el examen final y las preguntas rápidas, la posición de la respuesta correcta la decide la app, no el modelo: se reparte por igual entre A, B, C y D (cada test saca las posiciones de una bolsa barajada) y los distractores también se barajan. Si en demasiadas preguntas la respuesta correcta es claramente la más larga, la app le devuelve el test al modelo para que reescriba los distractores (como mucho dos veces).

### Simulaciones animadas e interactivas

Además, dos tipos más (`scene.js`):

- **`scene`**: animaciones y escenas interactivas descritas en JSON, sin código: formas, etiquetas con valores en vivo, curvas que cambian con el tiempo, partículas que fluyen por un camino (y aceleran donde el camino se estrecha), campos vectoriales, mapas de calor, muelles, un péndulo real, puntos que se arrastran, puntos que se añaden tocando y dibujo libre. Cualquier número puede ser una expresión de los controles, del tiempo `t`, de variables, de un estado que se integra en el tiempo (física sencilla) y de funciones propias. Controles: deslizadores, interruptores y botones; reproducir, pausar, reiniciar y velocidad.
- **`sandbox`**: para lo que no cabe en una escena (un algoritmo animado, un juego), HTML y JavaScript del modelo dentro de un `iframe` con `sandbox="allow-scripts"` y una CSP que bloquea toda conexión; no puede tocar la página ni la red, se puede pausar y se pausa sola si gasta demasiada CPU.

Puede haber varias vistas por mensaje, intercaladas con el texto (hasta 8; desde la quinta animación, o la novena vista, aparecen tras un botón). Solo se animan las que se ven (como mucho 4 a la vez, a 30 fps en el móvil) y, si el sistema pide menos movimiento, empiezan en pausa. Lo que hace el alumno con ellas (mover un control, un evento) le llega al tutor en el siguiente mensaje, y «Enviar al tutor» se lo manda al momento. Formato completo en [`docs/visual-schema.json`](docs/visual-schema.json), tres ejemplos listos para pegar en [`docs/visual-examples.md`](docs/visual-examples.md) y pruebas en [`tests/web`](tests/web) (`visuals.cjs` y `practice.cjs`).

## Vibración

En la app Android el chat vibra como ChatGPT: un toque suave al pulsar, uno más firme al enviar, una textura muy ligera mientras se escribe la respuesta, un pulso al terminar y un doble golpe en errores o respuestas falladas. Usa la vibración del propio sistema (respeta el ajuste del teléfono). En el navegador del móvil usa `navigator.vibrate`. Se apaga en el menú de perfil → «Vibración».

## Modo noche

El menú «+» trae «Modo noche» en tres posiciones: **Auto** (por defecto: sigue al móvil o al ordenador, y cambia solo si el sistema cambia de tema mientras lees), **Claro** y **Oscuro**, que es **AMOLED**: negro puro `#000` de fondo y superficies apenas más claras, para gastar menos en pantallas OLED. Se recuerda en este navegador y no toca los chats. El tema se elige antes de pintar la primera vez, así que al abrir en oscuro no hay destello claro, y todo se dibuja en el tema que toca: el chat, los cursos, los mini tests, los ejercicios y las gráficas, incluidos los diagramas de mermaid, que se vuelven a dibujar si cambias de tema con la app abierta. El CSS solo mira `data-theme` en `<html>` (`theme.css`), y el control lo monta `theme.js` dentro del menú «+».

## Respuestas fluidas

Mientras el modelo escribe (`stream.js`), cada párrafo terminado se dibuja una sola vez y ya no se toca; solo se redibuja el último, una vez por fotograma, y el texto aparece a ritmo constante. Las fórmulas, enlaces y vistas que aún están llegando esperan a estar completas en vez de enseñar su código, y el chat solo baja solo si estás abajo del todo (si subes a leer, se queda quieto y aparece un botón para volver al final).

### Recompilar el motor

```bash
cd engine
npm install --ignore-scripts
npm run build   # genera ../vendor/pi-engine.js
```

## Cómo funciona

- Las peticiones van directas del navegador a OpenRouter, con streaming. No hay servidor propio.
- La API key de OpenRouter se guarda en `localStorage` de tu navegador y, si entras con Google, también en el archivo de inhouse learn de tu Drive (junto al historial), para recuperarla al entrar desde otro navegador o desde la app Android. Gana la copia guardada más recientemente; borrar la key la borra también en Drive.
- **Uso** (el anillo junto a enviar): lo gastado con tu key hoy, esta semana, este mes y en total (`GET /api/v1/key`), y lo que te queda si la key tiene un límite de crédito. El saldo de toda la cuenta (`GET /api/v1/credits`) OpenRouter solo se lo da a una [key de gestión](https://openrouter.ai/settings/management-keys): si la pegas en el panel de uso, se usa solo para leer el saldo y se queda en este navegador.
- Los bloques de código ```latex se muestran como vista previa dentro del chat (título, secciones, listas, teoremas, tablas y fórmulas con KaTeX, incluidos los macros del paquete `physics`), con «Ver código» y «Copiar» al lado. No es un motor TeX: los comandos que no conoce conservan su texto.
- Adjuntos: PDF, Word, Excel y texto se extraen en el navegador; las imágenes se mandan al modelo si las admite y los PDF escaneados van como imágenes de sus páginas.
- Historial en el navegador. Si entras con Google (botón de arriba a la derecha), también se sincroniza en tu Google Drive, chat a chat: al entrar aparecen los chats de Drive y los de este navegador se suben; si dos dispositivos cambian cosas distintas se juntan (gana la copia más nueva de cada chat), un chat borrado no vuelve, cada guardado lee Drive antes de escribir para no pisar lo que guardó otro dispositivo, al salir de la app se guarda en el momento y al volver se traen los cambios de otros dispositivos.

Para el login de Google en la web de GitHub Pages, el origen `https://miguelcoxcaballero.github.io` tiene que estar en los orígenes de JavaScript autorizados del cliente OAuth, con los permisos `drive.file`, `userinfo.email` y `userinfo.profile`.

Nota: la key queda en el navegador, así que no la uses en ordenadores compartidos. En OpenRouter puedes ponerle un límite de gasto.
