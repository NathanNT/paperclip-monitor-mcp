# Successful-run handoff patch for Paperclip v2026.916.1

Paperclip may finish a useful agent run while its issue remains `in_progress` without a valid next-step disposition. It then queues one corrective `finish_successful_run_handoff` wake. In v2026.916.1, the producer stores a precise `instruction` in that wake's context, but the heartbeat payload builder does not pass it to the adapter prompt. The corrective run can repeat completed analysis and consume its only handoff attempt.

This is the defect tracked in [Paperclip issue #12603](https://github.com/paperclipai/paperclip/issues/12603). [PR #12604](https://github.com/paperclipai/paperclip/pull/12604) proposes the upstream fix. The source patch here ports that fix to the clean `v2026.916.1` tag. It changes only `server/src/services/heartbeat.ts`, `packages/adapter-utils/src/server-utils.ts`, and two focused tests. It adds a dedicated `successfulRunHandoff` wake block and renders the original disposition-only instruction. Unrelated wakes do not inherit a bare `instruction` field.

## Continuation contract correction

`patches/paperclip-successful-run-handoff-continuation-contract-2026.916.1.patch` is a separate, source-only correction to the handoff instruction and its focused test. Apply it to the source checkout in addition to the patch above. The previous instruction named `resumeIntent` and `resumeFromRunId` as though an agent could record them through an issue update. They are internal wake-context fields, not accepted fields of the issue update or comment API. A comment containing those words and a `PATCH` that leaves the issue `in_progress` do not establish a continuation.

In the observed live recovery, the board inspected and resolved the native recovery action to `todo`, preserving the assignee. Paperclip started a recovery run, and a subsequent issue-scoped on-demand wake started the research run. This sequence is distinct from a board-side issue `PATCH`; do not infer that a comment alone caused either wake. A board-side `PATCH /api/issues/{id}` with `status: "todo"`, `resume: true`, and a concrete next-action comment is another supported route, but its resulting wake must be verified. The `resume` field belongs to the public issue-update schema. A self-comment posted from a run that still owns the issue may suppress its own wake. Confirm a new queued, deferred, claimed, or running issue wake before treating a comment as a continuation.

In the same live case, the research run recorded a new checkpoint and left the issue `todo` with a concrete next action. Its 300-second generic timer subsequently started another run on that issue, reusing the same agent session and execution workspace. This verifies one observed continuation cycle; a generic timer is not a task-scoped delivery guarantee when an agent has several actionable issues.

An assigned `todo` issue passes the optional actionable-work filter for a periodic heartbeat, but the timer wake has no issue ID. It may lead the agent back to the issue, as observed here with session reuse; it is not a guaranteed continuation of that issue. Generic stranded-issue recovery also skips an assigned `todo` whose latest run succeeded unless a recovery action explicitly handed it back. The handoff instruction therefore asks for a durable, issue-scoped path or a real blocker/reviewer disposition.

For a source checkout, run:

```sh
git apply --check patches/paperclip-successful-run-handoff-continuation-contract-2026.916.1.patch
git apply patches/paperclip-successful-run-handoff-continuation-contract-2026.916.1.patch
pnpm exec vitest run server/src/services/recovery/successful-run-handoff.test.ts server/src/__tests__/heartbeat-successful-run-handoff-wake.test.ts packages/adapter-utils/src/wake-successful-run-handoff.test.ts
```

The source checkout used to create this patch passed all 40 tests in those three files.

The matching compiled delta is `patches/paperclip-successful-run-handoff-continuation-contract-dist-2026.916.1.patch`. It applies only to the already installed local `@paperclipai/server/dist/services/recovery/successful-run-handoff.js` baseline whose SHA-256 is `d3b66148171b6d48cdddfc50dfdd2208ec7e893281f4d01133709e0469aad4e6`; the expected patched SHA-256 is `a6771f97582579590aa7c6c767f7c1e3974231a0b010bf98bc219defa7be4d30`. A clean source build is preferable for any other baseline. The compiled patch passed `node --check` and a byte-for-byte application check with `core.autocrlf=false`.

On 2026-10-06, the compiled correction was installed after Paperclip's native task drain reported `quiescent=true`, `activeRuns=0`, and `pendingWakes=0`, with no live runs. The prior file was backed up and its hash checked before replacement. The restarted v2026.916.1 server answered health checks on its original port with a single listener, and the installed file matched the patched hash above. The SEN-80 and SEN-82 agents both started new runs after restart.

A natural SEN-80 `missing-disposition` case later provided the live check. Source run `2bb66c91-3caa-475d-8660-7b913ebd36fa` triggered corrective run `96afe7df-36b6-40f0-bd9e-3887f5c00cf7`. The corrective run's persisted wake payload carried the original instruction exactly, and the installed prompt renderer included that instruction. The corrective run left the same issue `todo` with a concrete next action, no active recovery, and a later timer run `89540a5a-e62f-4720-968f-8a7781d1c20f` resumed useful static research. This validates the handoff transport and a successful disposition for this observed case. It does not make generic timers task-scoped or guarantee every future handoff outcome.

## Source verification

From a clean Paperclip `v2026.916.1` source checkout, check and apply `patches/paperclip-successful-run-handoff-2026.916.1.patch`, then run:

```sh
corepack pnpm install --offline --frozen-lockfile --ignore-scripts
corepack pnpm exec vitest run packages/adapter-utils/src/wake-successful-run-handoff.test.ts server/src/__tests__/heartbeat-successful-run-handoff-wake.test.ts
corepack pnpm --filter @paperclipai/adapter-utils typecheck
```

The `--offline` flag is optional when dependencies are not cached. The focused suite contains seven tests across two test files. A clean source build can also be verified with the repository's broader checks before deployment.

## Compiled runtime overlay

`patches/paperclip-successful-run-handoff-dist-2026.916.1.patch` records the equivalent two-file change made to a **previously locally patched** `@paperclipai` npm package. It is not a generic replacement for a clean installation. The pre-patch SHA-256 values were:

| File relative to the `@paperclipai` package directory | SHA-256 before this patch |
| --- | --- |
| `server/dist/services/heartbeat.js` | `963bbed5bb1ca5b64141299ab2d751e5b1ffc4b67b6ae7fe31f928d9be1ddd8f` |
| `adapter-utils/dist/server-utils.js` | `726bfaabca56fe4e2c38e7269df2107e1fdf0a1d15ad4cf589f49464b3ca3671` |

Before applying the compiled delta, compare both hashes, preserve copies of those files, and ensure no useful agent run is active before restarting the supervised server. A package refresh may replace the overlay. Apply the source patch and rebuild for any other package baseline.

After the patch, check JavaScript syntax and execute the synthetic installed-package smoke test:

```sh
node --check PATH_TO_NODE_MODULES/@paperclipai/server/dist/services/heartbeat.js
node --check PATH_TO_NODE_MODULES/@paperclipai/adapter-utils/dist/server-utils.js
node test/successful-run-handoff-smoke.mjs PATH_TO_NODE_MODULES/@paperclipai
```

The smoke test verifies the handoff instruction reaches a resumed prompt and that a normal issue wake does not inherit it. A live check should then inspect a new corrective run's prompt and its issue disposition. Existing blocked issues require their own inspected recovery action; this patch does not automatically clear them.
