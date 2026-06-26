import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { buildApiServer } from '../src/api/server.js';
import { RelayApiClient } from '../src/api/client.js';
import { runCli, type CliRunResult } from '../src/cli.js';
import type { BackgroundNotificationWatcherStartInput } from '../src/notification-watch-lifecycle.js';
import {
  createBackendForProfile,
  createInviteForProfile,
  joinInvite,
  removeWorkspaceMember,
  startHandoffSetup,
} from '../src/setup/orchestrator.js';
import { runDoctorChecks } from '../src/setup/doctor.js';
import { buildInviteLink, parseInviteLink } from '../src/setup/invite-link.js';
import {
  detectLanBaseUrl,
  ensureLocalServer,
  findAvailablePort,
  inspectRecordedServer,
  readServerMetadata,
  stopRecordedServer,
  waitForHandoffServer,
  writeServerMetadata,
  type ServerMetadata,
} from '../src/setup/lifecycle.js';
import { detectMcpConfigs, installMcpConfig } from '../src/setup/mcp-config.js';
import { createProfileStore } from '../src/setup/profile.js';
import { RelayService } from '../src/service/relay-service.js';
import { createRelayDatabase } from '../src/storage/database.js';

const openApps: Array<{ close: () => Promise<unknown> }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

async function startProfileBackedApi(dbPath: string) {
  const service = new RelayService(createRelayDatabase(dbPath));
  const app = buildApiServer({ service });
  await app.listen({ host: '127.0.0.1', port: 0 });
  openApps.push(app);
  const address = app.server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP server address');
  }
  return `http://127.0.0.1:${address.port}`;
}

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'handoff-home-'));
}

async function runCliWithImplicitWatcher(
  argv: string[],
): Promise<{ result: CliRunResult; watcherCalls: BackgroundNotificationWatcherStartInput[] }> {
  const watcherCalls: BackgroundNotificationWatcherStartInput[] = [];
  const result = await runCli(argv, {
    setup: {
      startNotificationWatcher: async (input) => {
        watcherCalls.push(input);
        return {
          metadata: {
            schemaVersion: 1,
            desktopNotifications: input.desktopNotifications,
            intervalMs: input.intervalMs,
            logPath: join(input.home, 'logs', `watch-${input.profileName}.log`),
            pid: 4242,
            profileName: input.profileName,
            startedAt: '2026-01-02T03:04:05.000Z',
            webhookUrl: input.webhookUrl,
          },
          status: 'started',
        };
      },
    },
  });
  return { result, watcherCalls };
}

function writeServerMetadataFixture(
  home: string,
  overrides: Partial<{
    dbPath: string;
    host: string;
    includeServerId: boolean;
    logPath: string;
    pid: number;
    port: number;
    serverId: string;
    serverUrl: string;
    startedAt: string;
  }> = {},
) {
  const port = overrides.port ?? 39337;
  const metadata: ServerMetadata = {
    pid: overrides.pid ?? 999999,
    dbPath: overrides.dbPath ?? join(home, 'relay.db'),
    host: overrides.host ?? '127.0.0.1',
    port,
    serverUrl: overrides.serverUrl ?? `http://127.0.0.1:${port}`,
    logPath: overrides.logPath ?? join(home, 'logs', `server-${port}.log`),
    startedAt: overrides.startedAt ?? new Date().toISOString(),
  };
  if (overrides.includeServerId !== false) {
    metadata.serverId = overrides.serverId ?? 'srv_test';
  }
  writeServerMetadata(home, metadata);
}

async function spawnFakeHandoffServer(
  serverId = 'srv_test',
  input: { script?: string; startupTimeoutMs?: number } = {},
) {
  const script =
    input.script ??
    [
      "const http = require('node:http');",
      'const serverId = process.env.HANDOFF_SERVER_ID;',
      'const server = http.createServer((request, response) => {',
      "  if (request.url === '/health') {",
      "    response.writeHead(200, { 'content-type': 'application/json' });",
      "    response.end(JSON.stringify({ name: 'handoff', ok: true, pid: process.pid, server_id: serverId, version: 'test' }));",
      '    return;',
      '  }',
      '  response.writeHead(404).end();',
      '});',
      "server.listen(0, '127.0.0.1', () => console.log(server.address().port));",
      'setInterval(() => {}, 1000);',
    ].join('\n');
  const child = spawn(process.execPath, ['-e', script], {
    env: { ...process.env, HANDOFF_SERVER_ID: serverId },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    let settled = false;
    let stderr = '';
    const startupTimeout = setTimeout(() => {
      fail(`Fake Handoff server timed out before reporting a port.${stderrSuffix(stderr)}`);
    }, input.startupTimeoutMs ?? 1_000);

    function fail(message: string) {
      if (settled) return;
      settled = true;
      clearTimeout(startupTimeout);
      void killChildAndWait(child).then(
        () => reject(new Error(message)),
        () => reject(new Error(message)),
      );
    }

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      fail(`Fake Handoff server failed to start: ${error.message}.${stderrSuffix(stderr)}`);
    });
    child.once('exit', (code, signal) => {
      fail(
        `Fake Handoff server exited before reporting a port (code ${code ?? 'unknown'}, signal ${signal ?? 'unknown'}).${stderrSuffix(stderr)}`,
      );
    });
    child.stdout?.once('data', (chunk: Buffer) => {
      const parsed = Number(chunk.toString('utf8').trim());
      if (!Number.isFinite(parsed)) {
        fail(`Fake Handoff server printed an invalid port.${stderrSuffix(stderr)}`);
        return;
      }
      settled = true;
      clearTimeout(startupTimeout);
      resolve(parsed);
    });
  });
  return {
    child,
    port,
    serverId,
    serverUrl: `http://127.0.0.1:${port}`,
  };
}

function stderrSuffix(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed ? ` Stderr: ${trimmed}` : '';
}

async function killChildAndWait(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL') {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  let onExit: (() => void) | undefined;
  const exited = new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 500);
    onExit = () => {
      clearTimeout(timeout);
      resolve();
    };
    child.once('exit', onExit);
  });
  try {
    process.kill(child.pid, signal);
  } catch {
    if (onExit) child.off('exit', onExit);
    return;
  }
  await exited;
}

async function pidHasExited(pid: number, timeoutMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

describe('profile and credential storage', () => {
  test('start creates a default profile and restrictive credentials in HANDOFF_HOME', async () => {
    const home = tempHome();
    const result = await startHandoffSetup({
      env: { HANDOFF_HOME: home, USER: 'sam' },
      lifecycle: { ensureServer: async () => ({ status: 'skipped', serverUrl: 'local-db' }) },
    });
    const store = createProfileStore({ home });
    const profile = store.loadProfile('default');
    const credentials = store.loadCredentials('default');
    const credentialPath = store.credentialPath('default');
    const mode = statSync(credentialPath).mode & 0o777;

    expect(result.profile.profileName).toBe('default');
    expect(profile?.workspaceId).toMatch(/^wrk_/);
    expect(profile?.localDatabasePath).toContain(home);
    expect(credentials.memberToken).toMatch(/^relay_member_/);
    expect(credentials.approvalSecret).toMatch(/^relay_approval_secret_/);
    expect(mode & 0o077).toBe(0);
    expect(JSON.stringify(result)).not.toContain(credentials.memberToken);
    expect(JSON.stringify(result)).not.toContain(credentials.approvalSecret);
  });

  test('start preserves handles that begin with digits', async () => {
    const home = tempHome();
    const result = await startHandoffSetup({
      env: { HANDOFF_HOME: home, USER: '0dust' },
      lifecycle: { ensureServer: async () => ({ status: 'skipped', serverUrl: 'local-db' }) },
    });

    expect(result.profile.handle).toBe('0dust');
  });

  test('HTTP-backed profiles use the API server instead of opening the local database directly', () => {
    const home = tempHome();
    const dbPath = join(home, 'data', 'default', 'relay.db');
    const db = createRelayDatabase(dbPath);
    db.close();

    const backend = createBackendForProfile({
      credentials: {
        memberToken: 'relay_member_test',
        approvalSecret: 'relay_approval_secret_test',
        createdAt: new Date().toISOString(),
      },
      profile: {
        schemaVersion: 1,
        profileName: 'default',
        workspaceId: 'wrk_test',
        workspaceName: 'Test Workspace',
        memberId: 'mem_test',
        handle: '0dust',
        displayName: '0dust',
        role: 'admin',
        serverUrl: 'http://127.0.0.1:3737',
        localDatabasePath: dbPath,
        serverMode: 'lan',
        createdAt: new Date().toISOString(),
      },
    });

    expect(backend).toBeInstanceOf(RelayApiClient);
  });

  test('start is idempotent and reuses the existing workspace and member', async () => {
    const home = tempHome();
    const starts: string[] = [];
    const first = await startHandoffSetup({
      env: { HANDOFF_HOME: home, USER: 'sam' },
      lifecycle: {
        ensureServer: async (input) => {
          starts.push(input.dbPath);
          return { status: 'started', serverUrl: 'http://127.0.0.1:3737' };
        },
      },
    });
    const second = await startHandoffSetup({
      env: { HANDOFF_HOME: home, USER: 'sam' },
      lifecycle: {
        ensureServer: async (input) => {
          starts.push(input.dbPath);
          return { status: 'reused', serverUrl: 'http://127.0.0.1:3737' };
        },
      },
    });

    expect(second.profile.workspaceId).toBe(first.profile.workspaceId);
    expect(second.profile.memberId).toBe(first.profile.memberId);
    expect(starts).toHaveLength(2);
    expect(second.created).toBe(false);
  });

  test('explicit profile flags override HANDOFF_PROFILE and stored defaults', async () => {
    const home = tempHome();
    await startHandoffSetup({
      profileName: 'work',
      env: { HANDOFF_HOME: home, USER: 'sam' },
      lifecycle: { ensureServer: async () => ({ status: 'skipped', serverUrl: 'local-db' }) },
    });
    await startHandoffSetup({
      profileName: 'personal',
      env: { HANDOFF_HOME: home, HANDOFF_PROFILE: 'work', USER: 'sam' },
      handle: 'samantha',
      lifecycle: { ensureServer: async () => ({ status: 'skipped', serverUrl: 'local-db' }) },
    });

    const store = createProfileStore({ home });
    expect(store.loadActiveProfile({ profileName: 'personal' })?.handle).toBe('samantha');
    expect(
      store.loadActiveProfile({ env: { HANDOFF_HOME: home, HANDOFF_PROFILE: 'work' } })
        ?.profileName,
    ).toBe('work');
  });

  test('HANDOFF_PROFILE environment variable selects the active profile', async () => {
    const home = tempHome();
    await startHandoffSetup({
      profileName: 'default',
      env: { HANDOFF_HOME: home, USER: 'sam' },
      handle: 'sam',
      lifecycle: { ensureServer: async () => ({ status: 'skipped', serverUrl: 'local-db' }) },
    });
    await startHandoffSetup({
      profileName: 'alice',
      env: { HANDOFF_HOME: home, USER: 'alice' },
      handle: 'alice',
      lifecycle: { ensureServer: async () => ({ status: 'skipped', serverUrl: 'local-db' }) },
    });

    const store = createProfileStore({ home });
    expect(
      store.loadActiveProfile({ env: { HANDOFF_HOME: home, HANDOFF_PROFILE: 'alice' } })?.handle,
    ).toBe('alice');
  });

  test('doctor warns when credential permissions are too broad', async () => {
    const home = tempHome();
    await startHandoffSetup({
      env: { HANDOFF_HOME: home, USER: 'sam' },
      lifecycle: { ensureServer: async () => ({ status: 'skipped', serverUrl: 'local-db' }) },
    });
    const store = createProfileStore({ home });
    chmodSync(store.credentialPath('default'), 0o644);

    const report = await runDoctorChecks({ home, profileName: 'default' });

    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'credentials_permissions',
          status: 'WARN',
          fix: expect.stringContaining('chmod 600'),
        }),
      ]),
    );
  });
});

describe('invite, join, LAN, and doctor setup flows', () => {
  test('invite link creation and parsing round trip', () => {
    const link = buildInviteLink({
      baseUrl: 'http://192.168.1.42:3737/',
      inviteToken: 'relay_invite_abc123',
    });

    expect(link).toBe('http://192.168.1.42:3737/invite/relay_invite_abc123');
    expect(parseInviteLink(link)).toEqual({
      inviteToken: 'relay_invite_abc123',
      serverUrl: 'http://192.168.1.42:3737',
    });
    expect(parseInviteLink('relay_invite_raw', 'http://127.0.0.1:3737')).toEqual({
      inviteToken: 'relay_invite_raw',
      serverUrl: 'http://127.0.0.1:3737',
    });
    expect(() => parseInviteLink('relay_invite_raw')).toThrow(/--server-url/);
  });

  test('invite uses the active profile and prints a valid join command without secrets', async () => {
    const home = tempHome();
    const started = await startHandoffSetup({
      env: { HANDOFF_HOME: home, USER: 'sam' },
      lifecycle: { ensureServer: async () => ({ status: 'skipped', serverUrl: 'local-db' }) },
    });
    const serverUrl = await startProfileBackedApi(started.profile.localDatabasePath!);
    const store = createProfileStore({ home });
    store.saveProfile({ ...started.profile, serverUrl, publicInviteBaseUrl: serverUrl });

    const invite = await createInviteForProfile({ home, handle: 'alice' });
    const rerun = await createInviteForProfile({ home, handle: '@alice' });
    const credentials = store.loadCredentials('default');

    expect(invite.joinCommand).toMatch(/^npx -y handoff-relay join http:\/\/127\.0\.0\.1:/);
    expect(parseInviteLink(invite.inviteLink).inviteToken).toMatch(/^relay_invite_/);
    expect(rerun.joinCommand).toBe(invite.joinCommand);
    expect(rerun.inviteLink).toBe(invite.inviteLink);
    expect(invite.expiresAt).toBeTruthy();
    expect(JSON.stringify(invite)).not.toContain(credentials.memberToken);
    expect(JSON.stringify(invite)).not.toContain(credentials.approvalSecret);
  });

  test('join parses an invite URL, accepts it, and saves a usable profile', async () => {
    const hostHome = tempHome();
    const aliceHome = tempHome();
    const started = await startHandoffSetup({
      env: { HANDOFF_HOME: hostHome, USER: 'sam' },
      lifecycle: { ensureServer: async () => ({ status: 'skipped', serverUrl: 'local-db' }) },
    });
    const serverUrl = await startProfileBackedApi(started.profile.localDatabasePath!);
    const hostStore = createProfileStore({ home: hostHome });
    hostStore.saveProfile({ ...started.profile, serverUrl, publicInviteBaseUrl: serverUrl });
    const invite = await createInviteForProfile({ home: hostHome, handle: 'alice' });

    const joined = await joinInvite({
      home: aliceHome,
      env: { HANDOFF_HOME: aliceHome, HOME: aliceHome },
      installMcpClient: 'cursor',
      invite: invite.inviteLink,
      displayName: 'Alice Recipient',
    });
    const aliceStore = createProfileStore({ home: aliceHome });
    const profile = aliceStore.loadProfile('default');
    const credentials = aliceStore.loadCredentials('default');
    const client = joined.backend;
    const inbox = await client.listInbox({
      authToken: credentials.memberToken,
      workspaceId: profile!.workspaceId,
    });

    expect(joined.profile.handle).toBe('alice');
    expect(joined.profile.workspaceId).toBe(started.profile.workspaceId);
    expect(joined.mcp.status).toBe('installed');
    expect(profile?.serverUrl).toBe(serverUrl);
    expect(readFileSync(join(aliceHome, '.cursor', 'mcp.json'), 'utf8')).toContain('handoff-relay');
    expect(inbox).toEqual([]);
  });

  test('CLI join can install Claude Code MCP config explicitly', async () => {
    const hostHome = tempHome();
    const aliceHome = tempHome();
    const started = await startHandoffSetup({
      env: { HANDOFF_HOME: hostHome, USER: 'sam' },
      lifecycle: { ensureServer: async () => ({ status: 'skipped', serverUrl: 'local-db' }) },
    });
    const serverUrl = await startProfileBackedApi(started.profile.localDatabasePath!);
    const hostStore = createProfileStore({ home: hostHome });
    hostStore.saveProfile({ ...started.profile, serverUrl, publicInviteBaseUrl: serverUrl });
    const invite = await createInviteForProfile({ home: hostHome, handle: 'alice' });
    const previousHome = process.env.HANDOFF_HOME;
    const previousUserHome = process.env.HOME;
    process.env.HANDOFF_HOME = aliceHome;
    process.env.HOME = aliceHome;
    try {
      const { result, watcherCalls } = await runCliWithImplicitWatcher([
        'join',
        invite.inviteLink,
        '--install-mcp',
        'claude',
        '--json',
      ]);
      const parsed = JSON.parse(result.stdout);
      const config = JSON.parse(readFileSync(join(aliceHome, '.claude.json'), 'utf8'));

      expect(result.code).toBe(0);
      expect(watcherCalls).toHaveLength(1);
      expect(watcherCalls[0]).toMatchObject({
        desktopNotifications: true,
        home: aliceHome,
        intervalMs: 5000,
        profileName: 'default',
      });
      expect(parsed.notifications).toMatchObject({
        metadata: expect.objectContaining({
          desktopNotifications: true,
          intervalMs: 5000,
          profileName: 'default',
        }),
        status: 'started',
      });
      expect(parsed.mcp.status).toBe('installed');
      expect(parsed.mcp.configs).toContainEqual(
        expect.objectContaining({ client: 'claude-code', installed: true }),
      );
      expect(config.mcpServers.handoff.args).toEqual([
        '-y',
        'handoff-relay',
        'server',
        'mcp',
        '--profile',
        'default',
      ]);
    } finally {
      if (previousHome === undefined) delete process.env.HANDOFF_HOME;
      else process.env.HANDOFF_HOME = previousHome;
      if (previousUserHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousUserHome;
    }
  });

  test('join is safe to rerun after the profile already exists', async () => {
    const hostHome = tempHome();
    const aliceHome = tempHome();
    const started = await startHandoffSetup({
      env: { HANDOFF_HOME: hostHome, USER: 'sam' },
      lifecycle: { ensureServer: async () => ({ status: 'skipped', serverUrl: 'local-db' }) },
    });
    const serverUrl = await startProfileBackedApi(started.profile.localDatabasePath!);
    const hostStore = createProfileStore({ home: hostHome });
    hostStore.saveProfile({ ...started.profile, serverUrl, publicInviteBaseUrl: serverUrl });
    const invite = await createInviteForProfile({ home: hostHome, handle: 'alice' });

    const first = await joinInvite({
      home: aliceHome,
      env: { HANDOFF_HOME: aliceHome, HOME: aliceHome },
      invite: invite.inviteLink,
      displayName: 'Alice Recipient',
    });
    const retry = await joinInvite({
      home: aliceHome,
      env: { HANDOFF_HOME: aliceHome, HOME: aliceHome },
      invite: invite.inviteLink,
      displayName: 'Alice Recipient',
    });

    expect(retry.profile.memberId).toBe(first.profile.memberId);
    expect(retry.profile.workspaceId).toBe(first.profile.workspaceId);
    expect(retry.nextAgentInstruction).toContain('Notifications start automatically');
    expect(retry.nextAgentInstruction).not.toContain('handoff watch --background');
  });

  test('join rerun can finish MCP install after the profile already exists', async () => {
    const hostHome = tempHome();
    const aliceHome = tempHome();
    const started = await startHandoffSetup({
      env: { HANDOFF_HOME: hostHome, USER: 'sam' },
      lifecycle: { ensureServer: async () => ({ status: 'skipped', serverUrl: 'local-db' }) },
    });
    const serverUrl = await startProfileBackedApi(started.profile.localDatabasePath!);
    const hostStore = createProfileStore({ home: hostHome });
    hostStore.saveProfile({ ...started.profile, serverUrl, publicInviteBaseUrl: serverUrl });
    const invite = await createInviteForProfile({ home: hostHome, handle: 'alice' });

    await joinInvite({
      home: aliceHome,
      env: { HANDOFF_HOME: aliceHome, HOME: aliceHome },
      invite: invite.inviteLink,
      displayName: 'Alice Recipient',
    });
    const retry = await joinInvite({
      home: aliceHome,
      env: { HANDOFF_HOME: aliceHome, HOME: aliceHome },
      installMcpClient: 'claude-code',
      invite: invite.inviteLink,
      displayName: 'Alice Recipient',
    });
    const config = JSON.parse(readFileSync(join(aliceHome, '.claude.json'), 'utf8'));

    expect(retry.mcp.status).toBe('installed');
    expect(config.mcpServers.handoff.args).toEqual([
      '-y',
      'handoff-relay',
      'server',
      'mcp',
      '--profile',
      'default',
    ]);
  });

  test('join rejects a different invite when the target profile is already joined', async () => {
    const hostHome = tempHome();
    const aliceHome = tempHome();
    const started = await startHandoffSetup({
      env: { HANDOFF_HOME: hostHome, USER: 'sam' },
      lifecycle: { ensureServer: async () => ({ status: 'skipped', serverUrl: 'local-db' }) },
    });
    const serverUrl = await startProfileBackedApi(started.profile.localDatabasePath!);
    const hostStore = createProfileStore({ home: hostHome });
    hostStore.saveProfile({ ...started.profile, serverUrl, publicInviteBaseUrl: serverUrl });
    const aliceInvite = await createInviteForProfile({ home: hostHome, handle: 'alice' });
    const bobInvite = await createInviteForProfile({ home: hostHome, handle: 'bob' });
    await joinInvite({
      home: aliceHome,
      env: { HANDOFF_HOME: aliceHome, HOME: aliceHome },
      invite: aliceInvite.inviteLink,
      displayName: 'Alice Recipient',
    });

    await expect(
      joinInvite({
        home: aliceHome,
        env: { HANDOFF_HOME: aliceHome, HOME: aliceHome },
        invite: bobInvite.inviteLink,
        displayName: 'Bob Recipient',
      }),
    ).rejects.toThrow(/already joined as @alice/i);
  });

  test('join recovers a pending attempt after remote invite acceptance but before local save', async () => {
    const hostHome = tempHome();
    const aliceHome = tempHome();
    const started = await startHandoffSetup({
      env: { HANDOFF_HOME: hostHome, USER: 'sam' },
      lifecycle: { ensureServer: async () => ({ status: 'skipped', serverUrl: 'local-db' }) },
    });
    const serverUrl = await startProfileBackedApi(started.profile.localDatabasePath!);
    const hostStore = createProfileStore({ home: hostHome });
    hostStore.saveProfile({ ...started.profile, serverUrl, publicInviteBaseUrl: serverUrl });
    const invite = await createInviteForProfile({ home: hostHome, handle: 'alice' });
    const aliceStore = createProfileStore({ home: aliceHome });
    const idempotencyKey = 'relay_join_resume_test';
    aliceStore.savePendingJoinAttempt({
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      displayName: 'Alice Recipient',
      idempotencyKey,
      invite: invite.inviteLink,
      profileName: 'default',
      serverUrl,
    });
    const client = new RelayApiClient({ serverUrl });
    const parsedInvite = parseInviteLink(invite.inviteLink);
    const accepted = await client.acceptInvite({
      displayName: 'Alice Recipient',
      idempotencyKey,
      inviteToken: parsedInvite.inviteToken,
    });
    aliceStore.saveProfile({
      schemaVersion: 1,
      profileName: 'default',
      workspaceId: accepted.workspace.id,
      workspaceName: accepted.workspace.name,
      memberId: accepted.member.id,
      handle: accepted.member.handle,
      displayName: accepted.member.display_name,
      role: accepted.member.role,
      serverUrl,
      serverMode: 'remote',
      createdAt: new Date().toISOString(),
      lastVerifiedAt: new Date().toISOString(),
    });

    const joined = await joinInvite({
      home: aliceHome,
      env: { HANDOFF_HOME: aliceHome, HOME: aliceHome },
      invite: invite.inviteLink,
      displayName: 'Alice Recipient',
    });
    const credentials = aliceStore.loadCredentials('default');

    expect(aliceStore.credentialsExist('default')).toBe(true);
    expect(joined.profile.memberId).toBe(accepted.member.id);
    expect(aliceStore.loadPendingJoinAttempt('default')).toBeUndefined();
    await expect(
      joined.backend.listInbox({
        authToken: credentials.memberToken,
        workspaceId: joined.profile.workspaceId,
      }),
    ).resolves.toEqual([]);
  });

  test('leave revokes the joined member and removes local profile credentials', async () => {
    const hostHome = tempHome();
    const aliceHome = tempHome();
    const started = await startHandoffSetup({
      env: { HANDOFF_HOME: hostHome, USER: 'sam' },
      lifecycle: { ensureServer: async () => ({ status: 'skipped', serverUrl: 'local-db' }) },
    });
    const serverUrl = await startProfileBackedApi(started.profile.localDatabasePath!);
    const hostStore = createProfileStore({ home: hostHome });
    hostStore.saveProfile({ ...started.profile, serverUrl, publicInviteBaseUrl: serverUrl });
    const invite = await createInviteForProfile({ home: hostHome, handle: 'alice' });
    await joinInvite({
      home: aliceHome,
      env: { HANDOFF_HOME: aliceHome, HOME: aliceHome },
      invite: invite.inviteLink,
      displayName: 'Alice Recipient',
    });

    const previousHome = process.env.HOME;
    const previousHandoffHome = process.env.HANDOFF_HOME;
    try {
      process.env.HOME = aliceHome;
      process.env.HANDOFF_HOME = aliceHome;

      const first = await runCli(['leave']);
      const second = await runCli(['leave']);

      const aliceStore = createProfileStore({ home: aliceHome });
      expect(first.code).toBe(0);
      expect(first.stdout).toContain('Left Handoff workspace');
      expect(second.code).toBe(0);
      expect(second.stdout).toContain('No active Handoff profile');
      expect(aliceStore.loadProfile('default')).toBeUndefined();
      expect(aliceStore.credentialsExist('default')).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousHandoffHome === undefined) delete process.env.HANDOFF_HOME;
      else process.env.HANDOFF_HOME = previousHandoffHome;
    }
  });

  test('remove-member removes teammates by handle and is safe to retry', async () => {
    const hostHome = tempHome();
    const aliceHome = tempHome();
    const started = await startHandoffSetup({
      env: { HANDOFF_HOME: hostHome, USER: 'sam' },
      lifecycle: { ensureServer: async () => ({ status: 'skipped', serverUrl: 'local-db' }) },
    });
    const serverUrl = await startProfileBackedApi(started.profile.localDatabasePath!);
    const hostStore = createProfileStore({ home: hostHome });
    hostStore.saveProfile({ ...started.profile, serverUrl, publicInviteBaseUrl: serverUrl });
    const invite = await createInviteForProfile({ home: hostHome, handle: 'alice' });
    await joinInvite({
      home: aliceHome,
      env: { HANDOFF_HOME: aliceHome, HOME: aliceHome },
      invite: invite.inviteLink,
      displayName: 'Alice Recipient',
    });

    const previousHome = process.env.HOME;
    const previousHandoffHome = process.env.HANDOFF_HOME;
    try {
      process.env.HOME = hostHome;
      process.env.HANDOFF_HOME = hostHome;

      const first = await runCli(['remove-member', 'alice']);
      const second = await runCli(['remove-member', '@alice']);

      expect(first.code).toBe(0);
      expect(first.stdout).toContain('Removed @alice');
      expect(second.code).toBe(0);
      expect(second.stdout).toContain('@alice is already removed');
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousHandoffHome === undefined) delete process.env.HANDOFF_HOME;
      else process.env.HANDOFF_HOME = previousHandoffHome;
    }
  });

  test('leave cleans local profile after an admin already removed the member', async () => {
    const hostHome = tempHome();
    const aliceHome = tempHome();
    const started = await startHandoffSetup({
      env: { HANDOFF_HOME: hostHome, USER: 'sam' },
      lifecycle: { ensureServer: async () => ({ status: 'skipped', serverUrl: 'local-db' }) },
    });
    const serverUrl = await startProfileBackedApi(started.profile.localDatabasePath!);
    const hostStore = createProfileStore({ home: hostHome });
    hostStore.saveProfile({ ...started.profile, serverUrl, publicInviteBaseUrl: serverUrl });
    const invite = await createInviteForProfile({ home: hostHome, handle: 'alice' });
    await joinInvite({
      home: aliceHome,
      env: { HANDOFF_HOME: aliceHome, HOME: aliceHome },
      invite: invite.inviteLink,
      displayName: 'Alice Recipient',
    });
    await removeWorkspaceMember({ home: hostHome, member: 'alice' });

    const previousHome = process.env.HOME;
    const previousHandoffHome = process.env.HANDOFF_HOME;
    try {
      process.env.HOME = aliceHome;
      process.env.HANDOFF_HOME = aliceHome;

      const result = await runCli(['leave']);
      const aliceStore = createProfileStore({ home: aliceHome });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Left Handoff workspace');
      expect(aliceStore.loadProfile('default')).toBeUndefined();
      expect(aliceStore.credentialsExist('default')).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousHandoffHome === undefined) delete process.env.HANDOFF_HOME;
      else process.env.HANDOFF_HOME = previousHandoffHome;
    }
  });

  test('leave fails closed when local credentials are missing', async () => {
    const hostHome = tempHome();
    const aliceHome = tempHome();
    const started = await startHandoffSetup({
      env: { HANDOFF_HOME: hostHome, USER: 'sam' },
      lifecycle: { ensureServer: async () => ({ status: 'skipped', serverUrl: 'local-db' }) },
    });
    const serverUrl = await startProfileBackedApi(started.profile.localDatabasePath!);
    const hostStore = createProfileStore({ home: hostHome });
    hostStore.saveProfile({ ...started.profile, serverUrl, publicInviteBaseUrl: serverUrl });
    const invite = await createInviteForProfile({ home: hostHome, handle: 'alice' });
    await joinInvite({
      home: aliceHome,
      env: { HANDOFF_HOME: aliceHome, HOME: aliceHome },
      invite: invite.inviteLink,
      displayName: 'Alice Recipient',
    });
    const aliceStore = createProfileStore({ home: aliceHome });
    rmSync(aliceStore.credentialPath('default'), { force: true });

    const previousHome = process.env.HOME;
    const previousHandoffHome = process.env.HANDOFF_HOME;
    try {
      process.env.HOME = aliceHome;
      process.env.HANDOFF_HOME = aliceHome;

      const result = await runCli(['leave']);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Missing Handoff credentials');
      expect(aliceStore.loadProfile('default')).toBeTruthy();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousHandoffHome === undefined) delete process.env.HANDOFF_HOME;
      else process.env.HANDOFF_HOME = previousHandoffHome;
    }
  });

  test('CLI join output shows the profile-backed MCP command without start install hints', async () => {
    const hostHome = tempHome();
    const aliceHome = tempHome();
    const started = await startHandoffSetup({
      env: { HANDOFF_HOME: hostHome, USER: 'sam' },
      lifecycle: { ensureServer: async () => ({ status: 'skipped', serverUrl: 'local-db' }) },
    });
    const serverUrl = await startProfileBackedApi(started.profile.localDatabasePath!);
    const hostStore = createProfileStore({ home: hostHome });
    hostStore.saveProfile({ ...started.profile, serverUrl, publicInviteBaseUrl: serverUrl });
    const invite = await createInviteForProfile({ home: hostHome, handle: 'alice' });
    const previousHome = process.env.HOME;
    const previousHandoffHome = process.env.HANDOFF_HOME;
    try {
      process.env.HOME = aliceHome;
      process.env.HANDOFF_HOME = aliceHome;

      const { result, watcherCalls } = await runCliWithImplicitWatcher(['join', invite.inviteLink]);

      expect(result.code).toBe(0);
      expect(watcherCalls).toHaveLength(1);
      expect(watcherCalls[0]).toMatchObject({
        desktopNotifications: true,
        home: aliceHome,
        intervalMs: 5000,
        profileName: 'default',
      });
      expect(result.stdout).toContain('Command: npx -y handoff-relay server mcp --profile default');
      expect(result.stdout).toContain('Notifications: started in the background.');
      expect(result.stdout).toContain('handoff-relay watch --profile default --stop');
      expect(result.stdout).not.toContain('watch --profile default --background');
      expect(result.stdout).not.toContain('--desktop-notifications');
      expect(result.stdout).toContain('relay_review_next -> relay_hydrate_approved');
      expect(result.stdout).not.toContain('start --install-mcp');
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousHandoffHome === undefined) delete process.env.HANDOFF_HOME;
      else process.env.HANDOFF_HOME = previousHandoffHome;
    }
  });

  test('doctor reports missing and healthy states, including JSON-safe output', async () => {
    const missingHome = tempHome();
    const missing = await runDoctorChecks({ home: missingHome, profileName: 'default' });
    expect(missing.status).toBe('FAIL');
    expect(missing.checks).toContainEqual(
      expect.objectContaining({
        id: 'active_profile',
        status: 'FAIL',
        fix: expect.stringContaining('handoff-relay start'),
      }),
    );

    const healthyHome = tempHome();
    const started = await startHandoffSetup({
      env: { HANDOFF_HOME: healthyHome, USER: 'sam' },
      lifecycle: { ensureServer: async () => ({ status: 'skipped', serverUrl: 'local-db' }) },
    });
    const report = await runDoctorChecks({
      env: { HOME: healthyHome, HANDOFF_HOME: healthyHome },
      home: healthyHome,
      profileName: 'default',
    });

    expect(report.status).toBe('WARN');
    expect(report.checks.every((check) => check.status !== 'FAIL')).toBe(true);
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: 'mcp_config',
        status: 'WARN',
      }),
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: 'a2a_adapter_ledger',
        status: 'OK',
      }),
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: 'a2a_agent_card',
        status: 'OK',
      }),
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: 'a2a_receive_stub',
        status: 'OK',
      }),
    );
    expect(JSON.parse(JSON.stringify(report)).profile?.workspaceId).toBe(
      started.profile.workspaceId,
    );
  });

  test('doctor validates HTTP Agent Card and disabled A2A receive stub', async () => {
    const home = tempHome();
    const started = await startHandoffSetup({
      env: { HANDOFF_HOME: home, USER: 'sam' },
      lifecycle: { ensureServer: async () => ({ status: 'skipped', serverUrl: 'local-db' }) },
    });
    const serverUrl = await startProfileBackedApi(started.profile.localDatabasePath!);
    const store = createProfileStore({ home });
    store.saveProfile({ ...started.profile, publicInviteBaseUrl: serverUrl, serverUrl });

    const report = await runDoctorChecks({
      env: { HOME: home, HANDOFF_HOME: home },
      home,
      profileName: 'default',
    });

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: 'a2a_agent_card',
        status: 'OK',
      }),
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: 'a2a_receive_stub',
        status: 'OK',
      }),
    );
  });

  test('doctor reports MCP config OK when a supported client config includes profile mode', async () => {
    const home = tempHome();
    await startHandoffSetup({
      env: { HANDOFF_HOME: home, USER: 'sam' },
      lifecycle: { ensureServer: async () => ({ status: 'skipped', serverUrl: 'local-db' }) },
    });
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(
      join(home, '.codex', 'config.toml'),
      [
        '[mcp_servers.handoff]',
        'command = "npx"',
        'args = ["-y", "handoff-relay", "server", "mcp", "--profile", "default"]',
      ].join('\n'),
    );

    const report = await runDoctorChecks({
      env: { HOME: home, HANDOFF_HOME: home },
      home,
      profileName: 'default',
    });

    expect(report.status).toBe('OK');
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: 'mcp_config',
        status: 'OK',
      }),
    );
  });

  test.each(['@0dust/handoff', 'handoff'])(
    'doctor does not accept old npm package command %s as installed MCP config',
    async (packageName) => {
      const home = tempHome();
      const started = await startHandoffSetup({
        env: { HANDOFF_HOME: home, USER: 'sam' },
        lifecycle: { ensureServer: async () => ({ status: 'skipped', serverUrl: 'local-db' }) },
      });
      mkdirSync(join(home, '.codex'), { recursive: true });
      writeFileSync(
        join(home, '.codex', 'config.toml'),
        [
          '[mcp_servers.handoff]',
          'command = "npx"',
          `args = ["-y", "${packageName}", "server", "mcp", "--profile", "default"]`,
        ].join('\n'),
      );

      const report = await runDoctorChecks({
        env: { HOME: home, HANDOFF_HOME: home },
        home,
        profileName: started.profile.profileName,
      });

      expect(report.status).toBe('WARN');
      expect(report.checks).toContainEqual(
        expect.objectContaining({
          id: 'mcp_config',
          status: 'WARN',
        }),
      );
    },
  );

  test('LAN detection prefers a private non-loopback IPv4 address', () => {
    const interfaces = {
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as any],
      en0: [{ address: '192.168.1.42', family: 'IPv4', internal: false } as any],
      utun: [{ address: '100.64.0.2', family: 'IPv4', internal: false } as any],
    };

    expect(detectLanBaseUrl({ port: 3737, interfaces })).toBe('http://192.168.1.42:3737');
  });

  test('LAN start does not publish a LAN invite URL when lifecycle reused loopback server', async () => {
    const home = tempHome();
    const started = await startHandoffSetup({
      env: { HANDOFF_HOME: home, USER: 'sam' },
      lifecycle: {
        ensureServer: async () => ({
          bindHost: '127.0.0.1',
          port: 3737,
          serverUrl: 'http://127.0.0.1:3737',
          status: 'reused',
        }),
      },
    });
    const store = createProfileStore({ home });
    store.saveProfile({
      ...started.profile,
      serverMode: 'local',
      serverUrl: 'http://127.0.0.1:3737',
    });

    const lan = await startHandoffSetup({
      env: { HANDOFF_HOME: home, USER: 'sam' },
      lan: true,
      lifecycle: {
        ensureServer: async () => ({
          bindHost: '127.0.0.1',
          port: 3737,
          serverUrl: 'http://127.0.0.1:3737',
          status: 'reused',
        }),
      },
    });

    expect(lan.profile.publicInviteBaseUrl).toBeUndefined();
    expect(lan.server.warning).toContain('not LAN-reachable');
  });

  test('local start clears stale LAN invite state from an existing profile', async () => {
    const home = tempHome();
    const started = await startHandoffSetup({
      env: { HANDOFF_HOME: home, USER: 'sam' },
      lifecycle: { ensureServer: async () => ({ status: 'skipped', serverUrl: 'local-db' }) },
    });
    const store = createProfileStore({ home });
    store.saveProfile({
      ...started.profile,
      publicInviteBaseUrl: 'http://192.168.1.42:3737',
      serverMode: 'lan',
      serverUrl: 'http://127.0.0.1:3737',
    });

    let localServerUrl = '';
    const local = await startHandoffSetup({
      env: { HANDOFF_HOME: home, USER: 'sam' },
      lifecycle: {
        ensureServer: async (input) => {
          localServerUrl = await startProfileBackedApi(input.dbPath);
          return {
            port: Number(new URL(localServerUrl).port),
            serverUrl: localServerUrl,
            status: 'reused',
          };
        },
      },
    });
    const invite = await createInviteForProfile({ home, handle: 'alice' });

    expect(local.profile.serverMode).toBe('local');
    expect(local.profile.publicInviteBaseUrl).toBeUndefined();
    expect(invite.inviteLink).toContain(`${localServerUrl}/invite/`);
    expect(invite.inviteLink).not.toContain('192.168.1.42');
  });

  test('start preserves an explicit public invite URL for the current invocation', async () => {
    const home = tempHome();
    const publicUrl = 'https://handoff.example.test';

    const started = await startHandoffSetup({
      env: { HANDOFF_HOME: home, USER: 'sam' },
      publicUrl,
      lifecycle: {
        ensureServer: async (input) => {
          const serverUrl = await startProfileBackedApi(input.dbPath);
          return {
            port: Number(new URL(serverUrl).port),
            serverUrl,
            status: 'started',
          };
        },
      },
    });
    const invite = await createInviteForProfile({ home, handle: 'alice' });

    expect(started.profile.serverMode).toBe('local');
    expect(started.profile.publicInviteBaseUrl).toBe(publicUrl);
    expect(invite.inviteLink).toContain(`${publicUrl}/invite/`);
  });

  test('start rejects a joined remote profile instead of converting it to local state', async () => {
    const home = tempHome();
    const store = createProfileStore({ home });
    const remoteProfile = {
      schemaVersion: 1 as const,
      profileName: 'default',
      workspaceId: 'workspace_remote',
      workspaceName: 'Remote Workspace',
      memberId: 'member_remote',
      handle: 'alice',
      displayName: 'Alice',
      role: 'member' as const,
      serverUrl: 'https://handoff.example.test',
      serverMode: 'remote' as const,
      createdAt: new Date().toISOString(),
      lastVerifiedAt: new Date().toISOString(),
    };
    store.saveProfile(remoteProfile);
    store.saveCredentials('default', {
      memberToken: 'relay_member_remote',
      approvalSecret: 'relay_approval_secret_remote',
      createdAt: new Date().toISOString(),
    });

    await expect(
      startHandoffSetup({
        env: { HANDOFF_HOME: home, USER: 'alice' },
        lifecycle: { ensureServer: async () => ({ status: 'skipped', serverUrl: 'local-db' }) },
      }),
    ).rejects.toThrow(/joined to a remote Handoff server/);
    expect(store.loadProfile('default')).toEqual(remoteProfile);
  });

  test('port conflict handling chooses a different free port when preferred is occupied', async () => {
    const blocker = createServer((_request, response) => {
      response.writeHead(200).end('not handoff');
    });
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const address = blocker.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP server address');
    }
    try {
      const selected = await findAvailablePort({
        host: '127.0.0.1',
        preferredPort: address.port,
      });
      expect(selected).not.toBe(address.port);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  test('port conflict handling skips wildcard listeners when binding loopback', async () => {
    const blocker = createServer((_request, response) => {
      response.writeHead(200).end('not handoff');
    });
    await new Promise<void>((resolve) => blocker.listen(0, '0.0.0.0', resolve));
    const address = blocker.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP server address');
    }
    try {
      const selected = await findAvailablePort({
        host: '127.0.0.1',
        preferredPort: address.port,
      });
      expect(selected).not.toBe(address.port);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  test('readiness polling rejects a different Handoff server identity', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            name: 'handoff',
            ok: true,
            pid: process.pid,
            server_id: 'srv_other',
            version: 'test',
          }),
        );
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP server address');
    }
    try {
      await expect(
        waitForHandoffServer(`http://127.0.0.1:${address.port}`, {
          expectedServerId: 'srv_expected',
          intervalMs: 25,
          timeoutMs: 100,
        }),
      ).resolves.toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('readiness polling respects the overall timeout when health responses hang', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/health') {
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP server address');
    }
    const startedAt = Date.now();
    try {
      await expect(
        waitForHandoffServer(`http://127.0.0.1:${address.port}`, {
          intervalMs: 25,
          probeTimeoutMs: 50,
          timeoutMs: 200,
        }),
      ).resolves.toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('failed local server startup terminates the spawned child and does not write metadata', async () => {
    const home = tempHome();
    const store = createProfileStore({ home });
    store.ensureHome();
    const dbPath = store.localDatabasePath('default');
    mkdirSync(join(home, 'data', 'default'), { recursive: true });
    const fakeCliPath = join(home, 'fake-handoff-cli.js');
    writeFileSync(fakeCliPath, 'setInterval(() => {}, 1000);\n');
    const previousCliPath = process.env.HANDOFF_CLI_PATH;

    let error: unknown;
    try {
      process.env.HANDOFF_CLI_PATH = fakeCliPath;
      error = await ensureLocalServer({
        dbPath,
        home,
        host: '127.0.0.1',
        port: 39340,
        readinessIntervalMs: 1,
        readinessTimeoutMs: 50,
      }).catch((caught: unknown) => caught);
    } finally {
      if (previousCliPath === undefined) {
        delete process.env.HANDOFF_CLI_PATH;
      } else {
        process.env.HANDOFF_CLI_PATH = previousCliPath;
      }
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('Handoff server did not become reachable at http://127.0.0.1:');
    expect(message).toContain('cleanup: terminated');
    expect(message).toContain(join(home, 'logs'));
    expect(readServerMetadata(home)).toBeUndefined();

    const pid = Number(message.match(/pid (\d+)/)?.[1]);
    expect(Number.isFinite(pid)).toBe(true);
    expect(await pidHasExited(pid)).toBe(true);
  });

  test('server metadata can be inspected and stale records are cleaned up', async () => {
    const home = tempHome();
    writeServerMetadataFixture(home);

    expect(readServerMetadata(home)?.serverUrl).toBe('http://127.0.0.1:39337');
    await expect(stopRecordedServer(home)).resolves.toMatchObject({ status: 'not_running' });
    expect(readServerMetadata(home)).toBeUndefined();
  });

  test('fake Handoff server helper rejects with stderr when startup exits early', async () => {
    await expect(
      spawnFakeHandoffServer('srv_broken_test', {
        script: "console.error('intentional fake server failure'); process.exit(7);",
        startupTimeoutMs: 500,
      }),
    ).rejects.toThrow(/code 7.*intentional fake server failure/);
  });

  test('fake Handoff server helper rejects when startup never reports a port', async () => {
    await expect(
      spawnFakeHandoffServer('srv_hanging_test', {
        script: 'setInterval(() => {}, 1000);',
        startupTimeoutMs: 50,
      }),
    ).rejects.toThrow(/timed out before reporting a port/);
  });

  test('fake Handoff server helper rejects when startup prints a non-numeric port', async () => {
    await expect(
      spawnFakeHandoffServer('srv_invalid_port_test', {
        script: "console.log('not-a-port'); setInterval(() => {}, 1000);",
        startupTimeoutMs: 500,
      }),
    ).rejects.toThrow(/printed an invalid port/);
  });

  test('server stop does not terminate an arbitrary process from stale metadata', async () => {
    const home = tempHome();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    await new Promise<void>((resolve) => child.once('spawn', resolve));
    try {
      if (!child.pid) {
        throw new Error('Expected child pid');
      }
      writeServerMetadataFixture(home, { pid: child.pid });

      await expect(stopRecordedServer(home)).resolves.toMatchObject({
        pid: child.pid,
        status: 'not_running',
      });
      expect(readServerMetadata(home)).toBeUndefined();
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
    } finally {
      await killChildAndWait(child);
    }
  });

  test('server stop accepts legacy metadata when the health pid matches', async () => {
    const home = tempHome();
    const server = await spawnFakeHandoffServer('srv_legacy_recorded_test');
    const child = server.child;
    try {
      if (!child.pid) {
        throw new Error('Expected child pid');
      }
      writeServerMetadataFixture(home, {
        includeServerId: false,
        pid: child.pid,
        port: server.port,
        serverUrl: server.serverUrl,
      });

      await expect(inspectRecordedServer(home)).resolves.toMatchObject({
        identity: 'legacy_match',
        reachable: true,
      });
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      await expect(stopRecordedServer(home)).resolves.toMatchObject({
        pid: child.pid,
        status: 'stopped',
      });
      expect(readServerMetadata(home)).toBeUndefined();
      await exited;
    } finally {
      await killChildAndWait(child);
    }
  });

  test('server stop terminates the recorded matching Handoff server', async () => {
    const home = tempHome();
    const server = await spawnFakeHandoffServer('srv_recorded_test');
    const child = server.child;
    try {
      if (!child.pid) {
        throw new Error('Expected child pid');
      }
      writeServerMetadataFixture(home, {
        pid: child.pid,
        port: server.port,
        serverId: server.serverId,
        serverUrl: server.serverUrl,
      });

      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      await expect(stopRecordedServer(home)).resolves.toMatchObject({
        pid: child.pid,
        status: 'stopped',
      });
      expect(readServerMetadata(home)).toBeUndefined();
      await exited;
    } finally {
      await killChildAndWait(child);
    }
  });

  test('CLI doctor --json reports missing profile as machine-readable failures', async () => {
    const home = tempHome();
    const previous = process.env.HANDOFF_HOME;
    process.env.HANDOFF_HOME = home;
    try {
      const result = await runCli(['doctor', '--json']);
      const parsed = JSON.parse(result.stdout);

      expect(result.code).toBe(0);
      expect(parsed.status).toBe('FAIL');
      expect(parsed.checks).toContainEqual(
        expect.objectContaining({ id: 'active_profile', status: 'FAIL' }),
      );
    } finally {
      if (previous === undefined) {
        delete process.env.HANDOFF_HOME;
      } else {
        process.env.HANDOFF_HOME = previous;
      }
    }
  });

  test('CLI start --json redacts secrets and writes setup files under HANDOFF_HOME', async () => {
    const home = tempHome();
    const previous = process.env.HANDOFF_HOME;
    process.env.HANDOFF_HOME = home;
    process.env.HANDOFF_TEST_SKIP_SERVER = '1';
    try {
      const { result, watcherCalls } = await runCliWithImplicitWatcher(['start', '--json']);
      const parsed = JSON.parse(result.stdout);
      const credentialFile = join(home, 'credentials', 'default.json');
      const credentials = JSON.parse(readFileSync(credentialFile, 'utf8'));

      expect(result.code).toBe(0);
      expect(watcherCalls).toHaveLength(1);
      expect(watcherCalls[0]).toMatchObject({
        desktopNotifications: true,
        home,
        intervalMs: 5000,
        profileName: 'default',
      });
      expect(parsed.profile).toBe('default');
      expect(parsed.notifications).toMatchObject({
        metadata: expect.objectContaining({
          desktopNotifications: true,
          intervalMs: 5000,
          profileName: 'default',
        }),
        status: 'started',
      });
      expect(parsed.workspaceName).toBeTruthy();
      expect(existsSync(credentialFile)).toBe(true);
      expect(result.stdout).not.toContain(credentials.memberToken);
      expect(result.stdout).not.toContain(credentials.approvalSecret);
    } finally {
      delete process.env.HANDOFF_TEST_SKIP_SERVER;
      if (previous === undefined) {
        delete process.env.HANDOFF_HOME;
      } else {
        process.env.HANDOFF_HOME = previous;
      }
    }
  });

  test('CLI start succeeds and reports when automatic notifications cannot start', async () => {
    const home = tempHome();
    const previous = process.env.HANDOFF_HOME;
    process.env.HANDOFF_HOME = home;
    process.env.HANDOFF_TEST_SKIP_SERVER = '1';
    try {
      const result = await runCli(['start', '--json'], {
        setup: {
          startNotificationWatcher: async () => {
            throw new Error('notification process blocked');
          },
        },
      });
      const parsed = JSON.parse(result.stdout);

      expect(result.code).toBe(0);
      expect(parsed.profile).toBe('default');
      expect(parsed.notifications).toMatchObject({
        error: 'notification process blocked',
        profileName: 'default',
        status: 'failed',
      });
    } finally {
      delete process.env.HANDOFF_TEST_SKIP_SERVER;
      if (previous === undefined) {
        delete process.env.HANDOFF_HOME;
      } else {
        process.env.HANDOFF_HOME = previous;
      }
    }
  });

  test('CLI start --invite creates initial invites and reuses them on rerun', async () => {
    const home = tempHome();
    const previous = process.env.HANDOFF_HOME;
    process.env.HANDOFF_HOME = home;
    process.env.HANDOFF_TEST_SKIP_SERVER = '1';
    try {
      const first = (await runCliWithImplicitWatcher(['start', '--invite', 'alice', '--json']))
        .result;
      const second = (await runCliWithImplicitWatcher(['start', '--invite', '@alice', '--json']))
        .result;
      const human = (await runCliWithImplicitWatcher(['start', '--invite', 'alice'])).result;

      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      expect(human.code).toBe(0);

      const firstParsed = JSON.parse(first.stdout);
      const secondParsed = JSON.parse(second.stdout);

      expect(firstParsed.invites).toHaveLength(1);
      expect(firstParsed.notifications.status).toBe('started');
      expect(firstParsed.invites[0]).toMatchObject({
        handle: 'alice',
        joinCommand: expect.stringContaining('npx -y handoff-relay join '),
      });
      expect(secondParsed.invites[0].inviteLink).toBe(firstParsed.invites[0].inviteLink);
      expect(secondParsed.invites[0].joinCommand).toBe(firstParsed.invites[0].joinCommand);
      expect(human.stdout).toContain('Warning: This invite link is loopback-only.');
    } finally {
      delete process.env.HANDOFF_TEST_SKIP_SERVER;
      if (previous === undefined) {
        delete process.env.HANDOFF_HOME;
      } else {
        process.env.HANDOFF_HOME = previous;
      }
    }
  });

  test('CLI start can install Codex MCP config explicitly', async () => {
    const home = tempHome();
    const previousHome = process.env.HANDOFF_HOME;
    const previousUserHome = process.env.HOME;
    process.env.HANDOFF_HOME = home;
    process.env.HOME = home;
    process.env.HANDOFF_TEST_SKIP_SERVER = '1';
    try {
      const { result } = await runCliWithImplicitWatcher([
        'start',
        '--install-mcp',
        'codex',
        '--json',
      ]);
      const config = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
      const parsed = JSON.parse(result.stdout);

      expect(result.code).toBe(0);
      expect(parsed.mcp.status).toBe('installed');
      expect(config).toContain('handoff-relay');
      expect(config).toContain('--profile');
      expect(config).toContain('default');
    } finally {
      delete process.env.HANDOFF_TEST_SKIP_SERVER;
      if (previousHome === undefined) delete process.env.HANDOFF_HOME;
      else process.env.HANDOFF_HOME = previousHome;
      if (previousUserHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousUserHome;
    }
  });

  test('CLI start can install Claude Code MCP config explicitly', async () => {
    const home = tempHome();
    const previousHome = process.env.HANDOFF_HOME;
    const previousUserHome = process.env.HOME;
    process.env.HANDOFF_HOME = home;
    process.env.HOME = home;
    process.env.HANDOFF_TEST_SKIP_SERVER = '1';
    try {
      const { result } = await runCliWithImplicitWatcher([
        'start',
        '--install-mcp',
        'claude',
        '--json',
      ]);
      const config = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
      const parsed = JSON.parse(result.stdout);

      expect(result.code).toBe(0);
      expect(parsed.mcp.status).toBe('installed');
      expect(parsed.mcp.configs).toContainEqual(
        expect.objectContaining({ client: 'claude-code', installed: true }),
      );
      expect(config.mcpServers.handoff).toEqual({
        command: 'npx',
        args: ['-y', 'handoff-relay', 'server', 'mcp', '--profile', 'default'],
      });
    } finally {
      delete process.env.HANDOFF_TEST_SKIP_SERVER;
      if (previousHome === undefined) delete process.env.HANDOFF_HOME;
      else process.env.HANDOFF_HOME = previousHome;
      if (previousUserHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousUserHome;
    }
  });

  test('Codex MCP install replaces an existing explicit-auth Handoff table', () => {
    const home = tempHome();
    mkdirSync(join(home, '.codex'), { recursive: true });
    const configPath = join(home, '.codex', 'config.toml');
    writeFileSync(
      configPath,
      [
        '[workspace]',
        'trusted = true',
        '',
        '[mcp_servers.handoff]',
        'command = "npx"',
        'args = ["-y", "handoff-relay", "server", "mcp", "--explicit-auth"]',
        'startup_timeout_sec = 10',
        '',
        '[mcp_servers.other]',
        'command = "other-tool"',
      ].join('\n'),
    );

    const status = installMcpConfig({
      client: 'codex',
      env: { HOME: home },
      profileName: 'default',
    });
    const config = readFileSync(configPath, 'utf8');

    expect(status.installed).toBe(true);
    expect(config.match(/^\[mcp_servers\.handoff\]$/gm)).toHaveLength(1);
    expect(config).toContain(
      'args = ["-y", "handoff-relay", "server", "mcp", "--profile", "default"]',
    );
    expect(config).not.toContain('--explicit-auth');
    expect(config).toContain('[mcp_servers.other]');
  });

  test('Claude Code MCP install preserves unrelated user config and replaces legacy Handoff entry', () => {
    const home = tempHome();
    const configPath = join(home, '.claude.json');
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          theme: 'dark',
          mcpServers: {
            handoff: {
              command: 'npx',
              args: ['-y', 'handoff-relay', 'server', 'mcp', '--explicit-auth'],
            },
            github: {
              command: 'gh',
              args: ['mcp', 'server'],
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const status = installMcpConfig({
      client: 'claude-code',
      env: { HOME: home },
      profileName: 'default',
    });
    const config = JSON.parse(readFileSync(configPath, 'utf8'));

    expect(status).toMatchObject({ client: 'claude-code', installed: true });
    expect(config.theme).toBe('dark');
    expect(config.mcpServers.github).toEqual({ command: 'gh', args: ['mcp', 'server'] });
    expect(config.mcpServers.handoff).toEqual({
      command: 'npx',
      args: ['-y', 'handoff-relay', 'server', 'mcp', '--profile', 'default'],
    });
  });

  test('Claude Code MCP install backs up malformed JSON config and writes a valid entry', () => {
    const home = tempHome();
    const configPath = join(home, '.claude.json');
    const malformed = '{ "mcpServers": {';
    writeFileSync(configPath, malformed);

    const status = installMcpConfig({
      client: 'claude-code',
      env: { HOME: home },
      profileName: 'default',
    });
    const rerun = installMcpConfig({
      client: 'claude-code',
      env: { HOME: home },
      profileName: 'default',
    });
    const config = JSON.parse(readFileSync(configPath, 'utf8'));

    expect(status).toMatchObject({ client: 'claude-code', installed: true });
    expect(rerun).toMatchObject({ client: 'claude-code', installed: true });
    expect(readFileSync(`${configPath}.handoff-backup`, 'utf8')).toBe(malformed);
    expect(config.mcpServers.handoff).toEqual({
      command: 'npx',
      args: ['-y', 'handoff-relay', 'server', 'mcp', '--profile', 'default'],
    });
  });

  test('JSON MCP detection ignores explicit-auth on unrelated servers', () => {
    const home = tempHome();
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(
      join(home, '.cursor', 'mcp.json'),
      `${JSON.stringify(
        {
          mcpServers: {
            legacy: {
              command: 'npx',
              args: ['-y', 'handoff-relay', 'server', 'mcp', '--explicit-auth'],
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      join(home, '.claude.json'),
      `${JSON.stringify(
        {
          mcpServers: {
            handoff: {
              command: 'npx',
              args: ['-y', 'handoff-relay', 'server', 'mcp', '--profile', 'default'],
            },
            legacy: {
              command: 'npx',
              args: ['-y', 'handoff-relay', 'server', 'mcp', '--explicit-auth'],
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const cursorStatus = installMcpConfig({
      client: 'cursor',
      env: { HOME: home },
      profileName: 'default',
    });
    const statuses = detectMcpConfigs({ env: { HOME: home }, profileName: 'default' });

    expect(cursorStatus.installed).toBe(true);
    expect(statuses).toContainEqual(expect.objectContaining({ client: 'cursor', installed: true }));
    expect(statuses).toContainEqual(
      expect.objectContaining({ client: 'claude-code', installed: true }),
    );
  });

  test('start --foreground is rejected instead of spawning a misleading background server', async () => {
    const home = tempHome();
    const previous = process.env.HANDOFF_HOME;
    process.env.HANDOFF_HOME = home;
    process.env.HANDOFF_TEST_SKIP_SERVER = '1';
    try {
      const result = await runCli(['start', '--foreground']);

      expect(result.code).toBe(1);
    } finally {
      delete process.env.HANDOFF_TEST_SKIP_SERVER;
      if (previous === undefined) {
        delete process.env.HANDOFF_HOME;
      } else {
        process.env.HANDOFF_HOME = previous;
      }
    }
  });
});

describe('profile-backed approval tokens', () => {
  test('share-with and inbox resolve auth from the active profile by default', async () => {
    const home = tempHome();
    const started = await startHandoffSetup({
      env: { HANDOFF_HOME: home, USER: 'sam' },
      lifecycle: { ensureServer: async () => ({ status: 'skipped', serverUrl: 'local-db' }) },
    });
    const previous = process.env.HANDOFF_HOME;
    process.env.HANDOFF_HOME = home;
    try {
      const share = await runCli([
        'share-with',
        `@${started.profile.handle}`,
        '--finding',
        'Profile-backed CLI should not need raw auth flags.',
        '--title',
        'Profile CLI',
        '--summary',
        'The CLI resolves token and workspace from the active profile.',
        '--json',
      ]);
      const inbox = await runCli(['inbox', '--json']);

      expect(share.code).toBe(0);
      expect(JSON.parse(share.stdout).packet.status).toBe('pending_sender_approval');
      expect(inbox.code).toBe(0);
      expect(JSON.parse(inbox.stdout)).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.HANDOFF_HOME;
      else process.env.HANDOFF_HOME = previous;
    }
  });

  test('approval-token loads member token and approval secret from the active profile', async () => {
    const home = tempHome();
    const started = await startHandoffSetup({
      env: { HANDOFF_HOME: home, USER: 'sam' },
      lifecycle: { ensureServer: async () => ({ status: 'skipped', serverUrl: 'local-db' }) },
    });
    const service = new RelayService(createRelayDatabase(started.profile.localDatabasePath!));
    try {
      const draft = service.createShareDraft({
        authToken: createProfileStore({ home }).loadCredentials('default').memberToken,
        workspaceId: started.profile.workspaceId,
        to: `@${started.profile.handle}`,
        finding: 'Profile-backed approval should work.',
        title: 'Approval token',
        summary: 'The CLI should not require explicit secrets.',
        sourceClient: 'codex',
      });
      const previous = process.env.HANDOFF_HOME;
      const previousApproval = process.env.AGENT_RELAY_ASSUME_HUMAN_APPROVAL;
      process.env.HANDOFF_HOME = home;
      process.env.AGENT_RELAY_ASSUME_HUMAN_APPROVAL = '1';
      try {
        const result = await runCli(['approval-token', draft.id, '--action', 'send', '--json']);
        const parsed = JSON.parse(result.stdout);

        expect(result.code).toBe(0);
        expect(parsed.approval_token).toMatch(/^relay_approval_/);
        expect(result.stdout).not.toContain('relay_approval_secret_');
      } finally {
        if (previous === undefined) delete process.env.HANDOFF_HOME;
        else process.env.HANDOFF_HOME = previous;
        if (previousApproval === undefined) delete process.env.AGENT_RELAY_ASSUME_HUMAN_APPROVAL;
        else process.env.AGENT_RELAY_ASSUME_HUMAN_APPROVAL = previousApproval;
      }
    } finally {
      service.close();
    }
  });

  test('approval-token uses the profile server URL when one is configured', async () => {
    const home = tempHome();
    const started = await startHandoffSetup({
      env: { HANDOFF_HOME: home, USER: 'sam' },
      lifecycle: { ensureServer: async () => ({ status: 'skipped', serverUrl: 'local-db' }) },
    });
    const credentials = createProfileStore({ home }).loadCredentials('default');
    const service = new RelayService(createRelayDatabase(started.profile.localDatabasePath!));
    let serviceClosed = false;
    try {
      const draft = service.createShareDraft({
        authToken: credentials.memberToken,
        workspaceId: started.profile.workspaceId,
        to: `@${started.profile.handle}`,
        finding: 'Profile-backed approval should use the API server.',
        title: 'Server-backed approval token',
        summary: 'The CLI should not open the local database when a server URL is configured.',
        sourceClient: 'codex',
      });
      service.close();
      serviceClosed = true;

      const serverUrl = await startProfileBackedApi(started.profile.localDatabasePath!);
      const store = createProfileStore({ home });
      store.saveProfile({ ...started.profile, serverMode: 'lan', serverUrl });

      const previous = process.env.HANDOFF_HOME;
      const previousApproval = process.env.AGENT_RELAY_ASSUME_HUMAN_APPROVAL;
      process.env.HANDOFF_HOME = home;
      process.env.AGENT_RELAY_ASSUME_HUMAN_APPROVAL = '1';
      try {
        const result = await runCli(['approval-token', draft.id, '--action', 'send', '--json']);
        const parsed = JSON.parse(result.stdout);

        expect(result.code).toBe(0);
        expect(parsed.approval_token).toMatch(/^relay_approval_/);
        expect(result.stdout).not.toContain('relay_approval_secret_');
      } finally {
        if (previous === undefined) delete process.env.HANDOFF_HOME;
        else process.env.HANDOFF_HOME = previous;
        if (previousApproval === undefined) delete process.env.AGENT_RELAY_ASSUME_HUMAN_APPROVAL;
        else process.env.AGENT_RELAY_ASSUME_HUMAN_APPROVAL = previousApproval;
      }
    } finally {
      if (!serviceClosed) {
        service.close();
      }
    }
  });
});
