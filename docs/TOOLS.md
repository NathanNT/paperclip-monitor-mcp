# Tool catalog

The bridge exposes 43 tools when `PAPERCLIP_ALLOW_WRITES=1` is set. Without that opt-in, the 15 explicit write tools are hidden; some monitoring reads may still reconcile internal state. This table describes compatibility tested against Paperclip `v2026.916.1`.

- **B**: works with the baseline Paperclip backend.
- **P**: requires the optional backend patch in `patches/` to be deployed.
- **B / A**: works on the baseline backend; after deploying the patch, `PAPERCLIP_ATOMIC_MANAGEMENT=1` enables additional server-side preconditions for this tool. Leave the flag unset on an unpatched backend.
- **R**: read; **R\***: API read that may reconcile stale internal state; **W**: explicit write. The one-shot client requires `--allow-write` for **R\*** and **W** tools.

All names remain visible in the MCP catalog even when the optional backend routes are absent.

## Overview and changes

| Tool | Effect | Backend |
| --- | --- | --- |
| `paperclip_health` | R | B |
| `paperclip_bridge_metrics` | R | B |
| `paperclip_dashboard` | R | B |
| `paperclip_monitor_snapshot` | R* | B |
| `paperclip_server_snapshot` | R | P |
| `paperclip_changes_since` | R* | B |
| `paperclip_server_changes` | R | P |

## Agents and schedules

| Tool | Effect | Backend |
| --- | --- | --- |
| `paperclip_list_agents` | R | B |
| `paperclip_get_agent` | R | B |
| `paperclip_agent_schedule_state` | R* | B |
| `paperclip_pause_agent` | W | B |
| `paperclip_resume_agent` | W | B |
| `paperclip_wake_agent` | W | B |
| `paperclip_manage_agents_bulk` | W | B |
| `paperclip_set_agent_timer` | W | B |
| `paperclip_server_set_agent_timer` | W | P |

`paperclip_manage_agents_bulk` selects at most 20 agents by exactly one of `agentIds`, `taskIds`, or `projectId`. Its `changes` object accepts a lowercase model identifier made of letters, digits, dots and hyphens, plus `reasoningEffort` and `fastMode`; it sends only those adapter fields to Paperclip, preserving credentials and unrelated settings. The default is `dryRun: true` and `launch: "none"`. An explicit `dryRun: false` applies and verifies settings. `launch: "resume"` resumes paused agents without guaranteeing a run; `launch: "wake"` resumes an eligible paused agent and requests an on-demand task run. Wake requires a stable UUID `operationId` so each agent gets a repeatable idempotency key. The tool never changes issue status or resolves a blocked task. Blocked or non-actionable tasks are reported as skipped. A recent queued or scheduled-retry run also prevents a duplicate wake.

When a requested model differs from any selected agent's current model, `changes.reasoningEffort` is required. Before the first write, the bridge checks each resulting model/effort pair against a conservative snapshot of the local Codex host catalog; unknown models and unsupported efforts are rejected for configuration edits. It also checks the effective Fast toggle, including a previously enabled toggle that would be retained by Paperclip's partial merge. Fast requests for unverified models are rejected. The allowlist needs updating as Codex's model catalog changes. These checks do not probe the installed Codex CLI, the account's service-tier eligibility, or regional eligibility; a successful configuration verification does not prove that a later run used the requested model or Fast processing. See [OpenAI's Fast mode guide](https://developers.openai.com/api/docs/guides/fast-mode).

Before each wake, the bridge checks local free memory (at least 1.5 GiB by default), the global live-run count (at most eight including the new run), and a per-call limit of two new wakes. These limits can be lowered; `minFreeMemoryGiB` may be adjusted from 0.5 to 16, while `maxLiveRuns` cannot exceed eight and `maxNewWakes` cannot exceed two. Agents beyond a limit are returned as `deferred_capacity`; call again later on that subset under the same user instruction. A full 100-run history page is treated as inconclusive and defers that agent's wake. Preflight checks selection and company scope before any explicit write. Configuration edits use Paperclip's partial adapter merge and are re-read for verification; they are not atomic across agents. A configuration failure prevents launches in that call. Dry runs issue GET requests only; some Paperclip GET routes may internally reconcile stale state in the tested backend.

## Tasks and comments

| Tool | Effect | Backend |
| --- | --- | --- |
| `paperclip_list_tasks` | R* | B |
| `paperclip_get_task` | R* | B |
| `paperclip_batch_get_tasks` | R* | B |
| `paperclip_task_comments` | R* | B |
| `paperclip_new_comments` | R* | B |
| `paperclip_create_task` | W | B |
| `paperclip_update_task` | W | B |
| `paperclip_continue_task` | W | B |
| `paperclip_add_comment` | W | B |
| `paperclip_add_conditional_comment` | W | P |

## Runs and diagnostics

| Tool | Effect | Backend |
| --- | --- | --- |
| `paperclip_list_runs` | R | B |
| `paperclip_get_run` | R | B |
| `paperclip_run_events` | R | B |
| `paperclip_run_log` | R | B |
| `paperclip_run_tail` | R | B |
| `paperclip_run_lineage` | R* | B |
| `paperclip_server_run_page` | R | P |
| `paperclip_run_diagnostic` | R* | B |
| `paperclip_issue_activity` | R* | B |
| `paperclip_cancel_run` | W | B |

## Documents and checkpoints

| Tool | Effect | Backend |
| --- | --- | --- |
| `paperclip_task_documents` | R* | B |
| `paperclip_checkpoint_index` | R* | B |
| `paperclip_candidate_registry` | R* | B |

## Recovery and runner goals

| Tool | Effect | Backend |
| --- | --- | --- |
| `paperclip_inspect_recovery` | R* | B |
| `paperclip_runner_goal_action` | W | B |
| `paperclip_retry_scheduled` | W | B / A |
| `paperclip_resolve_recovery` | W | B / A |
