import { z } from 'zod';

export const A2A_JSON_MEDIA_TYPE = 'application/a2a+json';
export const A2A_AGENT_CARD_PATH = '/.well-known/agent-card.json';
export const A2A_RECEIVE_PATH = '/a2a';
export const A2A_PROTOCOL_VERSION = '1.0';
export const INTERNAL_A2A_PROTOCOL = 'a2a-internal';
export const A2A_RECEIVE_METHODS = ['SendMessage', 'message/send'] as const;
export const A2A_PARSE_ERROR_CODE = -32700;
export const A2A_INVALID_REQUEST_CODE = -32600;
export const A2A_METHOD_NOT_FOUND_CODE = -32601;
export const A2A_RECEIVE_UNAVAILABLE_CODE = -32004;
export const A2A_PARSE_ERROR_REASON = 'A2A_PARSE_ERROR';
export const A2A_INVALID_REQUEST_REASON = 'A2A_INVALID_REQUEST';
export const A2A_METHOD_NOT_FOUND_REASON = 'A2A_METHOD_NOT_FOUND';
export const A2A_DISABLED_REASON = 'A2A_DISABLED';
export const A2A_NOT_IMPLEMENTED_REASON = 'A2A_NOT_IMPLEMENTED';
export const RELAY_PACKET_ARTIFACT_MEDIA_TYPE = 'application/vnd.handoff.relay-packet+json';
export const TRUST_RECEIPT_ARTIFACT_MEDIA_TYPE = 'application/vnd.handoff.trust-receipt+json';

export const a2aTaskStates = [
  'TASK_STATE_UNSPECIFIED',
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
  'TASK_STATE_AUTH_REQUIRED',
] as const;

export const a2aTextPartSchema = z
  .object({
    text: z.string(),
    mediaType: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const a2aDataPartSchema = z
  .object({
    data: z.unknown(),
    mediaType: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const a2aPartSchema = z.union([a2aTextPartSchema, a2aDataPartSchema]);

export const a2aArtifactSchema = z
  .object({
    artifactId: z.string().min(1),
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    parts: z.array(a2aPartSchema).min(1),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const a2aMessageSchema = z
  .object({
    messageId: z.string().min(1),
    role: z.enum(['ROLE_USER', 'ROLE_AGENT']),
    parts: z.array(a2aPartSchema).min(1),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const a2aTaskStatusSchema = z
  .object({
    state: z.enum(a2aTaskStates),
    timestamp: z.string().datetime().optional(),
    message: a2aMessageSchema.optional(),
  })
  .strict();

export const a2aTaskSchema = z
  .object({
    id: z.string().min(1),
    contextId: z.string().min(1),
    status: a2aTaskStatusSchema,
    artifacts: z.array(a2aArtifactSchema).default([]),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const a2aAgentSkillSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    tags: z.array(z.string()).default([]),
    inputModes: z.array(z.string()).default([]),
    outputModes: z.array(z.string()).default([]),
  })
  .strict();

export const a2aAgentInterfaceSchema = z
  .object({
    url: z.string().url(),
    protocolBinding: z.enum(['JSONRPC', 'HTTP+JSON']),
    protocolVersion: z.string().min(1),
  })
  .strict();

export const a2aAgentCardSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    version: z.string().min(1),
    supportedInterfaces: z.array(a2aAgentInterfaceSchema),
    defaultInputModes: z.array(z.string()).default([]),
    defaultOutputModes: z.array(z.string()).default([]),
    capabilities: z.record(z.string(), z.unknown()).default({}),
    skills: z.array(a2aAgentSkillSchema).default([]),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const trustReceiptSchema = z
  .object({
    receipt_id: z.string().min(1),
    packet_id: z.string().min(1),
    a2a_task_id: z.string().min(1),
    workspace_id: z.string().min(1),
    sender_member_id: z.string().min(1),
    recipient_member_ids: z.array(z.string().min(1)).default([]),
    packet_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    packet_type: z.string().min(1),
    packet_status: z.string().min(1),
    redaction_blocked: z.boolean(),
    redaction_warning_count: z.number().int().nonnegative(),
    sender_approved_at: z.string().datetime().nullable(),
    hydrated_at: z.string().datetime().nullable(),
    replied_at: z.string().datetime().nullable(),
    terminal_at: z.string().datetime().nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict();

export type A2aTaskState = (typeof a2aTaskStates)[number];
export type A2aTextPart = z.infer<typeof a2aTextPartSchema>;
export type A2aDataPart = z.infer<typeof a2aDataPartSchema>;
export type A2aPart = z.infer<typeof a2aPartSchema>;
export type A2aArtifact = z.infer<typeof a2aArtifactSchema>;
export type A2aMessage = z.infer<typeof a2aMessageSchema>;
export type A2aTask = z.infer<typeof a2aTaskSchema>;
export type A2aTaskStatus = z.infer<typeof a2aTaskStatusSchema>;
export type A2aAgentSkill = z.infer<typeof a2aAgentSkillSchema>;
export type A2aAgentInterface = z.infer<typeof a2aAgentInterfaceSchema>;
export type A2aAgentCard = z.infer<typeof a2aAgentCardSchema>;
export type TrustReceipt = z.infer<typeof trustReceiptSchema>;
