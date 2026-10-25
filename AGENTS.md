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
  **A session that never expires in the app (APK ≥ 1.0.7, like Inhouse Notes):** with
  `APP_CONFIG.ANDROID_OAUTH_CLIENT_ID` set (an OAuth client of type *Android* for
  `com.inhouse.learn` + the Inhouse key's SHA-1 `3D:BE:BA:8C:62:10:B9:00:32:21:DB:DD:0F:45:94:69:D1:89:6B:76`,
  custom URI scheme enabled), sign-in uses PKCE: Google returns a code to
  `com.inhouse.learn:/oauth2redirect` (the APK's intent filter → `inhouseLearnAuth`), the page exchanges
  it with its verifier for an access token and a refresh token (localStorage
  `inhouse-learn-android-refresh-token`, this device only) and renews silently from then on
  (`refreshGoogleAccessTokenInApp`). A revoked refresh token is dropped; «Cerrar sesión» revokes it.
  Empty ID or an older APK: the one-hour implicit token as before. Test: `tests/web/android-pkce.cjs`.
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
  `learning.js` owns deterministic numeric grading, per-concept/day XP limits and spaced
  retrieval evidence; `guided.js` owns the interface and local review rounds. Keep `course.v=2`
  backwards compatible; old quizzes remain valid and receive no invented historical XP.
  Reviews preserve the current lesson and need no model request. A hint never counts as an
  independent recall. Numeric questions require a finite answer and an absolute tolerance in
  the requested unit; never evaluate learner input as code. `tests/web/learning.mjs` and
  `guided-learning.cjs` cover this flow. Pedagogical rationale: `docs/guided-learning.md`.
  `guided-stage.js/css` present the same message DOM as spacious learning screens, with
  local previous/next navigation and an accessible transcript toggle; do not clone live
  widgets or auto-scroll a focused screen to the bottom. The learner, never a message
  counter, advances `lesson.phase` (understand/apply/check). Confusion returns to understand
  and supersedes an unsubmitted lesson check; final exams and recall rounds stay intact.
  Both composer text and quick actions must pass through `guidedBeforeUserTurn`.
  `guided-wait.js/css` show optional local recall while a guided response is pending.
  Reuse only completed, answered questions via `GuidedLearning.waitingQuestions`; never
  change the active quiz/phase, send an extra model request, or award memory evidence/XP
  for these immediate repeats. Keep drafts/focus when the response arrives and let the
  learner return immediately. Haptic exercise patterns use the existing Android styles,
  respect the device switch and cancel queued pulses on hiding/disabling. Test: guided-wait.cjs.
  `explain.js` adds causal scene walkthroughs and `check_diagram` preflight measurements.
  It checks layouts, not physics. Preserve sandbox restrictions. `gTitle` safely renders
  math in course/lesson titles, including saved doubled escapes. Test: `guided-screens.cjs`.
  `scene.js` adds the animated `scene` (declarative) and `sandbox` (iframe with
  `sandbox="allow-scripts"` only and a CSP with `default-src 'none'`; never add
  `allow-same-origin`, never relax the CSP) types; schema in `docs/visual-schema.json`, tests
  in `tests/web`. `haptics.js` sends `{type: 'haptic', style}` to the Android shell
  (`MainActivity.haptic`), with `navigator.vibrate` as the browser fallback.
  `approval.js` + `approval.css` own the approval mode, a section of the + menu: per chat
  (`chat.approvalMode`), «Preguntar» (the user approves every change), «Auto» (the chat's own
  files are approved, GitHub uploads still ask) or «Acceso total» (nothing asks). It wraps the
  workspace tools and the GitHub `confirm` hook; every write still goes through it.
  `composer-dock.js` + `composer-dock.css` own what sits right above the composer: the approval
  card (`dockApprove`, never a fullscreen dialog for tool approvals), the GitHub changes prepared
  but not uploaded (`githubStageStore`: IndexedDB with a memory copy, never localStorage, which
  big files filled; test `tests/web/github-stage.cjs`), the message queue (Enter while the model works queues;
  each queued message goes out when the previous turn has fully ended) and steering («Ahora» or
  Ctrl/Cmd+Enter: pi's `agent.steer`, the message enters the running turn after the current
  tool, and the answer is split there into two messages). It also draws the live tool activity
  in the thread (`renderLiveSteps`).
- **Modo noche:** `theme.js` (en el `<head>`, antes del CSS) y `theme.css` (la
  última hoja) dan el tema oscuro a toda la app, y el oscuro es **AMOLED**:
  `--bg` es `#000` y las superficies son solo un pelín más claras, así que al
  añadir un color oscuro fijo hay que mantener esa escala. El estado vive en
  `localStorage` (`inhouselearn.theme`): «auto» sigue a `prefers-color-scheme`,
  también si el sistema cambia con la app abierta, y «light» / «dark» lo fijan.
  El CSS solo mira `data-theme` en `<html>`; `theme.js` monta el control
  (Auto · Claro · Oscuro) dentro del menú «+» desde JavaScript, como
  `approval.js`, y emite `themechange` en `document`. El modo claro es el de
  siempre: todo el oscuro cuelga de `html[data-theme="dark"]`, y lo que está
  escrito a mano en las demás hojas (tintes negros, estados verde/rojo/ámbar,
  el naranja de marca como texto y los botones «tinta» con
  `background: var(--text)`) se corrige en `theme.css`, no repartiéndolo por
  las otras hojas. Al añadir una vista, usa los tokens (`--bg`, `--surface`,
  `--text`, `--border`…); si escribes un color fijo, añade su versión oscura
  en `theme.css`. `visuals.js` dibuja mermaid en el tema activo y lo redibuja
  al cambiarlo. Prueba: `tests/web/theme.cjs`. En la app Android el WebView da a
  `prefers-color-scheme` el tema de la app, no el del móvil: desde la APK 1.0.5
  `MainActivity` llama a `window.inhouseLearnSystemNight(dark)` al cargar y en cada
  cambio de modo, y «Auto» usa eso (recordado para el primer frame). A una APK
  ≤ 1.0.4 la web nunca le pide barras claras (pintaba iconos oscuros sobre negro).
- **Chat library:** `library.js` keeps the files a user uploads to a chat (folders, PDFs page by
  page, photos and scanned pages read with OCR) in IndexedDB and in the user's Drive folder
  (`library-<id>.json`); the model reaches them only through the `search_library`,
  `read_library`, `list_library` and `view_library_image` tools (`engine/src/library.js`).
  Big uploads never go into the message itself, only a short manifest.
- **Documents:** `documents.js` (`InhouseDocs`) draws PDF (pdf.js), Word (docx-preview + html2canvas),
  PowerPoint (its own canvas renderer: boxes, text, pictures, tables, backgrounds, layout/master
  placeholders) and Excel (SheetJS) pages as images, and runs the model's code in a Worker with
  pdf-lib, docx, PptxGenJS, JSZip and SheetJS (fetched from jsDelivr and inlined into the worker,
  network removed). The model's tools (`engine/src/documents.js`): `doc_view` (pages as images, vision
  models only) and `doc_edit` (`readDocument`/`saveDocument`/`listDocuments`). What it saves goes into
  the chat library as a `generated` document (same path → replaced, same ref), always with its
  original (`originals` store, IndexedDB v2, images too; it travels to Drive inside `library-<id>.json` up to
  8 MB), and shows under the answer with «Ver» (every page) and «Descargar» (`step.documents`). In
  «Preguntar» saving asks first (`approveChange`). Uploaded PDF/Word/PowerPoint/Excel keep their
  original too, so they can be viewed and edited; `.pptx` is read slide by slide (notes included).
  Test: `tests/web/documents.cjs`.
- **LaTeX:** `latex.js` (`InhouseTex`) runs TeX Live 2026 inside the browser with BusyTeX
  (WebAssembly, AGPL, loaded at run time from `texlyre.github.io/texlyre-busytex/core/busytex/`, which
  serves it with CORS): pdflatex, xelatex, lualatex, BibTeX/Biber, makeindex and reruns. Nothing is
  uploaded anywhere; only the engine (~32 MB) and the TeX Live packages download, once, into the Cache
  API (`inhouse-texlive-2026`). Levels are cumulative and a worker mounts only one: `recommended`
  (201 MB) first, `extra` (342 MB) when a file is missing; babel's "Unknown option" retries with
  `provide=*`. The worker is a Blob that `importScripts` `busytex_pipeline.js` (a cross-origin Worker
  cannot be created) and stops after 5 idle minutes. The model writes the sources as chat files and calls
  `latex_compile` (`engine/src/documents.js`): every chat text file plus the library's PDFs/images go to
  the compiler, errors come back with their line, the PDF goes to the library like `doc_edit`'s output
  (same approval). Test: `tests/web/latex.cjs` (downloads TeX Live, so not in `run-ci.sh`).
- **GitHub connector:** `engine/src/github.js` gives the model `github_*` tools (list repos and
  files, read, search code, one-commit multi-file writes through the git data API, exact edits,
  pull requests, issues and comments) with the user's fine-grained token, kept only in that
  browser's localStorage, never in Drive. Tools are on per chat (+ menu → GitHub) and every write
  goes through the approval gate of `approval.js`: with the chat in «Preguntar» or «Auto» the
  user sees the files and the +/− lines in `confirmDialog` and decides; only in «Acceso total»
  (the user's explicit, per-chat choice) a write is approved without asking (the step stays in
  the thread's live activity). **The app shows no floating notices at all** (the user asked for none):
  `showToast` only logs to the console and `window.__inhouseNotices`; errors show where they happen. Never add a write that skips that gate. The app can also ship its
  own APK: `github_release_android` checks that `main` raises `versionCode` above
  `updates/A.json`, **always asks** (even in «Acceso total», via `always: true`), waits for a
  green "Android app" build of that exact commit, runs youtube-calma's **Sign Inhouse Learn**
  with that SHA, then this repository's publish, and verifies `updates/A.json`; it stops on any
  failure or if `main` moves, and never touches channel B. Its token needs Actions read/write
  on both repositories. Test: `tests/web/release.cjs`.
  **Real screenshots (any project):** `github_screenshot` photographs a branch or commit of any
  repository the token reads, or any public URL: `.github/workflows/screenshots.yml` checks out the
  project (optional `setup`, `serve` folder or its own `start` server on :8765), Chromium opens it
  (`.github/scripts/screenshots.cjs`, always from this repo's `main`; Inhouse Learn itself with
  OpenRouter mocked like `tests/web`, so a conversation can be replayed), runs the steps, and the PNGs
  land on the `screenshots` branch (`<id>/`, newest 30 kept); the model shows them with `image` blocks.
  Public projects and URLs run here. A **private** repository runs the same file copied into it as
  `.github/workflows/inhouse-screenshots.yml` (installed once through the approval gate), so its code
  and pictures stay private; the chat loads those images with the user's token
  (`window.inhousePrivateImage`). The project's code runs in a read-only job; only the publish job
  writes. In «Auto» the screenshot itself does not ask. A `preview` is a mockup, never presented as a
  screenshot.
- **The user's Google Drive:** + menu → Google Drive (per browser, `localStorage` `::userDrive`;
  on per chat, `chat.userDrive`). Connecting asks Google only for `drive.readonly` (added to
  `googleOauthScopes()`, checked with tokeninfo; if Google does not grant it nothing is connected).
  The model searches and reads with `drive_search`, `drive_list`, `drive_read` (`engine/src/gdrive.js`;
  Docs/Sheets/Slides exported as text, PDFs by pages with pdf.js, images as pictures). Every change
  (`drive_write_file`, `drive_edit_file`, `drive_organize`) is one call for one file and one action and
  goes through `approveChange` with `always: true`: it asks EVERY time, also in «Acceso total»; the
  first approved change asks Google for `drive` (write). Never add a Drive write that skips this.
  `drive_read` also reads Word/PowerPoint/Excel and their templates (`.dotx/.potx/.xltx`) as text
  (`officeTextOf`), and `drive_import` (read-only for Drive, also `extra_drive_import`) copies a file
  itself, shared drives included, into the chat library (Google Docs/Sheets/Slides as .docx/.xlsx/.pptx),
  so `doc_view`/`doc_edit` work on the real file. A template filled in `doc_edit` and saved as
  `.docx/.pptx/.xlsx` becomes a normal document (`saveDocument` rewrites the main part's content type),
  keeping its cover, styles, headers and margins. Tests: `tests/web/gdrive.cjs`, `tests/web/drive-templates.cjs`.
- **Another Google account for a question:** + menu → Otra cuenta de Google links a second account
  (Google's account chooser; `gmail.readonly` + `drive.readonly`, never the session's token; on Android
  the Custom Tab state is `android.x…` and is never applied as the session). It belongs to the chat
  where it was linked (`extraGoogleByChat`; `extraGoogle` is a window accessor for the open chat's):
  its token is kept on this device only (`localStorage` `inhouse-learn-extra-google`, never Drive), it
  shows as a pill in that chat's composer across messages and reloads (Google's hour still applies:
  then the pill says «caducada»), and removing the pill or deleting the chat revokes it. The model gets read-only `extra_gmail_search`, `extra_gmail_read` (`engine/src/gmail.js`)
  and `extra_drive_*` (shared drives included). Test: `tests/web/extra-account.cjs`.
- **Cost of each answer:** under every answer, always visible: the model's logo, its name and
  `$X.XXXX` in green (`message.cost`, each version keeps its own; tool rounds, repairs and steering
  split correctly). While it is written the price counts up live and animated (`liveCost`: finished
  requests plus the current one estimated from its characters, tool-call arguments included, and the output price;
  other devices get it in the live deltas' `c` and count up too, `showLiveCost`), then settles
  on the real figure. Right above the send button, small: the whole conversation's cost (every
  answer and older version, live; `chatTotalCost`), always of the open chat: `updateChatCost` (called
   first in `renderThread`, so a redraw that fails cannot skip it) writes the open chat's own figure at once, and a chat
   that has spent nothing shows `$0.0000` in grey (`.chat-cost.zero`) instead of the previous chat's total. Costs are saved: leaving or closing mid-answer
  writes the running estimate (`saveRunningCost`) and a reload counts it (`restoreState`); a Drive
  copy saved by an older page without costs never wipes the ones this browser knows
  (`keepKnownCosts`). Tests: `tests/web/extra-account.cjs`, `tests/web/cost-history.cjs`, `tests/web/live-sync.cjs`.
- **Internet:** `web_search` and `web_fetch` (`engine/src/web.js`) are on in every chat. The browser
  cannot call a search engine (CORS): `webSearchRequest` is one non-streaming OpenRouter request with
  the `web` plugin (user's key, chat's model; results come back as `url_citation` annotations, ~$0.007
  a search, counted in the answer's cost), and pages are read through `r.jina.ai`. While a web tool
  runs the live activity shows a turning blue globe; afterwards «Fuentes» under the answer lists the
  pages (`step.sources`, cited ones first, favicons from Google's s2 service). The cost's last two decimals
  (fractions of a cent) are always grey. Test: `tests/web/websearch.cjs`.
- **Saved chats on this device:** `saveState` writes the whole snapshot to IndexedDB (`inhouse-learn-state`,
  `writeStateDb`, one write at a time, newest waiting) and tries localStorage too; a localStorage copy that does
  not fit (~5 MB) is removed, and `::stamp` names the current copy. `loadState` (awaited at the start of `boot`)
  opens localStorage's copy only when its stamp matches, otherwise IndexedDB's: a reload never shows an old copy
  while Drive loads. `saveState` does nothing until the saved chats are read (`appState.stateLoaded`). Test:
  `tests/web/state-reload.cjs`.
- **One URL per conversation:** `?c=<chat id>`; a reload stays on it, back/forward move between
  opened chats, no `?c=` opens the most recently used one. Drive's `activeChatId` never decides what
  opens (it may be another device's or old); an unknown id opens a new chat and waits for Drive
  (`urlChatPending`). Test: `tests/web/chat-url.cjs`.
- **Fresh page:** the Android app keeps the page alive for days, so the page fetches its own
  `index.html` fresh every 5 min and on resume, compares the `?v=` of its scripts and sheets, and
  reloads (same chat, never while something is typed, running or awaiting approval). Bump the `?v=`
  of what you change. An expired Google session shows a banner above the composer with «Volver a
  entrar» (the app never blocks without Drive). Test: `tests/web/chat-url.cjs`.
- **Answers cut by leaving the app:** Android pauses the page and the stream dies with a network
  error. If the page was hidden during the turn and everything that ran was read-only
  (`READ_ONLY_TOOL`), no error is shown: the message says it will be repeated and
  `retryCutAnswers` regenerates it when the app is back in front, keeping the cut attempt's cost. A
  turn that changed something keeps its error. Test: `tests/web/cut-retry.cjs`.
- **Answers with the app in the background (APK 1.0.6):** `syncAndroidWorking` (called from
  `updateSendUi`) sends the shell `{type:'working', on, title, chat}` while an answer runs or the queue
  has messages, and `{type:'answered', title, text, chat}` when it ends with the page hidden. The shell's
  `AnswerService` (foreground `dataSync` service, ongoing notification) keeps the process alive and
  shows «Respuesta lista»; its tap calls `window.inhouseLearnOpenChat(id)`. Older APKs ignore both.
  Test: `tests/web/android-working.cjs`.
- **Chats menu «Índice»:** `chats-menu.css` + `renderHistory` (dark mode in `theme.css`). Groups
  Fijadas / Hoy / Ayer / Esta semana / month; serif titles (Newsreader) sized and faded by recency
  (`chatRecency`), a soft dotted leader to a short small-caps date (`shortWhen`); the open chat is a
  pill. A **pin** in the left gutter means pinned; news show as a **bold title with an orange
  diamond and orange date** (like unread mail): an answer that ended while the user was in another chat or away
  (`trackTurnForUnread`), or another device wrote there (live payload / Drive merge). News are this
  device's only (`localStorage` `inhouse-learn-unread-chats`) and clear when the chat is seen. Long
  press / right click / «⋯» opens Fijar · Renombrar · (Marcar como leído) · Eliminar; the magnifier
  filters by title; «Nuevo chat» (`#new-chat-btn`) sits bottom right. `touchChat` never changes the
  open chat. Test: `tests/web/chats-menu.cjs`.
- **The composer is per chat:** attachments waiting to be sent (`appState.composerAttachments` is an
  accessor for the open chat's `composerDrafts`) and the linked Google account belong to their chat;
  another chat never shows them, and they survive reloads (attachments in IndexedDB
  `inhouse-learn-drafts`, written only after the saved ones are read) until the user removes them or
  the message is sent. Test: `tests/web/chat-composer.cjs`.
- **Chat names:** after the first answer the chat's model names it (exactly three words, only the
  first letter in capitals, `normalizeChatTitle`); every three user messages it checks whether the
  topic changed a lot and only then renames (`autoTitle`, `autoTitleAt`). A user-written name or a
  course title is never touched. Renaming by hand saves it as `customTitle` and plays the same typing animation
   (`startTitleAnimation`): the open chat's name in the top bar is tapped (or Enter) and written over itself with NO box,
   border or underline: the `<b>` becomes `contenteditable="plaintext-only"` while editing (`startRenameChat`, `renaming`),
    so nothing can be selected (no `selectstart`, `dblclick`, Shift+arrows or Ctrl/Cmd+A) and only a caret blinks: the native caret is off and `.title-caret-live` draws the animation's own caret (1.5px, `currentColor`, `title-caret` 0.9s) at the caret position (`drawTitleCaret`, on `selectionchange`). It starts at the END of the name (`caretToTitleEnd`) and a tap puts it where touched (`placeTitleCaret`), so the arrow keys move it letter by letter; there is never a hover underline and the text never shifts, and it still works after the list
   itself closed. It also starts from «Renombrar chat» in the + menu and «Renombrar» in the row's menu (a chat that is not
    open is opened first). Escape discards the edit and an empty name is
   ignored. Before that, the provisional name from the first message follows the same
  rules (at most three words, filler like «me», «el», «explícame» left out; `TITLE_FILLER`). The change is typed out (`startTitleAnimation`), also on other
  devices through live sync. Test: `tests/web/chat-title.cjs`.
- **Ultra code:** an option of the reasoning dropdown in the model picker, for every model
  (`chat.ultraCode`; any other level, or «Normal» for models without levels, turns it off; it is in
  colours only once chosen). It uses the model's deepest level (`effectiveThinkingLevel`) and gives the model
  `spawn_agents` (`engine/src/agents.js`, v2): a plan of up to 12 agents (`id`, `name`, `task`, `role`
  explore|build, `depends_on`, `files` it owns, `returns`, `max_minutes`) run as a DAG (`planAgents`: cycles
  and unknown ids rejected before spending; waves; ≤ 6 at once, staggered so the first warms the prompt
  cache), a shared `context`, a `goal` and `acceptance` criteria, `budget_usd` (default 1) and caps of 40 steps
  and N minutes per agent (a capped or user-stopped agent returns its partial work), transient errors retried
  only before an agent has written, dependency results passed down, and — with 2+ agents — a read-only
  «Verificación» agent that checks the reports (at most one fix round; its verdict leads the result). Agents
  close with `submit_result` (summary, status, artifacts, open issues); the main model gets compact
  sections, the touched files and possible conflicts. The app side (`runSubAgent` in index.html): one stable
  `subAgentSystemPrompt` for all agents (with «Cómo trabajar»), read-only roles keep only `READ_ONLY_TOOL`
  tools (run_js cannot write), owned files enforced, a per-agent overwrite-guard scope, approvals that name
  the agent (`approvalMeta` → `approveChange` → the dock queue, '+N en espera') and set its lane «waiting»,
  per-lane stop (`window.ultraStopAgent`), and `settleAgentSteps` so a stop, error, cut or reload never leaves
  a lane running. GitHub commits from several agents: a per-branch lock, rebase on a moved branch, and a
  stop if another agent changed the same files (also between the approval and the commit). The board is
  `ultra.js` (`UltraAgents`) + `ultra.css`: patched in place by keyed lanes (stream.js no longer redraws it),
  header with title, clock, cost, budget bar and status segments, a constellation, waves, a pinned verifier
  lane, expandable lanes (task, steps, result through `renderMarkdown`, «Copiar»), a completion glow once,
  tokens with AMOLED versions in theme.css, everything off under reduced motion. The live row says
  «Coordinando N agentes» / «Integrando lo de N agentes». Turning Ultra code on plays the burst
  (`UltraAgents.burst`). Tests: `tests/web/ultra.cjs`, `ultra-board.cjs`, `agents-plan.mjs`,
  `github-concurrent.cjs`.
- **How the model is prompted and run** (index.html, engine/src/index.js): `stableSystemPrompt` is
  byte-identical across the turns of a chat (and a day) so providers with prompt caching reuse it;
  `turnContextText` (time, files, library, `InhouseStudy.brief`, visual events/variety, the course task or
  visuals reminder) is appended as a `<contexto_app>` block to the user's message and never saved.
  `WORK_METHOD_PROMPT` («Cómo trabajar»: read before assuming, decide defaults, plan 3+ steps, verify with
  run_js/doc_view/CI/sources, never repeat a failing call, separate verified from assumed) is in normal chats
  and sub-agents, not in Guided Learning. `runAgent` retries transient provider errors (429/5xx, ≤ 2, backoff,
  `agent.continue()` never re-runs tools; the live row says «Reintentando (n/m)…»), raises the reasoning one
  level after 2 consecutive tool errors (`escalate`), ages old tool results (`engine/src/context.js`,
  pure and deterministic, via `transformContext`, one smaller retry on a context overflow), adds coach notes
  to tool results (`engine/src/coach.js`: repeated failing call, review with doc_view, test code; never in
  `step.output` or saved history), runs read-only tools of one batch in parallel (`markExecution`,
  `toolExecution: 'parallel'`), offers `think` to models that reason little, and keeps `cacheRead` (the usage
  panel shows the share). run_js has math.js and Algebrite (`sandboxPrelude`, Cache API
  `inhouse-sandbox-libs-v1`, evaluated before the sandbox's network is removed) plus `nsolve`, `integrate`,
  `table`; without them it still works. Tests: `prompt-cache.cjs`, `context-aging.mjs`, `coach.mjs`,
  `harness.cjs`, `sandbox-net.cjs`. `tests/web/wiring.mjs` fails if a merge drops this wiring or the engine stops
  exporting what the page feature-checks. Trade-off: earlier user messages are resent without the context block
  they had, so the cached prefix covers the system prompt and tools, not the history. GitHub's repository and
  staged changes are per-turn (`githubTurnText`). Both sandboxes block the network on every prototype of the
  worker's global scope; run_js waits ≤ 4 s for the maths libraries and honours Stop meanwhile.
- **The model's working tools** (`engine/src/tools.js`, `interact.js`): `read_file` returns numbered lines
  (`  12→text`) by ranges (`offset`/`limit`, ≤ 2000 lines or 20 000 characters, and says the next offset);
  `search_files` greps the chat files (plain text or regex, glob `path`, context lines); `write_file` refuses
  to replace a file the model has not seen as it is now (content hash per chat, `seenByWorkspace`) unless
  `overwrite: true`; `edit_file` has `replace_all`; `run_js` reports refused paths without losing its console.
  The library tools are always there (also empty: `doc_edit`/`latex_compile` fill it mid-turn), plus
  `delete_library` (through `approveChange`). `docx` loads in `doc_edit` for any use of the global, also
  destructured. `update_plan` draws the model's checklist in the thread (`renderStepPlanCard`, latest version) and
  `ask_user` asks one question with 2–4 answers to tap above the composer (`dockAsk`, own words allowed,
  «Omitir» → no answer); both only for the main agent, not in Guided Learning. The system prompt says the
  date and time (`currentMomentText`). `web_fetch` asks Jina to drop menus, language lists and pictures
  (`WEB_FETCH_NOISE`), and the prompt forbids putting the user's data in URLs. `spawn_agents` takes a
  shared `context`. Test: `tests/web/harness.cjs`.
- **Estudio** (`study.js` = `InhouseStudy`, `study-view.js` + `study.css`, tools in `engine/src/study.js`): a
  second interface for studying and planning, opened by the «Estudio» button right above the Google account
  in the chats menu; it covers the chat as a full screen and «Chats» goes back (the chats UI is unchanged).
  Tabs: Hoy (today's sessions in every subject, «Hecho», «Empezar» → `startStudyChat`: a new chat of that
  subject with the task sent), Asignaturas (exam date, hours a week, weighted topics with their state
  sin tocar / frágil / en camino / sólido, the next 10 days, Simulacro), Sobre ti («Lo que sé de ti»: the
  memory, forgettable) and Errores (most expensive first: count × recency × topic weight). The app owns the
  state: the model only reports (`study_result`: correct or not, cause if wrong) and the app computes mastery
  (exponential average, fading with `exp(-days/21)`); the plan is recomputed from the state every time
  (interleaved study sessions by gap priority, reviews 1/3/7/14/30 days later, ~20 min a day kept for reviews,
  free days get a short review, a mock exam the day before), except today's list, frozen once a day
  (`state.frozen`) so «Hecho» never reshuffles it. Model tools (main agent, not Guided Learning):
  `memory_save`/`memory_forget` (ask in «Preguntar»), `study_space` (create/update a subject, links the chat),
  `study_overview`, `study_result`, `recall` (BM25 over every message of every other chat, cited with
  `?c=ID`). Every prompt carries `InhouseStudy.brief(chatId)` (memory, and in a subject's chat: days left,
  topic states, today's items, rules, costliest mistakes). Stored in `localStorage` `inhouse-learn-study` and
  `study.json` in the Drive folder (same adapter as the library), merged item by item (newer wins, `deleted`
  tombstones); pulled before each turn and when Estudio opens. Dark mode colours in `theme.css`.
  Test: `tests/web/study.cjs`.
- **Logos in the dark theme:** single-colour company logos (`MONO_LOGOS`, drawn with `currentColor`,
  black inside an `<img>`) are inverted to white by `theme.css`. Add new ones there.
- **Code blocks:** every `pre > code` in an answer gets a «Copiar» button in its top right corner
  (`enhanceRichContent`, `copyTextToClipboard`) that copies the whole block. Test: `tests/web/reasoning.cjs`.
- **What the chat shows:** reasoning a model writes inside its answer (`<think>…</think>`, or only a
  closing tag) goes to the thinking section (`splitReasoning` in `engine/src/index.js`); a model stuck
  repeating the same lines is cut (`runawayCut` in `index.html`), keeping what came before, and the queue
  goes on. «Muéstramelo» is only a Guided Learning quick reply. Test: `tests/web/reasoning.cjs`.
- **Live sync:** every tab with a chat open sees the other tabs' turns as they are written (the
  question at once, the answer character by character). Tabs of the same account open WebRTC
  data channels to each other, signalled through `peer-<deviceId>.json` in the Drive folder (a
  heartbeat, the id of the tab's live file, offers/answers); the answering tab sends the turn
  whole when anything but the text changes and otherwise only the new characters (`{t:'d'}`),
  and a `saved` notice after each Drive save. Tabs without a direct channel read the answering
  tab's `live-<deviceId>.json` **by file id** (never wait on Drive's lagging search index): fast
  while a turn runs or someone is typing (`typing` notice), slowly otherwise; writes stay under
  Drive's ~3 writes/s per account, and nothing is written when no other tab is online.
  `stream.js` spreads each burst from another device until the next one is due (`remote`
  views), and a chat another device is answering is never replaced by a snapshot mid-turn
  (`chatHasLiveTurn`). Legacy `live.json` is still read. Use a distinct ID per tab (a reload
  removes the previous tab's files). Durable history polling runs independently of live-file
  errors. Discover all pages of matching folders/snapshots, merge legacy duplicates without
  deleting them, and choose the smallest file ID as the canonical write target. Serialize
  history reads/writes, retry failed saves, and use conditional writes when Drive exposes an
  ETag. `tests/web/sync-recovery.cjs` covers reload, duplicate histories and transient
  failures; `tests/web/live-stream.cjs` measures latency, stalls, reliability and request
  cost over WebRTC and over Drive with real-world latency.
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
