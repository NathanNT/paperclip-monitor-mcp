# Successful-run handoff patch for Paperclip v2026.916.1

Paperclip may finish a useful agent run while its issue remains `in_progress` without a valid next-step disposition. It then queues one corrective `finish_successful_run_handoff` wake. In v2026.916.1, the producer stores a precise `instruction` in that wake's context, but the heartbeat payload builder does not pass it to the adapter prompt. The corrective run can repeat completed analysis and consume its only handoff attempt.

This is the defect tracked in [Paperclip issue #12603](https://github.com/paperclipai/paperclip/issues/12603). [PR #12604](https://github.com/paperclipai/paperclip/pull/12604) proposes the upstream fix. The source patch here ports that fix to the clean `v2026.916.1` tag. It changes only `server/src/services/heartbeat.ts`, `packages/adapter-utils/src/server-utils.ts`, and two focused tests. It adds a dedicated `successfulRunHandoff` wake block and renders the original disposition-only instruction. Unrelated wakes do not inherit a bare `instruction` field.

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
