import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { HandoffEnv } from './profile.js';

export type McpClientId = 'claude-code' | 'codex' | 'cursor';
export type McpSetupStatus = 'installed' | 'missing' | 'skipped';

export interface McpClientConfigStatus {
  agentApprovals: boolean;
  client: McpClientId;
  installed: boolean;
  path: string;
  present: boolean;
}

export interface McpClientUninstallStatus {
  client: McpClientId;
  installedAfter: boolean;
  installedBefore: boolean;
  path: string;
  presentAfter: boolean;
  presentBefore: boolean;
  removed: boolean;
}

export interface McpSetupSummary {
  command: string;
  configs: McpClientConfigStatus[];
  installCommands: string[];
  status: McpSetupStatus;
}

export interface McpUninstallSummary {
  configs: McpClientUninstallStatus[];
  profileName: string;
  status: 'missing' | 'removed';
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
  client: McpClientId;
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

  const path =
    input.client === 'claude-code' ? join(home, '.claude.json') : join(home, '.cursor', 'mcp.json');
  mkdirSync(dirname(path), { recursive: true });
  const existing = readJsonMcpConfig(path);
  const next = {
    ...existing,
    mcpServers: {
      ...(existing.mcpServers ?? {}),
      handoff: {
        command: 'npx',
        args: profileMcpArgs(input.profileName),
      },
    },
  };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return configStatus(input.client, path, input.profileName);
}

export function uninstallMcpConfigs(input: {
  clients?: McpClientId[];
  env?: HandoffEnv;
  profileName: string;
}): McpUninstallSummary {
  const clients = input.clients ?? ['codex', 'claude-code', 'cursor'];
  const configs = clients.map((client) =>
    uninstallMcpConfig({ client, env: input.env, profileName: input.profileName }),
  );
  return {
    configs,
    profileName: input.profileName,
    status: configs.some((config) => config.removed) ? 'removed' : 'missing',
  };
}

export function uninstallMcpConfig(input: {
  client: McpClientId;
  env?: HandoffEnv;
  profileName: string;
}): McpClientUninstallStatus {
  const home = input.env?.HOME ?? input.env?.USERPROFILE ?? homedir();
  const path =
    input.client === 'codex'
      ? join(home, '.codex', 'config.toml')
      : input.client === 'claude-code'
        ? join(home, '.claude.json')
        : join(home, '.cursor', 'mcp.json');
  const before = configStatus(input.client, path, input.profileName);
  let removed = false;

  if (input.client === 'codex') {
    removed = uninstallCodexMcpConfig(path, input.profileName);
  } else {
    removed = uninstallJsonMcpConfig(path, input.profileName);
  }

  const after = configStatus(input.client, path, input.profileName);
  return {
    client: input.client,
    installedAfter: after.installed,
    installedBefore: before.installed,
    path,
    presentAfter: after.present,
    presentBefore: before.present,
    removed,
  };
}

export function profileMcpCommand(profileName: string): string {
  return `npx ${profileMcpArgs(profileName).join(' ')}`;
}

function configStatus(
  client: McpClientId,
  path: string,
  profileName: string,
): McpClientConfigStatus {
  const present = existsSync(path);
  const contents = present ? readFileSync(path, 'utf8') : '';
  return {
    agentApprovals: configClientProfileUsesAgentApprovals(client, contents, profileName),
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

function configClientProfileUsesAgentApprovals(
  client: McpClientId,
  contents: string,
  profileName: string,
): boolean {
  if (!configContainsClientProfileCommand(client, contents, profileName)) return false;
  const profileConfig =
    client === 'codex' ? (codexHandoffTable(contents) ?? '') : jsonHandoffConfig(contents);
  return profileConfig.includes('--agent-approvals');
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

function jsonHandoffConfig(contents: string): string {
  if (!contents.trim()) return '';
  try {
    const config = JSON.parse(contents) as { mcpServers?: Record<string, unknown> };
    const handoff = config.mcpServers?.handoff;
    return handoff ? JSON.stringify(handoff) : '';
  } catch {
    return '';
  }
}

function configContainsProfileCommand(contents: string, profileName: string): boolean {
  return (
    containsHandoffPackageToken(contents) &&
    containsHandoffMcpInvocation(contents) &&
    containsProfileArgument(contents, profileName) &&
    !contents.includes('--explicit-auth')
  );
}

function profileMcpArgs(profileName: string): string[] {
  return ['-y', 'handoff-relay', 'server', 'mcp', '--profile', profileName, '--agent-approvals'];
}

function containsHandoffPackageToken(contents: string): boolean {
  return /(^|[\s"',[])(handoff-relay)(?=$|[\s"',\]])/.test(contents);
}

function containsHandoffMcpInvocation(contents: string): boolean {
  return contents.includes('server') && contents.includes('mcp');
}

function containsProfileArgument(contents: string, profileName: string): boolean {
  return new RegExp(
    `--profile(?:(?:["']?\\s*,\\s*["']?)|\\s+)${escapeRegExp(profileName)}(?=$|[\\s"',\\]])`,
  ).test(contents);
}

function configCanBeRemovedForProfile(contents: string, profileName: string): boolean {
  if (!containsHandoffPackageToken(contents) || !containsHandoffMcpInvocation(contents)) {
    return false;
  }
  if (contents.includes('--profile')) {
    return containsProfileArgument(contents, profileName);
  }
  return true;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readJsonMcpConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const contents = readFileSync(path, 'utf8');
  if (!contents.trim()) return {};
  try {
    const parsed = JSON.parse(contents);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Back up below.
  }
  const backupPath = `${path}.handoff-backup`;
  if (!existsSync(backupPath)) {
    writeFileSync(backupPath, contents);
  }
  return {};
}

function uninstallCodexMcpConfig(path: string, profileName: string): boolean {
  if (!existsSync(path)) return false;
  const existing = readFileSync(path, 'utf8');
  const section = codexHandoffTable(existing);
  if (!section || !configCanBeRemovedForProfile(section, profileName)) return false;
  writeFileSync(path, removeCodexHandoffTable(existing));
  return true;
}

function uninstallJsonMcpConfig(path: string, profileName: string): boolean {
  if (!existsSync(path)) return false;
  const existing = readJsonObjectForRemoval(path);
  if (!existing) return false;
  const mcpServers = existing.mcpServers;
  if (!isRecord(mcpServers)) return false;
  const handoff = mcpServers.handoff;
  if (!handoff || !configCanBeRemovedForProfile(JSON.stringify(handoff), profileName)) return false;
  const nextMcpServers = { ...mcpServers };
  delete nextMcpServers.handoff;
  writeFileSync(path, `${JSON.stringify({ ...existing, mcpServers: nextMcpServers }, null, 2)}\n`);
  return true;
}

function readJsonObjectForRemoval(path: string): Record<string, unknown> | undefined {
  const contents = readFileSync(path, 'utf8');
  if (!contents.trim()) return undefined;
  try {
    const parsed = JSON.parse(contents);
    if (isRecord(parsed)) return parsed;
  } catch {
    return undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

function removeCodexHandoffTable(contents: string): string {
  const range = codexHandoffTableRange(contents);
  if (!range) return contents;
  const lines = contents.split('\n');
  const before = lines.slice(0, range.start).join('\n').trimEnd();
  const after = lines.slice(range.end).join('\n').trimStart();
  const parts = [before, after].filter(Boolean);
  return parts.length ? `${parts.join('\n\n')}\n` : '';
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
    if (isTomlTableHeader(trimmed) && !isHandoffTomlTableHeader(trimmed)) {
      end = index;
      break;
    }
  }
  return { end, start };
}

function isTomlTableHeader(trimmed: string): boolean {
  return /^\[[^[\]]+\]$/.test(trimmed) || /^\[\[[^[\]]+\]\]$/.test(trimmed);
}

function isHandoffTomlTableHeader(trimmed: string): boolean {
  const header = trimmed.startsWith('[[') ? trimmed.slice(2, -2) : trimmed.slice(1, -1);
  return header === 'mcp_servers.handoff' || header.startsWith('mcp_servers.handoff.');
}

function installCommands(profileName: string): string[] {
  return [
    `Add to ~/.codex/config.toml: ${profileMcpCommand(profileName)}`,
    `Add to ~/.claude.json: ${profileMcpCommand(profileName)}`,
    `Add to ~/.cursor/mcp.json: ${profileMcpCommand(profileName)}`,
  ];
}

function codexToml(profileName: string): string {
  return [
    '[mcp_servers.handoff]',
    'command = "npx"',
    `args = ["-y", "handoff-relay", "server", "mcp", "--profile", "${profileName}", "--agent-approvals"]`,
    'startup_timeout_sec = 10',
    'tool_timeout_sec = 60',
    'enabled = true',
  ].join('\n');
}
