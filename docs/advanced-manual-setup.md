# Advanced Manual Setup

Use this path for automation, remote/self-hosted coordination servers, CI smoke tests, or explicit-auth MCP compatibility. Most users should start with:

```bash
npx -y @0dust/handoff start
npx -y @0dust/handoff invite alice
npx -y @0dust/handoff join <invite-link>
```

The commands below intentionally expose low-level details: DB paths, server URLs, workspace IDs, member tokens, and approval secrets.

## Start A Coordination Server

```bash
npx -y @0dust/handoff server start \
  --db /srv/handoff/relay.db \
  --host 10.0.0.10 \
  --port 3737
```

For local-only testing:

```bash
npx -y @0dust/handoff server start \
  --db .relay/team.db \
  --host 127.0.0.1 \
  --port 3737
```

## Create A Workspace

```bash
npx -y @0dust/handoff workspace create \
  --server-url http://127.0.0.1:3737 \
  --name "Relay Demo" \
  --handle sam \
  --display-name "Sam" \
  --json
```

Save the returned:

- `workspace.id`
- `admin.token`
- `admin.approval_secret`

Member tokens authenticate API/MCP calls. Approval secrets stay outside MCP and are used only by the local approval-token command.

## Invite And Accept A Member

```bash
npx -y @0dust/handoff member invite \
  --server-url http://127.0.0.1:3737 \
  --token <sam-token> \
  --workspace <workspace-id> \
  --handle alice \
  --json

npx -y @0dust/handoff member accept \
  --server-url http://127.0.0.1:3737 \
  --invite <invite-token> \
  --display-name "Alice" \
  --json
```

## Explicit-Auth MCP Mode

Profile-backed MCP is the normal mode:

```bash
npx -y @0dust/handoff server mcp --profile default
```

Explicit-auth compatibility mode keeps the older schemas that include `authToken` and `workspaceId`:

```bash
npx -y @0dust/handoff server mcp \
  --server-url http://127.0.0.1:3737 \
  --explicit-auth
```

Use explicit-auth mode only when a script or test harness intentionally supplies auth fields. Do not put approval secrets in MCP config.

## Draft, Approve, And Send

```bash
npx -y @0dust/handoff share-with @alice \
  --server-url http://127.0.0.1:3737 \
  --token <sam-token> \
  --workspace <workspace-id> \
  --title "Auth refresh handoff" \
  --summary "The retry path still returns 401 after refresh-token rotation." \
  --finding "The retry path appears to skip persistence before the second request." \
  --source-client codex \
  --evidence-json '[{"kind":"test_failure","label":"test output","source":"pnpm test auth-refresh","excerpt":"expected 200 received 401"}]' \
  --files src/auth/refresh.ts,refreshSession \
  --tests "pnpm test auth-refresh" \
  --tried "Checked token expiry math,Re-ran the refresh integration test" \
  --hypothesis "Refresh persistence ordering issue." \
  --json

npx -y @0dust/handoff approval-token <handoff-packet-id> \
  --server-url http://127.0.0.1:3737 \
  --token <sam-token> \
  --approval-secret <sam-approval-secret> \
  --action send \
  --json

npx -y @0dust/handoff approve <handoff-packet-id> \
  --server-url http://127.0.0.1:3737 \
  --token <sam-token> \
  --approval-token <send-approval-token> \
  --json
```

## Review And Hydrate

```bash
npx -y @0dust/handoff inbox \
  --server-url http://127.0.0.1:3737 \
  --token <alice-token> \
  --workspace <workspace-id> \
  --json

npx -y @0dust/handoff view <handoff-packet-id> \
  --server-url http://127.0.0.1:3737 \
  --token <alice-token> \
  --json

npx -y @0dust/handoff accept <handoff-packet-id> \
  --server-url http://127.0.0.1:3737 \
  --token <alice-token> \
  --json

npx -y @0dust/handoff approval-token <handoff-packet-id> \
  --server-url http://127.0.0.1:3737 \
  --token <alice-token> \
  --approval-secret <alice-approval-secret> \
  --action hydrate \
  --json

npx -y @0dust/handoff hydrate <handoff-packet-id> \
  --server-url http://127.0.0.1:3737 \
  --token <alice-token> \
  --client claude-code \
  --approval-token <hydrate-approval-token>
```

## Reply

```bash
npx -y @0dust/handoff reply <ask-packet-id> "Persist the rotated refresh token before retrying." \
  --server-url http://127.0.0.1:3737 \
  --token <alice-token> \
  --summary "Likely refresh persistence ordering issue." \
  --source-client claude-code \
  --json

npx -y @0dust/handoff approval-token <reply-packet-id> \
  --server-url http://127.0.0.1:3737 \
  --token <alice-token> \
  --approval-secret <alice-approval-secret> \
  --action reply \
  --json

npx -y @0dust/handoff approve <reply-packet-id> \
  --server-url http://127.0.0.1:3737 \
  --token <alice-token> \
  --approval-token <reply-approval-token> \
  --json
```

## Watch

```bash
npx -y @0dust/handoff watch \
  --server-url http://127.0.0.1:3737 \
  --token <member-token> \
  --workspace <workspace-id>

npx -y @0dust/handoff watch \
  --server-url http://127.0.0.1:3737 \
  --token <member-token> \
  --workspace <workspace-id> \
  --desktop-notifications

npx -y @0dust/handoff watch \
  --server-url http://127.0.0.1:3737 \
  --token <member-token> \
  --workspace <workspace-id> \
  --webhook-url https://hooks.example.test/relay
```
