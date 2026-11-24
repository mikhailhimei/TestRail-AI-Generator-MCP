import { spawnSync } from 'node:child_process';
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { ensureCli, qwenCommand } from './install-cli.mjs';
import { bridgeStateRoot } from './runtime/codex-runtime.mjs';
import { agentCommand } from './runtime/local-agents.mjs';

const providers = ['codex', 'gemini', 'copilot', 'qwen'];
const input = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
});

console.log('TestRail AI Generator');
console.log('1. Codex\n2. Gemini CLI\n3. GitHub Copilot\n4. Qwen / DeepSeek (Qwen Code)\n0. Выход');
input.setPrompt('Выберите клиента [0–4]: ');
input.prompt();

let provider;
for await (const line of input) {
  const choice = line.trim();
  if (choice === '0') break;
  if (/^[1-4]$/.test(choice)) {
    provider = providers[Number(choice) - 1];
    break;
  }
  console.log('Введите 1, 2, 3, 4 или 0.');
  input.prompt();
}
input.close();

const localFile = (name) => fileURLToPath(new URL(name, import.meta.url));

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    throw Error('Команда установки завершилась с ошибкой. Подробности указаны выше.');
  }
}

async function configureMcp(provider) {
  await ensureCli(provider);
  const destination = path.join(bridgeStateRoot(), 'mcp-server');
  await mkdir(destination, { recursive: true });
  for (const name of ['server.mjs', 'bridge-client.mjs', 'runtime']) {
    const target = path.join(destination, name);
    if (path.resolve(localFile(name)) !== path.resolve(target)) {
      await cp(localFile(name), target, { recursive: true });
    }
  }

  const server = path.join(destination, 'server.mjs');
  const [command, prefix] = provider === 'qwen' ? qwenCommand() : agentCommand(`${provider}-mcp`);
  const args = provider !== 'copilot'
    ? ['mcp', 'add', '--scope', 'user', 'testrail-extension', process.execPath, server]
    : ['mcp', 'add', 'testrail-extension', '--', process.execPath, server];
  run(command, [...prefix, ...args]);
  console.log('TestRail MCP добавлен. Откройте новую сессию и войдите в аккаунт, если потребуется.');
  if (provider === 'qwen') {
    console.log('Запустите qwen, настройте модель Qwen или DeepSeek и проверьте подключение командой /mcp list.');
    console.log('В расширении Chrome выберите «Codex (локальный сервер)», нажмите «Подключить Codex» и подтвердите доступ.');
    return;
  }
  console.log(`В расширении Chrome выберите ${provider === 'gemini' ? 'Gemini MCP' : 'Copilot MCP'}, нажмите «Подключить» и подтвердите доступ.`);
}

try {
  if (provider === 'codex') {
    if (process.platform === 'win32') run(process.execPath, [localFile('install.mjs')]);
    else run('sh', [localFile('install-unix.sh')]);
  } else if (provider) {
    await configureMcp(provider);
  }
} catch (error) {
  process.exitCode ||= 1;
  console.error(error.message);
}
