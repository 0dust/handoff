<div align="center">
  <p>
    <img alt="Handoff wordmark showing a reviewed packet moving between two coding-agent panes" src="https://raw.githubusercontent.com/0dust/handoff/main/assets/readme/handoff-relay-packet-wordmark.svg" width="760">
  </p>

  <p><strong>Human-approved context packets for coding agents.</strong></p>

  <p>Move only the selected context you approved from one teammate's coding agent to another.</p>
</div>

---

Handoff is a local-first MCP relay for structured Relay Packets. A sending agent drafts context, the sender reviews and approves it, the recipient reviews it, and only then does the recipient's agent hydrate bounded context into its own session.

It is not a chat room, passive team memory, or autonomous agent-to-agent channel.

## Quick Start

Host/admin:

```bash
npx -y handoff-relay start --lan --install-mcp codex --invite alice
```

Use `--install-mcp claude` for Claude Code or `--install-mcp cursor` for Cursor.

Teammate:

```bash
npx -y handoff-relay join <invite-link> --install-mcp codex
```

Check the setup:

```bash
npx -y handoff-relay doctor
```

After that, use Handoff inside your coding agent:

```text
Use Handoff to package this investigation for @alice.
Show me the Relay Packet and redaction report before sending.
If I approve, call relay_send_approved.
```

```text
Use Handoff to check my inbox.
Show me the next Relay Packet before hydration.
If I approve, call relay_hydrate_approved.
```

## What Handoff Protects

| Handoff protects | How                                                               |
| ---------------- | ----------------------------------------------------------------- |
| Scope            | Agents send selected packet fields instead of raw transcripts.    |
| Consent          | Sender approval before send, recipient approval before hydration. |
| Trust            | Claims are linked to evidence and audit receipts.                 |
| Secrets          | Redaction blocks secret-looking content by default.               |
| Ownership        | Teams self-host with local profiles and SQLite by default.        |

## Use With Agents

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

Codex TOML:

```toml
[mcp_servers.handoff]
command = "npx"
args = ["-y", "handoff-relay", "server", "mcp", "--profile", "default"]
startup_timeout_sec = 10
tool_timeout_sec = 60
enabled = true
```

Profile mode reads the active local Handoff profile. Agents do not need member tokens, workspace IDs, database paths, server URLs, or approval secrets in prompts or MCP schemas.

## Main MCP Tools

| Workflow | Tools                                                                          |
| -------- | ------------------------------------------------------------------------------ |
| Send     | `relay_share`, `relay_ask`, `relay_update_draft`, `relay_send_approved`        |
| Receive  | `relay_review_next`, `relay_hydrate_approved`, `relay_inbox`, `relay_review`   |
| Fallback | `relay_status`, `relay_view`, `relay_accept`, `relay_hydrate`, `relay_approve` |
| Reply    | `relay_reply`, `relay_send_approved`                                           |
| Triage   | `relay_clarify`, `relay_decline`, `relay_archive`                              |
| Search   | `relay_search`, `relay_history`, `relay_audit`                                 |
| Admin    | `relay_configure_project_alias`, `relay_project_aliases`                       |

## Approval Flow

Strict mode is the default:

```bash
npx -y handoff-relay approval-token <packet-id> --action send
npx -y handoff-relay approval-token <packet-id> --action hydrate
```

Optional agent-confirmed approvals are available for profile-backed MCP sessions:

```bash
npx -y handoff-relay server mcp --profile default --agent-approvals
```

In that mode, the MCP process requests the same short-lived approval token through the configured Handoff backend after the agent shows you the packet and you explicitly tell it to send, approve, or hydrate. Approval secrets stay out of MCP schemas and config.

## Demo

```bash
npx -y handoff-relay demo two-user --json
```

The demo exercises ask, share, reply, review, hydration, archive, and audit receipts in one local SQLite-backed flow.

## Links

- GitHub: https://github.com/0dust/handoff
- Codex setup: https://github.com/0dust/handoff/blob/main/docs/codex-setup.md
- Claude Code setup: https://github.com/0dust/handoff/blob/main/docs/claude-code-setup.md
- Generic MCP setup: https://github.com/0dust/handoff/blob/main/docs/generic-mcp-setup.md
- Security model: https://github.com/0dust/handoff/blob/main/docs/security-privacy.md
- Product Hunt launch kit: https://github.com/0dust/handoff/blob/main/docs/product-hunt-launch-kit.md
- Troubleshooting: https://github.com/0dust/handoff/blob/main/docs/troubleshooting.md
- License: MIT
