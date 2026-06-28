import { createHash, randomUUID } from 'node:crypto';

export type AuditAction =
  | 'accept'
  | 'approve'
  | 'archive'
  | 'answer_clarification'
  | 'clarify'
  | 'close'
  | 'configure_project_alias'
  | 'decline'
  | 'deliver'
  | 'draft'
  | 'edit'
  | 'hydrate'
  | 'invite'
  | 'leave'
  | 'reply'
  | 'reissue_invite_credentials'
  | 'rotate_approval_secret'
  | 'revoke'
  | 'rotate_token'
  | 'search'
  | 'send'
  | 'supersede'
  | 'view';

export interface AuditReceipt {
  receipt_id: string;
  action: AuditAction;
  actor_member_id: string;
  packet_id?: string;
  workspace_id: string;
  created_at: string;
  metadata: Record<string, unknown>;
  receipt_hash: string;
}

export interface CreateReceiptInput {
  action: AuditAction;
  actorMemberId: string;
  packetId?: string;
  workspaceId: string;
  metadata?: Record<string, unknown>;
}

export function createAuditReceipt(input: CreateReceiptInput): AuditReceipt {
  const createdAt = new Date().toISOString();
  const material = JSON.stringify({
    action: input.action,
    actor_member_id: input.actorMemberId,
    packet_id: input.packetId,
    workspace_id: input.workspaceId,
    created_at: createdAt,
    metadata: input.metadata ?? {},
  });

  return {
    receipt_id: `rcp_${randomUUID()}`,
    action: input.action,
    actor_member_id: input.actorMemberId,
    packet_id: input.packetId,
    workspace_id: input.workspaceId,
    created_at: createdAt,
    metadata: input.metadata ?? {},
    receipt_hash: `sha256:${createHash('sha256').update(material).digest('hex')}`,
  };
}
