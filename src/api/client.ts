import { RelayError } from '../errors.js';
import type {
  ApprovalAction,
  HistoryFilter,
  PacketQueryFilters,
} from '../service/relay-service.js';

export interface RelayApiClientOptions {
  serverUrl: string;
}

type JsonObject = Record<string, unknown>;

export class RelayApiClient {
  private readonly serverUrl: string;

  constructor(options: RelayApiClientOptions) {
    this.serverUrl = options.serverUrl.replace(/\/+$/, '');
  }

  async createWorkspace(input: {
    name: string;
    adminHandle: string;
    adminName: string;
    adminBodyAccess?: boolean;
  }) {
    return this.request('/workspaces', { method: 'POST', body: input });
  }

  async inviteMember(input: { adminToken: string; workspaceId: string; handle: string }) {
    return this.request(`/workspaces/${input.workspaceId}/invites`, {
      method: 'POST',
      token: input.adminToken,
      body: { handle: input.handle },
    });
  }

  async acceptInvite(input: { inviteToken: string; displayName: string; idempotencyKey?: string }) {
    return this.request(`/invites/${input.inviteToken}/accept`, {
      method: 'POST',
      body: { displayName: input.displayName, idempotencyKey: input.idempotencyKey },
    });
  }

  async getInvite(input: { inviteToken: string }) {
    return this.request(`/invites/${input.inviteToken}`);
  }

  async listMembers(input: { authToken: string; workspaceId: string }) {
    return this.request(`/members?workspaceId=${encodeURIComponent(input.workspaceId)}`, {
      token: input.authToken,
    });
  }

  async configureProjectAlias(input: {
    authToken: string;
    workspaceId: string;
    canonicalProject: string;
    alias: string;
  }) {
    return this.request(`/workspaces/${input.workspaceId}/project-aliases`, {
      method: 'POST',
      token: input.authToken,
      body: { canonicalProject: input.canonicalProject, alias: input.alias },
    });
  }

  async listProjectAliases(input: { authToken: string; workspaceId: string }) {
    return this.request(`/workspaces/${input.workspaceId}/project-aliases`, {
      token: input.authToken,
    });
  }

  async revokeMember(input: { adminToken: string; workspaceId: string; memberId: string }) {
    return this.request(`/members/${input.memberId}/revoke`, {
      method: 'POST',
      token: input.adminToken,
      body: { workspaceId: input.workspaceId },
    });
  }

  async removeMember(input: { adminToken: string; workspaceId: string; member: string }) {
    return this.request('/members/remove', {
      method: 'POST',
      token: input.adminToken,
      body: { workspaceId: input.workspaceId, member: input.member },
    });
  }

  async leaveWorkspace(input: { authToken: string; workspaceId: string }) {
    return this.request('/members/me/leave', {
      method: 'POST',
      token: input.authToken,
      body: { workspaceId: input.workspaceId },
    });
  }

  async rotateMemberToken(input: { authToken: string }) {
    return this.request('/members/rotate-token', {
      method: 'POST',
      token: input.authToken,
    });
  }

  async rotateApprovalSecret(input: { authToken: string; approvalSecret?: string }) {
    return this.request('/members/rotate-approval-secret', {
      method: 'POST',
      token: input.authToken,
      body: { approvalSecret: input.approvalSecret },
    });
  }

  async createApprovalToken(input: {
    authToken: string;
    approvalSecret?: string;
    packetId: string;
    action: ApprovalAction;
  }) {
    return this.request(`/packets/${input.packetId}/approval-token`, {
      method: 'POST',
      token: input.authToken,
      body: { action: input.action, approvalSecret: input.approvalSecret },
    });
  }

  async createAskDraft(input: JsonObject & { authToken: string }) {
    return this.request('/packets/ask', {
      method: 'POST',
      token: input.authToken,
      body: withoutAuth(input),
    });
  }

  async createShareDraft(input: JsonObject & { authToken: string }) {
    return this.request('/packets/share', {
      method: 'POST',
      token: input.authToken,
      body: withoutAuth(input),
    });
  }

  async updateDraft(input: JsonObject & { authToken: string; packetId: string }) {
    return this.request(`/packets/${input.packetId}/draft`, {
      method: 'PATCH',
      token: input.authToken,
      body: withoutAuthAndPacket(input),
    });
  }

  async approveAndSend(input: {
    authToken: string;
    packetId: string;
    approvalToken?: string;
    allowSecretOverride?: boolean;
  }) {
    return this.request(`/packets/${input.packetId}/approve`, {
      method: 'POST',
      token: input.authToken,
      body: {
        approvalToken: input.approvalToken,
        allowSecretOverride: input.allowSecretOverride,
      },
    });
  }

  async listInbox(input: { authToken: string; workspaceId: string }) {
    return this.request(`/inbox?workspaceId=${encodeURIComponent(input.workspaceId)}`, {
      token: input.authToken,
    });
  }

  async listNotifications(input: { authToken: string; workspaceId: string }) {
    return this.request(`/notifications?workspaceId=${encodeURIComponent(input.workspaceId)}`, {
      token: input.authToken,
    });
  }

  async ackNotification(input: { authToken: string; notificationId: string }) {
    return this.request(`/notifications/${input.notificationId}/ack`, {
      method: 'POST',
      token: input.authToken,
    });
  }

  async viewPacket(input: { authToken: string; packetId: string }) {
    return this.request(`/packets/${input.packetId}/view`, { token: input.authToken });
  }

  async getPacketForMember(input: { authToken: string; packetId: string }) {
    return this.request(`/packets/${input.packetId}/status`, { token: input.authToken });
  }

  async acceptPacket(input: { authToken: string; packetId: string }) {
    return this.request(`/packets/${input.packetId}/accept`, {
      method: 'POST',
      token: input.authToken,
    });
  }

  async hydratePacket(input: {
    authToken: string;
    packetId: string;
    client: string;
    sessionId?: string;
    approvalToken?: string;
  }) {
    return this.request(`/packets/${input.packetId}/hydrate`, {
      method: 'POST',
      token: input.authToken,
      body: {
        client: input.client,
        sessionId: input.sessionId,
        approvalToken: input.approvalToken,
      },
    });
  }

  async createReplyDraft(input: JsonObject & { authToken: string; packetId: string }) {
    return this.request(`/packets/${input.packetId}/reply`, {
      method: 'POST',
      token: input.authToken,
      body: withoutAuthAndPacket(input),
    });
  }

  async requestClarification(input: {
    authToken: string;
    packetId: string;
    question: string;
    requestedEvidence?: string[];
  }) {
    return this.request(`/packets/${input.packetId}/clarify`, {
      method: 'POST',
      token: input.authToken,
      body: {
        question: input.question,
        requestedEvidence: input.requestedEvidence,
      },
    });
  }

  async answerClarification(
    input: JsonObject & { authToken: string; packetId?: string; clarificationPacketId?: string },
  ) {
    const packetId = input.packetId ?? input.clarificationPacketId;
    if (!packetId) {
      throw new Error('Clarification packet id is required.');
    }
    const body: JsonObject = { ...input };
    delete body.authToken;
    delete body.packetId;
    delete body.clarificationPacketId;
    return this.request(`/packets/${packetId}/answer-clarification`, {
      method: 'POST',
      token: input.authToken,
      body,
    });
  }

  async approveReply(input: { authToken: string; replyPacketId: string; approvalToken?: string }) {
    return this.approveAndSend({
      authToken: input.authToken,
      packetId: input.replyPacketId,
      approvalToken: input.approvalToken,
    });
  }

  async declinePacket(input: { authToken: string; packetId: string; reason?: string }) {
    return this.request(`/packets/${input.packetId}/decline`, {
      method: 'POST',
      token: input.authToken,
      body: { reason: input.reason },
    });
  }

  async archivePacket(input: { authToken: string; packetId: string }) {
    return this.request(`/packets/${input.packetId}/archive`, {
      method: 'POST',
      token: input.authToken,
    });
  }

  async closePacket(input: {
    authToken: string;
    packetId: string;
    resolution: 'resolved' | 'unresolved';
  }) {
    return this.request(`/packets/${input.packetId}/close`, {
      method: 'POST',
      token: input.authToken,
      body: { resolution: input.resolution },
    });
  }

  async searchPackets(
    input: {
      authToken: string;
      workspaceId: string;
      query?: string;
    } & PacketQueryFilters,
  ) {
    const params = new URLSearchParams({ workspaceId: input.workspaceId });
    if (input.query) params.set('q', input.query);
    appendPacketQueryFilters(params, input);
    return this.request(`/search?${params.toString()}`, { token: input.authToken });
  }

  async listHistory(
    input: {
      authToken: string;
      workspaceId: string;
      filter?: HistoryFilter;
      query?: string;
    } & PacketQueryFilters,
  ) {
    const params = new URLSearchParams({ workspaceId: input.workspaceId });
    if (input.filter) params.set('filter', input.filter);
    if (input.query) params.set('q', input.query);
    appendPacketQueryFilters(params, input);
    return this.request(`/history?${params.toString()}`, { token: input.authToken });
  }

  async listAuditReceipts(input: { authToken: string; workspaceId: string; packetId?: string }) {
    const params = new URLSearchParams({ workspaceId: input.workspaceId });
    if (input.packetId) params.set('packetId', input.packetId);
    return this.request(`/audit?${params.toString()}`, { token: input.authToken });
  }

  private async request(
    path: string,
    options: {
      method?: string;
      token?: string;
      headers?: Record<string, string>;
      body?: unknown;
    } = {},
  ) {
    let response: Response;
    try {
      response = await fetch(`${this.serverUrl}${path}`, {
        method: options.method ?? 'GET',
        headers: {
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(options.headers ?? {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch (error) {
      throw new RelayError(
        'SERVER_UNAVAILABLE',
        `Relay coordination server is unavailable at ${this.serverUrl}.`,
        503,
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }
    const text = await response.text();
    const payload = text ? JSON.parse(text) : undefined;
    if (!response.ok) {
      const error = payload?.error;
      throw new RelayError(
        error?.code ?? 'INVALID_INPUT',
        error?.message ?? `Relay API request failed with ${response.status}`,
        response.status,
        error?.details,
      );
    }
    return payload;
  }
}

function withoutAuth(input: JsonObject & { authToken: string }): JsonObject {
  const { authToken: _authToken, ...body } = input;
  return body;
}

function withoutAuthAndPacket(
  input: JsonObject & { authToken: string; packetId: string },
): JsonObject {
  const { authToken: _authToken, packetId: _packetId, ...body } = input;
  return body;
}

function appendPacketQueryFilters(params: URLSearchParams, input: PacketQueryFilters): void {
  if (input.project) params.set('project', input.project);
  if (input.sender) params.set('sender', input.sender);
  if (input.recipient) params.set('recipient', input.recipient);
  if (input.status) params.set('status', input.status);
  if (input.fileOrSymbol) params.set('fileOrSymbol', input.fileOrSymbol);
  if (input.limit !== undefined) params.set('limit', String(input.limit));
  if (input.offset !== undefined) params.set('offset', String(input.offset));
  if (input.ticketOrPr) params.set('ticketOrPr', input.ticketOrPr);
}
