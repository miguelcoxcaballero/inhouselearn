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
CHROMIUM=/usr/bin/chromium node tests/web/latex.cjs
```

`latex.cjs` checks that widget LaTeX survives JSON damage (`\\frac` read as a form
feed, `\\$…\\$`, doubled backslashes) and that bare `x^2` options are drawn by KaTeX.

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
