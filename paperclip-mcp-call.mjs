#!/usr/bin/env node
// One-shot MCP client for local diagnostics and direct tool calls.
// The configured stdio server is still the source of truth for tools and schemas.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const toolName = process.argv[2];
const rawArguments = process.argv[3] || '{}';
const allowWrite = process.argv.slice(4).includes('--allow-write');
const listOnly = toolName === '--list';
const timeoutMs = Number(process.env.PAPERCLIP_MCP_CLIENT_TIMEOUT_MS || 120000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) {
  process.stderr.write('PAPERCLIP_MCP_CLIENT_TIMEOUT_MS must be between 1000 and 300000.\n');
  process.exit(2);
}
if (!listOnly && !/^paperclip_[a-z0-9_]+$/.test(toolName || '')) {
  process.stderr.write('Usage: node paperclip-mcp-call.mjs --list | paperclip_tool_name "{...}" [--allow-write]\n');
  process.exit(2);
}
let args;
try { args = JSON.parse(rawArguments); }
catch { process.stderr.write('Tool arguments must be JSON.\n'); process.exit(2); }
if (!args || Array.isArray(args) || typeof args !== 'object') {
  process.stderr.write('Tool arguments must be a JSON object.\n');
  process.exit(2);
}

const script = resolve(dirname(fileURLToPath(import.meta.url)), 'paperclip-mcp.mjs');
const child = spawn(process.execPath, [script], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
let nextId = 0;
let stderr = '';
child.stderr.on('data', chunk => { stderr += String(chunk).slice(0, 2000); });
function failPending(message) {
  for (const waiting of pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error(message)); }
  pending.clear();
}
child.on('error', error => failPending(`MCP server could not start: ${error.message}`));
child.on('exit', (code, signal) => failPending(`MCP server exited before replying (${code ?? signal})`));
createInterface({ input: child.stdout }).on('line', line => {
  let response;
  try { response = JSON.parse(line); } catch { return; }
  const waiting = pending.get(response.id);
  if (waiting) { clearTimeout(waiting.timer); pending.delete(response.id); waiting.resolve(response); }
});
function request(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} timed out`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
try {
  const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'paperclip-mcp-call', version: '1' } });
  if (init.error) throw new Error(`MCP initialize failed: ${init.error.message}`);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const catalog = await request('tools/list');
  if (catalog.error) throw new Error(`MCP catalog failed: ${catalog.error.message}`);
  if (listOnly) {
    process.stdout.write(JSON.stringify(catalog.result?.tools?.map(item => ({ name: item.name, changesPaperclip: Boolean(item.annotations?.destructiveHint) })) || [], null, 2) + '\n');
  } else {
    const tool = catalog.result?.tools?.find(item => item.name === toolName);
    if (!tool) throw new Error('Unknown Paperclip tool');
    if (tool.annotations?.destructiveHint && !allowWrite) throw new Error('This tool may change Paperclip state, including internal reconciliation. Pass --allow-write to invoke it intentionally.');
    const response = await request('tools/call', { name: toolName, arguments: args });
    if (response.error) throw new Error(`MCP call failed: ${response.error.message}`);
    if (response.result?.isError) throw new Error(response.result.content?.[0]?.text || 'Paperclip tool failed');
    process.stdout.write(JSON.stringify(response.result?.structuredContent?.data ?? null, null, 2) + '\n');
  }
} catch (error) {
  process.stderr.write(error.message + (stderr ? `\nMCP stderr: ${stderr.trim()}` : '') + '\n');
  process.exitCode = 1;
} finally {
  for (const waiting of pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error('MCP client closed')); }
  child.stdin.end();
  child.kill();
}
