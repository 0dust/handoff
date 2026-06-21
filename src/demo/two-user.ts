import type { RelayApiClient } from '../api/client.js';
import type { MemberRecord } from '../identity.js';
import type { RelayService } from '../service/relay-service.js';

type TwoUserDemoBackend = RelayApiClient | RelayService;
type ApprovalAction = 'hydrate' | 'reply' | 'send';

export async function runTwoUserDemo(service: TwoUserDemoBackend) {
  const workspace = await service.createWorkspace({
    name: 'Handoff Demo',
    adminHandle: 'sam',
    adminName: 'Sam Sender',
  });
  const invite = await service.inviteMember({
    adminToken: workspace.admin.token,
    workspaceId: workspace.workspace.id,
    handle: 'alice',
  });
  const alice = await service.acceptInvite({
    inviteToken: invite.invite.token,
    displayName: 'Alice Recipient',
  });
  const ask = await service.createAskDraft({
    authToken: workspace.admin.token,
    workspaceId: workspace.workspace.id,
    to: '@alice',
    question: 'Can you check why the auth refresh test keeps failing?',
    title: 'Auth refresh failing',
    summary: 'The auth refresh integration test returns 401 after token rotation.',
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
  const askSendApproval = await demoApprovalToken(service, workspace.admin, ask.id, 'send');
  await service.approveAndSend({
    authToken: workspace.admin.token,
    packetId: ask.id,
    approvalToken: askSendApproval.approval_token,
  });
  await service.viewPacket({ authToken: alice.member.token, packetId: ask.id });
  await service.acceptPacket({ authToken: alice.member.token, packetId: ask.id });
  const askHydrateApproval = await demoApprovalToken(service, alice.member, ask.id, 'hydrate');
  await service.hydratePacket({
    authToken: alice.member.token,
    packetId: ask.id,
    client: 'codex',
    approvalToken: askHydrateApproval.approval_token,
  });
  const reply = await service.createReplyDraft({
    authToken: alice.member.token,
    packetId: ask.id,
    answer: 'Persist the rotated refresh token before retrying the request.',
    summary: 'Likely refresh persistence ordering issue.',
    sourceClient: 'codex',
  });
  const replyApproval = await demoApprovalToken(service, alice.member, reply.id, 'reply');
  await service.approveReply({
    authToken: alice.member.token,
    replyPacketId: reply.id,
    approvalToken: replyApproval.approval_token,
  });
  await service.viewPacket({
    authToken: workspace.admin.token,
    packetId: reply.id,
  });
  const replyHydrateApproval = await demoApprovalToken(
    service,
    workspace.admin,
    reply.id,
    'hydrate',
  );
  await service.hydratePacket({
    authToken: workspace.admin.token,
    packetId: reply.id,
    client: 'codex',
    approvalToken: replyHydrateApproval.approval_token,
  });
  const closed = await service.closePacket({
    authToken: workspace.admin.token,
    packetId: ask.id,
    resolution: 'resolved',
  });

  const share = await service.createShareDraft({
    authToken: workspace.admin.token,
    workspaceId: workspace.workspace.id,
    to: '@alice',
    finding: 'The auth middleware retry path skips refresh persistence.',
    title: 'Auth middleware finding',
    summary: 'Patch retry persistence before the second request.',
    sourceClient: 'codex',
  });
  const shareSendApproval = await demoApprovalToken(service, workspace.admin, share.id, 'send');
  await service.approveAndSend({
    authToken: workspace.admin.token,
    packetId: share.id,
    approvalToken: shareSendApproval.approval_token,
  });
  await service.viewPacket({ authToken: alice.member.token, packetId: share.id });
  await service.acceptPacket({ authToken: alice.member.token, packetId: share.id });
  const shareHydrateApproval = await demoApprovalToken(service, alice.member, share.id, 'hydrate');
  await service.hydratePacket({
    authToken: alice.member.token,
    packetId: share.id,
    client: 'codex',
    approvalToken: shareHydrateApproval.approval_token,
  });
  const archived = await service.archivePacket({
    authToken: alice.member.token,
    packetId: share.id,
  });
  const hydratedReply = await service.getPacketForMember({
    authToken: workspace.admin.token,
    packetId: reply.id,
  });

  return {
    workspace: workspace.workspace,
    sender: demoMemberSummary(workspace.admin),
    recipient: demoMemberSummary(alice.member),
    ask: closed.packet,
    reply: hydratedReply.packet,
    share: archived.packet,
  };
}

function demoApprovalToken(
  service: TwoUserDemoBackend,
  member: MemberRecord,
  packetId: string,
  action: ApprovalAction,
) {
  if (!member.token || !member.approval_secret) {
    throw new Error(`Demo member @${member.handle} is missing local credentials.`);
  }
  return service.createApprovalToken({
    authToken: member.token,
    approvalSecret: member.approval_secret,
    packetId,
    action,
  });
}

function demoMemberSummary(member: MemberRecord) {
  return {
    id: member.id,
    workspace_id: member.workspace_id,
    handle: member.handle,
    display_name: member.display_name,
    role: member.role,
    status: member.status,
    token: '[redacted]',
    approval_secret: '[redacted]',
    credentials_redacted: true,
    created_at: member.created_at,
    revoked_at: member.revoked_at,
  };
}
