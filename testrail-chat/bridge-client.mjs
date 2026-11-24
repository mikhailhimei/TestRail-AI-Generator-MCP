import { access } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function resolveBridgeEntry(pluginDirectory) {
  const candidates = [path.join(pluginDirectory, 'runtime', 'codex-bridge.mjs'),
    path.resolve(pluginDirectory, '..', 'codex-bridge.mjs'),
    path.resolve(pluginDirectory, '..', '..', 'codex-bridge.mjs')];
  for (const filename of candidates) {
    try { await access(filename); return filename; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw Error('В плагине отсутствует встроенный сервер. Обновите плагин TestRail.');
}

export function createBridgeClient({ pluginDirectory, port = Number(process.env.CODEX_BRIDGE_PORT || 3210), stateRoot,
  entry, configuredToken } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Неверный CODEX_BRIDGE_PORT');
  let starting;
  let stopped = false;
  const url = `http://127.0.0.1:${port}`;
  const bootstrap = async () => {
    if (stopped) throw Error('Подключение TestRail закрыто');
    const bridgeEntry = entry || await resolveBridgeEntry(pluginDirectory);
    const runtime = await import(pathToFileURL(path.join(path.dirname(bridgeEntry), 'codex-runtime.mjs')).href);
    const token = await runtime.ensureBridgeToken(stateRoot || runtime.bridgeStateRoot(),
      [path.dirname(bridgeEntry), path.resolve(pluginDirectory, '..')], configuredToken);
    const headers = { Authorization: `Bearer ${token}` };
    const probe = async () => {
      let response;
      try { response = await fetch(`${url}/health`, { headers, signal: AbortSignal.timeout(1500) }); }
      catch (error) {
        if (error.cause?.code === 'ECONNREFUSED') return false;
        throw Error('Локальный сервер не отвечает. Проверьте порт подключения TestRail.');
      }
      if (response.status === 401) throw Error('На этом порту запущен сервер с другим ключом. Проверьте CODEX_BRIDGE_DIR или перезапустите старый сервер.');
      if (!response.ok || (await response.json().catch(() => null))?.status !== 'ok') throw Error('Порт TestRail занят другой программой');
      return true;
    };
    if (await probe()) return token;
    if (stopped) throw Error('Подключение TestRail закрыто');
    const service = await import(pathToFileURL(path.join(path.dirname(bridgeEntry), 'codex-service.mjs')).href);
    await service.startBridgeService(path.join(path.dirname(bridgeEntry), 'codex-service.mjs'), {
      stateRoot: stateRoot || runtime.bridgeStateRoot(), port, configuredToken: token
    });
    for (let attempt = 0; attempt < 50; attempt++) {
      if (stopped) throw Error('Подключение TestRail закрыто');
      if (await probe()) return token;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error('Не удалось запустить фоновый сервер TestRail. Проверьте .codex-bridge/server.log.');
  };
  const ensureServer = () => {
    if (!starting) starting = bootstrap().finally(() => { starting = undefined; });
    return starting;
  };
  return {
    ensureServer,
    async call(message) {
      const token = await ensureServer();
      const response = await fetch(`${url}/mcp`, { method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify(message), signal: AbortSignal.timeout(20000) });
      if (response.status === 404) throw Error('Работающий сервер TestRail устарел. Перезапустите его, чтобы плагин запустил встроенную версию.');
      if (!response.ok) throw Error('Не удалось передать команду локальному серверу TestRail');
      return response.status === 202 ? null : response.json();
    },
    async close() {
      stopped = true;
      await starting?.catch(() => {});
    }
  };
}
