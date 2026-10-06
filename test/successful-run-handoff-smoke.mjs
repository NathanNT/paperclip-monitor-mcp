import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const packageRoot = process.argv[2];
if (!packageRoot) {
  throw new Error('Usage: node test/successful-run-handoff-smoke.mjs PATH_TO_NODE_MODULES/@paperclipai');
}

const importFile = (relative) => import(pathToFileURL(resolve(packageRoot, relative)).href);
const { buildPaperclipWakePayload } = await importFile('server/dist/services/heartbeat.js');
const {
  isPaperclipRecoveryWakePayload,
  renderPaperclipWakePrompt,
} = await importFile('adapter-utils/dist/server-utils.js');

const db = { select: () => ({ from: () => ({ where: async () => [] }) }) };
const issueSummary = {
  id: 'issue-1',
  identifier: 'TEST-1',
  title: 'Synthetic handoff test',
  description: 'Synthetic fixture only.',
  status: 'in_progress',
  priority: 'medium',
  workMode: 'standard',
};
const handoff = {
  wakeReason: 'finish_successful_run_handoff',
  handoffRequired: true,
  handoffReason: 'successful_run_missing_state',
  missingDisposition: 'clear_next_step',
  handoffAttempt: 1,
  maxHandoffAttempts: 1,
  sourceRunId: 'run-1',
  validDispositionOptions: ['done', 'blocked', 'in_progress'],
  instruction: 'SYNTHETIC_HANDOFF_INSTRUCTION: record one valid disposition; do not redo work.',
};

const payload = await buildPaperclipWakePayload({
  db,
  companyId: 'company-1',
  contextSnapshot: handoff,
  issueSummary,
});
assert.equal(payload?.successfulRunHandoff?.instruction, handoff.instruction);
assert.equal(payload?.successfulRunHandoff?.missingDisposition, 'clear_next_step');
assert.equal(isPaperclipRecoveryWakePayload(payload), true);
const prompt = renderPaperclipWakePrompt(payload, { resumedSession: true });
assert.match(prompt, /SYNTHETIC_HANDOFF_INSTRUCTION/);
assert.match(prompt, /valid dispositions: done, blocked, in_progress/);

const unrelated = await buildPaperclipWakePayload({
  db,
  companyId: 'company-1',
  contextSnapshot: { wakeReason: 'issue_assigned', instruction: 'UNRELATED_INSTRUCTION' },
  issueSummary,
});
assert.equal(unrelated?.successfulRunHandoff, null);
assert.doesNotMatch(renderPaperclipWakePrompt(unrelated), /UNRELATED_INSTRUCTION/);

console.log('Successful-run handoff wake reaches the resumed prompt; unrelated wake stays unchanged.');
