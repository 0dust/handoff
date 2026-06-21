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

### Team Handoff

Use this path when Sam and Alice are on different machines on the same network.

```bash
# On Sam's machine: create a workspace and host it on the LAN
npx -y @0dust/handoff start --lan

# On Sam's machine: invite Alice
npx -y @0dust/handoff invite alice

# On Alice's machine: accept the invite and create her local profile
npx -y @0dust/handoff join http://<sam-lan-ip>:3737/invite/<invite-token>

# On each machine: check setup health
npx -y @0dust/handoff doctor
```

`start --lan` creates Sam's local Handoff profile, local SQLite database, workspace, admin member, secure credential file, and reachable coordination server. `invite alice` prints the exact `join` command Alice should run.

Alice does not run `start` for Sam's workspace. She needs Node 20+ with `npx`, the invite link/command Sam sends her, and network access to the Handoff server URL inside that invite. `join` is Alice's setup step: it accepts the invite, creates her local profile, stores her member credentials, and prints the MCP command for her agent client.

If Alice is not on the same LAN, host Handoff somewhere she can reach and pass that URL with `--public-url`, or use the dedicated server path in [Local self-hosting](docs/local-self-hosting.md).

Do not stop here for real use. These commands create the shared Handoff workspace; the actual handoff workflow happens through Codex, Claude Code, Cursor, or another MCP client.

Next, wire Handoff into each user's agent. If you use Codex or Cursor, let Handoff write the MCP config:

```bash
# choose the client you use
npx -y @0dust/handoff start --lan --install-mcp codex
npx -y @0dust/handoff start --lan --install-mcp cursor
npx -y @0dust/handoff join <invite-link> --install-mcp codex
npx -y @0dust/handoff join <invite-link> --install-mcp cursor
```

For Claude Code or another MCP client, add the profile-backed MCP command from [MCP setup](#mcp-setup). `doctor` may report `WARN` for `mcp_config` until this is done. That warning means the workspace exists, but the agent is not wired to Handoff yet.

### Local Demo Mode

Plain `start` is for local demos, CI smoke tests, or two profiles on the same machine. Its invite links are loopback-only and are not meant for Alice's laptop.

```bash
npx -y @0dust/handoff start
npx -y @0dust/handoff invite alice
```

`invite alice` prints one copyable command:

```bash
npx -y @0dust/handoff join http://<host>:<port>/invite/<invite-token>
```

Opening the invite URL in a browser only shows the same join command. The invite is accepted only when the teammate runs `handoff join`.

### What Is Actually Set Up?

Handoff has setup plumbing and agent integration. Only the agent integration is the product workflow.

| Layer | What it enables | Commands |
|---|---|---|
| Workspace foundation | Sam and Alice have profiles, credentials, and a shared reachable workspace. This is required infrastructure, not the handoff UX. | `start --lan`, `invite`, `join`, `doctor` |
| Agent MCP integration | Codex, Claude Code, Cursor, or another MCP client can see Handoff tools such as `relay_share`, `relay_inbox`, and `relay_hydrate`. This is the real user workflow. | `--install-mcp codex`, `--install-mcp cursor`, or Claude/Generic MCP config |
| Human approval gate | A terminal command mints short-lived approval tokens after a local confirmation phrase. This is a security step, not a manual handoff path. | `approval-token` |

The workspace foundation is not enough for the product experience. Handoff is ready when each person's coding agent can see the Handoff MCP tools.

`doctor` makes this distinction explicit:

- `OK` setup checks mean the Handoff profile/workspace/server are usable.
- `WARN mcp_config` means the workspace setup works, but your coding agent is not wired to Handoff yet.

For the full product flow, Sam and Alice should both finish with:

```text
Handoff profile works + MCP tools are visible inside the agent they use.
```

### Ask An Agent To Set It Up

Most users should not wire this by hand. Give your coding agent the repo path and this instruction.

If the npm package is live, the agent can use `npx -y @0dust/handoff`. If you are testing from a local checkout, tell the agent to run:

```bash
cd /path/to/handoff
pnpm install
pnpm build
```

Then use `node /path/to/handoff/dist/cli.js` anywhere the examples say `npx -y @0dust/handoff`.

For Sam, the host:

```text
Set up Handoff for a teammate handoff from this repo.

1. Use the published package with `npx -y @0dust/handoff`, or build this checkout and use `node /path/to/handoff/dist/cli.js`.
2. Do not stop after CLI setup; the goal is to make Handoff usable from my coding agent.
3. Run `npx -y @0dust/handoff start --lan`.
4. If I use Codex, run `npx -y @0dust/handoff start --lan --install-mcp codex` instead.
   If I use Cursor, run `npx -y @0dust/handoff start --lan --install-mcp cursor` instead.
   If I use Claude Code, show me the `claude mcp add-json` command or MCP JSON from the README.
5. Run `npx -y @0dust/handoff invite alice`.
6. Give me the exact join command to send Alice.
7. Run `npx -y @0dust/handoff doctor` and explain whether any warning is only MCP config or a real setup failure.
8. Confirm that my coding agent can see Handoff MCP tools, or tell me exactly what remains.
9. Tell me whether I need to restart Codex, Claude Code, Cursor, or another MCP client after config changes.
```

For Alice, the recipient:

```text
Set up my machine to join Sam's Handoff workspace.

1. Use the published package with `npx -y @0dust/handoff`, or build this checkout and use `node /path/to/handoff/dist/cli.js`.
2. Do not stop after joining; the goal is to make Handoff usable from my coding agent.
3. Run the `npx -y @0dust/handoff join ...` command Sam sent me.
4. If I use Codex, add `--install-mcp codex` to the join command.
   If I use Cursor, add `--install-mcp cursor` to the join command.
   If I use Claude Code, show me the `claude mcp add-json` command or MCP JSON from the README after join succeeds.
5. Run `npx -y @0dust/handoff doctor`.
6. Confirm that my profile can reach Sam's Handoff server and that my coding agent can see Handoff MCP tools, or tell me exactly what remains.
7. Tell me whether I need to restart Codex, Claude Code, Cursor, or another MCP client after config changes.
```

## Use It From Your Agent

This is the main product workflow. After MCP setup, ask your agent to package the current investigation:

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
# Sam hosts and installs Codex MCP
npx -y @0dust/handoff start --lan --install-mcp codex

# Alice joins and installs Codex MCP
npx -y @0dust/handoff join <invite-link> --install-mcp codex
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
# Sam hosts and installs Cursor MCP
npx -y @0dust/handoff start --lan --install-mcp cursor

# Alice joins and installs Cursor MCP
npx -y @0dust/handoff join <invite-link> --install-mcp cursor
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
npx -y @0dust/handoff server mcp --server-url http://10.0.0.10:3737 --explicit-auth
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

## Team, Local Demo, And Remote

Team setup on the same network:

```bash
npx -y @0dust/handoff start --lan
npx -y @0dust/handoff invite alice
```

Local demo setup:

```bash
npx -y @0dust/handoff start
npx -y @0dust/handoff invite alice
```

Running plain `start` later returns the profile to local-only invite links. Use `--lan` or pass a fresh `--public-url` again when you want new invites to leave Sam's machine.

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

These commands exist for setup, administration, approvals, automation, and debugging. For normal teammate handoff, use the MCP tools from Codex, Claude Code, Cursor, or another MCP client instead of manually recreating packets in the terminal.

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
