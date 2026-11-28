import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createAutotestJobs } from '../testrail-chat/runtime/codex-autotests.mjs';
import { createBridge } from '../testrail-chat/runtime/codex-bridge.mjs';
const caseData = { caseIdNumeric: '123', title: 'Scenario', type: 'Functional', preconditions: '', steps: [] };
const request = projectPath => ({ projectPath, pageUrl: '', mocks: '', description: '', cases: [caseData] });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('autotests have a one-hour deadline and remain cancellable and resumable after restart', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'autotest-persistence-'));
  const storagePath = path.join(directory, 'state', 'jobs.json');
  await mkdir(path.join(directory, '.git'));
  const execute = (_, signal, report) => {
    report('Working');
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  const jobs = createAutotestJobs({ storagePath, execute });
  let restored;
  try {
    const timer = t.mock.method(globalThis, 'setTimeout');
    const job = await jobs.start(request(directory), 'gemini-mcp');
    await tick();
    assert.equal(timer.mock.callCount(), 1);
    assert.equal(timer.mock.calls[0].arguments[1], 3_600_000);
    timer.mock.calls[0].arguments[0]();
    await tick();
    assert.equal(jobs.get(job.id).state, 'cancelled');
    assert.match(jobs.get(job.id).events.at(-1).text, /60/);
    timer.mock.restore();
    jobs.continue(job.id);
    await tick();
    assert.equal(jobs.get(job.id).state, 'running');
    jobs.cancel(job.id);
    await tick();
    assert.equal(jobs.get(job.id).state, 'cancelled');
    jobs.continue(job.id, 'Проверь также пустой список');
    await tick();
    // Preserve the last on-disk state as if the process was killed mid-run.
    const interrupted = await readFile(storagePath, 'utf8');
    jobs.close();
    await tick();
    await writeFile(storagePath, interrupted);
    const attempts = [];
    restored = createAutotestJobs({ storagePath, execute: async input => { attempts.push(input); } });
    const recovered = restored.get(job.id);
    assert.equal(recovered.state, 'cancelled');
    assert.equal(restored.busy, false);
    assert.ok(recovered.finishedAt);
    assert.match(recovered.events.at(-1).text, /Сервер был перезапущен/);
    assert.equal(restored.continue(job.id).state, 'running');
    await tick();
    assert.equal(restored.get(job.id).state, 'completed');
    assert.equal(attempts[0].continuation, true);
    assert.equal(attempts[0].agent, 'gemini-mcp');
    assert.deepEqual(attempts[0].cases, [caseData]);
    assert.deepEqual(attempts[0].followUps, ['Проверь также пустой список']);
    const finished = createAutotestJobs({ storagePath });
    assert.equal(finished.get(job.id).state, 'completed');
    assert.ok(finished.get(job.id).finishedAt);
  } finally {
    jobs.close(); restored?.close();
    await tick();
    await rm(directory, { recursive: true, force: true });
  }
});

test('bridge recovers a missing job from the original request with its agent and clarification history', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'autotest-recovery-'));
  await mkdir(path.join(directory, '.git'));
  const token = 'a'.repeat(40);
  const attempts = [];
  const server = createBridge({ token, autotestOptions: { execute: async input => { attempts.push(input); } } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const post = (action, body) => fetch(`http://127.0.0.1:${server.address().port}/autotests/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`,
      Origin: `chrome-extension://${'a'.repeat(32)}` }, body: JSON.stringify(body)
  });
  try {
    const recovery = { ...request(directory), agent: 'gemini-mcp', model: 'original-model', followUps: ['Проверь пустой список'] };
    assert.equal((await post('status', { id: 'lost-job' })).status, 404);
    assert.equal((await post('continue', { id: 'lost-job' })).status, 404);
    assert.equal((await post('continue', { id: 'invalid', recovery: { ...recovery, projectPath: directory + '-missing' } })).status, 400);
    assert.equal((await post('continue', { id: 'invalid', recovery: { ...recovery, agent: 'unknown' } })).status, 400);
    assert.equal((await post('follow-up', { id: 'invalid', recovery, message: '' })).status, 400);
    const response = await post('continue', { id: 'lost-job', recovery });
    assert.equal(response.status, 200);
    const job = await response.json();
    assert.equal(job.id, 'lost-job');
    assert.deepEqual(job.request.followUps, recovery.followUps);
    await tick();
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].continuation, true);
    assert.equal(attempts[0].agent, 'gemini-mcp');
    assert.equal(attempts[0].model, 'original-model');
    assert.deepEqual(attempts[0].cases, [caseData]);
    // A stale client snapshot must not replace a job that still exists on the server.
    const followUp = await post('follow-up', { id: job.id, recovery: { ...recovery, agent: 'codex' }, message: 'Добавь проверку ошибок' });
    assert.equal(followUp.status, 200);
    await tick();
    assert.equal(attempts[1].agent, 'gemini-mcp');
    assert.deepEqual(attempts[1].followUps, [...recovery.followUps, 'Добавь проверку ошибок']);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

