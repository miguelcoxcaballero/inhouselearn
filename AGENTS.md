# Inhouse Learn

Mandatory guidance for every AI and developer working in this repository.

- The app is the static web page (`index.html`, served by GitHub Pages from `main` at
  https://miguelcoxcaballero.github.io/inhouselearn/). Every push to `main` is live for the
  web and for the Android app at once, because the APK loads that same page.
- The Android app (`android/`) is a thin WebView shell around that page. Read
  `android/README.md` before touching it.
- **Signing:** every published APK is signed with the permanent Inhouse key shared with
  Inhouse YouTube and Inhouse Instagram (certificate SHA-256
  `7133a4b3e4b9f9c4d2fbbd38b7dd2d44c7b8d0d7d16568bfe3da74a09e7887b6`). That key exists only
  as the secret `EJEMPLO` of `youtube-calma` and `ig-calma`; GitHub cannot copy a secret, so
  this repository does not sign. `youtube-calma`'s workflow **Sign Inhouse Learn** builds a
  given commit of this repository, signs it and stages it as a public prerelease there;
  `.github/workflows/android.yml` (publish) verifies and publishes that APK as this
  repository's release. Never commit a key, keystore, password or its base64, never add a
  second copy of the key, and never sign a release with another key: Android refuses to
  update an installed app signed with a different key. Steps in `android/README.md`.
- **Package and versions:** the package ID `com.inhouse.learn` is permanent. Every new APK
  raises `versionCode` (and `versionName`) in `android/app/build.gradle.kts`; never reuse or
  lower a versionCode and never replace an already published release.
- **Google sign-in in the app** runs in a Chrome Custom Tab and returns through the OAuth
  client's registered redirect URI `https://miguelcoxcaballero.github.io/inhouselearn`
  (exactly that, no trailing slash) → the early script at the top of `index.html` →
  `app-auth.html` → `inhouselearn://auth`. Keep those three and `MainActivity` in step, and
  keep `redirect_uri` equal to a URI registered on the client.
- **Updates** come from the shared Inhouse services updater below: the native
  `MainActivity` calls `NativeUpdates`, and the popup and settings are `UpdateActivity`.
  The web page never receives an install bridge; it only asks the shell to open the
  updater settings (`{type: 'updates'}`).
- **Chat modules:** `stream.js` (smooth streaming: block renderer and thread follow),
  `visuals.js` (```visual / ```mermaid cards; `VISUALS_PROMPT` is the model-facing format),
  `guided.js` + `guided.css` (Guided Learning: the app owns the course state machine; the
  model only teaches and calls `set_course_plan`, `quiz` and `final_exam`, defined in
  `engine/src/guided.js`; rebuild `vendor/pi-engine.js` after changing the engine). Keep the
  model's task in `courseTaskText()` explicit, and never let the model own course state.
  `scene.js` adds the animated `scene` (declarative) and `sandbox` (iframe with
  `sandbox="allow-scripts"` only and a CSP with `default-src 'none'`; never add
  `allow-same-origin`, never relax the CSP) types; schema in `docs/visual-schema.json`, tests
  in `tests/web`. `haptics.js` sends `{type: 'haptic', style}` to the Android shell
  (`MainActivity.haptic`), with `navigator.vibrate` as the browser fallback.
- **Chat library:** `library.js` keeps the files a user uploads to a chat (folders, PDFs page by
  page, photos and scanned pages read with OCR) in IndexedDB and in the user's Drive folder
  (`library-<id>.json`); the model reaches them only through the `search_library`,
  `read_library`, `list_library` and `view_library_image` tools (`engine/src/library.js`).
  Big uploads never go into the message itself, only a short manifest.
- **Live sync:** devices of the same account open WebRTC data channels to each other, signalled
  through `peer-<deviceId>.json` files in the Drive folder; the answering device sends every change
  at once and a `saved` notice after each Drive save. When a direct connection is not possible,
  it writes `live.json` in Drive and the others poll it every second (`liveShareStart`, `liveTick`,
  `peerTick` in `index.html`).
- Never edit `vendor/inhouse-services-updater/`, `android/app/src/main/assets/updates/` or
  `android/app/src/main/java/com/inhouse/services/updater/` by hand: they are written by the
  canonical repository's `tools/sync.py`, and `vendor/inhouse-services-updater/verify.py`
  fails the build if they drift.

# Inhouse services updater — mandatory shared updater policy

Canonical repository: https://github.com/miguelcoxcaballero/inhouse-services-updater

Every AI/developer working in this app must read this section even without opening the updater repository:

- **The Android installer is FROZEN** at tag `installer-known-good` (verified on a real Samsung phone, 2026-10-20). Never edit, refactor, reformat or delete `vendor/inhouse-services-updater/android/PhotosUpdateInstaller.kt`, `vendor/inhouse-services-updater/android/UpdateFileProvider.java` or `vendor/inhouse-services-updater/register_android.py`, and never register `.update-provider` with `androidx.core.content.FileProvider` or replace `ACTION_VIEW`. `verify.py` fails the build if they change. Read `vendor/inhouse-services-updater/FROZEN_INSTALLER.md`; only the user, in their own words, can unfreeze it.
- **B is the default update channel.** A requires an English development warning, explicit acknowledgement and slide confirmation. Legacy implicit A preferences migrate to B; choosing B clears A consent. This does not authorize publishing or promoting a B release.
- New changes and automatic releases go to **A** unless the user explicitly requests B.
- **A receives all A and B releases; B receives only B releases.** The highest global Android versionCode wins: a newer B supersedes an older A for A users, while an older B never displaces a newer A.
- **B** (reviewed releases) requires the user's **explicit request**. Tests passing is not permission to publish or promote. B may promote an existing A release or publish a new verified APK directly; a previous A publication is not required.
- Every release needs a tiny changelog: preferably 2–10 words, maximum 120 characters.
- Never independently edit updater copies. Change the canonical repository first, test, commit, and sync the SAME revision into YouTube, Instagram, Notes, Photos, Read and Learn using its `tools/sync.py`.
- Commit `inhouse-updater.lock.json` and shared files together. Build checks must reject drift. App identity and host integration are the only permitted differences.
- Updates are optional. Later snoozes automatic prompts for 14 days; manual updates remain available in settings. The popup and settings both expose A/B selection.
- Keep APK package and signing key; increment Android versionCode globally across A/B. Switching channels never downgrades or deletes user data.
- Publish each exact verified signed APK before its matching channel catalog. Never replace a published binary or its immutable metadata. Use `updates/A.json` and `updates/B.json`.
- The publisher mirrors every B release and its exact metadata into A, preserving a newer A as latest. Existing clients therefore receive B releases through A without an APK update. B never falls back to A; neither channel uses generic GitHub latest. B initially has no releases until explicitly requested.
- See the central `AGENTS.md`, `docs/PROTOCOL.md` and `tools/catalog.py` before changing publication logic.

This section supersedes older instructions that mandate blocking update gates, independently copied updaters, unconditional latest/stable publication, disjoint A/B catalogs, or publication in A before an explicitly requested B release. Existing signature and integrity requirements remain in force.
