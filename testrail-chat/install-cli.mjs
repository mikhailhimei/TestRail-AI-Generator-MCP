import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexCommand } from './runtime/codex-bridge.mjs';
import { agentCommand } from './runtime/local-agents.mjs';

const providers = {
  codex: { label: 'Codex CLI', packageName: '@openai/codex', command: codexCommand },
  gemini: { label: 'Gemini CLI', packageName: '@google/gemini-cli', command: () => agentCommand('gemini-mcp') },
  qwen: {
    label: 'Qwen Code',
    packageName: '@qwen-code/qwen-code',
    command: () => {
      if (process.platform === 'win32') {
        for (const directory of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
          const binDirectory = directory.replace(/^"|"$/g, '');
          const script = path.join(binDirectory, 'node_modules', '@qwen-code', 'qwen-code', 'cli-entry.js');
          if (existsSync(script)) return [process.execPath, [script]];
          const executable = path.join(binDirectory, 'qwen.exe');
          if (existsSync(executable)) return [executable, []];
        }
      }
      return ['qwen', []];
    },
  },
  copilot: { label: 'Copilot CLI', packageName: '@github/copilot', command: () => agentCommand('copilot-mcp') },
};

function npmCommand() {
  if (process.platform !== 'win32') return ['npm', []];
  const directories = [path.dirname(process.execPath), ...(process.env.PATH || '').split(path.delimiter)];
  for (const directory of directories.filter(Boolean)) {
    const entry = path.join(directory.replace(/^"|"$/g, ''), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (existsSync(entry)) return [process.execPath, [entry]];
  }
  throw Error('npm не найден. Установите Node.js вместе с npm.');
}

function versionWorks(command) {
  const [binary, prefix] = command();
  return spawnSync(binary, [...prefix, '--version'], { stdio: 'ignore', windowsHide: true, timeout: 15000 }).status === 0;
}

async function archiveMatches(file, integrity) {
  const hash = createHash('sha512');
  try {
    for await (const chunk of createReadStream(file)) hash.update(chunk);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  return `sha512-${hash.digest('base64')}` === integrity;
}

export async function downloadPackage(name, info, directory, npm, {
  run = execFileSync, platform = process.platform, attempts = 3, log = console.log
} = {}) {
  const url = new URL(info.dist?.tarball);
  const integrity = info.dist?.integrity;
  if (url.origin !== 'https://registry.npmjs.org' || !/^sha512-[A-Za-z0-9+/=]+$/.test(integrity || '')) {
    throw Error(`Не удалось проверить метаданные npm-пакета ${name}.`);
  }
  await mkdir(directory, { recursive: true });
  const key = createHash('sha256').update(url.href + '\n' + integrity).digest('hex');
  const archive = path.join(directory, `${key}.tgz`);
  const partial = `${archive}.part`;
  if (!await archiveMatches(archive, integrity)) {
    await rm(archive, { force: true });
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      // A timeout can happen after the last bytes arrived. Verify before requesting a range.
      if (await archiveMatches(partial, integrity)) break;
      log(`Скачивание ${name} ${info.version}… Попытка ${attempt}/${attempts}; докачка включена.`);
      try {
        run(platform === 'win32' ? 'curl.exe' : 'curl', [
          '--fail', '--location', '--progress-bar', '--proto', '=https', '--proto-redir', '=https',
          '--connect-timeout', '20', '--max-time', '3600', '--speed-limit', '1024', '--speed-time', '120',
          '--continue-at', '-', '--write-out', '%{http_code}', '--output', partial, url.href
        ], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', windowsHide: true });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        // Some proxies do not support byte ranges. Restart only in that specific case.
        if (error.status === 33 || (error.status === 22 && String(error.stdout).trim() === '416')) {
          await rm(partial, { force: true });
        }
      }
    }
    if (!await archiveMatches(partial, integrity)) {
      if (lastError) throw Error(`Не удалось скачать ${name} после ${attempts} попыток (curl: ${lastError.status ?? 'ошибка запуска'}). Частичная загрузка сохранена; запустите установщик повторно для докачки. Проверьте VPN/прокси и доступ к registry.npmjs.org.`);
      await rm(partial, { force: true });
      throw Error(`Контрольная сумма пакета ${name} не совпала. Файл удалён; повторите установку.`);
    }
    await rename(partial, archive);
  }
  npm(['cache', 'add', archive]);
  return archive;
}

export function qwenCommand() {
  return providers.qwen.command();
}

export async function ensureCli(provider) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) throw Error('Требуется Node.js 22.12 или новее.');
  const { label, packageName, command } = Object.hasOwn(providers, provider) ? providers[provider] : {};
  if (!command) throw Error('Укажите codex, gemini, copilot или qwen.');
  if (versionWorks(command)) {
    console.log(`${label} уже установлен.`);
    return;
  }
  const [binary, prefix] = npmCommand();
  const registry = '--registry=https://registry.npmjs.org';
  const npm = (args, capture = false) => execFileSync(binary, [...prefix, ...args, registry], {
    encoding: 'utf8', windowsHide: true, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit'
  });
  const metadata = specification => JSON.parse(npm(['view', specification, 'dist', 'version', 'optionalDependencies', '--json'], true));
  const info = metadata(`${packageName}@latest`);
  // Keep partial archives across installer restarts; verified archives can be reused.
  const directory = path.join(tmpdir(), 'testrail-cli-downloads');
  const archive = await downloadPackage(packageName, info, directory, npm);
  const musl = provider === 'copilot' && process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime;
  const platform = musl ? 'linuxmusl' : process.platform;
  const nativeName = `${packageName}-${platform}-${process.arch}`;
  const nativeVersion = info.optionalDependencies?.[nativeName];
  if (nativeVersion) {
    const specification = nativeVersion.startsWith('npm:') ? nativeVersion.slice(4) : `${nativeName}@${nativeVersion}`;
    await downloadPackage(nativeName, metadata(specification), directory, npm);
  }
  console.log(`Распаковка и установка ${label}. npm может скачать дополнительные зависимости…`);
  npm(['install', '--global', '--prefer-offline', '--no-audit', '--no-fund', archive]);
  const npmPrefix = npm(['prefix', '--global'], true).trim();
  const binDirectory = process.platform === 'win32' ? npmPrefix : path.join(npmPrefix, 'bin');
  process.env.PATH = [binDirectory, process.env.PATH].filter(Boolean).join(path.delimiter);
  if (!versionWorks(command)) throw Error(`${label} не запускается после установки. Проверьте PATH.`);
  console.log(`${label} установлен. Если приложение уже открыто, перезапустите его.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await ensureCli(process.argv[2] || (await readFile(new URL('./provider.txt', import.meta.url), 'utf8')).trim());
  } catch (error) {
    process.exitCode = 1;
    console.error(error.stderr?.trim?.() || error.message);
  }
}
