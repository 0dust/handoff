import type { Command } from 'commander';

import { startApiServer } from '../api/server.js';
import { startMcpServer as defaultStartMcpServer } from '../mcp/server.js';
import {
  inspectRecordedServer,
  stopRecordedServer,
  type RecordedServerIdentity,
  type ServerMetadata,
  type StopRecordedServerResult,
} from '../setup/lifecycle.js';
import { createProfileStore } from '../setup/profile.js';
import { addCommonOptions, write, type CliIo, type CommonOptions } from './shared.js';

export function registerServerCommands(
  program: Command,
  input: { io: CliIo; startMcpServer?: typeof defaultStartMcpServer },
): void {
  const { io } = input;
  const startMcpServer = input.startMcpServer ?? defaultStartMcpServer;
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
  server
    .command('status')
    .description('Show the recorded local background server')
    .option('--json', 'Print JSON output')
    .action(async (options: CommonOptions) => {
      const result = await serverStatusOutput();
      write(io, options.json ? result : formatServerStatusHuman(result), options.json);
    });
  server
    .command('stop')
    .description('Stop the recorded local background server')
    .option('--json', 'Print JSON output')
    .action(async (options: CommonOptions) => {
      const result = await stopRecordedServer(createProfileStore().home);
      write(io, options.json ? result : formatServerStopHuman(result), options.json);
    });
  addCommonOptions(
    server
      .command('mcp')
      .option('--profile <name>', 'Use a stored Handoff profile')
      .option(
        '--agent-approvals',
        'Allow profile-backed MCP to mint approval tokens after explicit user instruction',
      )
      .option('--explicit-auth', 'Expose authToken and workspaceId in MCP schemas'),
  ).action(
    async (options: CommonOptions & { agentApprovals?: boolean; explicitAuth?: boolean }) => {
      await startMcpServer({
        agentApprovals: options.agentApprovals,
        dbPath: options.db ?? '.relay/relay.db',
        explicitAuth: options.explicitAuth,
        profileName: options.profile,
        serverUrl: options.serverUrl,
      });
    },
  );
}

async function serverStatusOutput(): Promise<{
  home: string;
  identity: RecordedServerIdentity;
  metadata?: ServerMetadata;
  reachable: boolean;
  status: 'not_found' | 'recorded';
}> {
  const store = createProfileStore();
  const inspection = await inspectRecordedServer(store.home);
  return {
    home: store.home,
    identity: inspection.identity,
    metadata: inspection.metadata,
    reachable: inspection.reachable,
    status: inspection.metadata ? 'recorded' : 'not_found',
  };
}

function formatServerStatusHuman(result: Awaited<ReturnType<typeof serverStatusOutput>>): string {
  if (!result.metadata) {
    return `No Handoff background server is recorded for ${result.home}.`;
  }
  const lines = [
    'Handoff background server',
    `Status: ${result.reachable ? 'reachable' : 'not reachable'}`,
    `Recorded identity: ${result.identity}`,
    `URL: ${result.metadata.serverUrl}`,
    `PID: ${result.metadata.pid ?? 'unknown'}`,
    `Database: ${result.metadata.dbPath}`,
    `Log: ${result.metadata.logPath}`,
    `Started: ${result.metadata.startedAt}`,
  ];
  if (!result.reachable) {
    lines.push('Run `npx -y handoff-relay start` to restart it.');
  }
  return lines.join('\n');
}

function formatServerStopHuman(result: StopRecordedServerResult): string {
  if (result.status === 'not_found') {
    return 'No Handoff background server is recorded.';
  }
  if (result.status === 'not_running') {
    return `Recorded Handoff server was not running. Removed stale metadata for ${result.serverUrl}.`;
  }
  if (result.status === 'still_running') {
    return `Handoff server ${result.serverUrl} is still running after SIGTERM. Metadata was kept so you can inspect pid ${result.pid ?? 'unknown'}.`;
  }
  return `Stopped Handoff background server ${result.serverUrl} (pid ${result.pid ?? 'unknown'}).`;
}
