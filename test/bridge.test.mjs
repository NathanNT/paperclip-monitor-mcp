import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// All requests stay within an ephemeral mock server. This test never reads or
// writes a configured Paperclip instance, even when live settings are present.
const bridgePath = fileURLToPath(new URL('../paperclip-mcp.mjs', import.meta.url));
const COMPANY = '00000000-0000-4000-8000-000000000001';
const UNKNOWN_COMPANY = '00000000-0000-4000-8000-000000000099';
const AGENT = '11111111-1111-4111-8111-111111111111';
const OTHER_AGENT = '22222222-2222-4222-8222-222222222222';
const TASK = '33333333-3333-4333-8333-333333333333';
const SECOND_TASK = '33333333-3333-4333-8333-333333333334';
const PROJECT = '44444444-4444-4444-8444-444444444444';
const RUN = '55555555-5555-4555-8555-555555555555';
const NATIVE_RUN = '12121212-1212-4212-8212-121212121212';
const TIMER = '66666666-6666-4666-8666-666666666666';
const OTHER_RUN = '77777777-7777-4777-8777-777777777777';
const COMMENT_NEW = '88888888-8888-4888-8888-888888888888';
const COMMENT_MIDDLE = '99999999-9999-4999-8999-999999999999';
const COMMENT_OLD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RETRY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACTION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DOCUMENT_NEW = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DOCUMENT_OLD = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ACTIVITY_RUN = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const CANARY = 'MCP_SECRET_CANARY_NEVER_RETURN';
const SINCE = '2026-10-01T00:00:00.000Z';
const NOW = '2026-10-02T12:00:00.000Z';
const OLD = '2026-09-29T12:00:00.000Z';

const missingCompanyEnv = { ...process.env, PAPERCLIP_API_URL: 'http://127.0.0.1:1' };
delete missingCompanyEnv.PAPERCLIP_COMPANY_ID;
const missingCompany = spawnSync(process.execPath, [bridgePath], {
  env: missingCompanyEnv,
  encoding: 'utf8',
  timeout: 5000,
});
assert.notEqual(missingCompany.status, 0, 'MCP started without PAPERCLIP_COMPANY_ID');
assert.match(missingCompany.stderr, /PAPERCLIP_COMPANY_ID/, 'Missing company error should identify the required setting');

function connect(origin, { atomicManagement = false, companyId = COMPANY, allowWrites = true } = {}) {
  const env = { ...process.env, PAPERCLIP_API_URL: origin, PAPERCLIP_COMPANY_ID: companyId, PAPERCLIP_ATOMIC_MANAGEMENT: atomicManagement ? '1' : '0' };
  if (allowWrites) env.PAPERCLIP_ALLOW_WRITES = '1';
  else delete env.PAPERCLIP_ALLOW_WRITES;
  const child = spawn(process.execPath, [bridgePath], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let sequence = 0;
  let stderr = '';
  const pending = new Map();
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('exit', (code, signal) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`MCP process exited ${code ?? signal}: ${stderr.slice(-2000)}`));
    }
    pending.clear();
  });
  createInterface({ input: child.stdout }).on('line', line => {
    let packet;
    try { packet = JSON.parse(line); } catch { return; }
    const entry = pending.get(packet.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(packet.id);
    entry.resolve(packet);
  });
  function request(method, params = {}) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out calling ${method}: ${stderr.slice(-2000)}`));
      }, 25000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  function notify(method, params = {}) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
  async function call(name, args = {}) {
    const response = await request('tools/call', { name, arguments: args });
    assert.equal(response.error, undefined, `${name}: ${JSON.stringify(response.error)}`);
    assert.notEqual(response.result?.isError, true, `${name}: ${JSON.stringify(response.result?.content)}`);
    if (response.result?.structuredContent?.data !== undefined) return response.result.structuredContent.data;
    const text = response.result?.content?.find(c => c.type === 'text')?.text;
    assert.ok(text, `${name}: no structured or text result`);
    const parsed = JSON.parse(text);
    return Object.hasOwn(parsed, 'data') ? parsed.data : parsed;
  }
  return {
    request, notify, call,
    async stop() {
      if (child.exitCode !== null || child.killed) return;
      child.stdin.end();
      await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill(); resolve(); }, 2000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    },
  };
}

const agents = [
  { id: AGENT, companyId: COMPANY, name: 'Fixture agent', status: 'running', adapterType: 'codex_local', lastHeartbeatAt: NOW, updatedAt: NOW, adapterConfig: { apiKey: CANARY }, runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, maxConcurrentRuns: 3 }, otherSetting: 'preserve-me' } },
  { id: OTHER_AGENT, companyId: COMPANY, name: 'Other fixture agent', status: 'running', adapterType: 'codex_local', lastHeartbeatAt: NOW },
];
const task = {
  id: TASK, companyId: COMPANY, identifier: 'TEST-1', title: 'Fixture task', description: `Test only ${CANARY}`,
  projectId: PROJECT, assigneeAgentId: AGENT, status: 'todo', updatedAt: NOW, executionRunId: ACTIVITY_RUN,
};
const secondTask = { ...task, id: SECOND_TASK, identifier: 'TEST-2', title: 'Second fixture task' };
const linkedRun = {
  id: RUN, companyId: COMPANY, agentId: AGENT, status: 'running', startedAt: NOW,
  updatedAt: NOW, invocationSource: 'issue', contextSnapshot: { issueId: TASK },
  livenessState: 'active', lastUsefulActionAt: NOW, error: CANARY,
};
const nativeRun = {
  id: NATIVE_RUN, companyId: COMPANY, agentId: AGENT, status: 'succeeded', startedAt: NOW,
  finishedAt: NOW, updatedAt: NOW, invocationSource: 'timer', nativeIssueId: TASK, contextSnapshot: {},
};
const timerRun = {
  id: TIMER, companyId: COMPANY, agentId: AGENT, status: 'succeeded', startedAt: OLD,
  finishedAt: OLD, updatedAt: OLD, invocationSource: 'timer', contextSnapshot: {},
};
const otherRun = {
  id: OTHER_RUN, companyId: COMPANY, agentId: OTHER_AGENT, status: 'running',
  startedAt: NOW, updatedAt: NOW, invocationSource: 'timer', contextSnapshot: {},
};
const retryRun = {
  id: RETRY, companyId: COMPANY, agentId: AGENT, status: 'scheduled_retry',
  startedAt: OLD, updatedAt: NOW, contextSnapshot: { taskId: TASK },
};
const activityLinkedRun = {
  id: ACTIVITY_RUN, companyId: COMPANY, agentId: AGENT, status: 'succeeded',
  startedAt: NOW, finishedAt: NOW, updatedAt: NOW, invocationSource: 'timer', contextSnapshot: {},
};
const comments = [
  { id: COMMENT_NEW, companyId: COMPANY, issueId: TASK, body: `Newest progress ${CANARY}`, createdAt: NOW },
  { id: COMMENT_MIDDLE, companyId: COMPANY, issueId: TASK, body: 'Middle progress', createdAt: NOW },
  { id: COMMENT_OLD, companyId: COMPANY, issueId: TASK, body: 'Old progress', createdAt: OLD },
];
const documents = [
  { id: DOCUMENT_NEW, companyId: COMPANY, issueId: TASK, key: 'candidate-register', title: 'Candidate register', updatedAt: NOW, latestRevisionNumber: 2, body: CANARY },
  { id: DOCUMENT_OLD, companyId: COMPANY, issueId: TASK, key: 'old-checkpoint', title: 'Old checkpoint', updatedAt: OLD, latestRevisionNumber: 1, body: 'Old body' },
];
const mockRequests = [];
let injectSecretError = false;
let injectSlowHealth = false;
let injectRunOverflow = false;
let injectLiveOverflow = false;
let injectLargeComments = false;
let allowMockWrites = false;
let injectedIssueWriteError = null;
let goalRevision = 7;
const goalResponses = new Map();
let recoveryActive = true;
let currentTaskStatus = 'todo';
let recoveryResolvedResponse;
const conditionalCommentResponses = new Map();
let mockAppliedWrites = 0;
const mock = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let body;
  if (req.method !== 'GET') {
    const raw = await Array.fromAsync(req).then(chunks => Buffer.concat(chunks).toString('utf8'));
    body = raw ? JSON.parse(raw) : undefined;
  }
  mockRequests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), ifNoneMatch: req.headers['if-none-match'] || null, body });
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    if (injectedIssueWriteError && req.method === 'POST' && url.pathname === `/api/issues/${TASK}/comments`) {
      res.statusCode = injectedIssueWriteError.status;
      res.end(JSON.stringify(injectedIssueWriteError.body));
      return;
    }
    if (!allowMockWrites) {
      res.statusCode = 405;
      res.end(JSON.stringify({ error: 'Mock write test is not enabled' }));
      return;
    }
    let result;
    if (req.method === 'POST' && url.pathname === `/api/issues/${TASK}/runner-goal/actions`) {
      if (goalResponses.has(body.requestId)) result = goalResponses.get(body.requestId);
      else if (body.agentId !== AGENT || body.expectedRevision !== goalRevision) {
        res.statusCode = 409;
        result = { code: 'runner_goal_conflict' };
      } else {
        goalRevision++;
        mockAppliedWrites++;
        result = { requestId: body.requestId, status: 'applied', projection: { revision: goalRevision } };
        goalResponses.set(body.requestId, result);
      }
    } else if (req.method === 'POST' && url.pathname === `/api/issues/${TASK}/comments/conditional`) {
      const prior = conditionalCommentResponses.get(body.clientRequestId);
      if (prior) {
        if (prior.body !== body.body) {
          res.statusCode = 409;
          result = { code: 'comment_request_conflict' };
        } else result = { ...prior.result, replayed: true };
      } else if (body.expectedIssueUpdatedAt !== NOW) {
        res.statusCode = 409;
        result = { code: 'issue_comment_checkpoint_stale' };
      } else {
        mockAppliedWrites++;
        result = { id: COMMENT_OLD, issueId: TASK, createdAt: NOW, replayed: false };
        conditionalCommentResponses.set(body.clientRequestId, { body: body.body, result });
      }
    } else if (req.method === 'POST' && url.pathname === `/api/issues/${TASK}/scheduled-retry/retry-now`) {
      if (retryRun.status === 'scheduled_retry') {
        retryRun.status = 'queued';
        mockAppliedWrites++;
        result = { outcome: 'promoted', scheduledRetry: { runId: RETRY } };
      } else result = { outcome: 'already_promoted', scheduledRetry: { runId: RETRY } };
    } else if (req.method === 'PATCH' && url.pathname === `/api/issues/${TASK}`) {
      if (body.status !== 'todo' || body.resume !== true || body.interrupt !== undefined || typeof body.comment !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.commentClientRequestId || '')) {
        res.statusCode = 400;
        result = { code: 'invalid_continuation_payload' };
      } else {
        mockAppliedWrites++;
        currentTaskStatus = 'todo';
        result = { ...task, status: currentTaskStatus };
      }
    } else if (req.method === 'PATCH' && url.pathname === `/api/agents/${AGENT}`) {
      mockAppliedWrites++;
      result = { ...agents[0], updatedAt: '2026-10-02T12:01:00.000Z', runtimeConfig: body.runtimeConfig };
    } else if (req.method === 'PATCH' && url.pathname === `/api/agents/${AGENT}/heartbeat-timer`) {
      if (body.expectedUpdatedAt !== NOW || JSON.stringify(body.expectedRuntimeConfig) !== JSON.stringify(agents[0].runtimeConfig)) {
        res.statusCode = 409;
        result = { code: 'agent_config_stale' };
      } else {
        mockAppliedWrites++;
        result = { ...agents[0], updatedAt: '2026-10-02T12:02:00.000Z', runtimeConfig: { ...agents[0].runtimeConfig, heartbeat: { ...agents[0].runtimeConfig.heartbeat, enabled: body.enabled, ...(body.intervalSec === undefined ? {} : { intervalSec: body.intervalSec }) } } };
      }
    } else if (req.method === 'POST' && url.pathname === `/api/issues/${TASK}/recovery-actions/resolve`) {
      if (!recoveryActive && body.actionId === ACTION) result = recoveryResolvedResponse;
      else if (!recoveryActive || body.actionId !== ACTION) {
        res.statusCode = 409;
        result = { code: 'recovery_action_conflict' };
      } else {
        recoveryActive = false;
        currentTaskStatus = body.sourceIssueStatus;
        mockAppliedWrites++;
        result = { issue: { ...task, status: currentTaskStatus }, recoveryAction: { id: ACTION, status: 'resolved', outcome: body.outcome, resolvedAt: NOW } };
        recoveryResolvedResponse = result;
      }
    }
    else { res.statusCode = 404; result = { error: 'Missing mock write route', path: url.pathname }; }
    res.end(JSON.stringify(result));
    return;
  }
  if (injectSlowHealth && url.pathname === '/api/health') await new Promise(resolve => setTimeout(resolve, 700));
  if (injectSecretError && url.pathname === '/api/health') {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: `fixture failure ${CANARY}`, apiKey: CANARY, detail: { token: CANARY } }));
    return;
  }
  const p = url.pathname;
  let result;
  if (p === '/api/health') result = { status: 'ok', version: 'fixture', deploymentMode: 'local_trusted' };
  else if (p === `/api/companies/${COMPANY}`) result = { id: COMPANY, name: 'Fixture company' };
  else if (p === `/api/companies/${COMPANY}/dashboard`) result = { companyId: COMPANY, agentCount: 2, issueCount: 1 };
  else if (p === `/api/companies/${COMPANY}/agents`) result = agents;
  else if (p === `/api/companies/${COMPANY}/monitor-snapshot`) {
    if (url.searchParams.get('issueIds') !== TASK) { res.statusCode = 400; result = { code: 'unexpected_issue_filter' }; }
    else result = { asOf: NOW, issues: [{ id: TASK, companyId: COMPANY, status: 'in_progress', assigneeAgentId: AGENT }], agents: [{ id: AGENT, companyId: COMPANY, status: 'running' }], runs: [{ id: RUN, companyId: COMPANY, agentId: AGENT, status: 'running' }, { id: RETRY, companyId: COMPANY, agentId: AGENT, status: 'scheduled_retry' }], genericRuns: [], latestComments: [{ id: COMMENT_NEW, issueId: TASK, createdAt: NOW }], documents: [], recoveryActions: [], hasMoreIssues: false, nextIssueId: null, coverage: { activityOnlyRunLinksIncluded: false, allRequestedIssuesIncluded: true } };
  }
  else if (p === `/api/companies/${COMPANY}/heartbeat-runs/page`) {
    if (url.searchParams.get('issueId') !== TASK) { res.statusCode = 400; result = { code: 'unexpected_issue_filter' }; }
    else result = { items: url.searchParams.has('cursor') ? [] : [{ id: RUN, companyId: COMPANY, agentId: AGENT, status: 'running' }], nextCursor: url.searchParams.has('cursor') ? null : 'opaque-next', coverage: { activityOnlyRunLinksIncluded: false } };
  }
  else if (p === `/api/companies/${COMPANY}/changes`) {
    if (url.searchParams.get('start') === 'latest') result = { items: [], nextCursor: 'head-cursor', hasMore: false };
    else if (url.searchParams.get('cursor') === 'head-cursor') result = { items: [{ seq: '42', entityType: 'issue', entityId: TASK, operation: 'update' }], nextCursor: 'next-cursor', hasMore: false };
    else if (url.searchParams.get('cursor') === 'expired-cursor') { res.statusCode = 410; result = { code: 'CHANGE_CURSOR_EXPIRED', latestCursor: 'new-head' }; }
    else { res.statusCode = 400; result = { code: 'unexpected_cursor' }; }
  }
  else if (p === `/api/agents/${AGENT}`) result = agents[0];
  else if (p === `/api/agents/${OTHER_AGENT}`) result = agents[1];
  else if (p === `/api/projects/${PROJECT}`) result = { id: PROJECT, companyId: COMPANY, name: 'Fixture project' };
  else if (p === '/api/instance/scheduler-heartbeats') result = [{ id: AGENT, companyId: COMPANY, schedulerActive: true, heartbeatEnabled: true, intervalSec: 60 }];
  else if (p === `/api/agents/${AGENT}/runtime-state`) result = { agentId: AGENT, companyId: COMPANY, activeRunId: RUN, nextWakeAt: NOW, status: 'running' };
  else if (p === `/api/agents/${AGENT}/sessions`) result = [];
  else if (p === `/api/agents/${AGENT}/task-sessions`) result = [];
  else if (p === `/api/companies/${COMPANY}/heartbeat-runs`) {
    const olderRun = { ...timerRun, id: '70000000-0000-4000-8000-000000000101', startedAt: '2026-09-28T12:00:00.000Z', updatedAt: NOW };
    const overflowRows = Array.from({ length: 100 }, (_, index) => ({ ...timerRun, id: `70000000-0000-4000-8000-${String(index).padStart(12, '0')}` }));
    // The backend orders by createdAt. A run older than page 1 can still change recently.
    const rows = (injectRunOverflow ? [...overflowRows, olderRun] : [linkedRun, activityLinkedRun, nativeRun, retryRun, timerRun, otherRun])
      .filter(r => !url.searchParams.has('agentId') || r.agentId === url.searchParams.get('agentId'));
    result = rows.slice(0, Number(url.searchParams.get('limit') || 100));
  } else if (p === `/api/companies/${COMPANY}/live-runs`) {
    // Deliberately global ordering. Filtering after limit=1 would falsely hide AGENT.
    const rows = injectLiveOverflow
      ? [...Array.from({ length: 50 }, (_, index) => ({ ...otherRun, id: `60000000-0000-4000-8000-${String(index).padStart(12, '0')}` })), linkedRun]
      : [otherRun, linkedRun];
    result = rows.slice(0, Math.min(50, Number(url.searchParams.get('limit') || 50)));
  } else if (p === `/api/heartbeat-runs/${RUN}`) result = linkedRun;
  else if (p === `/api/heartbeat-runs/${NATIVE_RUN}`) result = nativeRun;
  else if (p === `/api/heartbeat-runs/${TIMER}`) result = timerRun;
  else if (p === `/api/heartbeat-runs/${OTHER_RUN}`) result = otherRun;
  else if (p === `/api/heartbeat-runs/${ACTIVITY_RUN}`) result = activityLinkedRun;
  else if (p === `/api/heartbeat-runs/${RETRY}`) result = retryRun;
  else if (p === `/api/heartbeat-runs/${RUN}/events`) {
    const rows = [
      { id: 1, companyId: COMPANY, runId: RUN, seq: 1, eventType: 'lifecycle', message: `${'X'.repeat(160000)}${CANARY}`, payload: { privateText: `${'Y'.repeat(160000)}${CANARY}` }, createdAt: NOW },
      { id: 2, companyId: COMPANY, runId: RUN, seq: 2, eventType: 'lifecycle', message: 'Done', payload: { privateText: `${'Y'.repeat(160000)}${CANARY}` }, createdAt: NOW },
    ];
    result = rows.filter(row => row.seq > Number(url.searchParams.get('afterSeq') || 0)).slice(0, Number(url.searchParams.get('limit') || 50));
  }
  else if (p === `/api/heartbeat-runs/${RUN}/log`) result = { runId: RUN, content: 'fixture log', nextOffset: 11 };
  else if (p === `/api/companies/${COMPANY}/issues`) {
    const matches = (!url.searchParams.has('projectId') || url.searchParams.get('projectId') === PROJECT)
      && (!url.searchParams.has('assigneeAgentId') || url.searchParams.get('assigneeAgentId') === AGENT);
    const cursorMode = url.searchParams.get('sortField') === 'id' && url.searchParams.get('sortDir') === 'asc';
    const etag = cursorMode && url.searchParams.has('afterId') ? '"fixture-issues-page2"' : '"fixture-issues-page1"';
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) { res.statusCode = 304; res.end(); return; }
    const rows = matches ? (cursorMode ? [task, secondTask] : [task]) : [];
    const afterId = url.searchParams.get('afterId');
    result = rows.filter(row => !afterId || row.id > afterId).slice(0, Number(url.searchParams.get('limit') || 100));
  } else if (p === `/api/issues/${TASK}`) result = { ...task, status: currentTaskStatus };
  else if (p === `/api/issues/${TASK}/comments`) {
    const afterId = url.searchParams.get('afterCommentId');
    const start = afterId ? comments.findIndex(c => c.id === afterId) + 1 : 0;
    result = injectLargeComments ? [{ ...comments[0], body: `${'X'.repeat(160000)}${CANARY}` }] : comments.slice(start, start + Number(url.searchParams.get('limit') || 100));
  } else if (p === `/api/issues/${TASK}/heartbeat-runs` || p === `/api/issues/${TASK}/runs`) result = [linkedRun, activityLinkedRun, nativeRun];
  else if (p === `/api/issues/${TASK}/live-runs`) result = [linkedRun];
  else if (p === `/api/issues/${TASK}/execution`) result = { issueId: TASK, runId: RUN, execution: { phase: 'running', lastConfirmedActivityAt: NOW } };
  else if (p === `/api/issues/${TASK}/recovery-actions`) result = { active: recoveryActive ? { id: ACTION, status: 'active', type: 'stalled_run' } : null, actions: [{ id: ACTION, status: recoveryActive ? 'active' : 'resolved', type: 'stalled_run' }] };
  else if (p === `/api/issues/${TASK}/wakeup-diagnostics` || p === `/api/issues/${TASK}/diagnostics/wakes`) result = { issueId: TASK, nextWakeAt: NOW, diagnosis: 'active' };
  else if (p === `/api/issues/${TASK}/blockers` || p === `/api/issues/${TASK}/diagnostics/blockers`) result = { readiness: 'ready', blockers: [] };
  else if (p === `/api/issues/${TASK}/queued-comments`) result = { state: 'empty', revision: 1, entries: [] };
  else if (p === `/api/issues/${TASK}/runner-goal`) result = { capability: 'supported', workingNow: true, activeRunId: RUN, revision: goalRevision, observedAt: NOW };
  else if (p === `/api/issues/${TASK}/interactions`) result = [];
  else if (p === `/api/issues/${TASK}/activity`) result = [];
  else if (p === `/api/issues/${TASK}/documents`) result = documents;
  else if (p === `/api/issues/${TASK}/work-products`) result = [];
  else if (p === `/api/issues/${TASK}/thread-interactions`) result = [];
  else if (p === `/api/companies/${COMPANY}/audit`) result = { events: [], nextCursor: null };
  else {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Missing fixture route', path: p }));
    return;
  }
  res.end(JSON.stringify(result));
});

function hasId(value, id) { return JSON.stringify(value).includes(id); }
function tool(catalog, name, expectedReadOnlyHint) {
  const entry = catalog.find(t => t.name === name);
  assert.ok(entry, `Missing MCP tool ${name}`);
  if (expectedReadOnlyHint !== undefined) {
    assert.equal(entry.annotations?.readOnlyHint, expectedReadOnlyHint, `${name} has an incorrect readOnlyHint`);
    if (!expectedReadOnlyHint) assert.equal(entry.annotations?.destructiveHint, false, `${name} is a GET but is incorrectly marked destructive`);
  }
  return entry;
}
function writeTool(catalog, name, idempotent) {
  const entry = catalog.find(t => t.name === name);
  assert.ok(entry, `Missing MCP tool ${name}`);
  assert.equal(entry.annotations?.readOnlyHint, false, `${name} must be marked as a write`);
  assert.equal(entry.annotations?.idempotentHint, idempotent, `${name} idempotence hint is wrong`);
  return entry;
}
function assertBounded(value, limit, label) {
  const rows = Array.isArray(value) ? value : value?.comments || value?.items || value?.events || value?.runs;
  if (rows) assert.ok(rows.length <= limit, `${label} returned ${rows.length}, limit ${limit}`);
}

await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
const mockOrigin = `http://127.0.0.1:${mock.address().port}`;
const client = connect(mockOrigin);
let catalog;
try {
  const prematureList = await client.request('tools/list');
  const prematureCall = await client.request('tools/call', { name: 'paperclip_health', arguments: {} });
  assert.ok(prematureList.error, 'tools/list must be refused before initialize');
  assert.ok(prematureCall.error, 'tools/call must be refused before initialize');
  assert.equal(mockRequests.length, 0, 'Pre-initialize tool requests reached Paperclip');
  const init = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'supervision-test', version: '1' } });
  assert.equal(init.result?.protocolVersion, '2025-06-18');
  const beforeInitializedNotification = await client.request('tools/list');
  assert.ok(beforeInitializedNotification.error, 'tools/list must wait for notifications/initialized');
  client.notify('notifications/initialized');
  catalog = (await client.request('tools/list')).result.tools;
  assert.equal(catalog.length, 43);
  tool(catalog, 'paperclip_bridge_metrics', true);
  tool(catalog, 'paperclip_server_snapshot', true);
  tool(catalog, 'paperclip_server_run_page', true);
  tool(catalog, 'paperclip_server_changes', true);

  const readOnlyClient = connect(mockOrigin, { allowWrites: false });
  try {
    const readOnlyInit = await readOnlyClient.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'read-only-catalog-test', version: '1' } });
    assert.equal(readOnlyInit.result?.protocolVersion, '2025-06-18');
    readOnlyClient.notify('notifications/initialized');
    const readOnlyCatalog = (await readOnlyClient.request('tools/list')).result.tools;
    assert.ok(readOnlyCatalog.some(entry => entry.name === 'paperclip_health'), 'Default catalog lost read tools');
    for (const name of ['paperclip_create_task', 'paperclip_pause_agent', 'paperclip_continue_task', 'paperclip_resolve_recovery', 'paperclip_manage_agents_bulk']) {
      assert.ok(!readOnlyCatalog.some(entry => entry.name === name), `Default catalog exposed write tool ${name}`);
    }
  } finally { await readOnlyClient.stop(); }

  const unknownCompanyClient = connect(mockOrigin, { companyId: UNKNOWN_COMPANY });
  try {
    const unknownInit = await unknownCompanyClient.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'unknown-company-test', version: '1' } });
    assert.equal(unknownInit.result?.protocolVersion, '2025-06-18');
    unknownCompanyClient.notify('notifications/initialized');
    const unavailable = await unknownCompanyClient.request('tools/call', { name: 'paperclip_health', arguments: {} });
    assert.equal(unavailable.result?.isError, true, 'Health accepted a nonexistent configured company');
    assert.match(unavailable.result.content?.[0]?.text || '', /HTTP 404/);
    assert.ok(mockRequests.some(row => row.path === `/api/companies/${UNKNOWN_COMPANY}`), 'Health did not check the configured company');
  } finally { await unknownCompanyClient.stop(); }

  const legacyClient = connect(mockOrigin);
  try {
    const legacyInit = await legacyClient.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'legacy-client-test', version: '1' } });
    assert.equal(legacyInit.result?.protocolVersion, '2025-03-26');
    legacyClient.notify('notifications/initialized');
    const legacyHealth = await legacyClient.request('tools/call', { name: 'paperclip_health', arguments: {} });
    assert.equal(legacyHealth.result?.isError, undefined);
    assert.equal(legacyHealth.result?.structuredContent, undefined, 'Older MCP version received structuredContent');
    const legacyText = legacyHealth.result?.content?.find(part => part.type === 'text')?.text;
    assert.equal(JSON.parse(legacyText).data.companyId, COMPANY, 'Older MCP version lost its text result');
  } finally { await legacyClient.stop(); }

  injectSlowHealth = true;
  let slowFinished = false;
  const slow = client.call('paperclip_health').then(result => { slowFinished = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 30));
  const [ping, dashboard] = await Promise.all([client.request('ping'), client.call('paperclip_dashboard')]);
  assert.deepEqual(ping.result, {});
  assert.equal(dashboard.companyId, COMPANY);
  assert.equal(slowFinished, false, 'A slow GET blocked an unrelated ping/dashboard call');
  assert.equal((await slow).status, 'ok');
  injectSlowHealth = false;

  injectSecretError = true;
  const error = await client.request('tools/call', { name: 'paperclip_health', arguments: {} });
  assert.equal(error.result?.isError, true);
  assert.ok(!JSON.stringify(error).includes(CANARY), 'HTTP error leaked an API credential');
  injectSecretError = false;
  const metrics = await client.call('paperclip_bridge_metrics');
  assert.equal(metrics.processLocal, true);
  assert.ok(!JSON.stringify(metrics).includes(CANARY), 'Metrics included secret error content');
  const healthStats = metrics.tools.find(row => row.name === 'paperclip_health');
  assert.equal(healthStats?.calls, 2, 'Metrics lost a successful or failed health call');
  assert.equal(healthStats?.errors, 1, 'Metrics lost the intentional mock error');
  assert.equal(healthStats?.oversized, 0);
  assert.ok(Number.isFinite(healthStats.averageMs) && Number.isFinite(healthStats.p95RecentMs));
  const dashboardStats = metrics.tools.find(row => row.name === 'paperclip_dashboard');
  assert.equal(dashboardStats?.calls, 1, 'Metrics lost an ordinary mock call');
  assert.equal(dashboardStats?.errors, 0);

  const runs = await client.call('paperclip_list_runs', { limit: 3 });
  assert.ok(hasId(runs, TASK), 'run summary lost contextSnapshot.issueId');
  assert.ok(!JSON.stringify(runs).includes(CANARY), 'run summary returned raw error text');
  const run = await client.call('paperclip_get_run', { runId: RUN });
  assert.ok(hasId(run, TASK), 'run detail lost contextSnapshot.issueId');
  assert.ok(!JSON.stringify(run).includes(CANARY), 'run detail returned raw error text');
  const nativeLink = await client.call('paperclip_get_run', { runId: NATIVE_RUN });
  assert.equal(nativeLink.issueId, TASK, 'nativeIssueId was not reported');
  assert.equal(nativeLink.issueLinkSource, 'native_issue');
  const legacyLink = await client.call('paperclip_get_run', { runId: RETRY });
  assert.equal(legacyLink.issueId, TASK, 'legacy contextSnapshot.taskId was not reported');
  assert.equal(legacyLink.issueLinkSource, 'legacy_context_task');
  const timerLink = await client.call('paperclip_get_run', { runId: TIMER });
  assert.equal(timerLink.issueId, null, 'Generic timer was attributed to a task');
  assert.equal(timerLink.issueLinkSource, null);
  const provenancePage = await client.call('paperclip_list_runs', { limit: 5 });
  assert.equal(provenancePage.find(row => row.id === NATIVE_RUN)?.issueLinkSource, 'native_issue');
  assert.equal(provenancePage.find(row => row.id === TIMER)?.issueId, null);
  const firstEvents = await client.call('paperclip_run_events', { runId: RUN, limit: 1 });
  assert.equal(firstEvents.events.length, 1);
  assert.equal(firstEvents.events[0].seq, 1);
  assert.equal(firstEvents.nextAfterSeq, 1);
  assert.equal(firstEvents.pageFull, true);
  assert.equal(firstEvents.textIncluded, false);
  assert.equal(firstEvents.events[0].message, undefined, 'Default event response exposed message text');
  assert.equal(firstEvents.events[0].payload, undefined, 'Default event response exposed payload');
  assert.ok(!JSON.stringify(firstEvents).includes(CANARY), 'Large event leaked private text');
  const nextEvents = await client.call('paperclip_run_events', { runId: RUN, afterSeq: firstEvents.nextAfterSeq, limit: 1 });
  assert.equal(nextEvents.events[0].seq, 2);
  assert.equal(nextEvents.nextAfterSeq, 2);
  const messageExcerpt = await client.call('paperclip_run_events', { runId: RUN, limit: 1, includeText: true, maxTextChars: 100 });
  assert.equal(messageExcerpt.events[0].message.length, 100);
  assert.equal(messageExcerpt.events[0].messageTruncated, true);
  assert.equal(messageExcerpt.events[0].payloadTruncated, true);
  const payloadExcerpt = await client.call('paperclip_run_events', { runId: RUN, afterSeq: 1, limit: 1, includeText: true, maxTextChars: 100 });
  assert.ok(payloadExcerpt.events[0].payloadText.length <= 96);
  assert.equal(payloadExcerpt.events[0].payloadTruncated, true);
  assert.ok(!JSON.stringify([messageExcerpt, payloadExcerpt]).includes(CANARY), 'Bounded event excerpt included private tail');
  const live = await client.call('paperclip_list_runs', { liveOnly: true, agentId: AGENT, limit: 1 });
  assert.ok(hasId(live, RUN), 'live runs filtered only after global pagination');
  injectLiveOverflow = true;
  const inconclusiveLive = await client.request('tools/call', { name: 'paperclip_list_runs', arguments: { liveOnly: true, agentId: AGENT } });
  assert.equal(inconclusiveLive.result?.isError, true, 'full global live page falsely proved agent inactivity');
  injectLiveOverflow = false;

  await client.call('paperclip_list_tasks', { projectId: PROJECT, updatedSince: SINCE, limit: 1 });
  const listRequest = mockRequests.findLast(r => r.path === `/api/companies/${COMPANY}/issues`);
  assert.equal(listRequest.query.projectId, PROJECT);
  assert.equal(listRequest.query.updatedSince, SINCE);
  const sortedArgs = { sortField: 'id', sortDir: 'asc', limit: 1, withEtag: true };
  const firstPage = await client.call('paperclip_list_tasks', sortedArgs);
  assert.equal(firstPage.notModified, false);
  assert.equal(firstPage.etag, '"fixture-issues-page1"');
  assert.deepEqual(firstPage.items.map(row => row.id), [TASK]);
  const secondPage = await client.call('paperclip_list_tasks', { ...sortedArgs, afterId: TASK });
  assert.equal(secondPage.notModified, false);
  assert.deepEqual(secondPage.items.map(row => row.id), [SECOND_TASK]);
  const cursorRequest = mockRequests.findLast(r => r.path === `/api/companies/${COMPANY}/issues`);
  assert.equal(cursorRequest.query.sortField, 'id');
  assert.equal(cursorRequest.query.sortDir, 'asc');
  assert.equal(cursorRequest.query.afterId, TASK);
  const cachedPage = await client.call('paperclip_list_tasks', { ...sortedArgs, ifNoneMatch: firstPage.etag });
  assert.equal(cachedPage.notModified, true);
  assert.equal(cachedPage.etag, firstPage.etag);
  assert.deepEqual(cachedPage.items, []);
  const conditionalRequest = mockRequests.findLast(r => r.path === `/api/companies/${COMPANY}/issues`);
  assert.equal(conditionalRequest.ifNoneMatch, firstPage.etag);
  const page = await client.call('paperclip_task_comments', { taskId: TASK, limit: 2 });
  assertBounded(page, 2, 'comments page');
  const commentRequest = mockRequests.findLast(r => r.path === `/api/issues/${TASK}/comments`);
  assert.equal(commentRequest.query.limit, '2');
  const olderPage = await client.call('paperclip_task_comments', { taskId: TASK, limit: 2, afterCommentId: COMMENT_MIDDLE });
  assert.ok(hasId(olderPage, COMMENT_OLD), 'comment cursor did not reach the older page');
  injectLargeComments = true;
  const oversize = await client.request('tools/call', { name: 'paperclip_task_comments', arguments: { taskId: TASK, limit: 1 } });
  assert.equal(oversize.result?.isError, true, 'oversized output must not look like a complete success');
  assert.equal(oversize.result?.structuredContent, undefined, 'oversized output returned partial structured data');
  assert.ok(!JSON.stringify(oversize).includes(CANARY), 'oversized output leaked a private preview');
  injectLargeComments = false;

  for (const name of [
    'paperclip_run_lineage', 'paperclip_monitor_snapshot', 'paperclip_changes_since',
    'paperclip_run_diagnostic', 'paperclip_new_comments',
  ]) tool(catalog, name);

  const lineage = await client.call('paperclip_run_lineage', { taskId: TASK, agentId: AGENT, limit: 5 });
  assert.ok(hasId(lineage, RUN), 'lineage lost the explicitly linked run');
  assert.ok(hasId(lineage.linkedRuns, ACTIVITY_RUN), 'lineage lost run linked by issue activity');
  assert.ok(hasId(lineage.linkedRuns, NATIVE_RUN), 'lineage lost native issue link');
  assert.ok(!hasId(lineage.unattributedAgentRuns, NATIVE_RUN), 'native-linked run was classified as generic');
  assert.ok(!hasId(lineage.unattributedAgentRuns, ACTIVITY_RUN), 'activity-linked run also appeared as unattributed');
  assert.ok(hasId(lineage, TIMER), 'lineage lost the generic timer run');
  assert.ok(hasId(lineage, TASK), 'lineage lost explicit task provenance');
  assert.ok(hasId(lineage.unattributedAgentRuns, TIMER), 'generic timer was attributed to a task');
  assert.ok(!hasId(lineage.linkedRuns, TIMER), 'generic timer appeared in linked runs');

  const snapshot = await client.call('paperclip_monitor_snapshot', { taskIds: [TASK] });
  assert.ok(hasId(snapshot, TASK), 'snapshot lost requested task');
  assert.ok(hasId(snapshot, RUN), 'snapshot lost active execution');
  assert.ok(hasId(snapshot.tasks?.[0]?.linkedRecentRuns, ACTIVITY_RUN), 'snapshot lost executionRunId link');
  assert.ok(hasId(snapshot.tasks?.[0]?.linkedScheduledRetries, RETRY), 'snapshot lost a task-linked scheduled retry');
  assert.equal(snapshot.coverage.liveRunApiExcludesScheduledRetry, true, 'snapshot must disclose live-run API coverage');
  assert.ok(!hasId(snapshot.agents?.[0]?.recentUnattributedRuns, ACTIVITY_RUN), 'snapshot also classified an execution-linked run as generic');
  assert.ok(!hasId(snapshot, OTHER_RUN), 'snapshot included an unrelated agent run');
  assert.ok(!JSON.stringify(snapshot).includes(CANARY), 'snapshot returned raw task, run or adapter secrets');

  const nativeSnapshot = await client.call('paperclip_server_snapshot', { taskIds: [TASK] });
  assert.equal(nativeSnapshot.source, 'native_server');
  assert.equal(nativeSnapshot.issues?.[0]?.id, TASK);
  assert.equal(nativeSnapshot.coverage?.activityOnlyRunLinksIncluded, false);
  assert.ok(!JSON.stringify(nativeSnapshot).includes(CANARY), 'native snapshot returned raw private content');
  const nativeRunPage = await client.call('paperclip_server_run_page', { taskId: TASK, limit: 1 });
  assert.equal(nativeRunPage.source, 'native_server');
  assert.equal(nativeRunPage.items?.[0]?.id, RUN);
  assert.equal(nativeRunPage.nextCursor, 'opaque-next');
  const nativeRunNext = await client.call('paperclip_server_run_page', { taskId: TASK, cursor: nativeRunPage.nextCursor, limit: 1 });
  assert.deepEqual(nativeRunNext.items, []);
  const head = await client.call('paperclip_server_changes', { startLatest: true });
  assert.equal(head.nextCursor, 'head-cursor');
  const nativeChanges = await client.call('paperclip_server_changes', { cursor: head.nextCursor });
  assert.deepEqual(nativeChanges.items, [{ seq: '42', entityType: 'issue', entityId: TASK, operation: 'update' }]);
  assert.equal(nativeChanges.nextCursor, 'next-cursor');
  await assert.rejects(client.call('paperclip_server_changes', { cursor: 'expired-cursor' }), /cursor expired/i);
  await assert.rejects(client.call('paperclip_server_changes', { cursor: 'head-cursor', startLatest: true }), /exactly one/i);

  const changes = await client.call('paperclip_changes_since', { taskIds: [TASK], since: SINCE });
  assert.ok(hasId(changes, TASK), 'changes omitted the updated task');
  assert.ok(hasId(changes, COMMENT_NEW), 'changes omitted a recent comment');
  assert.ok(!hasId(changes, COMMENT_OLD), 'changes included an older comment');
  assert.ok(hasId(changes, DOCUMENT_NEW), 'changes omitted a recent document');
  assert.ok(!hasId(changes, DOCUMENT_OLD), 'changes included an older document');
  assert.ok(!JSON.stringify(changes).includes(CANARY), 'changes returned raw comment text');
  assert.ok(Number.isFinite(Date.parse(changes.nextSince)), 'changes omitted a usable nextSince');
  injectRunOverflow = true;
  const overflow = await client.call('paperclip_changes_since', { taskIds: [TASK], since: SINCE });
  assert.equal(overflow.coverage.potentiallyTruncated, true, 'full createdAt run page can hide older recently updated runs');
  injectRunOverflow = false;

  const diagnostic = await client.call('paperclip_run_diagnostic', { runId: RUN });
  assert.ok(hasId(diagnostic, RUN), 'run diagnostic omitted run identity');
  assert.ok(hasId(diagnostic, TASK), 'run diagnostic omitted explicit task context');
  assert.ok(!JSON.stringify(diagnostic).includes(CANARY), 'run diagnostic returned raw error text');
  const activityDiagnostic = await client.call('paperclip_run_diagnostic', { runId: ACTIVITY_RUN, taskId: TASK });
  assert.ok(hasId(activityDiagnostic, ACTIVITY_RUN), 'diagnostic rejected an issue-activity linked run');

  if (catalog.some(t => t.name === 'paperclip_batch_get_tasks')) {
    tool(catalog, 'paperclip_batch_get_tasks');
    assert.ok(hasId(await client.call('paperclip_batch_get_tasks', { taskIds: [TASK] }), TASK));
  }
  const fresh = await client.call('paperclip_new_comments', { taskId: TASK, lastSeenCommentId: COMMENT_OLD, limit: 2, includeBody: false });
  assert.ok(hasId(fresh, COMMENT_NEW) && hasId(fresh, COMMENT_MIDDLE), 'new comments omitted recent rows');
  assert.ok(!hasId(fresh, COMMENT_OLD), 'new comments repeated last seen row');
  assertBounded(fresh, 2, 'new comments');
  assert.ok(!JSON.stringify(fresh).includes('Newest progress'), 'new comments returned bodies when includeBody=false');
  assert.equal(fresh.newestCommentId, COMMENT_NEW, 'newestCommentId must point to the newest comment');
  if (fresh.complete === false) {
    assert.ok(fresh.nextOlderCommentId, 'incomplete comments page omitted its continuation cursor');
    const commentTool = tool(catalog, 'paperclip_new_comments');
    const cursorArg = ['afterCommentId', 'cursor'].find(key => Object.hasOwn(commentTool.inputSchema.properties, key));
    assert.ok(cursorArg, 'paperclip_new_comments emitted a cursor it cannot accept on the next call');
    const continuation = await client.call('paperclip_new_comments', {
      taskId: TASK, lastSeenCommentId: COMMENT_OLD, limit: 2, includeBody: false,
      [cursorArg]: fresh.nextOlderCommentId,
    });
    assert.equal(continuation.reachedLastSeen, true, 'comment continuation did not reach lastSeenCommentId');
  }
  if (catalog.some(t => t.name === 'paperclip_run_tail')) {
    tool(catalog, 'paperclip_run_tail');
    assert.ok(await client.call('paperclip_run_tail', { runId: RUN, limitBytes: 32 }));
  }
  if (catalog.some(t => t.name === 'paperclip_agent_schedule_state')) {
    tool(catalog, 'paperclip_agent_schedule_state');
    assert.ok(hasId(await client.call('paperclip_agent_schedule_state', { agentId: AGENT }), AGENT));
  }
  if (catalog.some(t => t.name === 'paperclip_checkpoint_index')) {
    tool(catalog, 'paperclip_checkpoint_index');
    await client.call('paperclip_checkpoint_index', { taskIds: [TASK] });
  }
  if (catalog.some(t => t.name === 'paperclip_issue_activity')) {
    tool(catalog, 'paperclip_issue_activity');
    assertBounded(await client.call('paperclip_issue_activity', { taskId: TASK, limit: 2 }), 2, 'issue activity');
  }
  if (catalog.some(t => t.name === 'paperclip_inspect_recovery')) {
    tool(catalog, 'paperclip_inspect_recovery');
    await client.call('paperclip_inspect_recovery', { taskId: TASK });
  }
  assert.ok(mockRequests.every(r => r.method === 'GET'), 'Read-only mock phase issued a write');

  for (const [name, idempotent] of [
    ['paperclip_runner_goal_action', true], ['paperclip_retry_scheduled', false],
    ['paperclip_set_agent_timer', false], ['paperclip_server_set_agent_timer', false], ['paperclip_resolve_recovery', true], ['paperclip_add_conditional_comment', true], ['paperclip_continue_task', false],
  ]) writeTool(catalog, name, idempotent);
  allowMockWrites = true;
  const deniedComment = () => client.request('tools/call', { name: 'paperclip_add_comment', arguments: { taskId: TASK, body: 'Fixture permission preflight' } });
  injectedIssueWriteError = {
    status: 403,
    body: { error: `Private error prose ${CANARY}`, code: CANARY, details: { code: 'issue_write_not_visible', boundary: `Spoofed ${CANARY}`, whoCanAct: CANARY, sanctionedPath: CANARY, apiKey: CANARY } },
  };
  let denied = await deniedComment();
  assert.equal(denied.result?.isError, true);
  assert.deepEqual(denied.result?.structuredContent?.error, {
    httpStatus: 403,
    code: 'issue_write_not_visible',
    boundary: 'Issue visibility',
    whoCanAct: 'An agent or board member who can read the task.',
    sanctionedPath: 'Ask a board member to grant visibility, or route the request through an authorized task.',
  });
  assert.ok(!JSON.stringify(denied).includes(CANARY), '403 projection leaked free-form error text or spoofed diagnostic fields');
  injectedIssueWriteError = {
    status: 403,
    body: { error: CANARY, details: { code: 'cross_issue_influence_run_context_required', sanctionedPath: CANARY } },
  };
  denied = await deniedComment();
  assert.equal(denied.result?.structuredContent?.error?.code, 'cross_issue_influence_run_context_required');
  assert.match(denied.result?.structuredContent?.error?.sanctionedPath, /X-Paperclip-Run-Id/);
  assert.ok(!JSON.stringify(denied).includes(CANARY), 'run-context 403 leaked server prose');
  for (const body of [
    { error: CANARY, code: CANARY, details: { code: 'deny_company_boundary', whoCanAct: CANARY } },
    { error: CANARY, details: { code: `issue_write_not_visible${CANARY}` } },
  ]) {
    injectedIssueWriteError = { status: 403, body };
    denied = await deniedComment();
    assert.equal(denied.result?.isError, true);
    assert.equal(denied.result?.structuredContent, undefined, 'unknown or malformed 403 gained a diagnostic');
    assert.ok(!JSON.stringify(denied).includes(CANARY), 'unknown 403 leaked free-form data');
  }
  injectedIssueWriteError = null;
  const mockWriteCount = () => mockRequests.filter(r => r.method !== 'GET').length;
  async function expectRejected(name, args, expectedExtraHttpWrites) {
    const before = mockWriteCount();
    const beforeApplied = mockAppliedWrites;
    const response = await client.request('tools/call', { name, arguments: args });
    assert.equal(response.result?.isError, true, `${name} should reject stale or incompatible state`);
    assert.equal(mockWriteCount(), before + expectedExtraHttpWrites, `${name} sent an unexpected number of HTTP writes`);
    assert.equal(mockAppliedWrites, beforeApplied, `${name} changed server state despite rejection`);
  }

  const goalArgs = { taskId: TASK, agentId: AGENT, requestId: 'fixture-goal-1', expectedRevision: 7, action: 'pause' };
  const goalResult = await client.call('paperclip_runner_goal_action', goalArgs);
  let write = mockRequests.filter(r => r.method !== 'GET').at(-1);
  assert.equal(write.path, `/api/issues/${TASK}/runner-goal/actions`);
  assert.equal(write.method, 'POST');
  assert.deepEqual(write.body, { requestId: 'fixture-goal-1', agentId: AGENT, expectedRevision: 7, action: 'pause' });
  assert.deepEqual(await client.call('paperclip_runner_goal_action', goalArgs), goalResult, 'requestId replay changed result');
  assert.equal(mockAppliedWrites, 1, 'requestId replay applied the runner goal twice');
  await expectRejected('paperclip_runner_goal_action', { taskId: TASK, agentId: AGENT, requestId: 'fixture-goal-stale', expectedRevision: 6, action: 'pause' }, 1);
  await expectRejected('paperclip_runner_goal_action', { taskId: TASK, agentId: OTHER_AGENT, requestId: 'fixture-goal-other', expectedRevision: 8, action: 'pause' }, 1);

  await client.call('paperclip_retry_scheduled', { taskId: TASK, expectedRunId: RETRY });
  write = mockRequests.filter(r => r.method !== 'GET').at(-1);
  assert.equal(write.path, `/api/issues/${TASK}/scheduled-retry/retry-now`);
  assert.equal(write.method, 'POST');
  assert.deepEqual(write.body, { expectedRunId: RETRY });
  await expectRejected('paperclip_retry_scheduled', { taskId: TASK, expectedRunId: RUN }, 0);

  await client.call('paperclip_set_agent_timer', { agentId: AGENT, expectedUpdatedAt: NOW, enabled: false, intervalSec: 120 });
  write = mockRequests.filter(r => r.method !== 'GET').at(-1);
  assert.equal(write.path, `/api/agents/${AGENT}`);
  assert.equal(write.method, 'PATCH');
  assert.deepEqual(write.body, { runtimeConfig: { heartbeat: { enabled: false, intervalSec: 120, maxConcurrentRuns: 3 }, otherSetting: 'preserve-me' } });
  await expectRejected('paperclip_set_agent_timer', { agentId: AGENT, expectedUpdatedAt: OLD, enabled: false }, 0);
  const atomicTimer = await client.call('paperclip_server_set_agent_timer', { agentId: AGENT, expectedUpdatedAt: NOW, enabled: false, intervalSec: 120 });
  assert.equal(atomicTimer.compareAndSwap, true);
  write = mockRequests.filter(r => r.method !== 'GET').at(-1);
  assert.equal(write.path, `/api/agents/${AGENT}/heartbeat-timer`);
  assert.deepEqual(write.body, { expectedUpdatedAt: NOW, expectedRuntimeConfig: agents[0].runtimeConfig, enabled: false, intervalSec: 120 });
  await expectRejected('paperclip_server_set_agent_timer', { agentId: AGENT, expectedUpdatedAt: OLD, enabled: true }, 0);

  await expectRejected('paperclip_resolve_recovery', { taskId: TASK, actionId: ACTION, expectedCurrentStatus: 'done', outcome: 'blocked', sourceIssueStatus: 'blocked' }, 0);
  await expectRejected('paperclip_resolve_recovery', { taskId: TASK, actionId: ACTION, expectedCurrentStatus: 'todo', outcome: 'blocked', sourceIssueStatus: 'done' }, 0);
  const recoveryArgs = { taskId: TASK, actionId: ACTION, expectedCurrentStatus: 'todo', outcome: 'blocked', sourceIssueStatus: 'blocked', resolutionNote: 'Fixture resolution' };
  const recoveryResult = await client.call('paperclip_resolve_recovery', recoveryArgs);
  write = mockRequests.filter(r => r.method !== 'GET').at(-1);
  assert.equal(write.path, `/api/issues/${TASK}/recovery-actions/resolve`);
  assert.equal(write.method, 'POST');
  assert.deepEqual(write.body, { actionId: ACTION, outcome: 'blocked', sourceIssueStatus: 'blocked', resolutionNote: 'Fixture resolution' });
  assert.deepEqual(await client.call('paperclip_resolve_recovery', recoveryArgs), recoveryResult, 'actionId replay changed result');
  assert.equal(mockAppliedWrites, 5, 'actionId replay applied a recovery twice');
  await expectRejected('paperclip_resolve_recovery', { ...recoveryArgs, actionId: OTHER_AGENT }, 1);
  assert.equal(mockAppliedWrites, 5, 'Only the five distinct mock writes should change state');

  // The patched server accepts exact-ID replays. This mode must stay disabled
  // until deployment because the old server lacks both atomic preconditions.
  const atomicClient = connect(`http://127.0.0.1:${mock.address().port}`, { atomicManagement: true });
  try {
    const atomicInit = await atomicClient.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'atomic-replay-test', version: '1' } });
    assert.equal(atomicInit.result?.protocolVersion, '2025-06-18');
    atomicClient.notify('notifications/initialized');
    const beforeAtomicReplay = mockAppliedWrites;
    const retryReplay = await atomicClient.call('paperclip_retry_scheduled', { taskId: TASK, expectedRunId: RETRY });
    assert.equal(retryReplay.outcome, 'already_promoted');
    assert.equal(mockAppliedWrites, beforeAtomicReplay, 'Atomic retry replay applied a second write');
    assert.deepEqual(await atomicClient.call('paperclip_resolve_recovery', recoveryArgs), recoveryResult);
    write = mockRequests.filter(r => r.method !== 'GET').at(-1);
    assert.equal(write.path, `/api/issues/${TASK}/recovery-actions/resolve`);
    assert.equal(write.body.expectedCurrentStatus, 'todo', 'Atomic recovery omitted its server-side status precondition');
    assert.equal(mockAppliedWrites, beforeAtomicReplay, 'Atomic recovery replay applied a second write');
  } finally { await atomicClient.stop(); }
  const conditionalArgs = { taskId: TASK, clientRequestId: COMMENT_NEW, expectedIssueUpdatedAt: NOW, body: 'One sanitized monitoring instruction' };
  const conditionalFirst = await client.call('paperclip_add_conditional_comment', conditionalArgs);
  assert.equal(conditionalFirst.replayed, false);
  write = mockRequests.filter(r => r.method !== 'GET').at(-1);
  assert.equal(write.path, `/api/issues/${TASK}/comments/conditional`);
  assert.deepEqual(write.body, { clientRequestId: COMMENT_NEW, expectedIssueUpdatedAt: NOW, body: conditionalArgs.body });
  assert.equal((await client.call('paperclip_add_conditional_comment', conditionalArgs)).replayed, true);
  await expectRejected('paperclip_add_conditional_comment', { ...conditionalArgs, clientRequestId: COMMENT_MIDDLE, expectedIssueUpdatedAt: OLD }, 1);
  await expectRejected('paperclip_add_conditional_comment', { ...conditionalArgs, body: 'Different content' }, 1);
  assert.equal(mockAppliedWrites, 6, 'Conditional comment replay or conflict applied a second effect');
  const continuationArgs = { taskId: TASK, clientRequestId: COMMENT_MIDDLE, comment: 'Resume the bounded task from its last checkpoint.' };
  for (const invalid of [
    { taskId: TASK, comment: continuationArgs.comment },
    { ...continuationArgs, clientRequestId: 'not-a-uuid' },
    { ...continuationArgs, comment: '   ' },
    { ...continuationArgs, comment: 'X'.repeat(12001) },
  ]) await expectRejected('paperclip_continue_task', invalid, 0);
  currentTaskStatus = 'in_progress';
  await expectRejected('paperclip_continue_task', continuationArgs, 0);
  currentTaskStatus = 'blocked';
  const continuation = await client.call('paperclip_continue_task', continuationArgs);
  assert.equal(continuation.task.status, 'todo');
  assert.match(continuation.caveat, /side effects on a replay/);
  write = mockRequests.filter(r => r.method !== 'GET').at(-1);
  assert.equal(write.path, `/api/issues/${TASK}`);
  assert.equal(write.method, 'PATCH');
  assert.deepEqual(write.body, { status: 'todo', resume: true, comment: continuationArgs.comment, commentClientRequestId: continuationArgs.clientRequestId });
  assert.equal(mockAppliedWrites, 7, 'Continuation should have applied exactly one mock write');
  console.log(`PASS mock: ${catalog.length} tools; read supervision, secret handling, write guards and idempotent replays; mock HTTP writes=${mockWriteCount()}, applied=${mockAppliedWrites}, production writes=0`);
} finally {
  await client.stop();
  await new Promise(resolve => mock.close(resolve));
}
