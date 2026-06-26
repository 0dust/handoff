import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { hashToken } from '../src/identity.js';
import { createRelayDatabase } from '../src/storage/database.js';
import { RelayService } from '../src/service/relay-service.js';
import { PacketTransportRepository } from '../src/storage/packet-transport-table.js';

function createService() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-relay-'));
  const db = createRelayDatabase(join(dir, 'relay.db'));
  const service = new RelayService(db);
  return { service, db };
}

async function createTwoMembers() {
  const { service, db } = createService();
  const workspace = service.createWorkspace({
    name: 'Demo Team',
    adminHandle: 'sam',
    adminName: 'Sam Sender',
  });
  const invite = service.inviteMember({
    adminToken: workspace.admin.token,
    workspaceId: workspace.workspace.id,
    handle: 'alice',
  });
  const alice = service.acceptInvite({
    inviteToken: invite.invite.token,
    displayName: 'Alice Recipient',
  });
  return { service, db, workspace, alice };
}

function approval(
  service: RelayService,
  input: {
    authToken: string;
    approvalSecret: string;
    packetId: string;
    action: 'hydrate' | 'reply' | 'send';
  },
) {
  return service.createApprovalToken(input).approval_token;
}

function approvalTokenConsumed(db: ReturnType<typeof createRelayDatabase>, token: string): boolean {
  const row = db
    .prepare('SELECT consumed_at FROM approval_tokens WHERE token_hash = ?')
    .get(hashToken(token)) as { consumed_at: string | null } | undefined;
  if (!row) {
    throw new Error('Expected approval token row.');
  }
  return row.consumed_at !== null;
}

function insertCorruptTransportRow(
  db: ReturnType<typeof createRelayDatabase>,
  input: { packetId: string; workspaceId: string; suffix: string },
): void {
  db.prepare(
    `INSERT INTO packet_transports
    (id, packet_id, workspace_id, protocol, task_id, artifact_id, trust_receipt_artifact_id,
     packet_hash, task_state, direction, trust_receipt, created_at, updated_at)
    VALUES (?, ?, ?, 'a2a-internal', ?, ?, ?, ?, 'TASK_STATE_WORKING', 'outbound', '{}', ?, ?)`,
  ).run(
    `ptr_corrupt_${input.suffix}`,
    input.packetId,
    input.workspaceId,
    `tsk_${input.packetId}`,
    `art_${input.packetId}_relay_packet`,
    `art_${input.packetId}_trust_receipt`,
    `sha256:${'c'.repeat(64)}`,
    new Date().toISOString(),
    new Date().toISOString(),
  );
}

describe('workspace identity and permissions', () => {
  test('creates the packet_transports schema and indexes for adapter metadata', () => {
    const { db } = createService();

    const columns = db.prepare('PRAGMA table_info(packet_transports)').all() as Array<{
      name: string;
    }>;
    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master
        WHERE type = 'index'
          AND tbl_name = 'packet_transports'`,
      )
      .all() as Array<{ name: string }>;

    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'packet_id',
        'workspace_id',
        'protocol',
        'task_id',
        'artifact_id',
        'trust_receipt_artifact_id',
        'packet_hash',
        'task_state',
        'direction',
        'remote_endpoint',
        'trust_receipt',
        'last_error',
        'created_at',
        'updated_at',
      ]),
    );
    expect(indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(['packet_transports_workspace_idx', 'packet_transports_task_idx']),
    );
  });

  test('creates a workspace, invites a member, accepts invite, lists members, and rotates tokens', () => {
    const { service } = createService();
    const workspace = service.createWorkspace({
      name: 'Relay Team',
      adminHandle: 'sam',
      adminName: 'Sam',
    });
    const invite = service.inviteMember({
      adminToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      handle: 'alice',
    });
    const accepted = service.acceptInvite({
      inviteToken: invite.invite.token,
      displayName: 'Alice',
    });
    const members = service.listMembers({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
    });
    const rotated = service.rotateMemberToken({ authToken: accepted.member.token });

    expect(members.map((member) => member.handle).sort()).toEqual(['alice', 'sam']);
    expect(rotated.token).not.toBe(accepted.member.token);
  });

  test('reuses an active pending invite when invite is rerun for the same handle', () => {
    const { service, db } = createService();
    const workspace = service.createWorkspace({
      name: 'Relay Team',
      adminHandle: 'sam',
      adminName: 'Sam',
    });
    const first = service.inviteMember({
      adminToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      handle: 'Alice',
    });
    const rerun = service.inviteMember({
      adminToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      handle: '@alice',
    });

    expect(rerun.invite.id).toBe(first.invite.id);
    expect(rerun.invite.token).toBe(first.invite.token);

    db.prepare('UPDATE invites SET expires_at = ? WHERE id = ?').run(
      new Date(Date.now() - 60_000).toISOString(),
      first.invite.id,
    );
    const afterExpiry = service.inviteMember({
      adminToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      handle: 'alice',
    });

    expect(afterExpiry.invite.id).not.toBe(first.invite.id);
    expect(afterExpiry.invite.token).not.toBe(first.invite.token);
  });

  test('accept invite can be retried with the same idempotency key', () => {
    const { service, db } = createService();
    const workspace = service.createWorkspace({
      name: 'Relay Team',
      adminHandle: 'sam',
      adminName: 'Sam',
    });
    const invite = service.inviteMember({
      adminToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      handle: 'alice',
    });

    const first = service.acceptInvite({
      displayName: 'Alice',
      idempotencyKey: 'join-attempt-1',
      inviteToken: invite.invite.token,
    });
    const retry = service.acceptInvite({
      displayName: 'Alice',
      idempotencyKey: 'join-attempt-1',
      inviteToken: invite.invite.token,
    });

    expect(retry.member.id).toBe(first.member.id);
    expect(retry.member.token).not.toBe(first.member.token);
    expect(() =>
      service.acceptInvite({
        displayName: 'Alice',
        idempotencyKey: 'different-attempt',
        inviteToken: invite.invite.token,
      }),
    ).toThrow(/already been accepted/i);
    expect(
      service.listMembers({
        authToken: retry.member.token,
        workspaceId: workspace.workspace.id,
      }),
    ).toHaveLength(2);

    db.prepare('UPDATE invites SET accepted_at = ? WHERE id = ?').run(
      new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      invite.invite.id,
    );
    expect(() =>
      service.acceptInvite({
        displayName: 'Alice',
        idempotencyKey: 'join-attempt-1',
        inviteToken: invite.invite.token,
      }),
    ).toThrow(/already been accepted/i);
  });

  test('allows members and recipients with handles that begin with digits', () => {
    const { service } = createService();
    const workspace = service.createWorkspace({
      name: 'Relay Team',
      adminHandle: '0dust',
      adminName: '0dust',
    });
    const invite = service.inviteMember({
      adminToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      handle: '1alice',
    });
    const accepted = service.acceptInvite({
      inviteToken: invite.invite.token,
      displayName: 'Alice',
    });
    const draft = service.createAskDraft({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      to: '@1alice',
      question: 'Can you review this?',
      title: 'Digit handle check',
      summary: 'Regression check for handles that start with a digit.',
      sourceClient: 'codex',
    });

    expect(workspace.admin.handle).toBe('0dust');
    expect(accepted.member.handle).toBe('1alice');
    expect(draft.packet.recipient_member_ids).toEqual([accepted.member.id]);
  });

  test('revoked members cannot authenticate, receive future packets, or access history', async () => {
    const { service, workspace, alice } = await createTwoMembers();

    service.revokeMember({
      adminToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      memberId: alice.member.id,
    });

    expect(() =>
      service.createAskDraft({
        authToken: workspace.admin.token,
        workspaceId: workspace.workspace.id,
        to: '@alice',
        question: 'Can you still see this?',
        title: 'Revocation check',
        summary: 'Should fail',
        sourceClient: 'codex',
      }),
    ).toThrow(/recipient.*revoked|invalid recipient/i);
    expect(() =>
      service.listInbox({
        authToken: alice.member.token,
        workspaceId: workspace.workspace.id,
      }),
    ).toThrow(/revoked/i);
  });

  test('members can leave a workspace and rerun leave without changing the revoked record', async () => {
    const { service, db, workspace, alice } = await createTwoMembers();
    const draft = service.createAskDraft({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      to: '@alice',
      question: 'Can you inspect auth refresh?',
      title: 'Auth refresh',
      summary: 'Refresh returns 401.',
      sourceClient: 'codex',
    });
    service.approveAndSend({
      authToken: workspace.admin.token,
      packetId: draft.id,
      approvalToken: approval(service, {
        authToken: workspace.admin.token,
        approvalSecret: workspace.admin.approval_secret,
        packetId: draft.id,
        action: 'send',
      }),
    });
    service.viewPacket({ authToken: alice.member.token, packetId: draft.id });
    service.acceptPacket({ authToken: alice.member.token, packetId: draft.id });
    service.createApprovalToken({
      authToken: alice.member.token,
      approvalSecret: alice.member.approval_secret,
      packetId: draft.id,
      action: 'hydrate',
    });

    const first = service.leaveWorkspace({
      authToken: alice.member.token,
      workspaceId: workspace.workspace.id,
    });
    const second = service.leaveWorkspace({
      authToken: alice.member.token,
      workspaceId: workspace.workspace.id,
    });

    expect(first.alreadyRemoved).toBe(false);
    expect(second.alreadyRemoved).toBe(true);
    expect(second.member.status).toBe('revoked');
    expect(second.member.revoked_at).toBe(first.member.revoked_at);
    expect(() =>
      service.listInbox({ authToken: alice.member.token, workspaceId: workspace.workspace.id }),
    ).toThrow(/revoked/i);
    expect(
      db
        .prepare(
          'SELECT COUNT(*) AS count FROM approval_tokens WHERE actor_member_id = ? AND consumed_at IS NULL',
        )
        .get(alice.member.id),
    ).toEqual({ count: 0 });
  });

  test('admins remove members by handle idempotently without revoking themselves', async () => {
    const { service, workspace, alice } = await createTwoMembers();

    const first = service.removeMember({
      adminToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      member: '@alice',
    });
    const second = service.removeMember({
      adminToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      member: alice.member.id,
    });

    expect(first.member.id).toBe(alice.member.id);
    expect(first.alreadyRemoved).toBe(false);
    expect(second.alreadyRemoved).toBe(true);
    expect(second.member.revoked_at).toBe(first.member.revoked_at);
    expect(() =>
      service.removeMember({
        adminToken: workspace.admin.token,
        workspaceId: workspace.workspace.id,
        member: workspace.admin.id,
      }),
    ).toThrow(/cannot remove themselves/i);
  });

  test('recipients cannot read packets not addressed to them and search respects permissions', async () => {
    const { service, workspace, alice } = await createTwoMembers();
    const bobInvite = service.inviteMember({
      adminToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      handle: 'bob',
    });
    const bob = service.acceptInvite({ inviteToken: bobInvite.invite.token, displayName: 'Bob' });

    const draft = service.createAskDraft({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      to: '@alice',
      question: 'Can you inspect auth refresh?',
      title: 'Auth refresh',
      summary: 'Refresh test fails',
      sourceClient: 'codex',
    });
    const sent = service.approveAndSend({
      authToken: workspace.admin.token,
      packetId: draft.id,
      approvalToken: approval(service, {
        authToken: workspace.admin.token,
        approvalSecret: workspace.admin.approval_secret,
        packetId: draft.id,
        action: 'send',
      }),
    });

    expect(() => service.viewPacket({ authToken: bob.member.token, packetId: sent.id })).toThrow(
      /not addressed|permission/i,
    );
    expect(
      service.searchPackets({
        authToken: bob.member.token,
        workspaceId: workspace.workspace.id,
        query: 'auth',
      }),
    ).toEqual([]);
    expect(
      service.searchPackets({
        authToken: alice.member.token,
        workspaceId: workspace.workspace.id,
        query: 'auth',
      }),
    ).toHaveLength(1);
  });
});

describe('two-user ask/share flows', () => {
  test('completes ask approve notify hydrate reply approve hydrate close with audit receipts', async () => {
    const { service, db, workspace, alice } = await createTwoMembers();

    const draft = service.createAskDraft({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      to: '@alice',
      question: 'Can you check why the auth refresh test keeps failing?',
      title: 'Auth refresh failing',
      summary: 'The auth refresh integration test returns 401.',
      sourceClient: 'codex',
      evidence: [
        {
          kind: 'test_failure',
          label: 'test output',
          source: 'pnpm test auth-refresh',
          excerpt: 'expected 200 received 401',
        },
      ],
    });
    expect(draft.packet.status).toBe('pending_sender_approval');

    const sent = service.approveAndSend({
      authToken: workspace.admin.token,
      packetId: draft.id,
      approvalToken: approval(service, {
        authToken: workspace.admin.token,
        approvalSecret: workspace.admin.approval_secret,
        packetId: draft.id,
        action: 'send',
      }),
    });
    expect(sent.packet.status).toBe('delivered');
    const sentTransport = service.getPacketTransport({
      authToken: workspace.admin.token,
      packetId: draft.id,
    });
    expect(sentTransport).toMatchObject({
      packet_id: draft.id,
      protocol: 'a2a-internal',
      task_id: `tsk_${draft.id}`,
      task_state: 'TASK_STATE_WORKING',
      direction: 'outbound',
    });
    expect(sentTransport?.trust_receipt.sender_approved_at).toBeTruthy();
    expect(sentTransport?.trust_receipt.hydrated_at).toBeNull();
    if (!sentTransport) {
      throw new Error('Expected packet transport after approved send.');
    }
    const changedPacketHash = `sha256:${'a'.repeat(64)}`;
    expect(() =>
      new PacketTransportRepository(db).upsert({
        existing: sentTransport,
        packet_id: sentTransport.packet_id,
        workspace_id: sentTransport.workspace_id,
        protocol: sentTransport.protocol,
        task_id: sentTransport.task_id,
        artifact_id: sentTransport.artifact_id,
        trust_receipt_artifact_id: sentTransport.trust_receipt_artifact_id,
        packet_hash: changedPacketHash,
        task_state: sentTransport.task_state,
        direction: sentTransport.direction,
        trust_receipt: { ...sentTransport.trust_receipt, packet_hash: changedPacketHash },
      }),
    ).toThrow(/immutable/i);
    expect(() =>
      new PacketTransportRepository(db).upsert({
        packet_id: sentTransport.packet_id,
        workspace_id: sentTransport.workspace_id,
        protocol: sentTransport.protocol,
        task_id: sentTransport.task_id,
        artifact_id: sentTransport.artifact_id,
        trust_receipt_artifact_id: sentTransport.trust_receipt_artifact_id,
        packet_hash: changedPacketHash,
        task_state: sentTransport.task_state,
        direction: sentTransport.direction,
        trust_receipt: { ...sentTransport.trust_receipt, packet_hash: changedPacketHash },
      }),
    ).toThrow(/immutable/i);
    expect(() =>
      new PacketTransportRepository(db).upsert({
        existing: sentTransport,
        packet_id: sentTransport.packet_id,
        workspace_id: sentTransport.workspace_id,
        protocol: sentTransport.protocol,
        task_id: sentTransport.task_id,
        artifact_id: sentTransport.artifact_id,
        trust_receipt_artifact_id: sentTransport.trust_receipt_artifact_id,
        packet_hash: sentTransport.packet_hash,
        task_state: sentTransport.task_state,
        direction: sentTransport.direction,
        remote_endpoint: 'https://user:pass@example.com/a2a',
        trust_receipt: sentTransport.trust_receipt,
      }),
    ).toThrow(/credentials/i);
    expect(() =>
      new PacketTransportRepository(db).upsert({
        existing: sentTransport,
        packet_id: sentTransport.packet_id,
        workspace_id: sentTransport.workspace_id,
        protocol: sentTransport.protocol,
        task_id: sentTransport.task_id,
        artifact_id: sentTransport.artifact_id,
        trust_receipt_artifact_id: sentTransport.trust_receipt_artifact_id,
        packet_hash: sentTransport.packet_hash,
        task_state: sentTransport.task_state,
        direction: sentTransport.direction,
        remote_endpoint: 'https://example.com/a2a?token=secret',
        trust_receipt: sentTransport.trust_receipt,
      }),
    ).toThrow(/credential/i);
    const approvedPacketHash = sentTransport?.packet_hash;
    expect(
      service.listInbox({ authToken: alice.member.token, workspaceId: workspace.workspace.id }),
    ).toHaveLength(1);

    const viewed = service.viewPacket({ authToken: alice.member.token, packetId: draft.id });
    expect(viewed.packet.status).toBe('viewed');
    const viewedTransport = service.getPacketTransport({
      authToken: alice.member.token,
      packetId: draft.id,
    });
    expect(viewedTransport?.packet_hash).toBe(approvedPacketHash);
    expect(viewedTransport?.task_state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(viewedTransport?.trust_receipt.packet_status).toBe('viewed');

    service.acceptPacket({ authToken: alice.member.token, packetId: draft.id });
    const acceptedTransport = service.getPacketTransport({
      authToken: alice.member.token,
      packetId: draft.id,
    });
    expect(acceptedTransport?.packet_hash).toBe(approvedPacketHash);
    expect(acceptedTransport?.task_state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(acceptedTransport?.trust_receipt.packet_status).toBe('accepted');

    const hydrated = service.hydratePacket({
      authToken: alice.member.token,
      packetId: draft.id,
      client: 'claude-code',
      sessionId: 'alice-session',
      approvalToken: approval(service, {
        authToken: alice.member.token,
        approvalSecret: alice.member.approval_secret,
        packetId: draft.id,
        action: 'hydrate',
      }),
    });
    expect(hydrated.context).toContain('Can you check why');
    const hydratedTransport = service.getPacketTransport({
      authToken: alice.member.token,
      packetId: draft.id,
    });
    expect(hydratedTransport?.id).toBe(sentTransport?.id);
    expect(hydratedTransport?.packet_hash).toBe(approvedPacketHash);
    expect(hydratedTransport?.task_state).toBe('TASK_STATE_COMPLETED');
    expect(hydratedTransport?.trust_receipt.hydrated_at).toBeTruthy();

    const reply = service.createReplyDraft({
      authToken: alice.member.token,
      packetId: draft.id,
      answer: 'Persist the rotated refresh token before retrying the request.',
      summary: 'Likely refresh persistence ordering issue.',
      sourceClient: 'claude-code',
    });
    expect(reply.packet.status).toBe('pending_recipient_approval');
    const replyDraftingTransport = service.getPacketTransport({
      authToken: alice.member.token,
      packetId: draft.id,
    });
    expect(replyDraftingTransport?.packet_hash).toBe(approvedPacketHash);
    expect(replyDraftingTransport?.task_state).toBe('TASK_STATE_WORKING');
    expect(replyDraftingTransport?.trust_receipt.packet_status).toBe('response_drafting');

    const approvedReply = service.approveReply({
      authToken: alice.member.token,
      replyPacketId: reply.id,
      approvalToken: approval(service, {
        authToken: alice.member.token,
        approvalSecret: alice.member.approval_secret,
        packetId: reply.id,
        action: 'reply',
      }),
    });
    expect(approvedReply.packet.status).toBe('replied');
    const replyTransport = service.getPacketTransport({
      authToken: alice.member.token,
      packetId: reply.id,
    });
    expect(replyTransport).toMatchObject({
      packet_id: reply.id,
      protocol: 'a2a-internal',
      task_state: 'TASK_STATE_WORKING',
    });
    expect(replyTransport?.trust_receipt.replied_at).toBeTruthy();

    const senderInbox = service.listInbox({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
    });
    expect(senderInbox.some((packet) => packet.packet_type === 'reply')).toBe(true);

    service.viewPacket({ authToken: workspace.admin.token, packetId: reply.id });
    const viewedReplyTransport = service.getPacketTransport({
      authToken: workspace.admin.token,
      packetId: reply.id,
    });
    expect(viewedReplyTransport?.task_state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(viewedReplyTransport?.trust_receipt.packet_status).toBe('viewed');

    const hydratedReply = service.hydratePacket({
      authToken: workspace.admin.token,
      packetId: reply.id,
      client: 'codex',
      sessionId: 'sam-session',
      approvalToken: approval(service, {
        authToken: workspace.admin.token,
        approvalSecret: workspace.admin.approval_secret,
        packetId: reply.id,
        action: 'hydrate',
      }),
    });
    expect(hydratedReply.context).toContain('Persist the rotated refresh token');

    const closed = service.closePacket({
      authToken: workspace.admin.token,
      packetId: draft.id,
      resolution: 'resolved',
    });
    expect(closed.packet.status).toBe('closed_resolved');
    const closedTransport = service.getPacketTransport({
      authToken: workspace.admin.token,
      packetId: draft.id,
    });
    expect(closedTransport?.id).toBe(sentTransport?.id);
    expect(closedTransport?.packet_hash).toBe(approvedPacketHash);
    expect(closedTransport?.task_state).toBe('TASK_STATE_COMPLETED');
    expect(closedTransport?.trust_receipt.terminal_at).toBeTruthy();

    const transportRows = db
      .prepare('SELECT COUNT(*) AS count FROM packet_transports WHERE packet_id = ?')
      .get(draft.id) as { count: number };
    expect(transportRows.count).toBe(1);

    const audit = service.listAuditReceipts({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      packetId: draft.id,
    });
    expect(audit.map((receipt) => receipt.action)).toEqual(
      expect.arrayContaining([
        'draft',
        'approve',
        'send',
        'deliver',
        'view',
        'accept',
        'hydrate',
        'reply',
        'close',
      ]),
    );
  });

  test('blocks sending a draft with secret-looking evidence unless explicitly overridden', async () => {
    const { service, workspace } = await createTwoMembers();
    const draft = service.createAskDraft({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      to: '@alice',
      question: 'Can you inspect this env failure?',
      title: 'Env failure',
      summary: 'Potential secret should block send.',
      sourceClient: 'codex',
      evidence: [
        {
          kind: 'log_excerpt',
          label: 'env',
          source: '.env',
          excerpt: 'API_KEY=sk-proj-secretsecretsecretsecret',
        },
      ],
    });

    expect(draft.packet.redaction_report.blocked).toBe(true);
    expect(() =>
      service.approveAndSend({
        authToken: workspace.admin.token,
        packetId: draft.id,
        approvalToken: approval(service, {
          authToken: workspace.admin.token,
          approvalSecret: workspace.admin.approval_secret,
          packetId: draft.id,
          action: 'send',
        }),
      }),
    ).toThrow(/redaction/i);
    expect(
      service.getPacketTransport({ authToken: workspace.admin.token, packetId: draft.id }),
    ).toBeUndefined();
  });

  test('adapter mirror failures roll back packet lifecycle mutations', async () => {
    const { service, db, workspace, alice } = await createTwoMembers();
    const draft = service.createShareDraft({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      to: '@alice',
      finding: 'The transport mirror should stay atomic with packet state.',
      title: 'Atomic transport mirror',
      summary: 'A corrupt existing mirror row should block and roll back lifecycle movement.',
      sourceClient: 'codex',
    });
    service.approveAndSend({
      authToken: workspace.admin.token,
      packetId: draft.id,
      approvalToken: approval(service, {
        authToken: workspace.admin.token,
        approvalSecret: workspace.admin.approval_secret,
        packetId: draft.id,
        action: 'send',
      }),
    });
    db.prepare('UPDATE packet_transports SET trust_receipt = ? WHERE packet_id = ?').run(
      '{}',
      draft.id,
    );

    expect(() => service.viewPacket({ authToken: alice.member.token, packetId: draft.id })).toThrow(
      /expected/i,
    );
    expect(
      service.getPacketForMember({ authToken: workspace.admin.token, packetId: draft.id }).packet
        .status,
    ).toBe('delivered');
  });

  test('adapter mirror failures do not consume approval tokens', async () => {
    {
      const { service, db, workspace } = await createTwoMembers();
      const draft = service.createShareDraft({
        authToken: workspace.admin.token,
        workspaceId: workspace.workspace.id,
        to: '@alice',
        finding: 'Send should roll back approval token consumption.',
        title: 'Atomic send token',
        summary: 'A corrupt mirror row should not consume send approval.',
        sourceClient: 'codex',
      });
      insertCorruptTransportRow(db, {
        packetId: draft.id,
        workspaceId: workspace.workspace.id,
        suffix: 'send',
      });
      const sendApproval = approval(service, {
        authToken: workspace.admin.token,
        approvalSecret: workspace.admin.approval_secret,
        packetId: draft.id,
        action: 'send',
      });

      expect(() =>
        service.approveAndSend({
          authToken: workspace.admin.token,
          packetId: draft.id,
          approvalToken: sendApproval,
        }),
      ).toThrow();
      expect(
        service.getPacketForMember({ authToken: workspace.admin.token, packetId: draft.id }).packet
          .status,
      ).toBe('pending_sender_approval');
      expect(approvalTokenConsumed(db, sendApproval)).toBe(false);
    }

    {
      const { service, db, workspace, alice } = await createTwoMembers();
      const draft = service.createShareDraft({
        authToken: workspace.admin.token,
        workspaceId: workspace.workspace.id,
        to: '@alice',
        finding: 'Hydrate should roll back approval token consumption.',
        title: 'Atomic hydrate token',
        summary: 'A corrupt mirror row should not consume hydrate approval.',
        sourceClient: 'codex',
      });
      service.approveAndSend({
        authToken: workspace.admin.token,
        packetId: draft.id,
        approvalToken: approval(service, {
          authToken: workspace.admin.token,
          approvalSecret: workspace.admin.approval_secret,
          packetId: draft.id,
          action: 'send',
        }),
      });
      service.viewPacket({ authToken: alice.member.token, packetId: draft.id });
      service.acceptPacket({ authToken: alice.member.token, packetId: draft.id });
      db.prepare('UPDATE packet_transports SET trust_receipt = ? WHERE packet_id = ?').run(
        '{}',
        draft.id,
      );
      const hydrateApproval = approval(service, {
        authToken: alice.member.token,
        approvalSecret: alice.member.approval_secret,
        packetId: draft.id,
        action: 'hydrate',
      });

      expect(() =>
        service.hydratePacket({
          authToken: alice.member.token,
          packetId: draft.id,
          client: 'codex',
          approvalToken: hydrateApproval,
        }),
      ).toThrow();
      expect(
        service.getPacketForMember({ authToken: workspace.admin.token, packetId: draft.id }).packet
          .status,
      ).toBe('accepted');
      expect(approvalTokenConsumed(db, hydrateApproval)).toBe(false);
    }

    {
      const { service, db, workspace, alice } = await createTwoMembers();
      const draft = service.createAskDraft({
        authToken: workspace.admin.token,
        workspaceId: workspace.workspace.id,
        to: '@alice',
        question: 'Can you check reply approval rollback?',
        title: 'Atomic reply token',
        summary: 'A corrupt mirror row should not consume reply approval.',
        sourceClient: 'codex',
      });
      service.approveAndSend({
        authToken: workspace.admin.token,
        packetId: draft.id,
        approvalToken: approval(service, {
          authToken: workspace.admin.token,
          approvalSecret: workspace.admin.approval_secret,
          packetId: draft.id,
          action: 'send',
        }),
      });
      service.viewPacket({ authToken: alice.member.token, packetId: draft.id });
      service.acceptPacket({ authToken: alice.member.token, packetId: draft.id });
      const reply = service.createReplyDraft({
        authToken: alice.member.token,
        packetId: draft.id,
        answer: 'The retry path should persist the token first.',
        summary: 'Reply approval rollback coverage.',
        sourceClient: 'codex',
      });
      insertCorruptTransportRow(db, {
        packetId: reply.id,
        workspaceId: workspace.workspace.id,
        suffix: 'reply',
      });
      const replyApproval = approval(service, {
        authToken: alice.member.token,
        approvalSecret: alice.member.approval_secret,
        packetId: reply.id,
        action: 'reply',
      });

      expect(() =>
        service.approveReply({
          authToken: alice.member.token,
          replyPacketId: reply.id,
          approvalToken: replyApproval,
        }),
      ).toThrow();
      expect(
        service.getPacketForMember({ authToken: workspace.admin.token, packetId: draft.id }).packet
          .status,
      ).toBe('response_drafting');
      expect(
        service.getPacketForMember({ authToken: alice.member.token, packetId: reply.id }).packet
          .status,
      ).toBe('pending_recipient_approval');
      expect(approvalTokenConsumed(db, replyApproval)).toBe(false);
    }
  });

  test('completes share approve inbox hydrate archive', async () => {
    const { service, workspace, alice } = await createTwoMembers();
    const draft = service.createShareDraft({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      to: '@alice',
      finding: 'The auth middleware retry path skips refresh persistence.',
      title: 'Auth middleware finding',
      summary: 'Patch retry persistence before the second request.',
      sourceClient: 'codex',
    });

    service.approveAndSend({
      authToken: workspace.admin.token,
      packetId: draft.id,
      approvalToken: approval(service, {
        authToken: workspace.admin.token,
        approvalSecret: workspace.admin.approval_secret,
        packetId: draft.id,
        action: 'send',
      }),
    });
    service.viewPacket({ authToken: alice.member.token, packetId: draft.id });
    service.acceptPacket({ authToken: alice.member.token, packetId: draft.id });
    const hydrated = service.hydratePacket({
      authToken: alice.member.token,
      packetId: draft.id,
      client: 'codex',
      approvalToken: approval(service, {
        authToken: alice.member.token,
        approvalSecret: alice.member.approval_secret,
        packetId: draft.id,
        action: 'hydrate',
      }),
    });
    const archived = service.archivePacket({ authToken: alice.member.token, packetId: draft.id });

    expect(hydrated.context).toContain('auth middleware');
    expect(archived.packet.status).toBe('archived');
    expect(
      service.getPacketTransport({ authToken: alice.member.token, packetId: draft.id })
        ?.trust_receipt.terminal_at,
    ).toBeTruthy();
    expect(
      service.listNotifications({
        authToken: alice.member.token,
        workspaceId: workspace.workspace.id,
      }),
    ).toEqual([]);
  });

  test('lists and acknowledges durable notifications without duplicate rows', async () => {
    const { service, workspace, alice } = await createTwoMembers();
    const draft = service.createShareDraft({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      to: '@alice',
      finding: 'The auth middleware retry path skips refresh persistence.',
      title: 'Auth middleware finding',
      summary: 'Patch retry persistence before the second request.',
      sourceClient: 'codex',
    });

    service.approveAndSend({
      authToken: workspace.admin.token,
      packetId: draft.id,
      approvalToken: approval(service, {
        authToken: workspace.admin.token,
        approvalSecret: workspace.admin.approval_secret,
        packetId: draft.id,
        action: 'send',
      }),
    });
    const notifications = service.listNotifications({
      authToken: alice.member.token,
      workspaceId: workspace.workspace.id,
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      packet_id: draft.id,
      sender_handle: 'sam',
      title: 'Auth middleware finding',
    });

    const acked = service.ackNotification({
      authToken: alice.member.token,
      notificationId: notifications[0].notification_id,
    });
    const ackedAgain = service.ackNotification({
      authToken: alice.member.token,
      notificationId: notifications[0].notification_id,
    });

    expect(acked.notification.status).toBe('read');
    expect(ackedAgain.notification.read_at).toBe(acked.notification.read_at);
    expect(
      service.listNotifications({
        authToken: alice.member.token,
        workspaceId: workspace.workspace.id,
      }),
    ).toEqual([]);
  });

  test('supports clarification and decline without hydration', async () => {
    const { service, workspace, alice } = await createTwoMembers();
    const draft = service.createAskDraft({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      to: '@alice',
      question: 'Can you help?',
      title: 'Needs details',
      summary: 'This is intentionally incomplete.',
      sourceClient: 'codex',
    });
    service.approveAndSend({
      authToken: workspace.admin.token,
      packetId: draft.id,
      approvalToken: approval(service, {
        authToken: workspace.admin.token,
        approvalSecret: workspace.admin.approval_secret,
        packetId: draft.id,
        action: 'send',
      }),
    });
    service.viewPacket({ authToken: alice.member.token, packetId: draft.id });

    const clarification = service.requestClarification({
      authToken: alice.member.token,
      packetId: draft.id,
      question: 'Can you include the failing assertion?',
      requestedEvidence: ['test failure'],
    });
    const declined = service.declinePacket({
      authToken: alice.member.token,
      packetId: draft.id,
      reason: 'Not enough context yet.',
    });

    expect(clarification.packet.packet_type).toBe('clarification');
    expect(declined.packet.status).toBe('declined');
    expect(
      service.getPacketTransport({ authToken: workspace.admin.token, packetId: draft.id })
        ?.task_state,
    ).toBe('TASK_STATE_REJECTED');
    expect(
      service.getPacketTransport({
        authToken: workspace.admin.token,
        packetId: clarification.id,
      }),
    ).toBeUndefined();
  });

  test('archiving a draft before send does not create adapter transport metadata', async () => {
    const { service, workspace } = await createTwoMembers();
    const draft = service.createShareDraft({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      to: '@alice',
      finding: 'This local note should not leave yet.',
      title: 'Draft archive',
      summary: 'A draft that is archived before approval.',
      sourceClient: 'codex',
    });

    const archived = service.archivePacket({
      authToken: workspace.admin.token,
      packetId: draft.id,
    });

    expect(archived.packet.status).toBe('archived');
    expect(
      service.getPacketTransport({ authToken: workspace.admin.token, packetId: draft.id }),
    ).toBeUndefined();
  });
});
