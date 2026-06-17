import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { RelayApiClient } from '../src/api/client.js';
import { buildApiServer } from '../src/api/server.js';
import { runCli } from '../src/cli.js';
import { getMcpToolDefinitions } from '../src/mcp/server.js';
import { createNotificationDispatcher, createPollingWatcher } from '../src/notifications.js';
import { RelayService } from '../src/service/relay-service.js';
import { createProfileStore } from '../src/setup/profile.js';
import { createRelayDatabase } from '../src/storage/database.js';

function createService() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-relay-api-'));
  const dbPath = join(dir, 'relay.db');
  const service = new RelayService(createRelayDatabase(dbPath));
  return { service, dbPath };
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

async function startWebhookServer() {
  const deliveries: any[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      deliveries.push({
        method: request.method,
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      response.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected webhook server address');
  }
  return {
    deliveries,
    url: `http://127.0.0.1:${address.port}/relay`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('coordination API', () => {
  test('API client reports a machine-readable server-unavailable error', async () => {
    const closedServer = createServer();
    await new Promise<void>((resolve) => closedServer.listen(0, '127.0.0.1', resolve));
    const address = closedServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected closed server address');
    }
    await new Promise<void>((resolve) => closedServer.close(() => resolve()));

    const client = new RelayApiClient({ serverUrl: `http://127.0.0.1:${address.port}` });
    await expect(
      client.listMembers({ authToken: 'relay_member_dead', workspaceId: 'wrk_dead' }),
    ).rejects.toMatchObject({
      code: 'SERVER_UNAVAILABLE',
      statusCode: 503,
    });
  });

  test('CLI reports server-unavailable as clean JSON without a stack trace', async () => {
    const closedServer = createServer();
    await new Promise<void>((resolve) => closedServer.listen(0, '127.0.0.1', resolve));
    const address = closedServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected closed server address');
    }
    await new Promise<void>((resolve) => closedServer.close(() => resolve()));

    const result = await runCli([
      'member',
      'list',
      '--server-url',
      `http://127.0.0.1:${address.port}`,
      '--token',
      'relay_member_dead',
      '--workspace',
      'wrk_dead',
      '--json',
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr).error).toMatchObject({
      code: 'SERVER_UNAVAILABLE',
    });
    expect(result.stderr).not.toContain('TypeError');
    expect(result.stderr).not.toContain('\n    at ');
    expect(result.stderr).not.toContain('src/api/client.ts');
  });

  test('CLI reports API Relay errors as clean human-readable lines without stack traces', async () => {
    const { service } = createService();
    const app = buildApiServer({ service });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected API server address');
    }
    try {
      const workspace = service.createWorkspace({
        name: 'CLI Error Team',
        adminHandle: 'sam',
        adminName: 'Sam',
      });
      service.inviteMember({
        adminToken: workspace.admin.token,
        workspaceId: workspace.workspace.id,
        handle: 'alice',
      });

      const result = await runCli([
        'ask',
        '@alice',
        'Can you inspect this?',
        '--server-url',
        `http://127.0.0.1:${address.port}`,
        '--token',
        workspace.admin.token,
        '--workspace',
        workspace.workspace.id,
        '--title',
        'Unsupported client',
        '--summary',
        'This should fail cleanly.',
        '--source-client',
        'made-up-client',
      ]);

      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('[UNSUPPORTED_CLIENT]');
      expect(result.stderr).not.toContain('ZodError');
      expect(result.stderr).not.toContain('at ');
    } finally {
      await app.close();
    }
  });

  test('creates users and completes an ask through Fastify routes', async () => {
    const { service } = createService();
    const app = buildApiServer({ service });

    const workspaceResponse = await app.inject({
      method: 'POST',
      url: '/workspaces',
      payload: { name: 'API Team', adminHandle: 'sam', adminName: 'Sam' },
    });
    const workspace = workspaceResponse.json();
    const inviteResponse = await app.inject({
      method: 'POST',
      url: `/workspaces/${workspace.workspace.id}/invites`,
      headers: { authorization: `Bearer ${workspace.admin.token}` },
      payload: { handle: 'alice' },
    });
    const invite = inviteResponse.json();
    const acceptedResponse = await app.inject({
      method: 'POST',
      url: `/invites/${invite.invite.token}/accept`,
      payload: { displayName: 'Alice' },
    });
    const accepted = acceptedResponse.json();

    const askResponse = await app.inject({
      method: 'POST',
      url: '/packets/ask',
      headers: { authorization: `Bearer ${workspace.admin.token}` },
      payload: {
        workspaceId: workspace.workspace.id,
        to: '@alice',
        question: 'Can you inspect the auth refresh test?',
        title: 'Auth refresh',
        summary: 'The integration test returns 401.',
        sourceClient: 'codex',
      },
    });
    const ask = askResponse.json();
    const approvalResponse = await app.inject({
      method: 'POST',
      url: `/packets/${ask.id}/approval-token`,
      headers: { authorization: `Bearer ${workspace.admin.token}` },
      payload: { action: 'send', approvalSecret: workspace.admin.approval_secret },
    });
    const approval = approvalResponse.json();
    await app.inject({
      method: 'POST',
      url: `/packets/${ask.id}/approve`,
      headers: { authorization: `Bearer ${workspace.admin.token}` },
      payload: { approvalToken: approval.approval_token },
    });
    const inboxResponse = await app.inject({
      method: 'GET',
      url: `/inbox?workspaceId=${workspace.workspace.id}`,
      headers: { authorization: `Bearer ${accepted.member.token}` },
    });

    expect(workspaceResponse.statusCode).toBe(200);
    expect(askResponse.statusCode).toBe(200);
    expect(inboxResponse.json()).toHaveLength(1);
  });

  test('unsupported source clients return UNSUPPORTED_CLIENT instead of INTERNAL_ERROR', async () => {
    const { service } = createService();
    const app = buildApiServer({ service });
    const workspace = service.createWorkspace({
      name: 'Unsupported Client Team',
      adminHandle: 'sam',
      adminName: 'Sam',
    });
    service.inviteMember({
      adminToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      handle: 'alice',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/packets/ask',
      headers: { authorization: `Bearer ${workspace.admin.token}` },
      payload: {
        workspaceId: workspace.workspace.id,
        to: '@alice',
        question: 'Can you inspect this?',
        title: 'Unsupported client',
        summary: 'The source client should be rejected predictably.',
        sourceClient: 'made-up-client',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      code: 'UNSUPPORTED_CLIENT',
    });
  });

  test('invite GET endpoint shows a join command without accepting the invite', async () => {
    const { service } = createService();
    const app = buildApiServer({ service });
    const workspace = service.createWorkspace({
      name: 'Invite Link Team',
      adminHandle: 'sam',
      adminName: 'Sam',
    });
    const invite = service.inviteMember({
      adminToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      handle: 'alice',
    });

    const response = await app.inject({
      method: 'GET',
      url: `/invite/${invite.invite.token}`,
    });
    const accepted = service.acceptInvite({
      inviteToken: invite.invite.token,
      displayName: 'Alice',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('npx -y @0dust/handoff join');
    expect(response.body).toContain(`/invite/${invite.invite.token}`);
    expect(accepted.member.handle).toBe('alice');
  });
});

describe('MCP tool contracts', () => {
  test('exposes the core Relay tools and delegates to service operations', async () => {
    const { service } = createService();
    const workspace = service.createWorkspace({
      name: 'MCP Team',
      adminHandle: 'sam',
      adminName: 'Sam',
    });
    const tools = getMcpToolDefinitions(service);

    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'relay_ask',
        'relay_share',
        'relay_approve',
        'relay_inbox',
        'relay_status',
        'relay_hydrate',
        'relay_reply',
        'relay_clarify',
        'relay_decline',
        'relay_archive',
        'relay_search',
      ]),
    );

    const askTool = tools.find((tool) => tool.name === 'relay_ask');
    const result = await askTool?.handler({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      to: '@sam',
      question: 'Can you review my own draft?',
      title: 'Self ask',
      summary: 'Useful for smoke tests.',
      sourceClient: 'generic',
    });

    expect(result).toMatchObject({ status: 'pending_sender_approval' });
  });

  test('profile-backed schemas omit auth fields and handlers inject auth context', async () => {
    const { service } = createService();
    const workspace = service.createWorkspace({
      name: 'Profile MCP Team',
      adminHandle: 'sam',
      adminName: 'Sam',
    });
    const invite = service.inviteMember({
      adminToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      handle: 'alice',
    });
    service.acceptInvite({ inviteToken: invite.invite.token, displayName: 'Alice' });
    const tools = getMcpToolDefinitions(service, {
      authContext: {
        authToken: workspace.admin.token,
        workspaceId: workspace.workspace.id,
      },
    });
    const askTool = tools.find((tool) => tool.name === 'relay_ask');

    expect(askTool?.inputSchema.authToken).toBeUndefined();
    expect(askTool?.inputSchema.workspaceId).toBeUndefined();
    const result = await askTool?.handler({
      to: '@alice',
      question: 'Can you inspect this?',
      title: 'Profile auth',
      summary: 'MCP should inject auth from the profile.',
      sourceClient: 'codex',
    });

    expect(result).toMatchObject({ status: 'pending_sender_approval' });
  });

  test('explicit-auth MCP compatibility mode still exposes auth fields', () => {
    const { service } = createService();
    const tools = getMcpToolDefinitions(service, { explicitAuth: true });
    const askTool = tools.find((tool) => tool.name === 'relay_ask');
    const inboxTool = tools.find((tool) => tool.name === 'relay_inbox');

    expect(askTool?.inputSchema.authToken).toBeTruthy();
    expect(askTool?.inputSchema.workspaceId).toBeTruthy();
    expect(inboxTool?.inputSchema.authToken).toBeTruthy();
    expect(inboxTool?.inputSchema.workspaceId).toBeTruthy();
  });

  test('profile-backed MCP startup can resolve auth from the active profile', async () => {
    const { service, dbPath } = createService();
    const workspace = service.createWorkspace({
      name: 'Stored MCP Team',
      adminHandle: 'sam',
      adminName: 'Sam',
    });
    const home = mkdtempSync(join(tmpdir(), 'handoff-mcp-profile-'));
    const store = createProfileStore({ home });
    store.saveProfile({
      schemaVersion: 1,
      profileName: 'default',
      workspaceId: workspace.workspace.id,
      workspaceName: workspace.workspace.name,
      memberId: workspace.admin.id,
      handle: workspace.admin.handle,
      displayName: workspace.admin.display_name,
      role: workspace.admin.role,
      serverUrl: 'local-db',
      localDatabasePath: dbPath,
      serverMode: 'local',
      createdAt: new Date().toISOString(),
      lastVerifiedAt: new Date().toISOString(),
    });
    store.saveCredentials('default', {
      memberToken: workspace.admin.token,
      approvalSecret: workspace.admin.approval_secret,
      createdAt: new Date().toISOString(),
    });
    const tools = getMcpToolDefinitions(service, {
      profileStore: store,
      profileName: 'default',
    });
    const inboxTool = tools.find((tool) => tool.name === 'relay_inbox');

    expect(inboxTool?.inputSchema.authToken).toBeUndefined();
    expect(inboxTool?.inputSchema.workspaceId).toBeUndefined();
    await expect(inboxTool?.handler({})).resolves.toEqual([]);
  });
});

describe('CLI and watcher', () => {
  test('supports workspace/member setup and ask approval as a CLI fallback', async () => {
    const { dbPath } = createService();
    const created = await runCli([
      'workspace',
      'create',
      '--db',
      dbPath,
      '--name',
      'CLI Team',
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
      '--db',
      dbPath,
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
      '--db',
      dbPath,
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
      'Can you check auth refresh?',
      '--db',
      dbPath,
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

    const approval = await runCliWithApproval([
      'approval-token',
      draft.id,
      '--db',
      dbPath,
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
      '--db',
      dbPath,
      '--token',
      workspace.admin.token,
      '--approval-token',
      approvalToken,
      '--json',
    ]);
    const inbox = await runCli([
      'inbox',
      '--db',
      dbPath,
      '--token',
      alice.member.token,
      '--workspace',
      workspace.workspace.id,
      '--json',
    ]);

    expect(JSON.parse(inbox.stdout)).toHaveLength(1);
  });

  test('polling watcher emits only newly delivered packets', async () => {
    const { service } = createService();
    const workspace = service.createWorkspace({
      name: 'Watch Team',
      adminHandle: 'sam',
      adminName: 'Sam',
    });
    const notifications: string[] = [];
    const watcher = createPollingWatcher({
      poll: () => [
        {
          packet_id: 'pkt_1',
          packet_type: 'ask',
          title: 'Auth refresh',
          summary: 'Refresh returns 401.',
          sender_handle: 'sam',
          project: 'project-api',
        },
      ],
      notify: (message) => {
        notifications.push(message);
      },
      intervalMs: 5,
    });

    await watcher.tick();
    await watcher.tick();
    watcher.stop();

    expect(workspace.workspace.id).toMatch(/^wrk_/);
    expect(notifications).toEqual([
      '@sam is asking for help on Auth refresh in project-api. Review packet?',
    ]);
  });

  test('notification dispatcher can send terminal, desktop-native, and webhook notifications', async () => {
    const terminal: string[] = [];
    const nativeCalls: Array<{ command: string; args: string[] }> = [];
    const webhookDeliveries: Array<{ url: string; body: any; headers: any }> = [];
    const dispatcher = createNotificationDispatcher({
      writeTerminal: (message) => terminal.push(message),
      desktop: true,
      platform: 'darwin',
      runNativeNotification: async (command, args) => {
        nativeCalls.push({ command, args });
      },
      webhookUrl: 'https://hooks.example.test/relay',
      webhookHeaders: { authorization: 'Bearer test-token' },
      fetchImpl: async (url, init) => {
        webhookDeliveries.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
          headers: init?.headers,
        });
        return new Response('', { status: 204 });
      },
    });

    await dispatcher('@sam is asking for help on Auth refresh in project-api. Review packet?', {
      packet_id: 'pkt_1',
      packet_type: 'ask',
      title: 'Auth refresh',
      summary: 'Refresh returns 401. API_KEY=sk-should-not-exist-in-payload',
      sender_handle: 'sam',
      project: 'project-api',
    });

    expect(terminal).toEqual([
      '@sam is asking for help on Auth refresh in project-api. Review packet?',
    ]);
    expect(nativeCalls[0]).toMatchObject({ command: 'osascript' });
    expect(nativeCalls[0].args.join(' ')).toContain('Auth refresh');
    expect(webhookDeliveries).toHaveLength(1);
    expect(webhookDeliveries[0].url).toBe('https://hooks.example.test/relay');
    expect(webhookDeliveries[0].body).toMatchObject({
      event: 'relay.notification',
      packet_id: 'pkt_1',
      packet_type: 'ask',
      sender_handle: 'sam',
      project: 'project-api',
      action: 'open/review',
    });
    expect(JSON.stringify(webhookDeliveries[0].body)).not.toContain('sk-should-not-exist');
  });

  test('watch command posts newly delivered packet summaries to a webhook adapter', async () => {
    const { service } = createService();
    const app = buildApiServer({ service });
    const webhook = await startWebhookServer();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected API server address');
    }
    const serverUrl = `http://127.0.0.1:${address.port}`;
    try {
      const workspace = service.createWorkspace({
        name: 'Webhook Watch Team',
        adminHandle: 'sam',
        adminName: 'Sam',
      });
      const invite = service.inviteMember({
        adminToken: workspace.admin.token,
        workspaceId: workspace.workspace.id,
        handle: 'alice',
      });
      const alice = service.acceptInvite({
        inviteToken: invite.invite.token,
        displayName: 'Alice',
      });
      const draft = service.createAskDraft({
        authToken: workspace.admin.token,
        workspaceId: workspace.workspace.id,
        to: '@alice',
        question: 'Can you inspect auth refresh?',
        title: 'Auth refresh',
        summary: 'Refresh returns 401.',
        sourceClient: 'codex',
      });
      const approval = service.createApprovalToken({
        authToken: workspace.admin.token,
        approvalSecret: workspace.admin.approval_secret,
        packetId: draft.id,
        action: 'send',
      });
      service.approveAndSend({
        authToken: workspace.admin.token,
        packetId: draft.id,
        approvalToken: approval.approval_token,
      });

      const watch = await runCli([
        'watch',
        '--server-url',
        serverUrl,
        '--token',
        alice.member.token,
        '--workspace',
        workspace.workspace.id,
        '--webhook-url',
        webhook.url,
        '--once',
      ]);

      expect(watch.stderr).toContain('@sam is asking for help');
      expect(webhook.deliveries).toHaveLength(1);
      expect(webhook.deliveries[0].body).toMatchObject({
        event: 'relay.notification',
        packet_id: draft.id,
        title: 'Auth refresh',
        project: 'unknown-project',
      });
    } finally {
      await app.close();
      await webhook.close();
    }
  });

  test('local demo command runs the full ask and share flow', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-relay-demo-'));
    const demoDb = join(dir, 'demo.db');
    const result = await runCli(['demo', 'two-user', '--db', demoDb, '--json']);
    const parsed = JSON.parse(result.stdout);

    expect(parsed.ask.status).toBe('closed_resolved');
    expect(parsed.reply.status).toBe('hydrated');
    expect(parsed.share.status).toBe('archived');
  });

  test('launch assets include a short-video recording demo script', () => {
    const scriptPath = join(process.cwd(), 'docs', 'demo-video-script.md');
    expect(existsSync(scriptPath)).toBe(true);
    const script = readFileSync(scriptPath, 'utf8');
    expect(script).toContain('npx -y @0dust/handoff demo two-user');
    expect(script.toLowerCase()).toContain('record');
  });
});
