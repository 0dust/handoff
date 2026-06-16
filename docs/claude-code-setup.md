# Claude Code Setup

Handoff runs as a local stdio MCP server near Claude Code. The canonical behavior is exposed as MCP tools; literal `/ask` and `/share-with` slash command registration is client-specific and not required.

Claude Code's CLI supports loading MCP servers from JSON with `--mcp-config`, and the in-session `/mcp` command is the place to inspect or set up MCP servers. Official reference: [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference) and [Claude Code commands](https://code.claude.com/docs/en/commands).

## Published Package Form

Use `npx -y` so Claude Code can launch Handoff directly:

```json
{
  "mcpServers": {
    "handoff": {
      "command": "npx",
      "args": ["-y", "@0dust/handoff", "server", "mcp", "--db", "/absolute/path/to/relay.db"]
    }
  }
}
```

For a shared coordination server:

```json
{
  "mcpServers": {
    "handoff": {
      "command": "npx",
      "args": ["-y", "@0dust/handoff", "server", "mcp", "--server-url", "http://127.0.0.1:3737"]
    }
  }
}
```

## From A Local Checkout

```bash
pnpm install
pnpm build
```

Create `handoff.mcp.json`:

```json
{
  "mcpServers": {
    "handoff": {
      "command": "node",
      "args": [
        "/absolute/path/to/handoff/dist/cli.js",
        "server",
        "mcp",
        "--db",
        "/absolute/path/to/relay.db"
      ]
    }
  }
}
```

To use a shared coordination server instead of local SQLite:

```json
{
  "mcpServers": {
    "handoff": {
      "command": "node",
      "args": [
        "/absolute/path/to/handoff/dist/cli.js",
        "server",
        "mcp",
        "--server-url",
        "http://127.0.0.1:3737"
      ]
    }
  }
}
```

Start Claude Code with that config:

```bash
claude --mcp-config ./handoff.mcp.json
```

## Invocation Pattern

Ask Claude to create a handoff packet, then review the returned draft before approving:

```text
Use Handoff to create a context handoff packet for @alice from this session.
Include files touched, commands run, known failures, current hypothesis, evidence excerpts, and suggested next steps.
Draft only. Show me the packet summary, claims, evidence, expiry, and redaction report before sending.
```

Then:

```text
Approve that Handoff packet and send it.
```

Before Claude calls `relay_approve`, generate a human approval token in a terminal:

```bash
node dist/cli.js approval-token <packet-id> --server-url http://127.0.0.1:3737 --token <your-token> --approval-secret <your-approval-secret> --action send
```

The command asks you to type an exact local confirmation phrase and requires the separate approval secret returned during workspace/member setup. Approval-token minting is deliberately outside MCP so Claude cannot draft and approve a packet with only a member token.

Recipient side:

```text
Check my Handoff inbox. Show me the packet before hydration.
If I approve, hydrate it into this Claude Code session.
```

Hydration also needs a human approval token:

```bash
node dist/cli.js approval-token <packet-id> --server-url http://127.0.0.1:3737 --token <your-token> --approval-secret <your-approval-secret> --action hydrate
```

Reply side:

```text
Draft a Relay reply to <packet-id>. Show me the answer and evidence before sending it back.
```

Clarification side:

```text
Request clarification on <packet-id> and ask for the missing failing assertion evidence before hydration.
```

Claude Code slash commands are not necessary for the product contract. If your local Claude Code setup supports custom command templates, you can create wrappers that instruct Claude to call `relay_ask`, `relay_share`, and related MCP tools, but keep human review prompts in the template.

For debugging and review, Claude can call `relay_history` to list sent/open/closed/draft packets and `relay_audit` to inspect receipts. Keep approval secrets out of MCP config.
