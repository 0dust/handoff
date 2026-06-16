import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { createRelayDatabase } from '../src/storage/database.js';
import { RelayService } from '../src/service/relay-service.js';

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

describe('workspace identity and permissions', () => {
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
    const { service, workspace, alice } = await createTwoMembers();

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
    expect(
      service.listInbox({ authToken: alice.member.token, workspaceId: workspace.workspace.id }),
    ).toHaveLength(1);

    const viewed = service.viewPacket({ authToken: alice.member.token, packetId: draft.id });
    expect(viewed.packet.status).toBe('viewed');
    service.acceptPacket({ authToken: alice.member.token, packetId: draft.id });
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

    const reply = service.createReplyDraft({
      authToken: alice.member.token,
      packetId: draft.id,
      answer: 'Persist the rotated refresh token before retrying the request.',
      summary: 'Likely refresh persistence ordering issue.',
      sourceClient: 'claude-code',
    });
    expect(reply.packet.status).toBe('pending_recipient_approval');

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

    const senderInbox = service.listInbox({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
    });
    expect(senderInbox.some((packet) => packet.packet_type === 'reply')).toBe(true);

    service.viewPacket({ authToken: workspace.admin.token, packetId: reply.id });
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
  });
});
