import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { buildApiServer } from '../src/api/server.js';
import { RelayApiClient } from '../src/api/client.js';
import { runCli } from '../src/cli.js';
import { getMcpToolDefinitions } from '../src/mcp/server.js';
import { RelayService } from '../src/service/relay-service.js';
import { createRelayDatabase } from '../src/storage/database.js';
import { packetSchema } from '../src/protocol/schema.js';
import normalAsk from '../fixtures/normal-ask.json' with { type: 'json' };
import { scanPacketForRedactions } from '../src/redaction.js';

const openApps: Array<{ close: () => Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

function createService() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-relay-review-'));
  const db = createRelayDatabase(join(dir, 'relay.db'));
  const service = new RelayService(db);
  return { service, db };
}

async function startServer(service: RelayService) {
  const app = buildApiServer({ service });
  await app.listen({ host: '127.0.0.1', port: 0 });
  openApps.push(app);
  const address = app.server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP server address');
  }
  return `http://127.0.0.1:${address.port}`;
}

async function runCliWithApproval(argv: string[]) {
  const previous = process.env.AGENT_RELAY_ASSUME_HUMAN_APPROVAL;
  process.env.AGENT_RELAY_ASSUME_HUMAN_APPROVAL = '1';
  try {
    return await runCli(argv);
  } finally {
    if (previous === undefined) {
      delete process.env.AGENT_RELAY_ASSUME_HUMAN_APPROVAL;
    } else {
      process.env.AGENT_RELAY_ASSUME_HUMAN_APPROVAL = previous;
    }
  }
}

async function setupTwoMembers(service: RelayService) {
  const workspace = service.createWorkspace({
    name: 'Review Team',
    adminHandle: 'sam',
    adminName: 'Sam Admin',
  });
  const aliceInvite = service.inviteMember({
    adminToken: workspace.admin.token,
    workspaceId: workspace.workspace.id,
    handle: 'alice',
  });
  const bobInvite = service.inviteMember({
    adminToken: workspace.admin.token,
    workspaceId: workspace.workspace.id,
    handle: 'bob',
  });
  const alice = service.acceptInvite({
    inviteToken: aliceInvite.invite.token,
    displayName: 'Alice',
  });
  const bob = service.acceptInvite({
    inviteToken: bobInvite.invite.token,
    displayName: 'Bob',
  });
  return { workspace, alice, bob };
}

describe('API-backed public clients', () => {
  test('two separate CLI clients coordinate through one Fastify server', async () => {
    const { service } = createService();
    const serverUrl = await startServer(service);

    const created = await runCli([
      'workspace',
      'create',
      '--server-url',
      serverUrl,
      '--name',
      'CLI Hub',
      '--handle',
      'sam',
      '--display-name',
      'Sam',
      '--json',
    ]);
    const workspace = JSON.parse(created.stdout);
    const invited = await runCli([
      'member',
      'invite',
      '--server-url',
      serverUrl,
      '--token',
      workspace.admin.token,
      '--workspace',
      workspace.workspace.id,
      '--handle',
      'alice',
      '--json',
    ]);
    const invite = JSON.parse(invited.stdout);
    const accepted = await runCli([
      'member',
      'accept',
      '--server-url',
      serverUrl,
      '--invite',
      invite.invite.token,
      '--display-name',
      'Alice',
      '--json',
    ]);
    const alice = JSON.parse(accepted.stdout);
    const ask = await runCli([
      'ask',
      '@alice',
      'Can you inspect auth refresh?',
      '--server-url',
      serverUrl,
      '--token',
      workspace.admin.token,
      '--workspace',
      workspace.workspace.id,
      '--title',
      'Auth refresh',
      '--summary',
      'The integration test returns 401.',
      '--evidence-json',
      '[{"kind":"test_failure","label":"test output","source":"pnpm test auth-refresh","excerpt":"expected 200 received 401"}]',
      '--json',
    ]);
    const draft = JSON.parse(ask.stdout);
    const approval = await runCliWithApproval([
      'approval-token',
      draft.id,
      '--server-url',
      serverUrl,
      '--token',
      workspace.admin.token,
      '--approval-secret',
      workspace.admin.approval_secret,
      '--action',
      'send',
      '--json',
    ]);
    const approvalToken = JSON.parse(approval.stdout).approval_token;

    await runCli([
      'approve',
      draft.id,
      '--server-url',
      serverUrl,
      '--token',
      workspace.admin.token,
      '--approval-token',
      approvalToken,
      '--json',
    ]);
    const inbox = await runCli([
      'inbox',
      '--server-url',
      serverUrl,
      '--token',
      alice.member.token,
      '--workspace',
      workspace.workspace.id,
      '--json',
    ]);

    expect(JSON.parse(inbox.stdout)).toHaveLength(1);
    expect(
      service.searchPackets({
        authToken: workspace.admin.token,
        workspaceId: workspace.workspace.id,
      }),
    ).toHaveLength(1);
  });

  test('MCP tools can be backed by the coordination API instead of a local database', async () => {
    const { service } = createService();
    const { workspace } = await setupTwoMembers(service);
    const serverUrl = await startServer(service);
    const apiClient = new RelayApiClient({ serverUrl });
    const tools = getMcpToolDefinitions(apiClient);

    const askTool = tools.find((tool) => tool.name === 'relay_ask');
    const result = await askTool?.handler({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      to: '@alice',
      question: 'Can you check auth refresh?',
      title: 'Auth refresh',
      summary: 'Refresh returns 401.',
      sourceClient: 'codex',
      evidence: [
        {
          kind: 'test_failure',
          label: 'test output',
          source: 'pnpm test auth-refresh',
          excerpt: 'expected 200 received 401',
        },
      ],
      filesOrSymbols: ['src/auth/refresh.ts'],
      commandsOrTestsRun: ['pnpm test auth-refresh'],
      whatWasTried: ['Checked token expiry math'],
      knownFailures: ['401 on retry'],
      currentHypothesis: 'Refresh persistence ordering issue.',
    });

    expect(result).toMatchObject({ status: 'pending_sender_approval' });
    expect(service.getPacket(result.id).evidence).toHaveLength(1);
  });
});

describe('approval and privacy contracts', () => {
  test('redaction scans claims and required string arrays before approval', async () => {
    const packet = packetSchema.parse({
      ...normalAsk,
      claims: [
        {
          claim_id: 'clm_secret',
          text: 'The repro used API_KEY=sk-proj-secretsecretsecretsecret',
          confidence: 'high',
          status: 'observed',
          evidence_ids: [],
          needs_recheck: false,
        },
      ],
      files_or_symbols: ['/Users/alice/project-api/.env'],
      commands_or_tests_run: ['curl https://user:pass@example.com/private'],
      what_was_tried: ['Exported TOKEN=sk-proj-secretsecretsecretsecret'],
      known_failures: ['Private key: -----BEGIN PRIVATE KEY-----'],
      suggested_next_steps: ['Remove password=supersecret before sharing'],
    });

    const report = scanPacketForRedactions(packet);

    expect(report.blocked).toBe(true);
    expect(report.findings.map((finding) => finding.field)).toEqual(
      expect.arrayContaining([
        'claims.0.text',
        'commands_or_tests_run.0',
        'what_was_tried.0',
        'known_failures.0',
        'suggested_next_steps.0',
      ]),
    );
    expect(report.warnings.some((warning) => warning.field === 'files_or_symbols.0')).toBe(true);
  });

  test('metadata-only admins cannot search private body or title and summary text', async () => {
    const { service } = createService();
    const { workspace, alice, bob } = await setupTwoMembers(service);
    const draft = service.createAskDraft({
      authToken: alice.member.token,
      workspaceId: workspace.workspace.id,
      to: '@bob',
      question: 'needle-private-refresh-token',
      title: 'needle-private-title',
      summary: 'needle-private-summary should not be used as a search oracle.',
      sourceClient: 'codex',
      evidence: [
        {
          kind: 'human_note',
          label: 'needle-private-evidence-label',
          source: 'needle-private-source',
          excerpt: 'needle-private-evidence-body',
        },
      ],
      filesOrSymbols: ['needle-private-file.ts'],
    });
    const sendApproval = service.createApprovalToken({
      authToken: alice.member.token,
      approvalSecret: alice.member.approval_secret,
      packetId: draft.id,
      action: 'send',
    });
    service.approveAndSend({
      authToken: alice.member.token,
      packetId: draft.id,
      approvalToken: sendApproval.approval_token,
    });

    expect(
      service.searchPackets({
        authToken: workspace.admin.token,
        workspaceId: workspace.workspace.id,
        query: 'needle-private-refresh-token',
      }),
    ).toEqual([]);
    expect(
      service.searchPackets({
        authToken: workspace.admin.token,
        workspaceId: workspace.workspace.id,
        query: 'needle-private-title',
      }),
    ).toEqual([]);
    expect(
      service.searchPackets({
        authToken: workspace.admin.token,
        workspaceId: workspace.workspace.id,
        query: 'needle-private-summary',
      }),
    ).toEqual([]);
    expect(
      service.searchPackets({
        authToken: workspace.admin.token,
        workspaceId: workspace.workspace.id,
        query: 'needle-private-evidence-label',
      }),
    ).toEqual([]);

    const adminMetadata = service.listHistory({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
    });
    expect(adminMetadata).toHaveLength(1);
    expect(adminMetadata[0]).toMatchObject({
      packet_id: draft.id,
      body_access: false,
      title: '[redacted]',
      summary: '[redacted]',
    });

    expect(
      service.searchPackets({
        authToken: bob.member.token,
        workspaceId: workspace.workspace.id,
        query: 'needle-private-refresh-token',
      }),
    ).toHaveLength(1);
    expect(
      service.searchPackets({
        authToken: bob.member.token,
        workspaceId: workspace.workspace.id,
        query: 'needle-private-title',
      })[0],
    ).toMatchObject({
      packet_id: draft.id,
      body_access: true,
      title: 'needle-private-title',
      summary: 'needle-private-summary should not be used as a search oracle.',
    });
  });

  test('approval-token API rejects static local-renderer header spoofing', async () => {
    const { service } = createService();
    const { workspace } = await setupTwoMembers(service);
    const serverUrl = await startServer(service);
    const draft = service.createAskDraft({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      to: '@alice',
      question: 'Can you inspect auth refresh?',
      title: 'Auth refresh',
      summary: 'Refresh returns 401.',
      sourceClient: 'codex',
    });
    const app = openApps[openApps.length - 1] as any;
    const response = await app.inject({
      method: 'POST',
      url: `/packets/${draft.id}/approval-token`,
      headers: {
        authorization: `Bearer ${workspace.admin.token}`,
        'x-agent-relay-local-approval': 'confirmed-by-local-renderer',
      },
      payload: { action: 'send' },
    });
    const client = new RelayApiClient({ serverUrl });

    await expect(
      client.createApprovalToken({
        authToken: workspace.admin.token,
        packetId: draft.id,
        action: 'send',
      }),
    ).rejects.toThrow(/approval secret/i);
    expect(response.statusCode).toBe(403);
  });

  test('server-backed approval token minting requires the separate approval secret', async () => {
    const { service } = createService();
    const serverUrl = await startServer(service);
    const created = await runCli([
      'workspace',
      'create',
      '--server-url',
      serverUrl,
      '--name',
      'Approval Secret Team',
      '--handle',
      'sam',
      '--display-name',
      'Sam',
      '--json',
    ]);
    const workspace = JSON.parse(created.stdout);
    const ask = await runCli([
      'ask',
      '@sam',
      'Can you inspect auth refresh?',
      '--server-url',
      serverUrl,
      '--token',
      workspace.admin.token,
      '--workspace',
      workspace.workspace.id,
      '--title',
      'Auth refresh',
      '--summary',
      'Refresh returns 401.',
      '--json',
    ]);
    const draft = JSON.parse(ask.stdout);

    await expect(
      new RelayApiClient({ serverUrl }).createApprovalToken({
        authToken: workspace.admin.token,
        packetId: draft.id,
        action: 'send',
      }),
    ).rejects.toThrow(/approval secret/i);

    const approval = await runCliWithApproval([
      'approval-token',
      draft.id,
      '--server-url',
      serverUrl,
      '--token',
      workspace.admin.token,
      '--approval-secret',
      workspace.admin.approval_secret,
      '--action',
      'send',
      '--json',
    ]);
    expect(JSON.parse(approval.stdout).approval_token).toMatch(/^relay_approval_/);
  });

  test('send, reply approval, and hydration require a human approval token', async () => {
    const { service } = createService();
    const { workspace, alice } = await setupTwoMembers(service);
    const draft = service.createAskDraft({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      to: '@alice',
      question: 'Can you inspect auth refresh?',
      title: 'Auth refresh',
      summary: 'Refresh returns 401.',
      sourceClient: 'codex',
    });

    expect(() =>
      service.approveAndSend({ authToken: workspace.admin.token, packetId: draft.id }),
    ).toThrow(/approval token/i);
    const sendApproval = service.createApprovalToken({
      authToken: workspace.admin.token,
      approvalSecret: workspace.admin.approval_secret,
      packetId: draft.id,
      action: 'send',
    });
    service.approveAndSend({
      authToken: workspace.admin.token,
      packetId: draft.id,
      approvalToken: sendApproval.approval_token,
    });
    expect(() =>
      service.approveAndSend({
        authToken: workspace.admin.token,
        packetId: draft.id,
        approvalToken: sendApproval.approval_token,
      }),
    ).toThrow(/approval token/i);

    service.viewPacket({ authToken: alice.member.token, packetId: draft.id });
    service.acceptPacket({ authToken: alice.member.token, packetId: draft.id });
    expect(() =>
      service.hydratePacket({ authToken: alice.member.token, packetId: draft.id, client: 'codex' }),
    ).toThrow(/approval token/i);
    const hydrateApproval = service.createApprovalToken({
      authToken: alice.member.token,
      approvalSecret: alice.member.approval_secret,
      packetId: draft.id,
      action: 'hydrate',
    });
    service.hydratePacket({
      authToken: alice.member.token,
      packetId: draft.id,
      client: 'codex',
      approvalToken: hydrateApproval.approval_token,
    });

    const reply = service.createReplyDraft({
      authToken: alice.member.token,
      packetId: draft.id,
      answer: 'Persist refresh before retrying.',
      summary: 'Persistence order issue.',
      sourceClient: 'codex',
    });
    expect(() =>
      service.approveReply({ authToken: alice.member.token, replyPacketId: reply.id }),
    ).toThrow(/approval token/i);
    const replyApproval = service.createApprovalToken({
      authToken: alice.member.token,
      approvalSecret: alice.member.approval_secret,
      packetId: reply.id,
      action: 'reply',
    });
    expect(
      service.approveReply({
        authToken: alice.member.token,
        replyPacketId: reply.id,
        approvalToken: replyApproval.approval_token,
      }).packet.status,
    ).toBe('replied');
  });

  test('workspace admins see audit metadata by default, not raw packet bodies', async () => {
    const { service } = createService();
    const { workspace, alice, bob } = await setupTwoMembers(service);
    const draft = service.createAskDraft({
      authToken: alice.member.token,
      workspaceId: workspace.workspace.id,
      to: '@bob',
      question: 'Sensitive question body',
      title: 'Sensitive auth question',
      summary: 'Contains private debugging context.',
      sourceClient: 'codex',
      evidence: [
        {
          kind: 'human_note',
          label: 'private note',
          source: 'alice',
          excerpt: 'private packet body',
        },
      ],
    });
    const sendApproval = service.createApprovalToken({
      authToken: alice.member.token,
      approvalSecret: alice.member.approval_secret,
      packetId: draft.id,
      action: 'send',
    });
    service.approveAndSend({
      authToken: alice.member.token,
      packetId: draft.id,
      approvalToken: sendApproval.approval_token,
    });
    service.viewPacket({ authToken: bob.member.token, packetId: draft.id });
    service.requestClarification({
      authToken: bob.member.token,
      packetId: draft.id,
      question: 'secret clarification body text',
      requestedEvidence: ['secret provenance label'],
    });
    service.searchPackets({
      authToken: bob.member.token,
      workspaceId: workspace.workspace.id,
      query: 'private packet body',
    });

    expect(() =>
      service.getPacketForMember({ authToken: workspace.admin.token, packetId: draft.id }),
    ).toThrow(/body access/i);
    expect(
      service.listAuditReceipts({
        authToken: workspace.admin.token,
        workspaceId: workspace.workspace.id,
        packetId: draft.id,
      }).length,
    ).toBeGreaterThan(0);
    const audit = service.listAuditReceipts({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
    });
    const serializedAudit = JSON.stringify(audit);
    expect(serializedAudit).not.toContain('secret clarification body text');
    expect(serializedAudit).not.toContain('secret provenance label');
    expect(serializedAudit).not.toContain('private packet body');
    expect(audit.find((receipt) => receipt.action === 'clarify')?.metadata).toMatchObject({
      question_present: true,
      question_length: 'secret clarification body text'.length,
      requested_evidence_count: 1,
    });
    expect(audit.find((receipt) => receipt.action === 'search')?.metadata).toMatchObject({
      query_present: true,
      query_length: 'private packet body'.length,
    });

    const search = service.listHistory({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
    });
    const originalSearchResult = search.find((packet) => packet.packet_id === draft.id);
    expect(originalSearchResult).toBeDefined();
    expect(originalSearchResult).not.toHaveProperty('evidence');
    expect(originalSearchResult).toMatchObject({
      packet_id: draft.id,
      title: '[redacted]',
      summary: '[redacted]',
      body_access: false,
    });

    expect(
      service.getPacketForMember({ authToken: bob.member.token, packetId: draft.id }).packet
        .evidence,
    ).toHaveLength(1);
  });
});

describe('evidence-rich public packet drafting and reply state', () => {
  test('MCP ask schema exposes evidence-backed packet fields', () => {
    const { service } = createService();
    const tools = getMcpToolDefinitions(service);
    const askTool = tools.find((tool) => tool.name === 'relay_ask');

    expect(Object.keys(askTool?.inputSchema ?? {})).toEqual(
      expect.arrayContaining([
        'claims',
        'evidence',
        'filesOrSymbols',
        'commandsOrTestsRun',
        'whatWasTried',
        'knownFailures',
        'currentHypothesis',
        'suggestedNextSteps',
      ]),
    );
  });

  test('CLI ask accepts structured evidence fields without manual summary-only handoffs', async () => {
    const { service } = createService();
    const { workspace } = await setupTwoMembers(service);
    const serverUrl = await startServer(service);

    const ask = await runCli([
      'ask',
      '@alice',
      'Can you inspect auth refresh?',
      '--server-url',
      serverUrl,
      '--token',
      workspace.admin.token,
      '--workspace',
      workspace.workspace.id,
      '--title',
      'Auth refresh',
      '--summary',
      'Refresh returns 401.',
      '--evidence-json',
      '[{"kind":"test_failure","label":"test output","source":"pnpm test auth-refresh","excerpt":"expected 200 received 401"}]',
      '--files',
      'src/auth/refresh.ts,refreshSession',
      '--tests',
      'pnpm test auth-refresh',
      '--tried',
      'Checked token expiry math',
      '--failures',
      '401 on retry',
      '--hypothesis',
      'Refresh persistence ordering issue.',
      '--next-steps',
      'Compare with Alice branch',
      '--json',
    ]);
    const draft = JSON.parse(ask.stdout);
    const packet = service.getPacket(draft.id);

    expect(packet.evidence).toHaveLength(1);
    expect(packet.files_or_symbols).toEqual(['src/auth/refresh.ts', 'refreshSession']);
    expect(packet.commands_or_tests_run).toEqual(['pnpm test auth-refresh']);
    expect(packet.what_was_tried).toEqual(['Checked token expiry math']);
    expect(packet.known_failures).toEqual(['401 on retry']);
    expect(packet.current_hypothesis).toBe('Refresh persistence ordering issue.');
  });

  test('accepted-but-not-hydrated asks can enter response drafting before reply approval', async () => {
    const { service } = createService();
    const { workspace, alice } = await setupTwoMembers(service);
    const draft = service.createAskDraft({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      to: '@alice',
      question: 'Can you inspect auth refresh?',
      title: 'Auth refresh',
      summary: 'Refresh returns 401.',
      sourceClient: 'codex',
    });
    const sendApproval = service.createApprovalToken({
      authToken: workspace.admin.token,
      approvalSecret: workspace.admin.approval_secret,
      packetId: draft.id,
      action: 'send',
    });
    service.approveAndSend({
      authToken: workspace.admin.token,
      packetId: draft.id,
      approvalToken: sendApproval.approval_token,
    });
    service.viewPacket({ authToken: alice.member.token, packetId: draft.id });
    service.acceptPacket({ authToken: alice.member.token, packetId: draft.id });

    const reply = service.createReplyDraft({
      authToken: alice.member.token,
      packetId: draft.id,
      answer: 'Persist refresh before retrying.',
      summary: 'Persistence order issue.',
      sourceClient: 'codex',
    });
    const parent = service.getPacket(draft.id);
    const replyApproval = service.createApprovalToken({
      authToken: alice.member.token,
      approvalSecret: alice.member.approval_secret,
      packetId: reply.id,
      action: 'reply',
    });

    expect(parent.status).toBe('response_drafting');
    expect(
      service.approveReply({
        authToken: alice.member.token,
        replyPacketId: reply.id,
        approvalToken: replyApproval.approval_token,
      }).packet.status,
    ).toBe('replied');
  });
});

describe('adapter parity and notifications', () => {
  test('audit receipts are available through API client, CLI, and MCP', async () => {
    const { service } = createService();
    const { workspace, alice } = await setupTwoMembers(service);
    const serverUrl = await startServer(service);
    const apiClient = new RelayApiClient({ serverUrl });
    const draft = service.createAskDraft({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      to: '@alice',
      question: 'Can you inspect auth refresh?',
      title: 'Auth refresh',
      summary: 'Refresh returns 401.',
      sourceClient: 'codex',
    });
    const sendApproval = service.createApprovalToken({
      authToken: workspace.admin.token,
      approvalSecret: workspace.admin.approval_secret,
      packetId: draft.id,
      action: 'send',
    });
    service.approveAndSend({
      authToken: workspace.admin.token,
      packetId: draft.id,
      approvalToken: sendApproval.approval_token,
    });

    const apiAudit = await apiClient.listAuditReceipts({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      packetId: draft.id,
    });
    expect(apiAudit.map((receipt: any) => receipt.action)).toEqual(
      expect.arrayContaining(['draft', 'send']),
    );

    const cliAudit = await runCli([
      'audit',
      '--server-url',
      serverUrl,
      '--token',
      workspace.admin.token,
      '--workspace',
      workspace.workspace.id,
      '--packet',
      draft.id,
      '--json',
    ]);
    expect(JSON.parse(cliAudit.stdout).some((receipt: any) => receipt.action === 'send')).toBe(
      true,
    );

    const auditTool = getMcpToolDefinitions(apiClient).find((tool) => tool.name === 'relay_audit');
    const mcpAudit = await auditTool?.handler({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      packetId: draft.id,
    });
    expect(mcpAudit.some((receipt: any) => receipt.action === 'draft')).toBe(true);

    await expect(
      apiClient.listAuditReceipts({
        authToken: alice.member.token,
        workspaceId: workspace.workspace.id,
      }),
    ).rejects.toThrow(/admins/i);
  });

  test('draft update is available through API client, CLI, and MCP before send', async () => {
    const { service } = createService();
    const { workspace } = await setupTwoMembers(service);
    const serverUrl = await startServer(service);
    const apiClient = new RelayApiClient({ serverUrl });

    const apiDraft = service.createAskDraft({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      to: '@alice',
      question: 'Old question?',
      title: 'Old title',
      summary: 'Old summary.',
      sourceClient: 'codex',
    });
    const apiUpdated = await apiClient.updateDraft({
      authToken: workspace.admin.token,
      packetId: apiDraft.id,
      title: 'API title',
      summary: 'API summary.',
      question: 'API question?',
      filesOrSymbols: ['src/auth/refresh.ts'],
    });
    expect(apiUpdated.packet).toMatchObject({
      title: 'API title',
      summary: 'API summary.',
      question: 'API question?',
      status: 'pending_sender_approval',
    });
    expect(apiUpdated.packet.files_or_symbols).toEqual(['src/auth/refresh.ts']);

    const cliDraft = service.createAskDraft({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      to: '@alice',
      question: 'Old CLI question?',
      title: 'Old CLI title',
      summary: 'Old CLI summary.',
      sourceClient: 'codex',
    });
    const cliUpdated = await runCli([
      'update-draft',
      cliDraft.id,
      '--server-url',
      serverUrl,
      '--token',
      workspace.admin.token,
      '--title',
      'CLI title',
      '--summary',
      'CLI summary.',
      '--question',
      'CLI question?',
      '--json',
    ]);
    expect(JSON.parse(cliUpdated.stdout).packet.title).toBe('CLI title');

    const mcpDraft = service.createAskDraft({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      to: '@alice',
      question: 'Old MCP question?',
      title: 'Old MCP title',
      summary: 'Old MCP summary.',
      sourceClient: 'codex',
    });
    const updateTool = getMcpToolDefinitions(apiClient).find(
      (tool) => tool.name === 'relay_update_draft',
    );
    const mcpUpdated = await updateTool?.handler({
      authToken: workspace.admin.token,
      packetId: mcpDraft.id,
      title: 'MCP title',
      summary: 'MCP summary.',
      question: 'MCP question?',
    });
    expect(mcpUpdated.packet.title).toBe('MCP title');
  });

  test('project aliases are configurable through API client, CLI, and MCP and normalize drafts', async () => {
    const { service } = createService();
    const { workspace } = await setupTwoMembers(service);
    const serverUrl = await startServer(service);
    const apiClient = new RelayApiClient({ serverUrl });

    const apiAlias = await apiClient.configureProjectAlias({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      canonicalProject: 'agent-relay',
      alias: 'relay-local',
    });
    expect(apiAlias.alias).toMatchObject({
      canonical_project: 'agent-relay',
      alias: 'relay-local',
    });

    const draft = service.createAskDraft({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      to: '@alice',
      question: 'Can you inspect alias normalization?',
      title: 'Alias normalization',
      summary: 'Repo clone name should normalize to the canonical project.',
      sourceClient: 'codex',
      project: { repo_name: 'relay-local' },
    });
    expect(draft.packet.project.repo_name).toBe('agent-relay');

    const cliAlias = await runCli([
      'workspace',
      'alias',
      'set',
      '--server-url',
      serverUrl,
      '--token',
      workspace.admin.token,
      '--workspace',
      workspace.workspace.id,
      '--canonical',
      'agent-relay',
      '--alias',
      'relay-cli',
      '--json',
    ]);
    expect(JSON.parse(cliAlias.stdout).alias.alias).toBe('relay-cli');

    const mcpTool = getMcpToolDefinitions(apiClient).find(
      (tool) => tool.name === 'relay_configure_project_alias',
    );
    const mcpAlias = await mcpTool?.handler({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      canonicalProject: 'agent-relay',
      alias: 'relay-mcp',
    });
    expect(mcpAlias.alias.alias).toBe('relay-mcp');

    const listed = await apiClient.listProjectAliases({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
    });
    expect(listed.map((alias: any) => alias.alias)).toEqual(
      expect.arrayContaining(['relay-local', 'relay-cli', 'relay-mcp']),
    );
  });

  test('history filters expose drafts, open, sent, and closed packets through public clients', async () => {
    const { service } = createService();
    const { workspace, alice } = await setupTwoMembers(service);
    const serverUrl = await startServer(service);
    const apiClient = new RelayApiClient({ serverUrl });
    const draft = service.createAskDraft({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      to: '@alice',
      question: 'Can you inspect auth refresh?',
      title: 'Auth refresh draft',
      summary: 'Draft summary.',
      sourceClient: 'codex',
    });
    const sentDraft = service.createAskDraft({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      to: '@alice',
      question: 'Can you inspect auth retry?',
      title: 'Auth retry open',
      summary: 'Open summary.',
      sourceClient: 'codex',
    });
    const sendApproval = service.createApprovalToken({
      authToken: workspace.admin.token,
      approvalSecret: workspace.admin.approval_secret,
      packetId: sentDraft.id,
      action: 'send',
    });
    service.approveAndSend({
      authToken: workspace.admin.token,
      packetId: sentDraft.id,
      approvalToken: sendApproval.approval_token,
    });
    service.viewPacket({ authToken: alice.member.token, packetId: sentDraft.id });
    service.acceptPacket({ authToken: alice.member.token, packetId: sentDraft.id });
    const hydrateApproval = service.createApprovalToken({
      authToken: alice.member.token,
      approvalSecret: alice.member.approval_secret,
      packetId: sentDraft.id,
      action: 'hydrate',
    });
    service.hydratePacket({
      authToken: alice.member.token,
      packetId: sentDraft.id,
      client: 'codex',
      approvalToken: hydrateApproval.approval_token,
    });
    service.closePacket({
      authToken: workspace.admin.token,
      packetId: sentDraft.id,
      resolution: 'resolved',
    });

    const drafts = await apiClient.listHistory({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      filter: 'drafts',
    });
    expect(drafts.map((packet: any) => packet.packet_id)).toContain(draft.id);

    const sent = await apiClient.listHistory({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      filter: 'sent',
    });
    expect(sent.map((packet: any) => packet.packet_id)).toContain(sentDraft.id);

    const closed = await runCli([
      'history',
      '--server-url',
      serverUrl,
      '--token',
      workspace.admin.token,
      '--workspace',
      workspace.workspace.id,
      '--filter',
      'closed',
      '--json',
    ]);
    expect(JSON.parse(closed.stdout).map((packet: any) => packet.packet_id)).toContain(
      sentDraft.id,
    );

    const historyTool = getMcpToolDefinitions(apiClient).find(
      (tool) => tool.name === 'relay_history',
    );
    const open = await historyTool?.handler({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      filter: 'open',
    });
    expect(open.map((packet: any) => packet.packet_id)).not.toContain(sentDraft.id);
  });

  test('history and search expose PRD typed filters through public clients', async () => {
    const { service } = createService();
    const { workspace, alice } = await setupTwoMembers(service);
    const serverUrl = await startServer(service);
    const apiClient = new RelayApiClient({ serverUrl });
    await apiClient.configureProjectAlias({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      canonicalProject: 'agent-relay',
      alias: 'relay-local',
    });
    const target = service.createAskDraft({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      to: '@alice',
      question: 'Can you inspect the auth refresh ticket?',
      title: 'Typed filter target',
      summary: 'Target packet for typed history filters.',
      sourceClient: 'codex',
      project: { repo_name: 'relay-local' },
      filesOrSymbols: ['src/auth/refresh.ts', 'refreshSession'],
      evidence: [
        {
          kind: 'ticket_link',
          label: 'Linear REL-7',
          source: 'https://linear.app/team/issue/REL-7/auth-refresh',
          excerpt: 'Ticket REL-7 tracks auth refresh failures.',
        },
      ],
    });
    const sendApproval = service.createApprovalToken({
      authToken: workspace.admin.token,
      approvalSecret: workspace.admin.approval_secret,
      packetId: target.id,
      action: 'send',
    });
    service.approveAndSend({
      authToken: workspace.admin.token,
      packetId: target.id,
      approvalToken: sendApproval.approval_token,
    });
    const decoy = service.createAskDraft({
      authToken: alice.member.token,
      workspaceId: workspace.workspace.id,
      to: '@bob',
      question: 'Can you inspect billing?',
      title: 'Typed filter decoy',
      summary: 'Decoy packet for typed filters.',
      sourceClient: 'codex',
      project: { repo_name: 'billing-service' },
      filesOrSymbols: ['src/billing/invoice.ts'],
      evidence: [
        {
          kind: 'pr_link',
          label: 'Billing PR',
          source: 'https://github.com/acme/billing/pull/99',
        },
      ],
    });

    const projectHistory = await apiClient.listHistory({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      project: 'relay-local',
    });
    expect(projectHistory.map((packet: any) => packet.packet_id)).toContain(target.id);
    expect(projectHistory.map((packet: any) => packet.packet_id)).not.toContain(decoy.id);

    const senderHistory = await apiClient.listHistory({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      sender: '@sam',
    });
    expect(senderHistory.map((packet: any) => packet.packet_id)).toContain(target.id);
    expect(senderHistory.map((packet: any) => packet.packet_id)).not.toContain(decoy.id);

    const recipientStatusHistory = await runCli([
      'history',
      '--server-url',
      serverUrl,
      '--token',
      workspace.admin.token,
      '--workspace',
      workspace.workspace.id,
      '--recipient',
      '@alice',
      '--status',
      'delivered',
      '--json',
    ]);
    const recipientStatusIds = JSON.parse(recipientStatusHistory.stdout).map(
      (packet: any) => packet.packet_id,
    );
    expect(recipientStatusIds).toContain(target.id);
    expect(recipientStatusIds).not.toContain(decoy.id);

    const historyTool = getMcpToolDefinitions(apiClient).find(
      (tool) => tool.name === 'relay_history',
    );
    const fileHistory = await historyTool?.handler({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      fileOrSymbol: 'auth/refresh.ts',
    });
    expect(fileHistory.map((packet: any) => packet.packet_id)).toEqual([target.id]);

    const ticketSearch = await apiClient.searchPackets({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      ticketOrPr: 'REL-7',
    });
    expect(ticketSearch.map((packet: any) => packet.packet_id)).toEqual([target.id]);
  });

  test('clarification is available through API client, CLI, and MCP', async () => {
    const { service } = createService();
    const { workspace, alice } = await setupTwoMembers(service);
    const serverUrl = await startServer(service);
    const apiClient = new RelayApiClient({ serverUrl });
    const draft = service.createAskDraft({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      to: '@alice',
      question: 'Can you inspect auth refresh?',
      title: 'Auth refresh',
      summary: 'Refresh returns 401.',
      sourceClient: 'codex',
    });
    const sendApproval = service.createApprovalToken({
      authToken: workspace.admin.token,
      approvalSecret: workspace.admin.approval_secret,
      packetId: draft.id,
      action: 'send',
    });
    service.approveAndSend({
      authToken: workspace.admin.token,
      packetId: draft.id,
      approvalToken: sendApproval.approval_token,
    });
    service.viewPacket({ authToken: alice.member.token, packetId: draft.id });

    const apiClarification = await apiClient.requestClarification({
      authToken: alice.member.token,
      packetId: draft.id,
      question: 'Can you include the failing assertion?',
      requestedEvidence: ['test failure'],
    });
    expect(apiClarification.packet.packet_type).toBe('clarification');
    const apiAnswered = await apiClient.answerClarification({
      authToken: workspace.admin.token,
      packetId: apiClarification.id,
      answer: 'The failing assertion is expected 200 received 401.',
      evidence: [
        {
          kind: 'test_failure',
          label: 'Updated test output',
          source: 'pnpm test auth-refresh',
          excerpt: 'expected 200 received 401',
        },
      ],
    });
    expect(apiAnswered.id).toBe(draft.id);
    expect(apiAnswered.packet.status).toBe('pending_sender_approval');
    expect(apiAnswered.packet.summary).toBe('The failing assertion is expected 200 received 401.');

    const secondDraft = service.createAskDraft({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      to: '@alice',
      question: 'Can you inspect auth retry?',
      title: 'Auth retry',
      summary: 'Retry returns 401.',
      sourceClient: 'codex',
    });
    const secondApproval = service.createApprovalToken({
      authToken: workspace.admin.token,
      approvalSecret: workspace.admin.approval_secret,
      packetId: secondDraft.id,
      action: 'send',
    });
    service.approveAndSend({
      authToken: workspace.admin.token,
      packetId: secondDraft.id,
      approvalToken: secondApproval.approval_token,
    });
    service.viewPacket({ authToken: alice.member.token, packetId: secondDraft.id });
    const cliClarification = await runCli([
      'clarify',
      secondDraft.id,
      '--server-url',
      serverUrl,
      '--token',
      alice.member.token,
      '--question',
      'Can you include the token payload?',
      '--requested-evidence',
      'token payload,test failure',
      '--json',
    ]);
    const parsedCliClarification = JSON.parse(cliClarification.stdout);
    expect(parsedCliClarification.packet.packet_type).toBe('clarification');
    const cliAnswer = await runCli([
      'answer-clarification',
      parsedCliClarification.id,
      'The token payload includes exp and sub.',
      '--server-url',
      serverUrl,
      '--token',
      workspace.admin.token,
      '--tests',
      'pnpm test auth-retry',
      '--json',
    ]);
    const parsedCliAnswer = JSON.parse(cliAnswer.stdout);
    expect(parsedCliAnswer.id).toBe(secondDraft.id);
    expect(parsedCliAnswer.packet.status).toBe('pending_sender_approval');
    expect(parsedCliAnswer.packet.commands_or_tests_run).toEqual(['pnpm test auth-retry']);

    const thirdDraft = service.createAskDraft({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      to: '@alice',
      question: 'Can you inspect auth middleware?',
      title: 'Auth middleware',
      summary: 'Middleware returns 401.',
      sourceClient: 'codex',
    });
    const thirdApproval = service.createApprovalToken({
      authToken: workspace.admin.token,
      approvalSecret: workspace.admin.approval_secret,
      packetId: thirdDraft.id,
      action: 'send',
    });
    service.approveAndSend({
      authToken: workspace.admin.token,
      packetId: thirdDraft.id,
      approvalToken: thirdApproval.approval_token,
    });
    service.viewPacket({ authToken: alice.member.token, packetId: thirdDraft.id });
    const clarifyTool = getMcpToolDefinitions(apiClient).find(
      (tool) => tool.name === 'relay_clarify',
    );
    const mcpClarification = await clarifyTool?.handler({
      authToken: alice.member.token,
      packetId: thirdDraft.id,
      question: 'Can you include middleware logs?',
      requestedEvidence: ['middleware log'],
    });
    expect(mcpClarification.packet.packet_type).toBe('clarification');
    const answerClarificationTool = getMcpToolDefinitions(apiClient).find(
      (tool) => tool.name === 'relay_answer_clarification',
    );
    const mcpAnswer = await answerClarificationTool?.handler({
      authToken: workspace.admin.token,
      packetId: mcpClarification.id,
      answer: 'Middleware logs show the auth guard rejects before refresh.',
      suggestedNextSteps: ['Recheck guard ordering'],
    });
    expect(mcpAnswer.id).toBe(thirdDraft.id);
    expect(mcpAnswer.packet.status).toBe('pending_sender_approval');
    expect(mcpAnswer.packet.suggested_next_steps).toEqual(['Recheck guard ordering']);
    expect(mcpAnswer.next_actions).toContain(
      'If approved, call relay_send_approved with this packetId.',
    );
  });

  test('server-backed API client and CLI can rotate member tokens', async () => {
    const { service } = createService();
    const { workspace, alice } = await setupTwoMembers(service);
    const serverUrl = await startServer(service);
    const apiClient = new RelayApiClient({ serverUrl });

    const apiRotated = await apiClient.rotateMemberToken({ authToken: alice.member.token });
    expect(apiRotated.token).not.toBe(alice.member.token);

    const cliRotated = await runCli([
      'member',
      'rotate-token',
      '--server-url',
      serverUrl,
      '--token',
      apiRotated.token,
      '--json',
    ]);
    expect(JSON.parse(cliRotated.stdout).token).not.toBe(apiRotated.token);
    expect(
      service.listMembers({
        authToken: workspace.admin.token,
        workspaceId: workspace.workspace.id,
      }),
    ).toHaveLength(3);
  });

  test('approval secrets rotate independently through API client and CLI with audit receipts', async () => {
    const { service } = createService();
    const { workspace } = await setupTwoMembers(service);
    const serverUrl = await startServer(service);
    const apiClient = new RelayApiClient({ serverUrl });
    const firstDraft = service.createAskDraft({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      to: '@alice',
      question: 'Can you inspect auth refresh?',
      title: 'Auth refresh',
      summary: 'Refresh returns 401.',
      sourceClient: 'codex',
    });

    const apiRotated = await apiClient.rotateApprovalSecret({
      authToken: workspace.admin.token,
      approvalSecret: workspace.admin.approval_secret,
    });
    expect(apiRotated.approval_secret).toMatch(/^relay_approval_secret_/);
    expect(apiRotated.approval_secret).not.toBe(workspace.admin.approval_secret);

    await expect(
      apiClient.createApprovalToken({
        authToken: workspace.admin.token,
        approvalSecret: workspace.admin.approval_secret,
        packetId: firstDraft.id,
        action: 'send',
      }),
    ).rejects.toThrow(/approval secret/i);
    await expect(
      apiClient.createApprovalToken({
        authToken: workspace.admin.token,
        approvalSecret: apiRotated.approval_secret,
        packetId: firstDraft.id,
        action: 'send',
      }),
    ).resolves.toMatchObject({ action: 'send' });

    const cliRotated = await runCli([
      'member',
      'rotate-approval-secret',
      '--server-url',
      serverUrl,
      '--token',
      workspace.admin.token,
      '--approval-secret',
      apiRotated.approval_secret,
      '--json',
    ]);
    const cliPayload = JSON.parse(cliRotated.stdout);
    expect(cliPayload.approval_secret).toMatch(/^relay_approval_secret_/);
    expect(cliPayload.approval_secret).not.toBe(apiRotated.approval_secret);

    const secondDraft = service.createAskDraft({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      to: '@alice',
      question: 'Can you inspect auth retry?',
      title: 'Auth retry',
      summary: 'Retry returns 401.',
      sourceClient: 'codex',
    });
    await expect(
      apiClient.createApprovalToken({
        authToken: workspace.admin.token,
        approvalSecret: apiRotated.approval_secret,
        packetId: secondDraft.id,
        action: 'send',
      }),
    ).rejects.toThrow(/approval secret/i);
    await expect(
      apiClient.createApprovalToken({
        authToken: workspace.admin.token,
        approvalSecret: cliPayload.approval_secret,
        packetId: secondDraft.id,
        action: 'send',
      }),
    ).resolves.toMatchObject({ action: 'send' });

    expect(
      service
        .listAuditReceipts({
          authToken: workspace.admin.token,
          workspaceId: workspace.workspace.id,
        })
        .map((receipt) => receipt.action),
    ).toEqual(expect.arrayContaining(['rotate_approval_secret']));
  });

  test('approval-secret rotation invalidates previously minted approval tokens', async () => {
    const { service } = createService();
    const { workspace } = await setupTwoMembers(service);
    const draft = service.createAskDraft({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      to: '@alice',
      question: 'Can you inspect auth refresh?',
      title: 'Auth refresh',
      summary: 'Refresh returns 401.',
      sourceClient: 'codex',
    });
    const oldApproval = service.createApprovalToken({
      authToken: workspace.admin.token,
      approvalSecret: workspace.admin.approval_secret,
      packetId: draft.id,
      action: 'send',
    });

    const rotated = service.rotateApprovalSecret({
      authToken: workspace.admin.token,
      approvalSecret: workspace.admin.approval_secret,
    });

    expect(() =>
      service.approveAndSend({
        authToken: workspace.admin.token,
        packetId: draft.id,
        approvalToken: oldApproval.approval_token,
      }),
    ).toThrow(/approval token/i);

    const freshApproval = service.createApprovalToken({
      authToken: workspace.admin.token,
      approvalSecret: rotated.approval_secret,
      packetId: draft.id,
      action: 'send',
    });
    expect(
      service.approveAndSend({
        authToken: workspace.admin.token,
        packetId: draft.id,
        approvalToken: freshApproval.approval_token,
      }).packet.status,
    ).toBe('delivered');
  });

  test('watch mode resolves notification sender handles instead of member ids', async () => {
    const { service } = createService();
    const { workspace, alice } = await setupTwoMembers(service);
    const serverUrl = await startServer(service);
    const draft = service.createAskDraft({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      to: '@alice',
      question: 'Can you inspect auth refresh?',
      title: 'Auth refresh',
      summary: 'Refresh returns 401.',
      sourceClient: 'codex',
    });
    const sendApproval = service.createApprovalToken({
      authToken: workspace.admin.token,
      approvalSecret: workspace.admin.approval_secret,
      packetId: draft.id,
      action: 'send',
    });
    service.approveAndSend({
      authToken: workspace.admin.token,
      packetId: draft.id,
      approvalToken: sendApproval.approval_token,
    });

    const watch = await runCli([
      'watch',
      '--server-url',
      serverUrl,
      '--token',
      alice.member.token,
      '--workspace',
      workspace.workspace.id,
      '--no-desktop-notifications',
      '--once',
    ]);

    expect(watch.stderr).toContain('@sam is asking for help');
    expect(watch.stderr).not.toContain('@mem_');
  });
});
