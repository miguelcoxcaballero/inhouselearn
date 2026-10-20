# Inhouse Learn para Android

La APK es una capa nativa mínima (≈180 KB) alrededor de la web
https://miguelcoxcaballero.github.io/inhouselearn/. Cada cambio en `index.html` publicado en
`main` llega a la app sin APK nueva; solo hace falta APK nueva para cambios en `android/`.

## Qué hace la capa nativa (`MainActivity.java`)

- WebView a pantalla completa, de borde a borde, con la web colocada entre las barras del
  sistema y por encima del teclado (el cuadro de mensaje nunca queda tapado).
- Pantalla de inicio con la bombilla hasta que la web ha pintado (máximo 2,5 s).
- Puente `window.InhouseLearnApp` solo para el origen `https://miguelcoxcaballero.github.io`
  y el marco principal (`WebMessageListener`, nunca `addJavascriptInterface`). Mensajes:
  - `signIn`: abre el inicio de sesión de Google en una Chrome Custom Tab (Google no
    permite su login dentro de un WebView).
  - `save`: descargas (ZIP de archivos, exportaciones) con el diálogo «Guardar como» de Android.
  - `open`: enlaces externos en una Custom Tab o en su app.
  - `updates`: abre los ajustes del actualizador (menú de perfil → «Actualizaciones»).
- Botón Atrás: primero cierra lo que tenga abierto la web (diálogos, menús, barra lateral).
- Sin conexión: usa la copia en caché y, si no hay, una pantalla «Sin conexión» con «Reintentar».
- Selector de archivos para adjuntos (varios a la vez).
- Sin copia de seguridad de Android (`allowBackup=false`): el almacenamiento del WebView
  guarda el token de Google y la key de OpenRouter. Los chats ya se sincronizan con Drive.

### Inicio de sesión con Google

1. La web (bloque `ANDROID APP` de `index.html`) pide a la app abrir
   `accounts.google.com/o/oauth2/v2/auth` con `response_type=token` y un `state` aleatorio.
2. Google redirige la Custom Tab a `app-auth.html`, que pasa el resultado a la app con
   `intent://auth?...;package=com.inhouse.learn` (solo puede abrirlo esta app).
3. La app llama a `window.inhouseLearnAuth(query)`; la web comprueba el `state` y guarda el token.

**Requisito en Google Cloud:** el cliente OAuth `435784295430-…` debe tener
`https://miguelcoxcaballero.github.io/inhouselearn/app-auth.html` en **URI de redirección
autorizados**. Sin eso Google responde `redirect_uri_mismatch` al entrar desde la app.
El token dura una hora; al caducar, la app pide volver a entrar con un toque.

## Firma (importante para el futuro)

- Todas las APK publicadas se firman con **la clave permanente de Inhouse**, la misma que
  Inhouse YouTube e Inhouse Instagram. Certificado SHA-256:
  `7133a4b3e4b9f9c4d2fbbd38b7dd2d44c7b8d0d7d16568bfe3da74a09e7887b6`.
- La clave está solo en el secreto de GitHub **`EJEMPLO`** (base64 del keystore .p12/.jks,
  contraseña de build `localbuild`). Para este repositorio hay que añadirlo en
  *Settings → Secrets and variables → Actions* con **el mismo valor** que en `youtube-calma`.
- El workflow busca en el keystore la entrada cuyo certificado coincide con ese SHA-256, firma
  con `apksigner` (esquemas v2 y v3), comprueba que el único firmante es ese certificado y
  borra la clave del runner. Si el secreto falta o es otra clave, la publicación se para.
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
2. *Actions → Android app → Run workflow* en `main`, con **publish** marcado y un changelog
   mínimo en inglés (2–10 palabras, máx. 120 caracteres).
3. El workflow firma con la clave de `EJEMPLO`, repite la prueba en el emulador con esa APK,
   crea la release `android-vX.Y.Z` (`inhouse-learn-X.Y.Z.apk`, `SHA256SUMS.txt`,
   `android-update.json`), descarga la APK pública para comprobar hash, tamaño, firma, paquete
   y versión, y solo entonces añade la versión a `updates/A.json` con
   `vendor/inhouse-services-updater/catalog.py`.

La primera instalación es manual: descarga la APK de la release y ábrela en el móvil
(Android pedirá permitir instalar apps de esa fuente). Las siguientes llegan por el actualizador.

## Compilar en local

Necesitas JDK 17 y el Android SDK (plataforma 35):

```bash
cd android
./gradlew assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
./gradlew assembleRelease      # sin firmar; las publicaciones se firman solo en GitHub Actions
```
