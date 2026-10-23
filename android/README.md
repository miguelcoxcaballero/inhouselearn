# Inhouse Learn para Android

La APK es una capa nativa mínima (≈180 KB) alrededor de la web
https://miguelcoxcaballero.github.io/inhouselearn/. Cada cambio en `index.html` publicado en
`main` llega a la app sin APK nueva; solo hace falta APK nueva para cambios en `android/`.

## Qué hace la capa nativa (`MainActivity.java`)

- WebView a pantalla completa, de borde a borde, con la web colocada entre las barras del
  sistema y por encima del teclado (el cuadro de mensaje nunca queda tapado).
- Pantalla de inicio con la bombilla hasta que la web ha pintado (máximo 2,5 s).
- Modo noche de verdad (desde 1.0.4): el tema lo elige la web (Auto / Claro / Oscuro
  AMOLED) y la app solo lo viste: iconos claros en las barras y negro puro de fondo
  cuando la página está en oscuro, y al revés en claro. Mientras no hay página mandan
  los recursos: `values-night/colors.xml` (`app_background` = `#000`) y
  `values*/bools.xml` (`light_status_bars`).
- Puente `window.InhouseLearnApp` solo para el origen `https://miguelcoxcaballero.github.io`
  y el marco principal (`WebMessageListener`, nunca `addJavascriptInterface`). Mensajes:
  - `signIn`: abre el inicio de sesión de Google en una Chrome Custom Tab (Google no
    permite su login dentro de un WebView).
  - `save`: descargas (ZIP de archivos, exportaciones) con el diálogo «Guardar como» de Android.
  - `open`: enlaces externos en una Custom Tab o en su app.
  - `updates`: abre los ajustes del actualizador (menú de perfil → «Actualizaciones»).
   - `theme`: `{dark: true|false}`, el tema que está enseñando la web (`theme.js`). La app
     pinta con eso los iconos de las barras del sistema y el color de detrás (negro puro
     en noche AMOLED). Quien decide el tema es siempre la web, nunca la app.
- Botón Atrás: primero cierra lo que tenga abierto la web (diálogos, menús, barra lateral).
- Sin conexión: usa la copia en caché y, si no hay, una pantalla «Sin conexión» con «Reintentar».
- Selector de archivos para adjuntos (varios a la vez).
- Micrófono (desde 1.0.3): permiso de audio solicitado al grabar, únicamente para
  el origen de Learn. La web usa MediaRecorder y Whisper local, sin cuentas ni envío de audio; nunca el dictado
  del teclado. Al salir de la app se detiene la grabación para revisar el texto.
- Sin copia de seguridad de Android (`allowBackup=false`): el almacenamiento del WebView
  guarda el token de Google y la key de OpenRouter. Los chats ya se sincronizan con Drive.

### Inicio de sesión con Google

1. La web (bloque `ANDROID APP` de `index.html`) pide a la app abrir
   `accounts.google.com/o/oauth2/v2/auth` con `response_type=token` y un `state` aleatorio.
2. Google redirige la Custom Tab a `https://miguelcoxcaballero.github.io/inhouselearn`
   (la única URI de redirección autorizada en el cliente OAuth; sin barra final) con el token
   en el fragmento. Un script al principio de `index.html` ve `state=android.…` y pasa el
   fragmento a `app-auth.html`, que lo entrega a la app con
   `intent://auth?...;package=com.inhouse.learn` (solo puede abrirlo esta app) y deja un botón
   «Volver a la app» por si Chrome no abre el intent solo.
3. La app llama a `window.inhouseLearnAuth(query)`; la web comprueba el `state` y guarda el token.

**Google Cloud:** el cliente OAuth `435784295430-cmug…` ya tiene
`https://miguelcoxcaballero.github.io/inhouselearn` como URI de redirección autorizada; la
app usa exactamente esa (`redirect_uri` en `requestGoogleAccessTokenInApp`). Si cambia el
cliente o la URL de la web, Google responde `redirect_uri_mismatch` hasta registrar la nueva.
El token dura una hora; al caducar, la app pide volver a entrar con un toque.

## Firma (importante para el futuro)

- Todas las APK publicadas se firman con **la clave permanente de Inhouse**, la misma que
  Inhouse YouTube e Inhouse Instagram. Certificado SHA-256:
  `7133a4b3e4b9f9c4d2fbbd38b7dd2d44c7b8d0d7d16568bfe3da74a09e7887b6`.
- La clave está **solo** en el secreto de GitHub **`EJEMPLO`** de `youtube-calma` y de `ig-calma`
  (base64 del keystore, contraseña de build `localbuild`). GitHub no deja leer ni copiar un
  secreto, así que este repositorio no lo tiene y **no firma**: la APK se firma en
  `youtube-calma` con el workflow **Sign Inhouse Learn**
  (`.github/workflows/sign-inhouse-learn.yml` de ese repositorio). Ese workflow compila Learn
  desde el commit exacto que se le indica, busca en el keystore la entrada cuyo certificado
  coincide con ese SHA-256, firma con `apksigner` (esquemas v2 y v3), comprueba que el único
  firmante es ese certificado, borra la clave del runner y deja la APK firmada como
  *prerelease* pública de `youtube-calma` (`learn-signed-<versión>-<sha corto>`; solo se
  conserva la última).
- El workflow **Android app** de este repositorio, al publicar, descarga esa copia, comprueba
  hash, firmante, paquete, versión y que `build-info.json` apunta a este mismo commit, la abre
  en el emulador y entonces la publica como release propia. Si alguien añade `EJEMPLO` aquí
  no cambia nada: la firma sigue haciéndose en `youtube-calma`.
- **Nunca** subas al repositorio un keystore, una contraseña ni su base64, ni firmes una
  publicación con otra clave: Android no deja actualizar una app instalada si la firma cambia,
  y habría que desinstalarla (perdiendo sus datos locales).
- El paquete `com.inhouse.learn` es permanente por el mismo motivo.

## Versiones y actualizaciones (Inhouse services updater)

- Versión en `app/build.gradle.kts`: sube **`versionCode`** (siempre crece, nunca se reutiliza)
  y `versionName` en cada APK publicada.
- Las actualizaciones las gestiona el actualizador común de Inhouse, sincronizado desde
  https://github.com/miguelcoxcaballero/inhouse-services-updater (léete `../UPDATER.md`):
  - `MainActivity` llama a `NativeUpdates` en `onResume`/`onPause`/`onDestroy`: un WebView
    oculto con los recursos locales `app/src/main/assets/updates` lee `updates/A.json` o
    `updates/B.json` de este repositorio y, si hay una versión nueva, abre `UpdateActivity`.
  - La instalación usa el instalador congelado (`PhotosUpdateInstaller.kt`): descarga,
    comprueba SHA-256, paquete, versionCode y firma, y entrega la APK a Android con
    `ACTION_VIEW` a través de `${applicationId}.update-provider`, registrado con la clase
    propia `UpdateFileProvider`. No se toca: `../vendor/inhouse-services-updater/FROZEN_INSTALLER.md`.
  - La web nunca recibe el puente de instalación.
  - Canal **B** por defecto. Las publicaciones nuevas van a **A**; B solo cuando el usuario lo
    pide expresamente. «Later» aplaza los avisos 14 días.
- `app/src/main/assets/updates/`, `app/src/main/java/com/inhouse/services/updater/` y
  `../vendor/inhouse-services-updater/` los escribe `tools/sync.py` del repositorio
  canónico (`python3 tools/sync.py learn <ruta a inhouselearn>`); no se editan a mano.

## Publicar una versión

1. Sube `versionCode` y `versionName` en `app/build.gradle.kts` y haz push a `main`.
   El workflow **Android app** compila la release minificada, la firma con una clave de
   prueba y la abre en un emulador Android 15 (web, retorno del login, actualizador).
2. En **`youtube-calma`**: *Actions → Sign Inhouse Learn → Run workflow* con `ref` = el SHA
   completo del commit de `main` de este repositorio que quieres publicar. Compila, firma con
   `EJEMPLO` y deja la APK firmada en la prerelease `learn-signed-X.Y.Z-<sha corto>`.
3. En este repositorio: *Actions → Android app → Run workflow* en `main` (el mismo commit),
   con **publish** marcado y un changelog mínimo en inglés (2–10 palabras, máx. 120
   caracteres). Descarga la APK firmada, la verifica, repite la prueba en el emulador, crea
   la release `android-vX.Y.Z` (`inhouse-learn-X.Y.Z.apk`, `SHA256SUMS.txt`,
   `android-update.json`), descarga la APK pública para comprobar hash, tamaño, firma, paquete
   y versión, y solo entonces añade la versión a `updates/A.json` con
   `vendor/inhouse-services-updater/catalog.py`.
   Si `main` cambió entre los pasos 2 y 3, repite el paso 2 con el SHA nuevo.

**Desde la propia app:** en un chat con GitHub activado (+ → GitHub), el modelo puede hacer
los pasos 1–3 él solo con la herramienta `github_release_android` (`engine/src/github.js`):
comprueba que el `versionCode` de `main` supera el de `updates/A.json` y que la release no
existe, **te pide confirmación siempre** (también en «Acceso total»), espera un build verde de
ese commit (lo lanza si no hay), lanza *Sign Inhouse Learn* con ese SHA exacto, comprueba la
prerelease y que `main` no se ha movido, lanza la publicación y verifica `updates/A.json`. Si
algo falla se para con el enlace y el error. Nunca toca el canal B. El token de GitHub de la
app necesita **Actions: lectura y escritura** en este repositorio **y** en `youtube-calma`
(además de Contents y Pull requests en escritura aquí). Prueba: `tests/web/release.cjs`.

La primera instalación es manual: descarga la APK de la release y ábrela en el móvil
(Android pedirá permitir instalar apps de esa fuente). Las siguientes llegan por el actualizador.

**Aviso de publicación:** el workflow **APK published** (`.github/workflows/apk-published.yml`,
cada 3 horas) lee `updates/A.json` y, cuando hay una versión nueva, abre el issue
«APK X.Y.Z publicada» con enlace, hash y changelog; GitHub manda ese issue por correo. Solo lee:
no publica ni toca los canales. `MIN_VERSION_CODE` en ese workflow es la versión desde la que avisa.

Si el step **Build the minified release** falla, la causa sale como anotación en el run
(`::error::`): `android.yml` guarda el log de Gradle y publica ahí las líneas `error:`/`FAILURE:`.

## Compilar en local

Necesitas JDK 17 y el Android SDK (plataforma 35):

```bash
cd android
./gradlew assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
./gradlew assembleRelease      # sin firmar; las publicaciones se firman solo en GitHub Actions
```
