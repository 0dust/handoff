import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

import { createAuditReceipt, type AuditReceipt } from '../audit.js';

export const packetStatuses = [
  'draft',
  'pending_sender_approval',
  'sent',
  'delivered',
  'viewed',
  'accepted',
  'clarification_requested',
  'response_drafting',
  'pending_recipient_approval',
  'replied',
  'hydrated',
  'archived',
  'declined',
  'expired',
  'superseded',
  'closed_resolved',
  'closed_unresolved',
] as const;

export const packetTypes = ['ask', 'share', 'reply', 'clarification'] as const;
export const confidenceLevels = ['low', 'medium', 'high'] as const;
export const sourceClients = ['claude-code', 'codex', 'cursor', 'generic', 'other'] as const;

export const auditReceiptSchema = z.object({
  receipt_id: z.string().min(1),
  action: z.string().min(1),
  actor_member_id: z.string().min(1),
  packet_id: z.string().min(1).optional(),
  workspace_id: z.string().min(1),
  created_at: z.string().datetime(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  receipt_hash: z.string().min(1).optional(),
});

export const projectIdentitySchema = z
  .object({
    repo_name: z.string().min(1),
    git_remote_fingerprint: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    commit_hash: z.string().min(1).optional(),
  })
  .strict();

export const claimSchema = z
  .object({
    claim_id: z.string().min(1),
    text: z.string().min(1),
    confidence: z.enum(confidenceLevels),
    status: z.enum(['observed', 'inferred', 'suspected', 'disproven', 'superseded']),
    evidence_ids: z.array(z.string()).default([]),
    needs_recheck: z.boolean().default(false),
  })
  .strict();

export const evidenceSchema = z
  .object({
    evidence_id: z.string().min(1),
    kind: z.enum([
      'file_excerpt',
      'command_output',
      'test_failure',
      'error_message',
      'log_excerpt',
      'diff_summary',
      'ticket_link',
      'pr_link',
      'human_note',
    ]),
    label: z.string().min(1),
    source: z.string().min(1),
    excerpt: z.string().default(''),
    hash: z.string().min(1),
    captured_at: z.string().datetime(),
    sensitivity: z.enum(['normal', 'private', 'secret_detected', 'restricted']).default('normal'),
  })
  .strict();

export const redactionFindingSchema = z
  .object({
    kind: z.enum([
      'api_key',
      'private_key',
      'credential_url',
      'env_secret',
      'local_path',
      'oversized_excerpt',
      'user_pattern',
    ]),
    field: z.string().min(1),
    evidence_id: z.string().optional(),
    severity: z.enum(['warning', 'block']),
    message: z.string().min(1),
    preview: z.string().optional(),
  })
  .strict();

export const redactionReportSchema = z
  .object({
    blocked: z.boolean(),
    findings: z.array(redactionFindingSchema).default([]),
    warnings: z.array(redactionFindingSchema).default([]),
  })
  .strict();

export const hydrationPolicySchema = z
  .object({
    requires_recipient_approval: z.boolean().default(true),
    requires_sender_approval_for_replies: z.boolean().default(true),
    allow_raw_transcript: z.boolean().default(false),
    max_characters: z.number().int().positive().default(8000),
  })
  .strict();

export const packetSchema = z
  .object({
    packet_id: z.string().min(1),
    packet_type: z.enum(packetTypes),
    workspace_id: z.string().min(1),
    sender_member_id: z.string().min(1),
    recipient_member_ids: z.array(z.string().min(1)).min(1),
    parent_packet_id: z.string().min(1).optional(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    expires_at: z.string().datetime().optional(),
    recheck_by: z.string().datetime().optional(),
    status: z.enum(packetStatuses),
    project: projectIdentitySchema,
    source_client: z.enum(sourceClients),
    title: z.string().min(1).max(200),
    summary: z.string().min(1).max(5000),
    question: z.string().optional(),
    finding: z.string().optional(),
    answer: z.string().optional(),
    claims: z.array(claimSchema).default([]),
    evidence: z.array(evidenceSchema).default([]),
    files_or_symbols: z.array(z.string()).default([]),
    commands_or_tests_run: z.array(z.string()).default([]),
    what_was_tried: z.array(z.string()).default([]),
    known_failures: z.array(z.string()).default([]),
    current_hypothesis: z.string().default(''),
    confidence: z.enum(confidenceLevels).default('medium'),
    suggested_next_steps: z.array(z.string()).default([]),
    redaction_report: redactionReportSchema,
    hydration_policy: hydrationPolicySchema,
    audit_receipt: auditReceiptSchema,
  })
  .strict()
  .superRefine((packet, ctx) => {
    if (packet.packet_type === 'ask' && !packet.question?.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['question'],
        message: 'Ask packets require a main question.',
      });
    }
    if (packet.packet_type === 'share' && !packet.finding?.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['finding'],
        message: 'Share packets require a finding.',
      });
    }
    if (packet.packet_type === 'reply' && !packet.answer?.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['answer'],
        message: 'Reply packets require an answer.',
      });
    }
    if (packet.packet_type === 'clarification' && !packet.question?.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['question'],
        message: 'Clarification packets require a question.',
      });
    }
    if (packet.packet_type !== 'clarification' && !packet.expires_at && !packet.recheck_by) {
      ctx.addIssue({
        code: 'custom',
        path: ['expires_at'],
        message: 'Packets require expires_at or recheck_by.',
      });
    }
  });

export type PacketStatus = (typeof packetStatuses)[number];
export type PacketType = (typeof packetTypes)[number];
export type RelayPacket = z.infer<typeof packetSchema>;
export type RelayEvidence = z.infer<typeof evidenceSchema>;
export type RelayClaim = z.infer<typeof claimSchema>;
export type RedactionReport = z.infer<typeof redactionReportSchema>;
export type RedactionFinding = z.infer<typeof redactionFindingSchema>;
export type HydrationPolicy = z.infer<typeof hydrationPolicySchema>;
export type ProjectIdentity = z.infer<typeof projectIdentitySchema>;

export const terminalPacketStatuses = [
  'archived',
  'closed_resolved',
  'closed_unresolved',
  'declined',
  'expired',
  'superseded',
] as const satisfies readonly PacketStatus[];

export const draftLikePacketStatuses = [
  'draft',
  'pending_sender_approval',
  'pending_recipient_approval',
] as const satisfies readonly PacketStatus[];

export function isTerminalPacketStatus(status: PacketStatus): boolean {
  return (terminalPacketStatuses as readonly PacketStatus[]).includes(status);
}

export interface ContextBudgetLimits {
  summaryCharacters: number;
  mainTextCharacters: number;
  maxClaims: number;
  maxEvidence: number;
  maxExcerptCharacters: number;
  maxHydrationCharacters: number;
}

export const defaultContextBudget: ContextBudgetLimits = {
  summaryCharacters: 1200,
  mainTextCharacters: 1200,
  maxClaims: 10,
  maxEvidence: 8,
  maxExcerptCharacters: 2000,
  maxHydrationCharacters: 32000,
};

export interface BuildPacketDraftInput {
  packet_type: PacketType;
  workspace_id: string;
  sender_member_id: string;
  recipient_member_ids: string[];
  source_client: RelayPacket['source_client'];
  title: string;
  summary: string;
  question?: string;
  finding?: string;
  answer?: string;
  parent_packet_id?: string;
  project?: Partial<ProjectIdentity>;
  claims?: Partial<RelayClaim>[];
  evidence?: Partial<RelayEvidence>[];
  files_or_symbols?: string[];
  commands_or_tests_run?: string[];
  what_was_tried?: string[];
  known_failures?: string[];
  current_hypothesis?: string;
  confidence?: RelayPacket['confidence'];
  suggested_next_steps?: string[];
  expires_at?: string;
  recheck_by?: string;
  status?: PacketStatus;
  redaction_report?: RedactionReport;
  hydration_policy?: Partial<HydrationPolicy>;
}

export interface ContextBudgetResult {
  ok: boolean;
  violations: string[];
}

function hashExcerpt(excerpt: string): string {
  return `sha256:${createHash('sha256').update(excerpt).digest('hex')}`;
}

function defaultExpiry(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
}

export function normalizeEvidence(evidence: Partial<RelayEvidence>, index: number): RelayEvidence {
  const excerpt = evidence.excerpt ?? '';
  return evidenceSchema.parse({
    evidence_id: evidence.evidence_id ?? `ev_${randomUUID()}`,
    kind: evidence.kind ?? 'human_note',
    label: evidence.label ?? `Evidence ${index + 1}`,
    source: evidence.source ?? 'handoff',
    excerpt,
    hash: evidence.hash ?? hashExcerpt(excerpt),
    captured_at: evidence.captured_at ?? new Date().toISOString(),
    sensitivity: evidence.sensitivity ?? 'normal',
  });
}

export function normalizeClaim(claim: Partial<RelayClaim>, index: number): RelayClaim {
  return claimSchema.parse({
    claim_id: claim.claim_id ?? `clm_${randomUUID()}`,
    text: claim.text ?? `Claim ${index + 1}`,
    confidence: claim.confidence ?? 'medium',
    status: claim.status ?? 'inferred',
    evidence_ids: claim.evidence_ids ?? [],
    needs_recheck: claim.needs_recheck ?? false,
  });
}

export function buildPacketDraft(input: BuildPacketDraftInput): RelayPacket {
  const now = new Date().toISOString();
  const packetId = `pkt_${randomUUID()}`;
  const receipt = createAuditReceipt({
    action: 'draft',
    actorMemberId: input.sender_member_id,
    packetId,
    workspaceId: input.workspace_id,
    metadata: {
      source_client: input.source_client,
      packet_type: input.packet_type,
    },
  }) as AuditReceipt;

  const packet = {
    packet_id: packetId,
    packet_type: input.packet_type,
    workspace_id: input.workspace_id,
    sender_member_id: input.sender_member_id,
    recipient_member_ids: input.recipient_member_ids,
    parent_packet_id: input.parent_packet_id,
    created_at: now,
    updated_at: now,
    expires_at: input.expires_at ?? defaultExpiry(),
    recheck_by: input.recheck_by,
    status: input.status ?? 'pending_sender_approval',
    project: {
      repo_name: input.project?.repo_name ?? 'unknown-project',
      git_remote_fingerprint: input.project?.git_remote_fingerprint,
      branch: input.project?.branch,
      commit_hash: input.project?.commit_hash,
    },
    source_client: input.source_client,
    title: input.title,
    summary: input.summary,
    question: input.question,
    finding: input.finding,
    answer: input.answer,
    claims: input.claims?.map(normalizeClaim) ?? [],
    evidence: input.evidence?.map(normalizeEvidence) ?? [],
    files_or_symbols: input.files_or_symbols ?? [],
    commands_or_tests_run: input.commands_or_tests_run ?? [],
    what_was_tried: input.what_was_tried ?? [],
    known_failures: input.known_failures ?? [],
    current_hypothesis: input.current_hypothesis ?? '',
    confidence: input.confidence ?? 'medium',
    suggested_next_steps: input.suggested_next_steps ?? [],
    redaction_report:
      input.redaction_report ??
      ({
        blocked: false,
        findings: [],
        warnings: [],
      } satisfies RedactionReport),
    hydration_policy: {
      requires_recipient_approval: input.hydration_policy?.requires_recipient_approval ?? true,
      requires_sender_approval_for_replies:
        input.hydration_policy?.requires_sender_approval_for_replies ?? true,
      allow_raw_transcript: input.hydration_policy?.allow_raw_transcript ?? false,
      max_characters: input.hydration_policy?.max_characters ?? 8000,
    },
    audit_receipt: receipt,
  };

  return packetSchema.parse(packet);
}

export function validateContextBudget(
  packet: RelayPacket,
  limits: Partial<ContextBudgetLimits> = {},
): ContextBudgetResult {
  const budget = { ...defaultContextBudget, ...limits };
  const violations: string[] = [];
  const mainText = packet.question ?? packet.finding ?? packet.answer ?? '';
  const hydrationCharacters =
    packet.summary.length +
    mainText.length +
    packet.claims.reduce((total, claim) => total + claim.text.length, 0) +
    packet.evidence.reduce((total, evidence) => total + evidence.excerpt.length, 0);

  if (packet.summary.length > budget.summaryCharacters) {
    violations.push(`summary exceeds ${budget.summaryCharacters} characters`);
  }
  if (mainText.length > budget.mainTextCharacters) {
    violations.push(`main packet text exceeds ${budget.mainTextCharacters} characters`);
  }
  if (packet.claims.length > budget.maxClaims) {
    violations.push(`claims exceed ${budget.maxClaims} max`);
  }
  if (packet.evidence.length > budget.maxEvidence) {
    violations.push(`evidence exceeds ${budget.maxEvidence} max`);
  }
  for (const evidence of packet.evidence) {
    if (evidence.excerpt.length > budget.maxExcerptCharacters) {
      violations.push(
        `evidence excerpt ${evidence.evidence_id} exceeds ${budget.maxExcerptCharacters} characters`,
      );
    }
  }
  if (hydrationCharacters > budget.maxHydrationCharacters) {
    violations.push(`hydration payload exceeds ${budget.maxHydrationCharacters} characters`);
  }

  return { ok: violations.length === 0, violations };
}

export function compressPacketToBudget(
  packet: RelayPacket,
  limits: Partial<ContextBudgetLimits> = {},
): RelayPacket {
  const budget = { ...defaultContextBudget, ...limits };
  const clippedEvidence = packet.evidence.slice(0, budget.maxEvidence).map((evidence) => {
    if (evidence.excerpt.length <= budget.maxExcerptCharacters) {
      return evidence;
    }
    return {
      ...evidence,
      excerpt: `${evidence.excerpt.slice(0, budget.maxExcerptCharacters - 80)}\n[truncated by Handoff; hash preserved: ${evidence.hash}]`,
    };
  });

  return packetSchema.parse({
    ...packet,
    summary: packet.summary.slice(0, budget.summaryCharacters),
    question: packet.question?.slice(0, budget.mainTextCharacters),
    finding: packet.finding?.slice(0, budget.mainTextCharacters),
    answer: packet.answer?.slice(0, budget.mainTextCharacters),
    claims: packet.claims.slice(0, budget.maxClaims),
    evidence: clippedEvidence,
    updated_at: new Date().toISOString(),
  });
}
