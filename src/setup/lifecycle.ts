import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface EnsureServerInput {
  dbPath: string;
  host: string;
  port: number;
  home: string;
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

export interface ServerLifecycle {
  ensureServer(input: EnsureServerInput): Promise<EnsureServerResult>;
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
    const port = input.preferredPort + offset;
    if (await canListen(input.host, port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting at ${input.preferredPort}.`);
}

export async function probeHandoffServer(serverUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${serverUrl.replace(/\/+$/, '')}/health`);
    if (!response.ok) return false;
    const body = (await response.json()) as { name?: string };
    return body.name === 'handoff';
  } catch {
    return false;
  }
}

export async function waitForHandoffServer(
  serverUrl: string,
  input: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = input.timeoutMs ?? 5_000;
  const intervalMs = input.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeHandoffServer(serverUrl)) return true;
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
  if (
    input.serverUrl &&
    input.serverUrl !== 'local-db' &&
    (await probeHandoffServer(input.serverUrl)) &&
    canReuseHealthyServer(input)
  ) {
    return {
      bindHost: readServerMetadata(input.home)?.host,
      status: 'reused',
      serverUrl: input.serverUrl,
    };
  }
  if (process.env.HANDOFF_TEST_SKIP_SERVER === '1') {
    return { status: 'skipped', serverUrl: 'local-db' };
  }

  const port = await findAvailablePort({ host: input.host, preferredPort: input.port });
  const serverUrl = `http://${input.host === '0.0.0.0' ? '127.0.0.1' : input.host}:${port}`;
  const logPath = join(input.home, 'logs', `server-${port}.log`);
  const out = openSync(logPath, 'a');
  const cliPath = resolveCliPath();
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
      stdio: ['ignore', out, out],
    },
  );
  child.unref();
  closeSync(out);

  const ready = await waitForHandoffServer(serverUrl);
  if (!ready) {
    throw new Error(`Handoff server did not become reachable at ${serverUrl}. See ${logPath}.`);
  }

  writeFileSync(
    join(input.home, 'run', 'server.json'),
    `${JSON.stringify(
      {
        pid: child.pid,
        dbPath: input.dbPath,
        host: input.host,
        port,
        serverUrl,
        logPath,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  return {
    bindHost: input.host,
    status: 'started',
    serverUrl,
    port,
    pid: child.pid,
    logPath,
  };
}

function canReuseHealthyServer(input: EnsureServerInput): boolean {
  if (!requiresLanBind(input.host)) return true;
  const metadata = readServerMetadata(input.home);
  if (metadata?.host && isLoopbackHost(metadata.host)) return false;
  if (isLoopbackUrl(input.serverUrl)) return false;
  return true;
}

function readServerMetadata(home: string): { host?: string } | undefined {
  const path = join(home, 'run', 'server.json');
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as { host?: string };
  } catch {
    return undefined;
  }
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
