import type { Command } from 'commander';

import { formatServerStopHuman } from './server-commands.js';
import { formatDoctorHuman, runDoctorChecks } from '../setup/doctor.js';
import {
  startBackgroundNotificationWatcher,
  stopBackgroundNotificationWatcher,
  type BackgroundNotificationWatcherMetadata,
} from '../notification-watch-lifecycle.js';
import { stopRecordedServer, type StopRecordedServerResult } from '../setup/lifecycle.js';
import {
  uninstallMcpConfigs,
  type McpClientId,
  type McpUninstallSummary,
} from '../setup/mcp-config.js';
import {
  createInviteForProfile,
  deleteLocalProfile,
  joinInvite,
  leaveWorkspaceProfile,
  removeWorkspaceMember,
  startHandoffSetup,
} from '../setup/orchestrator.js';
import { createProfileStore, resolveProfileName } from '../setup/profile.js';
import { write, type CliIo, type CommonOptions } from './shared.js';

type InstallableMcpClient = McpClientId;
type StartNotificationWatcher = typeof startBackgroundNotificationWatcher;
type NotificationWatcherStartResult = Awaited<ReturnType<StartNotificationWatcher>>;
type NotificationWatcherStopResult = Awaited<ReturnType<typeof stopBackgroundNotificationWatcher>>;

export interface SetupCommandOptions {
  io: CliIo;
  startNotificationWatcher?: StartNotificationWatcher;
}

interface SetupNotificationWatcherResult {
  error?: string;
  metadata?: BackgroundNotificationWatcherMetadata;
  profileName: string;
  status: NotificationWatcherStartResult['status'] | 'failed';
}

interface ProfileRuntimeCleanupResult {
  mcp?: McpUninstallSummary;
  notifications: NotificationWatcherStopResult;
  profileName: string;
}

export function registerSetupCommands(program: Command, input: SetupCommandOptions): void {
  const { io, startNotificationWatcher = startBackgroundNotificationWatcher } = input;
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
        const notifications = await startSetupNotificationWatcher({
          profileName: result.profile.profileName,
          startNotificationWatcher,
        });
        write(
          io,
          options.json
            ? startOutput(result, invites, notifications)
            : formatStartHuman(result, invites, notifications),
          options.json,
        );
      },
    );

  program
    .command('stop')
    .description('Stop the local Handoff background server started by start')
    .option('--json', 'Print JSON output')
    .action(async (options: CommonOptions) => {
      const result = await stopRecordedServer(createProfileStore().home);
      write(io, options.json ? result : formatServerStopHuman(result), options.json);
    });

  program
    .command('restart')
    .description('Restart the local Handoff background server for a profile')
    .option('--lan', 'Restart with LAN-reachable invite links')
    .option('--profile <name>', 'Profile name')
    .option('--host <host>', 'Server bind host')
    .option('--port <port>', 'Server port')
    .option('--public-url <url>', 'Public invite base URL')
    .option('--json', 'Print JSON output')
    .action(
      async (
        options: CommonOptions & {
          host?: string;
          lan?: boolean;
          port?: string;
          publicUrl?: string;
        },
      ) => {
        const store = createProfileStore();
        const profileName = resolveProfileName(options.profile);
        const existingProfile = store.loadProfile(profileName);
        const stopped = await stopRecordedServer(store.home);
        const result = await startHandoffSetup({
          host: options.host,
          lan: options.lan ?? existingProfile?.serverMode === 'lan',
          port: options.port ? Number(options.port) : undefined,
          profileName,
          publicUrl: options.publicUrl ?? existingProfile?.publicInviteBaseUrl,
        });
        const notifications = await startSetupNotificationWatcher({
          profileName: result.profile.profileName,
          startNotificationWatcher,
        });
        write(
          io,
          options.json
            ? restartOutput(result, stopped, notifications)
            : formatRestartHuman(result, stopped, notifications),
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
        const notifications = await startSetupNotificationWatcher({
          profileName: result.profile.profileName,
          startNotificationWatcher,
        });
        write(
          io,
          options.json ? joinOutput(result, notifications) : formatJoinHuman(result, notifications),
          options.json,
        );
      },
    );

  program
    .command('leave')
    .description('Leave the active Handoff workspace and remove local profile credentials')
    .option('--keep-mcp', 'Keep local MCP client config entries')
    .option('--profile <name>', 'Profile name')
    .option('--json', 'Print JSON output')
    .action(async (options: CommonOptions & { keepMcp?: boolean }) => {
      const profileName = resolveProfileName(options.profile);
      const result = await leaveWorkspaceProfile({ profileName });
      const cleanup = await cleanupProfileRuntime({
        keepMcp: options.keepMcp,
        profileName,
      });
      write(
        io,
        options.json ? { ...result, cleanup } : formatLeaveHuman(result, cleanup),
        options.json,
      );
    });

  program
    .command('delete-profile')
    .description('Delete a local Handoff profile, credentials, watcher, and MCP config')
    .option('--profile <name>', 'Profile name')
    .option('--keep-mcp', 'Keep local MCP client config entries')
    .option('--delete-data', 'Also delete the local relay database for this profile')
    .option('--json', 'Print JSON output')
    .action(
      async (
        options: CommonOptions & {
          deleteData?: boolean;
          keepMcp?: boolean;
        },
      ) => {
        const profileName = resolveProfileName(options.profile);
        const cleanup = await cleanupProfileRuntime({
          keepMcp: options.keepMcp,
          profileName,
        });
        const result = deleteLocalProfile({
          deleteData: options.deleteData,
          profileName,
        });
        write(
          io,
          options.json
            ? { ...result, cleanup }
            : formatDeleteProfileHuman(result, cleanup, {
                deleteData: Boolean(options.deleteData),
              }),
          options.json,
        );
      },
    );

  program
    .command('uninstall-mcp')
    .description('Remove Handoff MCP config from Codex, Claude Code, Cursor, or all')
    .option('--client <client>', 'codex, claude, cursor, or all', 'all')
    .option('--profile <name>', 'Profile name')
    .option('--json', 'Print JSON output')
    .action(async (options: CommonOptions & { client?: string }) => {
      const profileName = resolveProfileName(options.profile);
      const result = uninstallMcpConfigs({
        clients: parseMcpClientSelector(options.client),
        profileName,
      });
      write(io, options.json ? result : formatMcpUninstallHuman(result), options.json);
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

function parseMcpClientSelector(value: string | undefined): McpClientId[] | undefined {
  if (!value || value === 'all') return undefined;
  if (value === 'codex' || value === 'cursor') return [value];
  if (value === 'claude' || value === 'claude-code') return ['claude-code'];
  throw new Error('Unsupported MCP client. Use --client all, codex, claude, or cursor.');
}

function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

async function cleanupProfileRuntime(input: {
  keepMcp?: boolean;
  profileName: string;
}): Promise<ProfileRuntimeCleanupResult> {
  const store = createProfileStore();
  const notifications = await stopBackgroundNotificationWatcher({
    home: store.home,
    profileName: input.profileName,
  });
  return {
    mcp: input.keepMcp ? undefined : uninstallMcpConfigs({ profileName: input.profileName }),
    notifications,
    profileName: input.profileName,
  };
}

async function startSetupNotificationWatcher(input: {
  profileName: string;
  startNotificationWatcher: StartNotificationWatcher;
}): Promise<SetupNotificationWatcherResult> {
  const store = createProfileStore();
  store.ensureHome();
  try {
    const result = await input.startNotificationWatcher({
      desktopNotifications: true,
      home: store.home,
      intervalMs: 5000,
      profileName: input.profileName,
    });
    return {
      metadata: result.metadata,
      profileName: input.profileName,
      status: result.status,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      profileName: input.profileName,
      status: 'failed',
    };
  }
}

function restartOutput(
  result: Awaited<ReturnType<typeof startHandoffSetup>>,
  stopped: StopRecordedServerResult,
  notifications: SetupNotificationWatcherResult,
) {
  return {
    stopped,
    profile: result.profile.profileName,
    handle: result.profile.handle,
    workspaceName: result.profile.workspaceName,
    serverUrl: result.profile.serverUrl,
    publicInviteBaseUrl: result.profile.publicInviteBaseUrl,
    serverStatus: result.server.status,
    notifications,
    warning: result.server.warning,
  };
}

function startOutput(
  result: Awaited<ReturnType<typeof startHandoffSetup>>,
  invites: Array<Awaited<ReturnType<typeof createInviteForProfile>>> = [],
  notifications: SetupNotificationWatcherResult,
) {
  return {
    profile: result.profile.profileName,
    handle: result.profile.handle,
    workspaceName: result.profile.workspaceName,
    serverUrl: result.profile.serverUrl,
    publicInviteBaseUrl: result.profile.publicInviteBaseUrl,
    serverStatus: result.server.status,
    mcp: result.mcp,
    notifications,
    invites,
    nextCommand: result.nextCommand,
    warning: result.server.warning,
  };
}

function formatStartHuman(
  result: Awaited<ReturnType<typeof startHandoffSetup>>,
  invites: Array<Awaited<ReturnType<typeof createInviteForProfile>>> = [],
  notifications: SetupNotificationWatcherResult,
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
    ...formatNotificationSetupHuman(notifications),
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

function formatRestartHuman(
  result: Awaited<ReturnType<typeof startHandoffSetup>>,
  stopped: StopRecordedServerResult,
  notifications: SetupNotificationWatcherResult,
): string {
  const lines = [
    result.created ? 'Handoff started with a new profile.' : 'Handoff restarted.',
    `Profile: ${result.profile.profileName}`,
    `Handle: @${result.profile.handle}`,
    `Workspace: ${result.profile.workspaceName}`,
    `Server: ${result.profile.serverUrl}`,
    `Server status: ${result.server.status}`,
    `Previous server: ${formatServerStopHuman(stopped)}`,
  ];
  if (result.profile.publicInviteBaseUrl) {
    lines.push(`Invite URL: ${result.profile.publicInviteBaseUrl}`);
  }
  if (result.server.warning) {
    lines.push(`Warning: ${result.server.warning}`);
  }
  lines.push('', ...formatNotificationSetupHuman(notifications));
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

function joinOutput(
  result: Awaited<ReturnType<typeof joinInvite>>,
  notifications: SetupNotificationWatcherResult,
) {
  return {
    profile: result.profile.profileName,
    handle: result.profile.handle,
    workspaceName: result.profile.workspaceName,
    serverUrl: result.profile.serverUrl,
    mcp: result.mcp,
    notifications,
    nextAgentInstruction: result.nextAgentInstruction,
  };
}

function formatJoinHuman(
  result: Awaited<ReturnType<typeof joinInvite>>,
  notifications: SetupNotificationWatcherResult,
): string {
  return [
    `Joined ${result.profile.workspaceName} as @${result.profile.handle}.`,
    `Profile: ${result.profile.profileName}`,
    `Server: ${result.profile.serverUrl}`,
    '',
    ...formatMcpSetupHuman(result.mcp, { missingInstallHint: 'manual' }),
    '',
    ...formatNotificationSetupHuman(notifications),
    '',
    'Agent prompt:',
    result.nextAgentInstruction,
  ].join('\n');
}

function formatNotificationSetupHuman(result: SetupNotificationWatcherResult): string[] {
  if (result.status === 'failed') {
    return [
      'Notifications: could not start automatically.',
      `Reason: ${result.error ?? 'Unknown error'}`,
      `Retry: npx -y handoff-relay watch --profile ${result.profileName} --background`,
      `Opt out: npx -y handoff-relay watch --profile ${result.profileName} --stop`,
    ];
  }
  const profileName = result.metadata?.profileName ?? result.profileName;
  const status =
    result.status === 'already_running'
      ? 'already running in the background.'
      : 'started in the background.';
  return [
    `Notifications: ${status}`,
    `Stop: npx -y handoff-relay watch --profile ${profileName} --stop`,
    `Check: npx -y handoff-relay watch --profile ${profileName} --status`,
  ];
}

function formatLeaveHuman(
  result: Awaited<ReturnType<typeof leaveWorkspaceProfile>>,
  cleanup: ProfileRuntimeCleanupResult,
): string {
  if (!result.hadProfile) {
    return [
      `No active Handoff profile named "${result.profileName}". Nothing to leave.`,
      ...formatProfileRuntimeCleanupHuman(cleanup),
    ].join('\n');
  }
  return [
    `Left Handoff workspace ${result.workspaceName} as @${result.handle}.`,
    `Removed local profile credentials for "${result.profileName}".`,
    ...formatProfileRuntimeCleanupHuman(cleanup),
  ].join('\n');
}

function formatDeleteProfileHuman(
  result: ReturnType<typeof deleteLocalProfile>,
  cleanup: ProfileRuntimeCleanupResult,
  options: { deleteData: boolean },
): string {
  const removedLocalFiles =
    result.hadProfile || result.hadCredentials || result.hadPendingJoinAttempt;
  const lines = removedLocalFiles
    ? [`Deleted local Handoff profile "${result.profileName}".`]
    : [`No local Handoff profile named "${result.profileName}".`];
  if (result.workspaceName && result.handle) {
    lines.push(`Former workspace: ${result.workspaceName} as @${result.handle}`);
    lines.push(
      'Local only: workspace membership was not revoked. Use `handoff leave` when the workspace is reachable.',
    );
  }
  lines.push(...formatProfileRuntimeCleanupHuman(cleanup));
  if (result.localDatabasePath) {
    lines.push(
      options.deleteData
        ? `Local data deleted: ${result.localDatabasePath}`
        : `Local data kept: ${result.localDatabasePath}`,
    );
    if (!options.deleteData) {
      lines.push('Use --delete-data to remove the local relay database too.');
    }
  }
  return lines.join('\n');
}

function formatRemoveMemberHuman(
  result: Awaited<ReturnType<typeof removeWorkspaceMember>>,
): string {
  if (result.alreadyRemoved) {
    return `@${result.handle} is already removed from ${result.workspaceName}.`;
  }
  return `Removed @${result.handle} from ${result.workspaceName}.`;
}

function formatProfileRuntimeCleanupHuman(result: ProfileRuntimeCleanupResult): string[] {
  return [
    formatNotificationStopHuman(result.notifications),
    ...(result.mcp ? formatMcpUninstallHuman(result.mcp).split('\n') : ['MCP cleanup: skipped.']),
  ];
}

function formatNotificationStopHuman(result: NotificationWatcherStopResult): string {
  if (result.status === 'not_found') {
    return 'Notifications: no background watcher recorded.';
  }
  if (result.status === 'not_running') {
    return 'Notifications: watcher was not running; removed stale metadata.';
  }
  if (result.status === 'still_running') {
    return `Notifications: watcher is still running after SIGTERM (pid ${result.metadata?.pid ?? 'unknown'}).`;
  }
  return `Notifications: stopped watcher (pid ${result.metadata?.pid ?? 'unknown'}).`;
}

function formatMcpUninstallHuman(result: McpUninstallSummary): string {
  const removed = result.configs.filter((config) => config.removed);
  const unchanged = result.configs.filter((config) => !config.removed);
  const lines = [`MCP cleanup for profile "${result.profileName}":`];
  if (removed.length) {
    lines.push(`Removed: ${removed.map((config) => config.client).join(', ')}`);
    for (const config of removed) {
      lines.push(`- ${config.client}: ${config.path}`);
    }
  } else {
    lines.push('Removed: none.');
  }
  if (unchanged.length) {
    lines.push(`No Handoff entry: ${unchanged.map((config) => config.client).join(', ')}`);
  }
  return lines.join('\n');
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
