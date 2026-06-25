# handoff-relay

Human-approved context handoffs between coding agents.

Handoff lets Codex, Claude Code, Cursor, and other MCP-capable agents send bounded Relay Packets between teammates. An agent drafts the packet, a human reviews what leaves, the recipient reviews what arrives, and only then does their agent hydrate the selected context.

## Team Setup

On the host/admin machine, create a LAN-reachable workspace:

```bash
npx -y handoff-relay start --lan --install-mcp codex
npx -y handoff-relay watch
```

Create one invite per teammate:

```bash
npx -y handoff-relay invite alice
npx -y handoff-relay invite bob
```

Each teammate runs their own join command:

```bash
npx -y handoff-relay join http://<handoff-host>:3737/invite/<invite-token> --install-mcp codex
npx -y handoff-relay watch
```

Use `--install-mcp cursor` for Cursor. For Claude Code, run the printed `claude mcp add-json` command after `start` or `join`.

`start` creates the shared workspace, host profile, SQLite coordination database, reachable server URL, and MCP config when requested. `join` stores the teammate's local profile and member credentials. `watch` sends desktop/webhook-ready notifications when packets arrive.

## Use With Agents

Handoff is meant to run behind your coding agent as a stdio MCP server. The normal workflow happens inside the agent, not by manually copying CLI output around.

Profile-backed MCP command:

```bash
npx -y handoff-relay server mcp --profile default
```

MCP JSON:

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

Ask the sending agent:

```text
Use Handoff to create a Relay Packet for @alice from this session.
Include files touched, commands run, known failures, current hypothesis, evidence excerpts, and suggested next steps.
Draft with relay_share or relay_ask. Show me the packet summary, claims, evidence, expiry, and redaction report before sending.
If I approve, call relay_send_approved.
```

Ask the receiving agent:

```text
Check my Handoff inbox.
Call relay_review on the packet and show me the Relay Packet before hydration.
If I approve, call relay_hydrate_approved.
```

## Client Setup

Codex can be wired automatically while hosting or joining:

```bash
npx -y handoff-relay start --lan --install-mcp codex
npx -y handoff-relay join <invite-link> --install-mcp codex
```

Codex TOML:

```toml
[mcp_servers.handoff]
command = "npx"
args = ["-y", "handoff-relay", "server", "mcp", "--profile", "default"]
startup_timeout_sec = 10
tool_timeout_sec = 60
enabled = true
```

Claude Code:

```bash
claude mcp add-json handoff \
  '{"type":"stdio","command":"npx","args":["-y","handoff-relay","server","mcp","--profile","default"]}'
```

Cursor can be wired automatically while hosting or joining:

```bash
npx -y handoff-relay start --lan --install-mcp cursor
npx -y handoff-relay join <invite-link> --install-mcp cursor
```

Claude Desktop, Cursor, and other `mcpServers` clients can use the JSON config above.

## Human Approval

Strict approval is the default. Agents can draft, list, and read packets, but they need a human approval token before sending, hydrating, or approving a reply:

```bash
npx -y handoff-relay approval-token <packet-id> --action send
npx -y handoff-relay approval-token <packet-id> --action hydrate
npx -y handoff-relay approval-token <reply-packet-id> --action reply
```

For local profile-backed sessions, you can opt into agent-confirmed approvals:

```bash
npx -y handoff-relay server mcp --profile default --agent-approvals
```

With that flag, the MCP process requests the short-lived approval token through the configured Handoff backend after the agent shows you the packet and you explicitly tell it to send, approve, or hydrate. Local/LAN profiles with a running server URL use that local Handoff API instead of writing SQLite directly from the agent process; remote profiles use the configured Handoff server API.

## Optional CLI Install

You do not need a global install for MCP configs. `npx -y handoff-relay ...` is usually better because the MCP client can launch Handoff directly.

Install globally only if you want shorter local commands:

```bash
npm install -g handoff-relay
handoff doctor
```

`handoff-relay` is the npm package name. `handoff` is the installed CLI command.

Requires Node.js 20+.

## CLI Commands

```bash
handoff start [--lan] [--install-mcp codex|cursor]
handoff invite <handle>
handoff join <invite-link> [--install-mcp codex|cursor]
handoff leave
handoff remove-member <handle-or-id>
handoff doctor
handoff server mcp --profile default
handoff approval-token <packet-id> --action send|hydrate|reply
handoff inbox
handoff status <packet-id>
handoff history
handoff audit
handoff watch
handoff demo two-user
```

## MCP Tools

| Tool                     | Purpose                                                  |
| ------------------------ | -------------------------------------------------------- |
| `relay_ask`              | Draft an ask packet for another teammate.                |
| `relay_share`            | Draft a share packet from current context.               |
| `relay_update_draft`     | Edit a draft before approval.                            |
| `relay_send_approved`    | Approve and send an ask, share, or reply packet.         |
| `relay_inbox`            | List packets addressed to the current member.            |
| `relay_review`           | Mark a packet reviewed and return next actions.          |
| `relay_hydrate_approved` | Hydrate a reviewed packet after human approval.          |
| `relay_approve`          | Compatibility approval tool.                             |
| `relay_reply`            | Draft a reply packet.                                    |
| `relay_clarify`          | Request more information or evidence.                    |
| `relay_decline`          | Decline an addressed packet.                             |
| `relay_archive`          | Archive a readable packet.                               |
| `relay_search`           | Search permitted packet history without hydration.       |
| `relay_history`          | List drafts, sent packets, open work, or closed packets. |
| `relay_audit`            | List packet audit receipts.                              |

## Links

- GitHub: https://github.com/0dust/handoff
- Codex setup: https://github.com/0dust/handoff/blob/main/docs/codex-setup.md
- Claude Code setup: https://github.com/0dust/handoff/blob/main/docs/claude-code-setup.md
- Generic MCP setup: https://github.com/0dust/handoff/blob/main/docs/generic-mcp-setup.md
- Troubleshooting: https://github.com/0dust/handoff/blob/main/docs/troubleshooting.md
- License: MIT
