# Security And Privacy Model

Handoff is built around review gates, bounded packets, and local ownership.

## What Crosses The Boundary

Packets carry selected fields:

- Summary, question/finding/answer.
- Claims with confidence, status, evidence ids, and recheck flags.
- Evidence with kind, source, excerpt, hash, capture time, and sensitivity.
- Project identity: repo name, remote fingerprint, branch, optional commit.
- Audit and redaction receipts.

Raw transcripts are not captured or shared by default.

## Required Human Gates

- Sender reviews and approves ask/share packets before send.
- Recipient views and accepts ask/share packets before hydration.
- Recipient reviews and approves replies before return.
- Sender views replies and hydrates them explicitly.

The service rejects invalid state transitions, and send/reply/hydrate actions require a short-lived human approval token generated outside MCP. Approval-token minting requires both the member token and a separate per-member approval secret returned during setup/acceptance, plus the local CLI confirmation prompt. A member token alone cannot mint approval tokens.

## Redaction

The redaction engine blocks by default when it sees:

- API-key or token-looking values.
- Private key blocks.
- Credential-bearing URLs.
- `.env`-like secret values.
- Evidence marked `secret_detected` or `restricted`.

Redaction scans packet titles, summaries, questions/findings/answers, hypotheses, claims, evidence labels/sources/excerpts, files or symbols, commands/tests, tried steps, known failures, and suggested next steps before a packet can be approved.

It warns, but does not block by default, for:

- Local absolute paths.
- Oversized excerpts that should be compressed.

Hashes are preserved when evidence excerpts are truncated or omitted.

## Authorization

Authorization is enforced in the service/storage layer:

- Members can send only inside their workspace.
- Members can read packets they sent or packets addressed to them.
- Admins can manage workspace membership and view audit metadata by default.
- Admin packet body access is off by default and must be enabled as a workspace setting.
- Audit receipts are available through CLI, API, and MCP. Workspace-wide audit listing is admin-only; packet-specific audit listing follows metadata visibility.
- Revoked members cannot authenticate and cannot receive future packets.
- Search and history filter before returning results. Admins without body access can search and filter metadata fields only; body/provenance text is not exposed as a search oracle.

## Audit Receipts

Receipts are recorded for:

- `draft`
- `approve`
- `send`
- `deliver`
- `view`
- `accept`
- `edit`
- `hydrate`
- `reply`
- `decline`
- `archive`
- `close`
- `configure_project_alias`
- `revoke`
- `rotate_token`
- `rotate_approval_secret`
- `search`

Receipts avoid logging extra raw sensitive evidence beyond the approved packet body.

## Operational Notes

- Treat `.relay/*.db` as sensitive. It contains packet bodies, member token hashes, audit metadata, and hydration receipts.
- Treat approval secrets like local signing material. Keep them out of MCP config and committed files; store them in a human-controlled terminal secret manager or pass them only to `approval-token`.
- Rotate approval secrets with `member rotate-approval-secret` if one appears in shell history, terminal logs, or copied demo output. Rotation requires the current approval secret, returns the replacement once, invalidates unconsumed approval tokens minted by that member, and records `rotate_approval_secret`.
- Back up the SQLite database like any local coordination data store.
- Prefer private network access or localhost-only binding for the Fastify coordination server.
- Rotate member tokens if a token is pasted into a prompt, shell history, ticket, or chat. Rotate both credentials if both the member token and approval secret are exposed.
