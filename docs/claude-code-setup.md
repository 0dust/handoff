# Claude Code Setup

Handoff runs as a local stdio MCP server near each user's Claude Code session. The shared workspace lives on the host machine or server; every teammate joins it into their own local profile.

## Team Setup

On Sam's machine, host a LAN-reachable workspace:

```bash
npx -y handoff-relay start --lan --install-mcp claude --invite alice
```

On Alice's machine, run the invite command Sam sends her:

```bash
npx -y handoff-relay join http://<sam-lan-ip>:3737/invite/<invite-token> --install-mcp claude
```

Alice does not run `start` for Sam's workspace. `join` accepts the invite, stores Alice's local profile and credentials, and writes the profile-backed Claude Code MCP config when `--install-mcp claude` is present.

Both `start` and `join` start packet notifications automatically. To opt out later, run `npx -y handoff-relay watch --stop`.

To remove the Claude Code MCP entry without leaving the workspace, run:

```bash
npx -y handoff-relay uninstall-mcp --client claude
```

To leave the workspace and clean local profile, notification, and MCP state, run:

```bash
npx -y handoff-relay leave
```

If the workspace is unreachable and you only need local cleanup, run `npx -y handoff-relay delete-profile`.

If Alice is not on the same network, host Handoff behind a reachable URL and use `start --public-url <url>` or the dedicated server path in [Local self-hosting](local-self-hosting.md).

Handoff writes the user-scoped Claude Code MCP entry to `~/.claude.json`. `doctor` reports `WARN` until a supported MCP config contains the profile-backed command.

For same-machine demos or CI smoke tests, plain `start` remains available, but its invite links are loopback-only.

## Add Handoff To Claude Code Manually

Use this only when you did not pass `--install-mcp claude` or you prefer project-scoped config. Claude Code can add MCP servers with `claude mcp add-json`, and it can load MCP config JSON with `--mcp-config`.

Add with the CLI:

```bash
claude mcp add-json handoff \
  '{"type":"stdio","command":"npx","args":["-y","handoff-relay","server","mcp","--profile","default","--agent-approvals"]}'
```

Or create `handoff.mcp.json`:

```json
{
  "mcpServers": {
    "handoff": {
      "command": "npx",
      "args": ["-y", "handoff-relay", "server", "mcp", "--profile", "default", "--agent-approvals"]
    }
  }
}
```

Start Claude Code with that config:

```bash
claude --mcp-config ./handoff.mcp.json
```

Inside Claude Code, use `/mcp` to inspect server status.

## Invocation Pattern

Ask Claude to create a handoff packet, then review the returned draft before approving:

```text
Use Handoff to create a Relay Packet for @alice from this session.
Include files touched, commands run, known failures, current hypothesis, evidence excerpts, and suggested next steps.
Draft with relay_share or relay_ask. Show me the packet summary, claims, evidence, expiry, and redaction report before sending.
If I approve, call relay_send_approved.
```

The installed profile-backed MCP entry uses agent-confirmed approvals. After Claude shows you the packet, your explicit "send" or "hydrate" instruction lets it call `relay_send_approved` or `relay_hydrate_approved` without a pasted token.

In strict mode, before Claude calls `relay_send_approved`, generate a human approval token in a terminal:

```bash
npx -y handoff-relay approval-token <packet-id> --action send
```

Recipient side:

```text
Check my Handoff inbox.
Call relay_review_next and show me the Relay Packet before hydration.
If I approve, call relay_hydrate_approved.
```

Strict hydration also needs a human approval token:

```bash
npx -y handoff-relay approval-token <packet-id> --action hydrate
```

Strict approval-token minting is deliberately outside MCP so Claude cannot draft and approve a packet with only a member token. Keep approval secrets out of MCP config. To run strict mode manually, omit `--agent-approvals`:

```bash
npx -y handoff-relay server mcp --profile default
```

## Remote Or Self-Hosted

Profile mode is still preferred after `join` because the profile stores the server URL and credentials locally.

Explicit-auth compatibility mode remains available for automation:

```json
{
  "mcpServers": {
    "handoff": {
      "command": "npx",
      "args": [
        "-y",
        "handoff-relay",
        "server",
        "mcp",
        "--server-url",
        "http://10.0.0.10:3737",
        "--explicit-auth"
      ]
    }
  }
}
```

## From A Local Checkout

```bash
pnpm install
pnpm build
```

```json
{
  "mcpServers": {
    "handoff": {
      "command": "node",
      "args": ["/absolute/path/to/handoff/dist/cli.js", "server", "mcp", "--profile", "default"],
      "cwd": "/absolute/path/to/handoff"
    }
  }
}
```
