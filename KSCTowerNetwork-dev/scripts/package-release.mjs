import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
function run(command, args, cwd = root, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
function capture(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed`);
  return result.stdout.trim();
}
function copy(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}
function files(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(folder, entry.name)) : [join(folder, entry.name)]);
}
function hash(file, algorithm = 'sha256') { return createHash(algorithm).update(readFileSync(file)).digest('hex'); }
function zip(folder, output) {
  const ps = "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:KSC_ZIP_SOURCE, $env:KSC_ZIP_TARGET)";
  run('powershell.exe', ['-NoProfile', '-Command', ps], root, { ...process.env, KSC_ZIP_SOURCE: folder, KSC_ZIP_TARGET: output });
}
function dependencyNotices(modules) {
  const result = [];
  function visit(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const location = join(folder, entry.name);
      if (entry.name.startsWith('@')) { visit(location); continue; }
      if (existsSync(join(location, 'package.json'))) {
        const pkg = JSON.parse(readFileSync(join(location, 'package.json'), 'utf8'));
        result.push(`\n=== ${pkg.name}@${pkg.version} (${JSON.stringify(pkg.license ?? 'See upstream license')}) ===\n`);
        for (const name of readdirSync(location)) {
          if (/^(licen[sc]e|copying|notice)([.\-_]|$)/i.test(name) && statSync(join(location, name)).isFile()) result.push(readFileSync(join(location, name), 'utf8'));
        }
      }
      if (existsSync(join(location, 'node_modules'))) visit(join(location, 'node_modules'));
    }
  }
  visit(modules);
  return result.join('\n');
}

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Node 24.22.1+ (24.x), Windows x64: node scripts/package-release.mjs --ksp-managed <KSP_x64_Data/Managed> [--version 1.0.0] [--output <new-directory>]');
  process.exit(0);
}
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--ksp-managed', '--version', '--output'].includes(args[i]) || !args[i + 1]) throw new Error(`Unknown or incomplete option: ${args[i]}`);
  options[args[i]] = args[i + 1];
}
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Client release builds require Windows x64. Server archives install on Linux or Windows.');
const [major, minor, patch] = process.versions.node.split('.').map(Number);
if (major !== 24 || minor < 22 || (minor === 22 && patch < 1)) throw new Error('Use Node 24.22.1 or newer Node 24.');
if (capture('git', ['status', '--porcelain', '--untracked-files=normal'])) throw new Error('Commit release sources first; the release must identify a clean source commit.');
const avc = JSON.parse(readFileSync(join(root, 'GameData/KSCTowerNetwork/Plugins/KSCTowerNetwork.version'), 'utf8'));
const version = options['--version'] ?? `${avc.VERSION.MAJOR}.${avc.VERSION.MINOR}.${avc.VERSION.PATCH}`;
if (!/^\d+\.\d+\.\d+$/.test(version) || version !== `${avc.VERSION.MAJOR}.${avc.VERSION.MINOR}.${avc.VERSION.PATCH}`) throw new Error('Version must match the AVC file (X.Y.Z).');
const assembly = readFileSync(join(root, 'KSCTowerNetwork-dev/PluginSrc/Properties/AssemblyInfo.cs'), 'utf8');
if (!assembly.includes(`AssemblyVersion("${version}.0")`) || !assembly.includes(`AssemblyFileVersion("${version}.0")`)) throw new Error('Assembly and release versions differ.');
const managed = resolve(options['--ksp-managed'] ?? join(root, 'KSP_x64_Data/Managed'));
if (!existsSync(join(managed, 'Assembly-CSharp.dll'))) throw new Error('Provide --ksp-managed pointing to the installed game assemblies.');
const sourceCommit = capture('git', ['rev-parse', 'HEAD']);
const parent = options['--output'] ? resolve(options['--output']) : join(root, 'release');
mkdirSync(parent, { recursive: true });
const output = mkdtempSync(join(parent, `${version}-`));
const source = join(output, 'source');
mkdirSync(source);
// Only tracked files enter the build: local charts, fonts, textures, credentials and caches cannot leak.
for (const file of capture('git', ['ls-files', '-z']).split('\0').filter(Boolean)) copy(join(root, file), join(source, file));
const dev = join(source, 'KSCTowerNetwork-dev');
const bridge = join(source, 'KSCTowerNetwork-voice-bridge/voice-bridge');
const npmCli = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
if (!existsSync(npmCli)) throw new Error('Use a Node installation with npm alongside it.');
const cleanEnv = { ...process.env, PATH: `${dirname(process.execPath)};${process.env.PATH}`, NODE_ENV: 'development' };
for (const key of Object.keys(cleanEnv)) if (/^(VITE_|DEV_|LIVEKIT_|APP_JWT_|WEB_LOGIN_|NODE_OPTIONS$)/.test(key)) delete cleanEnv[key];
const npm = (args, cwd) => run(process.execPath, [npmCli, ...args], cwd, cleanEnv);
const ps = (script, args = []) => run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], source, cleanEnv);
for (const folder of [join(dev, 'backend'), join(dev, 'web'), bridge]) npm(['ci'], folder);
for (const folder of [join(dev, 'backend'), join(dev, 'web'), bridge]) npm(['test'], folder);
run(process.execPath, ['--test', 'deploy/server.test.mjs', 'scripts/release-validation.test.mjs'], dev, cleanEnv);
for (const name of ['verify-voice-invariants.mjs', 'verify-acars-invariants.mjs']) run(process.execPath, [join(dev, 'scripts', name)], dev, cleanEnv);
npm(['run', 'build'], join(dev, 'backend'));
npm(['run', 'build'], join(dev, 'web'));
ps(join(dev, 'build-plugin.ps1'), ['-KspManagedPath', managed]);
for (const name of ['run-listen-ui-tests.ps1', 'run-comm-radio-pure-tests.ps1', 'run-craft-thumbnail-tests.ps1']) ps(join(dev, 'plugin-tests', name));
ps(join(bridge, 'scripts/build-bridge-runtime.ps1'), ['-NodeExePath', process.execPath, '-SessionId', 'tower-public']);
const client = join(output, 'client');
const mod = join(client, 'GameData/KSCTowerNetwork');
copy(join(source, 'GameData/KSCTowerNetwork'), mod);
copy(join(mod, 'PluginData/settings.example.cfg'), join(mod, 'PluginData/settings.cfg'));
let settings = readFileSync(join(mod, 'PluginData/settings.cfg'), 'utf8').replace('sessionId = dev-shared', 'sessionId = tower-public');
writeFileSync(join(mod, 'PluginData/settings.cfg'), settings);
// Neutral clients are configured by the pilot; never bake the maintainer's server or auth into public downloads.
writeFileSync(join(client, 'INSTALL.txt'), `KSCTowerNetwork ${version} - Windows x64 client\n\nClose KSP. Install ModuleManager separately. Extract GameData into your KSP folder.\nEdit GameData/KSCTowerNetwork/PluginData/settings.cfg with your server operator's\ntowerApiHost, towerApiPort, towerApiTls and towerApiPath. Defaults are local-only.\nSet sessionId as supplied by the operator, then launch KSP and sign in.\nThe bridge bundles Node; you do not need to install Node on the pilot PC.\nWhen updating, back up and preserve your existing settings.cfg and auth.cfg.\nControllers use the operator's website and do not install this client.\nSee INTEGRATIONS.md for optional mods. KSP and other mods are not bundled.\n`);
copy(join(dev, 'docs/INTEGRATIONS.md'), join(client, 'INTEGRATIONS.md'));
const runtimeModules = join(mod, 'PluginData/bridge-runtime/app/node_modules');
writeFileSync(join(client, 'DEPENDENCY_NOTICES.txt'), dependencyNotices(runtimeModules));
copy(join(dirname(process.execPath), 'LICENSE'), join(mod, 'PluginData/bridge-runtime/node/LICENSE'));
const server = join(output, 'server');
const serverDev = join(server, 'KSCTowerNetwork-dev');
for (const name of ['package.json', 'package-lock.json', 'dist', 'data/atis.weather.json']) copy(join(dev, 'backend', name), join(serverDev, 'backend', name));
copy(join(dev, 'web/dist'), join(serverDev, 'web/dist'));
// Keep the documented chart installer available without distributing optional chart content.
for (const name of ['install-charts.ps1', 'install-charts.sh', 'install_charts.py', 'index_aerocharts.py', 'chart-requirements.txt']) copy(join(dev, 'web/scripts', name), join(serverDev, 'web/scripts', name));
copy(join(dev, 'deploy'), join(serverDev, 'deploy'));
copy(join(dev, 'docs'), join(serverDev, 'docs'));
writeFileSync(join(server, 'INSTALL.txt'), `KSCTowerNetwork ${version} - server (Linux/Windows)\n\nRequires Node 24.22.1+ (24.x) with npm, MariaDB, Redis, HTTPS proxy and LiveKit.\nFrom KSCTowerNetwork-dev run:\n  Linux:   bash deploy/server.sh install\n  Windows: powershell -File deploy/server.ps1 install\nConfigure backend/.env.production: secrets, owner password hash, origins, database,\nRedis and LiveKit. Then start with deploy/server.sh start (or server.ps1 start).\nServe web/dist using nginx/Caddy/IIS with SPA fallback and /v1 proxying.\nThe website is prebuilt for same-origin /v1; no frontend build is needed.\nNo node_modules are bundled: install downloads production dependencies for your OS.\nRead KSCTowerNetwork-dev/docs/SERVER_HOSTING.md for database, HTTPS and service setup.\nBack up database, backend/data and private env before updates. Extract a new release\ninto a fresh directory, install dependencies and migrate your private config/data.\nCharts, fonts and player-installed planet textures are optional and not bundled.\n`);
writeFileSync(join(server, 'DEPENDENCY_NOTICES.txt'), dependencyNotices(join(dev, 'backend/node_modules')) + dependencyNotices(join(dev, 'web/node_modules')));
for (const folder of [client, server]) {
  for (const name of ['LICENSE', 'NOTICE.md', 'licenses']) copy(join(source, name), join(folder, name));
  writeFileSync(join(folder, 'RELEASE_MANIFEST.json'), JSON.stringify({ version, sourceCommit, builtAt: new Date().toISOString(), node: process.version, platform: folder === client ? 'win32-x64' : 'linux-or-windows-install-native-dependencies-on-host', files: files(folder).map(file => ({ path: relative(folder, file).replaceAll('\\', '/'), sha256: hash(file) })) }, null, 2));
}
const { validateReleaseTree } = await import('./release-validation.mjs');
validateReleaseTree(client, 'client');
validateReleaseTree(server, 'server');
const clientZip = join(output, `KSCTowerNetwork-Client-${version}-win-x64.zip`);
const serverZip = join(output, `KSCTowerNetwork-Server-${version}.zip`);
zip(client, clientZip);
zip(server, serverZip);
const ckan = JSON.parse(readFileSync(join(dev, 'ckan/KSCTowerNetwork.ckan'), 'utf8'));
ckan.version = version;
ckan.download = `https://github.com/SpaceFoon/KSCTowerNetwork/releases/download/v${version}/${relative(output, clientZip)}`;
ckan.download_size = statSync(clientZip).size;
ckan.download_hash = { sha1: hash(clientZip, 'sha1'), sha256: hash(clientZip) };
const ckanFile = join(output, 'KSCTowerNetwork.ckan');
writeFileSync(ckanFile, JSON.stringify(ckan, null, 2));
writeFileSync(join(output, 'SHA256SUMS.txt'), [clientZip, serverZip, ckanFile].map(file => `${hash(file)}  ${relative(output, file)}`).join('\n') + '\n');
console.log(`\nRelease artifacts verified: ${output}\nSource commit: ${sourceCommit}`);
