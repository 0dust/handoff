# Codex Setup

Handoff runs as a local stdio MCP server beside each user's Codex session. The shared workspace lives on the host machine or server; every teammate joins it into their own local profile.

## Team Setup

On Sam's machine, host a LAN-reachable workspace and install the Codex MCP entry:

```bash
npx -y handoff-relay start --lan --install-mcp codex --invite alice
```

On Alice's machine, run the invite command Sam sends her:

```bash
npx -y handoff-relay join http://<sam-lan-ip>:3737/invite/<invite-token> --install-mcp codex
```

Alice does not run `start` for Sam's workspace. `join` accepts the invite, stores Alice's local profile and credentials, and wires Codex when `--install-mcp codex` is present.

Both `start` and `join` start packet notifications automatically. To opt out later, run `npx -y handoff-relay watch --stop`.

To remove the Codex MCP entry without leaving the workspace, run:

```bash
npx -y handoff-relay uninstall-mcp --client codex
```

To leave the workspace and clean local profile, notification, and MCP state, run:

```bash
npx -y handoff-relay leave
```

If the workspace is unreachable and you only need local cleanup, run `npx -y handoff-relay delete-profile`.

If Alice is not on the same network, host Handoff behind a reachable URL and use `start --public-url <url>` or the dedicated server path in [Local self-hosting](local-self-hosting.md).

## Local Demo Setup

For a same-machine demo or CI smoke test, use loopback-only setup:

```bash
npx -y handoff-relay start --install-mcp codex --invite alice
```

## Add Handoff To Codex

Codex stores MCP configuration in `~/.codex/config.toml` by default, and trusted projects can use `.codex/config.toml`. The CLI and IDE extension share this config.

If you did not use `--install-mcp codex`, add this TOML:

```toml
[mcp_servers.handoff]
command = "npx"
args = ["-y", "handoff-relay", "server", "mcp", "--profile", "default", "--agent-approvals"]
startup_timeout_sec = 10
tool_timeout_sec = 60
enabled = true
```

In Codex, use `/mcp` to inspect active MCP servers.

`npx -y handoff-relay doctor` reports `WARN` when no supported MCP client config contains the profile-backed Handoff command. That warning means Handoff setup exists, but Codex has not been wired to use it yet.

## Invocation Pattern

```text
Use Handoff to package the current investigation context for @alice.
Include files touched, commands run, known failures, current hypothesis, evidence excerpts, and suggested next steps.
Draft with relay_share or relay_ask. Show me the Relay Packet and redaction report before sending.
If I approve, call relay_send_approved.
```

Recipient flow:

```text
Use Handoff to check my inbox.
Call relay_review_next and show me the Relay Packet and redaction report before hydration.
If I approve, call relay_hydrate_approved.
```

The installed profile-backed MCP entry uses agent-confirmed approvals. After Codex shows you the packet, your explicit "send" or "hydrate" instruction lets it call `relay_send_approved` or `relay_hydrate_approved` without a pasted token. Approval secrets stay out of Codex config and tool schemas.

Strict approval tokens remain available when you intentionally run MCP without `--agent-approvals`:

```bash
npx -y handoff-relay approval-token <packet-id> --action send
npx -y handoff-relay approval-token <packet-id> --action hydrate
```

The command uses your active Handoff profile and asks for a local confirmation phrase. Do not put approval secrets in Codex config.

## Remote Or Self-Hosted

For normal local/LAN use, keep the profile-backed command. For automation against a self-hosted server, explicit-auth compatibility mode remains available:

```toml
[mcp_servers.handoff]
command = "npx"
args = [
  "-y",
  "handoff-relay",
  "server",
  "mcp",
  "--server-url",
  "http://10.0.0.10:3737",
  "--explicit-auth"
]
startup_timeout_sec = 10
tool_timeout_sec = 60
enabled = true
```

In explicit-auth mode, MCP tool schemas include `authToken` and `workspaceId`. Prefer profile mode for day-to-day agent use.

## From A Local Checkout

```bash
pnpm install
pnpm build
```

```toml
[mcp_servers.handoff]
command = "node"
args = [
  "/absolute/path/to/handoff/dist/cli.js",
  "server",
  "mcp",
  "--profile",
  "default"
]
cwd = "/absolute/path/to/handoff"
startup_timeout_sec = 10
tool_timeout_sec = 60
enabled = true
```
