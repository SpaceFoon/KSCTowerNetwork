import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
export function validateReleaseTree(root, kind) {
  const required = kind === 'client' ? ['GameData/KSCTowerNetwork/Plugins/KSCTowerNetwork.Client.dll', 'GameData/KSCTowerNetwork/PluginData/settings.cfg', 'GameData/KSCTowerNetwork/PluginData/bridge-runtime/node/node.exe', 'GameData/KSCTowerNetwork/PluginData/bridge-runtime/node/LICENSE', 'GameData/KSCTowerNetwork/PluginData/bridge-runtime/app/dist/bridge.js'] : ['KSCTowerNetwork-dev/backend/dist/index.js', 'KSCTowerNetwork-dev/backend/package-lock.json', 'KSCTowerNetwork-dev/web/dist/index.html', 'KSCTowerNetwork-dev/deploy/server.env.example', 'KSCTowerNetwork-dev/deploy/server.mjs'];
  for (const path of [...required, 'LICENSE', 'NOTICE.md', 'DEPENDENCY_NOTICES.txt', 'INSTALL.txt', 'RELEASE_MANIFEST.json']) if (!existsSync(join(root, path))) throw new Error(`Missing ${kind} release file: ${path}`);
  function walk(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const file = join(folder, entry.name);
      const path = relative(root, file).replaceAll('\\', '/');
      if (entry.isDirectory()) {
        if (['.git', '.chart-tools', 'fonts'].includes(entry.name)) throw new Error(`Private/optional folder in release: ${path}`);
        if (kind === 'server' && entry.name === 'node_modules') throw new Error('Server dependencies must be installed for the host OS.');
        walk(file);
      } else {
        if (/^(auth\.cfg|release-config\.json|settings\.local\.cfg|invite-codes.*\.json|registered-users.*\.json|\.env(?:\..*)?)$/i.test(entry.name)) throw new Error(`Private configuration in release: ${path}`);
        if (/\.(?:pdf|ttf|otf)$/i.test(entry.name) || /kerbin-jebbesen-terrain|Kerbin_AEROCHARTS/i.test(entry.name)) throw new Error(`Optional asset in release: ${path}`);
        if (kind === 'client' && /\.cs$/i.test(entry.name)) throw new Error(`Source in client: ${path}`);
      }
    }
  }
  walk(root);
  if (kind === 'server') {
    const manifest = JSON.parse(readFileSync(join(root, 'KSCTowerNetwork-dev/web/dist/charts/manifest.json'), 'utf8'));
    if (manifest.pageCount !== 0 || manifest.pages.length !== 0) throw new Error('Optional charts leaked into release.');
  }
}
