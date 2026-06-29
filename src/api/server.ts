import { createHash, timingSafeEqual } from 'node:crypto';

import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import { buildHandoffAgentCard } from '../a2a/handoff-mapping.js';
import {
  A2A_AGENT_CARD_PATH,
  A2A_DISABLED_REASON,
  A2A_INVALID_REQUEST_CODE,
  A2A_INVALID_REQUEST_REASON,
  A2A_JSON_MEDIA_TYPE,
  A2A_METHOD_NOT_FOUND_CODE,
  A2A_METHOD_NOT_FOUND_REASON,
  A2A_NOT_IMPLEMENTED_REASON,
  A2A_PARSE_ERROR_CODE,
  A2A_PARSE_ERROR_REASON,
  A2A_RECEIVE_METHODS,
  A2A_RECEIVE_PATH,
  A2A_RECEIVE_UNAVAILABLE_CODE,
} from '../a2a/schema.js';
import { isRelayError, relayError } from '../errors.js';
import {
  answerClarificationInputSchema,
  askDraftInputSchema,
  clarificationRequestInputSchema,
  packetQueryInputShape,
  replyDraftInputSchema,
  shareDraftInputSchema,
  sourceClients,
  updateDraftInputSchema,
} from '../protocol/inputs.js';
import { runtimeVersion } from '../runtime/version.js';
import { RelayService } from '../service/relay-service.js';
import { createRelayDatabase } from '../storage/database.js';
import { databaseIdForPath } from '../storage/database-id.js';

export interface ApiServerOptions {
  allowPublicWorkspaceBootstrap?: boolean;
  bindHost?: string;
  databaseId?: string;
  service: RelayService;
  workspaceBootstrapToken?: string;
}

function bearer(request: { headers: Record<string, unknown> }): string {
  const value = request.headers.authorization;
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) {
    return '';
  }
  return value.slice('Bearer '.length);
}

function a2aReceivingEnabled(): boolean {
  return process.env.HANDOFF_ENABLE_A2A === '1';
}

const GENERIC_INTERNAL_ERROR_MESSAGE = 'Unexpected internal server error.';
const PUBLIC_WORKSPACE_BOOTSTRAP_MESSAGE =
  'Workspace bootstrap is disabled on non-loopback API listeners unless explicitly allowed.';
const A2A_SUPPORTED_METHODS = new Set<string>(A2A_RECEIVE_METHODS);
const A2A_REQUEST_SCHEMA = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.unknown().optional(),
    method: z.string().min(1),
  })
  .passthrough();

function a2aJsonRpcError(input: { id: unknown; code: number; message: string; reason: string }) {
  return {
    jsonrpc: '2.0',
    id: input.id ?? null,
    error: {
      code: input.code,
      message: input.message,
      data: [
        {
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          reason: input.reason,
          domain: 'handoff-relay',
        },
      ],
    },
  };
}

function isA2aReceiveRequest(request: { method: string; url: string }): boolean {
  return request.method === 'POST' && request.url.split('?')[0] === A2A_RECEIVE_PATH;
}

function isLoopbackHost(host: string | undefined): boolean {
  return host === undefined || host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function isPublicApiBindHost(host: string | undefined): boolean {
  return !isLoopbackHost(host);
}

function effectiveBindHost(app: FastifyInstance, options: ApiServerOptions): string | undefined {
  if (options.bindHost) return options.bindHost;
  const addresses = app.addresses();
  return (
    addresses.find((address) => isPublicApiBindHost(address.address))?.address ??
    addresses[0]?.address
  );
}

function envFlag(name: string): boolean {
  return process.env[name] === '1';
}

function configuredWorkspaceBootstrapToken(options: ApiServerOptions): string | undefined {
  return (
    options.workspaceBootstrapToken ??
    process.env.HANDOFF_WORKSPACE_BOOTSTRAP_TOKEN ??
    process.env.HANDOFF_BOOTSTRAP_TOKEN
  );
}

function publicWorkspaceBootstrapAllowed(options: ApiServerOptions): boolean {
  return (
    options.allowPublicWorkspaceBootstrap === true ||
    envFlag('HANDOFF_ALLOW_PUBLIC_WORKSPACE_BOOTSTRAP')
  );
}

function headerString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.find((entry): entry is string => typeof entry === 'string') ?? '';
  }
  return '';
}

function workspaceBootstrapToken(request: { headers: Record<string, unknown> }): string {
  return headerString(request.headers['x-handoff-bootstrap-token']) || bearer(request);
}

function secureTokenEquals(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function workspaceBootstrapRequestAllowed(
  request: { headers: Record<string, unknown> },
  options: ApiServerOptions,
  bindHost: string | undefined,
): boolean {
  if (!isPublicApiBindHost(bindHost)) return true;
  if (publicWorkspaceBootstrapAllowed(options)) return true;
  const expectedToken = configuredWorkspaceBootstrapToken(options);
  return Boolean(
    expectedToken && secureTokenEquals(workspaceBootstrapToken(request), expectedToken),
  );
}

function ifNoneMatchMatches(value: unknown, etag: string): boolean {
  const values: string[] = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : typeof value === 'string'
      ? [value]
      : [];
  return values.some((entry) =>
    entry
      .split(',')
      .map((tag) => tag.trim())
      .some((tag) => tag === '*' || tag === etag),
  );
}

export function buildApiServer(options: ApiServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const service = options.service;

  app.addContentTypeParser(A2A_JSON_MEDIA_TYPE, { parseAs: 'string' }, (_request, body, done) => {
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (error) {
      done(error as Error);
    }
  });

  app.get('/health', async () => ({
    name: 'handoff',
    ok: true,
    bind_host: options.bindHost,
    database_id: options.databaseId,
    pid: process.pid,
    server_id: process.env.HANDOFF_SERVER_ID,
    version: runtimeVersion,
  }));

  app.get(A2A_AGENT_CARD_PATH, async (request, reply) => {
    const card = buildHandoffAgentCard({
      version: runtimeVersion,
      publicA2aEnabled: a2aReceivingEnabled(),
    });
    const etag = `"sha256-${createHash('sha256').update(JSON.stringify(card)).digest('hex')}"`;
    reply.type(A2A_JSON_MEDIA_TYPE);
    reply.header('cache-control', 'public, max-age=300, must-revalidate');
    reply.header('etag', etag);
    if (ifNoneMatchMatches(request.headers['if-none-match'], etag)) {
      reply.status(304).send();
      return;
    }
    return card;
  });

  app.post(A2A_RECEIVE_PATH, async (request, reply) => {
    const body = A2A_REQUEST_SCHEMA.parse(request.body ?? {});
    reply.type(A2A_JSON_MEDIA_TYPE);
    if (body.method && !A2A_SUPPORTED_METHODS.has(body.method)) {
      reply.status(200).send(
        a2aJsonRpcError({
          id: body.id,
          code: A2A_METHOD_NOT_FOUND_CODE,
          message: 'A2A method is not supported by this Handoff release.',
          reason: A2A_METHOD_NOT_FOUND_REASON,
        }),
      );
      return;
    }
    if (!a2aReceivingEnabled()) {
      reply.status(200).send(
        a2aJsonRpcError({
          id: body.id,
          code: A2A_RECEIVE_UNAVAILABLE_CODE,
          message: 'Public A2A receiving is disabled for this Handoff server.',
          reason: A2A_DISABLED_REASON,
        }),
      );
      return;
    }
    reply.status(200).send(
      a2aJsonRpcError({
        id: body.id,
        code: A2A_RECEIVE_UNAVAILABLE_CODE,
        message: 'Public A2A receiving is not implemented in this release.',
        reason: A2A_NOT_IMPLEMENTED_REASON,
      }),
    );
  });

  app.setErrorHandler((error, request, reply) => {
    if (isA2aReceiveRequest(request)) {
      reply.type(A2A_JSON_MEDIA_TYPE);
      if (error instanceof z.ZodError) {
        reply.status(200).send(
          a2aJsonRpcError({
            id: null,
            code: A2A_INVALID_REQUEST_CODE,
            message: 'Invalid A2A JSON-RPC request.',
            reason: A2A_INVALID_REQUEST_REASON,
          }),
        );
        return;
      }
      reply.status(200).send(
        a2aJsonRpcError({
          id: null,
          code: A2A_PARSE_ERROR_CODE,
          message: 'Malformed A2A JSON payload.',
          reason: A2A_PARSE_ERROR_REASON,
        }),
      );
      return;
    }
    if (isRelayError(error)) {
      reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      });
      return;
    }
    if (error instanceof z.ZodError) {
      const unsupportedClient = error.issues.some((issue) =>
        issue.path.some((segment) => segment === 'sourceClient'),
      );
      reply.status(400).send({
        error: unsupportedClient
          ? {
              code: 'UNSUPPORTED_CLIENT',
              message: `Unsupported source client. Supported clients: ${sourceClients.join(', ')}.`,
              details: { issues: error.issues },
            }
          : {
              code: 'INVALID_INPUT',
              message: 'Invalid Relay API request.',
              details: { issues: error.issues },
            },
      });
      return;
    }
    reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: GENERIC_INTERNAL_ERROR_MESSAGE,
      },
    });
  });

  app.post('/workspaces', async (request) => {
    if (!workspaceBootstrapRequestAllowed(request, options, effectiveBindHost(app, options))) {
      throw relayError('AUTH_REQUIRED', PUBLIC_WORKSPACE_BOOTSTRAP_MESSAGE, 401);
    }
    const body = z
      .object({
        name: z.string(),
        adminHandle: z.string(),
        adminName: z.string(),
        adminBodyAccess: z.boolean().optional(),
      })
      .parse(request.body);
    return service.createWorkspace(body);
  });

  app.post('/workspaces/:workspaceId/invites', async (request) => {
    const params = z.object({ workspaceId: z.string() }).parse(request.params);
    const body = z.object({ handle: z.string() }).parse(request.body);
    return service.inviteMember({
      adminToken: bearer(request),
      workspaceId: params.workspaceId,
      handle: body.handle,
    });
  });

  app.post('/invites/:inviteToken/accept', async (request) => {
    const params = z.object({ inviteToken: z.string() }).parse(request.params);
    const body = z
      .object({ displayName: z.string(), idempotencyKey: z.string().optional() })
      .parse(request.body);
    return service.acceptInvite({
      inviteToken: params.inviteToken,
      displayName: body.displayName,
      idempotencyKey: body.idempotencyKey,
    });
  });

  app.get('/invites/:inviteToken', async (request) => {
    const params = z.object({ inviteToken: z.string() }).parse(request.params);
    return service.getInvite({ inviteToken: params.inviteToken });
  });

  app.get('/invite/:inviteToken', async (request, reply) => {
    const params = z.object({ inviteToken: z.string() }).parse(request.params);
    const invite = service.getInvite({ inviteToken: params.inviteToken });
    const host = request.headers.host ?? '127.0.0.1:3737';
    const protocol =
      typeof request.headers['x-forwarded-proto'] === 'string'
        ? request.headers['x-forwarded-proto']
        : 'http';
    const link = `${protocol}://${host}/invite/${encodeURIComponent(params.inviteToken)}`;
    const joinCommand = `npx -y handoff-relay join ${link}`;
    let status = `Invite for @${invite.invite.handle} to join ${invite.workspace.name}.`;
    if (invite.invite.accepted_at) {
      status = `Invite for @${invite.invite.handle} has already been accepted.`;
    } else if (Date.parse(invite.invite.expires_at) < Date.now()) {
      status = `Invite for @${invite.invite.handle} has expired.`;
    }
    reply
      .type('text/plain')
      .send(
        [
          'Handoff invite',
          '',
          status,
          `Expires: ${invite.invite.expires_at}`,
          '',
          'Join with:',
          joinCommand,
          '',
          'Opening this page does not accept the invite.',
        ].join('\n'),
      );
  });

  app.get('/members', async (request) => {
    const query = z.object({ workspaceId: z.string() }).parse(request.query);
    return service.listMembers({ authToken: bearer(request), workspaceId: query.workspaceId });
  });

  app.post('/workspaces/:workspaceId/project-aliases', async (request) => {
    const params = z.object({ workspaceId: z.string() }).parse(request.params);
    const body = z.object({ canonicalProject: z.string(), alias: z.string() }).parse(request.body);
    return service.configureProjectAlias({
      authToken: bearer(request),
      workspaceId: params.workspaceId,
      canonicalProject: body.canonicalProject,
      alias: body.alias,
    });
  });

  app.get('/workspaces/:workspaceId/project-aliases', async (request) => {
    const params = z.object({ workspaceId: z.string() }).parse(request.params);
    return service.listProjectAliases({
      authToken: bearer(request),
      workspaceId: params.workspaceId,
    });
  });

  app.post('/members/:memberId/revoke', async (request) => {
    const params = z.object({ memberId: z.string() }).parse(request.params);
    const body = z.object({ workspaceId: z.string() }).parse(request.body);
    return service.revokeMember({
      adminToken: bearer(request),
      workspaceId: body.workspaceId,
      memberId: params.memberId,
    });
  });

  app.post('/members/remove', async (request) => {
    const body = z.object({ workspaceId: z.string(), member: z.string() }).parse(request.body);
    return service.removeMember({
      adminToken: bearer(request),
      workspaceId: body.workspaceId,
      member: body.member,
    });
  });

  app.post('/members/me/leave', async (request) => {
    const body = z.object({ workspaceId: z.string() }).parse(request.body);
    return service.leaveWorkspace({
      authToken: bearer(request),
      workspaceId: body.workspaceId,
    });
  });

  app.post('/members/rotate-token', async (request) => {
    return service.rotateMemberToken({ authToken: bearer(request) });
  });

  app.post('/members/rotate-approval-secret', async (request) => {
    const body = z.object({ approvalSecret: z.string().optional() }).parse(request.body ?? {});
    return service.rotateApprovalSecret({
      authToken: bearer(request),
      approvalSecret: body.approvalSecret,
    });
  });

  app.post('/packets/ask', async (request) => {
    const body = askDraftInputSchema.parse(request.body);
    return service.createAskDraft({ authToken: bearer(request), ...body });
  });

  app.post('/packets/share', async (request) => {
    const body = shareDraftInputSchema.parse(request.body);
    return service.createShareDraft({ authToken: bearer(request), ...body });
  });

  app.patch('/packets/:packetId/draft', async (request) => {
    const params = z.object({ packetId: z.string() }).parse(request.params);
    const body = updateDraftInputSchema.parse(request.body);
    return service.updateDraft({
      authToken: bearer(request),
      packetId: params.packetId,
      ...body,
    });
  });

  app.post('/packets/:packetId/approval-token', async (request) => {
    const params = z.object({ packetId: z.string() }).parse(request.params);
    const body = z
      .object({
        action: z.enum(['send', 'reply', 'hydrate']),
        approvalSecret: z.string().optional(),
      })
      .parse(request.body);
    return service.createApprovalToken({
      authToken: bearer(request),
      approvalSecret: body.approvalSecret,
      packetId: params.packetId,
      action: body.action,
    });
  });

  app.post('/packets/:packetId/approve', async (request) => {
    const params = z.object({ packetId: z.string() }).parse(request.params);
    const body = z
      .object({ allowSecretOverride: z.boolean().optional(), approvalToken: z.string().optional() })
      .parse(request.body ?? {});
    return service.approveAndSend({
      authToken: bearer(request),
      packetId: params.packetId,
      allowSecretOverride: body.allowSecretOverride,
      approvalToken: body.approvalToken,
    });
  });

  app.get('/inbox', async (request) => {
    const query = z.object({ workspaceId: z.string() }).parse(request.query);
    return service.listInbox({ authToken: bearer(request), workspaceId: query.workspaceId });
  });

  app.get('/notifications', async (request) => {
    const query = z.object({ workspaceId: z.string() }).parse(request.query);
    return service.listNotifications({
      authToken: bearer(request),
      workspaceId: query.workspaceId,
    });
  });

  app.post('/notifications/:notificationId/ack', async (request) => {
    const params = z.object({ notificationId: z.string() }).parse(request.params);
    return service.ackNotification({
      authToken: bearer(request),
      notificationId: params.notificationId,
    });
  });

  app.get('/packets/:packetId/view', async (request) => {
    const params = z.object({ packetId: z.string() }).parse(request.params);
    return service.viewPacket({ authToken: bearer(request), packetId: params.packetId });
  });

  app.get('/packets/:packetId/status', async (request) => {
    const params = z.object({ packetId: z.string() }).parse(request.params);
    return service.getPacketForMember({ authToken: bearer(request), packetId: params.packetId });
  });

  app.get('/_diagnostics/a2a/packets/:packetId/transport', async (request) => {
    const params = z.object({ packetId: z.string() }).parse(request.params);
    return {
      transport:
        service.getPacketTransport({
          authToken: bearer(request),
          packetId: params.packetId,
        }) ?? null,
    };
  });

  app.post('/packets/:packetId/accept', async (request) => {
    const params = z.object({ packetId: z.string() }).parse(request.params);
    return service.acceptPacket({ authToken: bearer(request), packetId: params.packetId });
  });

  app.post('/packets/:packetId/hydrate', async (request) => {
    const params = z.object({ packetId: z.string() }).parse(request.params);
    const body = z
      .object({
        client: z.string().default('generic'),
        sessionId: z.string().optional(),
        approvalToken: z.string().optional(),
      })
      .parse(request.body ?? {});
    return service.hydratePacket({
      authToken: bearer(request),
      packetId: params.packetId,
      client: body.client,
      sessionId: body.sessionId,
      approvalToken: body.approvalToken,
    });
  });

  app.post('/packets/:packetId/reply', async (request) => {
    const params = z.object({ packetId: z.string() }).parse(request.params);
    const body = replyDraftInputSchema.parse(request.body);
    return service.createReplyDraft({
      authToken: bearer(request),
      packetId: params.packetId,
      ...body,
    });
  });

  app.post('/packets/:packetId/clarify', async (request) => {
    const params = z.object({ packetId: z.string() }).parse(request.params);
    const body = clarificationRequestInputSchema.parse(request.body);
    return service.requestClarification({
      authToken: bearer(request),
      packetId: params.packetId,
      ...body,
    });
  });

  app.post('/packets/:packetId/answer-clarification', async (request) => {
    const params = z.object({ packetId: z.string() }).parse(request.params);
    const body = answerClarificationInputSchema.parse(request.body);
    return service.answerClarification({
      authToken: bearer(request),
      clarificationPacketId: params.packetId,
      ...body,
    });
  });

  app.post('/packets/:packetId/decline', async (request) => {
    const params = z.object({ packetId: z.string() }).parse(request.params);
    const body = z.object({ reason: z.string().optional() }).parse(request.body ?? {});
    return service.declinePacket({
      authToken: bearer(request),
      packetId: params.packetId,
      reason: body.reason,
    });
  });

  app.post('/packets/:packetId/archive', async (request) => {
    const params = z.object({ packetId: z.string() }).parse(request.params);
    return service.archivePacket({ authToken: bearer(request), packetId: params.packetId });
  });

  app.post('/packets/:packetId/close', async (request) => {
    const params = z.object({ packetId: z.string() }).parse(request.params);
    const body = z.object({ resolution: z.enum(['resolved', 'unresolved']) }).parse(request.body);
    return service.closePacket({
      authToken: bearer(request),
      packetId: params.packetId,
      resolution: body.resolution,
    });
  });

  app.get('/search', async (request) => {
    const query = z
      .object({ workspaceId: z.string(), q: z.string().optional(), ...packetQueryInputShape })
      .parse(request.query);
    return service.searchPackets({
      authToken: bearer(request),
      workspaceId: query.workspaceId,
      query: query.q,
      project: query.project,
      sender: query.sender,
      recipient: query.recipient,
      status: query.status,
      fileOrSymbol: query.fileOrSymbol,
      ticketOrPr: query.ticketOrPr,
      limit: query.limit,
      offset: query.offset,
    });
  });

  app.get('/history', async (request) => {
    const query = z
      .object({
        workspaceId: z.string(),
        filter: z.enum(['all', 'drafts', 'sent', 'open', 'closed']).optional(),
        q: z.string().optional(),
        ...packetQueryInputShape,
      })
      .parse(request.query);
    return service.listHistory({
      authToken: bearer(request),
      workspaceId: query.workspaceId,
      filter: query.filter,
      query: query.q,
      project: query.project,
      sender: query.sender,
      recipient: query.recipient,
      status: query.status,
      fileOrSymbol: query.fileOrSymbol,
      ticketOrPr: query.ticketOrPr,
      limit: query.limit,
      offset: query.offset,
    });
  });

  app.get('/audit', async (request) => {
    const query = z
      .object({ workspaceId: z.string(), packetId: z.string().optional() })
      .parse(request.query);
    return service.listAuditReceipts({
      authToken: bearer(request),
      workspaceId: query.workspaceId,
      packetId: query.packetId,
    });
  });

  return app;
}

export async function startApiServer(input: {
  dbPath: string;
  host?: string;
  port?: number;
}): Promise<FastifyInstance> {
  const service = new RelayService(createRelayDatabase(input.dbPath));
  const host = input.host ?? '127.0.0.1';
  const app = buildApiServer({
    service,
    bindHost: host,
    databaseId: databaseIdForPath(input.dbPath),
    allowPublicWorkspaceBootstrap: envFlag('HANDOFF_ALLOW_PUBLIC_WORKSPACE_BOOTSTRAP'),
    workspaceBootstrapToken:
      process.env.HANDOFF_WORKSPACE_BOOTSTRAP_TOKEN ?? process.env.HANDOFF_BOOTSTRAP_TOKEN,
  });
  await app.listen({ host, port: input.port ?? 3737 });
  return app;
}
