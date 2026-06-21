import { RelayApiClient } from '../api/client.js';
import { RelayService } from '../service/relay-service.js';
import { createRelayDatabase } from '../storage/database.js';

import type { Command } from 'commander';

export interface CliIo {
  writeOut(chunk: string): void;
  writeErr(chunk: string): void;
}

export interface CommonOptions {
  db?: string;
  json?: boolean;
  profile?: string;
  serverUrl?: string;
  token?: string;
  workspace?: string;
}

export type CliBackend = RelayService | RelayApiClient;

export const defaultIo: CliIo = {
  writeOut: (chunk) => process.stdout.write(chunk),
  writeErr: (chunk) => process.stderr.write(chunk),
};

export function createBackend(options: CommonOptions): CliBackend {
  if (options.serverUrl) {
    return new RelayApiClient({ serverUrl: options.serverUrl });
  }
  return new RelayService(
    createRelayDatabase(options.db ?? process.env.AGENT_RELAY_DB ?? '.relay/relay.db'),
  );
}

export function closeBackend(backend: CliBackend): void {
  if (backend instanceof RelayService) {
    backend.close();
  }
}

export function write(io: CliIo, value: unknown, json?: boolean): void {
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

export function addCommonOptions(command: Command): Command {
  return command
    .option('--db <path>', 'SQLite database path')
    .option('--server-url <url>', 'Relay coordination API URL')
    .option('--json', 'Print JSON output');
}
