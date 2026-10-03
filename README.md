# Paperclip Monitor MCP

A local [MCP](https://modelcontextprotocol.io/) server for monitoring and managing agents, tasks, runs, and schedules in [Paperclip](https://github.com/paperclipai/paperclip). It uses stdio, Node.js 22+, and the Paperclip REST API. There are no runtime npm dependencies.

This is an independent integration tested with Paperclip `v2026.916.1`. It supports a **local, trusted** Paperclip instance on a loopback HTTP address; remote and authenticated instances are not supported.

## Setup

1. Clone this repository and find your Paperclip company UUID.
2. Configure your MCP client to launch `paperclip-mcp.mjs` with Node.js and these environment variables:

   - `PAPERCLIP_COMPANY_ID` — required company UUID.
   - `PAPERCLIP_API_URL` — optional; defaults to `http://127.0.0.1:3100`.
   - `PAPERCLIP_ALLOW_WRITES=1` — optional; exposes explicit management tools.

For example, a Codex MCP client entry can use:

```toml
[mcp_servers.paperclip]
command = "node"
args = ["ABSOLUTE_PATH_TO_REPOSITORY/paperclip-mcp.mjs"]

[mcp_servers.paperclip.env]
PAPERCLIP_COMPANY_ID = "00000000-0000-4000-8000-000000000000"
PAPERCLIP_API_URL = "http://127.0.0.1:3100"
# PAPERCLIP_ALLOW_WRITES = "1"
```

Replace the example UUID and path locally. The server does not load `.env.example` automatically. Restart the MCP client after changing its configuration.

## Tools

The bridge provides task and agent status, runs, comments, logs, schedules, recovery diagnostics, and a bounded monitoring snapshot. With writes enabled, it can update tasks, comment, wake or pause agents, and manage recovery. See [the tool catalog](docs/TOOLS.md) for all 43 tools and backend requirements.

The optional [Paperclip backend patch](patches/paperclip-supervision-management-bundle-2026.916.1.patch) adds native snapshot, change-feed, conditional-comment, and atomic management routes. The baseline tools work without it. Leave `PAPERCLIP_ATOMIC_MANAGEMENT` unset unless that patch has been deployed and verified against the matching Paperclip version.

The separate [task-scoped timer patch](patches/paperclip-task-scoped-timer-2026.916.1.patch) fixes a Paperclip `v2026.916.1` scheduler issue: when an agent has exactly one actionable assigned task, its periodic timer run now carries that task's ID. This allows task-level writes and session reuse. It leaves proactive timers and ambiguous multi-task timers unscoped. This is a **Paperclip server patch**, not an MCP configuration switch; apply it to the matching Paperclip source and restart the server after building. It is independent of the management-route patch above.

## Check

```sh
npm run check
npm test
```

Tests use a mock HTTP server and do not need Paperclip credentials or a running instance. For a local MCP catalog check after setting the environment variables:

```sh
node paperclip-mcp-call.mjs --list
```

## Security

This is a privileged **local board tool**. In Paperclip's `local_trusted` mode, loopback API calls can have board/instance-admin authority even without a bearer token. Restrict access to the MCP client and machine. `PAPERCLIP_COMPANY_ID` selects a company; it does not reduce that authority. Some Paperclip read routes can also reconcile internal state. See [SECURITY.md](SECURITY.md).

MIT licensed.
