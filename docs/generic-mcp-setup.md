# Generic MCP Setup

Handoff is a stdio MCP server. Any MCP client that can launch a command with arguments can use it.

## Local Checkout

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

For a shared coordination server:

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

## Published Package

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

## Tool Contract

- `relay_ask`: draft an ask packet; returns `pending_sender_approval`.
- `relay_share`: draft a share packet; returns `pending_sender_approval`.
- `relay_update_draft`: edit a draft before sender approval.
- `relay_configure_project_alias`: maps a clone/repo alias to a canonical project name. Requires a workspace admin token.
- `relay_project_aliases`: lists workspace project/repo aliases.
- `relay_approve`: approves and sends ask/share packets, or approves reply packets. Requires a human approval token generated outside MCP.
- `relay_inbox`: lists packets addressed to the current member.
- `relay_status`: fetches a readable packet.
- `relay_view`: records a review view.
- `relay_accept`: records recipient acceptance before hydration.
- `relay_hydrate`: returns bounded context plus a hydration receipt. Requires a human hydration approval token generated outside MCP.
- `relay_reply`: drafts a reply packet; returns `pending_recipient_approval`.
- `relay_clarify`: requests more information or evidence from the sender after packet review.
- `relay_decline`: declines an addressed packet.
- `relay_archive`: archives a readable packet.
- `relay_search`: searches only permitted packet history and never hydrates results. Supports typed project, sender, recipient, status, file/symbol, and ticket/PR filters.
- `relay_history`: lists permitted packet history using `drafts`, `sent`, `open`, or `closed` filters plus the same typed filters as search.
- `relay_audit`: lists packet audit receipts, or workspace receipts for admins.

All tools require a Relay member token. Keep member tokens in your local MCP client config or local secret manager, not in committed project files.

Approval tokens are intentionally not exposed as MCP tools. Generate them through a local CLI/UI confirmation step; the command prompts for an exact phrase and requires the separate per-member approval secret before it asks the coordination API to mint the token:

```bash
node dist/cli.js approval-token <packet-id> --server-url http://127.0.0.1:3737 --token <member-token> --approval-secret <approval-secret> --action send
node dist/cli.js approval-token <packet-id> --server-url http://127.0.0.1:3737 --token <member-token> --approval-secret <approval-secret> --action hydrate
node dist/cli.js approval-token <reply-packet-id> --server-url http://127.0.0.1:3737 --token <member-token> --approval-secret <approval-secret> --action reply
```

You may set `AGENT_RELAY_APPROVAL_SECRET` in the terminal running approval commands instead of passing `--approval-secret`. Do not put approval secrets in MCP server config.

For clarification, ask the MCP client to call `relay_clarify` with the packet id, the clarification question, and optional `requestedEvidence` labels. This creates a structured clarification packet back to the sender.
