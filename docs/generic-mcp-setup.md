# Generic MCP Setup

Handoff is a stdio MCP server. Any MCP client that can launch a command with arguments can use it.

## Team Setup

On Sam's machine, host a LAN-reachable workspace:

```bash
npx -y handoff-relay start --lan
npx -y handoff-relay invite alice
npx -y handoff-relay doctor
```

On Alice's machine, run the invite command Sam sends her:

```bash
npx -y handoff-relay join http://<sam-lan-ip>:3737/invite/<invite-token>
npx -y handoff-relay doctor
```

Alice does not run `start` for Sam's workspace. `join` accepts the invite, stores Alice's local profile and credentials, and prints the same profile-backed MCP command for her MCP client.

Handoff can write MCP config for Codex and Cursor when you ask explicitly:

```bash
npx -y handoff-relay start --lan --install-mcp codex
npx -y handoff-relay start --lan --install-mcp cursor
npx -y handoff-relay join <invite-link> --install-mcp codex
npx -y handoff-relay join <invite-link> --install-mcp cursor
```

For Claude Code and other MCP clients, use the printed profile-backed command. `doctor` reports `WARN` until it detects a supported Codex, Claude Code, or Cursor config that already includes Handoff profile mode.

For same-machine demos or CI smoke tests, plain `start` remains available, but its invite links are loopback-only.

## Profile-Backed Config

Use profile mode for normal agent sessions:

```json
{
  "mcpServers": {
    "handoff": {
      "command": "npx",
      "args": ["-y", "handoff-relay", "server", "mcp", "--profile", "default"]
    }
  }
}
```

In this mode, Handoff injects the member token and workspace ID from the local profile. Normal MCP tool schemas omit `authToken` and `workspaceId`. Approval secrets are never exposed through MCP.

Strict approval remains the default. If you want the local agent session to treat your explicit chat instruction as approval, add `--agent-approvals`:

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

With that flag, the MCP process requests and consumes short-lived approval tokens through the configured Handoff backend after the agent shows you the packet and you explicitly tell it to send, approve, or hydrate. Local database profiles keep that request local; remote profiles send the approval secret to the configured Handoff server API.

## Cursor

In Cursor, open Settings > Tools & MCP and add a new MCP server, or create `.cursor/mcp.json` for a project-scoped setup or `~/.cursor/mcp.json` for a global setup:

```bash
npx -y handoff-relay start --lan --install-mcp cursor
npx -y handoff-relay join <invite-link> --install-mcp cursor
```

```json
{
  "mcpServers": {
    "handoff": {
      "command": "npx",
      "args": ["-y", "handoff-relay", "server", "mcp", "--profile", "default"]
    }
  }
}
```

Then ask Cursor Agent:

```text
Use Handoff to package the current investigation context for @alice.
Show me the Relay Packet before sending.
```

## LAN And Remote Profiles

For a same-network team setup:

```bash
npx -y handoff-relay start --lan
npx -y handoff-relay invite alice
```

For remote/self-hosted setups, users should `join` an invite link from that server. The saved profile records the remote server URL, so the MCP command stays the same:

```bash
npx -y handoff-relay server mcp --profile default
```

## Explicit-Auth Compatibility

For advanced scripts and tests that intentionally pass auth through tool inputs:

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

Explicit-auth mode exposes `authToken` and `workspaceId` in schemas. Do not put approval secrets in config.

## Tool Contract

- `relay_ask`: draft an ask packet; returns `pending_sender_approval`.
- `relay_share`: draft a share packet; returns `pending_sender_approval`.
- `relay_update_draft`: edit a draft before sender approval.
- `relay_configure_project_alias`: maps a clone/repo alias to a canonical project name.
- `relay_project_aliases`: lists workspace project/repo aliases.
- `relay_approve`: approves and sends ask/share packets, or approves reply packets. Requires a human approval token unless profile-backed MCP started with `--agent-approvals`.
- `relay_inbox`: lists packets addressed to the current member.
- `relay_status`: fetches a readable packet.
- `relay_view`: records a review view.
- `relay_accept`: records recipient acceptance before hydration.
- `relay_hydrate`: returns bounded context plus a hydration receipt. Requires a human hydration approval token unless profile-backed MCP started with `--agent-approvals`.
- `relay_reply`: drafts a reply packet; returns `pending_recipient_approval`.
- `relay_clarify`: requests more information or evidence from the sender after packet review.
- `relay_decline`: declines an addressed packet.
- `relay_archive`: archives a readable packet.
- `relay_search`: searches only permitted packet history and never hydrates results.
- `relay_history`: lists drafts, sent packets, open work, or closed packets with typed filters.
- `relay_audit`: lists packet audit receipts, or workspace receipts for admins.

In strict mode, generate approval tokens through the local CLI:

```bash
npx -y handoff-relay approval-token <packet-id> --action send
npx -y handoff-relay approval-token <packet-id> --action hydrate
npx -y handoff-relay approval-token <reply-packet-id> --action reply
```
