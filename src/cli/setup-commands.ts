import type { Command } from 'commander';

import { formatDoctorHuman, runDoctorChecks } from '../setup/doctor.js';
import type { McpClientId } from '../setup/mcp-config.js';
import {
  createInviteForProfile,
  joinInvite,
  leaveWorkspaceProfile,
  removeWorkspaceMember,
  startHandoffSetup,
} from '../setup/orchestrator.js';
import { write, type CliIo, type CommonOptions } from './shared.js';

type InstallableMcpClient = McpClientId;

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
    .option(
      '--invite <handle>',
      'Create or reprint an invite during setup; repeatable',
      collectOption,
      [],
    )
    .option('--install-mcp <client>', 'Install MCP config for codex, claude, or cursor')
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
          installMcp?: string;
          invite?: string[];
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
        const invites = [];
        for (const handle of options.invite ?? []) {
          invites.push(
            await createInviteForProfile({
              handle,
              profileName: result.profile.profileName,
            }),
          );
        }
        write(
          io,
          options.json ? startOutput(result, invites) : formatStartHuman(result, invites),
          options.json,
        );
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
    .option('--install-mcp <client>', 'Install MCP config for codex, claude, or cursor')
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
    .command('leave')
    .description('Leave the active Handoff workspace and remove local profile credentials')
    .option('--profile <name>', 'Profile name')
    .option('--json', 'Print JSON output')
    .action(async (options: CommonOptions) => {
      const result = await leaveWorkspaceProfile({ profileName: options.profile });
      write(io, options.json ? result : formatLeaveHuman(result), options.json);
    });

  program
    .command('remove-member')
    .description('Remove a teammate from the active Handoff workspace')
    .argument('<member>', '@handle or member id to remove')
    .option('--profile <name>', 'Profile name')
    .option('--json', 'Print JSON output')
    .action(async (member: string, options: CommonOptions) => {
      const result = await removeWorkspaceMember({ member, profileName: options.profile });
      write(io, options.json ? result : formatRemoveMemberHuman(result), options.json);
    });

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
  if (value === 'claude' || value === 'claude-code') return 'claude-code';
  throw new Error(
    'Unsupported MCP client. Use --install-mcp codex, --install-mcp claude, or --install-mcp cursor.',
  );
}

function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function startOutput(
  result: Awaited<ReturnType<typeof startHandoffSetup>>,
  invites: Array<Awaited<ReturnType<typeof createInviteForProfile>>> = [],
) {
  return {
    profile: result.profile.profileName,
    handle: result.profile.handle,
    workspaceName: result.profile.workspaceName,
    serverUrl: result.profile.serverUrl,
    publicInviteBaseUrl: result.profile.publicInviteBaseUrl,
    serverStatus: result.server.status,
    mcp: result.mcp,
    invites,
    nextCommand: result.nextCommand,
    warning: result.server.warning,
  };
}

function formatStartHuman(
  result: Awaited<ReturnType<typeof startHandoffSetup>>,
  invites: Array<Awaited<ReturnType<typeof createInviteForProfile>>> = [],
): string {
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
    'Notifications:',
    `npx -y handoff-relay watch --profile ${result.profile.profileName} --background`,
  );
  if (invites.length) {
    lines.push('', 'Invites:');
    for (const invite of invites) {
      lines.push(invite.joinCommand);
      if (invite.warning) lines.push(`Warning: ${invite.warning}`);
    }
  } else {
    lines.push('', 'Next:', result.nextCommand);
  }
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
    'Notifications:',
    `npx -y handoff-relay watch --profile ${result.profile.profileName} --background`,
    '',
    'Agent prompt:',
    result.nextAgentInstruction,
  ].join('\n');
}

function formatLeaveHuman(result: Awaited<ReturnType<typeof leaveWorkspaceProfile>>): string {
  if (!result.hadProfile) {
    return `No active Handoff profile named "${result.profileName}". Nothing to leave.`;
  }
  return [
    `Left Handoff workspace ${result.workspaceName} as @${result.handle}.`,
    `Removed local profile credentials for "${result.profileName}".`,
  ].join('\n');
}

function formatRemoveMemberHuman(
  result: Awaited<ReturnType<typeof removeWorkspaceMember>>,
): string {
  if (result.alreadyRemoved) {
    return `@${result.handle} is already removed from ${result.workspaceName}.`;
  }
  return `Removed @${result.handle} from ${result.workspaceName}.`;
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
    lines.push('Install for Claude Code: npx -y handoff-relay start --install-mcp claude');
    lines.push('Install for Cursor: npx -y handoff-relay start --install-mcp cursor');
  } else {
    lines.push(
      `Codex config: ${
        mcp.installCommands.find((command) => command.startsWith('Add to ~/.codex/')) ?? mcp.command
      }`,
    );
    lines.push(
      `Claude Code config: ${
        mcp.installCommands.find((command) => command.startsWith('Add to ~/.claude.json')) ??
        mcp.command
      }`,
    );
    lines.push(
      `Cursor config: ${
        mcp.installCommands.find((command) => command.startsWith('Add to ~/.cursor/')) ??
        mcp.command
      }`,
    );
  }
  return lines;
}
