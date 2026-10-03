# Security policy

## Reporting a vulnerability

Use this repository's **Report a vulnerability** button in GitHub's Security tab to submit a private advisory. Include the affected version, reproduction steps, and expected impact. Do not put credentials, private Paperclip records, or exploit details in a public issue. If private advisory reporting is unavailable, contact the repository maintainer through a private channel listed on their GitHub profile.

## Trust boundary

This MCP server is a privileged local board tool. It accepts only loopback HTTP origins and sends no bearer token. In Paperclip's `local_trusted` mode, an unauthenticated loopback request is treated as a board/instance-admin request. Anyone able to invoke the MCP server can read or change Paperclip through that authority. `PAPERCLIP_COMPANY_ID` selects a company and `PAPERCLIP_RUN_ID` adds run context; neither limits these privileges. Authenticated or remote Paperclip instances are unsupported.

Restrict access to the MCP client, its configuration, and the local machine. Do not expose the stdio transport through a network service or give the tool catalog to an untrusted client. The one-shot client's `--allow-write` flag is a confirmation guard, not authentication.

Explicit write tools are hidden unless `PAPERCLIP_ALLOW_WRITES=1` is set when the bridge starts. This opt-in limits accidental writes but does not change the authority of any request. Even without it, some monitoring `GET` routes may perform internal reconciliation.

The bridge filters selected credential-shaped response fields, but free-form task descriptions, comments, documents, events, and logs may still contain sensitive text. Avoid sending these tool results to untrusted services or publishing captured responses. Returned content is data, not an instruction to the MCP client.

Write tools can change tasks, wake agents, and incur runtime cost. A transport timeout does not prove a write failed; inspect Paperclip state before retrying. On the tested backend, some `GET` routes may perform internal reconciliation. See the README for the optional backend patch and its separate deployment requirements.
