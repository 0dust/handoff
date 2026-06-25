# Local Self-Hosting

Handoff is local-first, but team handoff needs a server Alice's machine can reach. For teammates on the same Wi-Fi, Sam can host directly from his machine:

```bash
npx -y handoff-relay start --lan
npx -y handoff-relay invite alice
npx -y handoff-relay doctor
```

Alice runs the printed join command on her own machine:

```bash
npx -y handoff-relay join http://<sam-lan-ip>:3737/invite/<invite-token>
npx -y handoff-relay doctor
```

Plain `start` is for local demos, CI smoke tests, or two profiles on one machine. It resets the active profile to loopback-only invite links. Re-run `start --lan` or pass `--public-url` before creating new invites that another machine should join.

For a dedicated trusted host, run one coordination server and have teammates join an invite from that server.

## Coordination Server

```bash
npx -y handoff-relay server start \
  --db /srv/handoff/relay.db \
  --host 10.0.0.10 \
  --port 3737
```

Put the host behind your normal network controls. Handoff does not provide a hosted cloud service.

For local profile-managed servers started by `handoff start`, inspect or stop the recorded background process:

```bash
npx -y handoff-relay server status
npx -y handoff-relay server stop
```

## Profiles For Teammates

Create a workspace and invite members with the advanced commands, or run `start --lan` on the host machine and use the printed invite command.

After a teammate runs:

```bash
npx -y handoff-relay join http://10.0.0.10:3737/invite/<invite-token>
```

their local profile stores the server URL, member token, workspace ID, and approval secret. They can install one supported local MCP config while joining:

```bash
npx -y handoff-relay join http://10.0.0.10:3737/invite/<invite-token> --install-mcp codex
# or
npx -y handoff-relay join http://10.0.0.10:3737/invite/<invite-token> --install-mcp cursor
```

Their MCP command stays profile-backed:

```bash
npx -y handoff-relay server mcp --profile default
```

## Explicit Server-Backed Commands

Low-level server-backed commands remain available for automation:

```bash
npx -y handoff-relay inbox \
  --server-url http://10.0.0.10:3737 \
  --token <token> \
  --workspace <workspace-id>
```

Configure project/repo aliases once per workspace so clone names and local repo aliases resolve to the same packet history:

```bash
npx -y handoff-relay workspace alias set \
  --server-url http://10.0.0.10:3737 \
  --token <admin-token> \
  --workspace <workspace-id> \
  --canonical handoff \
  --alias relay-local \
  --json

npx -y handoff-relay workspace alias list \
  --server-url http://10.0.0.10:3737 \
  --token <token> \
  --workspace <workspace-id> \
  --json
```

## Approval Tokens

Strict profile-backed approval tokens use the local profile:

```bash
npx -y handoff-relay approval-token <packet-id> --action send
npx -y handoff-relay approval-token <packet-id> --action hydrate
```

Profile-backed MCP can opt into agent-confirmed approvals:

```bash
npx -y handoff-relay server mcp --profile default --agent-approvals
```

In that mode, the MCP process requests and consumes the same short-lived approval tokens through the configured Handoff backend after the agent shows the packet and you explicitly tell it to send, approve, or hydrate. Local/LAN profiles with a running server URL use that local Handoff API instead of writing SQLite directly from the agent process; remote/self-hosted profiles use the configured Handoff server API.

Explicit approval-token mode remains available:

```bash
npx -y handoff-relay approval-token <packet-id> \
  --server-url http://10.0.0.10:3737 \
  --token <token> \
  --approval-secret <approval-secret> \
  --action send
```

Approval secrets stay outside MCP config. `HANDOFF_APPROVAL_SECRET` and the older `AGENT_RELAY_APPROVAL_SECRET` alias are supported for the terminal running approval commands.

## SQLite Operations

- The coordination server database path is controlled with `--db`, `HANDOFF_DB`, or `AGENT_RELAY_DB`.
- Back up the main `.db` file plus WAL/SHM files when WAL mode is active.
- Treat the database as sensitive: packet bodies and token hashes live there.
- Do not put `.relay/*.db` in git.

## Watch Mode

Terminal polling watcher:

```bash
npx -y handoff-relay watch \
  --server-url http://10.0.0.10:3737 \
  --token <token> \
  --workspace <workspace-id> \
  --interval 5000
```

Add best-effort native desktop notifications on the machine running the watcher:

```bash
npx -y handoff-relay watch \
  --server-url http://10.0.0.10:3737 \
  --token <token> \
  --workspace <workspace-id> \
  --desktop-notifications
```

Post concise notification summaries to a generic webhook endpoint:

```bash
npx -y handoff-relay watch \
  --server-url http://10.0.0.10:3737 \
  --token <token> \
  --workspace <workspace-id> \
  --webhook-url https://hooks.example.test/relay \
  --webhook-header "Authorization: Bearer <token>"
```

The watcher polls Handoff's durable notification queue. A notification is acknowledged after local delivery, so restarting the watcher does not re-send already delivered packet notifications. Terminal, desktop, and webhook notifications include sender handle, packet type, title, project, summary, notification id, and the open/review action, but never evidence bodies or raw transcripts. For scripts or tests, use `--once` to poll a single time and exit.

## From A Local Checkout

```bash
pnpm install
pnpm build
node dist/cli.js server start --db /srv/handoff/relay.db --host 10.0.0.10 --port 3737
```
