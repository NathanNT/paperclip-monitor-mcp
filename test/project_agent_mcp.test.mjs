import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

// Deliberately nonexistent company: even a bridge that ignores the mock URL
// cannot create an object in the user's real Paperclip company.
const companyId = '7b3baa7d-2709-42ef-8cb2-13c8e177b284';
const otherCompanyId = 'e4120300-8b9c-48ca-87c5-612538731111';
const projectId = '6e59ee96-4a54-4bbb-8c8f-c8e02306ab11';
const agentId = '4e1f3f9b-aead-46cc-8112-136a78d09711';
const workspaceId = '96586baa-3cd5-4f4d-a405-5a0b5e668311';
const defaultScript = fileURLToPath(new URL('../paperclip-mcp.mjs', import.meta.url));
const script = path.resolve(process.env.PAPERCLIP_MCP_SCRIPT || defaultScript);

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

async function fixture(run) {
  assert.ok(existsSync(script), `MCP script missing: ${script}`);
  let handler = (_request, res) => json(res, 404, { error: 'Unexpected mock route' });
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    const request = {
      method: req.method,
      path: new URL(req.url, 'http://127.0.0.1').pathname,
      query: new URL(req.url, 'http://127.0.0.1').searchParams,
      body: body ? JSON.parse(body) : undefined,
    };
    requests.push(request);
    try { await handler(request, res); }
    catch (error) { json(res, 500, { error: String(error) }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');
  const child = spawn(process.execPath, [script], {
    cwd: path.dirname(script),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PAPERCLIP_API_URL: `http://127.0.0.1:${address.port}`,
      PAPERCLIP_COMPANY_ID: companyId,
      PAPERCLIP_ALLOW_WRITES: '1',
    },
  });
  let nextId = 1;
  let stdout = '';
  let stderr = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdout += chunk;
    let newline;
    while ((newline = stdout.indexOf('\n')) >= 0) {
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      if (!line.trim()) continue;
      const response = JSON.parse(line);
      const waiter = pending.get(response.id);
      if (!waiter) continue;
      pending.delete(response.id);
      clearTimeout(waiter.timer);
      waiter.resolve(response);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('exit', (code, signal) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`MCP exited (${code}, ${signal}): ${stderr}`));
    }
    pending.clear();
  });
  function rpc(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP ${method} timed out: ${stderr}`));
      }, 5000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  try {
    const initialized = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'paperclip-mock-test', version: '1' },
    });
    assert.ok(initialized.result, JSON.stringify(initialized));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return await run({
      requests,
      onRequest(next) { handler = next; },
      rpc,
      async call(name, args = {}) {
        const response = await rpc('tools/call', { name, arguments: args });
        assert.ok(response.result, JSON.stringify(response));
        return response.result;
      },
    });
  } finally {
    child.stdin.end();
    if (child.exitCode === null) child.kill();
    await new Promise(resolve => server.close(resolve));
  }
}

function data(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.ok(result.structuredContent?.data !== undefined, JSON.stringify(result));
  return result.structuredContent.data;
}

test('project and agent creation tools are exposed over MCP stdio', async () => {
  await fixture(async ({ rpc }) => {
    const response = await rpc('tools/list', {});
    const tools = response.result?.tools || [];
    for (const name of ['paperclip_list_projects', 'paperclip_create_project', 'paperclip_create_agent']) {
      assert.ok(tools.some(tool => tool.name === name), `${name} missing`);
    }
    const create = tools.find(tool => tool.name === 'paperclip_create_project');
    assert.ok(create.inputSchema.properties.idempotencyKey, 'project creation needs a stable idempotency key');
    assert.ok(create.inputSchema.required.includes('idempotencyKey'),
      'a missing idempotency key must fail before the HTTP write');
  });
});

test('project reads are company scoped and omit secret configuration', async () => {
  await fixture(async ({ onRequest, call }) => {
    onRequest((request, res) => {
      if (request.path === `/api/companies/${companyId}`) {
        json(res, 200, { id: companyId, name: 'Mock company' });
        return;
      }
      assert.equal(request.method, 'GET');
      assert.equal(request.path, `/api/companies/${companyId}/projects`);
      json(res, 200, [{
        id: projectId, companyId, name: 'ExampleProject', status: 'planned',
        description: 'Local analysis',
        env: { API_TOKEN: 'secret-project-env-value' },
        executionWorkspacePolicy: { runtimePolicy: { credential: 'secret-runtime-value' } },
      }]);
    });
    const projects = data(await call('paperclip_list_projects'));
    assert.match(JSON.stringify(projects), /ExampleProject/);
    assert.doesNotMatch(JSON.stringify(projects), /secret-project-env-value|secret-runtime-value|"env"/);
  });
});

test('foreign-company project rows fail closed', async () => {
  await fixture(async ({ onRequest, call, requests }) => {
    onRequest((request, res) => {
      if (request.path === `/api/companies/${companyId}`) {
        json(res, 200, { id: companyId, name: 'Mock company' });
        return;
      }
      json(res, 200, [{
        id: projectId, companyId: otherCompanyId, name: 'Foreign project', status: 'planned',
      }]);
    });
    const result = await call('paperclip_list_projects');
    assert.equal(requests.filter(request => request.path.endsWith('/projects')).length, 1,
      'the tool must reach the mock project API');
    assert.equal(result.isError, true);
    assert.doesNotMatch(JSON.stringify(result), /Foreign project/);
  });
});

test('project creation forwards the idempotency key and limits returned fields', async () => {
  await fixture(async ({ onRequest, call, requests }) => {
    onRequest((request, res) => {
      if (request.method === 'GET' && request.path === `/api/companies/${companyId}/projects`) {
        json(res, 200, []);
        return;
      }
      assert.equal(request.method, 'POST');
      assert.equal(request.path, `/api/companies/${companyId}/projects`);
      json(res, 201, {
        id: projectId, companyId, name: request.body.name, status: 'backlog',
        env: { API_TOKEN: 'secret-new-project-value' },
      });
    });
    const project = data(await call('paperclip_create_project', {
      name: 'ExampleProject', idempotencyKey: 'example-project-2026-10-12',
    }));
    const writes = requests.filter(request => request.method === 'POST');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].body.idempotencyKey, 'example-project-2026-10-12');
    assert.match(JSON.stringify(project), /ExampleProject/);
    assert.doesNotMatch(JSON.stringify(project), /secret-new-project-value|"env"/);
  });
});

test('foreign-company write results fail closed', async () => {
  await fixture(async ({ onRequest, call, requests }) => {
    onRequest((request, res) => {
      if (request.method === 'GET') {
        json(res, 200, []);
        return;
      }
      if (request.path.endsWith('/projects')) {
        json(res, 201, { id: projectId, companyId: otherCompanyId, name: 'Foreign project' });
      } else if (request.path.endsWith('/agents')) {
        json(res, 201, { id: agentId, companyId: otherCompanyId, name: 'Foreign agent' });
      } else {
        json(res, 404, { error: 'Unexpected mock route' });
      }
    });
    const project = await call('paperclip_create_project', {
      name: 'Scoped project', idempotencyKey: 'foreign-project-result',
    });
    assert.equal(project.isError, true);
    assert.doesNotMatch(JSON.stringify(project), /Foreign project/);
    const agent = await call('paperclip_create_agent', {
      name: 'Scoped agent', adapterType: 'codex_local',
    });
    assert.equal(requests.filter(request => request.method === 'POST').length, 2,
      'both tools must reach the mock API');
    assert.equal(agent.isError, true);
    assert.doesNotMatch(JSON.stringify(agent), /Foreign agent/);
  });
});

test('agent creation uses safe Codex settings and redacts adapter configuration', async () => {
  await fixture(async ({ onRequest, call, requests }) => {
    onRequest((request, res) => {
      if (request.method === 'GET' && request.path === `/api/companies/${companyId}/agents`) {
        json(res, 200, []);
        return;
      }
      assert.equal(request.method, 'POST');
      assert.equal(request.path, `/api/companies/${companyId}/agents`);
      json(res, 201, {
        id: agentId, companyId, name: request.body.name, role: request.body.role,
        adapterType: request.body.adapterType, status: 'idle',
        adapterConfig: { env: { KEY: 'secret-agent-value' } },
      });
    });
    const agent = data(await call('paperclip_create_agent', {
      name: 'Protocol analyst', role: 'researcher', adapterType: 'codex_local',
      model: 'gpt-6.1-sol', reasoningEffort: 'medium',
    }));
    const writes = requests.filter(request => request.method === 'POST');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].body.adapterType, 'codex_local');
    assert.equal(writes[0].body.adapterConfig.model, 'gpt-6.1-sol');
    assert.equal(writes[0].body.adapterConfig.modelReasoningEffort, 'medium');
    assert.match(JSON.stringify(agent), /Protocol analyst/);
    assert.doesNotMatch(JSON.stringify(agent), /secret-agent-value|"adapterConfig"/);
    const invalid = await call('paperclip_create_agent', {
      name: 'Unsafe agent', adapterType: 'codex_local', adapterConfig: { env: { KEY: 'value' } },
    });
    assert.equal(invalid.isError, true);
    assert.equal(requests.filter(request => request.method === 'POST').length, 1,
      'invalid fields must be rejected before an HTTP write');
  });
});

test('get and update project use the requested company and omit sensitive fields', async () => {
  await fixture(async ({ onRequest, call, requests }) => {
    const row = {
      id: projectId, companyId, name: 'ExampleProject', status: 'planned',
      env: { PRIVATE_KEY: 'secret-project-key' },
      executionWorkspacePolicy: { runtimePolicy: { password: 'secret-policy-password' } },
    };
    onRequest((request, res) => {
      if (request.method === 'GET' && request.path === `/api/projects/${projectId}`) {
        json(res, 200, row);
      } else if (request.method === 'PATCH' && request.path === `/api/projects/${projectId}`) {
        json(res, 200, { ...row, ...request.body });
      } else {
        json(res, 404, { error: 'Unexpected mock route' });
      }
    });
    const project = data(await call('paperclip_get_project', { projectId }));
    assert.match(JSON.stringify(project), /ExampleProject/);
    assert.doesNotMatch(JSON.stringify(project), /secret-project-key|secret-policy-password|"env"/);
    const updated = data(await call('paperclip_update_project', {
      projectId, changes: { description: 'Protocol analysis' },
    }));
    assert.match(JSON.stringify(updated), /Protocol analysis/);
    assert.doesNotMatch(JSON.stringify(updated), /secret-project-key|secret-policy-password|"env"/);
    const writes = requests.filter(request => request.method === 'PATCH');
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].body, { description: 'Protocol analysis' });
    const unsafe = await call('paperclip_update_project', {
      projectId, changes: { env: { PRIVATE_KEY: 'new-secret' } },
    });
    assert.equal(unsafe.isError, true);
    assert.equal(requests.filter(request => request.method === 'PATCH').length, 1);
  });
});

test('workspace list, create and update verify the parent project and omit commands', async () => {
  await fixture(async ({ onRequest, call, requests }) => {
    let workspace = {
      id: workspaceId, projectId, companyId, name: 'Poker source',
      sourceType: 'local_path', cwd: 'C:\\Work\\ExampleProject',
      isPrimary: true, repoUrl: 'https://example.test/poker.git',
      setupCommand: 'secret-setup-command', runtimeConfig: { credential: 'secret-runtime' },
    };
    onRequest((request, res) => {
      if (request.method === 'GET' && request.path === `/api/projects/${projectId}`) {
        json(res, 200, { id: projectId, companyId, name: 'ExampleProject' });
      } else if (request.method === 'GET' && request.path === `/api/projects/${projectId}/workspaces`) {
        json(res, 200, [workspace]);
      } else if (request.method === 'POST' && request.path === `/api/projects/${projectId}/workspaces`) {
        workspace = { ...workspace, ...request.body };
        json(res, 201, workspace);
      } else if (request.method === 'PATCH' && request.path === `/api/projects/${projectId}/workspaces/${workspaceId}`) {
        workspace = { ...workspace, ...request.body };
        json(res, 200, workspace);
      } else {
        json(res, 404, { error: 'Unexpected mock route' });
      }
    });
    const listed = data(await call('paperclip_list_project_workspaces', { projectId }));
    assert.match(JSON.stringify(listed), /Poker source/);
    assert.doesNotMatch(JSON.stringify(listed), /secret-setup-command|secret-runtime|"repoUrl"/);
    const created = data(await call('paperclip_create_project_workspace', {
      projectId, workspace: {
        name: 'Local checkout', sourceType: 'local_path',
        cwd: 'C:\\Work\\ExampleProject', isPrimary: true,
      },
    }));
    assert.match(JSON.stringify(created), /Local checkout/);
    const updated = data(await call('paperclip_update_project_workspace', {
      projectId, workspaceId, changes: { name: 'Renamed checkout' },
    }));
    assert.match(JSON.stringify(updated), /Renamed checkout/);
    const writes = requests.filter(request => ['POST', 'PATCH'].includes(request.method));
    assert.equal(writes.length, 2);
    assert.equal(writes[0].path, `/api/projects/${projectId}/workspaces`);
    assert.equal(writes[1].path, `/api/projects/${projectId}/workspaces/${workspaceId}`);
    assert.deepEqual(writes[1].body, { name: 'Renamed checkout' });
    assert.doesNotMatch(JSON.stringify(updated), /secret-setup-command|secret-runtime|"repoUrl"/);
  });
});

test('agent update rejects a stale updatedAt before any write', async () => {
  await fixture(async ({ onRequest, call, requests }) => {
    const originalUpdatedAt = '2026-10-12T12:00:00.000Z';
    onRequest((request, res) => {
      if (request.method === 'GET' && request.path === `/api/agents/${agentId}`) {
        json(res, 200, {
          id: agentId, companyId, name: 'Protocol analyst', adapterType: 'codex_local',
          updatedAt: originalUpdatedAt,
          adapterConfig: { model: 'gpt-6.1-sol', modelReasoningEffort: 'medium', apiKey: 'secret-agent-key' },
        });
      } else if (request.method === 'PATCH' && request.path === `/api/agents/${agentId}`) {
        json(res, 200, {
          id: agentId, companyId, name: request.body.name, adapterType: 'codex_local',
          updatedAt: '2026-10-12T12:01:00.000Z', adapterConfig: { apiKey: 'secret-agent-key' },
        });
      } else {
        json(res, 404, { error: 'Unexpected mock route' });
      }
    });
    const stale = await call('paperclip_update_agent', {
      agentId, expectedUpdatedAt: '2026-10-12T11:59:00.000Z',
      changes: { name: 'New name' },
    });
    assert.equal(stale.isError, true);
    assert.equal(requests.filter(request => request.method === 'PATCH').length, 0);
    const updated = data(await call('paperclip_update_agent', {
      agentId, expectedUpdatedAt: originalUpdatedAt, changes: { name: 'New name' },
    }));
    assert.match(JSON.stringify(updated), /New name/);
    assert.doesNotMatch(JSON.stringify(updated), /secret-agent-key|"adapterConfig"/);
    const writes = requests.filter(request => request.method === 'PATCH');
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].body, { name: 'New name' });
  });
});

test('Git URLs containing credentials are rejected before a project or workspace write', async () => {
  await fixture(async ({ onRequest, call, requests }) => {
    onRequest((request, res) => {
      if (request.method === 'GET' && request.path === `/api/projects/${projectId}`) {
        json(res, 200, { id: projectId, companyId, name: 'ExampleProject' });
      } else {
        json(res, 404, { error: 'Unexpected mock route' });
      }
    });
    const unsafeWorkspace = {
      name: 'Secret Git repo', sourceType: 'git_repo',
      repoUrl: 'https://git:embedded-password@example.test/repo.git',
    };
    const project = await call('paperclip_create_project', {
      name: 'Unsafe project', idempotencyKey: 'unsafe-project', workspace: unsafeWorkspace,
    });
    assert.equal(project.isError, true);
    const workspace = await call('paperclip_create_project_workspace', {
      projectId, workspace: unsafeWorkspace,
    });
    assert.equal(workspace.isError, true);
    assert.equal(requests.filter(request => request.method !== 'GET').length, 0);
  });
});
