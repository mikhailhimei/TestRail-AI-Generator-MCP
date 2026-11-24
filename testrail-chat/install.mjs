import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { ensureCli } from './install-cli.mjs';
import { codexCommand } from './runtime/codex-bridge.mjs';

const source = path.dirname(fileURLToPath(import.meta.url));
const runtime = await import(pathToFileURL(path.join(source, 'runtime', 'codex-runtime.mjs')).href);
const manifest = JSON.parse(await readFile(path.join(source, 'plugin.json'), 'utf8'));
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) throw Error('Требуется Node.js 22.12 или новее');
if (!process.env.CODEX_INSTALL_CLI) await ensureCli('codex');
// State is outside the plugin cache and survives plugin updates.
const root = runtime.bridgeStateRoot();
const legacyState = process.argv.includes('--legacy-state') ? process.argv[process.argv.indexOf('--legacy-state') + 1] : path.dirname(source);
await runtime.ensureBridgeToken(root, [legacyState]);
const marketplace = path.join(root, 'plugin-marketplace');
const destination = path.join(marketplace, 'plugins', manifest.name);
await mkdir(destination, { recursive: true });
if (path.resolve(source) !== path.resolve(destination)) await cp(source, destination, { recursive: true });
const catalogDirectory = path.join(marketplace, '.agents', 'plugins');
await mkdir(catalogDirectory, { recursive: true });
await writeFile(path.join(catalogDirectory, 'marketplace.json'), JSON.stringify({
  name: 'testrail-local', interface: { displayName: 'TestRail AI Generator' },
  plugins: [{ name: manifest.name, source: { source: 'local', path: `./plugins/${manifest.name}` },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }]
}, null, 2));
const [cli, prefix] = process.env.CODEX_INSTALL_CLI
  ? codexCommand({ env: { ...process.env, CODEX_BIN: process.env.CODEX_INSTALL_CLI } })
  : codexCommand();
execFileSync(cli, [...prefix, 'plugin', 'marketplace', 'add', marketplace], { stdio: 'inherit', windowsHide: true });
execFileSync(cli, [...prefix, 'plugin', 'add', `${manifest.name}@testrail-local`], { stdio: 'inherit', windowsHide: true });
const { installBackgroundService } = await import(pathToFileURL(path.join(destination, 'runtime', 'codex-service.mjs')).href);
await installBackgroundService(destination);
console.log('TestRail AI Generator установлен. Переподключите MCP / откройте новую беседу и выберите плагин.');
console.log('Для генерации из расширения открывать проект, консоль или чат не требуется.');
