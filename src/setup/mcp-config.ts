import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { HandoffEnv } from './profile.js';

export type McpClientId = 'claude-code' | 'codex' | 'cursor';
export type McpSetupStatus = 'installed' | 'missing' | 'skipped';

export interface McpClientConfigStatus {
  client: McpClientId;
  installed: boolean;
  path: string;
  present: boolean;
}

export interface McpSetupSummary {
  command: string;
  configs: McpClientConfigStatus[];
  installCommands: string[];
  status: McpSetupStatus;
}

export function summarizeMcpSetup(input: {
  env?: HandoffEnv;
  profileName: string;
  skipped?: boolean;
}): McpSetupSummary {
  const command = profileMcpCommand(input.profileName);
  if (input.skipped) {
    return {
      command,
      configs: detectMcpConfigs({ env: input.env, profileName: input.profileName }),
      installCommands: installCommands(input.profileName),
      status: 'skipped',
    };
  }
  const configs = detectMcpConfigs({ env: input.env, profileName: input.profileName });
  return {
    command,
    configs,
    installCommands: installCommands(input.profileName),
    status: configs.some((config) => config.installed) ? 'installed' : 'missing',
  };
}

export function detectMcpConfigs(input: {
  env?: HandoffEnv;
  profileName: string;
}): McpClientConfigStatus[] {
  const home = input.env?.HOME ?? input.env?.USERPROFILE ?? homedir();
  return [
    configStatus('codex', join(home, '.codex', 'config.toml'), input.profileName),
    configStatus('claude-code', join(home, '.claude.json'), input.profileName),
    configStatus('cursor', join(home, '.cursor', 'mcp.json'), input.profileName),
  ];
}

export function installMcpConfig(input: {
  client: Exclude<McpClientId, 'claude-code'>;
  env?: HandoffEnv;
  profileName: string;
}): McpClientConfigStatus {
  const home = input.env?.HOME ?? input.env?.USERPROFILE ?? homedir();
  if (input.client === 'codex') {
    const path = join(home, '.codex', 'config.toml');
    mkdirSync(dirname(path), { recursive: true });
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (!codexConfigContainsProfileCommand(existing, input.profileName)) {
      writeFileSync(path, upsertCodexHandoffTable(existing, input.profileName));
    }
    return configStatus('codex', path, input.profileName);
  }

  const path = join(home, '.cursor', 'mcp.json');
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const next = {
    ...existing,
    mcpServers: {
      ...(existing.mcpServers ?? {}),
      handoff: {
        command: 'npx',
        args: ['-y', '@0dust/handoff', 'server', 'mcp', '--profile', input.profileName],
      },
    },
  };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return configStatus('cursor', path, input.profileName);
}

export function profileMcpCommand(profileName: string): string {
  return `npx -y @0dust/handoff server mcp --profile ${profileName}`;
}

function configStatus(
  client: McpClientId,
  path: string,
  profileName: string,
): McpClientConfigStatus {
  const present = existsSync(path);
  const contents = present ? readFileSync(path, 'utf8') : '';
  return {
    client,
    installed: configContainsClientProfileCommand(client, contents, profileName),
    path,
    present,
  };
}

function configContainsClientProfileCommand(
  client: McpClientId,
  contents: string,
  profileName: string,
): boolean {
  if (client === 'codex') {
    return codexConfigContainsProfileCommand(contents, profileName);
  }
  return jsonMcpConfigContainsProfileCommand(contents, profileName);
}

function codexConfigContainsProfileCommand(contents: string, profileName: string): boolean {
  const section = codexHandoffTable(contents);
  return section ? configContainsProfileCommand(section, profileName) : false;
}

function jsonMcpConfigContainsProfileCommand(contents: string, profileName: string): boolean {
  if (!contents.trim()) return false;
  try {
    const config = JSON.parse(contents) as { mcpServers?: Record<string, unknown> };
    const handoff = config.mcpServers?.handoff;
    return handoff ? configContainsProfileCommand(JSON.stringify(handoff), profileName) : false;
  } catch {
    return false;
  }
}

function configContainsProfileCommand(contents: string, profileName: string): boolean {
  return (
    contents.includes('@0dust/handoff') &&
    contents.includes('server') &&
    contents.includes('mcp') &&
    contents.includes('--profile') &&
    contents.includes(profileName) &&
    !contents.includes('--explicit-auth')
  );
}

function upsertCodexHandoffTable(contents: string, profileName: string): string {
  const replacement = codexToml(profileName);
  const range = codexHandoffTableRange(contents);
  if (!range) {
    return `${contents.trimEnd()}${contents.trim() ? '\n\n' : ''}${replacement}\n`;
  }
  const lines = contents.split('\n');
  const before = lines.slice(0, range.start).join('\n').trimEnd();
  const after = lines.slice(range.end).join('\n').trimStart();
  return `${before}${before ? '\n\n' : ''}${replacement}${after ? `\n\n${after}` : ''}\n`;
}

function codexHandoffTable(contents: string): string | undefined {
  const range = codexHandoffTableRange(contents);
  if (!range) return undefined;
  return contents.split('\n').slice(range.start, range.end).join('\n');
}

function codexHandoffTableRange(contents: string): { end: number; start: number } | undefined {
  const lines = contents.split('\n');
  const start = lines.findIndex((line) => line.trim() === '[mcp_servers.handoff]');
  if (start === -1) return undefined;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (/^\[[^\]]+\]$/.test(trimmed) && !trimmed.startsWith('[mcp_servers.handoff.')) {
      end = index;
      break;
    }
  }
  return { end, start };
}

function installCommands(profileName: string): string[] {
  return [
    `Add to ~/.codex/config.toml: ${profileMcpCommand(profileName)}`,
    `claude mcp add-json handoff '{"type":"stdio","command":"npx","args":["-y","@0dust/handoff","server","mcp","--profile","${profileName}"]}'`,
    `Add to ~/.cursor/mcp.json: ${profileMcpCommand(profileName)}`,
  ];
}

function codexToml(profileName: string): string {
  return [
    '[mcp_servers.handoff]',
    'command = "npx"',
    `args = ["-y", "@0dust/handoff", "server", "mcp", "--profile", "${profileName}"]`,
    'startup_timeout_sec = 10',
    'tool_timeout_sec = 60',
    'enabled = true',
  ].join('\n');
}
