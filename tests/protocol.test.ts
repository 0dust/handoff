import normalAsk from '../fixtures/normal-ask.json' with { type: 'json' };
import normalShare from '../fixtures/normal-share.json' with { type: 'json' };
import staleHandoff from '../fixtures/stale-handoff.json' with { type: 'json' };
import { describe, expect, test } from 'vitest';

import {
  buildPacketDraft,
  packetSchema,
  type RelayPacket,
  validateContextBudget,
} from '../src/protocol/schema.js';
import { assertTransition, transitionStatus } from '../src/protocol/state-machine.js';
import { formatHydrationContext } from '../src/hydration.js';

describe('Relay packet schema', () => {
  test('validates a normal ask packet with separated claims and evidence', () => {
    const parsed = packetSchema.parse(normalAsk);

    expect(parsed.packet_type).toBe('ask');
    expect(parsed.question).toContain('auth refresh');
    expect(parsed.finding).toBeUndefined();
    expect(parsed.claims[0].evidence_ids).toEqual(['ev_1']);
    expect(parsed.evidence[0].excerpt).toContain('expected 200');
    expect(parsed.hydration_policy.allow_raw_transcript).toBe(false);
    expect('raw_transcript' in parsed).toBe(false);
  });

  test('requires questions for ask packets and findings for share packets', () => {
    expect(() => packetSchema.parse({ ...normalAsk, question: '' })).toThrow(/question/i);
    expect(() => packetSchema.parse({ ...normalShare, finding: '' })).toThrow(/finding/i);
    expect(() => packetSchema.parse(normalShare)).not.toThrow();
  });

  test('builds concise pending approval drafts with default hydration policy', () => {
    const packet = buildPacketDraft({
      packet_type: 'ask',
      workspace_id: 'wrk_demo',
      sender_member_id: 'mem_sam',
      recipient_member_ids: ['mem_alice'],
      source_client: 'codex',
      title: 'Need auth help',
      summary: 'Refresh is returning 401.',
      question: 'Can you look at the refresh token path?',
      project: {
        repo_name: 'project-api',
        git_remote_fingerprint: 'sha256:demo',
        branch: 'main',
      },
    });

    expect(packet.status).toBe('pending_sender_approval');
    expect(packet.hydration_policy.requires_recipient_approval).toBe(true);
    expect(packet.hydration_policy.allow_raw_transcript).toBe(false);
    expect(packet.audit_receipt.action).toBe('draft');
  });

  test('flags packets that exceed the default context budget', () => {
    const oversized = {
      ...normalAsk,
      evidence: [
        {
          ...normalAsk.evidence[0],
          excerpt: 'x'.repeat(2100),
        },
      ],
    };

    const result = validateContextBudget(oversized as RelayPacket);

    expect(result.ok).toBe(false);
    expect(result.violations).toContain('evidence excerpt ev_1 exceeds 2000 characters');
  });

  test('marks stale hydration context with recheck warnings', () => {
    const packet = packetSchema.parse({
      ...normalAsk,
      ...staleHandoff,
      packet_id: 'pkt_stale',
      recheck_by: staleHandoff.recheck_by,
      expires_at: undefined,
    });

    const hydration = formatHydrationContext(packet, {
      hydratedBy: 'mem_alice',
      client: 'codex',
      sessionId: 'sess_1',
    });

    expect(hydration.context).toContain('STALE OR RECHECK REQUIRED');
    expect(hydration.context).toContain('Provenance');
    expect(hydration.receipt.action).toBe('hydrate');
  });

  test('includes clarification answers in hydration text and context budgeting', () => {
    const packet = packetSchema.parse({
      ...normalAsk,
      answer: 'The failing assertion is expected 200 received 401.',
      status: 'accepted',
    });

    const hydration = formatHydrationContext(packet, {
      hydratedBy: 'mem_alice',
      client: 'codex',
    });

    expect(hydration.context).toContain('Clarification answer:');
    expect(hydration.context).toContain('expected 200 received 401');
    expect(
      validateContextBudget({
        ...packet,
        answer: 'x'.repeat(1300),
      }).violations,
    ).toContain('main packet text exceeds 1200 characters');
  });
});

describe('Relay state machine', () => {
  test('allows the happy ask path and rejects skipped approvals', () => {
    expect(transitionStatus('pending_sender_approval', 'sent', 'sender')).toBe('sent');
    expect(transitionStatus('sent', 'delivered', 'system')).toBe('delivered');
    expect(transitionStatus('delivered', 'viewed', 'recipient')).toBe('viewed');
    expect(transitionStatus('viewed', 'accepted', 'recipient')).toBe('accepted');
    expect(transitionStatus('accepted', 'hydrated', 'recipient')).toBe('hydrated');

    expect(() => transitionStatus('pending_sender_approval', 'delivered', 'sender')).toThrow(
      /invalid state transition/i,
    );
    expect(() => transitionStatus('delivered', 'hydrated', 'recipient')).toThrow(
      /invalid state transition/i,
    );
  });

  test('prevents a sender from hydrating on behalf of a recipient', () => {
    expect(() =>
      assertTransition({
        from: 'accepted',
        to: 'hydrated',
        actorRole: 'sender',
        packetType: 'ask',
      }),
    ).toThrow(/recipient/i);
  });

  test('requires recipient approval before a reply returns to the sender', () => {
    expect(transitionStatus('response_drafting', 'pending_recipient_approval', 'recipient')).toBe(
      'pending_recipient_approval',
    );
    expect(transitionStatus('pending_recipient_approval', 'replied', 'recipient')).toBe('replied');
    expect(() => transitionStatus('response_drafting', 'replied', 'recipient')).toThrow(
      /invalid state transition/i,
    );
  });
});
