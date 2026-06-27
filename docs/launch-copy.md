# Launch Copy

Use this file for quick posting. Use [product-hunt-launch-kit.md](product-hunt-launch-kit.md) for the full Product Hunt submission package.

## Short X Post

Handoff is live.

Human-approved context packets for coding agents.

Codex, Claude Code, Cursor, and other MCP-capable agents can pass reviewed Relay Packets between teammates without dumping raw transcripts into Slack.

Open source, local-first, self-hosted.

## Technical X Post

The primitive in Handoff is a Relay Packet:

- selected context, not transcript dump
- claims linked to evidence
- sender approval before send
- recipient approval before hydration
- redaction blocks secret-looking content
- audit receipts for packet movement

Built for MCP-connected coding agents.

## Contrast X Post

Handoff is not:

- agent Slack
- passive shared memory
- hosted context ingestion
- autonomous agent-to-agent chat

It is a small approval layer for one painful moment: "my agent knows the state, your agent needs the usable parts."

## Preflight Before Posting

- Merge the release PR to the public GitHub repo.
- Publish `handoff-relay` to npm.
- Verify `npx -y handoff-relay@latest --version` runs from a clean temp directory.
- Verify `npx -y handoff-relay@latest doctor --json` runs with a clean temp `HANDOFF_HOME`.
- Record the short demo from [demo-video-script.md](demo-video-script.md) after the npm package is live.
- Export gallery images from `assets/readme`.

## GitHub Release Announcement

Handoff is a local-first public beta for human-approved context packets between coding agents.

The release focuses on one workflow: a developer can package selected agent-session context into a reviewable packet so another teammate's coding agent can continue without reconstructing the investigation.

What is included:

- Structured ask, share, reply, and clarification packets.
- Sender approval before send.
- Recipient review before hydration.
- Reply approval before return.
- Sender-controlled reply hydration.
- Claims and evidence as separate fields.
- Redaction that blocks secret-looking content by default.
- Explicit state machine with invalid transition rejection.
- SQLite coordination storage.
- Fastify coordination API.
- MCP server for Claude Code, Codex, Cursor, and generic MCP clients.
- Profile-backed setup with `start`, `invite`, `join`, and `doctor`.
- CLI support for setup, admin flows, approval tokens, debugging, watch, and demos.
- Audit and hydration receipts.
- Local polling watcher with terminal output, best-effort desktop notifications, and generic webhook posts.
- Docs, examples, launch assets, and a two-user demo.

What this is not:

- Not passive agent memory.
- Not Slack for agents.
- Not autonomous agent-to-agent chat.
- Not a hosted SaaS dependency.

Try it:

```bash
# Sam hosts a reachable workspace
npx -y handoff-relay start --lan --install-mcp codex --invite alice

# Alice joins from her machine
npx -y handoff-relay join http://<host>:3737/invite/<invite-token> --install-mcp codex
npx -y handoff-relay doctor
```

Then use Handoff from inside Codex, Claude Code, Cursor, or another MCP client.

## Comparison

Compared with raw Slack or paste workflows, Relay Packets keep handoffs structured, reviewed, evidence-backed, and auditable.

Compared with passive memory tools, Handoff does not watch every session or ingest everything by default. A human chooses what crosses the boundary.

Compared with autonomous agent-to-agent systems, Handoff keeps both humans in the loop: sender approves send, recipient approves hydration, recipient approves replies, and sender approves reply hydration.
