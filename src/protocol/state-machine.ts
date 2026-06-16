import { relayError } from '../errors.js';
import type { PacketStatus, PacketType } from './schema.js';

export type ActorRole = 'admin' | 'recipient' | 'sender' | 'system';

interface TransitionRule {
  to: PacketStatus;
  roles: ActorRole[];
  packetTypes?: PacketType[];
}

const transitionRules: Record<PacketStatus, TransitionRule[]> = {
  draft: [
    { to: 'pending_sender_approval', roles: ['sender'] },
    { to: 'archived', roles: ['sender', 'admin'] },
  ],
  pending_sender_approval: [
    { to: 'sent', roles: ['sender'] },
    { to: 'replied', roles: ['recipient'], packetTypes: ['reply'] },
    { to: 'archived', roles: ['sender', 'admin', 'recipient'] },
  ],
  sent: [
    { to: 'delivered', roles: ['system'] },
    { to: 'expired', roles: ['system'] },
    { to: 'superseded', roles: ['sender', 'admin'] },
  ],
  delivered: [
    { to: 'viewed', roles: ['recipient'] },
    { to: 'declined', roles: ['recipient'] },
    { to: 'archived', roles: ['recipient'] },
    { to: 'expired', roles: ['system'] },
  ],
  viewed: [
    { to: 'accepted', roles: ['recipient'] },
    { to: 'clarification_requested', roles: ['recipient'] },
    { to: 'declined', roles: ['recipient'] },
    { to: 'archived', roles: ['recipient'] },
    { to: 'hydrated', roles: ['recipient'], packetTypes: ['reply'] },
  ],
  accepted: [
    { to: 'hydrated', roles: ['recipient'] },
    { to: 'response_drafting', roles: ['recipient'], packetTypes: ['ask'] },
    { to: 'archived', roles: ['recipient', 'sender'] },
  ],
  clarification_requested: [
    { to: 'pending_sender_approval', roles: ['sender'] },
    { to: 'declined', roles: ['recipient'] },
    { to: 'archived', roles: ['recipient', 'sender'] },
  ],
  response_drafting: [
    { to: 'pending_recipient_approval', roles: ['recipient'] },
    { to: 'archived', roles: ['recipient'] },
  ],
  pending_recipient_approval: [
    { to: 'replied', roles: ['recipient'] },
    { to: 'archived', roles: ['recipient'] },
  ],
  replied: [
    { to: 'viewed', roles: ['recipient'], packetTypes: ['reply'] },
    { to: 'closed_resolved', roles: ['sender'] },
    { to: 'closed_unresolved', roles: ['sender'] },
    { to: 'archived', roles: ['recipient', 'sender'] },
  ],
  hydrated: [
    { to: 'response_drafting', roles: ['recipient'], packetTypes: ['ask'] },
    { to: 'archived', roles: ['recipient', 'sender'] },
    { to: 'closed_resolved', roles: ['sender'] },
    { to: 'closed_unresolved', roles: ['sender'] },
  ],
  archived: [],
  declined: [{ to: 'archived', roles: ['recipient', 'sender'] }],
  expired: [{ to: 'archived', roles: ['recipient', 'sender', 'admin'] }],
  superseded: [{ to: 'archived', roles: ['recipient', 'sender', 'admin'] }],
  closed_resolved: [{ to: 'archived', roles: ['sender', 'recipient'] }],
  closed_unresolved: [{ to: 'archived', roles: ['sender', 'recipient'] }],
};

export interface AssertTransitionInput {
  from: PacketStatus;
  to: PacketStatus;
  actorRole: ActorRole;
  packetType?: PacketType;
}

export function assertTransition(input: AssertTransitionInput): void {
  const rules = transitionRules[input.from] ?? [];
  const rule = rules.find(
    (candidate) =>
      candidate.to === input.to &&
      candidate.roles.includes(input.actorRole) &&
      (!candidate.packetTypes ||
        !input.packetType ||
        candidate.packetTypes.includes(input.packetType)),
  );

  if (!rule) {
    const allowed = rules
      .map((candidate) => `${candidate.to} by ${candidate.roles.join('/')}`)
      .join(', ');
    throw relayError(
      'INVALID_STATE_TRANSITION',
      `Invalid state transition from ${input.from} to ${input.to} by ${input.actorRole}. Allowed: ${allowed || 'none'}`,
      409,
    );
  }
}

export function transitionStatus(
  from: PacketStatus,
  to: PacketStatus,
  actorRole: ActorRole,
  packetType?: PacketType,
): PacketStatus {
  assertTransition({ from, to, actorRole, packetType });
  return to;
}

export function allowedTransitions(
  from: PacketStatus,
  actorRole: ActorRole,
  packetType?: PacketType,
): PacketStatus[] {
  return (transitionRules[from] ?? [])
    .filter(
      (rule) =>
        rule.roles.includes(actorRole) &&
        (!rule.packetTypes || !packetType || rule.packetTypes.includes(packetType)),
    )
    .map((rule) => rule.to);
}
