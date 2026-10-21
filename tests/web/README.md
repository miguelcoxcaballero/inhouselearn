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
