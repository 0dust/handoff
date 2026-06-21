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
npx -y handoff-relay start --lan
```

This creates:

- the Handoff workspace
- the host/admin member
- the SQLite coordination database
- a reachable server URL for teammates on the network
- a local profile for the host

Check it:

```bash
npx -y handoff-relay doctor
```

If the host also wants to use Handoff from Codex or Cursor, install MCP during start:

```bash
npx -y handoff-relay start --lan --install-mcp codex
# or
npx -y handoff-relay start --lan --install-mcp cursor
```

Claude Code setup is shown in [Agent setup](#agent-setup).

### 2. Invite Teammates

The host/admin creates one invite per teammate:

```bash
npx -y handoff-relay invite alice
npx -y handoff-relay invite bob
npx -y handoff-relay invite priya
```

Each invite prints a `join` command. Send each person their own command.

### 3. Members Join

Each teammate runs their invite command on their own machine:

```bash
npx -y handoff-relay join http://<handoff-host>:3737/invite/<invite-token>
```

This creates the teammate's local profile and stores their member credentials. It does not replace MCP setup. The teammate still needs their coding agent connected to Handoff.

Members using Codex or Cursor can install MCP while joining:

```bash
npx -y handoff-relay join <invite-link> --install-mcp codex
# or
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
npx -y handoff-relay start --lan --install-mcp codex

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

Handoff prints the profile-backed MCP command after `start` or `join`:

```bash
npx -y handoff-relay server mcp --profile default
```

Add it to Claude Code:

```bash
claude mcp add-json handoff \
  '{"type":"stdio","command":"npx","args":["-y","handoff-relay","server","mcp","--profile","default"]}'
```

Or use MCP JSON:

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
npx -y handoff-relay start --lan --install-mcp cursor

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
2. Start a reachable team workspace with `start --lan`.
3. If I use Codex, install MCP with `start --lan --install-mcp codex`.
   If I use Cursor, install MCP with `start --lan --install-mcp cursor`.
   If I use Claude Code, show me the `claude mcp add-json` command.
4. Invite each teammate I name and give me their exact join commands.
5. Run `doctor`.
6. Confirm whether my coding agent can see the Handoff MCP tools. Do not call setup complete until MCP is wired.
```

### Member Prompt

```text
Set up my machine as a Handoff team member.

1. Use `npx -y handoff-relay`, or build this local checkout and use `node /path/to/handoff/dist/cli.js`.
2. Run the join command my teammate sent me.
3. If I use Codex, add `--install-mcp codex` to the join command.
   If I use Cursor, add `--install-mcp cursor` to the join command.
   If I use Claude Code, show me the `claude mcp add-json` command after join succeeds.
4. Run `doctor`.
5. Confirm whether my coding agent can see the Handoff MCP tools. Do not call setup complete until MCP is wired.
```

## Using Handoff

The human talks to their coding agent. The agent uses Handoff MCP tools.

Sender:

```text
Use Handoff to package this investigation for @bob.
Include files touched, commands run, known failures, current hypothesis, evidence excerpts, and suggested next steps.
Show me the Relay Packet before sending.
```

Recipient:

```text
Use Handoff to check my inbox.
Show me the packet before hydration.
Wait for my approval before calling relay_hydrate.
```

Handoff MCP tools include:

| Tool                            | Purpose                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------- |
| `relay_share`                   | Draft a handoff packet with selected context, findings, evidence, and next steps. |
| `relay_ask`                     | Draft a handoff packet that includes a question for the recipient.                |
| `relay_update_draft`            | Edit a draft before sender approval.                                              |
| `relay_approve`                 | Send a packet or approve a reply after human review.                              |
| `relay_inbox`                   | List packets addressed to the current member.                                     |
| `relay_status`                  | Fetch the latest readable packet status.                                          |
| `relay_view`                    | Record that a packet was opened for review.                                       |
| `relay_accept`                  | Accept a packet before hydration.                                                 |
| `relay_hydrate`                 | Return bounded context and record a hydration receipt.                            |
| `relay_reply`                   | Draft a reply packet.                                                             |
| `relay_clarify`                 | Request missing evidence or context.                                              |
| `relay_decline`                 | Decline an addressed packet.                                                      |
| `relay_archive`                 | Archive a readable packet.                                                        |
| `relay_search`                  | Search permitted packet history without hydrating results.                        |
| `relay_history`                 | List drafts, sent packets, open work, or closed packets.                          |
| `relay_audit`                   | List packet or workspace audit receipts.                                          |
| `relay_configure_project_alias` | Map a repo or clone alias to a canonical project.                                 |
| `relay_project_aliases`         | List configured project aliases.                                                  |

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

In that mode, your agent may call `relay_approve` or `relay_hydrate` without a pasted token after it shows you the packet and you tell it to send, approve, or hydrate. The MCP process requests and consumes the same short-lived approval token through the configured Handoff backend. Local database profiles keep that request local; remote profiles send the approval secret to the configured Handoff server API. Approval secrets stay out of MCP schemas and config.

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

## Commands Are Support Plumbing

The CLI exists for setup, invites, admin operations, approval tokens, health checks, and automation. Normal teammate handoff should happen through MCP tools inside the coding agent.

Common operational commands:

```bash
handoff start
handoff invite
handoff join
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
