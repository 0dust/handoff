import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Command } from 'commander';
import { describe, expect, test } from 'vitest';

import packageJson from '../package.json' with { type: 'json' };
import { RelayApiClient } from '../src/api/client.js';
import { buildApiServer } from '../src/api/server.js';
import { runCli } from '../src/cli.js';
import { registerServerCommands } from '../src/cli/server-commands.js';
import { relayError } from '../src/errors.js';
import { createMcpServer, getMcpToolDefinitions } from '../src/mcp/server.js';
import {
  inspectBackgroundNotificationWatcher,
  startBackgroundNotificationWatcher,
  stopBackgroundNotificationWatcher,
} from '../src/notification-watch-lifecycle.js';
import { createNotificationDispatcher, createPollingWatcher } from '../src/notifications.js';
import { RelayService } from '../src/service/relay-service.js';
import { createProfileStore } from '../src/setup/profile.js';
import { createRelayDatabase } from '../src/storage/database.js';
import { databaseIdForPath } from '../src/storage/database-id.js';

function createService() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-relay-api-'));
  const dbPath = join(dir, 'relay.db');
  const db = createRelayDatabase(dbPath);
  const service = new RelayService(db);
  return { service, db, dbPath };
}

async function startApiForService(service: RelayService) {
  const app = buildApiServer({ service });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected API server address');
  }
  return {
    close: () => app.close(),
    serverUrl: `http://127.0.0.1:${address.port}`,
  };
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
  test('runtime surfaces report the package version from a shared constant', async () => {
    const { runtimeVersion } = await import('../src/runtime/version.js');
    const { service, dbPath } = createService();
    const app = buildApiServer({ service, databaseId: databaseIdForPath(dbPath) });

    const health = await app.inject({
      method: 'GET',
      url: '/health',
    });
    const cli = await runCli(['--version']);

    expect(runtimeVersion).toBe(packageJson.version);
    expect(health.json().version).toBe(runtimeVersion);
    expect(health.json().database_id).toBe(databaseIdForPath(dbPath));
    expect(cli.stdout.trim()).toBe(runtimeVersion);
  });

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
    const transportResponse = await app.inject({
      method: 'GET',
      url: `/_diagnostics/a2a/packets/${ask.id}/transport`,
      headers: { authorization: `Bearer ${workspace.admin.token}` },
    });
    const inboxResponse = await app.inject({
      method: 'GET',
      url: `/inbox?workspaceId=${workspace.workspace.id}`,
      headers: { authorization: `Bearer ${accepted.member.token}` },
    });

    expect(workspaceResponse.statusCode).toBe(200);
    expect(askResponse.statusCode).toBe(200);
    expect(transportResponse.json().transport).toMatchObject({
      protocol: 'a2a-internal',
      task_id: `tsk_${ask.id}`,
      trust_receipt: {
        packet_id: ask.id,
        redaction_blocked: false,
      },
    });
    expect(inboxResponse.json()).toHaveLength(1);
  });

  test('diagnostic transport route is explicit, authenticated, and stable when absent', async () => {
    const { service } = createService();
    const app = buildApiServer({ service });
    const workspace = service.createWorkspace({
      name: 'API Team',
      adminHandle: 'sam',
      adminName: 'Sam',
    });
    const invite = service.inviteMember({
      adminToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      handle: 'alice',
    });
    service.acceptInvite({ displayName: 'Alice', inviteToken: invite.invite.token });
    const outsider = service.createWorkspace({
      name: 'Other Team',
      adminHandle: 'owen',
      adminName: 'Owen',
    });
    const draft = service.createShareDraft({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      to: '@alice',
      finding: 'The retry path skips persistence.',
      title: 'Retry persistence',
      summary: 'A2A metadata should be inspectable only through an explicit diagnostic route.',
      sourceClient: 'codex',
    });

    const beforeSend = await app.inject({
      method: 'GET',
      url: `/_diagnostics/a2a/packets/${draft.id}/transport`,
      headers: { authorization: `Bearer ${workspace.admin.token}` },
    });
    const missingAuth = await app.inject({
      method: 'GET',
      url: `/_diagnostics/a2a/packets/${draft.id}/transport`,
    });
    const unrelatedMember = await app.inject({
      method: 'GET',
      url: `/_diagnostics/a2a/packets/${draft.id}/transport`,
      headers: { authorization: `Bearer ${outsider.admin.token}` },
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
    const afterSend = await app.inject({
      method: 'GET',
      url: `/_diagnostics/a2a/packets/${draft.id}/transport`,
      headers: { authorization: `Bearer ${workspace.admin.token}` },
    });
    const status = await app.inject({
      method: 'GET',
      url: `/packets/${draft.id}/status`,
      headers: { authorization: `Bearer ${workspace.admin.token}` },
    });

    expect(beforeSend.statusCode).toBe(200);
    expect(beforeSend.json()).toEqual({ transport: null });
    expect(missingAuth.statusCode).toBe(401);
    expect(unrelatedMember.statusCode).toBe(403);
    expect(afterSend.json().transport).toMatchObject({
      packet_id: draft.id,
      task_state: 'TASK_STATE_WORKING',
      trust_receipt: {
        packet_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
    });
    expect(status.json()).not.toHaveProperty('transport');
  });

  test('serves a minimal cacheable Agent Card without exposing workspace activity', async () => {
    const { service } = createService();
    const app = buildApiServer({ service });
    const workspace = service.createWorkspace({
      name: 'Private API Team',
      adminHandle: 'sam',
      adminName: 'Sam',
    });
    const invite = service.inviteMember({
      adminToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      handle: 'alice',
    });
    const alice = service.acceptInvite({ displayName: 'Alice', inviteToken: invite.invite.token });
    const draft = service.createAskDraft({
      authToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      to: '@alice',
      question: 'Sensitive body should not appear.',
      title: 'Leaky Activity Signal',
      summary: 'Private packet activity must not appear in discovery.',
      sourceClient: 'codex',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/.well-known/agent-card.json',
      headers: {
        host: 'handoff.test:3737',
        'x-forwarded-proto': 'https',
      },
    });
    const card = response.json();
    const etag = response.headers.etag;
    const cached = await app.inject({
      method: 'GET',
      url: '/.well-known/agent-card.json',
      headers: {
        host: 'handoff.test:3737',
        'if-none-match': etag,
        'x-forwarded-proto': 'https',
      },
    });
    const cachedFromList = await app.inject({
      method: 'GET',
      url: '/.well-known/agent-card.json',
      headers: {
        host: 'handoff.test:3737',
        'if-none-match': `"other", ${etag}`,
        'x-forwarded-proto': 'https',
      },
    });
    const cachedFromWildcard = await app.inject({
      method: 'GET',
      url: '/.well-known/agent-card.json',
      headers: {
        host: 'handoff.test:3737',
        'if-none-match': '*',
        'x-forwarded-proto': 'https',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/a2a+json');
    expect(response.headers['cache-control']).toContain('max-age=300');
    expect(etag).toMatch(/^"sha256-[a-f0-9]{64}"$/);
    expect(cached.statusCode).toBe(304);
    expect(cachedFromList.statusCode).toBe(304);
    expect(cachedFromWildcard.statusCode).toBe(304);
    expect(card).toMatchObject({
      name: 'Handoff',
      version: packageJson.version,
      supportedInterfaces: [],
      capabilities: {
        streaming: false,
        pushNotifications: false,
        extendedAgentCard: false,
        publicA2aReceiving: false,
      },
    });
    const serializedCard = JSON.stringify(card);
    expect(serializedCard).not.toContain(workspace.workspace.id);
    expect(serializedCard).not.toContain(workspace.admin.id);
    expect(serializedCard).not.toContain(alice.member.id);
    expect(serializedCard).not.toContain(workspace.admin.token);
    expect(serializedCard).not.toContain(workspace.admin.approval_secret);
    expect(serializedCard).not.toContain(draft.id);
    expect(serializedCard).not.toContain('Leaky Activity Signal');
    expect(serializedCard).not.toContain('Sensitive body should not appear.');
    expect(serializedCard).not.toContain('relay_member');
  });

  test('A2A receive stub returns disabled JSON-RPC errors without creating packets', async () => {
    const { service, db } = createService();
    const app = buildApiServer({ service });
    service.createWorkspace({ name: 'API Team', adminHandle: 'sam', adminName: 'Sam' });

    const disabled = await app.inject({
      method: 'POST',
      url: '/a2a',
      payload: {
        jsonrpc: '2.0',
        id: 'req-1',
        method: 'SendMessage',
        params: { message: { parts: [] } },
      },
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/a2a',
      payload: {
        jsonrpc: '2.0',
        id: 'req-2',
        method: 'TaskTeleport',
      },
    });
    const packetCount = db.prepare('SELECT COUNT(*) AS count FROM packets').get() as {
      count: number;
    };

    expect(disabled.statusCode).toBe(200);
    expect(disabled.headers['content-type']).toContain('application/a2a+json');
    expect(disabled.json()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-1',
      error: {
        code: -32004,
        data: [expect.objectContaining({ reason: 'A2A_DISABLED' })],
      },
    });
    expect(unknown.json()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-2',
      error: {
        code: -32601,
        data: [expect.objectContaining({ reason: 'A2A_METHOD_NOT_FOUND' })],
      },
    });
    expect(packetCount.count).toBe(0);
  });

  test('A2A receive stub keeps JSON-RPC error shape for malformed and invalid requests', async () => {
    const { service, db } = createService();
    const app = buildApiServer({ service });
    service.createWorkspace({ name: 'API Team', adminHandle: 'sam', adminName: 'Sam' });

    const malformed = await app.inject({
      method: 'POST',
      url: '/a2a',
      payload: '{"jsonrpc":',
      headers: { 'content-type': 'application/a2a+json' },
    });
    const invalid = await app.inject({
      method: 'POST',
      url: '/a2a',
      payload: {
        jsonrpc: '1.0',
        id: 'invalid-1',
        method: 'SendMessage',
      },
      headers: { 'content-type': 'application/a2a+json' },
    });
    const missingMethod = await app.inject({
      method: 'POST',
      url: '/a2a',
      payload: {
        jsonrpc: '2.0',
        id: 'invalid-2',
      },
      headers: { 'content-type': 'application/a2a+json' },
    });
    const packetCount = db.prepare('SELECT COUNT(*) AS count FROM packets').get() as {
      count: number;
    };

    expect(malformed.statusCode).toBe(200);
    expect(malformed.headers['content-type']).toContain('application/a2a+json');
    expect(malformed.json()).toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32700,
        data: [expect.objectContaining({ reason: 'A2A_PARSE_ERROR' })],
      },
    });
    expect(invalid.json()).toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32600,
        data: [expect.objectContaining({ reason: 'A2A_INVALID_REQUEST' })],
      },
    });
    expect(missingMethod.json()).toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32600,
        data: [expect.objectContaining({ reason: 'A2A_INVALID_REQUEST' })],
      },
    });
    expect(packetCount.count).toBe(0);
  });

  test('A2A receive opt-in remains a non-advertising non-accepting stub', async () => {
    const previous = process.env.HANDOFF_ENABLE_A2A;
    process.env.HANDOFF_ENABLE_A2A = '1';
    try {
      const { service, db } = createService();
      const app = buildApiServer({ service });
      service.createWorkspace({ name: 'API Team', adminHandle: 'sam', adminName: 'Sam' });

      const cardResponse = await app.inject({
        method: 'GET',
        url: '/.well-known/agent-card.json',
      });
      const notImplemented = await app.inject({
        method: 'POST',
        url: '/a2a',
        payload: {
          jsonrpc: '2.0',
          id: 'req-enabled',
          method: 'SendMessage',
          params: { message: { parts: [] } },
        },
      });
      const packetCount = db.prepare('SELECT COUNT(*) AS count FROM packets').get() as {
        count: number;
      };

      expect(cardResponse.json()).toMatchObject({
        supportedInterfaces: [],
        capabilities: { publicA2aReceiving: false },
        metadata: { public_a2a_receiving: 'not_implemented' },
      });
      expect(notImplemented.json()).toMatchObject({
        jsonrpc: '2.0',
        id: 'req-enabled',
        error: {
          code: -32004,
          data: [expect.objectContaining({ reason: 'A2A_NOT_IMPLEMENTED' })],
        },
      });
      expect(packetCount.count).toBe(0);
    } finally {
      if (previous === undefined) {
        delete process.env.HANDOFF_ENABLE_A2A;
      } else {
        process.env.HANDOFF_ENABLE_A2A = previous;
      }
    }
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

  test('invalid workspace admin handles return INVALID_INPUT instead of INTERNAL_ERROR', async () => {
    const { service } = createService();
    const app = buildApiServer({ service });

    const response = await app.inject({
      method: 'POST',
      url: '/workspaces',
      payload: { name: 'Invalid Handle Team', adminHandle: '!', adminName: 'Sam' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  test('invalid invite handles return INVALID_INPUT instead of INTERNAL_ERROR', async () => {
    const { service } = createService();
    const app = buildApiServer({ service });
    const workspace = service.createWorkspace({
      name: 'Invalid Invite Team',
      adminHandle: 'sam',
      adminName: 'Sam',
    });

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${workspace.workspace.id}/invites`,
      headers: { authorization: `Bearer ${workspace.admin.token}` },
      payload: { handle: '!' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  test('unexpected API errors return a generic 500 while Relay errors keep client-facing messages', async () => {
    const { service } = createService();
    const app = buildApiServer({ service });
    app.get('/test/unexpected-error', async () => {
      throw new Error('sqlite path /Users/sam/private/relay.db is locked');
    });
    app.get('/test/relay-error', async () => {
      throw relayError('FORBIDDEN', 'Only workspace admins can invite members.', 403);
    });

    const unexpected = await app.inject({ method: 'GET', url: '/test/unexpected-error' });
    const intentional = await app.inject({ method: 'GET', url: '/test/relay-error' });

    expect(unexpected.statusCode).toBe(500);
    expect(unexpected.json().error).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'Unexpected internal server error.',
    });
    expect(unexpected.body).not.toContain('/Users/sam/private/relay.db');
    expect(unexpected.body).not.toContain('sqlite path');
    expect(intentional.statusCode).toBe(403);
    expect(intentional.json().error).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Only workspace admins can invite members.',
    });
  });

  test('public workspace bootstrap is denied by default and allowed explicitly', async () => {
    const previousAllow = process.env.HANDOFF_ALLOW_PUBLIC_WORKSPACE_BOOTSTRAP;
    const previousWorkspaceToken = process.env.HANDOFF_WORKSPACE_BOOTSTRAP_TOKEN;
    const previousBootstrapToken = process.env.HANDOFF_BOOTSTRAP_TOKEN;
    try {
      delete process.env.HANDOFF_ALLOW_PUBLIC_WORKSPACE_BOOTSTRAP;
      delete process.env.HANDOFF_WORKSPACE_BOOTSTRAP_TOKEN;
      delete process.env.HANDOFF_BOOTSTRAP_TOKEN;

      const denied = buildApiServer({ service: createService().service, bindHost: '0.0.0.0' });
      const local = buildApiServer({ service: createService().service, bindHost: '127.0.0.1' });
      const allowed = buildApiServer({
        service: createService().service,
        bindHost: '10.0.0.10',
        allowPublicWorkspaceBootstrap: true,
      });
      const tokenProtected = buildApiServer({
        service: createService().service,
        bindHost: '0.0.0.0',
        workspaceBootstrapToken: 'setup-token',
      });
      const clientTokenProtected = buildApiServer({
        service: createService().service,
        bindHost: '0.0.0.0',
        workspaceBootstrapToken: 'client-token',
      });
      const payload = { name: 'Bootstrap Team', adminHandle: 'sam', adminName: 'Sam' };

      const deniedResponse = await denied.inject({ method: 'POST', url: '/workspaces', payload });
      const localResponse = await local.inject({ method: 'POST', url: '/workspaces', payload });
      const allowedResponse = await allowed.inject({ method: 'POST', url: '/workspaces', payload });
      const wrongTokenResponse = await tokenProtected.inject({
        method: 'POST',
        url: '/workspaces',
        headers: { 'x-handoff-bootstrap-token': 'wrong-token' },
        payload,
      });
      const tokenResponse = await tokenProtected.inject({
        method: 'POST',
        url: '/workspaces',
        headers: { 'x-handoff-bootstrap-token': 'setup-token' },
        payload,
      });
      await clientTokenProtected.listen({ host: '127.0.0.1', port: 0 });
      const address = clientTokenProtected.server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected API server address');
      }
      const client = new RelayApiClient({ serverUrl: `http://127.0.0.1:${address.port}` });
      try {
        await expect(
          client.createWorkspace({
            ...payload,
            adminHandle: 'alex',
            bootstrapToken: 'client-token',
          }),
        ).resolves.toMatchObject({
          admin: { handle: 'alex' },
        });
      } finally {
        await clientTokenProtected.close();
      }

      expect(deniedResponse.statusCode).toBe(401);
      expect(deniedResponse.json().error).toMatchObject({
        code: 'AUTH_REQUIRED',
        message:
          'Workspace bootstrap is disabled on non-loopback API listeners unless explicitly allowed.',
      });
      expect(localResponse.statusCode).toBe(200);
      expect(allowedResponse.statusCode).toBe(200);
      expect(wrongTokenResponse.statusCode).toBe(401);
      expect(tokenResponse.statusCode).toBe(200);
    } finally {
      if (previousAllow === undefined) delete process.env.HANDOFF_ALLOW_PUBLIC_WORKSPACE_BOOTSTRAP;
      else process.env.HANDOFF_ALLOW_PUBLIC_WORKSPACE_BOOTSTRAP = previousAllow;
      if (previousWorkspaceToken === undefined)
        delete process.env.HANDOFF_WORKSPACE_BOOTSTRAP_TOKEN;
      else process.env.HANDOFF_WORKSPACE_BOOTSTRAP_TOKEN = previousWorkspaceToken;
      if (previousBootstrapToken === undefined) delete process.env.HANDOFF_BOOTSTRAP_TOKEN;
      else process.env.HANDOFF_BOOTSTRAP_TOKEN = previousBootstrapToken;
    }
  });

  test('exported API builder denies public bootstrap when listen host is public', async () => {
    const publicBuilder = buildApiServer({ service: createService().service });
    await publicBuilder.listen({ host: '0.0.0.0', port: 0 });
    const address = publicBuilder.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected API server address');
    }
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Public Team', adminHandle: 'sam', adminName: 'Sam' }),
      });
      const payload = (await response.json()) as any;

      expect(response.status).toBe(401);
      expect(payload.error).toMatchObject({ code: 'AUTH_REQUIRED' });
    } finally {
      await publicBuilder.close();
    }
  });

  test('HTTP packet command endpoints ignore harmless extra top-level fields', async () => {
    const { service } = createService();
    const app = buildApiServer({ service });
    const workspace = service.createWorkspace({
      name: 'API Team',
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

    const ask = await app.inject({
      method: 'POST',
      url: '/packets/ask',
      headers: { authorization: `Bearer ${workspace.admin.token}` },
      payload: {
        workspaceId: workspace.workspace.id,
        to: '@alice',
        question: 'Can you inspect auth refresh?',
        title: 'Auth refresh',
        summary: 'Refresh returns 401.',
        sourceClient: 'codex',
        requestId: 'client-generated-id',
      },
    });
    const share = await app.inject({
      method: 'POST',
      url: '/packets/share',
      headers: { authorization: `Bearer ${workspace.admin.token}` },
      payload: {
        workspaceId: workspace.workspace.id,
        to: '@alice',
        finding: 'Refresh retry skips persistence.',
        title: 'Refresh retry',
        summary: 'Retry ordering bug.',
        sourceClient: 'codex',
        redundantWorkspaceId: workspace.workspace.id,
      },
    });
    const askPayload = ask.json();
    const update = await app.inject({
      method: 'PATCH',
      url: `/packets/${askPayload.id}/draft`,
      headers: { authorization: `Bearer ${workspace.admin.token}` },
      payload: { summary: 'Updated summary.', clientTrace: 'ignored' },
    });
    const sendApproval = service.createApprovalToken({
      authToken: workspace.admin.token,
      approvalSecret: workspace.admin.approval_secret,
      packetId: askPayload.id,
      action: 'send',
    });
    service.approveAndSend({
      authToken: workspace.admin.token,
      packetId: askPayload.id,
      approvalToken: sendApproval.approval_token,
    });
    service.viewPacket({ authToken: alice.member.token, packetId: askPayload.id });
    const clarification = service.requestClarification({
      authToken: alice.member.token,
      packetId: askPayload.id,
      question: 'Can you add the failing assertion?',
    });
    const answer = await app.inject({
      method: 'POST',
      url: `/packets/${clarification.id}/answer-clarification`,
      headers: { authorization: `Bearer ${workspace.admin.token}` },
      payload: {
        answer: 'expected 200 received 401',
        extraClientMetadata: 'ignored',
      },
    });

    expect(ask.statusCode).toBe(200);
    expect(share.statusCode).toBe(200);
    expect(update.statusCode).toBe(200);
    expect(update.json().packet.summary).toBe('Updated summary.');
    expect(answer.statusCode).toBe(200);
    expect(answer.json().packet.summary).toBe('expected 200 received 401');
  });

  test('search and history honor pagination query parameters', async () => {
    const { service } = createService();
    const app = buildApiServer({ service });
    const workspace = service.createWorkspace({
      name: 'Pagination Team',
      adminHandle: 'sam',
      adminName: 'Sam',
    });
    const invite = service.inviteMember({
      adminToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      handle: 'alice',
    });
    service.acceptInvite({ inviteToken: invite.invite.token, displayName: 'Alice' });
    for (const title of ['Pagination one', 'Pagination two', 'Pagination three']) {
      service.createAskDraft({
        authToken: workspace.admin.token,
        workspaceId: workspace.workspace.id,
        to: '@alice',
        question: `Can you inspect ${title}?`,
        title,
        summary: 'Pagination regression packet.',
        sourceClient: 'codex',
      });
    }

    const search = await app.inject({
      method: 'GET',
      url: `/search?workspaceId=${workspace.workspace.id}&q=Pagination&limit=1`,
      headers: { authorization: `Bearer ${workspace.admin.token}` },
    });
    const history = await app.inject({
      method: 'GET',
      url: `/history?workspaceId=${workspace.workspace.id}&limit=2&offset=1`,
      headers: { authorization: `Bearer ${workspace.admin.token}` },
    });

    expect(search.statusCode).toBe(200);
    expect(search.json()).toHaveLength(1);
    expect(history.statusCode).toBe(200);
    expect(history.json()).toHaveLength(2);
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
    expect(response.body).toContain('npx -y handoff-relay join');
    expect(response.body).toContain(`/invite/${invite.invite.token}`);
    expect(accepted.member.handle).toBe('alice');
  });
});

describe('MCP tool contracts', () => {
  test('packet tools reuse shared protocol input schemas', async () => {
    const { service } = createService();
    const { confidenceInputSchema, packetQueryInputShape, sourceClientInputSchema } =
      await import('../src/protocol/inputs.js');
    const tools = getMcpToolDefinitions(service);
    const askTool = tools.find((tool) => tool.name === 'relay_ask');
    const searchTool = tools.find((tool) => tool.name === 'relay_search');

    expect(askTool?.inputSchema.sourceClient).toBe(sourceClientInputSchema);
    expect(askTool?.inputSchema.confidence).toBe(confidenceInputSchema);
    for (const [field, schema] of Object.entries(packetQueryInputShape)) {
      expect(searchTool?.inputSchema[field]).toBe(schema);
    }
  });

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
        'relay_review_next',
        'relay_status',
        'relay_hydrate',
        'relay_reply',
        'relay_clarify',
        'relay_answer_clarification',
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

  test('MCP array tool results stay text-only to satisfy structured content schema', async () => {
    const { service } = createService();
    const workspace = service.createWorkspace({
      name: 'Array Result Team',
      adminHandle: 'sam',
      adminName: 'Sam',
    });
    const server = createMcpServer(service, {
      authContext: {
        authToken: workspace.admin.token,
        workspaceId: workspace.workspace.id,
      },
    });
    const inboxTool = (server as any)._registeredTools.relay_inbox;

    const result = await inboxTool.handler({});

    expect(result.content[0].text).toBe('[]');
    expect(result.structuredContent).toBeUndefined();
    expect(CallToolResultSchema.safeParse(result).success).toBe(true);
  });

  test('profile-backed MCP remains strict without agent-confirmed approvals', async () => {
    const { service } = createService();
    const workspace = service.createWorkspace({
      name: 'Strict MCP Team',
      adminHandle: 'sam',
      adminName: 'Sam',
    });
    const tools = getMcpToolDefinitions(service, {
      authContext: {
        authToken: workspace.admin.token,
        workspaceId: workspace.workspace.id,
      },
    });
    const askTool = tools.find((tool) => tool.name === 'relay_ask');
    const approveTool = tools.find((tool) => tool.name === 'relay_approve');
    const hydrateTool = tools.find((tool) => tool.name === 'relay_hydrate');
    const draft = await askTool?.handler({
      to: '@sam',
      question: 'Can you review strict mode?',
      title: 'Strict approval',
      summary: 'MCP should still require a token by default.',
      sourceClient: 'codex',
    });

    expect(approveTool?.inputSchema.approvalToken.safeParse(undefined).success).toBe(false);
    expect(hydrateTool?.inputSchema.approvalToken.safeParse(undefined).success).toBe(false);
    expect(approveTool?.inputSchema.allowSecretOverride).toBeTruthy();
    await expect(approveTool?.handler({ packetId: draft.id })).rejects.toThrow(/approval token/i);
  });

  test('agent-confirmed MCP approvals send, hydrate, and approve replies without manual tokens', async () => {
    const { service } = createService();
    const workspace = service.createWorkspace({
      name: 'Agent Approval Team',
      adminHandle: 'sam',
      adminName: 'Sam',
    });
    const invite = service.inviteMember({
      adminToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      handle: 'alice',
    });
    const alice = service.acceptInvite({ inviteToken: invite.invite.token, displayName: 'Alice' });
    const senderTools = getMcpToolDefinitions(service, {
      agentApprovals: true,
      authContext: {
        approvalSecret: workspace.admin.approval_secret,
        authToken: workspace.admin.token,
        workspaceId: workspace.workspace.id,
      },
    });
    const recipientTools = getMcpToolDefinitions(service, {
      agentApprovals: true,
      authContext: {
        approvalSecret: alice.member.approval_secret,
        authToken: alice.member.token,
        workspaceId: workspace.workspace.id,
      },
    });
    const askTool = senderTools.find((tool) => tool.name === 'relay_ask');
    const senderApproveTool = senderTools.find((tool) => tool.name === 'relay_approve');
    const viewTool = recipientTools.find((tool) => tool.name === 'relay_view');
    const acceptTool = recipientTools.find((tool) => tool.name === 'relay_accept');
    const hydrateTool = recipientTools.find((tool) => tool.name === 'relay_hydrate');
    const replyTool = recipientTools.find((tool) => tool.name === 'relay_reply');
    const recipientApproveTool = recipientTools.find((tool) => tool.name === 'relay_approve');

    const draft = await askTool?.handler({
      to: '@alice',
      question: 'Can you inspect auth refresh?',
      title: 'Agent approval',
      summary: 'The agent should send after explicit user approval.',
      sourceClient: 'codex',
    });
    const sent = await senderApproveTool?.handler({ packetId: draft.id });

    expect(senderApproveTool?.inputSchema.approvalToken.safeParse(undefined).success).toBe(true);
    expect(hydrateTool?.inputSchema.approvalToken.safeParse(undefined).success).toBe(true);
    expect(senderApproveTool?.inputSchema.allowSecretOverride).toBeUndefined();
    await viewTool?.handler({ packetId: draft.id });
    await acceptTool?.handler({ packetId: draft.id });
    const hydrated = await hydrateTool?.handler({ packetId: draft.id, client: 'codex' });
    const reply = await replyTool?.handler({
      packetId: draft.id,
      answer: 'Persist the rotated token before retrying.',
      summary: 'Persistence order issue.',
      sourceClient: 'codex',
    });
    const approvedReply = await recipientApproveTool?.handler({ packetId: reply.id });

    expect(sent.packet.status).toBe('delivered');
    expect(hydrated.context).toContain('Can you inspect auth refresh?');
    expect(approvedReply.packet.status).toBe('replied');
    expect(senderApproveTool?.inputSchema.approvalSecret).toBeUndefined();
    expect(hydrateTool?.inputSchema.approvalSecret).toBeUndefined();
  });

  test('MCP shortcut tools make sender and recipient workflows explicit without skipping review', async () => {
    const { service } = createService();
    const workspace = service.createWorkspace({
      name: 'Shortcut Team',
      adminHandle: 'sam',
      adminName: 'Sam',
    });
    const invite = service.inviteMember({
      adminToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      handle: 'alice',
    });
    const alice = service.acceptInvite({ inviteToken: invite.invite.token, displayName: 'Alice' });
    const senderTools = getMcpToolDefinitions(service, {
      agentApprovals: true,
      authContext: {
        approvalSecret: workspace.admin.approval_secret,
        authToken: workspace.admin.token,
        workspaceId: workspace.workspace.id,
      },
    });
    const recipientTools = getMcpToolDefinitions(service, {
      agentApprovals: true,
      authContext: {
        approvalSecret: alice.member.approval_secret,
        authToken: alice.member.token,
        workspaceId: workspace.workspace.id,
      },
    });
    const shareTool = senderTools.find((tool) => tool.name === 'relay_share');
    const sendApprovedTool = senderTools.find((tool) => tool.name === 'relay_send_approved');
    const reviewTool = recipientTools.find((tool) => tool.name === 'relay_review');
    const hydrateApprovedTool = recipientTools.find(
      (tool) => tool.name === 'relay_hydrate_approved',
    );

    expect(sendApprovedTool?.description).toContain('Sender step 2');
    expect(reviewTool?.description).toContain('Recipient step 2');
    expect(hydrateApprovedTool?.description).toContain('Recipient step 3');

    const draft = await shareTool?.handler({
      to: '@alice',
      finding: 'The refresh retry path skips persistence.',
      title: 'Shortcut handoff',
      summary: 'Use the shortcut flow after human review.',
      sourceClient: 'codex',
    });
    const sent = await sendApprovedTool?.handler({ packetId: draft.id });

    await expect(
      hydrateApprovedTool?.handler({ packetId: draft.id, client: 'codex' }),
    ).rejects.toThrow(/review/i);
    const reviewed = await reviewTool?.handler({ packetId: draft.id });
    const hydrated = await hydrateApprovedTool?.handler({ packetId: draft.id, client: 'codex' });

    expect(sent.packet.status).toBe('delivered');
    expect(reviewed.packet.status).toBe('viewed');
    expect(reviewed.next_actions).toEqual(
      expect.arrayContaining([expect.stringContaining('relay_hydrate_approved')]),
    );
    expect(hydrated.packet.status).toBe('hydrated');
    expect(hydrated.context).toContain('refresh retry path');
  });

  test('MCP review_next opens an inbox packet without requiring the agent to know its id', async () => {
    const { service } = createService();
    const workspace = service.createWorkspace({
      name: 'Review Next Team',
      adminHandle: 'sam',
      adminName: 'Sam',
    });
    const invite = service.inviteMember({
      adminToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      handle: 'alice',
    });
    const alice = service.acceptInvite({ inviteToken: invite.invite.token, displayName: 'Alice' });
    const senderTools = getMcpToolDefinitions(service, {
      agentApprovals: true,
      authContext: {
        approvalSecret: workspace.admin.approval_secret,
        authToken: workspace.admin.token,
        workspaceId: workspace.workspace.id,
      },
    });
    const recipientTools = getMcpToolDefinitions(service, {
      agentApprovals: true,
      authContext: {
        approvalSecret: alice.member.approval_secret,
        authToken: alice.member.token,
        workspaceId: workspace.workspace.id,
      },
    });
    const shareTool = senderTools.find((tool) => tool.name === 'relay_share');
    const sendApprovedTool = senderTools.find((tool) => tool.name === 'relay_send_approved');
    const reviewNextTool = recipientTools.find((tool) => tool.name === 'relay_review_next');

    expect(reviewNextTool).toBeDefined();
    expect(reviewNextTool!.description).toContain('Recipient shortcut');
    await expect(reviewNextTool?.handler({})).resolves.toMatchObject({
      inbox_count: 0,
      packet: null,
    });

    const draft = await shareTool?.handler({
      to: '@alice',
      finding: 'The webhook ack path should be retried after local delivery.',
      title: 'Review next handoff',
      summary: 'Open the next inbox packet directly.',
      sourceClient: 'codex',
    });
    await sendApprovedTool?.handler({ packetId: draft.id });

    const reviewed = await reviewNextTool?.handler({});

    expect(reviewed.packet.packet_id).toBe(draft.id);
    expect(reviewed.packet.status).toBe('viewed');
    expect(reviewed.inbox_count).toBe(1);
    expect(reviewed.next_actions).toEqual(
      expect.arrayContaining([expect.stringContaining('relay_hydrate_approved')]),
    );
  });

  test('MCP hydrate shortcut requires review for reply packets and hydrates without accept', async () => {
    const { service } = createService();
    const workspace = service.createWorkspace({
      name: 'Reply Shortcut Team',
      adminHandle: 'sam',
      adminName: 'Sam',
    });
    const invite = service.inviteMember({
      adminToken: workspace.admin.token,
      workspaceId: workspace.workspace.id,
      handle: 'alice',
    });
    const alice = service.acceptInvite({ inviteToken: invite.invite.token, displayName: 'Alice' });
    const senderTools = getMcpToolDefinitions(service, {
      agentApprovals: true,
      authContext: {
        approvalSecret: workspace.admin.approval_secret,
        authToken: workspace.admin.token,
        workspaceId: workspace.workspace.id,
      },
    });
    const recipientTools = getMcpToolDefinitions(service, {
      agentApprovals: true,
      authContext: {
        approvalSecret: alice.member.approval_secret,
        authToken: alice.member.token,
        workspaceId: workspace.workspace.id,
      },
    });
    const askTool = senderTools.find((tool) => tool.name === 'relay_ask');
    const senderSendApprovedTool = senderTools.find((tool) => tool.name === 'relay_send_approved');
    const recipientReviewTool = recipientTools.find((tool) => tool.name === 'relay_review');
    const recipientHydrateApprovedTool = recipientTools.find(
      (tool) => tool.name === 'relay_hydrate_approved',
    );
    const replyTool = recipientTools.find((tool) => tool.name === 'relay_reply');
    const recipientSendApprovedTool = recipientTools.find(
      (tool) => tool.name === 'relay_send_approved',
    );
    const senderReviewTool = senderTools.find((tool) => tool.name === 'relay_review');
    const senderHydrateApprovedTool = senderTools.find(
      (tool) => tool.name === 'relay_hydrate_approved',
    );

    const draft = await askTool?.handler({
      to: '@alice',
      question: 'Can you inspect auth refresh?',
      title: 'Reply shortcut',
      summary: 'Need recipient context and reply.',
      sourceClient: 'codex',
    });
    await senderSendApprovedTool?.handler({ packetId: draft.id });
    await recipientReviewTool?.handler({ packetId: draft.id });
    await recipientHydrateApprovedTool?.handler({ packetId: draft.id, client: 'codex' });
    const reply = await replyTool?.handler({
      packetId: draft.id,
      answer: 'Persist the rotated token before retrying.',
      summary: 'Persistence order issue.',
      sourceClient: 'codex',
    });
    const approvedReply = await recipientSendApprovedTool?.handler({ packetId: reply.id });

    await expect(
      senderHydrateApprovedTool?.handler({ packetId: reply.id, client: 'codex' }),
    ).rejects.toThrow(/review/i);
    const reviewedReply = await senderReviewTool?.handler({ packetId: reply.id });
    const hydratedReply = await senderHydrateApprovedTool?.handler({
      packetId: reply.id,
      client: 'codex',
    });

    expect(approvedReply.packet.status).toBe('replied');
    expect(reviewedReply.packet.status).toBe('viewed');
    expect(hydratedReply.packet.status).toBe('hydrated');
    expect(hydratedReply.context).toContain('Persist the rotated token');
  });

  test('agent-confirmed MCP approval cannot override redaction blocks without a manual token', async () => {
    const { service } = createService();
    const workspace = service.createWorkspace({
      name: 'Redaction Override Team',
      adminHandle: 'sam',
      adminName: 'Sam',
    });
    const tools = getMcpToolDefinitions(service, {
      agentApprovals: true,
      authContext: {
        approvalSecret: workspace.admin.approval_secret,
        authToken: workspace.admin.token,
        workspaceId: workspace.workspace.id,
      },
    });
    const askTool = tools.find((tool) => tool.name === 'relay_ask');
    const approveTool = tools.find((tool) => tool.name === 'relay_approve');
    const draft = await askTool?.handler({
      to: '@sam',
      question: 'Can you review blocked evidence?',
      title: 'Blocked evidence',
      summary: 'This packet includes blocked evidence.',
      sourceClient: 'codex',
      evidence: [
        {
          kind: 'human_note',
          label: 'blocked secret',
          source: 'note',
          excerpt: 'API_KEY=sk-should-not-send-123456',
          sensitivity: 'secret_detected',
        },
      ],
    });

    expect(draft.packet.redaction_report.blocked).toBe(true);
    await expect(
      approveTool?.handler({ allowSecretOverride: true, packetId: draft.id }),
    ).rejects.toThrow(/manual/i);
    expect(service.getPacket(draft.id).status).toBe('pending_sender_approval');
  });

  test('agent-confirmed MCP approvals work through API-backed profiles', async () => {
    const { service } = createService();
    const api = await startApiForService(service);
    try {
      const client = new RelayApiClient({ serverUrl: api.serverUrl });
      const workspace = service.createWorkspace({
        name: 'Remote Agent Approval Team',
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
      const senderTools = getMcpToolDefinitions(client, {
        agentApprovals: true,
        authContext: {
          approvalSecret: workspace.admin.approval_secret,
          authToken: workspace.admin.token,
          workspaceId: workspace.workspace.id,
        },
      });
      const recipientTools = getMcpToolDefinitions(client, {
        agentApprovals: true,
        authContext: {
          approvalSecret: alice.member.approval_secret,
          authToken: alice.member.token,
          workspaceId: workspace.workspace.id,
        },
      });
      const askTool = senderTools.find((tool) => tool.name === 'relay_ask');
      const senderApproveTool = senderTools.find((tool) => tool.name === 'relay_approve');
      const viewTool = recipientTools.find((tool) => tool.name === 'relay_view');
      const acceptTool = recipientTools.find((tool) => tool.name === 'relay_accept');
      const hydrateTool = recipientTools.find((tool) => tool.name === 'relay_hydrate');
      const replyTool = recipientTools.find((tool) => tool.name === 'relay_reply');
      const recipientApproveTool = recipientTools.find((tool) => tool.name === 'relay_approve');

      const draft = await askTool?.handler({
        to: '@alice',
        question: 'Can you inspect remote approval?',
        title: 'Remote agent approval',
        summary: 'The API-backed MCP path should mint approval tokens.',
        sourceClient: 'codex',
      });
      const sent = await senderApproveTool?.handler({ packetId: draft.id });

      await viewTool?.handler({ packetId: draft.id });
      await acceptTool?.handler({ packetId: draft.id });
      const hydrated = await hydrateTool?.handler({ packetId: draft.id, client: 'codex' });
      const reply = await replyTool?.handler({
        packetId: draft.id,
        answer: 'Remote approval works.',
        summary: 'API-backed approval path is covered.',
        sourceClient: 'codex',
      });
      const approvedReply = await recipientApproveTool?.handler({ packetId: reply.id });

      expect(sent.packet.status).toBe('delivered');
      expect(hydrated.context).toContain('Can you inspect remote approval?');
      expect(approvedReply.packet.status).toBe('replied');
    } finally {
      await api.close();
    }
  });

  test('agent-confirmed MCP approvals require a profile approval secret', () => {
    const { service } = createService();
    const workspace = service.createWorkspace({
      name: 'Missing Secret Team',
      adminHandle: 'sam',
      adminName: 'Sam',
    });

    expect(() =>
      getMcpToolDefinitions(service, {
        agentApprovals: true,
        authContext: {
          authToken: workspace.admin.token,
          workspaceId: workspace.workspace.id,
        },
      }),
    ).toThrow(/profile approval secret/i);
    expect(() =>
      getMcpToolDefinitions(service, { agentApprovals: true, explicitAuth: true }),
    ).toThrow(/profile-backed MCP/i);
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
  test('root help describes everyday packet workflow commands', async () => {
    const help = await runCli(['--help']);

    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Draft a question packet for a teammate');
    expect(help.stdout).toContain('Draft a context-sharing packet for a');
    expect(help.stdout).toContain('List open packets sent to you');
    expect(help.stdout).toContain('Generate bounded context for your agent');
    expect(help.stdout).toContain('Draft a reply to an accepted or hydrated');
    expect(help.stdout).toContain('List audit receipts for the workspace');
  });

  test('grouped command help describes nested commands', async () => {
    const workspace = await runCli(['workspace', '--help']);
    const workspaceAlias = await runCli(['workspace', 'alias', '--help']);
    const member = await runCli(['member', '--help']);
    const server = await runCli(['server', '--help']);
    const demo = await runCli(['demo', '--help']);

    expect(workspace.code).toBe(0);
    expect(workspaceAlias.code).toBe(0);
    expect(member.code).toBe(0);
    expect(server.code).toBe(0);
    expect(demo.code).toBe(0);
    expect(workspace.stdout).toContain('Create a workspace and first admin member');
    expect(workspaceAlias.stdout).toContain('Map a repo alias to a canonical project name');
    expect(workspaceAlias.stdout).toContain('List configured project aliases');
    expect(member.stdout).toContain('Create an invite for a teammate handle');
    expect(member.stdout).toContain('Rotate the local approval secret');
    expect(server.stdout).toContain('Run the stdio MCP server');
    expect(demo.stdout).toContain('Run a local two-user ask/share demo');
  });

  test('packet command help describes token auth options', async () => {
    const commands = [
      'update-draft',
      'approve',
      'approval-token',
      'status',
      'view',
      'accept',
      'hydrate',
      'reply',
      'clarify',
      'answer-clarification',
      'decline',
      'archive',
      'close',
    ];
    for (const command of commands) {
      const help = await runCli([command, '--help']);

      expect(help.code).toBe(0);
      expect(help.stdout).toMatch(/--token <token>\s+Relay member token/);
    }
  });

  test('watch help documents desktop notifications as the default', async () => {
    const help = await runCli(['watch', '--help']);

    expect(help.code).toBe(0);
    expect(help.stdout).toContain('desktop notifications are enabled by default');
    expect(help.stdout).toContain('--no-desktop-notifications');
    expect(help.stdout).toContain('--desktop-notifications');
    expect(help.stdout).toContain('--background');
    expect(help.stdout).toContain('--status');
    expect(help.stdout).toContain('--stop');
  });

  test('server mcp forwards the agent approvals flag to startup', async () => {
    const calls: any[] = [];
    const program = new Command();
    const io = { writeErr: () => undefined, writeOut: () => undefined };
    program.exitOverride();
    program.configureOutput({
      writeErr: () => undefined,
      writeOut: () => undefined,
    });
    registerServerCommands(program, {
      io,
      startMcpServer: async (input) => {
        calls.push(input);
      },
    });

    await program.parseAsync(
      ['node', 'handoff', 'server', 'mcp', '--profile', 'default', '--agent-approvals'],
      { from: 'node' },
    );

    expect(calls).toEqual([
      expect.objectContaining({
        agentApprovals: true,
        dbPath: '.relay/relay.db',
        explicitAuth: undefined,
        profileName: 'default',
      }),
    ]);
  });

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

  test('polling watcher emits clarified parent redeliveries after the first notification was acked', async () => {
    const { service } = createService();
    const workspace = service.createWorkspace({
      name: 'Watch Team',
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
      question: 'Can you inspect the auth refresh test?',
      title: 'Auth refresh',
      summary: 'The integration test returns 401.',
      sourceClient: 'codex',
    });
    service.approveAndSend({
      authToken: workspace.admin.token,
      packetId: draft.id,
      approvalToken: service.createApprovalToken({
        authToken: workspace.admin.token,
        approvalSecret: workspace.admin.approval_secret,
        packetId: draft.id,
        action: 'send',
      }).approval_token,
    });

    const deliveredNotificationIds: string[] = [];
    const watcher = createPollingWatcher({
      poll: () =>
        service.listNotifications({
          authToken: alice.member.token,
          workspaceId: workspace.workspace.id,
        }),
      notify: (_message, summary) => {
        deliveredNotificationIds.push(summary.notification_id ?? '');
      },
      ack: (summary) => {
        if (!summary.notification_id) {
          throw new Error('Expected notification id.');
        }
        service.ackNotification({
          authToken: alice.member.token,
          notificationId: summary.notification_id,
        });
      },
    });

    await watcher.tick();
    await watcher.tick();
    service.viewPacket({ authToken: alice.member.token, packetId: draft.id });
    const clarification = service.requestClarification({
      authToken: alice.member.token,
      packetId: draft.id,
      question: 'Can you include the failing assertion?',
      requestedEvidence: ['test failure'],
    });
    service.answerClarification({
      authToken: workspace.admin.token,
      clarificationPacketId: clarification.id,
      answer: 'The failing assertion is expected 200 received 401.',
    });
    service.approveAndSend({
      authToken: workspace.admin.token,
      packetId: draft.id,
      approvalToken: service.createApprovalToken({
        authToken: workspace.admin.token,
        approvalSecret: workspace.admin.approval_secret,
        packetId: draft.id,
        action: 'send',
      }).approval_token,
    });
    await watcher.tick();
    watcher.stop();

    expect(deliveredNotificationIds).toHaveLength(2);
    expect(deliveredNotificationIds[1]).not.toBe(deliveredNotificationIds[0]);
  });

  test('polling watcher tolerates stale acks when clarification redelivery rotates the notification id', async () => {
    const { service } = createService();
    const workspace = service.createWorkspace({
      name: 'Watch Team',
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
      question: 'Can you inspect the auth refresh test?',
      title: 'Auth refresh',
      summary: 'The integration test returns 401.',
      sourceClient: 'codex',
    });
    service.approveAndSend({
      authToken: workspace.admin.token,
      packetId: draft.id,
      approvalToken: service.createApprovalToken({
        authToken: workspace.admin.token,
        approvalSecret: workspace.admin.approval_secret,
        packetId: draft.id,
        action: 'send',
      }).approval_token,
    });

    const deliveredNotificationIds: string[] = [];
    const watcher = createPollingWatcher({
      poll: () =>
        service.listNotifications({
          authToken: alice.member.token,
          workspaceId: workspace.workspace.id,
        }),
      notify: (_message, summary) => {
        deliveredNotificationIds.push(summary.notification_id ?? '');
        if (deliveredNotificationIds.length !== 1) {
          return;
        }
        service.viewPacket({ authToken: alice.member.token, packetId: draft.id });
        const clarification = service.requestClarification({
          authToken: alice.member.token,
          packetId: draft.id,
          question: 'Can you include the failing assertion?',
          requestedEvidence: ['test failure'],
        });
        service.answerClarification({
          authToken: workspace.admin.token,
          clarificationPacketId: clarification.id,
          answer: 'The failing assertion is expected 200 received 401.',
        });
        service.approveAndSend({
          authToken: workspace.admin.token,
          packetId: draft.id,
          approvalToken: service.createApprovalToken({
            authToken: workspace.admin.token,
            approvalSecret: workspace.admin.approval_secret,
            packetId: draft.id,
            action: 'send',
          }).approval_token,
        });
      },
      ack: (summary) => {
        if (!summary.notification_id) {
          throw new Error('Expected notification id.');
        }
        service.ackNotification({
          authToken: alice.member.token,
          notificationId: summary.notification_id,
        });
      },
    });

    await watcher.tick();
    await watcher.tick();
    watcher.stop();

    expect(deliveredNotificationIds).toHaveLength(2);
    expect(deliveredNotificationIds[1]).not.toBe(deliveredNotificationIds[0]);
  });

  test('polling watcher retries when notification delivery fails before ack', async () => {
    const notifications: string[] = [];
    let attempts = 0;
    let acked = 0;
    const watcher = createPollingWatcher({
      poll: () => [
        {
          notification_id: 'ntf_1',
          packet_id: 'pkt_1',
          packet_type: 'ask',
          title: 'Auth refresh',
          summary: 'Refresh returns 401.',
          sender_handle: 'sam',
          project: 'project-api',
        },
      ],
      notify: (message) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('desktop notification failed');
        }
        notifications.push(message);
      },
      ack: () => {
        acked += 1;
      },
    });

    await expect(watcher.tick()).rejects.toThrow(/desktop notification failed/);
    await watcher.tick();

    expect(attempts).toBe(2);
    expect(acked).toBe(1);
    expect(notifications).toEqual([
      '@sam is asking for help on Auth refresh in project-api. Review packet?',
    ]);
  });

  test('polling watcher retries when ack fails after local delivery', async () => {
    let attempts = 0;
    let ackAttempts = 0;
    const watcher = createPollingWatcher({
      poll: () => [
        {
          notification_id: 'ntf_1',
          packet_id: 'pkt_1',
          packet_type: 'share',
          title: 'Auth finding',
          summary: 'Refresh persistence ordering.',
          sender_handle: 'sam',
          project: 'project-api',
        },
      ],
      notify: () => {
        attempts += 1;
      },
      ack: () => {
        ackAttempts += 1;
        if (ackAttempts === 1) {
          throw new Error('ack failed');
        }
      },
    });

    await expect(watcher.tick()).rejects.toThrow(/ack failed/);
    await watcher.tick();

    expect(attempts).toBe(2);
    expect(ackAttempts).toBe(2);
  });

  test('background notification watcher records a detached profile watcher and reuses it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agent-relay-watch-'));
    const spawned: Array<{ args: string[]; command: string; options: any }> = [];
    const running = new Set<number>();
    const deps = {
      cliPath: '/tmp/handoff-cli.js',
      now: () => new Date('2026-01-02T03:04:05.000Z'),
      processIsRunning: (pid: number) => running.has(pid),
      spawnDetached: (command: string, args: string[], options: any) => {
        spawned.push({ command, args, options });
        running.add(4242);
        return { pid: 4242, unref: () => undefined };
      },
    };

    const first = await startBackgroundNotificationWatcher(
      {
        desktopNotifications: true,
        home,
        intervalMs: 5000,
        profileName: 'default',
      },
      deps,
    );
    const second = await startBackgroundNotificationWatcher(
      {
        desktopNotifications: true,
        home,
        intervalMs: 5000,
        profileName: 'default',
      },
      deps,
    );
    const status = await inspectBackgroundNotificationWatcher(
      { home, profileName: 'default' },
      deps,
    );

    expect(first.status).toBe('started');
    expect(second.status).toBe('already_running');
    expect(status.status).toBe('running');
    expect(spawned).toHaveLength(1);
    expect(spawned[0].command).toBe(process.execPath);
    expect(spawned[0].args).toEqual([
      '/tmp/handoff-cli.js',
      'watch',
      '--profile',
      'default',
      '--interval',
      '5000',
    ]);
    expect(spawned[0].options.env.HANDOFF_HOME).toBe(home);
    expect(first.metadata).toMatchObject({
      desktopNotifications: true,
      intervalMs: 5000,
      pid: 4242,
      profileName: 'default',
      startedAt: '2026-01-02T03:04:05.000Z',
    });
  });

  test('background notification watcher stop terminates and clears recorded metadata', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agent-relay-watch-'));
    let running = true;
    const deps = {
      cliPath: '/tmp/handoff-cli.js',
      now: () => new Date('2026-01-02T03:04:05.000Z'),
      processIsRunning: () => running,
      spawnDetached: () => ({ pid: 4243, unref: () => undefined }),
      killProcess: () => {
        running = false;
      },
      waitForExit: async () => true,
    };

    await startBackgroundNotificationWatcher(
      {
        desktopNotifications: false,
        home,
        intervalMs: 5000,
        profileName: 'default',
      },
      deps,
    );
    const stopped = await stopBackgroundNotificationWatcher({ home, profileName: 'default' }, deps);
    const status = await inspectBackgroundNotificationWatcher(
      { home, profileName: 'default' },
      deps,
    );

    expect(stopped.status).toBe('stopped');
    expect(status.status).toBe('not_found');
  });

  test('watch --background fails before recording when the stored profile is unreachable', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agent-relay-watch-'));
    const store = createProfileStore({ home });
    const createdAt = new Date('2026-01-02T03:04:05.000Z').toISOString();
    store.saveProfile({
      schemaVersion: 1,
      profileName: 'default',
      workspaceId: 'wrk_dead',
      workspaceName: 'Unreachable Team',
      memberId: 'mem_dead',
      handle: 'alice',
      displayName: 'Alice',
      role: 'member',
      serverUrl: 'http://127.0.0.1:1',
      serverMode: 'remote',
      createdAt,
      lastVerifiedAt: createdAt,
    });
    store.saveCredentials('default', {
      memberToken: 'relay_member_dead',
      approvalSecret: 'relay_approval_dead',
      createdAt,
    });
    const previousHome = process.env.HOME;
    const previousHandoffHome = process.env.HANDOFF_HOME;
    try {
      process.env.HOME = home;
      process.env.HANDOFF_HOME = home;

      const result = await runCli(['watch', '--background']);
      const status = await inspectBackgroundNotificationWatcher({ home, profileName: 'default' });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('SERVER_UNAVAILABLE');
      expect(status.status).toBe('not_found');
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousHandoffHome === undefined) delete process.env.HANDOFF_HOME;
      else process.env.HANDOFF_HOME = previousHandoffHome;
    }
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
        '--no-desktop-notifications',
        '--once',
      ]);

      expect(watch.stderr).toContain('@sam is asking for help');
      expect(webhook.deliveries).toHaveLength(1);
      expect(webhook.deliveries[0].body).toMatchObject({
        event: 'relay.notification',
        notification_id: expect.stringMatching(/^ntf_/),
        packet_id: draft.id,
        title: 'Auth refresh',
        project: 'unknown-project',
      });

      const repeatedWatch = await runCli([
        'watch',
        '--server-url',
        serverUrl,
        '--token',
        alice.member.token,
        '--workspace',
        workspace.workspace.id,
        '--webhook-url',
        webhook.url,
        '--no-desktop-notifications',
        '--once',
      ]);

      expect(repeatedWatch.stderr).not.toContain('@sam is asking for help');
      expect(webhook.deliveries).toHaveLength(1);
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
    expect(parsed.sender.token).toBe('[redacted]');
    expect(parsed.sender.approval_secret).toBe('[redacted]');
    expect(parsed.sender.credentials_redacted).toBe(true);
    expect(parsed.recipient.token).toBe('[redacted]');
    expect(parsed.recipient.approval_secret).toBe('[redacted]');
    expect(parsed.recipient.credentials_redacted).toBe(true);
    expect(result.stdout).not.toContain('relay_member_');
    expect(result.stdout).not.toContain('relay_approval_secret_');
  });

  test('launch assets include a short-video recording demo script', () => {
    const scriptPath = join(process.cwd(), 'docs', 'demo-video-script.md');
    expect(existsSync(scriptPath)).toBe(true);
    const script = readFileSync(scriptPath, 'utf8');
    expect(script).toContain('npx -y handoff-relay demo two-user');
    expect(script.toLowerCase()).toContain('record');
  });
});
