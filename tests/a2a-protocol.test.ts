import normalShare from '../fixtures/normal-share.json' with { type: 'json' };
import secretEvidence from '../fixtures/secret-redaction.json' with { type: 'json' };
import { describe, expect, test } from 'vitest';

import {
  buildA2aTaskForPacket,
  buildHandoffAgentCard,
  buildTrustReceipt,
  canonicalPacketHash,
  mapPacketStatusToA2aTaskState,
  relayPacketToA2aArtifact,
  trustReceiptToA2aArtifact,
} from '../src/a2a/handoff-mapping.js';
import {
  a2aArtifactSchema,
  RELAY_PACKET_ARTIFACT_MEDIA_TYPE,
  TRUST_RECEIPT_ARTIFACT_MEDIA_TYPE,
} from '../src/a2a/schema.js';
import { packetSchema, packetStatuses, type RelayPacket } from '../src/protocol/schema.js';

const parsedShare = packetSchema.parse(normalShare);

describe('A2A adapter protocol mapping', () => {
  test('maps every Relay packet status to an internal A2A task state', () => {
    const expected = {
      draft: 'TASK_STATE_INPUT_REQUIRED',
      pending_sender_approval: 'TASK_STATE_INPUT_REQUIRED',
      sent: 'TASK_STATE_SUBMITTED',
      delivered: 'TASK_STATE_WORKING',
      viewed: 'TASK_STATE_INPUT_REQUIRED',
      accepted: 'TASK_STATE_INPUT_REQUIRED',
      clarification_requested: 'TASK_STATE_INPUT_REQUIRED',
      response_drafting: 'TASK_STATE_WORKING',
      pending_recipient_approval: 'TASK_STATE_INPUT_REQUIRED',
      replied: 'TASK_STATE_WORKING',
      hydrated: 'TASK_STATE_COMPLETED',
      archived: 'TASK_STATE_COMPLETED',
      declined: 'TASK_STATE_REJECTED',
      expired: 'TASK_STATE_FAILED',
      superseded: 'TASK_STATE_FAILED',
      closed_resolved: 'TASK_STATE_COMPLETED',
      closed_unresolved: 'TASK_STATE_COMPLETED',
    } satisfies Record<(typeof packetStatuses)[number], string>;

    for (const status of packetStatuses) {
      expect(mapPacketStatusToA2aTaskState(status)).toBe(expected[status]);
    }
  });

  test('represents Relay Packets and Trust Receipts as data artifacts', () => {
    const packetArtifact = relayPacketToA2aArtifact(parsedShare);
    const receipt = buildTrustReceipt({
      packet: parsedShare,
      senderApprovedAt: '2026-06-15T12:06:00.000Z',
    });
    const receiptArtifact = trustReceiptToA2aArtifact(receipt);

    expect(packetArtifact.parts[0]).toMatchObject({
      mediaType: RELAY_PACKET_ARTIFACT_MEDIA_TYPE,
      data: parsedShare,
    });
    expect(receiptArtifact.parts[0]).toMatchObject({
      mediaType: TRUST_RECEIPT_ARTIFACT_MEDIA_TYPE,
      data: receipt,
    });
  });

  test('rejects data artifacts without a media type', () => {
    expect(() =>
      a2aArtifactSchema.parse({
        artifactId: 'art_invalid',
        name: 'Invalid artifact',
        parts: [
          {
            data: parsedShare,
          },
        ],
      }),
    ).toThrow(/mediaType/i);
  });

  test('builds a minimal Agent Card with no public interface when receiving is disabled', () => {
    const card = buildHandoffAgentCard({
      version: '0.1.4',
      serverUrl: 'http://127.0.0.1:9876',
      publicA2aEnabled: false,
    });

    expect(card.name).toBe('Handoff');
    expect(card.supportedInterfaces).toEqual([]);
    expect(card.capabilities.publicA2aReceiving).toBe(false);
    expect(JSON.stringify(card)).not.toContain('wrk_');
    expect(JSON.stringify(card)).not.toContain('mem_');
  });

  test('builds an internal A2A task with Relay Packet and Trust Receipt artifacts', () => {
    const sentPacket = packetSchema.parse({ ...parsedShare, status: 'sent' });
    const receipt = buildTrustReceipt({
      packet: sentPacket,
      senderApprovedAt: '2026-06-15T12:06:00.000Z',
    });

    const task = buildA2aTaskForPacket({ packet: sentPacket, trustReceipt: receipt });

    expect(task.id).toBe(`tsk_${sentPacket.packet_id}`);
    expect(task.status.state).toBe('TASK_STATE_SUBMITTED');
    expect(
      task.artifacts.map((artifact) => {
        const part = artifact.parts[0];
        return part && 'data' in part ? part.mediaType : undefined;
      }),
    ).toEqual([RELAY_PACKET_ARTIFACT_MEDIA_TYPE, TRUST_RECEIPT_ARTIFACT_MEDIA_TYPE]);
  });
});

describe('A2A canonical packet hash and Trust Receipt', () => {
  test('keeps the canonical packet hash stable across workflow-only mutations', () => {
    const approved = packetSchema.parse({
      ...parsedShare,
      status: 'sent',
      updated_at: '2026-06-15T12:06:00.000Z',
      audit_receipt: {
        ...parsedShare.audit_receipt,
        action: 'approve_send',
        created_at: '2026-06-15T12:06:00.000Z',
        metadata: { approval_token_id: 'apr_123' },
      },
    });
    const hydrated = packetSchema.parse({
      ...approved,
      status: 'hydrated',
      updated_at: '2026-06-15T12:08:00.000Z',
      audit_receipt: {
        ...approved.audit_receipt,
        action: 'hydrate',
        created_at: '2026-06-15T12:08:00.000Z',
        metadata: { hydrated_by: 'mem_alice' },
      },
    });

    expect(canonicalPacketHash(hydrated)).toBe(canonicalPacketHash(approved));
  });

  test('changes the canonical packet hash when trust-relevant packet fields change', () => {
    const baseHash = canonicalPacketHash(parsedShare);
    const changedTitle = packetSchema.parse({ ...parsedShare, title: 'Different finding' });
    const changedEvidence = packetSchema.parse({
      ...parsedShare,
      evidence: [
        {
          ...secretEvidence,
          hash: 'sha256:different',
          sensitivity: 'secret_detected',
        },
      ],
    });
    const changedHydrationPolicy = packetSchema.parse({
      ...parsedShare,
      hydration_policy: {
        ...parsedShare.hydration_policy,
        max_characters: parsedShare.hydration_policy.max_characters + 1,
      },
    });

    expect(canonicalPacketHash(changedTitle)).not.toBe(baseHash);
    expect(canonicalPacketHash(changedEvidence)).not.toBe(baseHash);
    expect(canonicalPacketHash(changedHydrationPolicy)).not.toBe(baseHash);
  });

  test('omits raw evidence excerpts and token-like values from Trust Receipt artifacts', () => {
    const packetWithSecretEvidence = packetSchema.parse({
      ...parsedShare,
      evidence: [secretEvidence],
      redaction_report: {
        blocked: false,
        findings: [
          {
            kind: 'api_key',
            field: 'evidence.ev_secret.excerpt',
            evidence_id: 'ev_secret',
            severity: 'warning',
            message: 'Secret-like value redacted before approval.',
            preview: 'sk-proj-...',
          },
        ],
        warnings: [],
      },
    }) as RelayPacket;

    const receipt = buildTrustReceipt({
      packet: packetWithSecretEvidence,
      senderApprovedAt: '2026-06-15T12:06:00.000Z',
      hydratedAt: '2026-06-15T12:10:00.000Z',
    });
    const artifact = trustReceiptToA2aArtifact(receipt);
    const serialized = JSON.stringify(artifact);

    expect(receipt.redaction_warning_count).toBe(1);
    expect(receipt.hydrated_at).toBe('2026-06-15T12:10:00.000Z');
    expect(serialized).not.toContain('OPENAI_API_KEY');
    expect(serialized).not.toContain('sk-proj-secret');
    expect(serialized).not.toContain('postgres://user:pass');
    expect(serialized).toContain(canonicalPacketHash(packetWithSecretEvidence));
  });
});
