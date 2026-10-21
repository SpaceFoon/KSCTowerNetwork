#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Install Node 24.22.1 LTS and npm before running the server scripts.' >&2
  exit 1
fi
exec node "$script_dir/server.mjs" "$@"
