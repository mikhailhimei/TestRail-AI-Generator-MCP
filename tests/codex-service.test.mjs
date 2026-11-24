import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { startBridgeService, installBridgeStartup } from '../testrail-chat/runtime/codex-service.mjs';
import { ensureBridgeToken } from '../testrail-chat/runtime/codex-runtime.mjs';
import { createBridgeClient } from '../testrail-chat/bridge-client.mjs';

test('cold MCP connection starts a separate service and disconnect leaves it running', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'testrail-cold-'));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const pluginDirectory = path.join(root, 'plugin');
  const runtime = path.join(pluginDirectory, 'runtime');
  let client, servicePid;
  try {
    await cp(fileURLToPath(new URL('../testrail-chat/runtime/', import.meta.url)), runtime, {
      recursive: true, filter: filename => !path.extname(filename) || filename.endsWith('.mjs')
    });
    // Record the actual service process only in this isolated fixture, for cleanup.
    const entry = path.join(runtime, 'codex-service.mjs');
    await writeFile(entry, (await readFile(entry, 'utf8')) + `
      if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
        await writeFile(path.join(bridgeStateRoot(), 'service.pid'), String(process.pid));
      }
    `);
    const token = await ensureBridgeToken(root);
    client = createBridgeClient({ pluginDirectory, port, stateRoot: root });
    assert.equal(await client.ensureServer(), token);
    servicePid = Number(await readFile(path.join(root, 'service.pid'), 'utf8'));
    assert.notEqual(servicePid, process.pid);
    await client.close();
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000)
    });
    assert.equal(response.status, 200);
  } finally {
    await client?.close();
    if (!servicePid) servicePid = Number(await readFile(path.join(root, 'service.pid'), 'utf8').catch(() => 0));
    if (servicePid) {
      try { process.kill(servicePid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('background server survives exit of the console that launched it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'testrail-console-'));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const moduleUrl = new URL('../testrail-chat/runtime/codex-service.mjs', import.meta.url).href;
  const entry = fileURLToPath(new URL('../testrail-chat/runtime/codex-service.mjs', import.meta.url));
  let servicePid;
  try {
    const token = await ensureBridgeToken(root);
    const parent = spawn(process.execPath, ['--input-type=module', '-e',
      `import { startBridgeService } from ${JSON.stringify(moduleUrl)};
       const child = await startBridgeService(${JSON.stringify(entry)}, ${JSON.stringify({ stateRoot: root, port })});
       console.log(child.pid);`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    parent.stdout.on('data', chunk => { stdout += chunk; });
    parent.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => { parent.once('error', reject); parent.once('close', resolve); });
    assert.equal(code, 0, stderr);
    servicePid = Number(stdout.trim());
    assert.ok(servicePid > 0);
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000)
        });
        assert.equal(response.status, 200);
        break;
      } catch (error) {
        if (attempt === 50) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  } finally {
    if (servicePid) {
      try { process.kill(servicePid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('standalone bridge serves browser requests and survives MCP disconnect', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'testrail-service-'));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  let child;
  let client;
  try {
    const token = await ensureBridgeToken(root);
    child = await startBridgeService(fileURLToPath(new URL('../testrail-chat/runtime/codex-service.mjs', import.meta.url)), { stateRoot: root, port });
    child.ref();
    const health = () => fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000) });
    for (let i = 0; ; i++) {
      try { assert.equal((await health()).status, 200); break; }
      catch (error) { if (i === 50) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    client = createBridgeClient({ pluginDirectory: fileURLToPath(new URL('../testrail-chat/', import.meta.url)), stateRoot: root, port });
    const result = await client.call({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_extension_state', arguments: {} } });
    assert.equal(result.id, 1);
    assert.ok(result.result);
    await client.close();
    assert.equal((await health()).status, 200);
    const denied = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(denied.status, 401);
  } finally {
    await client?.close();
    if (child && child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('login launchers point at installed runtime and quote paths with spaces', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'testrail-startup-'));
  try {
    const entry = path.join(root, 'installed plugin', 'codex-service.mjs');
    for (const platform of ['win32', 'darwin', 'linux']) {
      const filename = await installBridgeStartup(entry, { platform, home: root, env: { APPDATA: root, XDG_CONFIG_HOME: root } });
      const content = await readFile(filename, 'utf8');
      assert.ok(content.includes('codex-service.mjs'));
      assert.ok(content.includes('installed plugin'));
      assert.ok(!content.includes('server.mjs'));
      if (platform === 'win32') assert.ok(content.includes(', 0, False'));
      if (platform === 'darwin') assert.ok(content.includes('<key>RunAtLoad</key><true/>'));
      if (platform === 'linux') assert.ok(content.includes('Terminal=false'));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
