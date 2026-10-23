# Browser tests for the chat visuals

`visuals.cjs` checks the animated and interactive visuals (scene, sandbox) with a
mocked OpenRouter that streams slowly: the tube example (particles faster in
the narrowing, lower pressure, instant sliders, pause), the pendulum, the
sandbox (isolated, no network, no access to the page), fallbacks, the per
message limits, four animations at once, accessibility and the events sent back
to the tutor.

```bash
npm install --no-save playwright        # or set NODE_PATH to an existing install
python3 -m http.server 8765 --bind 127.0.0.1 &   # from the repository root
node tests/web/visuals.cjs               # CHROMIUM=/path/to/chromium if needed
```

Every line starts with PASS or FAIL. Screenshots go to `$OUT` (the temp folder by default).

Text quality and exercise layout regressions:

```bash
node --test tests/web/text-quality.mjs
CHROMIUM=/usr/bin/chromium node tests/web/text-quality.cjs
CHROMIUM=/usr/bin/chromium node tests/web/practice.cjs
CHROMIUM=/usr/bin/chromium node tests/web/motion.cjs
CHROMIUM=/usr/bin/chromium node tests/web/theme.cjs
CHROMIUM=/usr/bin/chromium node tests/web/photos.cjs
CHROMIUM=/usr/bin/chromium node tests/web/latex.cjs
CHROMIUM=/usr/bin/chromium node tests/web/live-sync.cjs
CHROMIUM=/usr/bin/chromium node tests/web/sync-recovery.cjs
CHROMIUM=/usr/bin/chromium node tests/web/live-stream.cjs
CHROMIUM=/usr/bin/chromium node tests/web/library.cjs
CHROMIUM=/usr/bin/chromium node tests/web/github.cjs
CHROMIUM=/usr/bin/chromium node tests/web/queue.cjs
```

`theme.cjs` opens the app with the system in dark and in light: the theme is
chosen before the first paint, dark is AMOLED (`rgb(0, 0, 0)`), the control in
the + menu pins Claro/Oscuro, the choice survives a reload and «Auto» follows
the system live.

`photos.cjs` checks the pictures inside the chat: an `image` and a `preview`
appear while the answer is still streaming, the preview is an iframe with
`sandbox=""` that cannot reach the page, a `javascript:` source is rejected with
a neutral note and an `svg` drawn by the model is rendered without its scripts.

`latex.cjs` checks that widget LaTeX survives JSON damage (`\\frac` read as a form
feed, `\\$…\\$`, doubled backslashes) and that bare `x^2` options are drawn by KaTeX.

`live-sync.cjs` opens two devices on a fake Google Drive: they connect directly (WebRTC
signalled through Drive), the second one stays within a few characters of the first one's answer, ends with the same chat and gets new chats
within seconds (conversations.json polling). Set `LIVE_SYNC_FALLBACK=1` to explicitly
exercise the Drive fallback with WebRTC disabled; the default suite still requires WebRTC.

`live-stream.cjs` measures the live chat between two devices with the same chat open, over
WebRTC and over the Drive fallback, on a fake Drive with 120–350 ms per request and a search
index 2 s behind: how far behind the other device draws the question and the answer, the
longest stall of the text, bytes over the channel and Drive requests (answering and idle), plus
the reverse direction, steering, stop, switching chats and reloading mid-answer and a dropped
connection. It prints `METRIC` lines; `LIVE_MODES=rtc` or `drive` runs one mode.

`sync-recovery.cjs` exercises the normal login/reload path against a fake Drive with
duplicate folders/files, reversed and paginated listings, a transient upload failure,
a conditional-write conflict, malformed live data, and a failed live download. It also
checks simultaneous messages between tabs, deletion-only snapshots, token renewal during
login, and that sync preserves a running agent's chat object.

`library.cjs` uploads a folder (a 3-page PDF, long notes, a photo read by a stubbed OCR and
40 small files) and checks the search, the manifest the model gets and the three library tools.

`reasoning.cjs` checks that reasoning written inside an answer (`<think>`, or a lone `</think>`)
goes to the thinking section, that a model repeating itself is cut (and the queue goes on), that
«Muéstramelo en visual» is gone from normal chats and that confirmations show no dark notice.
`release.cjs` also covers `github_screenshot` (no card in «Auto», a card in «Preguntar», real URLs).

`queue.cjs` checks the message queue (Enter while busy, one per finished turn, Stop pauses)
and steering (Ctrl+Enter enters the running turn after the current tool, same request chain).

All of them run in GitHub Actions (`.github/workflows/web-tests.yml` → `run-ci.sh`).

`github.cjs` runs the GitHub connector against a fake GitHub API: edits are only prepared (reads
and grep see them), one approval card above the composer uploads them in one commit and opens
the PR, two pushes in a row chain, search falls back to grep, CI status is read, and a rejected
upload keeps the changes prepared for «Subir» / «Descartar».

`text-quality.cjs` uses mocked OpenRouter responses to reproduce accidental
Cyrillic/Chinese insertions, check automatic repair and stored transcripts,
repair an old message, preserve it on failure/cancellation, and complete a quiz
and final exam. It also checks mobile/desktop layout. No real API key is used.

The app requests one copy-editing pass from the selected model only when it
detects suspect prose, including course tool arguments before they are applied.
This request is included in usage totals. Existing affected messages expose
“Corregir texto”; correcting one keeps the course state and answers intact.
Code/math spans and languages requested by the student are preserved.

`motion.cjs` checks continuous quiz collapse/reordering, keyboard focus, rapid
successive answers, animation cleanup, live reduced-motion preferences, mobile
scene cadence and batching slider redraws to one per animation frame. Shared
transitions live in `motion.js`; the course/practice state changes immediately.
