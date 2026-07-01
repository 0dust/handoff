import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sanitizeProfileName } from './setup/profile.js';

export interface BackgroundNotificationWatcherMetadata {
  schemaVersion: 1;
  desktopNotifications: boolean;
  intervalMs: number;
  logPath: string;
  pid?: number;
  profileName: string;
  startedAt: string;
  webhookUrl?: string;
}

export type BackgroundNotificationWatcherStartStatus = 'already_running' | 'started';
export type BackgroundNotificationWatcherStatus = 'not_found' | 'not_running' | 'running';
export type BackgroundNotificationWatcherStopStatus =
  | 'not_found'
  | 'not_running'
  | 'still_running'
  | 'stopped';

export interface BackgroundNotificationWatcherStartInput {
  desktopNotifications: boolean;
  home: string;
  intervalMs: number;
  profileName: string;
  webhookHeaders?: string[];
  webhookUrl?: string;
}

export interface BackgroundNotificationWatcherIdentityInput {
  home: string;
  profileName: string;
}

export interface BackgroundNotificationWatcherDeps {
  cliPath?: string;
  env?: NodeJS.ProcessEnv;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  now?: () => Date;
  processIsRunning?: (pid: number) => boolean;
  spawnDetached?: (
    command: string,
    args: string[],
    options: { detached: true; env: NodeJS.ProcessEnv; stdio: ['ignore', number, number] },
  ) => Pick<ChildProcess, 'pid' | 'unref'>;
  waitForExit?: (pid: number) => Promise<boolean>;
}

export async function startBackgroundNotificationWatcher(
  input: BackgroundNotificationWatcherStartInput,
  deps: BackgroundNotificationWatcherDeps = {},
): Promise<{
  metadata: BackgroundNotificationWatcherMetadata;
  status: BackgroundNotificationWatcherStartStatus;
}> {
  const profileName = sanitizeProfileName(input.profileName);
  const processIsRunning = deps.processIsRunning ?? defaultProcessIsRunning;
  const existing = readBackgroundNotificationWatcherMetadata(input.home, profileName);
  if (existing?.pid && processIsRunning(existing.pid)) {
    return { metadata: existing, status: 'already_running' };
  }
  removeBackgroundNotificationWatcherMetadata(input.home, profileName);

  const logPath = join(input.home, 'logs', `watch-${profileName}.log`);
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(backgroundNotificationWatcherMetadataPath(input.home, profileName)), {
    recursive: true,
    mode: 0o700,
  });

  const out = openSync(logPath, 'a');
  try {
    const spawnDetached = deps.spawnDetached ?? defaultSpawnDetached;
    const child = spawnDetached(process.execPath, buildBackgroundWatcherArgs(input, deps), {
      detached: true,
      env: {
        ...process.env,
        ...(deps.env ?? {}),
        HANDOFF_HOME: input.home,
        HANDOFF_WATCH_BACKGROUND: '1',
      },
      stdio: ['ignore', out, out],
    });
    child.unref();
    const metadata: BackgroundNotificationWatcherMetadata = {
      schemaVersion: 1,
      desktopNotifications: input.desktopNotifications,
      intervalMs: input.intervalMs,
      logPath,
      pid: child.pid,
      profileName,
      startedAt: (deps.now ?? (() => new Date()))().toISOString(),
      webhookUrl: input.webhookUrl,
    };
    writeBackgroundNotificationWatcherMetadata(input.home, metadata);
    return { metadata, status: 'started' };
  } finally {
    closeSync(out);
  }
}

export async function inspectBackgroundNotificationWatcher(
  input: BackgroundNotificationWatcherIdentityInput,
  deps: BackgroundNotificationWatcherDeps = {},
): Promise<{
  metadata?: BackgroundNotificationWatcherMetadata;
  status: BackgroundNotificationWatcherStatus;
}> {
  const profileName = sanitizeProfileName(input.profileName);
  const metadata = readBackgroundNotificationWatcherMetadata(input.home, profileName);
  if (!metadata) return { status: 'not_found' };
  if (metadata.pid && (deps.processIsRunning ?? defaultProcessIsRunning)(metadata.pid)) {
    return { metadata, status: 'running' };
  }
  return { metadata, status: 'not_running' };
}

export async function stopBackgroundNotificationWatcher(
  input: BackgroundNotificationWatcherIdentityInput,
  deps: BackgroundNotificationWatcherDeps = {},
): Promise<{
  metadata?: BackgroundNotificationWatcherMetadata;
  status: BackgroundNotificationWatcherStopStatus;
}> {
  const profileName = sanitizeProfileName(input.profileName);
  const metadata = readBackgroundNotificationWatcherMetadata(input.home, profileName);
  if (!metadata) return { status: 'not_found' };

  const processIsRunning = deps.processIsRunning ?? defaultProcessIsRunning;
  if (!metadata.pid || !processIsRunning(metadata.pid)) {
    removeBackgroundNotificationWatcherMetadata(input.home, profileName);
    return { metadata, status: 'not_running' };
  }

  try {
    (deps.killProcess ?? defaultKillProcess)(metadata.pid, 'SIGTERM');
  } catch {
    removeBackgroundNotificationWatcherMetadata(input.home, profileName);
    return { metadata, status: 'not_running' };
  }

  if (await (deps.waitForExit ?? defaultWaitForExit)(metadata.pid)) {
    removeBackgroundNotificationWatcherMetadata(input.home, profileName);
    return { metadata, status: 'stopped' };
  }
  return { metadata, status: 'still_running' };
}

export function readBackgroundNotificationWatcherMetadata(
  home: string,
  profileName: string,
): BackgroundNotificationWatcherMetadata | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(backgroundNotificationWatcherMetadataPath(home, profileName), 'utf8'),
    ) as BackgroundNotificationWatcherMetadata;
    if (parsed.schemaVersion !== 1) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function backgroundNotificationWatcherMetadataPath(
  home: string,
  profileName: string,
): string {
  return join(home, 'run', `watch-${sanitizeProfileName(profileName)}.json`);
}

function buildBackgroundWatcherArgs(
  input: BackgroundNotificationWatcherStartInput,
  deps: BackgroundNotificationWatcherDeps,
): string[] {
  const args = [
    deps.cliPath ?? resolveCliPath(),
    'watch',
    '--profile',
    sanitizeProfileName(input.profileName),
    '--interval',
    String(input.intervalMs),
  ];
  if (!input.desktopNotifications) {
    args.push('--no-desktop-notifications');
  }
  if (input.webhookUrl) {
    args.push('--webhook-url', input.webhookUrl);
  }
  for (const header of input.webhookHeaders ?? []) {
    args.push('--webhook-header', header);
  }
  return args;
}

function writeBackgroundNotificationWatcherMetadata(
  home: string,
  metadata: BackgroundNotificationWatcherMetadata,
): void {
  const path = backgroundNotificationWatcherMetadataPath(home, metadata.profileName);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
}

function removeBackgroundNotificationWatcherMetadata(home: string, profileName: string): void {
  rmSync(backgroundNotificationWatcherMetadataPath(home, profileName), { force: true });
}

function defaultSpawnDetached(
  command: string,
  args: string[],
  options: { detached: true; env: NodeJS.ProcessEnv; stdio: ['ignore', number, number] },
) {
  return spawn(command, args, options);
}

function defaultKillProcess(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal);
}

function defaultProcessIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function defaultWaitForExit(
  pid: number,
  input: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<boolean> {
  const intervalMs = input.intervalMs ?? 50;
  const deadline = Date.now() + (input.timeoutMs ?? 2_000);
  while (Date.now() < deadline) {
    if (!defaultProcessIsRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return !defaultProcessIsRunning(pid);
}

function resolveCliPath(): string {
  if (process.env.HANDOFF_CLI_PATH) {
    return process.env.HANDOFF_CLI_PATH;
  }
  const currentFile = fileURLToPath(import.meta.url);
  if (basename(currentFile) === 'cli.js') {
    return currentFile;
  }
  const currentDir = dirname(currentFile);
  if (currentDir.endsWith(`${join('dist')}`)) {
    return join(currentDir, 'cli.js');
  }
  if (currentDir.endsWith(`${join('src')}`)) {
    return join(currentDir, 'cli.ts');
  }
  return join(currentDir, 'cli.js');
}
