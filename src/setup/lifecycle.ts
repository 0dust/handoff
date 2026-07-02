import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { databaseIdForPath } from '../storage/database-id.js';

export interface EnsureServerInput {
  dbPath: string;
  host: string;
  port: number;
  home: string;
  readinessIntervalMs?: number;
  readinessTimeoutMs?: number;
  serverUrl?: string;
}

export interface EnsureServerResult {
  status: 'reused' | 'skipped' | 'started';
  serverUrl: string;
  bindHost?: string;
  port?: number;
  pid?: number;
  logPath?: string;
  warning?: string;
}

export interface ServerMetadata {
  dbPath: string;
  host: string;
  logPath: string;
  pid?: number;
  port: number;
  serverId?: string;
  serverUrl: string;
  startedAt: string;
}

export interface StopRecordedServerResult {
  logPath?: string;
  pid?: number;
  serverUrl?: string;
  status: 'not_found' | 'not_running' | 'still_running' | 'stopped';
}

export interface ServerLifecycle {
  ensureServer(input: EnsureServerInput): Promise<EnsureServerResult>;
}

export type RecordedServerIdentity =
  | 'legacy_match'
  | 'matched'
  | 'missing_pid'
  | 'mismatch'
  | 'not_found'
  | 'not_running'
  | 'unreachable';

export interface RecordedServerInspection {
  identity: RecordedServerIdentity;
  metadata?: ServerMetadata;
  reachable: boolean;
}

interface HandoffHealth {
  bind_host?: string;
  database_id?: string;
  name?: string;
  ok?: boolean;
  pid?: number;
  server_id?: string;
  version?: string;
}

export interface LanDetectionInput {
  interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>;
  port: number;
}

export function detectLanBaseUrl(input: LanDetectionInput): string | undefined {
  const interfaces = input.interfaces ?? networkInterfaces();
  const addresses = Object.values(interfaces)
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === 'IPv4')
    .filter((entry) => !entry.internal)
    .map((entry) => entry.address);
  const privateAddress = addresses.find(isPrivateIpv4);
  const address = privateAddress ?? addresses[0];
  return address ? `http://${address}:${input.port}` : undefined;
}

export async function findAvailablePort(input: {
  host: string;
  preferredPort: number;
  maxAttempts?: number;
}): Promise<number> {
  const maxAttempts = input.maxAttempts ?? 50;
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const port = candidatePort(input.preferredPort, offset);
    if (await canSafelyListen(input.host, port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting at ${input.preferredPort}.`);
}

export async function probeHandoffServer(
  serverUrl: string,
  input: { expectedDatabaseId?: string; expectedServerId?: string; timeoutMs?: number } = {},
): Promise<boolean> {
  try {
    const body = await readHandoffHealth(serverUrl, input);
    return (
      body.name === 'handoff' &&
      (!input.expectedDatabaseId || body.database_id === input.expectedDatabaseId) &&
      (!input.expectedServerId || body.server_id === input.expectedServerId)
    );
  } catch {
    return false;
  }
}

export async function waitForHandoffServer(
  serverUrl: string,
  input: {
    expectedServerId?: string;
    expectedDatabaseId?: string;
    intervalMs?: number;
    probeTimeoutMs?: number;
    timeoutMs?: number;
  } = {},
): Promise<boolean> {
  const timeoutMs = input.timeoutMs ?? 5_000;
  const intervalMs = input.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    const probeTimeoutMs = Math.max(1, Math.min(input.probeTimeoutMs ?? 1_000, remainingMs));
    if (
      await probeHandoffServer(serverUrl, {
        expectedServerId: input.expectedServerId,
        expectedDatabaseId: input.expectedDatabaseId,
        timeoutMs: probeTimeoutMs,
      })
    ) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

export function createDefaultServerLifecycle(): ServerLifecycle {
  return {
    ensureServer: ensureLocalServer,
  };
}

export async function ensureLocalServer(input: EnsureServerInput): Promise<EnsureServerResult> {
  const expectedDatabaseId = databaseIdForPath(input.dbPath);
  if (input.serverUrl && input.serverUrl !== 'local-db') {
    const savedServer = await inspectReusableHandoffServer({
      expectedDatabaseId,
      input,
      serverUrl: input.serverUrl,
      sourceDescription: `Saved profile server ${input.serverUrl}`,
    });
    if (savedServer) {
      return savedServer;
    }
  }
  if (process.env.HANDOFF_TEST_SKIP_SERVER === '1') {
    return { status: 'skipped', serverUrl: 'local-db' };
  }

  const preferredServer = await inspectPreferredPortHandoffServer(input, expectedDatabaseId);
  if (preferredServer) {
    return preferredServer;
  }

  const port = await findAvailablePort({ host: input.host, preferredPort: input.port });
  const serverUrl = `http://${input.host === '0.0.0.0' ? '127.0.0.1' : input.host}:${port}`;
  const logPath = join(input.home, 'logs', `server-${port}.log`);
  const out = openSync(logPath, 'a');
  const cliPath = resolveCliPath();
  const serverId = `srv_${randomUUID()}`;
  const child = spawn(
    process.execPath,
    [
      cliPath,
      'server',
      'start',
      '--db',
      input.dbPath,
      '--host',
      input.host,
      '--port',
      String(port),
    ],
    {
      detached: true,
      env: { ...process.env, HANDOFF_SERVER_ID: serverId },
      stdio: ['ignore', out, out],
    },
  );
  child.unref();
  closeSync(out);

  const ready = await waitForHandoffServer(serverUrl, {
    expectedDatabaseId,
    expectedServerId: serverId,
    intervalMs: input.readinessIntervalMs,
    timeoutMs: input.readinessTimeoutMs,
  });
  if (!ready) {
    const cleanupStatus = await terminateSpawnedChild(child.pid);
    throw new Error(
      `Handoff server did not become reachable at ${serverUrl} (pid ${child.pid ?? 'unknown'}; cleanup: ${cleanupStatus}). See ${logPath}.`,
    );
  }

  writeServerMetadata(input.home, {
    pid: child.pid,
    dbPath: input.dbPath,
    host: input.host,
    port,
    serverId,
    serverUrl,
    logPath,
    startedAt: new Date().toISOString(),
  });

  return {
    bindHost: input.host,
    status: 'started',
    serverUrl,
    port,
    pid: child.pid,
    logPath,
  };
}

async function inspectPreferredPortHandoffServer(
  input: EnsureServerInput,
  expectedDatabaseId: string,
): Promise<EnsureServerResult | undefined> {
  const serverUrl = loopbackServerUrl(input.host, input.port);
  return inspectReusableHandoffServer({
    expectedDatabaseId,
    input,
    serverUrl,
    sourceDescription: `Port ${input.port}`,
  });
}

async function inspectReusableHandoffServer(options: {
  expectedDatabaseId: string;
  input: EnsureServerInput;
  serverUrl: string;
  sourceDescription: string;
}): Promise<EnsureServerResult | undefined> {
  let health: HandoffHealth;
  try {
    health = await readHandoffHealth(options.serverUrl, { timeoutMs: 1_000 });
  } catch {
    return undefined;
  }
  if (health.name !== 'handoff') {
    return undefined;
  }
  if (!health.database_id) {
    throw new Error(
      `${options.sourceDescription} already has a Handoff server, but this version cannot verify its database. Run \`npx -y handoff-relay stop\`, restart stale Handoff processes, or pass --port <free-port>.`,
    );
  }
  if (health.database_id !== options.expectedDatabaseId) {
    throw new Error(
      `${options.sourceDescription} already has a Handoff server for a different local database. Use --port <free-port> or stop the other Handoff server first.`,
    );
  }
  if (!canReuseHealthyServerAtUrl(options.input, options.serverUrl, health.bind_host)) {
    throw new Error(
      `${options.sourceDescription} already has a matching Handoff server, but it is not LAN-reachable. Stop it first or pass --port <free-port>.`,
    );
  }

  const port = portFromServerUrl(options.serverUrl) ?? options.input.port;
  const host = health.bind_host ?? hostFromServerUrl(options.serverUrl) ?? options.input.host;
  const logPath = join(options.input.home, 'logs', `server-${port}.log`);
  writeServerMetadata(options.input.home, {
    pid: health.pid,
    dbPath: options.input.dbPath,
    host,
    port,
    serverId: health.server_id,
    serverUrl: options.serverUrl,
    logPath,
    startedAt: new Date().toISOString(),
  });
  return {
    bindHost: host,
    status: 'reused',
    serverUrl: options.serverUrl,
    port,
    pid: health.pid,
    logPath,
  };
}

export function readServerMetadata(home: string): ServerMetadata | undefined {
  try {
    return JSON.parse(readFileSync(serverMetadataPath(home), 'utf8')) as ServerMetadata;
  } catch {
    return undefined;
  }
}

export function writeServerMetadata(home: string, metadata: ServerMetadata): void {
  const path = serverMetadataPath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
}

export async function inspectRecordedServer(home: string): Promise<RecordedServerInspection> {
  const metadata = readServerMetadata(home);
  if (!metadata) {
    return { identity: 'not_found', reachable: false };
  }
  return { metadata, ...(await inspectRecordedServerIdentity(metadata)) };
}

export async function stopRecordedServer(home: string): Promise<StopRecordedServerResult> {
  const metadata = readServerMetadata(home);
  if (!metadata) {
    return { status: 'not_found' };
  }

  const result = {
    logPath: metadata.logPath,
    pid: metadata.pid,
    serverUrl: metadata.serverUrl,
  };
  const inspection = await inspectRecordedServerIdentity(metadata);
  if (!inspection.reachable) {
    removeServerMetadata(home);
    return { ...result, status: 'not_running' };
  }
  const pid = metadata.pid;
  if (!pid) {
    removeServerMetadata(home);
    return { ...result, status: 'not_running' };
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    removeServerMetadata(home);
    return { ...result, status: 'not_running' };
  }

  if (await waitForProcessExit(pid)) {
    removeServerMetadata(home);
    return { ...result, status: 'stopped' };
  }
  return { ...result, status: 'still_running' };
}

async function readHandoffHealth(
  serverUrl: string,
  input: { timeoutMs?: number } = {},
): Promise<HandoffHealth> {
  const response = await fetch(`${serverUrl.replace(/\/+$/, '')}/health`, {
    signal: input.timeoutMs ? AbortSignal.timeout(input.timeoutMs) : undefined,
  });
  if (!response.ok) return {};
  return (await response.json()) as HandoffHealth;
}

async function inspectRecordedServerIdentity(
  metadata: ServerMetadata,
): Promise<Omit<RecordedServerInspection, 'metadata'>> {
  if (!metadata.pid) {
    return { identity: 'missing_pid', reachable: false };
  }
  if (!processIsRunning(metadata.pid)) {
    return { identity: 'not_running', reachable: false };
  }
  try {
    const health = await readHandoffHealth(metadata.serverUrl, { timeoutMs: 1_000 });
    if (health.name !== 'handoff') {
      return { identity: 'unreachable', reachable: false };
    }
    if (!metadata.serverId && health.pid === metadata.pid) {
      return { identity: 'legacy_match', reachable: true };
    }
    if (
      metadata.serverId &&
      health.pid === metadata.pid &&
      health.server_id === metadata.serverId
    ) {
      return { identity: 'matched', reachable: true };
    }
    return { identity: 'mismatch', reachable: false };
  } catch {
    return { identity: 'unreachable', reachable: false };
  }
}

function canReuseHealthyServerAtUrl(
  input: EnsureServerInput,
  serverUrl: string | undefined,
  bindHost: string | undefined,
): boolean {
  if (!requiresLanBind(input.host)) return true;
  if (bindHost && !isLoopbackHost(bindHost)) return true;
  const metadata = readServerMetadata(input.home);
  if (metadata?.host && isLoopbackHost(metadata.host)) return false;
  if (isLoopbackUrl(serverUrl)) return false;
  return true;
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(
  pid: number,
  input: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<boolean> {
  const intervalMs = input.intervalMs ?? 50;
  const deadline = Date.now() + (input.timeoutMs ?? 2_000);
  while (Date.now() < deadline) {
    if (!processIsRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return !processIsRunning(pid);
}

async function terminateSpawnedChild(
  pid: number | undefined,
): Promise<'not_running' | 'not_started' | 'still_running' | 'terminated'> {
  if (!pid) return 'not_started';
  if (!processIsRunning(pid)) return 'not_running';
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return 'not_running';
  }
  if (await waitForProcessExit(pid)) return 'terminated';
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return processIsRunning(pid) ? 'still_running' : 'terminated';
  }
  return (await waitForProcessExit(pid, { timeoutMs: 500 })) ? 'terminated' : 'still_running';
}

function removeServerMetadata(home: string): void {
  try {
    unlinkSync(serverMetadataPath(home));
  } catch {
    // The command outcome is still useful if metadata was already gone.
  }
}

function serverMetadataPath(home: string): string {
  return join(home, 'run', 'server.json');
}

function canListen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

async function canSafelyListen(host: string, port: number): Promise<boolean> {
  if (!(await canListen(host, port))) return false;
  if (host === '0.0.0.0') return true;
  return canListen('0.0.0.0', port);
}

function candidatePort(preferredPort: number, offset: number): number {
  const maxPort = 65_535;
  const minFallbackPort = 1_024;
  const port = preferredPort + offset;
  if (port <= maxPort) return port;
  const fallbackRange = maxPort - minFallbackPort + 1;
  return minFallbackPort + ((port - maxPort - 1) % fallbackRange);
}

function loopbackServerUrl(host: string, port: number): string {
  return `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
}

function portFromServerUrl(serverUrl: string): number | undefined {
  try {
    const parsed = new URL(serverUrl);
    if (parsed.port) return Number(parsed.port);
    if (parsed.protocol === 'http:') return 80;
    if (parsed.protocol === 'https:') return 443;
  } catch {
    return undefined;
  }
  return undefined;
}

function hostFromServerUrl(serverUrl: string): string | undefined {
  try {
    return new URL(serverUrl).hostname;
  } catch {
    return undefined;
  }
}

function isPrivateIpv4(address: string): boolean {
  const [a, b] = address.split('.').map((part) => Number(part));
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function requiresLanBind(host: string): boolean {
  return host === '0.0.0.0' || !isLoopbackHost(host);
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function isLoopbackUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return isLoopbackHost(new URL(value).hostname);
  } catch {
    return false;
  }
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
  if (currentDir.endsWith(`${join('dist', 'setup')}`)) {
    return join(currentDir, '..', 'cli.js');
  }
  if (currentDir.endsWith(`${join('src', 'setup')}`)) {
    return join(currentDir, '..', 'cli.ts');
  }
  return join(currentDir, '..', 'cli.js');
}
