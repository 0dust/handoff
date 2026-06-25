<div align="center">

# Handoff

  <p><strong>Human-approved context handoffs between coding agents.</strong></p>

  <p>Move selected investigation context from one teammate's agent to another teammate's agent without dumping raw transcripts into Slack.</p>

  <p>
    MCP server | team workspace | local profiles | explicit approvals | audit receipts
  </p>

  <p>
    <img alt="Node 20 plus" src="https://img.shields.io/badge/node-20%2B-4b5563">
    <img alt="MCP stdio" src="https://img.shields.io/badge/MCP-stdio-5f5a4f">
    <img alt="Self hosted" src="https://img.shields.io/badge/self--hosted-SQLite-2f7d5b">
    <img alt="License MIT" src="https://img.shields.io/badge/license-MIT-3f3a36">
  </p>

  <p>
    <a href="#quick-start">Quick start</a> |
    <a href="#mental-model">Mental model</a> |
    <a href="#team-setup">Team setup</a> |
    <a href="#agent-setup">Agent setup</a> |
    <a href="#using-handoff">Using Handoff</a> |
    <a href="#security-model">Security model</a>
  </p>
</div>

---

Handoff is not a chat room and it is not a manual CLI handoff tool. The normal workflow happens inside Codex, Claude Code, Cursor, or another MCP-capable coding agent.

An agent drafts a structured Relay Packet from the current session. A human reviews and approves what leaves. The recipient's agent reads the packet, the recipient reviews it, and only then hydrates bounded context into their own session.

```text
Alice's Codex session
  -> selected investigation context
  -> human-reviewed Relay Packet
  -> Bob's Claude Code inbox
  -> Bob reviews and approves hydration
  -> Bob's agent continues with bounded context
```

## Quick Start

Most people need one setup command and one notification command.

Host/admin on the machine that will host the workspace:

```bash
npx -y handoff-relay start --lan --install-mcp codex --invite alice
npx -y handoff-relay watch
```

Use `--install-mcp claude` for Claude Code or `--install-mcp cursor` for Cursor.

Add more teammates later with `invite`:

```bash
npx -y handoff-relay invite bob
```

Rerunning `start --invite alice` or `invite alice` before Alice joins reprints the same active invite instead of creating a confusing duplicate.

Each teammate runs the join command from their invite:

```bash
npx -y handoff-relay join <invite-link> --install-mcp codex
npx -y handoff-relay watch
```

After that, use Handoff inside the agent. The sender path is `relay_share` or `relay_ask` -> human review -> `relay_send_approved`. The recipient path is `relay_review_next` -> human review -> `relay_hydrate_approved`.

## Mental Model

A team has one shared Handoff workspace and many local member profiles.

```text
One reachable Handoff server/workspace
15 teammates with local profiles
15 coding agents connected through MCP
Many addressed handoff packets between members
```

There are two roles:

| Role                 | Who does it                                                 | What they do                                                                                                       |
| -------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Workspace host/admin | One person, a dev box, or a small internal server           | Hosts the reachable Handoff server, creates the workspace, and invites members.                                    |
| Member/user          | Every teammate, including the host if they also use Handoff | Joins the workspace, configures their coding agent through MCP, sends and receives handoffs from inside the agent. |

The host can also be a normal member. Hosting is an extra responsibility, not a separate kind of user.

For a 15-person team, one host/admin sets up the workspace once. All 15 teammates, including the host if they want to use Handoff personally, need their own local profile and MCP setup.

## Team Setup

### 1. Host The Workspace

Pick the machine that will host Handoff. For a small team this can be a teammate's machine on the LAN. For a more reliable team setup, use a stable internal host or VPN-reachable machine.

On the host:

```bash
npx -y handoff-relay start --lan --install-mcp codex --invite alice --invite bob
npx -y handoff-relay watch
```

This creates:

- the Handoff workspace
- the host/admin member
- the SQLite coordination database
- a reachable server URL for teammates on the network
- a local profile for the host
- an MCP config when `--install-mcp codex`, `--install-mcp claude`, or `--install-mcp cursor` is used
- desktop/webhook-ready notification watching with `watch`

Check it:

```bash
npx -y handoff-relay doctor
```

If the host uses Cursor instead of Codex:

```bash
npx -y handoff-relay start --lan --install-mcp cursor --invite alice
```

Claude Code setup is shown in [Agent setup](#agent-setup).

### 2. Invite More Teammates

Use `--invite <handle>` during `start` for the people you already know. Add more teammates later with:

```bash
npx -y handoff-relay invite priya
```

Each invite prints a `join` command. Send each person their own command.

### 3. Members Join

Each teammate runs their invite command on their own machine:

```bash
npx -y handoff-relay join http://<handoff-host>:3737/invite/<invite-token> --install-mcp codex
npx -y handoff-relay watch
```

This creates the teammate's local profile, stores member credentials, wires MCP for Codex, and starts visible packet notifications.

Members using Cursor can swap the MCP install flag:

```bash
npx -y handoff-relay join <invite-link> --install-mcp cursor
```

After joining:

```bash
npx -y handoff-relay doctor
```

`doctor` may show `WARN mcp_config` when the profile and server work but the coding agent is not wired to Handoff yet. That warning means setup is not complete for real product use.

## Agent Setup

Handoff is ready when the user's coding agent can see the Handoff MCP tools. The CLI creates profiles and handles approvals, but the handoff workflow itself belongs in the agent.

### Codex

Install automatically when hosting or joining:

```bash
# host/admin who also uses Codex
npx -y handoff-relay start --lan --install-mcp codex --invite alice

# teammate joining with Codex
npx -y handoff-relay join <invite-link> --install-mcp codex
```

The MCP entry looks like:

```toml
[mcp_servers.handoff]
command = "npx"
args = ["-y", "handoff-relay", "server", "mcp", "--profile", "default"]
startup_timeout_sec = 10
tool_timeout_sec = 60
enabled = true
```

More detail: [docs/codex-setup.md](docs/codex-setup.md).

### Claude Code

Install automatically when hosting or joining:

```bash
# host/admin who also uses Claude Code
npx -y handoff-relay start --lan --install-mcp claude --invite alice

# teammate joining with Claude Code
npx -y handoff-relay join <invite-link> --install-mcp claude
```

The user-scoped Claude Code entry is written to `~/.claude.json` and looks like:

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

More detail: [docs/claude-code-setup.md](docs/claude-code-setup.md).

### Cursor

Install automatically when hosting or joining:

```bash
# host/admin who also uses Cursor
npx -y handoff-relay start --lan --install-mcp cursor --invite alice

# teammate joining with Cursor
npx -y handoff-relay join <invite-link> --install-mcp cursor
```

More detail: [docs/generic-mcp-setup.md](docs/generic-mcp-setup.md).

### Other MCP Clients

Any MCP client that can launch a stdio command can use:

```bash
npx -y handoff-relay server mcp --profile default
```

Profile mode reads the active local Handoff profile. Agents do not need member tokens, workspace IDs, database paths, server URLs, or approval secrets in prompts or MCP schemas.

## Ask An Agent To Set It Up

Most users should give these instructions to their coding agent instead of wiring the files by hand.

If the npm package is live, the agent can use `npx -y handoff-relay`. If testing from a local checkout:

```bash
cd /path/to/handoff
pnpm install
pnpm build
```

Then use `node /path/to/handoff/dist/cli.js` anywhere the examples say `npx -y handoff-relay`.

### Host/Admin Prompt

```text
Set up Handoff as the host/admin for my team.

1. Use `npx -y handoff-relay`, or build this local checkout and use `node /path/to/handoff/dist/cli.js`.
2. Start a reachable team workspace with `start --lan --install-mcp codex --invite <teammate>`, repeating `--invite` for each teammate I name.
3. If I use Cursor, use `start --lan --install-mcp cursor --invite <teammate>` instead.
   If I use Claude Code, use `start --lan --install-mcp claude --invite <teammate>` instead.
4. Start packet notifications with `watch`.
5. Give me the exact join command printed for each teammate.
6. Run `doctor`.
7. Confirm whether my coding agent can see `relay_share`, `relay_send_approved`, `relay_review_next`, and `relay_hydrate_approved`. Do not call setup complete until MCP is wired.
```

### Member Prompt

```text
Set up my machine as a Handoff team member.

1. Use `npx -y handoff-relay`, or build this local checkout and use `node /path/to/handoff/dist/cli.js`.
2. Run the join command my teammate sent me with `--install-mcp codex`.
3. If I use Cursor, use `--install-mcp cursor` instead.
   If I use Claude Code, use `--install-mcp claude` instead.
4. Start packet notifications with `watch`.
5. Run `doctor`.
6. Confirm whether my coding agent can see `relay_review_next` and `relay_hydrate_approved`. Do not call setup complete until MCP is wired.
```

## Using Handoff

The human talks to their coding agent. The agent uses Handoff MCP tools.

Sender prompt:

```text
Use Handoff to package this investigation for @bob.
Include files touched, commands run, known failures, current hypothesis, evidence excerpts, and suggested next steps.
Draft with relay_share or relay_ask. Show me the Relay Packet and redaction report before sending.
If I approve, call relay_send_approved.
```

Recipient prompt:

```text
Use Handoff to check my inbox.
Call relay_review_next, then show me the Relay Packet and redaction report.
If I approve, call relay_hydrate_approved.
```

Keep notifications running in a terminal:

```bash
npx -y handoff-relay watch
```

Handoff MCP tools are grouped by workflow:

| Workflow | Tools                                                                          |
| -------- | ------------------------------------------------------------------------------ |
| Send     | `relay_share`, `relay_ask`, `relay_update_draft`, `relay_send_approved`        |
| Receive  | `relay_review_next`, `relay_hydrate_approved`, `relay_inbox`, `relay_review`   |
| Fallback | `relay_status`, `relay_view`, `relay_accept`, `relay_hydrate`, `relay_approve` |
| Reply    | `relay_reply`, `relay_send_approved`                                           |
| Triage   | `relay_clarify`, `relay_decline`, `relay_archive`                              |
| Search   | `relay_search`, `relay_history`, `relay_audit`                                 |
| Admin    | `relay_configure_project_alias`, `relay_project_aliases`                       |

The fallback tools are still available for automation and compatibility. New agents should prefer the send and receive recipes above.

## Approval Flow

Handoff supports two approval modes.

Strict mode is the default. Agents can draft and read handoff packets, but they cannot mint approval tokens.

When your agent asks for a send, hydrate, or reply approval token, generate it in a local terminal:

```bash
npx -y handoff-relay approval-token <packet-id> --action send
npx -y handoff-relay approval-token <packet-id> --action hydrate
npx -y handoff-relay approval-token <reply-packet-id> --action reply
```

Paste the short-lived approval token back into the agent instruction. This is a human approval gate, not the handoff mechanism itself.

Agent-confirmed mode is optional for profile-backed MCP sessions. Start MCP with `--agent-approvals`:

```bash
npx -y handoff-relay server mcp --profile default --agent-approvals
```

In that mode, your agent may call `relay_send_approved` or `relay_hydrate_approved` without a pasted token after it shows you the packet and you tell it to send, approve, or hydrate. The MCP process requests and consumes the same short-lived approval token through the configured Handoff backend. Local/LAN profiles with a running server URL use that local Handoff API instead of writing SQLite directly from the agent process; remote profiles use the configured Handoff server API. Approval secrets stay out of MCP schemas and config.

## Packet Shape

A Relay Packet keeps context structured instead of dumping a transcript:

```json
{
  "packet_type": "share",
  "title": "Auth refresh handoff",
  "summary": "The refresh-token retry path still returns 401 after rotation.",
  "finding": "The retry path appears to skip persistence before the second request.",
  "source_client": "codex",
  "files_or_symbols": ["src/auth/refresh.ts", "refreshSession"],
  "commands_or_tests_run": ["pnpm test auth-refresh"],
  "what_was_tried": ["Checked token expiry math", "Re-ran the refresh integration test"],
  "known_failures": ["expected 200 received 401"],
  "current_hypothesis": "Refresh persistence ordering issue.",
  "suggested_next_steps": ["Trace where the rotated token is written before retry"]
}
```

Full schema notes: [docs/packet-schema.md](docs/packet-schema.md).

## Security Model

- Sender approval is required before ask/share packets leave the sender.
- Recipient acceptance and approval are required before ask/share packets hydrate.
- Reply approval is required before recipient-agent output returns to the sender.
- Strict mode requires manual approval tokens; optional agent-confirmed mode lets profile-backed MCP request those tokens after explicit user instruction.
- Approval secrets are not exposed through MCP schemas or config.
- Member tokens and approval secrets are stored outside profile metadata.
- Secret-looking content blocks sending by default.
- Raw transcripts are not shared by default.
- Packet access is enforced in the service and storage layer, not only in MCP filtering.
- Audit and hydration receipts record packet movement.

More detail: [docs/security-privacy.md](docs/security-privacy.md).

## Operating A Team Workspace

For a small team, `start --lan` is the fastest way to host on the same network. For a more durable team setup, run Handoff on a stable internal host:

```bash
npx -y handoff-relay server start \
  --db /srv/handoff/relay.db \
  --host 10.0.0.10 \
  --port 3737
```

See [Local self-hosting](docs/local-self-hosting.md) and [Advanced manual setup](docs/advanced-manual-setup.md).

## Leaving Or Removing Members

Members can leave from their own machine:

```bash
npx -y handoff-relay leave
```

The command revokes the member server-side first, then removes the local profile and credentials. If it is interrupted after the server revoke, rerunning `leave` finishes local cleanup.

Hosts/admins can remove a teammate by handle or member id:

```bash
npx -y handoff-relay remove-member alice
npx -y handoff-relay remove-member mem_...
```

Removal is a soft revoke, so historical packets and audit receipts keep their member references. Re-running the command is safe and does not change the original removal time.

## Commands Are Support Plumbing

The CLI exists for setup, invites, admin operations, approval tokens, health checks, and automation. Normal teammate handoff should happen through MCP tools inside the coding agent.

Common operational commands:

```bash
handoff start
handoff invite
handoff join
handoff leave
handoff remove-member <handle-or-id>
handoff doctor
handoff server status
handoff server stop
handoff server mcp
handoff approval-token
handoff watch
```

## Docs

- [Codex setup](docs/codex-setup.md)
- [Claude Code setup](docs/claude-code-setup.md)
- [Generic MCP setup](docs/generic-mcp-setup.md)
- [Local self-hosting](docs/local-self-hosting.md)
- [Advanced manual setup](docs/advanced-manual-setup.md)
- [Packet schema](docs/packet-schema.md)
- [Security and privacy model](docs/security-privacy.md)
- [Troubleshooting](docs/troubleshooting.md)

## Run From Source

Use this path when developing Handoff itself:

```bash
pnpm install
pnpm build
pnpm check
```

The package ships `dist`, top-level docs, examples, fixtures, and this README.

## Current Limits

- Handoff does not provide a hosted cloud service. You host the workspace/server.
- Slack is not a first-class adapter. Handoff is meant to replace raw paste/chat handoff with structured agent-to-agent context transfer.
- Literal client-specific slash command registration is not shipped. Use MCP tools and optional local command templates in your client.
- SQLite is the default storage for local/self-hosted teams. Postgres is intentionally left as a future storage adapter.
- Handoff does not passively capture sessions, build a team memory index, or apply another teammate's patch automatically.

## License

MIT.
