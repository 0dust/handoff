# Claude Code Setup

Handoff runs as a local stdio MCP server near each user's Claude Code session. The shared workspace lives on the host machine or server; every teammate joins it into their own local profile.

## Team Setup

On Sam's machine, host a LAN-reachable workspace:

```bash
npx -y @0dust/handoff start --lan
npx -y @0dust/handoff invite alice
npx -y @0dust/handoff doctor
```

On Alice's machine, run the invite command Sam sends her:

```bash
npx -y @0dust/handoff join http://<sam-lan-ip>:3737/invite/<invite-token>
npx -y @0dust/handoff doctor
```

Alice does not run `start` for Sam's workspace. `join` accepts the invite, stores Alice's local profile and credentials, and prints the profile-backed MCP command for her Claude Code config.

If Alice is not on the same network, host Handoff behind a reachable URL and use `start --public-url <url>` or the dedicated server path in [Local self-hosting](local-self-hosting.md).

Handoff cannot safely edit every Claude Code config shape automatically, so setup prints the profile-backed command and the `claude mcp add-json` command below. `doctor` reports `WARN` until a supported MCP config contains that profile-backed command.

For same-machine demos or CI smoke tests, plain `start` remains available, but its invite links are loopback-only.

## Add Handoff To Claude Code

Claude Code can add MCP servers with `claude mcp add-json`, and it can load MCP config JSON with `--mcp-config`.

Add with the CLI:

```bash
claude mcp add-json handoff \
  '{"type":"stdio","command":"npx","args":["-y","@0dust/handoff","server","mcp","--profile","default"]}'
```

Or create `handoff.mcp.json`:

```json
{
  "mcpServers": {
    "handoff": {
      "command": "npx",
      "args": ["-y", "@0dust/handoff", "server", "mcp", "--profile", "default"]
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
Draft only. Show me the packet summary, claims, evidence, expiry, and redaction report before sending.
```

Before Claude calls `relay_approve`, generate a human approval token in a terminal:

```bash
npx -y @0dust/handoff approval-token <packet-id> --action send
```

Recipient side:

```text
Check my Handoff inbox. Show me the Relay Packet before hydration.
If I approve, hydrate it into this Claude Code session.
```

Hydration also needs a human approval token:

```bash
npx -y @0dust/handoff approval-token <packet-id> --action hydrate
```

Approval-token minting is deliberately outside MCP so Claude cannot draft and approve a packet with only a member token. Keep approval secrets out of MCP config.

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
        "@0dust/handoff",
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
