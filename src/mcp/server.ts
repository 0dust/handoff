import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { RelayApiClient } from '../api/client.js';
import { packetStatuses } from '../protocol/schema.js';
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

const sourceClient = z
  .enum(['claude-code', 'codex', 'cursor', 'generic', 'other'])
  .default('generic');
const confidence = z.enum(['low', 'medium', 'high']).optional();
const historyFilter = z.enum(['all', 'drafts', 'sent', 'open', 'closed']).optional();
const projectInput = z
  .object({
    repo_name: z.string(),
    git_remote_fingerprint: z.string().optional(),
    branch: z.string().optional(),
    commit_hash: z.string().optional(),
  })
  .optional();
const packetQueryInput = {
  project: z.string().optional(),
  sender: z.string().optional(),
  recipient: z.string().optional(),
  status: z.enum(packetStatuses).optional(),
  fileOrSymbol: z.string().optional(),
  ticketOrPr: z.string().optional(),
};
const evidenceInput = z
  .array(
    z.object({
      evidence_id: z.string().optional(),
      kind: z
        .enum([
          'file_excerpt',
          'command_output',
          'test_failure',
          'error_message',
          'log_excerpt',
          'diff_summary',
          'ticket_link',
          'pr_link',
          'human_note',
        ])
        .default('human_note'),
      label: z.string(),
      source: z.string(),
      excerpt: z.string(),
      hash: z.string().optional(),
      captured_at: z.string().optional(),
      sensitivity: z.enum(['normal', 'private', 'secret_detected', 'restricted']).optional(),
    }),
  )
  .optional();
const claimInput = z
  .array(
    z.object({
      claim_id: z.string().optional(),
      text: z.string(),
      confidence: z.enum(['low', 'medium', 'high']).optional(),
      status: z.enum(['observed', 'inferred', 'suspected', 'disproven', 'superseded']).optional(),
      evidence_ids: z.array(z.string()).optional(),
      needs_recheck: z.boolean().optional(),
    }),
  )
  .optional();

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
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
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
  const tools: McpToolDefinition[] = [
    {
      name: 'relay_ask',
      description:
        'Draft a human-reviewed ask packet for a teammate. Does not send until relay_approve.',
      inputSchema: {
        authToken: z.string(),
        workspaceId: z.string(),
        to: z.string().describe('@handle recipient'),
        question: z.string(),
        title: z.string(),
        summary: z.string(),
        sourceClient,
        project: projectInput,
        claims: claimInput,
        evidence: evidenceInput,
        filesOrSymbols: z.array(z.string()).optional(),
        commandsOrTestsRun: z.array(z.string()).optional(),
        whatWasTried: z.array(z.string()).optional(),
        knownFailures: z.array(z.string()).optional(),
        currentHypothesis: z.string().optional(),
        confidence,
        suggestedNextSteps: z.array(z.string()).optional(),
      },
      handler: async (args) => {
        const result = await service.createAskDraft(args);
        return { id: result.id, status: result.packet.status, packet: result.packet };
      },
    },
    {
      name: 'relay_share',
      description:
        'Draft a human-reviewed share packet for a teammate. Does not send until relay_approve.',
      inputSchema: {
        authToken: z.string(),
        workspaceId: z.string(),
        to: z.string(),
        finding: z.string(),
        title: z.string(),
        summary: z.string(),
        sourceClient,
        project: projectInput,
        claims: claimInput,
        evidence: evidenceInput,
        filesOrSymbols: z.array(z.string()).optional(),
        commandsOrTestsRun: z.array(z.string()).optional(),
        whatWasTried: z.array(z.string()).optional(),
        knownFailures: z.array(z.string()).optional(),
        currentHypothesis: z.string().optional(),
        confidence,
        suggestedNextSteps: z.array(z.string()).optional(),
      },
      handler: async (args) => {
        const result = await service.createShareDraft(args);
        return { id: result.id, status: result.packet.status, packet: result.packet };
      },
    },
    {
      name: 'relay_update_draft',
      description: 'Edit an ask/share draft before it is approved and sent.',
      inputSchema: {
        authToken: z.string(),
        packetId: z.string(),
        title: z.string().optional(),
        summary: z.string().optional(),
        question: z.string().optional(),
        finding: z.string().optional(),
        claims: claimInput,
        evidence: evidenceInput,
        filesOrSymbols: z.array(z.string()).optional(),
        commandsOrTestsRun: z.array(z.string()).optional(),
        whatWasTried: z.array(z.string()).optional(),
        knownFailures: z.array(z.string()).optional(),
        currentHypothesis: z.string().optional(),
        confidence,
        suggestedNextSteps: z.array(z.string()).optional(),
      },
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
        'Approve and send a drafted ask/share packet or approve a reply packet after human review.',
      inputSchema: approveInputSchema,
      handler: async (args) => {
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
      },
    },
    {
      name: 'relay_inbox',
      description: 'List packets addressed to the current member.',
      inputSchema: {
        authToken: z.string(),
        workspaceId: z.string(),
      },
      handler: async (args) => service.listInbox(args),
    },
    {
      name: 'relay_status',
      description: 'Get a packet if the current member is allowed to read it.',
      inputSchema: {
        authToken: z.string(),
        packetId: z.string(),
      },
      handler: async (args) => service.getPacketForMember(args),
    },
    {
      name: 'relay_view',
      description: 'Record a packet view and return the packet for review.',
      inputSchema: {
        authToken: z.string(),
        packetId: z.string(),
      },
      handler: async (args) => service.viewPacket(args),
    },
    {
      name: 'relay_accept',
      description: 'Accept a reviewed packet before hydration.',
      inputSchema: {
        authToken: z.string(),
        packetId: z.string(),
      },
      handler: async (args) => service.acceptPacket(args),
    },
    {
      name: 'relay_hydrate',
      description:
        'Hydrate an accepted packet into agent context after human review and record a hydration receipt.',
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
      name: 'relay_reply',
      description:
        'Draft a reply to an accepted/hydrated ask packet. Requires relay_approve to return.',
      inputSchema: {
        authToken: z.string(),
        packetId: z.string(),
        answer: z.string(),
        summary: z.string(),
        sourceClient,
        evidence: evidenceInput,
        confidence,
      },
      handler: async (args) => service.createReplyDraft(args),
    },
    {
      name: 'relay_clarify',
      description: 'Request clarification from the sender after reviewing an addressed packet.',
      inputSchema: {
        authToken: z.string(),
        packetId: z.string(),
        question: z.string(),
        requestedEvidence: z.array(z.string()).optional(),
      },
      handler: async (args) => service.requestClarification(args),
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
  const server = new McpServer({ name: 'handoff', version: '0.1.3' });
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
