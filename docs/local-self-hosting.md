# Local Self-Hosting

Handoff is local-first. You can run everything on one machine for a demo or point multiple teammates at the same coordination server on a trusted host.

## Coordination Server

```bash
pnpm build
node dist/cli.js server start --db /srv/handoff/relay.db --host 127.0.0.1 --port 3737
```

For a LAN host, bind to a private interface and put access behind your normal network controls:

```bash
node dist/cli.js server start --db /srv/handoff/relay.db --host 10.0.0.10 --port 3737
```

## MCP Server

Each user runs a local MCP stdio process near their coding agent:

```bash
node dist/cli.js server mcp --db /srv/handoff/relay.db
```

For multi-host teammate use, run the Fastify API on the shared host and point each local MCP server at it:

```bash
node dist/cli.js server mcp --server-url http://10.0.0.10:3737
```

CLI commands use the same API-backed mode:

```bash
node dist/cli.js inbox --server-url http://10.0.0.10:3737 --token <token> --workspace <workspace-id>
```

Configure project/repo aliases once per workspace so clone names and local repo aliases resolve to the same packet history:

```bash
node dist/cli.js workspace alias set --server-url http://10.0.0.10:3737 --token <admin-token> --workspace <workspace-id> --canonical handoff --alias relay-local --json
node dist/cli.js workspace alias list --server-url http://10.0.0.10:3737 --token <token> --workspace <workspace-id> --json
```

Human approval tokens still come from each teammate's local CLI renderer:

```bash
node dist/cli.js approval-token <packet-id> --server-url http://10.0.0.10:3737 --token <token> --approval-secret <approval-secret> --action send
```

The approval secret is returned once during workspace creation or invite acceptance. Keep it outside MCP config; `AGENT_RELAY_APPROVAL_SECRET` is supported for the terminal running approval commands.

Rotate a member token through the same server-backed path:

```bash
node dist/cli.js member rotate-token --server-url http://10.0.0.10:3737 --token <current-token> --json
```

Rotate a leaked approval secret without changing the member token or member id:

```bash
node dist/cli.js member rotate-approval-secret --server-url http://10.0.0.10:3737 --token <current-token> --approval-secret <current-approval-secret> --json
```

Inspect history and audit metadata through the server:

```bash
node dist/cli.js history --server-url http://10.0.0.10:3737 --token <token> --workspace <workspace-id> --filter open --json
node dist/cli.js history --server-url http://10.0.0.10:3737 --token <token> --workspace <workspace-id> --project relay-local --sender @sam --recipient @alice --status delivered --file-symbol refreshSession --ticket-pr REL-7 --json
node dist/cli.js search --server-url http://10.0.0.10:3737 --token <token> --workspace <workspace-id> --project handoff --query "auth refresh" --json
node dist/cli.js audit --server-url http://10.0.0.10:3737 --token <admin-token> --workspace <workspace-id> --json
```

## SQLite Operations

- The coordination server database path is controlled with `--db` or `AGENT_RELAY_DB`.
- Back up the main `.db` file plus WAL/SHM files when WAL mode is active.
- Treat the database as sensitive: packet bodies and token hashes live there.
- Do not put `.relay/*.db` in git.

## Watch Mode

Terminal polling watcher:

```bash
node dist/cli.js watch --server-url http://10.0.0.10:3737 --token <token> --workspace <workspace-id> --interval 5000
```

Add best-effort native desktop notifications on the machine running the watcher:

```bash
node dist/cli.js watch --server-url http://10.0.0.10:3737 --token <token> --workspace <workspace-id> --desktop-notifications
```

Post concise notification summaries to a generic webhook endpoint:

```bash
node dist/cli.js watch --server-url http://10.0.0.10:3737 --token <token> --workspace <workspace-id> --webhook-url https://hooks.example.test/relay --webhook-header "Authorization: Bearer <token>"
```

The watcher always uses polling. Terminal, desktop, and webhook notifications include sender handle, packet type, title, project, summary, and the open/review action, but never evidence bodies or raw transcripts. For scripts or tests, use `--once` to poll a single time and exit.
