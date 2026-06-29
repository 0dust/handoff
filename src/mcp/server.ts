import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { RelayApiClient } from '../api/client.js';
import {
  answerClarificationInputShape,
  askDraftInputShape,
  clarificationRequestInputShape,
  draftMutationInputShape,
  historyFilterInputSchema,
  packetQueryInputShape,
  replyDraftInputShape,
  shareDraftInputShape,
} from '../protocol/inputs.js';
import type { RelayPacket } from '../protocol/schema.js';
import { runtimeVersion } from '../runtime/version.js';
import { RelayService, type ApprovalAction } from '../service/relay-service.js';
import { createBackendForProfile } from '../setup/orchestrator.js';
import { createProfileStore, resolveProfileName, type ProfileStore } from '../setup/profile.js';
import { createRelayDatabase } from '../storage/database.js';

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  handler: (args: any) => any | Promise<any>;
}

const historyFilter = historyFilterInputSchema;
const packetQueryInput = packetQueryInputShape;
const reviewableInboxStatuses = ['delivered', 'replied', 'viewed', 'accepted'];
const askMcpInputShape = {
  authToken: z.string(),
  ...askDraftInputShape,
  to: askDraftInputShape.to.describe('@handle recipient'),
} as const;
const shareMcpInputShape = { authToken: z.string(), ...shareDraftInputShape } as const;
const updateDraftMcpInputShape = {
  authToken: z.string(),
  packetId: z.string(),
  ...draftMutationInputShape,
} as const;
const answerClarificationMcpInputShape = {
  authToken: z.string(),
  packetId: z.string().describe('Clarification packet id'),
  ...answerClarificationInputShape,
} as const;
const replyDraftMcpInputShape = {
  authToken: z.string(),
  packetId: z.string(),
  ...replyDraftInputShape,
} as const;
const clarificationRequestMcpInputShape = {
  authToken: z.string(),
  packetId: z.string(),
  ...clarificationRequestInputShape,
} as const;

type RelayBackend = RelayService | RelayApiClient;

export interface McpAuthContext {
  approvalSecret?: string;
  authToken: string;
  workspaceId: string;
}

export interface McpDefinitionOptions {
  agentApprovals?: boolean;
  authContext?: McpAuthContext;
  explicitAuth?: boolean;
  profileName?: string;
  profileStore?: ProfileStore;
}

function asToolResult(value: unknown) {
  const result = {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
  if (isStructuredObject(value)) {
    return { ...result, structuredContent: value };
  }
  return result;
}

function isStructuredObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withReviewGuidance<T extends { packet: RelayPacket }>(
  result: T,
): T & {
  next_actions: string[];
} {
  if (result.packet.packet_type === 'clarification') {
    return {
      ...result,
      next_actions: [
        'Show this clarification request to the human.',
        'If the human can answer, call relay_answer_clarification with this clarification packetId.',
        'Show the returned original packet and redaction_report to the human.',
        'If approved, call relay_send_approved for the returned original packetId.',
      ],
    };
  }
  return {
    ...result,
    next_actions: [
      'Show this packet and redaction_report to the human.',
      'If approved, call relay_hydrate_approved with this packetId.',
      'If more context is needed, call relay_clarify.',
      'If the packet should not be used, call relay_decline.',
    ],
  };
}

export function getMcpToolDefinitions(
  service: RelayBackend,
  options: McpDefinitionOptions = {},
): McpToolDefinition[] {
  const authContext = options.authContext ?? authContextFromProfile(options);
  const agentApprovals = Boolean(options.agentApprovals);
  if (agentApprovals && (options.explicitAuth || !authContext?.approvalSecret)) {
    throw new Error(
      'Agent-confirmed approvals require profile-backed MCP with a profile approval secret.',
    );
  }
  const agentApprovalSecret = agentApprovals ? authContext?.approvalSecret : undefined;
  const approvalTokenInput = agentApprovals ? z.string().optional() : z.string();
  const approveInputSchema: Record<string, z.ZodTypeAny> = {
    authToken: z.string(),
    packetId: z.string(),
    approvalToken: approvalTokenInput,
  };
  if (!agentApprovals) {
    approveInputSchema.allowSecretOverride = z.boolean().optional();
  }
  const approveAndSendHandler = async (args: any) => {
    if (agentApprovals && !args.approvalToken && args.allowSecretOverride) {
      throw new Error(
        'Redaction overrides require a manually generated approval token; agent-confirmed approvals cannot override blocked content.',
      );
    }
    const approvalToken = await resolveMcpApprovalToken({
      action: async () => {
        const result = await service.getPacketForMember({
          authToken: args.authToken,
          packetId: args.packetId,
        });
        return result.packet.packet_type === 'reply' ? 'reply' : 'send';
      },
      args,
      approvalSecret: agentApprovalSecret,
      service,
      useAgentApprovals: agentApprovals,
    });
    return service.approveAndSend({ ...args, approvalToken });
  };
  const tools: McpToolDefinition[] = [
    {
      name: 'relay_ask',
      description:
        'Sender step 1/2: draft a human-reviewed ask packet for a teammate. Show the returned packet and redaction_report to the human, then send with relay_send_approved or relay_approve.',
      inputSchema: askMcpInputShape,
      handler: async (args) => {
        const result = await service.createAskDraft(args);
        return { id: result.id, status: result.packet.status, packet: result.packet };
      },
    },
    {
      name: 'relay_share',
      description:
        'Sender step 1/2: draft a human-reviewed share packet for a teammate. Show the returned packet and redaction_report to the human, then send with relay_send_approved or relay_approve.',
      inputSchema: shareMcpInputShape,
      handler: async (args) => {
        const result = await service.createShareDraft(args);
        return { id: result.id, status: result.packet.status, packet: result.packet };
      },
    },
    {
      name: 'relay_update_draft',
      description: 'Edit an ask/share draft before it is approved and sent.',
      inputSchema: updateDraftMcpInputShape,
      handler: async (args) => service.updateDraft(args),
    },
    {
      name: 'relay_configure_project_alias',
      description: 'Configure a workspace project/repo alias. Requires workspace admin token.',
      inputSchema: {
        authToken: z.string(),
        workspaceId: z.string(),
        canonicalProject: z.string(),
        alias: z.string(),
      },
      handler: async (args) => service.configureProjectAlias(args),
    },
    {
      name: 'relay_project_aliases',
      description: 'List configured project/repo aliases for a workspace.',
      inputSchema: {
        authToken: z.string(),
        workspaceId: z.string(),
      },
      handler: async (args) => service.listProjectAliases(args),
    },
    {
      name: 'relay_approve',
      description:
        'Compatibility approval tool: send a drafted ask/share packet or approve a reply packet after human review. Prefer relay_send_approved for new sender flows.',
      inputSchema: approveInputSchema,
      handler: approveAndSendHandler,
    },
    {
      name: 'relay_send_approved',
      description:
        'Sender step 2/2: after the human reviews the draft packet and redaction_report, approve and send it. Also approves reply packets after human review.',
      inputSchema: approveInputSchema,
      handler: approveAndSendHandler,
    },
    {
      name: 'relay_inbox',
      description:
        'Recipient step 1/3: list packets addressed to the current member. Pick a packet and call relay_review before accepting or hydrating it.',
      inputSchema: {
        authToken: z.string(),
        workspaceId: z.string(),
      },
      handler: async (args) => service.listInbox(args),
    },
    {
      name: 'relay_review_next',
      description:
        'Recipient shortcut: check the inbox, open the next actionable packet, mark it viewed when needed, and return next actions. Use this when the human says "check my Handoff inbox".',
      inputSchema: {
        authToken: z.string(),
        workspaceId: z.string(),
      },
      handler: async (args) => {
        const inbox = await service.listInbox(args);
        const packet = inbox.find((candidate: RelayPacket) =>
          reviewableInboxStatuses.includes(candidate.status),
        );
        if (!packet) {
          return {
            inbox_count: inbox.length,
            packet: null,
            next_actions: ['No open Handoff packets need review right now.'],
          };
        }
        return {
          ...withReviewGuidance(
            await service.viewPacket({
              authToken: args.authToken,
              packetId: packet.packet_id,
            }),
          ),
          inbox_count: inbox.length,
        };
      },
    },
    {
      name: 'relay_status',
      description:
        'Inspect a readable packet without changing workflow state. For recipient review, prefer relay_review so delivered packets are marked viewed before hydration.',
      inputSchema: {
        authToken: z.string(),
        packetId: z.string(),
      },
      handler: async (args) => service.getPacketForMember(args),
    },
    {
      name: 'relay_view',
      description:
        'Recipient review primitive: mark an addressed delivered/replied packet as viewed and return it for human review. Prefer relay_review for next-action guidance.',
      inputSchema: {
        authToken: z.string(),
        packetId: z.string(),
      },
      handler: async (args) => service.viewPacket(args),
    },
    {
      name: 'relay_accept',
      description:
        'Accept a reviewed ask/share packet before hydration. New recipient flows can use relay_hydrate_approved after relay_review.',
      inputSchema: {
        authToken: z.string(),
        packetId: z.string(),
      },
      handler: async (args) => service.acceptPacket(args),
    },
    {
      name: 'relay_hydrate',
      description:
        'Hydrate an accepted packet into agent context after human review and record a hydration receipt. Recipient happy path: relay_review, show packet to human, then relay_hydrate_approved.',
      inputSchema: {
        authToken: z.string(),
        packetId: z.string(),
        client: z.string().default('generic'),
        sessionId: z.string().optional(),
        approvalToken: approvalTokenInput,
      },
      handler: async (args) => {
        const approvalToken = await resolveMcpApprovalToken({
          action: 'hydrate',
          args,
          approvalSecret: agentApprovalSecret,
          service,
          useAgentApprovals: agentApprovals,
        });
        return service.hydratePacket({ ...args, approvalToken });
      },
    },
    {
      name: 'relay_review',
      description:
        'Recipient step 2/3: mark a packet viewed and return the full packet plus next actions. Show the packet to the human before calling relay_hydrate_approved.',
      inputSchema: {
        authToken: z.string(),
        packetId: z.string(),
      },
      handler: async (args) => {
        return withReviewGuidance(await service.viewPacket(args));
      },
    },
    {
      name: 'relay_hydrate_approved',
      description:
        'Recipient step 3/3: after relay_review and explicit human approval, accept if needed and hydrate the reviewed packet. Refuses untouched delivered/replied packets.',
      inputSchema: {
        authToken: z.string(),
        packetId: z.string(),
        client: z.string().default('generic'),
        sessionId: z.string().optional(),
        approvalToken: approvalTokenInput,
      },
      handler: async (args) => {
        let result = await service.getPacketForMember({
          authToken: args.authToken,
          packetId: args.packetId,
        });
        if (result.packet.status === 'delivered' || result.packet.status === 'replied') {
          throw new Error(
            'Review this packet first with relay_review, show it to the human, then call relay_hydrate_approved.',
          );
        }
        if (result.packet.status === 'viewed' && result.packet.packet_type !== 'reply') {
          result = await service.acceptPacket({
            authToken: args.authToken,
            packetId: args.packetId,
          });
        }
        if (result.packet.packet_type !== 'reply' && result.packet.status !== 'accepted') {
          throw new Error(
            `Packet must be reviewed and accepted before hydration. Current status: ${result.packet.status}.`,
          );
        }
        const approvalToken = await resolveMcpApprovalToken({
          action: 'hydrate',
          args,
          approvalSecret: agentApprovalSecret,
          service,
          useAgentApprovals: agentApprovals,
        });
        return service.hydratePacket({ ...args, approvalToken });
      },
    },
    {
      name: 'relay_reply',
      description:
        'Draft a reply to an accepted/hydrated ask packet. Requires relay_approve to return.',
      inputSchema: replyDraftMcpInputShape,
      handler: async (args) => service.createReplyDraft(args),
    },
    {
      name: 'relay_clarify',
      description: 'Request clarification from the sender after reviewing an addressed packet.',
      inputSchema: clarificationRequestMcpInputShape,
      handler: async (args) => service.requestClarification(args),
    },
    {
      name: 'relay_answer_clarification',
      description:
        'Answer a clarification request addressed to the sender and return the original packet to sender approval.',
      inputSchema: answerClarificationMcpInputShape,
      handler: async (args) => {
        const result = await service.answerClarification(args);
        return {
          ...result,
          next_actions: [
            'Show this updated original packet and redaction_report to the human.',
            'If approved, call relay_send_approved with this packetId.',
            'If redaction_report.blocked is true, remove or override blocked content through the existing sender approval flow.',
          ],
        };
      },
    },
    {
      name: 'relay_decline',
      description: 'Decline a packet addressed to the current member.',
      inputSchema: {
        authToken: z.string(),
        packetId: z.string(),
        reason: z.string().optional(),
      },
      handler: async (args) => service.declinePacket(args),
    },
    {
      name: 'relay_archive',
      description: 'Archive a readable packet.',
      inputSchema: {
        authToken: z.string(),
        packetId: z.string(),
      },
      handler: async (args) => service.archivePacket(args),
    },
    {
      name: 'relay_search',
      description: 'Search permitted packet history without hydrating results.',
      inputSchema: {
        authToken: z.string(),
        workspaceId: z.string(),
        query: z.string().optional(),
        ...packetQueryInput,
      },
      handler: async (args) => service.searchPackets(args),
    },
    {
      name: 'relay_history',
      description: 'List permitted packet history with typed workflow filters.',
      inputSchema: {
        authToken: z.string(),
        workspaceId: z.string(),
        filter: historyFilter,
        query: z.string().optional(),
        ...packetQueryInput,
      },
      handler: async (args) => service.listHistory(args),
    },
    {
      name: 'relay_audit',
      description: 'List audit receipts for a packet or, for admins, the workspace.',
      inputSchema: {
        authToken: z.string(),
        workspaceId: z.string(),
        packetId: z.string().optional(),
      },
      handler: async (args) => service.listAuditReceipts(args),
    },
  ];
  if (options.explicitAuth || !authContext) {
    return tools;
  }
  return tools.map((tool) => ({
    ...tool,
    inputSchema: omitInjectedAuth(tool.inputSchema),
    handler: async (args) =>
      tool.handler({
        ...args,
        authToken: authContext.authToken,
        workspaceId: authContext.workspaceId,
      }),
  }));
}

export function createMcpServer(
  service: RelayBackend,
  options: McpDefinitionOptions = {},
): McpServer {
  const server = new McpServer({ name: 'handoff', version: runtimeVersion });
  for (const tool of getMcpToolDefinitions(service, options)) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args) => asToolResult(await tool.handler(args)),
    );
  }
  return server;
}

export async function startMcpServer(input: {
  agentApprovals?: boolean;
  dbPath: string;
  explicitAuth?: boolean;
  profileName?: string;
  serverUrl?: string;
}): Promise<void> {
  const profileStore = input.profileName ? createProfileStore() : undefined;
  const storedProfile = profileStore?.loadProfile(resolveProfileName(input.profileName));
  if (input.profileName && !storedProfile) {
    throw new Error(
      `No Handoff profile named "${resolveProfileName(input.profileName)}". Run \`npx -y handoff-relay doctor\`.`,
    );
  }
  const storedCredentials = storedProfile
    ? profileStore?.loadCredentials(storedProfile.profileName)
    : undefined;
  const profile = storedProfile
    ? {
        ...storedProfile,
        workspaceId: process.env.HANDOFF_WORKSPACE_ID ?? storedProfile.workspaceId,
        serverUrl:
          input.serverUrl ??
          process.env.HANDOFF_SERVER_URL ??
          process.env.AGENT_RELAY_SERVER_URL ??
          storedProfile.serverUrl,
        localDatabasePath:
          process.env.HANDOFF_DB ?? process.env.AGENT_RELAY_DB ?? storedProfile.localDatabasePath,
      }
    : undefined;
  const credentials = storedCredentials
    ? {
        ...storedCredentials,
        memberToken:
          process.env.HANDOFF_MEMBER_TOKEN ??
          process.env.AGENT_RELAY_TOKEN ??
          storedCredentials.memberToken,
        approvalSecret:
          process.env.HANDOFF_APPROVAL_SECRET ??
          process.env.AGENT_RELAY_APPROVAL_SECRET ??
          storedCredentials.approvalSecret,
      }
    : undefined;
  const service =
    profile && credentials
      ? createBackendForProfile({ profile, credentials })
      : input.serverUrl
        ? new RelayApiClient({ serverUrl: input.serverUrl })
        : new RelayService(createRelayDatabase(input.dbPath));
  const server = createMcpServer(service, {
    agentApprovals: input.agentApprovals,
    authContext:
      profile && credentials
        ? {
            approvalSecret: credentials.approvalSecret,
            authToken: credentials.memberToken,
            workspaceId: profile.workspaceId,
          }
        : undefined,
    explicitAuth: input.explicitAuth || !profile,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Handoff MCP server running on stdio');
}

function omitInjectedAuth(inputSchema: Record<string, z.ZodTypeAny>): Record<string, z.ZodTypeAny> {
  const { authToken: _authToken, workspaceId: _workspaceId, ...rest } = inputSchema;
  return rest;
}

function authContextFromProfile(options: McpDefinitionOptions): McpAuthContext | undefined {
  const store = options.profileStore;
  if (!store) return undefined;
  const profileName = resolveProfileName(options.profileName);
  const profile = store.loadProfile(profileName);
  if (!profile) {
    throw new Error(
      `No Handoff profile named "${profileName}". Run \`npx -y handoff-relay doctor\`.`,
    );
  }
  const credentials = store.loadCredentials(profile.profileName);
  const workspaceId = process.env.HANDOFF_WORKSPACE_ID ?? profile.workspaceId;
  const authToken =
    process.env.HANDOFF_MEMBER_TOKEN ?? process.env.AGENT_RELAY_TOKEN ?? credentials.memberToken;
  const approvalSecret =
    process.env.HANDOFF_APPROVAL_SECRET ??
    process.env.AGENT_RELAY_APPROVAL_SECRET ??
    credentials.approvalSecret;
  return {
    approvalSecret,
    authToken,
    workspaceId,
  };
}

async function resolveMcpApprovalToken(input: {
  action: ApprovalAction | (() => Promise<ApprovalAction>);
  args: { authToken: string; approvalToken?: string; packetId: string };
  approvalSecret?: string;
  service: RelayBackend;
  useAgentApprovals: boolean;
}): Promise<string | undefined> {
  if (input.args.approvalToken) {
    return input.args.approvalToken;
  }
  if (!input.useAgentApprovals) {
    return undefined;
  }
  if (!input.approvalSecret) {
    throw new Error(
      'Agent-confirmed approvals require profile-backed MCP with a profile approval secret.',
    );
  }
  const action = typeof input.action === 'function' ? await input.action() : input.action;
  const approval = await input.service.createApprovalToken({
    authToken: input.args.authToken,
    approvalSecret: input.approvalSecret,
    packetId: input.args.packetId,
    action,
  });
  return approval.approval_token;
}
