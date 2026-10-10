#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
web_root="$(dirname -- "$script_dir")"
if [[ $# -eq 0 || "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  printf '%s\n' 'Usage: bash scripts/install-charts.sh --pdf "/path/to/charts.pdf" [--output "/website/charts"]' 'Requires Python 3.10+. Set PYTHON to select another Python executable.'
  exit 0
fi
python_command="${PYTHON:-python3}"
if ! command -v "$python_command" >/dev/null 2>&1; then
  if [[ -z "${PYTHON:-}" ]] && command -v python >/dev/null 2>&1; then
    python_command=python
  else
    printf '%s\n' 'Python not found. Install Python 3.10+ (including venv), or set PYTHON.' >&2
    exit 1
  fi
fi
environment_path="$web_root/.chart-tools"
environment_python="$environment_path/bin/python"
if [[ -f "$environment_path/Scripts/python.exe" ]]; then
  environment_python="$environment_path/Scripts/python.exe"
fi
if [[ ! -f "$environment_python" ]]; then
  "$python_command" -m venv "$environment_path"
  if [[ -f "$environment_path/Scripts/python.exe" ]]; then
    environment_python="$environment_path/Scripts/python.exe"
  fi
fi
"$environment_python" -m pip install --disable-pip-version-check -r "$script_dir/chart-requirements.txt"
"$environment_python" "$script_dir/install_charts.py" "$@"
