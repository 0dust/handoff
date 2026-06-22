import { createHash, randomBytes, randomUUID } from 'node:crypto';

export type MemberRole = 'admin' | 'member';
export type MemberStatus = 'active' | 'revoked';

export interface WorkspaceRecord {
  id: string;
  name: string;
  admin_body_access: boolean;
  created_at: string;
}

export interface MemberRecord {
  id: string;
  workspace_id: string;
  handle: string;
  display_name: string;
  role: MemberRole;
  status: MemberStatus;
  token?: string;
  approval_secret?: string;
  created_at: string;
  revoked_at?: string;
}

export interface InviteRecord {
  id: string;
  workspace_id: string;
  handle: string;
  token: string;
  created_by_member_id: string;
  expires_at: string;
  accepted_at?: string;
  created_at: string;
}

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function createToken(prefix = 'relay'): string {
  return `${prefix}_${randomBytes(24).toString('base64url')}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function normalizeHandle(handle: string): string {
  const trimmed = handle.trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(trimmed)) {
    throw new Error(
      'Handle must start with a letter or number and contain only letters, numbers, _, or -',
    );
  }
  return trimmed;
}
