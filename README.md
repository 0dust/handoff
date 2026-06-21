<div align="center">

# Handoff

  <p><strong>Human-approved Relay Packet context handoffs between coding agents.</strong></p>

  <p>Package the useful context from one agent session so another coding agent can continue without rediscovery.</p>

  <p>
    MCP server | local-first profiles | SQLite coordination | explicit approvals | audit receipts
  </p>

  <p>
    <img alt="Node 20 plus" src="https://img.shields.io/badge/node-20%2B-4b5563">
    <img alt="MCP stdio" src="https://img.shields.io/badge/MCP-stdio-5f5a4f">
    <img alt="Self hosted" src="https://img.shields.io/badge/self--hosted-SQLite-2f7d5b">
    <img alt="License MIT" src="https://img.shields.io/badge/license-MIT-3f3a36">
  </p>

  <p>
    <a href="#quick-start">Quick start</a> |
    <a href="#use-it-from-your-agent">Use it from your agent</a> |
    <a href="#mcp-setup">MCP setup</a> |
    <a href="#security-defaults">Security defaults</a> |
    <a href="#commands">Commands</a>
  </p>
</div>

---

Coding agents still work in isolated sessions. When an engineer gets stuck or finishes an investigation, the useful context is trapped in one local session: files inspected, tests run, errors seen, hypotheses ruled out, and the current best next step.

Handoff turns selected session context into a Relay Packet: a reviewable handoff with summary, claims, evidence, files, commands, known failures, confidence, expiry, and provenance. The sender approves exactly what leaves their session. The recipient reviews the packet before hydrating it into Claude Code, Codex, Cursor, or another MCP-capable agent.

This is not chat between agents. `relay_share` and `relay_ask` create handoff packets. The wedge is bounded, auditable, human-approved context transfer.

```text
Sam's Codex session
  -> selected investigation context
  -> Relay Packet
  -> Alice reviews and hydrates
  -> Alice's Claude Code session continues from that context
```

## Quick Start

No global install is required.

```bash
# On your machine: create the workspace and local server
npx -y @0dust/handoff start

# On your machine: invite a teammate
npx -y @0dust/handoff invite alice

# On Alice's machine: accept the invite and create her local profile
npx -y @0dust/handoff join <invite-link>

# On each machine: check setup health
npx -y @0dust/handoff doctor
```

`start` creates a local Handoff profile, a local SQLite database, a workspace, an admin member, a secure credential file, and a profile-backed MCP command. It does not print member tokens, approval secrets, database paths, workspace IDs, or MCP auth arguments in the normal path.

Alice does not run `start` for your workspace. She needs Node 20+ with `npx`, the invite link/command you send her, and network access to the Handoff server URL inside that invite. `join` is her setup step: it accepts the invite, creates her local profile, stores her member credentials, and prints the MCP command for her agent client.

`doctor` may report `WARN` for `mcp_config` until you add Handoff to Codex, Claude Code, Cursor, or another MCP client. That warning means the local setup is healthy, but agent access has not been wired yet.

If you want Handoff to write an MCP config for a supported client, pass an explicit install target:

```bash
# choose the client you use
npx -y @0dust/handoff start --install-mcp codex
npx -y @0dust/handoff start --install-mcp cursor
npx -y @0dust/handoff join <invite-link> --install-mcp codex
npx -y @0dust/handoff join <invite-link> --install-mcp cursor
```

Plain `start` creates loopback-only invites for the same machine. Use LAN mode before inviting when Alice joins from another machine on the same network:

```bash
npx -y @0dust/handoff start --lan
npx -y @0dust/handoff invite alice
```

`invite alice` prints one copyable command:

```bash
npx -y @0dust/handoff join http://<host>:<port>/invite/<invite-token>
```

Opening the invite URL in a browser only shows the same join command. The invite is accepted only when the teammate runs `handoff join`.

## Use It From Your Agent

After MCP setup, ask your agent to package the current investigation:

```text
/share-with @alice
```

or:

```text
Use Handoff to package the current investigation context for @alice.
Show me the Relay Packet before sending.
```

For receiving:

```text
Use Handoff to check my inbox. Show me the packet before hydration.
Wait for my approval before calling relay_hydrate.
```

MCP tools use your active profile by default, so the agent does not need `authToken`, `workspaceId`, member tokens, approval secrets, DB paths, or server URLs in the prompt. Approval secrets are never exposed through MCP.

## MCP Setup

The setup command prints this profile-backed MCP command:

```bash
npx -y @0dust/handoff server mcp --profile default
```

Use it in your MCP client config.

`doctor` checks whether Codex, Claude Code, or Cursor config already contains that profile-backed command. If no supported client config is detected, setup can still be healthy, but `doctor` reports a `WARN` with the exact command to add.

### Codex

Codex stores MCP configuration in `~/.codex/config.toml` or trusted project-scoped `.codex/config.toml` files. You can also manage entries with `codex mcp`.

Automatic install for the default global Codex config:

```bash
npx -y @0dust/handoff start --install-mcp codex
```

```toml
[mcp_servers.handoff]
command = "npx"
args = ["-y", "@0dust/handoff", "server", "mcp", "--profile", "default"]
startup_timeout_sec = 10
tool_timeout_sec = 60
enabled = true
```

More detail: [docs/codex-setup.md](docs/codex-setup.md).

### Claude Code

Claude Code can load MCP servers from JSON with `--mcp-config`, and `claude mcp add-json` can install the same stdio server entry.

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

More detail: [docs/claude-code-setup.md](docs/claude-code-setup.md).

### Cursor

Cursor supports MCP server entries from Settings > Tools & MCP, and can also use JSON config such as `.cursor/mcp.json` or `~/.cursor/mcp.json`.

Automatic install for `~/.cursor/mcp.json`:

```bash
npx -y @0dust/handoff start --install-mcp cursor
```

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

### Generic MCP

Any MCP client that can launch a stdio subprocess can use the same command:

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

Advanced explicit-auth MCP mode remains available:

```bash
npx -y @0dust/handoff server mcp --server-url http://127.0.0.1:3737 --explicit-auth
```

More detail: [docs/generic-mcp-setup.md](docs/generic-mcp-setup.md).

## Approval Flow

Agents can draft, list, view, accept, hydrate, reply, search, and inspect audit receipts. They cannot mint approval tokens.

Generate approval tokens in a local terminal. In the normal profile-backed flow, no token or approval secret flags are needed:

```bash
npx -y @0dust/handoff approval-token <packet-id> --action send
npx -y @0dust/handoff approval-token <packet-id> --action hydrate
npx -y @0dust/handoff approval-token <reply-packet-id> --action reply
```

The command asks for an exact local confirmation phrase and returns a short-lived approval token. Paste that token back into the agent instruction when you want it to call `relay_approve` or `relay_hydrate`.

## Local, LAN, And Remote

Local-only setup:

```bash
npx -y @0dust/handoff start
```

LAN setup for teammates on the same Wi-Fi:

```bash
npx -y @0dust/handoff start --lan
npx -y @0dust/handoff invite alice
```

Running plain `start` later returns the profile to local-only invite links. Use `--lan` or pass a fresh `--public-url` again when you want new invites to leave the machine.

Remote or self-hosted setup still uses the existing low-level server and explicit flags. Keep that path for automation, custom hosting, and migration work:

- [Advanced manual setup](docs/advanced-manual-setup.md)
- [Local self-hosting](docs/local-self-hosting.md)

## Demo

Run the full local ask/share flow without any hosted service:

```bash
npx -y @0dust/handoff demo two-user --db .relay/demo.db
```

Expected shape:

```text
ask handoff   -> closed_resolved
reply handoff -> hydrated
share handoff -> archived
```

## What You Get

```text
selected session context
  -> Relay Packet
  -> sender approval
  -> recipient notification
  -> recipient review
  -> bounded hydration context
  -> audit and hydration receipts
```

| Output                            | Why it matters                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------- |
| Relay Packet                      | The product object is selected context, not chat or a raw transcript.            |
| Claims and evidence fields        | Recipients can judge what was observed, inferred, or still uncertain.            |
| Files, commands, failures, steps  | The receiving agent can continue the investigation without rediscovery.          |
| Human approval tokens             | Drafting and sending are separate, so an agent cannot silently cross a boundary. |
| Receiver-controlled hydration     | Nothing enters another agent context until the recipient accepts it.             |
| Audit and hydration receipts      | Teams can inspect who sent, viewed, accepted, hydrated, replied, and closed.     |
| Project aliases and typed history | Different clone names can resolve to one project history.                        |

## MCP Tools

Profile-backed mode hides auth fields from normal tool schemas. Existing `relay_*` names stay stable.

| Tool                            | Purpose                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------- |
| `relay_share`                   | Draft a handoff packet with selected context, findings, evidence, and next steps. |
| `relay_ask`                     | Draft a handoff packet that includes a question for the recipient.                |
| `relay_update_draft`            | Edit a handoff draft before approval.                                             |
| `relay_approve`                 | Send a handoff packet or approve a reply with a human approval token.             |
| `relay_inbox`                   | List handoff packets addressed to the current member.                             |
| `relay_status`                  | Fetch a readable packet.                                                          |
| `relay_view`                    | Record that a packet was opened for review.                                       |
| `relay_accept`                  | Accept a packet before hydration.                                                 |
| `relay_hydrate`                 | Return bounded context and record a hydration receipt.                            |
| `relay_reply`                   | Draft a reply packet to an accepted or hydrated ask.                              |
| `relay_clarify`                 | Request missing evidence or context before answering.                             |
| `relay_decline`                 | Decline an addressed packet.                                                      |
| `relay_archive`                 | Archive a readable packet.                                                        |
| `relay_search`                  | Search permitted packet history without hydrating results.                        |
| `relay_history`                 | List drafts, sent packets, open work, or closed packets with typed filters.       |
| `relay_audit`                   | List packet or workspace audit receipts.                                          |
| `relay_configure_project_alias` | Map a repo or clone alias to a canonical project.                                 |
| `relay_project_aliases`         | List configured project aliases.                                                  |

## Packet Shape

A draft handoff carries fields like this. It can be a `share` when you are transferring findings, or an `ask` when the receiving teammate needs to continue the investigation and answer a question.

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
  "suggested_next_steps": ["Trace where the rotated token is written before retry"],
  "claims": [
    {
      "text": "The second request still uses the stale refresh token.",
      "confidence": "medium",
      "status": "suspected",
      "evidence_ids": ["ev_auth_refresh_failure"]
    }
  ],
  "evidence": [
    {
      "evidence_id": "ev_auth_refresh_failure",
      "kind": "test_failure",
      "label": "test output",
      "source": "pnpm test auth-refresh",
      "excerpt": "expected 200 received 401",
      "sensitivity": "normal"
    }
  ],
  "hydration_policy": {
    "requires_recipient_approval": true,
    "requires_sender_approval_for_replies": true,
    "allow_raw_transcript": false
  }
}
```

Example packets:

- [examples/packets/ask.json](examples/packets/ask.json)
- [examples/packets/share.json](examples/packets/share.json)
- [examples/packets/reply.json](examples/packets/reply.json)
- [examples/hydration-receipts/reply-hydration.json](examples/hydration-receipts/reply-hydration.json)

Full schema notes: [docs/packet-schema.md](docs/packet-schema.md).

## Security Defaults

- Sender approval is required before ask/share packets leave the sender.
- Recipient acceptance and approval are required before ask/share packets hydrate.
- Reply approval is required before recipient-agent output returns to the sender.
- Sender approval is required before reply packets hydrate into the sender's agent.
- Raw transcripts are not shared by default.
- Secret-looking content blocks sending by default.
- Local absolute paths and oversized excerpts produce warnings.
- Member tokens and approval secrets are stored outside profile metadata.
- Credential files are created with restrictive permissions where supported.
- Approval secrets are not exposed through MCP schemas or config.
- Packet access is enforced in the service and storage layer, not only in MCP filtering.
- Revoked members cannot authenticate or receive future packets.
- Notification payloads include summaries, not evidence bodies or raw transcripts.

More detail: [docs/security-privacy.md](docs/security-privacy.md).

## Commands

```bash
handoff start
handoff invite
handoff join
handoff doctor
handoff server start
handoff server status
handoff server stop
handoff server mcp
handoff workspace create
handoff member invite
handoff member accept
handoff member rotate-token
handoff member rotate-approval-secret
handoff workspace alias set
handoff workspace alias list
handoff ask
handoff share-with
handoff update-draft
handoff approval-token
handoff approve
handoff inbox
handoff status
handoff view
handoff accept
handoff hydrate
handoff reply
handoff clarify
handoff decline
handoff archive
handoff close
handoff history
handoff search
handoff audit
handoff watch
handoff demo two-user
```

## Docs

- [Codex setup](docs/codex-setup.md)
- [Claude Code setup](docs/claude-code-setup.md)
- [Generic MCP setup](docs/generic-mcp-setup.md)
- [Advanced manual setup](docs/advanced-manual-setup.md)
- [Local self-hosting](docs/local-self-hosting.md)
- [Packet schema](docs/packet-schema.md)
- [Security and privacy model](docs/security-privacy.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Short video demo script](docs/demo-video-script.md)
- [Launch copy](docs/launch-copy.md)

## Run From Source

Use this path when developing Handoff itself:

```bash
pnpm install
pnpm build
pnpm demo
```

Before publishing or sending a PR:

```bash
pnpm check
pnpm build
pnpm format:check
pnpm demo
npm pack --dry-run
```

The package ships `dist`, top-level docs, examples, fixtures, and this README.

## Current Limits

- Direct SMTP/email delivery is not implemented. Use `watch --webhook-url` with your email or incident provider's webhook endpoint.
- Slack is not a first-class adapter. Use the generic webhook adapter.
- Literal client-specific slash command registration is not shipped. Use MCP tools and optional local command templates in your client.
- SQLite is the default storage for local/self-hosted teams. Postgres is intentionally left as a future storage adapter.
- Handoff does not passively capture sessions, build a team memory index, or apply another teammate's patch automatically.

## License

MIT.
