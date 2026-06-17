#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Command, CommanderError } from 'commander';

import { confirmLocalApproval } from './approval.js';
import { RelayApiClient } from './api/client.js';
import { startApiServer } from './api/server.js';
import { isRelayError } from './errors.js';
import { startMcpServer } from './mcp/server.js';
import { createNotificationDispatcher, createPollingWatcher } from './notifications.js';
import type { RelayPacket } from './protocol/schema.js';
import { RelayService } from './service/relay-service.js';
import { formatDoctorHuman, runDoctorChecks } from './setup/doctor.js';
import {
  createBackendForProfile,
  createInviteForProfile,
  joinInvite,
  startHandoffSetup,
} from './setup/orchestrator.js';
import { createProfileStore, resolveProfileName } from './setup/profile.js';
import { createRelayDatabase } from './storage/database.js';

export interface CliRunResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface CliIo {
  writeOut(chunk: string): void;
  writeErr(chunk: string): void;
}

interface CommonOptions {
  db?: string;
  json?: boolean;
  profile?: string;
  serverUrl?: string;
  token?: string;
  workspace?: string;
}

const defaultIo: CliIo = {
  writeOut: (chunk) => process.stdout.write(chunk),
  writeErr: (chunk) => process.stderr.write(chunk),
};

type CliBackend = RelayService | RelayApiClient;
type InstallableMcpClient = 'codex' | 'cursor';

function createBackend(options: CommonOptions): CliBackend {
  if (options.serverUrl) {
    return new RelayApiClient({ serverUrl: options.serverUrl });
  }
  return new RelayService(
    createRelayDatabase(options.db ?? process.env.AGENT_RELAY_DB ?? '.relay/relay.db'),
  );
}

function closeBackend(backend: CliBackend): void {
  if (backend instanceof RelayService) {
    backend.close();
  }
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
      `No active Handoff profile found. Run \`npx -y @0dust/handoff start\` or \`npx -y @0dust/handoff doctor\`.`,
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

function write(io: CliIo, value: unknown, json?: boolean): void {
  if (json) {
    io.writeOut(`${JSON.stringify(value)}\n`);
    return;
  }
  if (typeof value === 'string') {
    io.writeOut(`${value}\n`);
    return;
  }
  io.writeOut(`${JSON.stringify(value, null, 2)}\n`);
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

function parseInstallMcpClient(value: string | undefined): InstallableMcpClient | undefined {
  if (!value) return undefined;
  if (value === 'codex' || value === 'cursor') return value;
  throw new Error('Unsupported MCP client. Use --install-mcp codex or --install-mcp cursor.');
}

function startOutput(result: Awaited<ReturnType<typeof startHandoffSetup>>) {
  return {
    profile: result.profile.profileName,
    handle: result.profile.handle,
    workspaceName: result.profile.workspaceName,
    serverUrl: result.profile.serverUrl,
    publicInviteBaseUrl: result.profile.publicInviteBaseUrl,
    serverStatus: result.server.status,
    mcp: result.mcp,
    nextCommand: result.nextCommand,
    warning: result.server.warning,
  };
}

function formatStartHuman(result: Awaited<ReturnType<typeof startHandoffSetup>>): string {
  const lines = [
    result.created ? 'Handoff setup created.' : 'Handoff setup is ready.',
    `Profile: ${result.profile.profileName}`,
    `Handle: @${result.profile.handle}`,
    `Workspace: ${result.profile.workspaceName}`,
    `Server: ${result.profile.serverUrl}`,
  ];
  if (result.profile.publicInviteBaseUrl) {
    lines.push(`Invite URL: ${result.profile.publicInviteBaseUrl}`);
  }
  if (result.server.warning) {
    lines.push(`Warning: ${result.server.warning}`);
  }
  lines.push('', ...formatMcpSetupHuman(result.mcp), '', 'Next:', result.nextCommand);
  return lines.join('\n');
}

function formatInviteHuman(result: Awaited<ReturnType<typeof createInviteForProfile>>): string {
  const lines = [
    `Invite ready for @${result.handle}.`,
    `Expires: ${result.expiresAt}`,
    '',
    result.joinCommand,
    '',
    result.inviteLink,
  ];
  if (result.warning) lines.push('', `Warning: ${result.warning}`);
  return lines.join('\n');
}

function joinOutput(result: Awaited<ReturnType<typeof joinInvite>>) {
  return {
    profile: result.profile.profileName,
    handle: result.profile.handle,
    workspaceName: result.profile.workspaceName,
    serverUrl: result.profile.serverUrl,
    mcp: result.mcp,
    nextAgentInstruction: result.nextAgentInstruction,
  };
}

function formatJoinHuman(result: Awaited<ReturnType<typeof joinInvite>>): string {
  return [
    `Joined ${result.profile.workspaceName} as @${result.profile.handle}.`,
    `Profile: ${result.profile.profileName}`,
    `Server: ${result.profile.serverUrl}`,
    '',
    ...formatMcpSetupHuman(result.mcp),
    '',
    'Agent prompt:',
    result.nextAgentInstruction,
  ].join('\n');
}

function formatMcpSetupHuman(mcp: Awaited<ReturnType<typeof startHandoffSetup>>['mcp']): string[] {
  const lines = ['MCP setup:', `Command: ${mcp.command}`];
  const installed = mcp.configs.filter((config) => config.installed);
  if (installed.length > 0) {
    lines.push(`Detected: ${installed.map((config) => config.client).join(', ')}`);
    return lines;
  }
  if (mcp.status === 'skipped') {
    lines.push('Status: skipped.');
    return lines;
  } else {
    lines.push('Status: not detected in Codex, Claude Code, or Cursor config yet.');
  }
  lines.push('Install for Codex: npx -y @0dust/handoff start --install-mcp codex');
  lines.push('Install for Cursor: npx -y @0dust/handoff start --install-mcp cursor');
  lines.push(
    `Claude Code: ${
      mcp.installCommands.find((command) => command.startsWith('claude ')) ??
      'add the command above with claude mcp add-json'
    }`,
  );
  return lines;
}

function addCommonOptions(command: Command): Command {
  return command
    .option('--db <path>', 'SQLite database path')
    .option('--server-url <url>', 'Relay coordination API URL')
    .option('--json', 'Print JSON output');
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
    .option('--ticket-pr <value>', 'Filter by ticket or PR evidence link');
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

export function buildCliProgram(io: CliIo = defaultIo): Command {
  const program = new Command();
  program
    .name('handoff')
    .description('Human-approved handoffs between coding agents.')
    .version('0.1.0');

  program
    .command('start')
    .description('Create or reuse a frictionless Handoff profile and local server')
    .option('--lan', 'Prepare LAN-reachable invite links')
    .option('--profile <name>', 'Profile name')
    .option('--handle <handle>', 'Local member handle')
    .option('--display-name <name>', 'Local display name')
    .option('--workspace-name <name>', 'Workspace name')
    .option('--host <host>', 'Server bind host')
    .option('--install-mcp <client>', 'Install MCP config for codex or cursor')
    .option('--port <port>', 'Server port')
    .option('--public-url <url>', 'Public invite base URL')
    .option('--no-mcp-install', 'Do not offer automatic MCP setup')
    .option('--json', 'Print JSON output')
    .action(
      async (
        options: CommonOptions & {
          displayName?: string;
          handle?: string;
          host?: string;
          installMcp?: 'codex' | 'cursor';
          lan?: boolean;
          mcpInstall?: boolean;
          port?: string;
          publicUrl?: string;
          workspaceName?: string;
        },
      ) => {
        const result = await startHandoffSetup({
          displayName: options.displayName,
          handle: options.handle,
          host: options.host,
          installMcpClient: parseInstallMcpClient(options.installMcp),
          lan: options.lan,
          noMcpInstall: options.mcpInstall === false,
          port: options.port ? Number(options.port) : undefined,
          profileName: options.profile,
          publicUrl: options.publicUrl,
          workspaceName: options.workspaceName,
        });
        write(io, options.json ? startOutput(result) : formatStartHuman(result), options.json);
      },
    );

  program
    .command('invite')
    .description('Invite a teammate with the active Handoff profile')
    .argument('<handle>', '@handle to invite')
    .option('--profile <name>', 'Profile name')
    .option('--expires-in <duration>', 'Reserved for future invite durations')
    .option('--json', 'Print JSON output')
    .action(async (handle: string, options: CommonOptions) => {
      const result = await createInviteForProfile({ handle, profileName: options.profile });
      write(io, options.json ? result : formatInviteHuman(result), options.json);
    });

  program
    .command('join')
    .description('Join a Handoff workspace from an invite link')
    .argument('<invite>', 'Invite URL or raw invite token with --server-url')
    .option('--profile <name>', 'Profile name')
    .option('--display-name <name>', 'Display name')
    .option('--server-url <url>', 'Server URL for raw invite tokens')
    .option('--install-mcp <client>', 'Install MCP config for codex or cursor')
    .option('--no-mcp-install', 'Do not offer automatic MCP setup')
    .option('--json', 'Print JSON output')
    .action(
      async (
        invite: string,
        options: CommonOptions & {
          displayName?: string;
          installMcp?: string;
          mcpInstall?: boolean;
        },
      ) => {
        const result = await joinInvite({
          displayName: options.displayName,
          installMcpClient: parseInstallMcpClient(options.installMcp),
          invite,
          noMcpInstall: options.mcpInstall === false,
          profileName: options.profile,
          serverUrl: options.serverUrl,
        });
        write(io, options.json ? joinOutput(result) : formatJoinHuman(result), options.json);
      },
    );

  program
    .command('doctor')
    .description('Diagnose Handoff setup health')
    .option('--profile <name>', 'Profile name')
    .option('--fix', 'Repair safe local issues')
    .option('--json', 'Print JSON output')
    .action(async (options: CommonOptions & { fix?: boolean }) => {
      const report = await runDoctorChecks({ fix: options.fix, profileName: options.profile });
      write(io, options.json ? report : formatDoctorHuman(report), options.json);
    });

  const workspace = program.command('workspace').description('Workspace setup flows');
  addCommonOptions(
    workspace
      .command('create')
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
  addAuthOptions(workspaceAlias.command('list')).action(async (options: CommonOptions) => {
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
    member.command('invite').requiredOption('--handle <handle>', 'Handle to invite'),
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
  addAuthOptions(member.command('list')).action(async (options: CommonOptions) => {
    const auth = createAuthContext(options);
    const result = await auth.backend.listMembers({
      authToken: auth.authToken,
      workspaceId: auth.workspaceId,
    });
    closeBackend(auth.backend);
    write(io, result, options.json);
  });
  addAuthOptions(
    member.command('revoke').requiredOption('--member <memberId>', 'Member id to revoke'),
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
    member.command('rotate-token').requiredOption('--token <token>', 'Current token'),
  ).action(async (options: CommonOptions) => {
    const service = createBackend(options);
    const result = await service.rotateMemberToken({ authToken: options.token ?? '' });
    closeBackend(service);
    write(io, result, options.json);
  });
  addCommonOptions(
    member
      .command('rotate-approval-secret')
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
      .argument('<packetId>', 'Draft packet id')
      .option('--token <token>')
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
      .argument('<packetId>', 'Packet id')
      .option('--token <token>')
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
      .argument('<packetId>')
      .option('--token <token>')
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
    const result =
      service instanceof RelayApiClient
        ? await service.createApprovalToken({
            authToken: authToken ?? '',
            approvalSecret,
            packetId,
            action: options.action,
          })
        : await service.createApprovalToken({
            authToken: authToken ?? '',
            approvalSecret,
            packetId,
            action: options.action,
          });
    closeBackend(service);
    write(io, result, options.json);
  });

  addAuthOptions(program.command('inbox')).action(async (options: CommonOptions) => {
    const auth = createAuthContext(options);
    const result = await auth.backend.listInbox({
      authToken: auth.authToken,
      workspaceId: auth.workspaceId,
    });
    closeBackend(auth.backend);
    write(io, result, options.json);
  });

  addCommonOptions(
    program.command('status').argument('<packetId>').option('--token <token>'),
  ).action(async (packetId: string, options: CommonOptions) => {
    const auth = createAuthContext(options, { requireWorkspace: false });
    const result = await auth.backend.getPacketForMember({
      authToken: auth.authToken,
      packetId,
    });
    closeBackend(auth.backend);
    write(io, result, options.json);
  });

  addCommonOptions(program.command('view').argument('<packetId>').option('--token <token>')).action(
    async (packetId: string, options: CommonOptions) => {
      const auth = createAuthContext(options, { requireWorkspace: false });
      const result = await auth.backend.viewPacket({ authToken: auth.authToken, packetId });
      closeBackend(auth.backend);
      write(io, result, options.json);
    },
  );

  addCommonOptions(
    program.command('accept').argument('<packetId>').option('--token <token>'),
  ).action(async (packetId: string, options: CommonOptions) => {
    const auth = createAuthContext(options, { requireWorkspace: false });
    const result = await auth.backend.acceptPacket({ authToken: auth.authToken, packetId });
    closeBackend(auth.backend);
    write(io, result, options.json);
  });

  addCommonOptions(
    program
      .command('hydrate')
      .argument('<packetId>')
      .option('--token <token>')
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
      .argument('<packetId>')
      .argument('<answer>')
      .option('--token <token>')
      .requiredOption('--summary <summary>')
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
      .argument('<packetId>')
      .option('--token <token>')
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
        .argument('<packetId>')
        .option('--token <token>')
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
      .argument('<packetId>')
      .option('--token <token>')
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
    addPacketFilterOptions(program.command('search').option('--query <query>', 'Search query')),
  ).action(
    async (
      options: CommonOptions & {
        query?: string;
        project?: string;
        sender?: string;
        recipient?: string;
        status?: any;
        fileSymbol?: string;
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
        ticketOrPr: options.ticketPr,
      });
      closeBackend(auth.backend);
      write(io, result, options.json);
    },
  );

  addAuthOptions(
    program.command('audit').option('--packet <packetId>', 'Optional packet id'),
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
      .option('--interval <ms>', 'Polling interval in ms', '5000')
      .option('--once', 'Poll once and exit')
      .option('--desktop-notifications', 'Also send best-effort native desktop notifications')
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
        interval: string;
        once?: boolean;
        desktopNotifications?: boolean;
        webhookUrl?: string;
        webhookHeader?: string[];
      },
    ) => {
      const auth = createAuthContext(options);
      const notify = createNotificationDispatcher({
        writeTerminal: (message) => io.writeErr(`${message}\n`),
        desktop: options.desktopNotifications,
        webhookUrl: options.webhookUrl,
        webhookHeaders: parseWebhookHeaders(options.webhookHeader),
        onError: (error, channel) => {
          io.writeErr(`[handoff] ${channel} notification failed: ${error.message}\n`);
        },
      });
      const watcher = createPollingWatcher({
        poll: async () => {
          const [packets, members] = await Promise.all([
            Promise.resolve(
              auth.backend.listInbox({
                authToken: auth.authToken,
                workspaceId: auth.workspaceId,
              }),
            ),
            Promise.resolve(
              auth.backend.listMembers({
                authToken: auth.authToken,
                workspaceId: auth.workspaceId,
              }),
            ),
          ]);
          const handlesById = new Map(
            members.map((member: { id: string; handle: string }) => [member.id, member.handle]),
          );
          return packets.map((packet: RelayPacket) => ({
            packet_id: packet.packet_id,
            packet_type: packet.packet_type,
            title: packet.title,
            summary: packet.summary,
            sender_handle: handlesById.get(packet.sender_member_id) ?? packet.sender_member_id,
            project: packet.project.repo_name,
          }));
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

  const server = program.command('server').description('Coordination and MCP servers');
  addCommonOptions(
    server
      .command('start')
      .option('--host <host>', 'Host', '127.0.0.1')
      .option('--port <port>', 'Port', '3737'),
  ).action(async (options: CommonOptions & { host: string; port: string }) => {
    await startApiServer({
      dbPath: options.db ?? '.relay/relay.db',
      host: options.host,
      port: Number(options.port),
    });
    io.writeErr(
      `Handoff coordination server listening on http://${options.host}:${options.port}\n`,
    );
  });
  addCommonOptions(
    server
      .command('mcp')
      .option('--profile <name>', 'Use a stored Handoff profile')
      .option('--explicit-auth', 'Expose authToken and workspaceId in MCP schemas'),
  ).action(async (options: CommonOptions & { explicitAuth?: boolean }) => {
    await startMcpServer({
      dbPath: options.db ?? '.relay/relay.db',
      explicitAuth: options.explicitAuth,
      profileName: options.profile,
      serverUrl: options.serverUrl,
    });
  });

  const demo = program.command('demo').description('Local demos');
  addCommonOptions(demo.command('two-user')).action(async (options: CommonOptions) => {
    const service = createBackend(options);
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
    const askSendApproval = await service.createApprovalToken({
      authToken: workspace.admin.token,
      approvalSecret: workspace.admin.approval_secret,
      packetId: ask.id,
      action: 'send',
    });
    await service.approveAndSend({
      authToken: workspace.admin.token,
      packetId: ask.id,
      approvalToken: askSendApproval.approval_token,
    });
    await service.viewPacket({ authToken: alice.member.token, packetId: ask.id });
    await service.acceptPacket({ authToken: alice.member.token, packetId: ask.id });
    const askHydrateApproval = await service.createApprovalToken({
      authToken: alice.member.token,
      approvalSecret: alice.member.approval_secret,
      packetId: ask.id,
      action: 'hydrate',
    });
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
    const replyApproval = await service.createApprovalToken({
      authToken: alice.member.token,
      approvalSecret: alice.member.approval_secret,
      packetId: reply.id,
      action: 'reply',
    });
    await service.approveReply({
      authToken: alice.member.token,
      replyPacketId: reply.id,
      approvalToken: replyApproval.approval_token,
    });
    await service.viewPacket({
      authToken: workspace.admin.token,
      packetId: reply.id,
    });
    const replyHydrateApproval = await service.createApprovalToken({
      authToken: workspace.admin.token,
      approvalSecret: workspace.admin.approval_secret,
      packetId: reply.id,
      action: 'hydrate',
    });
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
    const shareSendApproval = await service.createApprovalToken({
      authToken: workspace.admin.token,
      approvalSecret: workspace.admin.approval_secret,
      packetId: share.id,
      action: 'send',
    });
    await service.approveAndSend({
      authToken: workspace.admin.token,
      packetId: share.id,
      approvalToken: shareSendApproval.approval_token,
    });
    await service.viewPacket({ authToken: alice.member.token, packetId: share.id });
    await service.acceptPacket({ authToken: alice.member.token, packetId: share.id });
    const shareHydrateApproval = await service.createApprovalToken({
      authToken: alice.member.token,
      approvalSecret: alice.member.approval_secret,
      packetId: share.id,
      action: 'hydrate',
    });
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
    closeBackend(service);

    write(
      io,
      {
        workspace: workspace.workspace,
        sender: workspace.admin,
        recipient: alice.member,
        ask: closed.packet,
        reply: hydratedReply.packet,
        share: archived.packet,
      },
      options.json,
    );
  });

  return program;
}

export async function runCli(argv: string[]): Promise<CliRunResult> {
  let stdout = '';
  let stderr = '';
  const program = buildCliProgram({
    writeOut: (chunk) => {
      stdout += chunk;
    },
    writeErr: (chunk) => {
      stderr += chunk;
    },
  });
  program.exitOverride();
  program.configureOutput({
    writeOut: (chunk) => {
      stdout += chunk;
    },
    writeErr: (chunk) => {
      stderr += chunk;
    },
  });

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
