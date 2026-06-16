<div align="center">

# Handoff

  <p><strong>Human-approved context handoffs between coding agents.</strong></p>

  <p>Package what one agent session learned so another coding agent can continue from the right context.</p>

  <p>
    MCP server | local-first | SQLite coordination | explicit approvals | audit receipts
  </p>

  <p>
    <img alt="Node 20 plus" src="https://img.shields.io/badge/node-20%2B-4b5563">
    <img alt="MCP stdio" src="https://img.shields.io/badge/MCP-stdio-5f5a4f">
    <img alt="Self hosted" src="https://img.shields.io/badge/self--hosted-SQLite-2f7d5b">
    <img alt="License MIT" src="https://img.shields.io/badge/license-MIT-3f3a36">
  </p>

  <p>
    <a href="#create-a-handoff">Create a handoff</a> |
    <a href="#demo">Demo</a> |
    <a href="#what-you-get">What you get</a> |
    <a href="#security-defaults">Security defaults</a> |
    <a href="#commands">Commands</a>
  </p>
</div>

---

Coding agents still work in isolated sessions. When an engineer gets stuck or finishes an investigation, the useful context is trapped in one local session: files inspected, tests run, errors seen, hypotheses ruled out, and the current best next step.

The usual handoff is lossy: paste logs into Slack, summarize from memory, ask someone else to reconstruct the thread, then hope their agent reads the right details.

Handoff turns that selected session context into a Relay Packet: a reviewable handoff with summary, claims, evidence, files, commands, known failures, confidence, expiry, and provenance. The sender approves exactly what leaves their session. The recipient reviews the packet before hydrating it into Claude Code, Codex, Cursor, or another MCP-capable agent.

This is not chat between agents. `/ask` and `/share-with` are entry points for creating handoff packets. The wedge is making context transfer clean, bounded, auditable, and human-approved.

```text
Sam's Codex session
  -> selected investigation context
  -> Relay Packet
  -> Alice reviews and hydrates
  -> Alice's Claude Code session continues from that context
```

## Create A Handoff

Handoff is meant to sit behind each coding agent as a local stdio MCP server. For a solo demo, every command can use one SQLite file. For a team, run one shared coordination server and point each local MCP process at it.

Start a local coordination server:

```bash
npx -y @0dust/handoff server start --db .relay/team.db --host 127.0.0.1 --port 3737
```

Create a workspace and invite a teammate:

```bash
npx -y @0dust/handoff workspace create \
  --server-url http://127.0.0.1:3737 \
  --name "Relay Demo" \
  --handle sam \
  --display-name "Sam" \
  --json

npx -y @0dust/handoff member invite \
  --server-url http://127.0.0.1:3737 \
  --token <sam-token> \
  --workspace <workspace-id> \
  --handle alice \
  --json

npx -y @0dust/handoff member accept \
  --server-url http://127.0.0.1:3737 \
  --invite <invite-token> \
  --display-name "Alice" \
  --json
```

Workspace creation and invite acceptance return a member `token` and a separate `approval_secret`. Put member tokens in local MCP config or a local secret manager. Keep approval secrets out of MCP config; they are used only by the local approval command.

Then connect the MCP server to your agent.

### Claude Code

Create an MCP config:

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

Start Claude Code with that config:

```bash
claude --mcp-config ./handoff.mcp.json
```

Now tell Claude Code:

```text
Create a Handoff packet for @alice from this session.
Include the current hypothesis, files and symbols touched, commands run, known failures, evidence excerpts, and the next step I want Alice's agent to continue from.
Show me the packet and redaction report before sending.
```

More setup details: [docs/claude-code-setup.md](docs/claude-code-setup.md).

### Codex

Add this to `~/.codex/config.toml` or a trusted project config:

```toml
[mcp_servers.handoff]
command = "npx"
args = ["-y", "@0dust/handoff", "server", "mcp", "--server-url", "http://127.0.0.1:3737"]
startup_timeout_sec = 10
tool_timeout_sec = 60
enabled = true
```

Now tell Codex:

```text
Use Handoff to check my inbox.
Show me any handoff packet before hydration, including evidence, files, commands, confidence, and staleness warnings.
Wait for my approval before calling relay_hydrate.
```

More setup details: [docs/codex-setup.md](docs/codex-setup.md).

### Any MCP Client

Any MCP client that can launch a stdio subprocess can use Handoff:

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

More setup details: [docs/generic-mcp-setup.md](docs/generic-mcp-setup.md).

## Approval Flow

MCP tools can draft, list, view, accept, hydrate, reply, search, and inspect audit receipts. They cannot mint approval tokens.

Generate approval tokens in a local terminal:

```bash
npx -y @0dust/handoff approval-token <packet-id> \
  --server-url http://127.0.0.1:3737 \
  --token <member-token> \
  --approval-secret <approval-secret> \
  --action send

npx -y @0dust/handoff approval-token <packet-id> \
  --server-url http://127.0.0.1:3737 \
  --token <member-token> \
  --approval-secret <approval-secret> \
  --action hydrate

npx -y @0dust/handoff approval-token <reply-packet-id> \
  --server-url http://127.0.0.1:3737 \
  --token <member-token> \
  --approval-secret <approval-secret> \
  --action reply
```

The command asks for an exact local confirmation phrase and returns a short-lived token. Paste that token back into the agent instruction when you want it to call `relay_approve` or `relay_hydrate`.

## Demo

Run the full local handoff flow without any hosted service:

```bash
npx -y @0dust/handoff demo two-user --db .relay/demo.db
```

Expected shape:

```text
ask handoff   -> closed_resolved
reply handoff -> hydrated
share handoff -> archived
```

For machine-readable output:

```bash
npx -y @0dust/handoff demo two-user --db .relay/demo-json.db --json
```

From a local checkout:

```bash
pnpm install
pnpm build
node dist/cli.js demo two-user --db .relay/demo.db
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
| Relay handoff packet              | The product object is selected context, not a message or raw transcript.         |
| Claims and evidence fields        | Recipients can judge what was observed, inferred, or still uncertain.            |
| Files, commands, failures, steps  | The receiving agent can continue the investigation without re-discovery.         |
| Human approval tokens             | Drafting and sending are separate, so an agent cannot silently cross a boundary. |
| Receiver-controlled hydration     | Nothing enters another agent context until the recipient accepts it.             |
| Audit and hydration receipts      | Teams can inspect who sent, viewed, accepted, hydrated, replied, and closed.     |
| Project aliases and typed history | Different clone names can resolve to one project history.                        |

## MCP Tools

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
- Packet access is enforced in the service and storage layer, not only in MCP filtering.
- Workspace admins can inspect audit metadata by default, but not packet bodies unless body access is explicitly enabled.
- Revoked members cannot authenticate or receive future packets.
- Notification payloads include summaries, not evidence bodies or raw transcripts.

More detail: [docs/security-privacy.md](docs/security-privacy.md).

## Local Self-Hosting

Run one coordination server on a trusted host:

```bash
npx -y @0dust/handoff server start --db /srv/handoff/relay.db --host 10.0.0.10 --port 3737
```

Point each local MCP server at it:

```bash
npx -y @0dust/handoff server mcp --server-url http://10.0.0.10:3737
```

Run a terminal watcher:

```bash
npx -y @0dust/handoff watch \
  --server-url http://10.0.0.10:3737 \
  --token <member-token> \
  --workspace <workspace-id>
```

Add native desktop notifications or a webhook:

```bash
npx -y @0dust/handoff watch \
  --server-url http://10.0.0.10:3737 \
  --token <member-token> \
  --workspace <workspace-id> \
  --desktop-notifications

npx -y @0dust/handoff watch \
  --server-url http://10.0.0.10:3737 \
  --token <member-token> \
  --workspace <workspace-id> \
  --webhook-url https://hooks.example.test/relay
```

More detail: [docs/local-self-hosting.md](docs/local-self-hosting.md).

## CLI Happy Path

Create a context handoff and approve it:

```bash
npx -y @0dust/handoff share-with @alice \
  --server-url http://127.0.0.1:3737 \
  --token <sam-token> \
  --workspace <workspace-id> \
  --title "Auth refresh handoff" \
  --summary "The retry path still returns 401 after refresh-token rotation." \
  --finding "The retry path appears to skip persistence before the second request." \
  --source-client codex \
  --evidence-json '[{"kind":"test_failure","label":"test output","source":"pnpm test auth-refresh","excerpt":"expected 200 received 401"}]' \
  --files src/auth/refresh.ts,refreshSession \
  --tests "pnpm test auth-refresh" \
  --tried "Checked token expiry math,Re-ran the refresh integration test" \
  --hypothesis "Refresh persistence ordering issue." \
  --json

npx -y @0dust/handoff approval-token <handoff-packet-id> \
  --server-url http://127.0.0.1:3737 \
  --token <sam-token> \
  --approval-secret <sam-approval-secret> \
  --action send \
  --json

npx -y @0dust/handoff approve <handoff-packet-id> \
  --server-url http://127.0.0.1:3737 \
  --token <sam-token> \
  --approval-token <send-approval-token> \
  --json
```

Review and hydrate:

```bash
npx -y @0dust/handoff inbox --server-url http://127.0.0.1:3737 --token <alice-token> --workspace <workspace-id> --json
npx -y @0dust/handoff view <handoff-packet-id> --server-url http://127.0.0.1:3737 --token <alice-token> --json
npx -y @0dust/handoff accept <handoff-packet-id> --server-url http://127.0.0.1:3737 --token <alice-token> --json
npx -y @0dust/handoff hydrate <handoff-packet-id> --server-url http://127.0.0.1:3737 --token <alice-token> --client claude-code --approval-token <hydrate-approval-token>
```

If the handoff includes a question, the recipient can draft and approve a reply:

```bash
npx -y @0dust/handoff reply <ask-packet-id> "Persist the rotated refresh token before retrying." \
  --server-url http://127.0.0.1:3737 \
  --token <alice-token> \
  --summary "Likely refresh persistence ordering issue." \
  --source-client claude-code \
  --json

npx -y @0dust/handoff approve <reply-packet-id> \
  --server-url http://127.0.0.1:3737 \
  --token <alice-token> \
  --approval-token <reply-approval-token> \
  --json

npx -y @0dust/handoff close <ask-packet-id> \
  --server-url http://127.0.0.1:3737 \
  --token <sam-token> \
  --resolution resolved \
  --json
```

## Commands

```bash
handoff workspace create
handoff member invite
handoff member accept
handoff member rotate-token
handoff member rotate-approval-secret
handoff workspace alias set
handoff workspace alias list
handoff server start
handoff server mcp
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

- [Claude Code setup](docs/claude-code-setup.md)
- [Codex setup](docs/codex-setup.md)
- [Generic MCP setup](docs/generic-mcp-setup.md)
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

The package ships `dist`, top-level docs, examples, fixtures, and this README. Development-only planning files are excluded from the npm package.

## Current Limits

- Direct SMTP/email delivery is not implemented. Use `watch --webhook-url` with your email or incident provider's webhook endpoint.
- Slack is not a first-class adapter. Use the generic webhook adapter.
- Literal client-specific slash command registration is not shipped. Use MCP tools and optional local command templates in your client.
- SQLite is the default storage for local/self-hosted teams. Postgres is intentionally left as a future storage adapter.
- Handoff does not passively capture sessions, build a team memory index, or apply another teammate's patch automatically.

## License

MIT.
