import { createAuditReceipt, type AuditReceipt } from './audit.js';
import type { RelayPacket } from './protocol/schema.js';

export interface HydrationInput {
  hydratedBy: string;
  client: string;
  sessionId?: string;
  maxCharacters?: number;
}

export interface HydrationResult {
  context: string;
  receipt: AuditReceipt;
}

function isStale(packet: RelayPacket): boolean {
  const now = Date.now();
  return Boolean(
    (packet.expires_at && Date.parse(packet.expires_at) < now) ||
    (packet.recheck_by && Date.parse(packet.recheck_by) < now) ||
    packet.claims.some((claim) => claim.needs_recheck),
  );
}

function mainText(packet: RelayPacket): string {
  const clarificationAnswer = packet.answer ? `\n\nClarification answer:\n${packet.answer}` : '';
  if (packet.packet_type === 'ask') return `${packet.question ?? ''}${clarificationAnswer}`;
  if (packet.packet_type === 'share') return `${packet.finding ?? ''}${clarificationAnswer}`;
  if (packet.packet_type === 'reply') return packet.answer ?? '';
  return packet.question ?? '';
}

export function formatHydrationContext(
  packet: RelayPacket,
  input: HydrationInput,
): HydrationResult {
  const maxCharacters = input.maxCharacters ?? packet.hydration_policy.max_characters;
  const claims = packet.claims
    .map(
      (claim) =>
        `- [${claim.confidence}/${claim.status}] ${claim.text}${claim.needs_recheck ? ' (needs recheck)' : ''}`,
    )
    .join('\n');
  const evidence = packet.evidence
    .map(
      (item) =>
        `- ${item.label} (${item.kind}, ${item.sensitivity}, ${item.source}, ${item.hash})\n  ${item.excerpt}`,
    )
    .join('\n');
  const staleWarning = isStale(packet)
    ? '\nSTALE OR RECHECK REQUIRED: verify dates, claims, and evidence before relying on this packet.\n'
    : '';
  const context = `
Handoff Hydration Packet
============================
${staleWarning}
Title: ${packet.title}
Type: ${packet.packet_type}
Status at hydration: ${packet.status}

Main content:
${mainText(packet)}

Summary:
${packet.summary}

Claims:
${claims || '- No explicit claims supplied.'}

Evidence:
${evidence || '- No evidence supplied.'}

What was tried:
${packet.what_was_tried.map((item) => `- ${item}`).join('\n') || '- Not supplied.'}

Known failures:
${packet.known_failures.map((item) => `- ${item}`).join('\n') || '- Not supplied.'}

Current hypothesis:
${packet.current_hypothesis || 'Not supplied.'}

Suggested next steps:
${packet.suggested_next_steps.map((item) => `- ${item}`).join('\n') || '- Not supplied.'}

Provenance:
- packet_id: ${packet.packet_id}
- workspace_id: ${packet.workspace_id}
- sender_member_id: ${packet.sender_member_id}
- recipient_member_ids: ${packet.recipient_member_ids.join(', ')}
- source_client: ${packet.source_client}
- project: ${packet.project.repo_name}${packet.project.branch ? ` on ${packet.project.branch}` : ''}
- created_at: ${packet.created_at}
- recheck_by: ${packet.recheck_by ?? 'not set'}
- expires_at: ${packet.expires_at ?? 'not set'}
`.trim();

  const bounded =
    context.length > maxCharacters
      ? `${context.slice(0, Math.max(0, maxCharacters - 120))}\n[truncated by Handoff hydration budget]`
      : context;

  return {
    context: bounded,
    receipt: createAuditReceipt({
      action: 'hydrate',
      actorMemberId: input.hydratedBy,
      packetId: packet.packet_id,
      workspaceId: packet.workspace_id,
      metadata: {
        client: input.client,
        session_id: input.sessionId,
        packet_type: packet.packet_type,
      },
    }),
  };
}
