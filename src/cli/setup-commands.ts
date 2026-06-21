import type { Command } from 'commander';

import { formatDoctorHuman, runDoctorChecks } from '../setup/doctor.js';
import type { McpClientId } from '../setup/mcp-config.js';
import { createInviteForProfile, joinInvite, startHandoffSetup } from '../setup/orchestrator.js';
import { write, type CliIo, type CommonOptions } from './shared.js';

type InstallableMcpClient = Exclude<McpClientId, 'claude-code'>;

export function registerSetupCommands(program: Command, input: { io: CliIo }): void {
  const { io } = input;
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
  lines.push(
    '',
    ...formatMcpSetupHuman(result.mcp, { missingInstallHint: 'start' }),
    '',
    'Next:',
    result.nextCommand,
  );
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
    ...formatMcpSetupHuman(result.mcp, { missingInstallHint: 'manual' }),
    '',
    'Agent prompt:',
    result.nextAgentInstruction,
  ].join('\n');
}

function formatMcpSetupHuman(
  mcp: Awaited<ReturnType<typeof startHandoffSetup>>['mcp'],
  options: { missingInstallHint: 'manual' | 'start' },
): string[] {
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
  if (options.missingInstallHint === 'start') {
    lines.push('Install for Codex: npx -y handoff-relay start --install-mcp codex');
    lines.push('Install for Cursor: npx -y handoff-relay start --install-mcp cursor');
  } else {
    lines.push(
      `Codex config: ${
        mcp.installCommands.find((command) => command.startsWith('Add to ~/.codex/')) ?? mcp.command
      }`,
    );
    lines.push(
      `Cursor config: ${
        mcp.installCommands.find((command) => command.startsWith('Add to ~/.cursor/')) ??
        mcp.command
      }`,
    );
  }
  lines.push(
    `Claude Code: ${
      mcp.installCommands.find((command) => command.startsWith('claude ')) ??
      'add the command above with claude mcp add-json'
    }`,
  );
  return lines;
}
