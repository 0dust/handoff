# Architecture

Handoff is organized around one public contract: a reviewed Relay Packet moves between members of a workspace only through explicit approval gates.

## Runtime Surfaces

```text
CLI
  setup, invites, admin, approval tokens, health checks, demos

MCP stdio server
  coding-agent tools for drafting, review, send, hydrate, reply, search, and audit

Fastify coordination API
  server-backed workspace access for LAN or internal self-hosted teams

RelayService
  packet creation, validation, state transitions, authorization, redaction, audit

SQLite storage
  packets, members, credentials, receipts, notifications, transport metadata
```

The CLI and MCP server both call the same service layer or an API client that reaches the same service layer on a running Handoff server. This keeps approval, authorization, state transitions, and redaction consistent across interfaces.

## Layer Responsibilities

| Layer         | Responsibility                                                                            | Important files                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Protocol      | Relay Packet schema, state machine, public input shapes                                   | `src/protocol/schema.ts`, `src/protocol/state-machine.ts`, `src/protocol/inputs.ts`               |
| Service       | Workspace/member authorization, packet lifecycle, audit, hydration, redaction enforcement | `src/service/relay-service.ts`, `src/service/packet-repository.ts`                                |
| Storage       | SQLite schema and durable packet/member/receipt operations                                | `src/storage/database.ts`, `src/storage/packet-table.ts`, `src/storage/packet-transport-table.ts` |
| API           | Network coordination server for self-hosted teams                                         | `src/api/server.ts`, `src/api/client.ts`                                                          |
| MCP           | Agent-facing tools and profile-backed auth context                                        | `src/mcp/server.ts`                                                                               |
| CLI           | Setup/admin/debug/user commands                                                           | `src/cli.ts`, `src/cli/*.ts`, `src/setup/*.ts`                                                    |
| Notifications | Durable local packet notifications                                                        | `src/notifications.ts`, `src/notification-watch-lifecycle.ts`                                     |
| A2A adapter   | Internal task/artifact/trust-receipt mapping, not public protocol support                 | `src/a2a/*.ts`                                                                                    |

## Core Invariants

- A packet belongs to one workspace.
- A member can read packets they sent or packets addressed to them.
- Admin packet body access is off by default.
- Secret-looking content blocks packet approval unless the human uses an explicit override path.
- Sending, hydrating, and reply approval require short-lived approval tokens.
- Approval tokens are scoped to member, packet, action, and expiry.
- Invalid state transitions fail with `INVALID_STATE_TRANSITION`.
- Search and history filter by authorization before returning results.
- Profile-backed MCP keeps member tokens, workspace IDs, server URLs, and approval secrets out of tool schemas.

## Main Data Flow

```text
relay_share or relay_ask
  -> validate packet input
  -> resolve recipients and project aliases
  -> run redaction
  -> create pending_sender_approval draft
  -> record audit receipt

relay_send_approved
  -> verify approval token or agent-confirmed approval mode
  -> enforce redaction status
  -> transition to sent and delivered
  -> enqueue recipient notifications
  -> record audit receipt

relay_review_next
  -> list authorized inbox packets
  -> mark next delivered packet viewed
  -> return packet and next actions

relay_hydrate_approved
  -> verify recipient approval token
  -> transition accepted/viewed packet to hydrated
  -> write hydration receipt
  -> record audit receipt
```

## Public API Boundary

Relay Packet fields, Handoff CLI commands, Handoff MCP tools, and documented server-backed setup flows are public surfaces.

Internal A2A adapter metadata is not a public protocol promise. It mirrors Relay Packet state for Handoff internals and trust receipts, but users should not depend on A2A field names, public A2A endpoints, or external A2A client compatibility.

## Release Readiness Checks

Before cutting a release or Product Hunt launch:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm demo
npm pack --dry-run
```

For setup or profile changes, also smoke `start`, `invite`, `join`, `doctor`, and notification watcher state in temporary `HANDOFF_HOME` directories.
