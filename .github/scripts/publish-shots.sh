#!/usr/bin/env bash
# Publishes $OUT/$ID (the PNGs and manifest.json) on the `screenshots` branch
# of the repository running the workflow, keeping the newest 30 folders.
# Needs GH_TOKEN with contents: write. Another run may publish at the same
# time: each attempt starts again from the branch's new head.
set -euo pipefail
OUT="${OUT:-$GITHUB_WORKSPACE/out}"
[ -f "$OUT/$ID/manifest.json" ] || { echo "::error::No manifest for $ID"; exit 1; }
git config --global user.name "github-actions[bot]"
git config --global user.email "41898282+github-actions[bot]@users.noreply.github.com"
work="$(mktemp -d)"
for attempt in 1 2 3 4 5 6; do
  rm -rf "$work/pub" && mkdir "$work/pub" && cd "$work/pub"
  git init -q
  git remote add origin "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
  if git fetch -q --depth 1 origin screenshots; then git checkout -q -B screenshots FETCH_HEAD; else git checkout -q --orphan screenshots; fi
  # Ids start with a timestamp, so they sort by date.
  ls -1d */ 2>/dev/null | sed 's#/$##' | sort | head -n -29 | while read -r old; do git rm -rq "$old"; done
  rm -rf "$ID" && cp -r "$OUT/$ID" .
  git add -A
  git commit -qm "Screenshots $ID"
  if git push -q origin screenshots; then
    echo "Published: https://github.com/${GITHUB_REPOSITORY}/tree/screenshots/$ID"
    exit 0
  fi
  cd / && sleep $((attempt * 2))
done
echo "::error::Could not publish on the screenshots branch"
exit 1
