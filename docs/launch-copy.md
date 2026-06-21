# Launch Copy

## Short X Post

Public beta: Handoff, human-approved context handoffs between coding agents.

Package selected agent-session context, review before send, review before hydration, keep claims separate from evidence, and get audit receipts for every step.

Not shared memory. Not agent Slack. Just safer teammate handoffs.

## Preflight Before Posting

- Push the release branch to the public GitHub repo.
- Publish `@0dust/handoff` to npm.
- Verify `npx -y @0dust/handoff doctor --json` runs from a clean temp directory.
- Record the short demo from `docs/demo-video-script.md` after the npm package is live.

## GitHub Release Announcement

Handoff is a local-first public beta for human-approved context handoffs between coding agents.

The first release focuses on one workflow: a developer can package selected session context into a reviewable packet so another teammate's coding agent can continue without reconstructing the investigation.

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
- MCP server for Claude Code, Codex, and generic MCP clients.
- Profile-backed setup with `start`, `invite`, `join`, and `doctor`.
- CLI support for setup, admin flows, approval tokens, debugging, watch, and demos. Normal handoffs happen through MCP tools inside the coding agent.
- Audit and hydration receipts.
- Local polling watcher with terminal output, best-effort desktop notifications, and generic webhook posts.
- Docs, examples, and a five-minute two-user demo.

What this is not:

- Not passive agent memory.
- Not Slack for agents.
- Not autonomous agent-to-agent chat.
- Not a hosted SaaS dependency.

Try it:

```bash
# Sam hosts a reachable workspace
npx -y @0dust/handoff start --lan
npx -y @0dust/handoff invite alice

# Alice joins from her machine
npx -y @0dust/handoff join http://<host>:3737/invite/<invite-token>
npx -y @0dust/handoff doctor

# Then wire Handoff into Codex, Claude Code, Cursor, or another MCP client.
```

## Comparison

Compared with raw Slack or paste workflows, Relay keeps handoffs structured, reviewed, evidence-backed, and auditable.

Compared with passive memory tools, Relay does not watch every session or ingest everything by default. A human chooses what crosses the boundary.

Compared with autonomous agent-to-agent systems, Relay keeps both humans in the loop: sender approves send, recipient approves hydration, recipient approves replies, sender approves reply hydration.
