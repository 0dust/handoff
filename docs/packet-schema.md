# Packet Schema

Relay packets are Zod-validated TypeScript objects. The source lives in `src/protocol/schema.ts`.

Relay Packet is the documented interchange contract. Internal A2A adapter infrastructure may translate this shape into task, artifact, and Trust Receipt metadata inside Handoff, but users should not depend on A2A field names, endpoints, or protocol compatibility as a public API.

## Packet Types

- `ask`: requires `question`.
- `share`: requires `finding`.
- `reply`: requires `answer`.
- `clarification`: requires `question` and references an original packet. Sender answers update the original packet and return it to `pending_sender_approval`.

## Required Contract Fields

- `packet_id`
- `packet_type`
- `workspace_id`
- `sender_member_id`
- `recipient_member_ids`
- `created_at`
- `updated_at`
- `expires_at` or `recheck_by`
- `status`
- `project`
- `source_client`
- `title`
- `summary`
- `claims`
- `evidence`
- `files_or_symbols`
- `commands_or_tests_run`
- `what_was_tried`
- `known_failures`
- `current_hypothesis`
- `confidence`
- `suggested_next_steps`
- `redaction_report`
- `hydration_policy`
- `audit_receipt`

## Internal A2A Adapter Metadata

When a packet is approved and delivered, Handoff records internal A2A-shaped metadata in a separate transport ledger. Relay Packet artifacts use `application/vnd.handoff.relay-packet+json`; workspace-scoped Trust Receipt artifacts use `application/vnd.handoff.trust-receipt+json`.

This metadata mirrors Relay Packet state. It does not replace packet status, approval tokens, redaction, hydration policy, or audit receipts.

Diagnostic transport inspection, where present, is an authenticated internal support surface. It is not a public A2A protocol contract.

## Project Identity

Packet `project.repo_name` is the canonical workspace project name when a matching project/repo alias is configured. Configure aliases with `workspace alias set` or `relay_configure_project_alias`; history/search filters accept either the canonical project or a configured alias.

```json
{
  "repo_name": "handoff",
  "git_remote_fingerprint": "sha256:...",
  "branch": "main",
  "commit_hash": "abc123"
}
```

## Claims

```json
{
  "claim_id": "clm_1",
  "text": "The failure happens after refresh token rotation.",
  "confidence": "medium",
  "status": "observed",
  "evidence_ids": ["ev_1"],
  "needs_recheck": true
}
```

## Evidence

```json
{
  "evidence_id": "ev_1",
  "kind": "test_failure",
  "label": "vitest failure",
  "source": "pnpm test auth-refresh",
  "excerpt": "expected 200, received 401",
  "hash": "sha256:...",
  "captured_at": "2026-06-15T12:00:00.000Z",
  "sensitivity": "normal"
}
```

## State Model

Supported statuses:

```text
draft
pending_sender_approval
sent
delivered
viewed
accepted
clarification_requested
response_drafting
pending_recipient_approval
replied
hydrated
archived
declined
expired
superseded
closed_resolved
closed_unresolved
```

Invalid transitions throw `INVALID_STATE_TRANSITION`.

Examples:

- `pending_sender_approval` drafts can be edited with `update-draft`/`relay_update_draft`; edits recalculate redaction and write an `edit` audit receipt.
- `pending_sender_approval -> sent` only by sender.
- `sent -> delivered` only by system.
- `delivered -> viewed -> accepted -> hydrated` only by recipient.
- `viewed -> clarification_requested -> pending_sender_approval` lets a recipient ask for missing context and lets the sender update the original packet before approving it again.
- `response_drafting -> pending_recipient_approval -> replied` only by recipient.
- `replied -> viewed -> hydrated` by the reply recipient.

See [example packets](../examples/packets/).
