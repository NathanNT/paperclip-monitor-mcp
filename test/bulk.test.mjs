import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// The bridge below is connected exclusively to this ephemeral HTTP fixture.
const bridge = fileURLToPath(new URL('../paperclip-mcp.mjs', import.meta.url));
const COMPANY = '00000000-0000-4000-8000-000000000001';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const TASK_A = '33333333-3333-4333-8333-333333333333';
const TASK_B = '44444444-4444-4444-8444-444444444444';
const RUN = '55555555-5555-4555-8555-555555555555';
const OPERATION = '66666666-6666-4666-8666-666666666666';
const SECRET = 'BULK_TEST_SECRET_MUST_STAY_LOCAL';
const NOW = '2026-10-02T12:00:00.000Z';

const agents = new Map([
  [A, { id: A, companyId: COMPANY, name: 'A', status: 'paused', adapterType: 'codex_local', updatedAt: NOW,
    adapterConfig: { model: 'gpt-6-sol', modelReasoningEffort: 'high', fastMode: false, apiKey: SECRET },
    runtimeConfig: { heartbeat: { enabled: false, intervalSec: 600 } } }],
  [B, { id: B, companyId: COMPANY, name: 'B', status: 'paused', adapterType: 'codex_local', updatedAt: NOW,
    adapterConfig: { model: 'gpt-6-sol', modelReasoningEffort: 'high', fastMode: false, apiKey: SECRET },
    runtimeConfig: { heartbeat: { enabled: false, intervalSec: 600 } } }],
]);
const tasks = new Map([
  [TASK_A, { id: TASK_A, companyId: COMPANY, projectId: '77777777-7777-4777-8777-777777777777', assigneeAgentId: A, status: 'todo' }],
  [TASK_B, { id: TASK_B, companyId: COMPANY, projectId: '77777777-7777-4777-8777-777777777777', assigneeAgentId: B, status: 'blocked' }],
]);
const requests = [];
let liveRuns = [];
let wakeCount = 0;
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const bodyText = request.method === 'GET' ? '' : await Array.fromAsync(request).then(parts => Buffer.concat(parts).toString('utf8'));
  const body = bodyText ? JSON.parse(bodyText) : null;
  requests.push({ method: request.method, path: url.pathname, body });
  response.setHeader('Content-Type', 'application/json');
  const send = value => response.end(JSON.stringify(value));
  const agentId = url.pathname.match(/^\/api\/agents\/([0-9a-f-]+)(?:\/(resume|wakeup))?$/)?.[1];
  const action = url.pathname.match(/^\/api\/agents\/[0-9a-f-]+\/(resume|wakeup)$/)?.[1];
  if (agentId && !agents.has(agentId)) { response.statusCode = 404; return send({ error: 'unknown agent' }); }
  if (request.method === 'GET' && agentId && !action) return send(agents.get(agentId));
  if (request.method === 'PATCH' && agentId && !action) {
    assert.deepEqual(Object.keys(body), ['adapterConfig']);
    assert.ok(!JSON.stringify(body).includes(SECRET), 'Bulk PATCH sent a credential');
    const current = agents.get(agentId);
    const updated = { ...current, updatedAt: '2026-10-02T12:01:00.000Z', adapterConfig: { ...current.adapterConfig, ...body.adapterConfig } };
    agents.set(agentId, updated);
    return send(updated);
  }
  if (request.method === 'POST' && agentId && action === 'resume') {
    const current = agents.get(agentId);
    const updated = { ...current, status: 'idle' };
    agents.set(agentId, updated);
    return send(updated);
  }
  if (request.method === 'POST' && agentId && action === 'wakeup') {
    assert.equal(body.idempotencyKey, `bulk:${OPERATION}:${A}`);
    assert.equal(body.payload.issueId, TASK_A);
    wakeCount++;
    const run = { id: RUN, companyId: COMPANY, agentId, status: 'queued' };
    liveRuns = [run];
    return send(run);
  }
  if (request.method === 'GET' && url.pathname === `/api/heartbeat-runs/${RUN}`) return send(liveRuns[0]);
  if (request.method === 'GET' && url.pathname === `/api/companies/${COMPANY}/live-runs`) return send(liveRuns);
  if (request.method === 'GET' && url.pathname === `/api/companies/${COMPANY}/heartbeat-runs`) return send([]);
  if (request.method === 'GET' && url.pathname === `/api/companies/${COMPANY}/issues`) {
    return send([...tasks.values()].filter(task => !url.searchParams.has('assigneeAgentId') || task.assigneeAgentId === url.searchParams.get('assigneeAgentId')));
  }
  const taskId = url.pathname.match(/^\/api\/issues\/([0-9a-f-]+)$/)?.[1];
  if (request.method === 'GET' && taskId && tasks.has(taskId)) return send(tasks.get(taskId));
  response.statusCode = 404;
  return send({ error: 'unknown fixture route' });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

const child = spawn(process.execPath, [bridge], {
  env: { ...process.env, PAPERCLIP_API_URL: `http://127.0.0.1:${server.address().port}`, PAPERCLIP_COMPANY_ID: COMPANY, PAPERCLIP_ALLOW_WRITES: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let nextId = 0;
const pending = new Map();
let stderr = '';
child.stderr.on('data', data => { stderr += data.toString(); });
createInterface({ input: child.stdout }).on('line', line => {
  const packet = JSON.parse(line);
  const entry = pending.get(packet.id);
  if (entry) { clearTimeout(entry.timer); pending.delete(packet.id); entry.resolve(packet); }
});
function request(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP timeout: ${stderr}`)), 30000);
    pending.set(id, { resolve, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
async function call(args) {
  const packet = await request('tools/call', { name: 'paperclip_manage_agents_bulk', arguments: args });
  assert.notEqual(packet.result?.isError, true, JSON.stringify(packet.result?.content));
  return packet.result.structuredContent.data;
}
async function callError(args, pattern) {
  const packet = await request('tools/call', { name: 'paperclip_manage_agents_bulk', arguments: args });
  assert.equal(packet.result?.isError, true, 'Expected preflight rejection');
  assert.match(packet.result.content?.[0]?.text || '', pattern);
}
try {
  const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bulk-test', version: '1' } });
  assert.equal(init.result?.protocolVersion, '2025-06-18');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const catalog = await request('tools/list');
  assert.ok(catalog.result?.tools.some(tool => tool.name === 'paperclip_manage_agents_bulk'));

  const selection = { agentIds: [A, B], changes: { model: 'gpt-6.1-sol', reasoningEffort: 'xhigh', fastMode: true } };
  const before = requests.filter(item => item.method !== 'GET').length;
  const preview = await call({ ...selection, minFreeMemoryGiB: 2 });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.capacity.minFreeMemoryGiB, 2);
  assert.equal(preview.summary.plannedConfiguration, 2);
  assert.equal(requests.filter(item => item.method !== 'GET').length, before, 'Default preview wrote to Paperclip');

  await callError({ agentIds: [A, B], changes: { model: 'gpt-6-luna' }, dryRun: false }, /explicit reasoningEffort/);
  await callError({ agentIds: [A, B], changes: { model: 'gpt-6-luna', reasoningEffort: 'ultra' }, dryRun: false }, /Unverified Codex model\/reasoningEffort pair/);
  await callError({ agentIds: [A, B], changes: { model: 'gpt-daybreak-blue-latest', reasoningEffort: 'high', fastMode: true }, dryRun: false }, /Fast compatibility is unverified/);
  assert.equal(requests.filter(item => item.method !== 'GET').length, before, 'Invalid model settings reached a write route');

  const applied = await call({ ...selection, dryRun: false });
  assert.equal(applied.summary.verifiedConfiguration, 2);
  const patches = requests.filter(item => item.method === 'PATCH' && item.path.startsWith('/api/agents/'));
  assert.equal(patches.length, 2);
  for (const patch of patches) assert.deepEqual(patch.body, { adapterConfig: { model: 'gpt-6.1-sol', modelReasoningEffort: 'xhigh', fastMode: true } });
  assert.equal(agents.get(A).adapterConfig.apiKey, SECRET);
  assert.ok(!JSON.stringify(applied).includes(SECRET), 'Bulk result exposed a credential');
  assert.equal(agents.get(A).status, 'paused', 'Configuration resumed an agent implicitly');

  const solPreview = await call({ agentIds: [A], changes: { model: 'gpt-6-sol', reasoningEffort: 'ultra', fastMode: true } });
  assert.equal(solPreview.agents[0].after.reasoningEffort, 'ultra');
  assert.equal(agents.get(A).adapterConfig.model, 'gpt-6.1-sol', 'Supported pair preview unexpectedly wrote to Paperclip');

  await callError({ agentIds: [A], changes: { model: 'gpt-daybreak-blue-latest', reasoningEffort: 'high' }, dryRun: false }, /Fast compatibility is unverified/);
  assert.equal(requests.filter(item => item.method === 'PATCH' && item.path === `/api/agents/${A}`).length, 1, 'Retained Fast mode was not checked for the new model');

  const beforeBlocked = requests.filter(item => item.method !== 'GET').length;
  const blocked = await call({ agentIds: [B], launch: 'wake', operationId: OPERATION, dryRun: false });
  assert.equal(blocked.agents[0].launch, 'skipped_blocked_task');
  assert.equal(requests.filter(item => item.method !== 'GET').length, beforeBlocked, 'Blocked task was awakened');

  const woke = await call({ agentIds: [A], launch: 'wake', operationId: OPERATION, dryRun: false, minFreeMemoryGiB: 0.5 });
  assert.equal(woke.agents[0].launch, 'wake_verified');
  assert.equal(wakeCount, 1);
  assert.equal(agents.get(A).status, 'idle');
  const repeat = await call({ agentIds: [A], launch: 'wake', operationId: OPERATION, dryRun: false, minFreeMemoryGiB: 0.5 });
  assert.equal(repeat.agents[0].launch, 'already_live');
  assert.equal(wakeCount, 1, 'A repeated request woke the same agent twice');
  console.log('PASS bulk: preview, configuration, paused state, blocked-task guard, bounded wake, no secret leakage');
} finally {
  child.stdin.end();
  await new Promise(resolve => { child.once('exit', resolve); setTimeout(() => { child.kill(); resolve(); }, 1500); });
  await new Promise(resolve => server.close(resolve));
}
