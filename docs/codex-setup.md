# Codex Setup

Handoff runs as a local stdio MCP server. Run setup first:

```bash
npx -y @0dust/handoff start
npx -y @0dust/handoff doctor
```

To let Handoff write a global Codex MCP entry, run:

```bash
npx -y @0dust/handoff start --install-mcp codex
```

For a teammate on the same Wi-Fi:

```bash
npx -y @0dust/handoff start --lan
npx -y @0dust/handoff invite alice
```

## Add Handoff To Codex

Codex stores MCP configuration in `~/.codex/config.toml` by default, and trusted projects can use `.codex/config.toml`. The CLI and IDE extension share this config.

If you did not use `--install-mcp codex`, add this TOML:

```toml
[mcp_servers.handoff]
command = "npx"
args = ["-y", "@0dust/handoff", "server", "mcp", "--profile", "default"]
startup_timeout_sec = 10
tool_timeout_sec = 60
enabled = true
```

In Codex, use `/mcp` to inspect active MCP servers.

`npx -y @0dust/handoff doctor` reports `WARN` when no supported MCP client config contains the profile-backed Handoff command. That warning means Handoff setup exists, but Codex has not been wired to use it yet.

## Invocation Pattern

```text
Use Handoff to package the current investigation context for @alice.
Include files touched, commands run, known failures, current hypothesis, evidence excerpts, and suggested next steps.
Show me the Relay Packet and redaction report before sending.
```

Recipient flow:

```text
Use Handoff to check my inbox. Show me any Relay Packet before hydration.
Wait for my approval before calling relay_hydrate.
```

Approval tokens are generated outside MCP:

```bash
npx -y @0dust/handoff approval-token <packet-id> --action send
npx -y @0dust/handoff approval-token <packet-id> --action hydrate
```

The command uses your active Handoff profile and asks for a local confirmation phrase. Do not put approval secrets in Codex config.

## Remote Or Self-Hosted

For normal local/LAN use, keep the profile-backed command. For automation against a self-hosted server, explicit-auth compatibility mode remains available:

```toml
[mcp_servers.handoff]
command = "npx"
args = [
  "-y",
  "@0dust/handoff",
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
