import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const deployRoot = dirname(fileURLToPath(import.meta.url));
const devRoot = resolve(deployRoot, '..');
const backend = join(devRoot, 'backend');
const web = join(devRoot, 'web');

export function productionEnvironment(text, inherited = process.env) {
  const values = parseEnv(text);
  if (values.NODE_ENV && values.NODE_ENV !== 'production') {
    throw new Error('The server env file must use NODE_ENV=production.');
  }
  if (!values.APP_JWT_SECRET || values.APP_JWT_SECRET.includes('CHANGE_ME')) {
    throw new Error('Set APP_JWT_SECRET in the server env file before starting.');
  }
  return { ...inherited, ...values, NODE_ENV: 'production' };
}

function run(command, args, cwd, env = process.env) {
  return new Promise((done, reject) => {
    let executable = command;
    let launchArgs = args;
    if (command === 'npm.cmd') {
      const candidates = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')].filter(Boolean);
      const npmCli = candidates.find(candidate => existsSync(candidate));
      if (!npmCli) return reject(new Error('npm CLI not found beside Node. Install Node with npm, or run through npm.'));
      executable = process.execPath;
      launchArgs = [npmCli, ...args];
    }
    const child = spawn(executable, launchArgs, { cwd, env, stdio: 'inherit', shell: false });
    const interrupt = () => child.kill('SIGINT');
    const terminate = () => child.kill('SIGTERM');
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);
    const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => {
      cleanup();
      if (code === 0) done();
      else reject(new Error(`${command} ${args.join(' ')} stopped (${signal ?? code}).`));
    });
  });
}

export async function main(args = process.argv.slice(2)) {
  const [command, ...options] = args;
  if (!command || command === '--help' || command === '-h') {
    console.log('Server commands: install | setup | build | start [--env-file /path/to/server.env]');
    console.log('Requires Node 24.22.1 LTS and npm. Serves the backend; nginx/Caddy/IIS serves web/dist and proxies /v1 to port 48787.');
    return;
  }
  if (!['install', 'setup', 'build', 'start'].includes(command)) throw new Error(`Unknown server command: ${command}`);
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 22 || (minor === 22 && patch < 1)) {
    throw new Error('Node 24.22.1 LTS or newer Node 24 is required.');
  }
  if (options.length && !(command === 'start' && options.length === 2 && options[0] === '--env-file')) {
    throw new Error('Only start accepts --env-file followed by a path.');
  }
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  if (command === 'install') {
    await run(npm, ['ci', '--omit=dev'], backend);
    const target = join(backend, '.env.production');
    if (!existsSync(target)) copyFileSync(join(deployRoot, 'server.env.example'), target);
    console.log('Production dependencies installed. Configure backend/.env.production, then run start. Website is already built.');
  } else if (command === 'setup') {
    // Server installation deliberately bypasses the root lifecycle and player bridge tooling.
    await run(npm, ['ci'], backend);
    await run(npm, ['ci'], web);
    const target = join(backend, '.env.production');
    if (!existsSync(target)) copyFileSync(join(deployRoot, 'server.env.example'), target);
    console.log('Server dependencies installed. Configure backend/.env.production, then run build and start.');
  } else if (command === 'build') {
    await run(npm, ['run', 'build'], backend);
    await run(npm, ['run', 'build'], web, { ...process.env, NODE_ENV: 'production', VITE_API_BASE: process.env.VITE_API_BASE ?? '' });
    console.log('Built backend/dist and web/dist. Install optional charts after this build.');
  } else {
    const entry = join(backend, 'dist', 'index.js');
    if (!existsSync(entry)) throw new Error('Backend build is missing. Run the build command first.');
    const envPath = options.length ? resolve(options[1]) : join(backend, '.env.production');
    const env = productionEnvironment(readFileSync(envPath, 'utf8'));
    await run(process.execPath, [entry], backend, env);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`[server] ${error.message}`); process.exitCode = 1; });
}
