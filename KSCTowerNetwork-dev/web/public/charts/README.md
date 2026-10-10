# Optional Kerbin chart installation

KSCTowerNetwork does not bundle third-party chart PDFs, rendered pages, or extracted transcripts. The web app works without them.

1. Open the [upstream ASET repository PDF](https://github.com/StoneBlue/ASET-Consolidated-Avionics/blob/main/Docs%20%26%20Manuals/ASET%20Consolidated%20Avionics-%20Kerbin%20AEROCHARTS%20v17-11-25.pdf) and use **Download raw file**. Download the November 25, 2017 edition to any local folder. You do not need to clone the upstream repository.
2. Build the KSCTowerNetwork web app as usual. From `KSCTowerNetwork-dev/web`, run:

Python 3.10+ is required. The wrappers create an isolated `.chart-tools` environment and install dependencies; the first run needs internet access.

PowerShell (Windows):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-charts.ps1 -PdfPath "C:/Downloads/ASET Consolidated Avionics- Kerbin AEROCHARTS v17-11-25.pdf"
```

Bash (Linux, macOS, or Git Bash):

```bash
bash scripts/install-charts.sh --pdf "/path/to/ASET Consolidated Avionics- Kerbin AEROCHARTS v17-11-25.pdf"
```

PowerShell accepts `-OutputPath "C:/chart-install/charts"` and `-PythonCommand "C:/Python/python.exe"`. Bash accepts `--output /website/charts` and uses `PYTHON` to select an executable, for example `PYTHON=python bash scripts/install-charts.sh --pdf /path/to/charts.pdf`. Install your platform's Python venv support if environment creation fails.

For manual setup: `python -m pip install -r scripts/chart-requirements.txt`, then `python scripts/install_charts.py --pdf /path/to/charts.pdf`.

The installer creates `dist/charts/`: the original PDF, 22 rendered pages and thumbnails, a searchable manifest, reference data, and attribution. Deploy that folder beside your built web app's `index.html`, so it is served at `/charts/manifest.json`. Reload the Charts page. Players do not install anything into GameData.

To prepare a folder for another server, add `--output "C:/chart-install/charts"` and copy that entire folder into the website's root. To test locally, build first, install into `dist/charts`, and run `npm run preview`. A fresh install accepts an empty destination or the shipped empty manifest/README; it refuses to overwrite an existing chart bundle. To update, generate into a new folder and replace the old server folder yourself.

**Rebuilds:** Vite replaces `dist` on every build. Install charts after each build, or restore the previously generated folder afterward. Use a clean checkout without locally installed charts when producing public release artifacts. Do not commit locally generated manifests or chart assets.

## Attribution and use

Original charts: **alexustas / ASET Aviation Agency**, November 25, 2017. [Source repository](https://github.com/StoneBlue/ASET-Consolidated-Avionics). Charts and generated adaptations retain [CC BY-NC-SA 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/), separate from MIT project code. Generated adaptations are rasterized pages, thumbnails and extracted text/data; keep the generated attribution file and source/license links with the installation. The installer is a convenience, not additional permission: the server owner must follow the source license for their intended use.

The source PDF preserves diagrams and symbols that extracted text cannot fully represent. Source navigation rows are reference material; installed-game navaids remain authoritative. No chart terrain SVG is installed or required.
