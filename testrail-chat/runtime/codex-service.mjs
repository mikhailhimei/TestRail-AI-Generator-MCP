import { spawn } from 'node:child_process';
import { cp, mkdir, open, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBridge } from './codex-bridge.mjs';
import { bridgeStateRoot, ensureBridgeToken, confirmDesktopPair } from './codex-runtime.mjs';

export async function startBridgeService(entry, { stateRoot = bridgeStateRoot(), port = Number(process.env.CODEX_BRIDGE_PORT || 3210), configuredToken } = {}) {
  const directory = path.join(stateRoot, '.codex-bridge');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const log = await open(path.join(directory, 'server.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [entry], {
      cwd: path.dirname(entry), detached: true, windowsHide: true,
      stdio: ['ignore', log.fd, log.fd],
      env: { ...process.env, CODEX_BRIDGE_DIR: stateRoot, CODEX_BRIDGE_PORT: String(port),
        ...(configuredToken ? { CODEX_BRIDGE_TOKEN: configuredToken } : {}) }
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    return child;
  } finally { await log.close(); }
}

// Register only for the current user, with absolute paths to the installed copy.
export async function installBridgeStartup(entry, { platform = process.platform, env = process.env, home = homedir() } = {}) {
  const node = process.execPath;
  let filename, content;
  if (platform === 'win32') {
    if (!env.APPDATA) throw Error('APPDATA отсутствует: не удалось настроить запуск сервера');
    filename = path.join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'TestRail AI Generator.vbs');
    const command = `"${node}" "${entry}"`;
    content = `CreateObject("WScript.Shell").Run "${command.replace(/"/g, '""')}", 0, False\r\n`;
  } else if (platform === 'darwin') {
    filename = path.join(home, 'Library', 'LaunchAgents', 'com.testrail-ai-generator.bridge.plist');
    const xml = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    content = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.testrail-ai-generator.bridge</string><key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(entry)}</string></array><key>RunAtLoad</key><true/></dict></plist>\n`;
  } else {
    filename = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'autostart', 'testrail-ai-generator.desktop');
    const quote = value => '"' + value.replace(/[\\"`$]/g, '\\$&').replace(/%/g, '%%') + '"';
    content = `[Desktop Entry]\nType=Application\nName=TestRail AI Generator\nExec=${quote(node)} ${quote(entry)}\nTerminal=false\n`;
  }
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, content, { mode: 0o600 });
  return filename;
}

export async function serveBridge() {
  const port = Number(process.env.CODEX_BRIDGE_PORT || 3210);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Неверный CODEX_BRIDGE_PORT');
  const token = await ensureBridgeToken(bridgeStateRoot());
  const server = createBridge({ token, confirmPair: confirmDesktopPair });
  server.on('error', error => {
    // Another MCP adapter or login launcher may have won the startup race.
    if (error.code === 'EADDRINUSE') process.exit(0);
    console.error(error);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1');
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
  return server;
}

export async function installBackgroundService(pluginDirectory) {
  const entry = path.join(pluginDirectory, 'runtime', 'codex-service.mjs');
  const startup = await installBridgeStartup(entry);
  const { createBridgeClient } = await import(pathToFileURL(path.join(pluginDirectory, 'bridge-client.mjs')).href);
  const client = createBridgeClient({ pluginDirectory });
  try { await client.ensureServer(); } finally { await client.close(); }
  console.log(`Фоновый сервер запущен. Автозапуск при входе: ${startup}`);
}

export async function installStandaloneService(sourceDirectory) {
  const destination = path.join(bridgeStateRoot(), 'mcp-server');
  await mkdir(destination, { recursive: true });
  if (path.resolve(sourceDirectory) !== path.resolve(destination)) {
    for (const name of ['server.mjs', 'bridge-client.mjs', 'runtime']) {
      await cp(path.join(sourceDirectory, name), path.join(destination, name), { recursive: true });
    }
  }
  await installBackgroundService(destination);
  return destination;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await serveBridge();
}
