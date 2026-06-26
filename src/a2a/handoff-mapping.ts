import { createHash } from 'node:crypto';

import type { PacketStatus, RelayPacket } from '../protocol/schema.js';
import {
  a2aAgentCardSchema,
  a2aArtifactSchema,
  a2aTaskSchema,
  INTERNAL_A2A_PROTOCOL,
  RELAY_PACKET_ARTIFACT_MEDIA_TYPE,
  TRUST_RECEIPT_ARTIFACT_MEDIA_TYPE,
  trustReceiptSchema,
  type A2aAgentCard,
  type A2aArtifact,
  type A2aTask,
  type A2aTaskState,
  type TrustReceipt,
} from './schema.js';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface BuildHandoffAgentCardInput {
  version: string;
  serverUrl?: string;
  publicA2aEnabled?: boolean;
}

export interface BuildTrustReceiptInput {
  packet: RelayPacket;
  packetHash?: string;
  a2aTaskId?: string;
  senderApprovedAt?: string | null;
  hydratedAt?: string | null;
  repliedAt?: string | null;
  terminalAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export function taskIdForPacket(packetId: string): string {
  return `tsk_${packetId}`;
}

export function relayPacketArtifactId(packetId: string): string {
  return `art_${packetId}_relay_packet`;
}

export function trustReceiptArtifactId(packetId: string): string {
  return `art_${packetId}_trust_receipt`;
}

export function mapPacketStatusToA2aTaskState(status: PacketStatus): A2aTaskState {
  switch (status) {
    case 'draft':
    case 'pending_sender_approval':
    case 'viewed':
    case 'accepted':
    case 'clarification_requested':
    case 'pending_recipient_approval':
      return 'TASK_STATE_INPUT_REQUIRED';
    case 'sent':
      return 'TASK_STATE_SUBMITTED';
    case 'delivered':
    case 'response_drafting':
    case 'replied':
      return 'TASK_STATE_WORKING';
    case 'hydrated':
    case 'archived':
    case 'closed_resolved':
    case 'closed_unresolved':
      return 'TASK_STATE_COMPLETED';
    case 'declined':
      return 'TASK_STATE_REJECTED';
    case 'expired':
    case 'superseded':
      return 'TASK_STATE_FAILED';
  }
}

export function relayPacketToA2aArtifact(packet: RelayPacket): A2aArtifact {
  return a2aArtifactSchema.parse({
    artifactId: relayPacketArtifactId(packet.packet_id),
    name: 'Handoff Relay Packet',
    description: 'Human-approved Handoff Relay Packet artifact.',
    parts: [
      {
        data: packet,
        mediaType: RELAY_PACKET_ARTIFACT_MEDIA_TYPE,
      },
    ],
    metadata: {
      packet_id: packet.packet_id,
      packet_type: packet.packet_type,
      packet_status: packet.status,
      created_at: packet.created_at,
    },
  });
}

export function trustReceiptToA2aArtifact(receipt: TrustReceipt): A2aArtifact {
  return a2aArtifactSchema.parse({
    artifactId: trustReceiptArtifactId(receipt.packet_id),
    name: 'Handoff Trust Receipt',
    description: 'Workspace-scoped Handoff trust receipt metadata.',
    parts: [
      {
        data: receipt,
        mediaType: TRUST_RECEIPT_ARTIFACT_MEDIA_TYPE,
      },
    ],
    metadata: {
      packet_id: receipt.packet_id,
      a2a_task_id: receipt.a2a_task_id,
      packet_hash: receipt.packet_hash,
      created_at: receipt.created_at,
    },
  });
}

export function buildA2aTaskForPacket(input: {
  packet: RelayPacket;
  trustReceipt?: TrustReceipt;
}): A2aTask {
  const artifacts = [relayPacketToA2aArtifact(input.packet)];
  if (input.trustReceipt) {
    artifacts.push(trustReceiptToA2aArtifact(input.trustReceipt));
  }

  return a2aTaskSchema.parse({
    id: taskIdForPacket(input.packet.packet_id),
    contextId: input.packet.workspace_id,
    status: {
      state: mapPacketStatusToA2aTaskState(input.packet.status),
      timestamp: input.packet.updated_at,
    },
    artifacts,
    metadata: {
      protocol: INTERNAL_A2A_PROTOCOL,
      packet_id: input.packet.packet_id,
      packet_status: input.packet.status,
    },
  });
}

export function buildHandoffAgentCard(input: BuildHandoffAgentCardInput): A2aAgentCard {
  return a2aAgentCardSchema.parse({
    name: 'Handoff',
    description:
      'Human-approved Relay Packet handoff for coding agents, with A2A adapter metadata for future interoperability.',
    version: input.version,
    supportedInterfaces: [],
    defaultInputModes: [RELAY_PACKET_ARTIFACT_MEDIA_TYPE],
    defaultOutputModes: [RELAY_PACKET_ARTIFACT_MEDIA_TYPE, TRUST_RECEIPT_ARTIFACT_MEDIA_TYPE],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
      publicA2aReceiving: false,
    },
    skills: [
      {
        id: 'relay-packet-handoff',
        name: 'Relay Packet handoff',
        description:
          'Accepts reviewed Handoff Relay Packet artifacts through the existing approval-gated workflow.',
        tags: ['handoff', 'relay-packet', 'coding-agents'],
        inputModes: [RELAY_PACKET_ARTIFACT_MEDIA_TYPE],
        outputModes: [RELAY_PACKET_ARTIFACT_MEDIA_TYPE, TRUST_RECEIPT_ARTIFACT_MEDIA_TYPE],
      },
    ],
    metadata: {
      public_a2a_receiving: input.publicA2aEnabled === true ? 'not_implemented' : 'disabled',
      relay_packet_media_type: RELAY_PACKET_ARTIFACT_MEDIA_TYPE,
      trust_receipt_media_type: TRUST_RECEIPT_ARTIFACT_MEDIA_TYPE,
    },
  });
}

export function buildTrustReceipt(input: BuildTrustReceiptInput): TrustReceipt {
  const packetHash = input.packetHash ?? canonicalPacketHash(input.packet);
  const now = input.updatedAt ?? input.packet.updated_at;
  const warningCount =
    input.packet.redaction_report.warnings.length +
    input.packet.redaction_report.findings.filter((finding) => finding.severity === 'warning')
      .length;

  return trustReceiptSchema.parse({
    receipt_id: `rct_${input.packet.packet_id}_${packetHash.slice('sha256:'.length, 18)}`,
    packet_id: input.packet.packet_id,
    a2a_task_id: input.a2aTaskId ?? taskIdForPacket(input.packet.packet_id),
    workspace_id: input.packet.workspace_id,
    sender_member_id: input.packet.sender_member_id,
    recipient_member_ids: input.packet.recipient_member_ids,
    packet_hash: packetHash,
    packet_type: input.packet.packet_type,
    packet_status: input.packet.status,
    redaction_blocked: input.packet.redaction_report.blocked,
    redaction_warning_count: warningCount,
    sender_approved_at: input.senderApprovedAt ?? null,
    hydrated_at: input.hydratedAt ?? null,
    replied_at: input.repliedAt ?? null,
    terminal_at: input.terminalAt ?? null,
    created_at: input.createdAt ?? input.packet.created_at,
    updated_at: now,
  });
}

export function canonicalPacketHash(packet: RelayPacket): string {
  return `sha256:${createHash('sha256')
    .update(stableJsonStringify(canonicalPacketProjection(packet)))
    .digest('hex')}`;
}

function canonicalPacketProjection(packet: RelayPacket): JsonValue {
  return {
    packet_id: packet.packet_id,
    packet_type: packet.packet_type,
    workspace_id: packet.workspace_id,
    sender_member_id: packet.sender_member_id,
    recipient_member_ids: packet.recipient_member_ids,
    parent_packet_id: packet.parent_packet_id ?? null,
    created_at: packet.created_at,
    expires_at: packet.expires_at ?? null,
    recheck_by: packet.recheck_by ?? null,
    project: packet.project,
    source_client: packet.source_client,
    title: packet.title,
    summary: packet.summary,
    question: packet.question ?? null,
    finding: packet.finding ?? null,
    answer: packet.answer ?? null,
    claims: packet.claims,
    evidence: packet.evidence.map((evidence) => ({
      evidence_id: evidence.evidence_id,
      kind: evidence.kind,
      label: evidence.label,
      source: evidence.source,
      hash: evidence.hash,
      captured_at: evidence.captured_at,
      sensitivity: evidence.sensitivity,
    })),
    files_or_symbols: packet.files_or_symbols,
    commands_or_tests_run: packet.commands_or_tests_run,
    what_was_tried: packet.what_was_tried,
    known_failures: packet.known_failures,
    current_hypothesis: packet.current_hypothesis,
    confidence: packet.confidence,
    suggested_next_steps: packet.suggested_next_steps,
    redaction_report: packet.redaction_report,
    hydration_policy: packet.hydration_policy,
  };
}

function stableJsonStringify(value: JsonValue): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortJson(nested)]),
    );
  }
  return value;
}
