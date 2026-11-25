import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { validateAutotestRequest, autotestPrompt, runAutotestCodex } from '../testrail-chat/runtime/codex-autotests.mjs';
import { createBridge } from '../testrail-chat/runtime/codex-bridge.mjs';
import { createChatChannel, CHAT_TOOLS } from '../testrail-chat/runtime/codex-chat.mjs';

const kept = { caseIdNumeric: '123', title: 'Current scenario', type: 'Functional', preconditions: '', steps: [] };
const deleted = { ...kept, caseIdNumeric: '124', title: 'Удалить', type: 'Delete' };
const request = projectPath => ({ projectPath, pageUrl: '', mocks: '', description: '', cases: [kept, deleted] });

test('optional page URL and case types survive validation without changing delete to create', () => {
  const data = request(path.resolve('project'));
  for (const pageUrl of [undefined, '', '   ']) {
    const checked = validateAutotestRequest({ ...data, pageUrl });
    assert.equal(checked.pageUrl, '');
    assert.deepEqual(checked.cases, [kept, deleted]);
    assert.match(autotestPrompt(checked), /Ссылка на страницу не указана/);
  }
  assert.equal(validateAutotestRequest({ ...data, cases: [{ ...kept, type: undefined }] }).cases[0].type, 'Functional');
  for (const type of ['delete', null, 'Unknown', 1]) {
    assert.throws(() => validateAutotestRequest({ ...data, cases: [{ ...kept, type }] }), /тип/);
  }
  assert.throws(() => validateAutotestRequest({ ...data, pageUrl: 'invalid' }), /URL/);
  const prompt = autotestPrompt(validateAutotestRequest(data));
  assert.match(prompt, /точному caseIdNumeric/);
  assert.match(prompt, /сохрани покрытие остальных ID/);
  assert.match(prompt, /Не создавай и не обновляй автотест для такого кейса/);
  assert.match(prompt, /неоднозначна/);
});

test('actual CLI input contains both types, original TestRail IDs and deletion instructions', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mcp-autotest-cli-'));
  try {
    const script = path.join(directory, 'fake-cli.mjs');
    await writeFile(script, `import { writeFileSync } from 'node:fs';
      let text = ''; for await (const chunk of process.stdin) text += chunk;
      writeFileSync('prompt.txt', text);
      console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done' } }));`);
    await runAutotestCodex(validateAutotestRequest(request(directory)), new AbortController().signal, () => {},
      () => [process.execPath, [script]]);
    const prompt = await readFile(path.join(directory, 'prompt.txt'), 'utf8');
    assert.match(prompt, /"type": "Functional"/);
    assert.match(prompt, /"type": "Delete"/);
    assert.match(prompt, /"caseIdNumeric": "124"/);
    assert.match(prompt, /Не удаляй кейсы из TestRail/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('all autotest agent routes accept mixed actions with no page URL and advertise support', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mcp-autotest-http-'));
  await mkdir(path.join(directory, '.git'));
  const token = 'a'.repeat(40);
  const received = [];
  const server = createBridge({ token, autotestOptions: { execute: async data => { received.push(data); } } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: `chrome-extension://${'a'.repeat(32)}` };
  try {
    assert.equal((await (await fetch(`${base}/health`, { headers })).json()).autotestCaseActions, true);
    for (const agent of ['', '/gemini-mcp', '/copilot-mcp']) {
      const response = await fetch(`${base}/autotests${agent}/start`, { method: 'POST', headers, body: JSON.stringify(request(directory)) });
      assert.equal(response.status, 202);
      const job = await response.json();
      for (let attempt = 0; attempt < 100; attempt++) {
        const status = await (await fetch(`${base}/autotests/status`, { method: 'POST', headers, body: JSON.stringify({ id: job.id }) })).json();
        if (status.state === 'completed') break;
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.ok(attempt < 99, 'job must complete');
      }
      assert.deepEqual(received.at(-1).cases, [kept, deleted]);
      assert.equal(received.at(-1).pageUrl, '');
    }
    assert.equal(received.length, 3);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('MCP can mark a draft as Delete while preserving the draft itself', async () => {
  assert.ok(CHAT_TOOLS.find(tool => tool.name === 'update_test_case').inputSchema.properties.case.properties.type.enum.includes('Delete'));
  const channel = createChatChannel({ commandTimeoutMs: 1000 });
  const state = { sessionId: 'panel', revision: 'r1', busy: false, rawText: '', instructions: '', cases: [{ ...kept, id: 'draft' }] };
  try {
    channel.poll(state);
    const pending = channel.rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'update_test_case', arguments: { sessionId: 'panel', expectedRevision: 'r1', caseId: 'draft',
        case: { title: 'Удалить', type: 'Delete', preconditions: '', steps: [] } }
    } });
    const commands = channel.poll(state).commands;
    assert.equal(commands.length, 1);
    assert.equal(commands[0].name, 'update_test_case');
    assert.equal(commands[0].arguments.case.type, 'Delete');
    channel.complete({ id: commands[0].id, sessionId: 'panel', ok: true, state });
    assert.equal(JSON.parse((await pending).result.content[0].text).applied, true);
  } finally { channel.close(); }
});
