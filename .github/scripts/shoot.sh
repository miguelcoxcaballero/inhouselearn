#!/usr/bin/env bash
# Takes the pictures for the "App screenshots" workflow, from the tool's
# checkout (inhouselearn main): serves the project (or uses URL), loads only
# Playwright's driver (playwright-core, a few seconds) and uses the Chrome the
# GitHub runner already has; Playwright's own Chromium is downloaded only if
# that Chrome does not start. Always leaves $OUT/$ID/manifest.json.
set -uo pipefail
cd "$(dirname "$0")/../.."
export OUT="${OUT:-$GITHUB_WORKSPACE/out}"

npm install --no-save --no-package-lock --no-audit --no-fund --loglevel=error playwright-core@1.56.1 >/dev/null 2>&1 \
  || npm install --no-save --no-package-lock --no-audit --no-fund --loglevel=error playwright-core@1.56.1

if [ -z "${CHROMIUM:-}" ]; then
  for candidate in google-chrome google-chrome-stable chromium chromium-browser; do
    found="$(command -v "$candidate" || true)"
    if [ -n "$found" ]; then export CHROMIUM="$found"; break; fi
  done
fi
echo "Browser: ${CHROMIUM:-Playwright Chromium}"

if [ -z "${URL:-}" ]; then
  if [ -n "${START:-}" ]; then
    (cd ../app && nohup bash -c "$START" > ../server.log 2>&1 &)
    for _ in $(seq 1 240); do curl -s -o /dev/null http://127.0.0.1:8765/ && break; sleep 0.5; done
    curl -s -o /dev/null http://127.0.0.1:8765/ || { echo "::error::Nothing answers on port 8765 after 2 minutes"; tail -n 40 ../server.log; exit 1; }
  else
    [ -d "../app/${SERVE:-}" ] || { echo "::error::The folder '${SERVE:-}' does not exist (did setup build it?)"; exit 1; }
    (cd "../app/${SERVE:-}" && python3 -m http.server 8765 --bind 127.0.0.1 >/dev/null 2>&1 &)
    for _ in $(seq 1 50); do curl -s -o /dev/null http://127.0.0.1:8765/ && break; sleep 0.1; done
  fi
fi

timeout 300 node .github/scripts/screenshots.cjs
code=$?
if [ "$code" -eq 3 ]; then
  echo "The runner's Chrome did not start: downloading Playwright's Chromium"
  npx playwright-core install --with-deps chromium
  CHROMIUM= timeout 300 node .github/scripts/screenshots.cjs
  code=$?
fi
[ -f "$OUT/$ID/manifest.json" ] || { echo "::error::The pictures script ended (code $code) without a manifest"; exit 1; }
exit 0
