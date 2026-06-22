import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import { isRelayError } from '../errors.js';
import { packetStatuses } from '../protocol/schema.js';
import { RelayService } from '../service/relay-service.js';
import { createRelayDatabase } from '../storage/database.js';

const sourceClients = ['claude-code', 'codex', 'cursor', 'generic', 'other'] as const;

export interface ApiServerOptions {
  service: RelayService;
}

function bearer(request: { headers: Record<string, unknown> }): string {
  const value = request.headers.authorization;
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) {
    return '';
  }
  return value.slice('Bearer '.length);
}

export function buildApiServer(options: ApiServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const service = options.service;
  const packetQuerySchema = {
    project: z.string().optional(),
    sender: z.string().optional(),
    recipient: z.string().optional(),
    status: z.enum(packetStatuses).optional(),
    fileOrSymbol: z.string().optional(),
    ticketOrPr: z.string().optional(),
  };

  app.get('/health', async () => ({
    name: 'handoff',
    ok: true,
    pid: process.pid,
    server_id: process.env.HANDOFF_SERVER_ID,
    version: '0.1.3',
  }));

  app.setErrorHandler((error, _request, reply) => {
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
        message: error instanceof Error ? error.message : 'Unknown internal error.',
      },
    });
  });

  app.post('/workspaces', async (request) => {
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
    const body = z.object({ displayName: z.string() }).parse(request.body);
    return service.acceptInvite({ inviteToken: params.inviteToken, displayName: body.displayName });
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
    const body = z
      .object({
        workspaceId: z.string(),
        to: z.string(),
        question: z.string(),
        title: z.string(),
        summary: z.string(),
        sourceClient: z.enum(sourceClients).default('generic'),
        project: z.record(z.string(), z.unknown()).optional(),
        claims: z.array(z.record(z.string(), z.unknown())).optional(),
        evidence: z.array(z.record(z.string(), z.unknown())).optional(),
        filesOrSymbols: z.array(z.string()).optional(),
        commandsOrTestsRun: z.array(z.string()).optional(),
        whatWasTried: z.array(z.string()).optional(),
        knownFailures: z.array(z.string()).optional(),
        currentHypothesis: z.string().optional(),
        confidence: z.enum(['low', 'medium', 'high']).optional(),
        suggestedNextSteps: z.array(z.string()).optional(),
      })
      .parse(request.body);
    return service.createAskDraft({
      authToken: bearer(request),
      workspaceId: body.workspaceId,
      to: body.to,
      question: body.question,
      title: body.title,
      summary: body.summary,
      sourceClient: body.sourceClient,
      project: body.project as any,
      claims: body.claims as any,
      evidence: body.evidence as any,
      filesOrSymbols: body.filesOrSymbols,
      commandsOrTestsRun: body.commandsOrTestsRun,
      whatWasTried: body.whatWasTried,
      knownFailures: body.knownFailures,
      currentHypothesis: body.currentHypothesis,
      confidence: body.confidence,
      suggestedNextSteps: body.suggestedNextSteps,
    });
  });

  app.post('/packets/share', async (request) => {
    const body = z
      .object({
        workspaceId: z.string(),
        to: z.string(),
        finding: z.string(),
        title: z.string(),
        summary: z.string(),
        sourceClient: z.enum(sourceClients).default('generic'),
        project: z.record(z.string(), z.unknown()).optional(),
        claims: z.array(z.record(z.string(), z.unknown())).optional(),
        evidence: z.array(z.record(z.string(), z.unknown())).optional(),
        filesOrSymbols: z.array(z.string()).optional(),
        commandsOrTestsRun: z.array(z.string()).optional(),
        whatWasTried: z.array(z.string()).optional(),
        knownFailures: z.array(z.string()).optional(),
        currentHypothesis: z.string().optional(),
        confidence: z.enum(['low', 'medium', 'high']).optional(),
        suggestedNextSteps: z.array(z.string()).optional(),
      })
      .parse(request.body);
    return service.createShareDraft({
      authToken: bearer(request),
      workspaceId: body.workspaceId,
      to: body.to,
      finding: body.finding,
      title: body.title,
      summary: body.summary,
      sourceClient: body.sourceClient,
      project: body.project as any,
      claims: body.claims as any,
      evidence: body.evidence as any,
      filesOrSymbols: body.filesOrSymbols,
      commandsOrTestsRun: body.commandsOrTestsRun,
      whatWasTried: body.whatWasTried,
      knownFailures: body.knownFailures,
      currentHypothesis: body.currentHypothesis,
      confidence: body.confidence,
      suggestedNextSteps: body.suggestedNextSteps,
    });
  });

  app.patch('/packets/:packetId/draft', async (request) => {
    const params = z.object({ packetId: z.string() }).parse(request.params);
    const body = z
      .object({
        title: z.string().optional(),
        summary: z.string().optional(),
        question: z.string().optional(),
        finding: z.string().optional(),
        claims: z.array(z.record(z.string(), z.unknown())).optional(),
        evidence: z.array(z.record(z.string(), z.unknown())).optional(),
        filesOrSymbols: z.array(z.string()).optional(),
        commandsOrTestsRun: z.array(z.string()).optional(),
        whatWasTried: z.array(z.string()).optional(),
        knownFailures: z.array(z.string()).optional(),
        currentHypothesis: z.string().optional(),
        confidence: z.enum(['low', 'medium', 'high']).optional(),
        suggestedNextSteps: z.array(z.string()).optional(),
      })
      .parse(request.body);
    return service.updateDraft({
      authToken: bearer(request),
      packetId: params.packetId,
      title: body.title,
      summary: body.summary,
      question: body.question,
      finding: body.finding,
      claims: body.claims as any,
      evidence: body.evidence as any,
      filesOrSymbols: body.filesOrSymbols,
      commandsOrTestsRun: body.commandsOrTestsRun,
      whatWasTried: body.whatWasTried,
      knownFailures: body.knownFailures,
      currentHypothesis: body.currentHypothesis,
      confidence: body.confidence,
      suggestedNextSteps: body.suggestedNextSteps,
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

  app.get('/packets/:packetId/view', async (request) => {
    const params = z.object({ packetId: z.string() }).parse(request.params);
    return service.viewPacket({ authToken: bearer(request), packetId: params.packetId });
  });

  app.get('/packets/:packetId/status', async (request) => {
    const params = z.object({ packetId: z.string() }).parse(request.params);
    return service.getPacketForMember({ authToken: bearer(request), packetId: params.packetId });
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
    const body = z
      .object({
        answer: z.string(),
        summary: z.string(),
        sourceClient: z.enum(sourceClients).default('generic'),
        evidence: z.array(z.record(z.string(), z.unknown())).optional(),
        confidence: z.enum(['low', 'medium', 'high']).optional(),
      })
      .parse(request.body);
    return service.createReplyDraft({
      authToken: bearer(request),
      packetId: params.packetId,
      answer: body.answer,
      summary: body.summary,
      sourceClient: body.sourceClient,
      evidence: body.evidence as any,
      confidence: body.confidence,
    });
  });

  app.post('/packets/:packetId/clarify', async (request) => {
    const params = z.object({ packetId: z.string() }).parse(request.params);
    const body = z
      .object({
        question: z.string(),
        requestedEvidence: z.array(z.string()).optional(),
      })
      .parse(request.body);
    return service.requestClarification({
      authToken: bearer(request),
      packetId: params.packetId,
      question: body.question,
      requestedEvidence: body.requestedEvidence,
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
      .object({ workspaceId: z.string(), q: z.string().optional(), ...packetQuerySchema })
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
    });
  });

  app.get('/history', async (request) => {
    const query = z
      .object({
        workspaceId: z.string(),
        filter: z.enum(['all', 'drafts', 'sent', 'open', 'closed']).optional(),
        q: z.string().optional(),
        ...packetQuerySchema,
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
  const app = buildApiServer({ service });
  await app.listen({ host: input.host ?? '127.0.0.1', port: input.port ?? 3737 });
  return app;
}
