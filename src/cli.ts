#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Command, CommanderError, type OutputConfiguration } from 'commander';

import { confirmLocalApproval } from './approval.js';
import { registerDemoCommands } from './cli/demo-commands.js';
import { registerServerCommands } from './cli/server-commands.js';
import { registerSetupCommands, type SetupCommandOptions } from './cli/setup-commands.js';
import {
  addCommonOptions,
  closeBackend,
  createBackend,
  defaultIo,
  write,
  type CliBackend,
  type CliIo,
  type CommonOptions,
} from './cli/shared.js';
import { isRelayError } from './errors.js';
import {
  inspectBackgroundNotificationWatcher,
  startBackgroundNotificationWatcher,
  stopBackgroundNotificationWatcher,
  type BackgroundNotificationWatcherMetadata,
} from './notification-watch-lifecycle.js';
import { createNotificationDispatcher, createPollingWatcher } from './notifications.js';
import { runtimeVersion } from './runtime/version.js';
import { createBackendForProfile } from './setup/orchestrator.js';
import { createProfileStore, resolveProfileName } from './setup/profile.js';

export interface CliRunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface CliProgramOptions {
  setup?: Omit<SetupCommandOptions, 'io'>;
}

function createProfileBackend(options: CommonOptions): {
  backend: CliBackend;
  credentials: { approvalSecret: string; memberToken: string };
  profile: { profileName: string; workspaceId: string };
} {
  const store = createProfileStore();
  const profileName = resolveProfileName(options.profile);
  const profile = store.loadProfile(profileName);
  if (!profile) {
    throw new Error(
      `No active Handoff profile found. Run \`npx -y handoff-relay start\` or \`npx -y handoff-relay doctor\`.`,
    );
  }
  const credentials = store.loadCredentials(profile.profileName);
  const resolvedProfile = {
    ...profile,
    workspaceId:
      options.workspace ??
      process.env.HANDOFF_WORKSPACE_ID ??
      process.env.AGENT_RELAY_WORKSPACE ??
      profile.workspaceId,
    serverUrl:
      options.serverUrl ??
      process.env.HANDOFF_SERVER_URL ??
      process.env.AGENT_RELAY_SERVER_URL ??
      profile.serverUrl,
    localDatabasePath: options.db ?? process.env.HANDOFF_DB ?? profile.localDatabasePath,
  };
  const resolvedCredentials = {
    ...credentials,
    memberToken:
      options.token ??
      process.env.HANDOFF_MEMBER_TOKEN ??
      process.env.AGENT_RELAY_TOKEN ??
      credentials.memberToken,
    approvalSecret:
      process.env.HANDOFF_APPROVAL_SECRET ??
      process.env.AGENT_RELAY_APPROVAL_SECRET ??
      credentials.approvalSecret,
  };
  return {
    backend: createBackendForProfile({
      profile: resolvedProfile,
      credentials: resolvedCredentials,
    }),
    credentials: resolvedCredentials,
    profile: resolvedProfile,
  };
}

function createAuthContext(
  options: CommonOptions,
  input: { requireWorkspace?: boolean } = { requireWorkspace: true },
): {
  authToken: string;
  backend: CliBackend;
  workspaceId: string;
} {
  const requireWorkspace = input.requireWorkspace ?? true;
  if (options.token && (!requireWorkspace || options.workspace)) {
    return {
      authToken: options.token,
      backend: createBackend(options),
      workspaceId: options.workspace ?? '',
    };
  }
  const profileContext = createProfileBackend(options);
  return {
    authToken: options.token ?? profileContext.credentials.memberToken,
    backend: profileContext.backend,
    workspaceId: options.workspace ?? profileContext.profile.workspaceId,
  };
}

function hasJsonFlag(argv: string[]): boolean {
  return argv.includes('--json');
}

function cliErrorPayload(error: unknown) {
  if (isRelayError(error)) {
    return {
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    };
  }
  return {
    error: {
      code: 'INVALID_INPUT',
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function formatCliError(error: unknown, json: boolean): string {
  const payload = cliErrorPayload(error);
  if (json) {
    return `${JSON.stringify(payload)}\n`;
  }
  return `[${payload.error.code}] ${payload.error.message}\n`;
}

function parseJsonOption(value: string | undefined): any[] | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new Error('Expected a JSON array.');
  }
  return parsed;
}

function parseListOption(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function addAuthOptions(command: Command): Command {
  return addCommonOptions(command)
    .option('--profile <name>', 'Profile name')
    .option('--token <token>', 'Relay member token')
    .option('--workspace <workspaceId>', 'Relay workspace id');
}

function addPacketFilterOptions(command: Command): Command {
  return command
    .option('--project <repo>', 'Filter by canonical project or configured project alias')
    .option('--sender <handleOrId>', 'Filter by sender @handle or member id')
    .option('--recipient <handleOrId>', 'Filter by recipient @handle or member id')
    .option('--status <status>', 'Filter by exact packet status')
    .option('--file-symbol <value>', 'Filter by file path or symbol')
    .option('--ticket-pr <value>', 'Filter by ticket or PR evidence link')
    .option('--limit <count>', 'Maximum packets to return')
    .option('--offset <count>', 'Packets to skip before returning results');
}

function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function parseWebhookHeaders(values: string[] | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const value of values ?? []) {
    const separator = value.includes(':') ? ':' : '=';
    const index = value.indexOf(separator);
    if (index <= 0) {
      throw new Error('Webhook headers must use "Name: value" or "Name=value" format.');
    }
    headers[value.slice(0, index).trim()] = value.slice(index + 1).trim();
  }
  return headers;
}

export function buildCliProgram(io: CliIo = defaultIo, options: CliProgramOptions = {}): Command {
  const program = new Command();
  program
    .name('handoff')
    .description('Human-approved handoffs between coding agents.')
    .version(runtimeVersion);

  registerSetupCommands(program, { io, ...options.setup });

  const workspace = program.command('workspace').description('Workspace setup flows');
  addCommonOptions(
    workspace
      .command('create')
      .description('Create a workspace and first admin member')
      .requiredOption('--name <name>', 'Workspace name')
      .requiredOption('--handle <handle>', 'Admin handle')
      .requiredOption('--display-name <name>', 'Admin display name'),
  ).action(
    async (options: CommonOptions & { name: string; handle: string; displayName: string }) => {
      const service = createBackend(options);
      const result = await service.createWorkspace({
        name: options.name,
        adminHandle: options.handle,
        adminName: options.displayName,
      });
      closeBackend(service);
      write(io, result, options.json);
    },
  );

  const workspaceAlias = workspace.command('alias').description('Project/repo alias flows');
  addAuthOptions(
    workspaceAlias
      .command('set')
      .description('Map a repo alias to a canonical project name')
      .requiredOption('--canonical <project>', 'Canonical project/repo name')
      .requiredOption('--alias <project>', 'Alias project/repo name'),
  ).action(async (options: CommonOptions & { canonical: string; alias: string }) => {
    const auth = createAuthContext(options);
    const result = await auth.backend.configureProjectAlias({
      authToken: auth.authToken,
      workspaceId: auth.workspaceId,
      canonicalProject: options.canonical,
      alias: options.alias,
    });
    closeBackend(auth.backend);
    write(io, result, options.json);
  });
  addAuthOptions(
    workspaceAlias.command('list').description('List configured project aliases'),
  ).action(async (options: CommonOptions) => {
    const auth = createAuthContext(options);
    const result = await auth.backend.listProjectAliases({
      authToken: auth.authToken,
      workspaceId: auth.workspaceId,
    });
    closeBackend(auth.backend);
    write(io, result, options.json);
  });

  const member = program.command('member').description('Workspace member flows');
  addAuthOptions(
    member
      .command('invite')
      .description('Create an invite for a teammate handle')
      .requiredOption('--handle <handle>', 'Handle to invite'),
  ).action(async (options: CommonOptions & { handle: string }) => {
    const auth = createAuthContext(options);
    const result = await auth.backend.inviteMember({
      adminToken: auth.authToken,
      workspaceId: auth.workspaceId,
      handle: options.handle,
    });
    closeBackend(auth.backend);
    write(io, result, options.json);
  });
  addCommonOptions(
    member
      .command('accept')
      .description('Accept a raw invite token into a member account')
      .requiredOption('--invite <token>', 'Invite token')
      .requiredOption('--display-name <name>', 'Display name'),
  ).action(async (options: CommonOptions & { invite: string; displayName: string }) => {
    const service = createBackend(options);
    const result = await service.acceptInvite({
      inviteToken: options.invite,
      displayName: options.displayName,
    });
    closeBackend(service);
    write(io, result, options.json);
  });
  addAuthOptions(member.command('list').description('List workspace members')).action(
    async (options: CommonOptions) => {
      const auth = createAuthContext(options);
      const result = await auth.backend.listMembers({
        authToken: auth.authToken,
        workspaceId: auth.workspaceId,
      });
      closeBackend(auth.backend);
      write(io, result, options.json);
    },
  );
  addAuthOptions(
    member
      .command('revoke')
      .description('Revoke a workspace member by member id')
      .requiredOption('--member <memberId>', 'Member id to revoke'),
  ).action(async (options: CommonOptions & { member: string }) => {
    const auth = createAuthContext(options);
    const result = await auth.backend.revokeMember({
      adminToken: auth.authToken,
      workspaceId: auth.workspaceId,
      memberId: options.member,
    });
    closeBackend(auth.backend);
    write(io, result, options.json);
  });
  addCommonOptions(
    member
      .command('rotate-token')
      .description('Rotate the current member token')
      .requiredOption('--token <token>', 'Current token'),
  ).action(async (options: CommonOptions) => {
    const service = createBackend(options);
    const result = await service.rotateMemberToken({ authToken: options.token ?? '' });
    closeBackend(service);
    write(io, result, options.json);
  });
  addCommonOptions(
    member
      .command('rotate-approval-secret')
      .description('Rotate the local approval secret and invalidate unused approvals')
      .requiredOption('--token <token>', 'Current token')
      .option('--approval-secret <secret>', 'Current local approval secret'),
  ).action(async (options: CommonOptions & { approvalSecret?: string }) => {
    const service = createBackend(options);
    const result = await service.rotateApprovalSecret({
      authToken: options.token ?? '',
      approvalSecret: options.approvalSecret ?? process.env.AGENT_RELAY_APPROVAL_SECRET,
    });
    closeBackend(service);
    write(io, result, options.json);
  });

  addAuthOptions(
    program
      .command('ask')
      .description('Draft a question packet for a teammate; requires approval before sending')
      .argument('<handle>', '@handle recipient')
      .argument('<question>', 'Question to ask')
      .requiredOption('--title <title>', 'Packet title')
      .requiredOption('--summary <summary>', 'Packet summary')
      .option('--source-client <client>', 'Source client', 'generic')
      .option('--claims-json <json>', 'JSON array of claim objects')
      .option('--evidence-json <json>', 'JSON array of evidence objects')
      .option('--files <items>', 'Comma-separated files or symbols')
      .option('--tests <items>', 'Comma-separated commands or tests run')
      .option('--tried <items>', 'Comma-separated what-was-tried entries')
      .option('--failures <items>', 'Comma-separated known failures')
      .option('--hypothesis <text>', 'Current hypothesis')
      .option('--confidence <level>', 'low, medium, or high')
      .option('--next-steps <items>', 'Comma-separated suggested next steps'),
  ).action(async (handle: string, question: string, options: CommonOptions & any) => {
    const auth = createAuthContext(options);
    const result = await auth.backend.createAskDraft({
      authToken: auth.authToken,
      workspaceId: auth.workspaceId,
      to: handle,
      question,
      title: options.title,
      summary: options.summary,
      sourceClient: options.sourceClient,
      claims: parseJsonOption(options.claimsJson),
      evidence: parseJsonOption(options.evidenceJson),
      filesOrSymbols: parseListOption(options.files),
      commandsOrTestsRun: parseListOption(options.tests),
      whatWasTried: parseListOption(options.tried),
      knownFailures: parseListOption(options.failures),
      currentHypothesis: options.hypothesis,
      confidence: options.confidence,
      suggestedNextSteps: parseListOption(options.nextSteps),
    });
    closeBackend(auth.backend);
    write(io, result, options.json);
  });

  addAuthOptions(
    program
      .command('share-with')
      .description(
        'Draft a context-sharing packet for a teammate; requires approval before sending',
      )
      .argument('<handle>', '@handle recipient')
      .requiredOption('--finding <finding>', 'Finding to share')
      .requiredOption('--title <title>', 'Packet title')
      .requiredOption('--summary <summary>', 'Packet summary')
      .option('--source-client <client>', 'Source client', 'generic')
      .option('--claims-json <json>', 'JSON array of claim objects')
      .option('--evidence-json <json>', 'JSON array of evidence objects')
      .option('--files <items>', 'Comma-separated files or symbols')
      .option('--tests <items>', 'Comma-separated commands or tests run')
      .option('--tried <items>', 'Comma-separated what-was-tried entries')
      .option('--failures <items>', 'Comma-separated known failures')
      .option('--hypothesis <text>', 'Current hypothesis')
      .option('--confidence <level>', 'low, medium, or high')
      .option('--next-steps <items>', 'Comma-separated suggested next steps'),
  ).action(async (handle: string, options: CommonOptions & any) => {
    const auth = createAuthContext(options);
    const result = await auth.backend.createShareDraft({
      authToken: auth.authToken,
      workspaceId: auth.workspaceId,
      to: handle,
      finding: options.finding,
      title: options.title,
      summary: options.summary,
      sourceClient: options.sourceClient,
      claims: parseJsonOption(options.claimsJson),
      evidence: parseJsonOption(options.evidenceJson),
      filesOrSymbols: parseListOption(options.files),
      commandsOrTestsRun: parseListOption(options.tests),
      whatWasTried: parseListOption(options.tried),
      knownFailures: parseListOption(options.failures),
      currentHypothesis: options.hypothesis,
      confidence: options.confidence,
      suggestedNextSteps: parseListOption(options.nextSteps),
    });
    closeBackend(auth.backend);
    write(io, result, options.json);
  });

  addCommonOptions(
    program
      .command('update-draft')
      .description('Edit an ask/share draft before sender approval')
      .argument('<packetId>', 'Draft packet id')
      .option('--token <token>', 'Relay member token')
      .option('--title <title>', 'Packet title')
      .option('--summary <summary>', 'Packet summary')
      .option('--question <question>', 'Ask question')
      .option('--finding <finding>', 'Share finding')
      .option('--claims-json <json>', 'JSON array of claim objects')
      .option('--evidence-json <json>', 'JSON array of evidence objects')
      .option('--files <items>', 'Comma-separated files or symbols')
      .option('--tests <items>', 'Comma-separated commands or tests run')
      .option('--tried <items>', 'Comma-separated what-was-tried entries')
      .option('--failures <items>', 'Comma-separated known failures')
      .option('--hypothesis <text>', 'Current hypothesis')
      .option('--confidence <level>', 'low, medium, or high')
      .option('--next-steps <items>', 'Comma-separated suggested next steps'),
  ).action(async (packetId: string, options: CommonOptions & any) => {
    const auth = createAuthContext(options, { requireWorkspace: false });
    const result = await auth.backend.updateDraft({
      authToken: auth.authToken,
      packetId,
      title: options.title,
      summary: options.summary,
      question: options.question,
      finding: options.finding,
      claims: parseJsonOption(options.claimsJson),
      evidence: parseJsonOption(options.evidenceJson),
      filesOrSymbols: parseListOption(options.files),
      commandsOrTestsRun: parseListOption(options.tests),
      whatWasTried: parseListOption(options.tried),
      knownFailures: parseListOption(options.failures),
      currentHypothesis: options.hypothesis,
      confidence: options.confidence,
      suggestedNextSteps: parseListOption(options.nextSteps),
    });
    closeBackend(auth.backend);
    write(io, result, options.json);
  });

  addCommonOptions(
    program
      .command('approve')
      .description('Approve and send a pending ask/share draft')
      .argument('<packetId>', 'Packet id')
      .option('--token <token>', 'Relay member token')
      .requiredOption('--approval-token <token>', 'Human-generated approval token'),
  ).action(async (packetId: string, options: CommonOptions) => {
    const auth = createAuthContext(options, { requireWorkspace: false });
    const result = await auth.backend.approveAndSend({
      authToken: auth.authToken,
      packetId,
      approvalToken: (options as any).approvalToken,
    });
    closeBackend(auth.backend);
    write(io, result, options.json);
  });

  addCommonOptions(
    program
      .command('approval-token')
      .description('Create a short-lived human approval token for send, reply, or hydrate')
      .argument('<packetId>', 'Packet id')
      .option('--token <token>', 'Relay member token')
      .option('--profile <name>', 'Profile name')
      .option('--approval-secret <secret>', 'Local approval secret from workspace/member setup')
      .requiredOption('--action <action>', 'send, reply, or hydrate'),
  ).action(async (packetId: string, options: CommonOptions & any) => {
    const profileContext = options.token ? undefined : createProfileBackend(options);
    const service = profileContext?.backend ?? createBackend(options);
    await confirmLocalApproval({ packetId, action: options.action });
    const approvalSecret =
      options.approvalSecret ??
      process.env.HANDOFF_APPROVAL_SECRET ??
      process.env.AGENT_RELAY_APPROVAL_SECRET ??
      profileContext?.credentials.approvalSecret;
    const authToken =
      options.token ??
      process.env.HANDOFF_MEMBER_TOKEN ??
      process.env.AGENT_RELAY_TOKEN ??
      profileContext?.credentials.memberToken;
    const result = await service.createApprovalToken({
      authToken: authToken ?? '',
      approvalSecret,
      packetId,
      action: options.action,
    });
    closeBackend(service);
    write(io, result, options.json);
  });

  addAuthOptions(program.command('inbox').description('List open packets sent to you')).action(
    async (options: CommonOptions) => {
      const auth = createAuthContext(options);
      const result = await auth.backend.listInbox({
        authToken: auth.authToken,
        workspaceId: auth.workspaceId,
      });
      closeBackend(auth.backend);
      write(io, result, options.json);
    },
  );

  addCommonOptions(
    program
      .command('status')
      .description('Show the current packet state and metadata')
      .argument('<packetId>', 'Packet id')
      .option('--token <token>', 'Relay member token'),
  ).action(async (packetId: string, options: CommonOptions) => {
    const auth = createAuthContext(options, { requireWorkspace: false });
    const result = await auth.backend.getPacketForMember({
      authToken: auth.authToken,
      packetId,
    });
    closeBackend(auth.backend);
    write(io, result, options.json);
  });

  addCommonOptions(
    program
      .command('view')
      .description('Mark a delivered packet as viewed and show its metadata')
      .argument('<packetId>', 'Packet id')
      .option('--token <token>', 'Relay member token'),
  ).action(async (packetId: string, options: CommonOptions) => {
    const auth = createAuthContext(options, { requireWorkspace: false });
    const result = await auth.backend.viewPacket({ authToken: auth.authToken, packetId });
    closeBackend(auth.backend);
    write(io, result, options.json);
  });

  addCommonOptions(
    program
      .command('accept')
      .description('Accept a packet before replying')
      .argument('<packetId>', 'Packet id')
      .option('--token <token>', 'Relay member token'),
  ).action(async (packetId: string, options: CommonOptions) => {
    const auth = createAuthContext(options, { requireWorkspace: false });
    const result = await auth.backend.acceptPacket({ authToken: auth.authToken, packetId });
    closeBackend(auth.backend);
    write(io, result, options.json);
  });

  addCommonOptions(
    program
      .command('hydrate')
      .description('Generate bounded context for your agent from a reviewed packet')
      .argument('<packetId>', 'Packet id')
      .option('--token <token>', 'Relay member token')
      .option('--client <client>', 'Client name', 'generic')
      .option('--session <sessionId>', 'Client session id')
      .requiredOption('--approval-token <token>', 'Human-generated hydration approval token'),
  ).action(async (packetId: string, options: CommonOptions & any) => {
    const auth = createAuthContext(options, { requireWorkspace: false });
    const result = await auth.backend.hydratePacket({
      authToken: auth.authToken,
      packetId,
      client: options.client,
      sessionId: options.session,
      approvalToken: options.approvalToken,
    });
    closeBackend(auth.backend);
    write(io, result, options.json);
  });

  addCommonOptions(
    program
      .command('reply')
      .description('Draft a reply to an accepted or hydrated ask packet')
      .argument('<packetId>', 'Original ask packet id')
      .argument('<answer>', 'Reply answer')
      .option('--token <token>', 'Relay member token')
      .requiredOption('--summary <summary>', 'Reply summary')
      .option('--source-client <client>', 'Source client', 'generic')
      .option('--evidence-json <json>', 'JSON array of evidence objects')
      .option('--confidence <level>', 'low, medium, or high'),
  ).action(async (packetId: string, answer: string, options: CommonOptions & any) => {
    const auth = createAuthContext(options, { requireWorkspace: false });
    const result = await auth.backend.createReplyDraft({
      authToken: auth.authToken,
      packetId,
      answer,
      summary: options.summary,
      sourceClient: options.sourceClient,
      evidence: parseJsonOption(options.evidenceJson),
      confidence: options.confidence,
    });
    closeBackend(auth.backend);
    write(io, result, options.json);
  });

  addCommonOptions(
    program
      .command('clarify')
      .description('Ask the sender for missing details before accepting or hydrating')
      .argument('<packetId>', 'Packet id')
      .option('--token <token>', 'Relay member token')
      .requiredOption('--question <question>', 'Clarification question')
      .option('--requested-evidence <items>', 'Comma-separated requested evidence labels'),
  ).action(async (packetId: string, options: CommonOptions & any) => {
    const auth = createAuthContext(options, { requireWorkspace: false });
    const result = await auth.backend.requestClarification({
      authToken: auth.authToken,
      packetId,
      question: options.question,
      requestedEvidence: parseListOption(options.requestedEvidence),
    });
    closeBackend(auth.backend);
    write(io, result, options.json);
  });

  for (const commandName of ['decline', 'archive'] as const) {
    addCommonOptions(
      program
        .command(commandName)
        .description(
          commandName === 'decline'
            ? 'Decline a packet that should not be handled'
            : 'Archive a packet you are done with',
        )
        .argument('<packetId>', 'Packet id')
        .option('--token <token>', 'Relay member token')
        .option('--reason <reason>', 'Decline reason'),
    ).action(async (packetId: string, options: CommonOptions & { reason?: string }) => {
      const auth = createAuthContext(options, { requireWorkspace: false });
      const result =
        commandName === 'decline'
          ? await auth.backend.declinePacket({
              authToken: auth.authToken,
              packetId,
              reason: options.reason,
            })
          : await auth.backend.archivePacket({ authToken: auth.authToken, packetId });
      closeBackend(auth.backend);
      write(io, result, options.json);
    });
  }

  addCommonOptions(
    program
      .command('close')
      .description('Close an ask after resolution')
      .argument('<packetId>', 'Packet id')
      .option('--token <token>', 'Relay member token')
      .option('--resolution <resolution>', 'resolved or unresolved', 'resolved'),
  ).action(
    async (
      packetId: string,
      options: CommonOptions & { resolution: 'resolved' | 'unresolved' },
    ) => {
      const auth = createAuthContext(options, { requireWorkspace: false });
      const result = await auth.backend.closePacket({
        authToken: auth.authToken,
        packetId,
        resolution: options.resolution,
      });
      closeBackend(auth.backend);
      write(io, result, options.json);
    },
  );

  addAuthOptions(
    addPacketFilterOptions(
      program
        .command('search')
        .description('Search packets in the workspace')
        .option('--query <query>', 'Search query'),
    ),
  ).action(
    async (
      options: CommonOptions & {
        query?: string;
        project?: string;
        sender?: string;
        recipient?: string;
        status?: any;
        fileSymbol?: string;
        limit?: string;
        offset?: string;
        ticketPr?: string;
      },
    ) => {
      const auth = createAuthContext(options);
      const result = await auth.backend.searchPackets({
        authToken: auth.authToken,
        workspaceId: auth.workspaceId,
        query: options.query,
        project: options.project,
        sender: options.sender,
        recipient: options.recipient,
        status: options.status,
        fileOrSymbol: options.fileSymbol,
        limit: options.limit === undefined ? undefined : Number(options.limit),
        offset: options.offset === undefined ? undefined : Number(options.offset),
        ticketOrPr: options.ticketPr,
      });
      closeBackend(auth.backend);
      write(io, result, options.json);
    },
  );

  addAuthOptions(
    addPacketFilterOptions(
      program
        .command('history')
        .description('List packet history with workflow filters')
        .option('--filter <filter>', 'all, drafts, sent, open, or closed', 'all')
        .option('--query <query>', 'Search query'),
    ),
  ).action(
    async (
      options: CommonOptions & {
        filter?: any;
        query?: string;
        project?: string;
        sender?: string;
        recipient?: string;
        status?: any;
        fileSymbol?: string;
        limit?: string;
        offset?: string;
        ticketPr?: string;
      },
    ) => {
      const auth = createAuthContext(options);
      const result = await auth.backend.listHistory({
        authToken: auth.authToken,
        workspaceId: auth.workspaceId,
        filter: options.filter,
        query: options.query,
        project: options.project,
        sender: options.sender,
        recipient: options.recipient,
        status: options.status,
        fileOrSymbol: options.fileSymbol,
        limit: options.limit === undefined ? undefined : Number(options.limit),
        offset: options.offset === undefined ? undefined : Number(options.offset),
        ticketOrPr: options.ticketPr,
      });
      closeBackend(auth.backend);
      write(io, result, options.json);
    },
  );

  addAuthOptions(
    program
      .command('audit')
      .description('List audit receipts for the workspace or one packet')
      .option('--packet <packetId>', 'Optional packet id'),
  ).action(async (options: CommonOptions & { packet?: string }) => {
    const auth = createAuthContext(options);
    const result = await auth.backend.listAuditReceipts({
      authToken: auth.authToken,
      workspaceId: auth.workspaceId,
      packetId: options.packet,
    });
    closeBackend(auth.backend);
    write(io, result, options.json);
  });

  addAuthOptions(
    program
      .command('watch')
      .description('Poll packet notifications; desktop notifications are enabled by default')
      .option('--interval <ms>', 'Polling interval in ms', '5000')
      .option('--once', 'Poll once and exit')
      .option('--background', 'Run the profile notification watcher in the background')
      .option('--status', 'Show the recorded background notification watcher')
      .option('--stop', 'Stop the recorded background notification watcher')
      .option('--no-desktop-notifications', 'Only print terminal notifications')
      .option('--desktop-notifications', 'Send best-effort native desktop notifications (default)')
      .option(
        '--webhook-url <url>',
        'Also POST notification summaries to a generic webhook URL',
        process.env.AGENT_RELAY_WEBHOOK_URL,
      )
      .option(
        '--webhook-header <header>',
        'Webhook header as "Name: value" or "Name=value"; repeat for multiple headers',
        collectOption,
        [],
      ),
  ).action(
    async (
      options: CommonOptions & {
        background?: boolean;
        interval: string;
        once?: boolean;
        desktopNotifications?: boolean;
        status?: boolean;
        stop?: boolean;
        webhookUrl?: string;
        webhookHeader?: string[];
      },
    ) => {
      const modeCount = [options.background, options.status, options.stop].filter(Boolean).length;
      if (modeCount > 1) {
        throw new Error('Use only one watch mode: --background, --status, or --stop.');
      }
      if (options.once && modeCount > 0) {
        throw new Error('Use --once only with foreground watch mode.');
      }
      const intervalMs = Number(options.interval);
      if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
        throw new Error('Polling interval must be a positive number of milliseconds.');
      }
      if (modeCount > 0) {
        const store = createProfileStore();
        const profileName = resolveProfileName(options.profile);
        if (options.status) {
          const result = await inspectBackgroundNotificationWatcher({
            home: store.home,
            profileName,
          });
          write(io, options.json ? result : formatWatchStatusHuman(result), options.json);
          return;
        }
        if (options.stop) {
          const result = await stopBackgroundNotificationWatcher({
            home: store.home,
            profileName,
          });
          write(io, options.json ? result : formatWatchStopHuman(result), options.json);
          return;
        }
        if (options.token || options.workspace || options.db || options.serverUrl) {
          throw new Error(
            'watch --background uses a stored profile so credentials are not exposed in process arguments. Run `handoff start` or `handoff join`, then retry with --profile <name>.',
          );
        }
        store.ensureHome();
        if (!store.loadProfile(profileName)) {
          throw new Error(
            `No Handoff profile named "${profileName}". Run \`npx -y handoff-relay start\` or \`npx -y handoff-relay join <invite>\`.`,
          );
        }
        const auth = createAuthContext({ ...options, profile: profileName });
        try {
          await auth.backend.listNotifications({
            authToken: auth.authToken,
            workspaceId: auth.workspaceId,
          });
        } finally {
          closeBackend(auth.backend);
        }
        const result = await startBackgroundNotificationWatcher({
          desktopNotifications: options.desktopNotifications !== false,
          home: store.home,
          intervalMs,
          profileName,
          webhookHeaders: options.webhookHeader,
          webhookUrl: options.webhookUrl,
        });
        write(io, options.json ? result : formatWatchBackgroundHuman(result), options.json);
        return;
      }
      const auth = createAuthContext(options);
      const notify = createNotificationDispatcher({
        writeTerminal: (message) => io.writeErr(`${message}\n`),
        desktop: options.desktopNotifications !== false,
        webhookUrl: options.webhookUrl,
        webhookHeaders: parseWebhookHeaders(options.webhookHeader),
        onError: (error, channel) => {
          io.writeErr(`[handoff] ${channel} notification failed: ${error.message}\n`);
        },
      });
      const watcher = createPollingWatcher({
        ack: async (summary) => {
          if (!summary.notification_id) return;
          await auth.backend.ackNotification({
            authToken: auth.authToken,
            notificationId: summary.notification_id,
          });
        },
        poll: async () => {
          return auth.backend.listNotifications({
            authToken: auth.authToken,
            workspaceId: auth.workspaceId,
          });
        },
        notify,
        intervalMs: Number(options.interval),
      });
      await watcher.tick();
      if (options.once) {
        closeBackend(auth.backend);
        return;
      }
      watcher.start();
    },
  );

  registerServerCommands(program, { io });
  registerDemoCommands(program, { io });

  return program;
}

function formatWatchBackgroundHuman(result: {
  metadata: BackgroundNotificationWatcherMetadata;
  status: 'already_running' | 'started';
}): string {
  const pid = result.metadata.pid ?? 'unknown';
  if (result.status === 'already_running') {
    return [
      `Handoff notification watcher is already running for profile "${result.metadata.profileName}" (pid ${pid}).`,
      `Log: ${result.metadata.logPath}`,
      `Check: npx -y handoff-relay watch --profile ${result.metadata.profileName} --status`,
    ].join('\n');
  }
  return [
    `Handoff notification watcher started for profile "${result.metadata.profileName}" (pid ${pid}).`,
    `Log: ${result.metadata.logPath}`,
    `Stop: npx -y handoff-relay watch --profile ${result.metadata.profileName} --stop`,
  ].join('\n');
}

function formatWatchStatusHuman(result: {
  metadata?: BackgroundNotificationWatcherMetadata;
  status: 'not_found' | 'not_running' | 'running';
}): string {
  if (!result.metadata) {
    return 'No Handoff notification watcher is recorded.';
  }
  const pid = result.metadata.pid ?? 'unknown';
  if (result.status === 'running') {
    return [
      `Handoff notification watcher is running for profile "${result.metadata.profileName}" (pid ${pid}).`,
      `Interval: ${result.metadata.intervalMs}ms`,
      `Log: ${result.metadata.logPath}`,
    ].join('\n');
  }
  return [
    `Recorded Handoff notification watcher for profile "${result.metadata.profileName}" is not running.`,
    `Log: ${result.metadata.logPath}`,
    `Restart: npx -y handoff-relay watch --profile ${result.metadata.profileName} --background`,
  ].join('\n');
}

function formatWatchStopHuman(result: {
  metadata?: BackgroundNotificationWatcherMetadata;
  status: 'not_found' | 'not_running' | 'still_running' | 'stopped';
}): string {
  if (!result.metadata) {
    return 'No Handoff notification watcher is recorded.';
  }
  const pid = result.metadata.pid ?? 'unknown';
  if (result.status === 'not_running') {
    return `Recorded Handoff notification watcher was not running. Removed stale metadata for profile "${result.metadata.profileName}".`;
  }
  if (result.status === 'still_running') {
    return `Handoff notification watcher for profile "${result.metadata.profileName}" is still running after SIGTERM. Metadata was kept so you can inspect pid ${pid}.`;
  }
  return `Stopped Handoff notification watcher for profile "${result.metadata.profileName}" (pid ${pid}).`;
}

export async function runCli(
  argv: string[],
  options: CliProgramOptions = {},
): Promise<CliRunResult> {
  let stdout = '';
  let stderr = '';
  const output = {
    writeOut: (chunk: string) => {
      stdout += chunk;
    },
    writeErr: (chunk: string) => {
      stderr += chunk;
    },
  };
  const program = buildCliProgram(
    {
      writeOut: output.writeOut,
      writeErr: output.writeErr,
    },
    options,
  );
  program.exitOverride();
  configureOutputRecursively(program, output);

  try {
    await program.parseAsync(argv, { from: 'user' });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    if (error instanceof CommanderError) {
      return { stdout, stderr, code: error.exitCode };
    }
    return { stdout, stderr: stderr + formatCliError(error, hasJsonFlag(argv)), code: 1 };
  }
}

function configureOutputRecursively(command: Command, output: OutputConfiguration): void {
  command.exitOverride();
  command.configureOutput(output);
  for (const subcommand of command.commands) {
    configureOutputRecursively(subcommand, output);
  }
}

function isCliEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === `file://${process.argv[1]}`;
  }
}

if (isCliEntrypoint()) {
  buildCliProgram()
    .parseAsync(process.argv)
    .catch((error) => {
      process.stderr.write(formatCliError(error, hasJsonFlag(process.argv)));
      process.exit(1);
    });
}
