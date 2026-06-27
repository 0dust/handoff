# Product Hunt Launch Kit

This kit keeps the launch story, copy, assets, and preflight checks in one place. It is written for a public beta launch of Handoff as an open-source developer tool.

## Positioning

**Name:** Handoff

**Tagline:** Human-approved context packets for coding agents

**One-line hook:** Move only the reviewed context from one teammate's coding agent to another.

**Category tags:** Developer Tools, AI Agents, Open Source

**Pricing:** Free, open source, self-hosted.

**Primary link:** https://github.com/0dust/handoff

**Package link:** https://www.npmjs.com/package/handoff-relay

## Short Description

Handoff lets Codex, Claude Code, Cursor, and other MCP-capable agents pass structured Relay Packets between teammates. A sender reviews what leaves, a recipient reviews what arrives, and only then does the recipient's agent hydrate bounded context.

## What Is New Or Different

Most agent handoffs today are raw transcript dumps, Slack messages, or passive memory. Handoff turns a handoff into a reviewable packet with claims, evidence, failures, files, commands, redaction, approval gates, and audit receipts. It is local-first and self-hosted, so teams can use it without sending internal debugging context to a hosted service.

## First Comment

We built Handoff because coding agents are starting to work in teams, but the handoff between two agents is still usually a paste, a Slack thread, or a vague recap.

Handoff keeps that moment explicit. One agent drafts a Relay Packet from selected session context. The sender reviews and approves it. The recipient reviews it. Only then does the recipient's agent hydrate bounded context.

It is not agent Slack or passive shared memory. It is a small trust layer for teammate handoffs: claims stay linked to evidence, secret-looking content blocks by default, and every movement has an audit receipt.

I would love feedback from teams already using multiple coding agents.

## Gallery Assets

Use at least three Product Hunt gallery images. The first image becomes the social preview.

| Slot | Asset                                             | Purpose                                                                                                         |
| ---- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1    | `assets/readme/product-hunt-gallery-hero.png`     | 1200x630 social/PH gallery export of the packet moving between two coding agents through a human approval gate. |
| 2    | `assets/readme/handoff-relay-packet-wordmark.svg` | Brand and tagline for GitHub/npm/social previews.                                                               |
| 3    | `assets/readme/product-hunt-thumbnail.png`        | 240x240 Product Hunt thumbnail export.                                                                          |
| 4    | `assets/readme/handoff-ascii-banner.svg`          | Developer-tool flavored banner for technical posts.                                                             |

Recommended Product Hunt export targets:

- Thumbnail: 240x240 PNG or JPG, under 2 MB. Use `product-hunt-thumbnail.png`.
- Gallery: 1200x630 PNG or JPG, under 10 MB. Use `product-hunt-gallery-hero.png` first.
- Video: 60-90 seconds. Use [demo-video-script.md](demo-video-script.md).

## Demo Script

Record the narrow workflow:

1. Show the promise: reviewed agent-session context moves as a packet, not a transcript dump.
2. Run `npx -y handoff-relay demo two-user --json`.
3. Point out ask/share/reply, review gates, hydration, archive, and audit receipts.
4. Show `watch --status` to make proactive packet notifications visible.
5. Close with the difference: not passive memory, not chat, not autonomous agent-to-agent exchange.

Full script: [demo-video-script.md](demo-video-script.md).

## X Posts

### Launch Post

Handoff is live.

Human-approved context packets for coding agents.

Codex, Claude Code, Cursor, and other MCP-capable agents can pass reviewed Relay Packets between teammates without dumping raw transcripts into Slack.

Open source, local-first, self-hosted.

### Technical Post

The primitive in Handoff is a Relay Packet:

- selected context, not transcript dump
- claims linked to evidence
- sender approval before send
- recipient approval before hydration
- redaction blocks secret-looking content
- audit receipts for packet movement

Built for MCP-connected coding agents.

### Contrast Post

Handoff is not:

- agent Slack
- passive shared memory
- hosted context ingestion
- autonomous agent-to-agent chat

It is a small approval layer for one painful moment: "my agent knows the state, your agent needs the usable parts."

## GitHub Release Copy

Handoff is a local-first public beta for human-approved context packets between coding agents.

The release focuses on one workflow: a developer can package selected agent-session context into a reviewable packet so another teammate's coding agent can continue without reconstructing the investigation.

Included:

- structured ask, share, reply, and clarification packets
- sender approval before send
- recipient review before hydration
- reply approval before return
- claims and evidence as separate fields
- redaction that blocks secret-looking content by default
- explicit state machine with invalid transition rejection
- SQLite coordination storage and Fastify coordination API
- MCP server for Codex, Claude Code, Cursor, and generic MCP clients
- profile-backed setup with `start`, `invite`, `join`, and `doctor`
- local packet notifications
- audit and hydration receipts
- docs, examples, launch assets, and a two-user demo

## Preflight Checklist

Before launch:

- [ ] PR merged to `main`.
- [ ] `pnpm install --frozen-lockfile` passes from a clean checkout.
- [ ] `pnpm check` passes.
- [ ] `pnpm build` passes.
- [ ] `pnpm demo` passes.
- [ ] `npm pack --dry-run` includes `dist`, docs, examples, fixtures, README, and `assets/readme`.
- [ ] Clean npm smoke works from a temp directory: `npx -y handoff-relay@latest --version`.
- [ ] `npx -y handoff-relay@latest doctor --json` runs from a temp `HANDOFF_HOME`.
- [ ] README and npm README both show the same quick start.
- [ ] Product Hunt gallery images are exported.
- [ ] Demo video is recorded from the published package.
- [ ] First comment is scheduled.
- [ ] Launch day replies are staffed for questions about security, self-hosting, MCP setup, and how Handoff differs from chat/shared memory.

## Launch Day Replies

**Is this a hosted service?**

No. Handoff is local-first and self-hosted. Small teams can start on a LAN; more durable teams can run the coordination server on an internal host or VPN-reachable machine.

**Why not just use Slack?**

Slack is transport. Handoff is a reviewed workflow artifact. The packet separates claims, evidence, commands, known failures, and next steps, then gates send and hydration with human approval.

**Is this shared memory?**

No. Handoff does not passively capture sessions or build a team memory index. A human decides what becomes a packet.

**Does it support A2A?**

Handoff has internal A2A adapter infrastructure, but the public product contract is Relay Packets over the Handoff workflow. MCP is the normal agent UX.

**What agents does it support?**

Codex, Claude Code, Cursor, and any MCP-capable client that can launch a stdio command.
