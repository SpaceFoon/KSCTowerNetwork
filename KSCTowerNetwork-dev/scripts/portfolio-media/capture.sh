#!/usr/bin/env bash
# Render the portfolio Flightwall screenshot from this checkout.
#
#   KSCTowerNetwork-dev/scripts/portfolio-media/capture.sh [out-dir]
#   (default out-dir: KSCTowerNetwork-dev/portfolio-media/, which Git ignores)
#
# Needs Docker, Node 24 and `npm ci` already run in KSCTowerNetwork-dev/web and in
# this folder. It starts the Vite dev server on a loopback port and screenshots
# /flightwall-preview.html?capture=portfolio with the pinned Playwright image, so
# every machine renders the same fonts. The page shows only the preview's built-in
# sample traffic (fictional Kerbal pilots and craft) under a fixed browser clock.
# No backend, KSP, LiveKit or real server is involved: API calls get a 404.
#
# Writes: tower-flightwall.jpg (1280x720)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
dev="$(cd "$here/../.." && pwd)"
out_arg="${1:-$dev/portfolio-media}"
out="$(mkdir -p "$out_arg" && cd "$out_arg" && pwd)"
# Keep in step with "playwright-core" in this folder's package.json.
playwright_image="mcr.microsoft.com/playwright:v1.65.1-noble"

work="$(mktemp -d)"
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

port="$(node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"

echo "== web (Vite dev server on 127.0.0.1:$port)"
(cd "$dev/web" && exec npx vite --host 127.0.0.1 --port "$port" --strictPort >"$work/web.log" 2>&1) &
pids+=($!)
for _ in $(seq 1 90); do
  curl -fsS "http://127.0.0.1:$port/flightwall-preview.html" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:$port/flightwall-preview.html" >/dev/null || { tail -50 "$work/web.log" >&2; exit 1; }

echo "== screenshot"
docker run --rm --network host --ipc host --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$here:/capture:ro" -v "$out:/out" -w /capture "$playwright_image" \
  node shoot.mjs "http://127.0.0.1:$port" /out

ls -l "$out/tower-flightwall.jpg"
