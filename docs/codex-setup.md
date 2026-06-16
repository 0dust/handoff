# Codex Setup

Handoff exposes a stdio MCP server and a CLI fallback. Codex configuration supports MCP server entries in `config.toml`; OpenAI's current docs describe user-level config at `~/.codex/config.toml`, project-scoped `.codex/config.toml`, and MCP server keys such as `command`, `cwd`, `env`, `startup_timeout_sec`, and `tool_timeout_sec`. Official reference: [Codex config basics](https://developers.openai.com/codex/config-basic) and [Codex configuration reference](https://developers.openai.com/codex/config-reference).

## Published Package Form

Add this to your trusted Codex config:

```toml
[mcp_servers.handoff]
command = "npx"
args = ["-y", "@0dust/handoff", "server", "mcp", "--db", "/absolute/path/to/relay.db"]
startup_timeout_sec = 10
tool_timeout_sec = 60
```

For a shared coordination server:

```toml
[mcp_servers.handoff]
command = "npx"
args = ["-y", "@0dust/handoff", "server", "mcp", "--server-url", "http://127.0.0.1:3737"]
startup_timeout_sec = 10
tool_timeout_sec = 60
```

## From A Local Checkout

```bash
pnpm install
pnpm build
```

Add this to your trusted Codex config:

```toml
[mcp_servers.handoff]
command = "node"
args = [
  "/absolute/path/to/handoff/dist/cli.js",
  "server",
  "mcp",
  "--db",
  "/absolute/path/to/relay.db"
]
cwd = "/absolute/path/to/handoff"
startup_timeout_sec = 10
tool_timeout_sec = 60
```

For a shared coordination server:

```toml
[mcp_servers.handoff]
command = "node"
args = [
  "/absolute/path/to/handoff/dist/cli.js",
  "server",
  "mcp",
  "--server-url",
  "http://127.0.0.1:3737"
]
startup_timeout_sec = 10
tool_timeout_sec = 60
```

## Invocation Pattern

Codex does not need a custom slash command to use Relay. Ask Codex to call MCP tools:

```text
Use Handoff to create a context handoff packet for @alice from this session.
Include files touched, commands run, known failures, current hypothesis, evidence excerpts, and suggested next steps.
Do not send it until I approve the Relay packet.
```

Then approve:

```text
Send the drafted Relay packet after showing me the redaction report.
```

Generate the required approval token outside MCP, then paste it into the Codex instruction:

```bash
node dist/cli.js approval-token <packet-id> --server-url http://127.0.0.1:3737 --token <your-token> --approval-secret <your-approval-secret> --action send
```

The command uses the local approval renderer, asks you to type an exact confirmation phrase, and requires the separate approval secret returned during workspace/member setup. Codex should never call an MCP tool to mint approval tokens, and approval secrets should not be placed in MCP config.

Recipient flow:

```text
Check my Handoff inbox, show me any packets, and wait for my approval before hydration.
```

Reply flow:

```text
Draft a Relay reply to <packet-id>. Show me the answer and evidence before approving the reply.
```

Clarification flow:

```text
Request clarification on <packet-id>: ask for the failing assertion and token payload evidence.
```

CLI fallback is always available:

```bash
node dist/cli.js inbox --db .relay/team.db --token <token> --workspace <workspace-id>
node dist/cli.js history --db .relay/team.db --token <token> --workspace <workspace-id> --filter open
node dist/cli.js audit --db .relay/team.db --token <token> --workspace <workspace-id> --packet <packet-id>
node dist/cli.js approval-token <packet-id> --db .relay/team.db --token <token> --approval-secret <approval-secret> --action hydrate
node dist/cli.js hydrate <packet-id> --db .relay/team.db --token <token> --client codex --approval-token <approval-token>
```
