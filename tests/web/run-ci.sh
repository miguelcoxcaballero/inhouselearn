#!/usr/bin/env bash
# Runs the browser tests of tests/web against this checkout (GitHub Actions or
# locally): serves the repo on 127.0.0.1:8765, runs each test, and fails if a
# test prints FAIL or crashes. FAIL lines become GitHub annotations.
set -u
cd "$(dirname "$0")/../.."
python3 -m http.server 8765 --bind 127.0.0.1 >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
for _ in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:8765/index.html && break; sleep 0.2; done
export OUT="${RUNNER_TEMP:-/tmp}"
status=0
node --test tests/web/text-quality.mjs tests/web/learning.mjs || { echo "::error::unit tests failed"; status=1; }
for test in latex practice text-quality motion guided-learning guided-screens guided-wait theme photos visuals visual-controls library github release gdrive extra-account websearch reasoning queue live-sync sync-recovery live-stream; do
  echo "::group::$test"
  log="$OUT/web-$test.log"
  limit=300; [ "$test" = live-stream ] && limit=600
  timeout "$limit" node "tests/web/$test.cjs" > "$log" 2>&1
  code=$?
  cat "$log"
  echo "::endgroup::"
  if grep -q '^FAIL' "$log"; then
    grep '^FAIL' "$log" | cut -c1-600 | while IFS= read -r line; do echo "::error title=$test::$line"; done
    status=1
  elif [ "$code" -ne 0 ]; then
    echo "::error title=$test::$test.cjs exited with code $code: $(grep -m1 -iE 'error' "$log" | cut -c1-400)"
    status=1
  else
    echo "$test: $(grep -c '^PASS' "$log") PASS"
  fi
done
exit $status
