import type { AuditReceipt, AuditAction } from '../audit.js';
import { createAuditReceipt } from '../audit.js';
import { relayError } from '../errors.js';
import { formatHydrationContext } from '../hydration.js';
import {
  createId,
  createToken,
  hashToken,
  normalizeHandle,
  type InviteRecord,
  type MemberRecord,
  type WorkspaceRecord,
} from '../identity.js';
import type { HistoryFilter } from '../protocol/inputs.js';
import {
  buildPacketDraft,
  compressPacketToBudget,
  normalizeClaim,
  normalizeEvidence,
  packetSchema,
  validateContextBudget,
  type BuildPacketDraftInput,
  type PacketStatus,
  type ProjectIdentity,
  type RelayEvidence,
  type RelayPacket,
} from '../protocol/schema.js';
import { assertTransition, type ActorRole } from '../protocol/state-machine.js';
import { scanPacketForRedactions } from '../redaction.js';
import type { NotificationSummary } from '../notifications.js';
import type { RelayDatabase } from '../storage/database.js';
import { PacketRepository, type PacketRepositoryFilters } from './packet-repository.js';

interface MemberRow {
  id: string;
  workspace_id: string;
  handle: string;
  display_name: string;
  role: 'admin' | 'member';
  status: 'active' | 'revoked';
  token_hash: string;
  approval_secret_hash: string;
  created_at: string;
  revoked_at: string | null;
}

interface WorkspaceRow {
  id: string;
  name: string;
  admin_body_access: number;
  created_at: string;
}

interface InviteRow {
  id: string;
  workspace_id: string;
  handle: string;
  token: string;
  created_by_member_id: string;
  accepted_member_id: string | null;
  accept_idempotency_key_hash: string | null;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
}

interface ProjectAliasRow {
  id: string;
  workspace_id: string;
  canonical_project: string;
  alias: string;
  created_by_member_id: string;
  created_at: string;
}

interface NotificationRow {
  id: string;
  packet_id: string;
  workspace_id: string;
  member_id: string;
  status: 'unread' | 'read';
  created_at: string;
  read_at: string | null;
}

interface NotificationSummaryRow extends NotificationRow {
  packet_type: RelayPacket['packet_type'];
  title: string;
  summary: string;
  sender_handle: string;
  project: string;
}

const ACCEPTED_INVITE_RETRY_WINDOW_MS = 15 * 60 * 1000;

export interface CreateWorkspaceInput {
  name: string;
  adminHandle: string;
  adminName: string;
  adminBodyAccess?: boolean;
}

export type ApprovalAction = 'hydrate' | 'reply' | 'send';
export type { HistoryFilter } from '../protocol/inputs.js';

export interface PacketQueryFilters {
  project?: string;
  sender?: string;
  recipient?: string;
  status?: PacketStatus;
  fileOrSymbol?: string;
  limit?: number;
  offset?: number;
  ticketOrPr?: string;
}

export interface ProjectAliasRecord {
  id: string;
  workspace_id: string;
  canonical_project: string;
  alias: string;
  created_by_member_id: string;
  created_at: string;
}

export interface ApprovalTokenResult {
  approval_token: string;
  action: ApprovalAction;
  packet_id: string;
  expires_at: string;
}

export interface PacketDraftOptions {
  authToken: string;
  workspaceId: string;
  to: string;
  title: string;
  summary: string;
  sourceClient: RelayPacket['source_client'];
  project?: Partial<ProjectIdentity>;
  evidence?: Partial<RelayEvidence>[];
  claims?: BuildPacketDraftInput['claims'];
  filesOrSymbols?: string[];
  commandsOrTestsRun?: string[];
  whatWasTried?: string[];
  knownFailures?: string[];
  currentHypothesis?: string;
  confidence?: RelayPacket['confidence'];
  suggestedNextSteps?: string[];
}

export interface AskDraftInput extends PacketDraftOptions {
  question: string;
}

export interface ShareDraftInput extends PacketDraftOptions {
  finding: string;
}

export interface ReplyDraftInput {
  authToken: string;
  packetId: string;
  answer: string;
  summary: string;
  sourceClient: RelayPacket['source_client'];
  title?: string;
  evidence?: Partial<RelayEvidence>[];
  confidence?: RelayPacket['confidence'];
}

export interface UpdateDraftInput {
  authToken: string;
  packetId: string;
  title?: string;
  summary?: string;
  question?: string;
  finding?: string;
  claims?: BuildPacketDraftInput['claims'];
  evidence?: Partial<RelayEvidence>[];
  filesOrSymbols?: string[];
  commandsOrTestsRun?: string[];
  whatWasTried?: string[];
  knownFailures?: string[];
  currentHypothesis?: string;
  confidence?: RelayPacket['confidence'];
  suggestedNextSteps?: string[];
}

export interface PacketResult {
  id: string;
  packet: RelayPacket;
}

export interface PacketSearchResult {
  packet_id: string;
  packet_type: RelayPacket['packet_type'];
  workspace_id: string;
  sender_member_id: string;
  recipient_member_ids: string[];
  status: RelayPacket['status'];
  title: string;
  summary: string;
  project: RelayPacket['project'];
  source_client: RelayPacket['source_client'];
  created_at: string;
  updated_at: string;
  expires_at?: string;
  recheck_by?: string;
  body_access: boolean;
}

export interface MemberRemovalResult {
  member: MemberRecord;
  alreadyRemoved: boolean;
}

export interface NotificationRecord extends NotificationSummary {
  notification_id: string;
  status: 'unread' | 'read';
  created_at: string;
  read_at?: string;
}

function rowToMember(row: MemberRow, token?: string, approvalSecret?: string): MemberRecord {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    handle: row.handle,
    display_name: row.display_name,
    role: row.role,
    status: row.status,
    token,
    approval_secret: approvalSecret,
    created_at: row.created_at,
    revoked_at: row.revoked_at ?? undefined,
  };
}

function rowToWorkspace(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    name: row.name,
    admin_body_access: Boolean(row.admin_body_access),
    created_at: row.created_at,
  };
}

function rowToInvite(row: InviteRow): InviteRecord {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    handle: row.handle,
    token: row.token,
    created_by_member_id: row.created_by_member_id,
    expires_at: row.expires_at,
    accepted_at: row.accepted_at ?? undefined,
    created_at: row.created_at,
  };
}

function rowToProjectAlias(row: ProjectAliasRow): ProjectAliasRecord {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    canonical_project: row.canonical_project,
    alias: row.alias,
    created_by_member_id: row.created_by_member_id,
    created_at: row.created_at,
  };
}

function rowToNotificationRecord(row: NotificationSummaryRow): NotificationRecord {
  return {
    notification_id: row.id,
    packet_id: row.packet_id,
    packet_type: row.packet_type,
    title: row.title,
    summary: row.summary,
    sender_handle: row.sender_handle,
    project: parseJson<ProjectIdentity>(row.project).repo_name,
    status: row.status,
    created_at: row.created_at,
    read_at: row.read_at ?? undefined,
  };
}

function normalizeProjectName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw relayError('INVALID_INPUT', 'Project alias values cannot be empty.', 400);
  }
  return normalized;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export class RelayService {
  private readonly packets: PacketRepository;

  constructor(private readonly db: RelayDatabase) {
    this.packets = new PacketRepository(db);
  }

  close(): void {
    this.db.close();
  }

  createWorkspace(input: CreateWorkspaceInput): {
    workspace: WorkspaceRecord;
    admin: MemberRecord & { token: string; approval_secret: string };
  } {
    const now = new Date().toISOString();
    const workspace: WorkspaceRecord = {
      id: createId('wrk'),
      name: input.name,
      admin_body_access: input.adminBodyAccess ?? false,
      created_at: now,
    };
    const token = createToken('relay_member');
    const approvalSecret = createToken('relay_approval_secret');
    const admin: MemberRecord & { token: string; approval_secret: string } = {
      id: createId('mem'),
      workspace_id: workspace.id,
      handle: normalizeHandle(input.adminHandle),
      display_name: input.adminName,
      role: 'admin',
      status: 'active',
      token,
      approval_secret: approvalSecret,
      created_at: now,
    };

    const transaction = this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO workspaces (id, name, admin_body_access, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(
          workspace.id,
          workspace.name,
          workspace.admin_body_access ? 1 : 0,
          workspace.created_at,
        );
      this.db
        .prepare(
          `INSERT INTO members
          (id, workspace_id, handle, display_name, role, status, token_hash, approval_secret_hash, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          admin.id,
          admin.workspace_id,
          admin.handle,
          admin.display_name,
          admin.role,
          admin.status,
          hashToken(token),
          hashToken(approvalSecret),
          admin.created_at,
        );
    });
    transaction();

    return { workspace, admin };
  }

  inviteMember(input: { adminToken: string; workspaceId: string; handle: string }): {
    invite: InviteRecord;
  } {
    const admin = this.requireAdmin(input.adminToken, input.workspaceId);
    const handle = normalizeHandle(input.handle);
    const existing = this.findMemberByHandle(input.workspaceId, handle, true);
    if (existing?.status === 'revoked') {
      throw relayError('INVALID_RECIPIENT', `Recipient @${handle} is revoked.`, 403);
    }
    if (existing) {
      throw relayError('INVALID_INPUT', `Member @${handle} already exists in this workspace.`, 409);
    }

    const now = new Date().toISOString();
    const invite: InviteRecord = {
      id: createId('inv'),
      workspace_id: input.workspaceId,
      handle,
      token: createToken('relay_invite'),
      created_by_member_id: admin.id,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      created_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO invites
        (id, workspace_id, handle, token, created_by_member_id, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        invite.id,
        invite.workspace_id,
        invite.handle,
        invite.token,
        invite.created_by_member_id,
        invite.expires_at,
        invite.created_at,
      );
    return { invite };
  }

  acceptInvite(input: { inviteToken: string; displayName: string; idempotencyKey?: string }): {
    member: MemberRecord & { token: string; approval_secret: string };
    workspace: WorkspaceRecord;
  } {
    const inviteRow = this.db
      .prepare('SELECT * FROM invites WHERE token = ?')
      .get(input.inviteToken) as InviteRow | undefined;
    if (!inviteRow) {
      throw relayError('NOT_FOUND', 'Invite not found.', 404);
    }
    if (inviteRow.accepted_at) {
      const idempotencyKeyHash = input.idempotencyKey ? hashToken(input.idempotencyKey) : undefined;
      const acceptedAt = Date.parse(inviteRow.accepted_at);
      const retryWindowOpen =
        Number.isFinite(acceptedAt) && Date.now() - acceptedAt <= ACCEPTED_INVITE_RETRY_WINDOW_MS;
      if (
        idempotencyKeyHash &&
        inviteRow.accept_idempotency_key_hash === idempotencyKeyHash &&
        inviteRow.accepted_member_id &&
        retryWindowOpen
      ) {
        return this.reissueAcceptedInviteCredentials({
          displayName: input.displayName,
          memberId: inviteRow.accepted_member_id,
          workspaceId: inviteRow.workspace_id,
        });
      }
      throw relayError('INVALID_INPUT', 'Invite has already been accepted.', 409);
    }
    if (Date.parse(inviteRow.expires_at) < Date.now()) {
      throw relayError('INVALID_INPUT', 'Invite has expired.', 410);
    }

    const workspace = this.getWorkspace(inviteRow.workspace_id);
    const now = new Date().toISOString();
    const token = createToken('relay_member');
    const approvalSecret = createToken('relay_approval_secret');
    const member: MemberRecord & { token: string; approval_secret: string } = {
      id: createId('mem'),
      workspace_id: inviteRow.workspace_id,
      handle: inviteRow.handle,
      display_name: input.displayName,
      role: 'member',
      status: 'active',
      token,
      approval_secret: approvalSecret,
      created_at: now,
    };

    const transaction = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO members
          (id, workspace_id, handle, display_name, role, status, token_hash, approval_secret_hash, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          member.id,
          member.workspace_id,
          member.handle,
          member.display_name,
          member.role,
          member.status,
          hashToken(token),
          hashToken(approvalSecret),
          member.created_at,
        );
      this.db
        .prepare(
          `UPDATE invites
          SET accepted_at = ?,
              accepted_member_id = ?,
              accept_idempotency_key_hash = ?
          WHERE id = ?`,
        )
        .run(
          now,
          member.id,
          input.idempotencyKey ? hashToken(input.idempotencyKey) : null,
          inviteRow.id,
        );
    });
    transaction();

    return { member, workspace };
  }

  private reissueAcceptedInviteCredentials(input: {
    displayName: string;
    memberId: string;
    workspaceId: string;
  }): {
    member: MemberRecord & { token: string; approval_secret: string };
    workspace: WorkspaceRecord;
  } {
    const existing = this.getMember(input.memberId);
    if (existing.status === 'revoked') {
      throw relayError('TOKEN_REVOKED', 'This member token has been revoked.', 403);
    }
    const token = createToken('relay_member');
    const approvalSecret = createToken('relay_approval_secret');
    const reissuedAt = new Date().toISOString();
    let invalidatedApprovalTokens = 0;
    const reissue = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE members
          SET display_name = ?,
              token_hash = ?,
              approval_secret_hash = ?
          WHERE id = ?`,
        )
        .run(input.displayName, hashToken(token), hashToken(approvalSecret), input.memberId);
      const invalidated = this.db
        .prepare(
          `UPDATE approval_tokens
          SET consumed_at = ?
          WHERE actor_member_id = ?
            AND consumed_at IS NULL`,
        )
        .run(reissuedAt, input.memberId);
      invalidatedApprovalTokens = invalidated.changes;
      this.recordAudit({
        action: 'reissue_invite_credentials',
        actorMemberId: input.memberId,
        workspaceId: input.workspaceId,
        metadata: { invalidated_approval_tokens: invalidatedApprovalTokens },
      });
    });
    reissue();
    return {
      member: {
        ...existing,
        display_name: input.displayName,
        token,
        approval_secret: approvalSecret,
      },
      workspace: this.getWorkspace(input.workspaceId),
    };
  }

  getInvite(input: { inviteToken: string }): { invite: InviteRecord; workspace: WorkspaceRecord } {
    const inviteRow = this.db
      .prepare('SELECT * FROM invites WHERE token = ?')
      .get(input.inviteToken) as InviteRow | undefined;
    if (!inviteRow) {
      throw relayError('NOT_FOUND', 'Invite not found.', 404);
    }
    return {
      invite: rowToInvite(inviteRow),
      workspace: this.getWorkspace(inviteRow.workspace_id),
    };
  }

  listMembers(input: { authToken: string; workspaceId: string }): MemberRecord[] {
    this.requireMember(input.authToken, input.workspaceId);
    return (
      this.db
        .prepare('SELECT * FROM members WHERE workspace_id = ? ORDER BY handle')
        .all(input.workspaceId) as MemberRow[]
    ).map((row) => rowToMember(row));
  }

  configureProjectAlias(input: {
    authToken: string;
    workspaceId: string;
    canonicalProject: string;
    alias: string;
  }): { alias: ProjectAliasRecord } {
    const admin = this.requireAdmin(input.authToken, input.workspaceId);
    const canonicalProject = normalizeProjectName(input.canonicalProject);
    const alias = normalizeProjectName(input.alias);
    const now = new Date().toISOString();
    const id = createId('pal');
    this.db
      .prepare(
        `INSERT INTO project_aliases
        (id, workspace_id, canonical_project, alias, created_by_member_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, alias) DO UPDATE SET
          id = excluded.id,
          canonical_project = excluded.canonical_project,
          created_by_member_id = excluded.created_by_member_id,
          created_at = excluded.created_at`,
      )
      .run(id, input.workspaceId, canonicalProject, alias, admin.id, now);
    this.recordAudit({
      action: 'configure_project_alias',
      actorMemberId: admin.id,
      workspaceId: input.workspaceId,
      metadata: { canonical_project: canonicalProject, alias },
    });
    return {
      alias: {
        id,
        workspace_id: input.workspaceId,
        canonical_project: canonicalProject,
        alias,
        created_by_member_id: admin.id,
        created_at: now,
      },
    };
  }

  listProjectAliases(input: { authToken: string; workspaceId: string }): ProjectAliasRecord[] {
    this.requireMember(input.authToken, input.workspaceId);
    return (
      this.db
        .prepare(
          `SELECT * FROM project_aliases
          WHERE workspace_id = ?
          ORDER BY canonical_project, alias`,
        )
        .all(input.workspaceId) as ProjectAliasRow[]
    ).map((row) => rowToProjectAlias(row));
  }

  revokeMember(input: {
    adminToken: string;
    workspaceId: string;
    memberId: string;
  }): MemberRemovalResult {
    return this.removeMember({
      adminToken: input.adminToken,
      workspaceId: input.workspaceId,
      member: input.memberId,
    });
  }

  removeMember(input: {
    adminToken: string;
    workspaceId: string;
    member: string;
  }): MemberRemovalResult {
    const admin = this.requireAdmin(input.adminToken, input.workspaceId);
    const member = this.resolveWorkspaceMember(input.workspaceId, input.member);
    if (admin.id === member.id) {
      throw relayError('INVALID_INPUT', 'Admins cannot remove themselves.', 400);
    }
    if (member.workspace_id !== input.workspaceId) {
      throw relayError('FORBIDDEN', 'Member belongs to a different workspace.', 403);
    }
    return this.markMemberRemoved({
      action: 'revoke',
      actorMemberId: admin.id,
      member,
      metadata: { revoked_member_id: member.id },
      workspaceId: input.workspaceId,
    });
  }

  leaveWorkspace(input: { authToken: string; workspaceId: string }): MemberRemovalResult {
    const member = this.authenticate(input.authToken, { allowRevoked: true });
    if (member.workspace_id !== input.workspaceId) {
      throw relayError('FORBIDDEN', 'Token belongs to a different workspace.', 403);
    }
    if (member.role === 'admin') {
      throw relayError(
        'INVALID_INPUT',
        'Workspace admins cannot leave their own workspace. Remove member profiles with `handoff remove-member <handle>` or create a separate member profile.',
        400,
      );
    }
    return this.markMemberRemoved({
      action: 'leave',
      actorMemberId: member.id,
      member,
      metadata: { left_member_id: member.id },
      workspaceId: input.workspaceId,
    });
  }

  private markMemberRemoved(input: {
    action: 'leave' | 'revoke';
    actorMemberId: string;
    member: MemberRecord;
    metadata: Record<string, unknown>;
    workspaceId: string;
  }): MemberRemovalResult {
    if (input.member.status === 'revoked') {
      return { member: input.member, alreadyRemoved: true };
    }
    const revokedAt = new Date().toISOString();
    const deactivate = this.db.transaction(() => {
      this.db
        .prepare('UPDATE members SET status = ?, revoked_at = ? WHERE id = ?')
        .run('revoked', revokedAt, input.member.id);
      this.db
        .prepare(
          `UPDATE approval_tokens
          SET consumed_at = ?
          WHERE actor_member_id = ?
            AND consumed_at IS NULL`,
        )
        .run(revokedAt, input.member.id);
    });
    deactivate();
    this.recordAudit({
      action: input.action,
      actorMemberId: input.actorMemberId,
      workspaceId: input.workspaceId,
      metadata: input.metadata,
    });
    return {
      member: { ...input.member, status: 'revoked', revoked_at: revokedAt },
      alreadyRemoved: false,
    };
  }

  rotateMemberToken(input: { authToken: string }): { member: MemberRecord; token: string } {
    const member = this.authenticate(input.authToken);
    const token = createToken('relay_member');
    this.db
      .prepare('UPDATE members SET token_hash = ? WHERE id = ?')
      .run(hashToken(token), member.id);
    this.recordAudit({
      action: 'rotate_token',
      actorMemberId: member.id,
      workspaceId: member.workspace_id,
      metadata: {},
    });
    return { member, token };
  }

  rotateApprovalSecret(input: { authToken: string; approvalSecret?: string }): {
    member: MemberRecord;
    approval_secret: string;
  } {
    const member = this.authenticate(input.authToken);
    this.requireApprovalSecret(member, input.approvalSecret);
    const approvalSecret = createToken('relay_approval_secret');
    const rotatedAt = new Date().toISOString();
    const rotate = this.db.transaction(() => {
      this.db
        .prepare('UPDATE members SET approval_secret_hash = ? WHERE id = ?')
        .run(hashToken(approvalSecret), member.id);
      const invalidated = this.db
        .prepare(
          `UPDATE approval_tokens
          SET consumed_at = ?
          WHERE actor_member_id = ?
            AND consumed_at IS NULL`,
        )
        .run(rotatedAt, member.id);
      this.recordAudit({
        action: 'rotate_approval_secret',
        actorMemberId: member.id,
        workspaceId: member.workspace_id,
        metadata: { invalidated_approval_tokens: invalidated.changes },
      });
    });
    rotate();
    return { member, approval_secret: approvalSecret };
  }

  createApprovalToken(input: {
    authToken: string;
    approvalSecret?: string;
    packetId: string;
    action: ApprovalAction;
  }): ApprovalTokenResult {
    const actor = this.authenticate(input.authToken);
    this.requireApprovalSecret(actor, input.approvalSecret);
    const packet = this.getPacket(input.packetId);
    this.assertApprovalTokenAllowed(actor, packet, input.action);

    const token = createToken('relay_approval');
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    this.db
      .prepare(
        `INSERT INTO approval_tokens
        (id, packet_id, workspace_id, actor_member_id, action, token_hash, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        createId('apr'),
        packet.packet_id,
        packet.workspace_id,
        actor.id,
        input.action,
        hashToken(token),
        expiresAt,
        now,
      );
    this.recordAudit({
      action: 'approve',
      actorMemberId: actor.id,
      packetId: packet.packet_id,
      workspaceId: packet.workspace_id,
      metadata: { approval_action: input.action, token_created: true },
    });

    return {
      approval_token: token,
      action: input.action,
      packet_id: packet.packet_id,
      expires_at: expiresAt,
    };
  }

  createAskDraft(input: AskDraftInput): PacketResult {
    return this.createPacketDraft('ask', input, { question: input.question });
  }

  createShareDraft(input: ShareDraftInput): PacketResult {
    return this.createPacketDraft('share', input, { finding: input.finding });
  }

  updateDraft(input: UpdateDraftInput): PacketResult {
    const actor = this.authenticate(input.authToken);
    const packet = this.getPacket(input.packetId);
    this.requireSender(actor, packet);
    if (!['ask', 'share'].includes(packet.packet_type)) {
      throw relayError('INVALID_INPUT', 'Only ask/share drafts can be edited before send.', 400);
    }
    if (packet.status !== 'pending_sender_approval') {
      throw relayError(
        'INVALID_STATE_TRANSITION',
        'Only drafts pending sender approval can be edited.',
        409,
      );
    }

    const changedFields = Object.entries(input)
      .filter(([key, value]) => !['authToken', 'packetId'].includes(key) && value !== undefined)
      .map(([key]) => key);
    const updated = this.preparePacket(
      packetSchema.parse({
        ...packet,
        title: input.title ?? packet.title,
        summary: input.summary ?? packet.summary,
        question: input.question ?? packet.question,
        finding: input.finding ?? packet.finding,
        claims: input.claims?.map(normalizeClaim) ?? packet.claims,
        evidence: input.evidence?.map(normalizeEvidence) ?? packet.evidence,
        files_or_symbols: input.filesOrSymbols ?? packet.files_or_symbols,
        commands_or_tests_run: input.commandsOrTestsRun ?? packet.commands_or_tests_run,
        what_was_tried: input.whatWasTried ?? packet.what_was_tried,
        known_failures: input.knownFailures ?? packet.known_failures,
        current_hypothesis: input.currentHypothesis ?? packet.current_hypothesis,
        confidence: input.confidence ?? packet.confidence,
        suggested_next_steps: input.suggestedNextSteps ?? packet.suggested_next_steps,
      }),
    );
    this.updatePacket(updated);
    this.recordAudit({
      action: 'edit',
      actorMemberId: actor.id,
      packetId: updated.packet_id,
      workspaceId: updated.workspace_id,
      metadata: { changed_fields: changedFields },
    });
    return { id: updated.packet_id, packet: this.getPacket(updated.packet_id) };
  }

  approveAndSend(input: {
    authToken: string;
    packetId: string;
    approvalToken?: string;
    allowSecretOverride?: boolean;
  }): PacketResult {
    const actor = this.authenticate(input.authToken);
    let packet = this.getPacket(input.packetId);
    this.requireSender(actor, packet);

    if (packet.packet_type === 'reply') {
      return this.approveReply({
        authToken: input.authToken,
        replyPacketId: input.packetId,
        approvalToken: input.approvalToken,
      });
    }
    this.consumeApprovalToken({
      actor,
      packet,
      action: 'send',
      approvalToken: input.approvalToken,
    });
    if (packet.redaction_report.blocked && !input.allowSecretOverride) {
      throw relayError(
        'REDACTION_BLOCKED',
        'Redaction blocked this packet. Remove secret-looking evidence or explicitly override.',
        422,
        packet.redaction_report,
      );
    }
    for (const recipientId of packet.recipient_member_ids) {
      const recipient = this.getMember(recipientId);
      if (recipient.status === 'revoked') {
        throw relayError('INVALID_RECIPIENT', `Recipient @${recipient.handle} is revoked.`, 403);
      }
    }

    packet = this.transitionPacket(packet, 'sent', actor, 'sender');
    this.recordAudit({
      action: 'approve',
      actorMemberId: actor.id,
      packetId: packet.packet_id,
      workspaceId: packet.workspace_id,
      metadata: { status: 'sent' },
    });
    this.recordAudit({
      action: 'send',
      actorMemberId: actor.id,
      packetId: packet.packet_id,
      workspaceId: packet.workspace_id,
      metadata: { recipient_member_ids: packet.recipient_member_ids },
    });
    packet = this.transitionPacket(packet, 'delivered', actor, 'system');
    for (const recipientId of packet.recipient_member_ids) {
      this.createNotification(packet, recipientId);
    }
    this.recordAudit({
      action: 'deliver',
      actorMemberId: actor.id,
      packetId: packet.packet_id,
      workspaceId: packet.workspace_id,
      metadata: { recipient_member_ids: packet.recipient_member_ids },
    });

    return { id: packet.packet_id, packet: this.getPacket(packet.packet_id) };
  }

  listInbox(input: { authToken: string; workspaceId: string }): RelayPacket[] {
    const member = this.requireMember(input.authToken, input.workspaceId);
    return this.listWorkspacePackets(input.workspaceId)
      .filter((packet) => packet.recipient_member_ids.includes(member.id))
      .filter(
        (packet) =>
          ![
            'archived',
            'closed_resolved',
            'closed_unresolved',
            'declined',
            'expired',
            'superseded',
          ].includes(packet.status),
      );
  }

  listNotifications(input: { authToken: string; workspaceId: string }): NotificationRecord[] {
    const member = this.requireMember(input.authToken, input.workspaceId);
    return (
      this.db
        .prepare(
          `SELECT
            notifications.id,
            notifications.packet_id,
            notifications.workspace_id,
            notifications.member_id,
            notifications.status,
            notifications.created_at,
            notifications.read_at,
            packets.packet_type,
            packets.title,
            packets.summary,
            packets.project,
            members.handle AS sender_handle
          FROM notifications
          JOIN packets ON packets.id = notifications.packet_id
          JOIN members ON members.id = packets.sender_member_id
          WHERE notifications.workspace_id = ?
            AND notifications.member_id = ?
            AND notifications.status = 'unread'
          ORDER BY notifications.created_at ASC`,
        )
        .all(input.workspaceId, member.id) as NotificationSummaryRow[]
    ).map((row) => rowToNotificationRecord(row));
  }

  ackNotification(input: { authToken: string; notificationId: string }): {
    notification: NotificationRecord;
  } {
    const member = this.authenticate(input.authToken);
    const row = this.db
      .prepare(
        `SELECT
          notifications.id,
          notifications.packet_id,
          notifications.workspace_id,
          notifications.member_id,
          notifications.status,
          notifications.created_at,
          notifications.read_at,
          packets.packet_type,
          packets.title,
          packets.summary,
          packets.project,
          members.handle AS sender_handle
        FROM notifications
        JOIN packets ON packets.id = notifications.packet_id
        JOIN members ON members.id = packets.sender_member_id
        WHERE notifications.id = ?`,
      )
      .get(input.notificationId) as NotificationSummaryRow | undefined;
    if (!row) {
      throw relayError('NOT_FOUND', 'Notification not found.', 404);
    }
    if (row.member_id !== member.id) {
      throw relayError('FORBIDDEN', 'Notification belongs to a different member.', 403);
    }
    if (row.status === 'read') {
      return { notification: rowToNotificationRecord(row) };
    }
    const readAt = new Date().toISOString();
    this.db
      .prepare('UPDATE notifications SET status = ?, read_at = ? WHERE id = ?')
      .run('read', readAt, input.notificationId);
    return {
      notification: rowToNotificationRecord({
        ...row,
        status: 'read',
        read_at: readAt,
      }),
    };
  }

  viewPacket(input: { authToken: string; packetId: string }): PacketResult {
    const actor = this.authenticate(input.authToken);
    let packet = this.getPacket(input.packetId);
    this.requireReadable(actor, packet);
    const role = this.actorRole(actor, packet);
    if (role === 'recipient' && (packet.status === 'delivered' || packet.status === 'replied')) {
      packet = this.transitionPacket(packet, 'viewed', actor, 'recipient');
    }
    if (role === 'recipient') {
      this.markNotificationRead(packet.packet_id, actor.id);
    }
    this.recordAudit({
      action: 'view',
      actorMemberId: actor.id,
      packetId: packet.packet_id,
      workspaceId: packet.workspace_id,
      metadata: { status: packet.status },
    });
    return { id: packet.packet_id, packet };
  }

  getPacketForMember(input: { authToken: string; packetId: string }): PacketResult {
    const actor = this.authenticate(input.authToken);
    const packet = this.getPacket(input.packetId);
    this.requireReadable(actor, packet);
    return { id: packet.packet_id, packet };
  }

  acceptPacket(input: { authToken: string; packetId: string }): PacketResult {
    const actor = this.authenticate(input.authToken);
    const packet = this.getPacket(input.packetId);
    this.requireRecipient(actor, packet);
    const accepted = this.transitionPacket(packet, 'accepted', actor, 'recipient');
    this.markNotificationRead(packet.packet_id, actor.id);
    this.recordAudit({
      action: 'accept',
      actorMemberId: actor.id,
      packetId: packet.packet_id,
      workspaceId: packet.workspace_id,
      metadata: {},
    });
    return { id: accepted.packet_id, packet: accepted };
  }

  hydratePacket(input: {
    authToken: string;
    packetId: string;
    client: string;
    sessionId?: string;
    approvalToken?: string;
  }): ReturnType<typeof formatHydrationContext> & { packet: RelayPacket } {
    const actor = this.authenticate(input.authToken);
    let packet = this.getPacket(input.packetId);
    this.requireRecipient(actor, packet);
    this.consumeApprovalToken({
      actor,
      packet,
      action: 'hydrate',
      approvalToken: input.approvalToken,
    });
    const targetStatus = 'hydrated';
    packet = this.transitionPacket(packet, targetStatus, actor, 'recipient');
    this.markNotificationRead(packet.packet_id, actor.id);
    const hydration = formatHydrationContext(packet, {
      hydratedBy: actor.id,
      client: input.client,
      sessionId: input.sessionId,
    });
    this.insertAuditReceipt(hydration.receipt);
    this.db
      .prepare(
        `INSERT INTO hydration_receipts
        (receipt_id, packet_id, workspace_id, actor_member_id, client, session_id, context, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        hydration.receipt.receipt_id,
        packet.packet_id,
        packet.workspace_id,
        actor.id,
        input.client,
        input.sessionId ?? null,
        hydration.context,
        hydration.receipt.created_at,
      );
    packet = this.updatePacket({ ...packet, audit_receipt: hydration.receipt });
    return { ...hydration, packet };
  }

  createReplyDraft(input: ReplyDraftInput): PacketResult {
    const actor = this.authenticate(input.authToken);
    let original = this.getPacket(input.packetId);
    this.requireRecipient(actor, original);
    if (!['accepted', 'hydrated'].includes(original.status)) {
      throw relayError(
        'INVALID_STATE_TRANSITION',
        'A recipient must accept or hydrate an ask before replying.',
        409,
      );
    }
    if (original.packet_type !== 'ask') {
      throw relayError('INVALID_INPUT', 'Replies can only be created for ask packets.', 400);
    }

    if (original.status === 'accepted' || original.status === 'hydrated') {
      original = this.transitionPacket(original, 'response_drafting', actor, 'recipient');
    }

    const packet = this.preparePacket(
      buildPacketDraft({
        packet_type: 'reply',
        workspace_id: original.workspace_id,
        sender_member_id: actor.id,
        recipient_member_ids: [original.sender_member_id],
        parent_packet_id: original.packet_id,
        status: 'pending_recipient_approval',
        title: input.title ?? `Reply: ${original.title}`,
        summary: input.summary,
        answer: input.answer,
        source_client: input.sourceClient,
        project: original.project,
        evidence: input.evidence,
        confidence: input.confidence,
      }),
    );
    this.insertPacket(packet);
    this.insertAuditReceipt(packet.audit_receipt as AuditReceipt);
    this.recordAudit({
      action: 'reply',
      actorMemberId: actor.id,
      packetId: original.packet_id,
      workspaceId: original.workspace_id,
      metadata: { reply_packet_id: packet.packet_id, status: 'pending_recipient_approval' },
    });
    return { id: packet.packet_id, packet };
  }

  approveReply(input: {
    authToken: string;
    replyPacketId: string;
    approvalToken?: string;
  }): PacketResult {
    const actor = this.authenticate(input.authToken);
    let reply = this.getPacket(input.replyPacketId);
    this.requireSender(actor, reply);
    if (reply.packet_type !== 'reply') {
      throw relayError('INVALID_INPUT', 'Packet is not a reply.', 400);
    }
    this.consumeApprovalToken({
      actor,
      packet: reply,
      action: 'reply',
      approvalToken: input.approvalToken,
    });
    reply = this.transitionPacket(reply, 'replied', actor, 'recipient');
    for (const recipientId of reply.recipient_member_ids) {
      this.createNotification(reply, recipientId);
    }
    this.recordAudit({
      action: 'approve',
      actorMemberId: actor.id,
      packetId: reply.packet_id,
      workspaceId: reply.workspace_id,
      metadata: { reply_packet_id: reply.packet_id },
    });

    if (reply.parent_packet_id) {
      let parent = this.getPacket(reply.parent_packet_id);
      if (parent.status === 'response_drafting') {
        parent = this.transitionPacket(parent, 'pending_recipient_approval', actor, 'recipient');
      }
      parent = this.transitionPacket(parent, 'replied', actor, 'recipient');
      this.recordAudit({
        action: 'reply',
        actorMemberId: actor.id,
        packetId: parent.packet_id,
        workspaceId: parent.workspace_id,
        metadata: { reply_packet_id: reply.packet_id, status: 'replied' },
      });
    }

    return { id: reply.packet_id, packet: this.getPacket(reply.packet_id) };
  }

  declinePacket(input: { authToken: string; packetId: string; reason?: string }): PacketResult {
    const actor = this.authenticate(input.authToken);
    const packet = this.getPacket(input.packetId);
    this.requireRecipient(actor, packet);
    const declined = this.transitionPacket(packet, 'declined', actor, 'recipient');
    this.markNotificationRead(packet.packet_id, actor.id);
    this.recordAudit({
      action: 'decline',
      actorMemberId: actor.id,
      packetId: packet.packet_id,
      workspaceId: packet.workspace_id,
      metadata: { reason: input.reason },
    });
    return { id: declined.packet_id, packet: declined };
  }

  archivePacket(input: { authToken: string; packetId: string }): PacketResult {
    const actor = this.authenticate(input.authToken);
    const packet = this.getPacket(input.packetId);
    this.requireReadable(actor, packet);
    const role = this.actorRole(actor, packet);
    const archived = this.transitionPacket(
      packet,
      'archived',
      actor,
      role === 'admin' ? 'admin' : role,
    );
    if (role === 'recipient') {
      this.markNotificationRead(packet.packet_id, actor.id);
    }
    this.recordAudit({
      action: 'archive',
      actorMemberId: actor.id,
      packetId: packet.packet_id,
      workspaceId: packet.workspace_id,
      metadata: {},
    });
    return { id: archived.packet_id, packet: archived };
  }

  requestClarification(input: {
    authToken: string;
    packetId: string;
    question: string;
    requestedEvidence?: string[];
  }): PacketResult {
    const actor = this.authenticate(input.authToken);
    let original = this.getPacket(input.packetId);
    this.requireRecipient(actor, original);
    original = this.transitionPacket(original, 'clarification_requested', actor, 'recipient');
    this.markNotificationRead(original.packet_id, actor.id);
    this.recordAudit({
      action: 'clarify',
      actorMemberId: actor.id,
      packetId: original.packet_id,
      workspaceId: original.workspace_id,
      metadata: { question: input.question, requested_evidence: input.requestedEvidence ?? [] },
    });

    const packet = this.preparePacket(
      buildPacketDraft({
        packet_type: 'clarification',
        workspace_id: original.workspace_id,
        sender_member_id: actor.id,
        recipient_member_ids: [original.sender_member_id],
        parent_packet_id: original.packet_id,
        status: 'delivered',
        title: `Clarification: ${original.title}`,
        summary: input.question,
        question: input.question,
        source_client: original.source_client,
        project: original.project,
        suggested_next_steps: input.requestedEvidence,
      }),
    );
    this.insertPacket(packet);
    this.insertAuditReceipt(packet.audit_receipt as AuditReceipt);
    this.createNotification(packet, original.sender_member_id);
    return { id: packet.packet_id, packet };
  }

  closePacket(input: {
    authToken: string;
    packetId: string;
    resolution: 'resolved' | 'unresolved';
  }): PacketResult {
    const actor = this.authenticate(input.authToken);
    const packet = this.getPacket(input.packetId);
    this.requireSender(actor, packet);
    const status = input.resolution === 'resolved' ? 'closed_resolved' : 'closed_unresolved';
    const closed = this.transitionPacket(packet, status, actor, 'sender');
    this.recordAudit({
      action: 'close',
      actorMemberId: actor.id,
      packetId: packet.packet_id,
      workspaceId: packet.workspace_id,
      metadata: { resolution: input.resolution },
    });
    return { id: closed.packet_id, packet: closed };
  }

  searchPackets(
    input: {
      authToken: string;
      workspaceId: string;
      query?: string;
    } & PacketQueryFilters,
  ): PacketSearchResult[] {
    const actor = this.requireMember(input.authToken, input.workspaceId);
    const query = input.query?.trim().toLowerCase() ?? '';
    const results = this.packets.search({
      actorIsAdmin: actor.role === 'admin',
      actorMemberId: actor.id,
      adminBodyAccess: this.adminBodyAccessFor(actor, input.workspaceId),
      filters: {
        ...this.resolveRepositoryFilters(input.workspaceId, input),
        query,
      },
      workspaceId: input.workspaceId,
    });
    this.recordAudit({
      action: 'search',
      actorMemberId: actor.id,
      workspaceId: input.workspaceId,
      metadata: { query, filters: this.auditFilterMetadata(input) },
    });
    return results.map((packet) => this.toSearchResult(actor, packet));
  }

  listHistory(
    input: {
      authToken: string;
      workspaceId: string;
      filter?: HistoryFilter;
      query?: string;
    } & PacketQueryFilters,
  ): PacketSearchResult[] {
    const actor = this.requireMember(input.authToken, input.workspaceId);
    const filter = input.filter ?? 'all';
    const query = input.query?.trim().toLowerCase() ?? '';
    const results = this.packets.search({
      actorIsAdmin: actor.role === 'admin',
      actorMemberId: actor.id,
      adminBodyAccess: this.adminBodyAccessFor(actor, input.workspaceId),
      filters: {
        ...this.resolveRepositoryFilters(input.workspaceId, input),
        historyFilter: filter,
        query,
      },
      workspaceId: input.workspaceId,
    });
    this.recordAudit({
      action: 'search',
      actorMemberId: actor.id,
      workspaceId: input.workspaceId,
      metadata: { query, history_filter: filter, filters: this.auditFilterMetadata(input) },
    });
    return results.map((packet) => this.toSearchResult(actor, packet));
  }

  listAuditReceipts(input: {
    authToken: string;
    workspaceId: string;
    packetId?: string;
  }): AuditReceipt[] {
    const actor = this.requireMember(input.authToken, input.workspaceId);
    if (input.packetId) {
      const packet = this.getPacket(input.packetId);
      if (!this.canReadMetadata(actor, packet)) {
        throw relayError('FORBIDDEN', 'Packet audit metadata is not visible to this member.', 403);
      }
    } else if (actor.role !== 'admin') {
      throw relayError('FORBIDDEN', 'Only admins can view workspace audit logs.', 403);
    }

    const rows = input.packetId
      ? (this.db
          .prepare(
            'SELECT * FROM audit_receipts WHERE workspace_id = ? AND packet_id = ? ORDER BY created_at',
          )
          .all(input.workspaceId, input.packetId) as any[])
      : (this.db
          .prepare('SELECT * FROM audit_receipts WHERE workspace_id = ? ORDER BY created_at')
          .all(input.workspaceId) as any[]);

    return rows.map((row) => ({
      receipt_id: row.receipt_id,
      workspace_id: row.workspace_id,
      packet_id: row.packet_id ?? undefined,
      actor_member_id: row.actor_member_id,
      action: row.action,
      created_at: row.created_at,
      metadata: parseJson(row.metadata),
      receipt_hash: row.receipt_hash,
    }));
  }

  getPacket(packetId: string): RelayPacket {
    const packet = this.packets.get(packetId);
    if (!packet) {
      throw relayError('NOT_FOUND', 'Packet not found.', 404);
    }
    return packet;
  }

  private createPacketDraft(
    packetType: 'ask' | 'share',
    input: AskDraftInput | ShareDraftInput,
    main: { question: string } | { finding: string },
  ): PacketResult {
    const actor = this.requireMember(input.authToken, input.workspaceId);
    const recipient = this.resolveRecipient(input.workspaceId, input.to);
    const project = input.project
      ? {
          ...input.project,
          repo_name: this.resolveCanonicalProjectName(
            input.workspaceId,
            input.project.repo_name ?? 'unknown-project',
          ),
        }
      : input.project;
    const base = buildPacketDraft({
      packet_type: packetType,
      workspace_id: input.workspaceId,
      sender_member_id: actor.id,
      recipient_member_ids: [recipient.id],
      title: input.title,
      summary: input.summary,
      source_client: input.sourceClient,
      project,
      evidence: input.evidence,
      claims: input.claims,
      files_or_symbols: input.filesOrSymbols,
      commands_or_tests_run: input.commandsOrTestsRun,
      what_was_tried: input.whatWasTried,
      known_failures: input.knownFailures,
      current_hypothesis: input.currentHypothesis,
      confidence: input.confidence,
      suggested_next_steps: input.suggestedNextSteps,
      ...main,
    });
    const packet = this.preparePacket(base);
    this.insertPacket(packet);
    this.insertAuditReceipt(packet.audit_receipt as AuditReceipt);
    return { id: packet.packet_id, packet };
  }

  private preparePacket(packet: RelayPacket): RelayPacket {
    const redactionReport = scanPacketForRedactions(packet);
    let prepared = packetSchema.parse({
      ...packet,
      redaction_report: redactionReport,
      updated_at: new Date().toISOString(),
    });
    const budget = validateContextBudget(prepared);
    if (!budget.ok) {
      prepared = compressPacketToBudget(prepared);
      prepared = packetSchema.parse({
        ...prepared,
        redaction_report: {
          ...prepared.redaction_report,
          warnings: [
            ...prepared.redaction_report.warnings,
            ...budget.violations.map((violation) => ({
              kind: 'oversized_excerpt',
              field: 'packet',
              severity: 'warning',
              message: violation,
            })),
          ],
        },
      });
    }
    return prepared;
  }

  private authenticate(token: string, input: { allowRevoked?: boolean } = {}): MemberRecord {
    if (!token) {
      throw relayError('AUTH_REQUIRED', 'Missing Relay auth token.', 401);
    }
    const row = this.db
      .prepare('SELECT * FROM members WHERE token_hash = ?')
      .get(hashToken(token)) as MemberRow | undefined;
    if (!row) {
      throw relayError('AUTH_REQUIRED', 'Invalid Relay auth token.', 401);
    }
    const member = rowToMember(row);
    if (member.status === 'revoked' && !input.allowRevoked) {
      throw relayError('TOKEN_REVOKED', 'This member token has been revoked.', 403);
    }
    return member;
  }

  private requireMember(token: string, workspaceId: string): MemberRecord {
    const member = this.authenticate(token);
    if (member.workspace_id !== workspaceId) {
      throw relayError('FORBIDDEN', 'Token belongs to a different workspace.', 403);
    }
    return member;
  }

  private requireAdmin(token: string, workspaceId: string): MemberRecord {
    const member = this.requireMember(token, workspaceId);
    if (member.role !== 'admin') {
      throw relayError('FORBIDDEN', 'Workspace admin permission required.', 403);
    }
    return member;
  }

  private requireApprovalSecret(member: MemberRecord, approvalSecret: string | undefined): void {
    if (!approvalSecret) {
      throw relayError(
        'FORBIDDEN',
        'A local approval secret is required to mint approval tokens.',
        403,
      );
    }
    const row = this.db
      .prepare('SELECT approval_secret_hash FROM members WHERE id = ?')
      .get(member.id) as { approval_secret_hash: string } | undefined;
    if (!row?.approval_secret_hash || row.approval_secret_hash !== hashToken(approvalSecret)) {
      throw relayError('FORBIDDEN', 'Invalid local approval secret.', 403);
    }
  }

  private getWorkspace(workspaceId: string): WorkspaceRecord {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as
      | WorkspaceRow
      | undefined;
    if (!row) {
      throw relayError('NOT_FOUND', 'Workspace not found.', 404);
    }
    return rowToWorkspace(row);
  }

  private getMember(memberId: string): MemberRecord {
    const row = this.db.prepare('SELECT * FROM members WHERE id = ?').get(memberId) as
      | MemberRow
      | undefined;
    if (!row) {
      throw relayError('NOT_FOUND', 'Member not found.', 404);
    }
    return rowToMember(row);
  }

  private resolveWorkspaceMember(workspaceId: string, member: string): MemberRecord {
    const trimmed = member.trim();
    if (!trimmed) {
      throw relayError('INVALID_INPUT', 'Member handle or id is required.', 400);
    }
    if (trimmed.startsWith('mem_')) {
      return this.getMember(trimmed);
    }
    const byHandle = this.findMemberByHandle(workspaceId, trimmed, true);
    if (byHandle) return byHandle;
    try {
      return this.getMember(trimmed);
    } catch {
      throw relayError('NOT_FOUND', `Member ${trimmed} not found.`, 404);
    }
  }

  private findMemberByHandle(
    workspaceId: string,
    handle: string,
    includeRevoked = false,
  ): MemberRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM members WHERE workspace_id = ? AND handle = ?')
      .get(workspaceId, normalizeHandle(handle)) as MemberRow | undefined;
    if (!row) return undefined;
    const member = rowToMember(row);
    if (!includeRevoked && member.status === 'revoked') {
      return undefined;
    }
    return member;
  }

  private resolveRecipient(workspaceId: string, handle: string): MemberRecord {
    const normalized = normalizeHandle(handle);
    const member = this.findMemberByHandle(workspaceId, normalized, true);
    if (!member) {
      throw relayError('INVALID_RECIPIENT', `Invalid recipient @${normalized}.`, 404);
    }
    if (member.status === 'revoked') {
      throw relayError('INVALID_RECIPIENT', `Recipient @${normalized} is revoked.`, 403);
    }
    return member;
  }

  private actorRole(actor: MemberRecord, packet: RelayPacket): ActorRole {
    if (packet.sender_member_id === actor.id) return 'sender';
    if (packet.recipient_member_ids.includes(actor.id)) return 'recipient';
    if (actor.role === 'admin' && actor.workspace_id === packet.workspace_id) return 'admin';
    return 'system';
  }

  private canReadMetadata(actor: MemberRecord, packet: RelayPacket): boolean {
    return (
      actor.workspace_id === packet.workspace_id &&
      actor.status === 'active' &&
      (packet.sender_member_id === actor.id ||
        packet.recipient_member_ids.includes(actor.id) ||
        actor.role === 'admin')
    );
  }

  private canReadBody(actor: MemberRecord, packet: RelayPacket): boolean {
    if (actor.workspace_id !== packet.workspace_id || actor.status !== 'active') {
      return false;
    }
    if (packet.sender_member_id === actor.id || packet.recipient_member_ids.includes(actor.id)) {
      return true;
    }
    if (actor.role === 'admin') {
      return this.getWorkspace(packet.workspace_id).admin_body_access;
    }
    return false;
  }

  private requireReadable(actor: MemberRecord, packet: RelayPacket): void {
    if (!this.canReadBody(actor, packet)) {
      if (this.canReadMetadata(actor, packet)) {
        throw relayError(
          'FORBIDDEN',
          'Workspace admin metadata access does not include packet body access by default.',
          403,
        );
      }
      throw relayError('FORBIDDEN', 'Packet is not addressed to this member.', 403);
    }
  }

  private toSearchResult(actor: MemberRecord, packet: RelayPacket): PacketSearchResult {
    return {
      packet_id: packet.packet_id,
      packet_type: packet.packet_type,
      workspace_id: packet.workspace_id,
      sender_member_id: packet.sender_member_id,
      recipient_member_ids: packet.recipient_member_ids,
      status: packet.status,
      title: packet.title,
      summary: packet.summary,
      project: packet.project,
      source_client: packet.source_client,
      created_at: packet.created_at,
      updated_at: packet.updated_at,
      expires_at: packet.expires_at,
      recheck_by: packet.recheck_by,
      body_access: this.canReadBody(actor, packet),
    };
  }

  private auditFilterMetadata(input: PacketQueryFilters): Record<string, string> {
    return Object.fromEntries(
      Object.entries({
        project: input.project,
        sender: input.sender,
        recipient: input.recipient,
        status: input.status,
        file_or_symbol: input.fileOrSymbol,
        ticket_or_pr: input.ticketOrPr,
      }).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !!entry[1]),
    );
  }

  private adminBodyAccessFor(actor: MemberRecord, workspaceId: string): boolean {
    return actor.role === 'admin' ? this.getWorkspace(workspaceId).admin_body_access : false;
  }

  private resolveRepositoryFilters(
    workspaceId: string,
    filters: PacketQueryFilters,
  ): PacketRepositoryFilters {
    return {
      canonicalProject: filters.project
        ? this.resolveCanonicalProjectName(workspaceId, filters.project)
        : undefined,
      fileOrSymbol: filters.fileOrSymbol,
      limit: filters.limit,
      offset: filters.offset,
      recipientMemberId: this.resolveMemberFilter(workspaceId, filters.recipient),
      senderMemberId: this.resolveMemberFilter(workspaceId, filters.sender),
      status: filters.status,
      ticketOrPr: filters.ticketOrPr,
    };
  }

  private resolveMemberFilter(
    workspaceId: string,
    selector: string | undefined,
  ): string | undefined {
    const trimmed = selector?.trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith('mem_')) return trimmed;
    try {
      return this.findMemberByHandle(workspaceId, trimmed, true)?.id ?? '__relay_no_member__';
    } catch {
      return '__relay_no_member__';
    }
  }

  private resolveCanonicalProjectName(workspaceId: string, projectName: string): string {
    const name = normalizeProjectName(projectName);
    const row = this.db
      .prepare(
        `SELECT canonical_project FROM project_aliases
        WHERE workspace_id = ? AND alias = ?`,
      )
      .get(workspaceId, name) as { canonical_project: string } | undefined;
    return row?.canonical_project ?? name;
  }

  private requireSender(actor: MemberRecord, packet: RelayPacket): void {
    if (packet.sender_member_id !== actor.id) {
      throw relayError('FORBIDDEN', 'Only the packet sender can perform this action.', 403);
    }
  }

  private requireRecipient(actor: MemberRecord, packet: RelayPacket): void {
    if (!packet.recipient_member_ids.includes(actor.id)) {
      throw relayError('FORBIDDEN', 'Packet is not addressed to this member.', 403);
    }
  }

  private assertApprovalTokenAllowed(
    actor: MemberRecord,
    packet: RelayPacket,
    action: ApprovalAction,
  ): void {
    if (action === 'send') {
      this.requireSender(actor, packet);
      if (packet.packet_type === 'reply') {
        throw relayError('INVALID_INPUT', 'Use reply approval for reply packets.', 400);
      }
      if (packet.status !== 'pending_sender_approval') {
        throw relayError(
          'INVALID_STATE_TRANSITION',
          'Only pending drafts can be approved for send.',
          409,
        );
      }
      return;
    }
    if (action === 'reply') {
      this.requireSender(actor, packet);
      if (packet.packet_type !== 'reply' || packet.status !== 'pending_recipient_approval') {
        throw relayError(
          'INVALID_STATE_TRANSITION',
          'Only pending reply drafts can be approved.',
          409,
        );
      }
      return;
    }
    this.requireRecipient(actor, packet);
    if (packet.packet_type === 'reply') {
      if (packet.status !== 'viewed') {
        throw relayError(
          'INVALID_STATE_TRANSITION',
          'Replies must be viewed before hydration approval.',
          409,
        );
      }
      return;
    }
    if (packet.status !== 'accepted') {
      throw relayError(
        'INVALID_STATE_TRANSITION',
        'Packets must be accepted before hydration approval.',
        409,
      );
    }
  }

  private consumeApprovalToken(input: {
    actor: MemberRecord;
    packet: RelayPacket;
    action: ApprovalAction;
    approvalToken?: string;
  }): void {
    if (!input.approvalToken) {
      throw relayError(
        'FORBIDDEN',
        `A human approval token is required to ${input.action} this packet.`,
        403,
      );
    }
    const row = this.db
      .prepare(
        `SELECT * FROM approval_tokens
        WHERE packet_id = ? AND actor_member_id = ? AND action = ? AND token_hash = ?`,
      )
      .get(input.packet.packet_id, input.actor.id, input.action, hashToken(input.approvalToken)) as
      | {
          id: string;
          expires_at: string;
          consumed_at: string | null;
        }
      | undefined;
    if (!row || row.consumed_at || Date.parse(row.expires_at) < Date.now()) {
      throw relayError('FORBIDDEN', 'Invalid, expired, or consumed approval token.', 403);
    }
    this.assertApprovalTokenAllowed(input.actor, input.packet, input.action);
    this.db
      .prepare('UPDATE approval_tokens SET consumed_at = ? WHERE id = ?')
      .run(new Date().toISOString(), row.id);
  }

  private transitionPacket(
    packet: RelayPacket,
    status: PacketStatus,
    actor: MemberRecord,
    role: ActorRole,
  ): RelayPacket {
    assertTransition({
      from: packet.status,
      to: status,
      actorRole: role,
      packetType: packet.packet_type,
    });
    return this.updatePacket({
      ...packet,
      status,
      updated_at: new Date().toISOString(),
    });
  }

  private insertPacket(packet: RelayPacket): RelayPacket {
    return this.packets.insert(packet);
  }

  private updatePacket(packet: RelayPacket): RelayPacket {
    return this.packets.update(packet);
  }

  private listWorkspacePackets(workspaceId: string): RelayPacket[] {
    return this.packets.listWorkspacePackets(workspaceId);
  }

  private createNotification(packet: RelayPacket, memberId: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO notifications (id, packet_id, workspace_id, member_id, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        createId('ntf'),
        packet.packet_id,
        packet.workspace_id,
        memberId,
        'unread',
        new Date().toISOString(),
      );
  }

  private markNotificationRead(packetId: string, memberId: string): void {
    this.db
      .prepare(
        `UPDATE notifications
        SET status = 'read',
            read_at = COALESCE(read_at, ?)
        WHERE packet_id = ?
          AND member_id = ?
          AND status = 'unread'`,
      )
      .run(new Date().toISOString(), packetId, memberId);
  }

  private recordAudit(input: {
    action: AuditAction;
    actorMemberId: string;
    workspaceId: string;
    packetId?: string;
    metadata?: Record<string, unknown>;
  }): AuditReceipt {
    const receipt = createAuditReceipt(input);
    this.insertAuditReceipt(receipt);
    if (input.packetId) {
      const packet = this.getPacket(input.packetId);
      this.updatePacket({ ...packet, audit_receipt: receipt });
    }
    return receipt;
  }

  private insertAuditReceipt(receipt: AuditReceipt): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO audit_receipts
        (receipt_id, workspace_id, packet_id, actor_member_id, action, created_at, metadata, receipt_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.receipt_id,
        receipt.workspace_id,
        receipt.packet_id ?? null,
        receipt.actor_member_id,
        receipt.action,
        receipt.created_at,
        JSON.stringify(receipt.metadata),
        receipt.receipt_hash,
      );
  }
}
