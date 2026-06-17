import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { buildApiServer } from '../src/api/server.js';
import { runCli } from '../src/cli.js';
import {
  createInviteForProfile,
  joinInvite,
  startHandoffSetup,
} from '../src/setup/orchestrator.js';
import { runDoctorChecks } from '../src/setup/doctor.js';
import { buildInviteLink, parseInviteLink } from '../src/setup/invite-link.js';
import { detectLanBaseUrl, findAvailablePort } from '../src/setup/lifecycle.js';
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
    const credentials = store.loadCredentials('default');

    expect(invite.joinCommand).toMatch(/^npx -y @0dust\/handoff join http:\/\/127\.0\.0\.1:/);
    expect(parseInviteLink(invite.inviteLink).inviteToken).toMatch(/^relay_invite_/);
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
    expect(readFileSync(join(aliceHome, '.cursor', 'mcp.json'), 'utf8')).toContain(
      '@0dust/handoff',
    );
    expect(inbox).toEqual([]);
  });

  test('doctor reports missing and healthy states, including JSON-safe output', async () => {
    const missingHome = tempHome();
    const missing = await runDoctorChecks({ home: missingHome, profileName: 'default' });
    expect(missing.status).toBe('FAIL');
    expect(missing.checks).toContainEqual(
      expect.objectContaining({
        id: 'active_profile',
        status: 'FAIL',
        fix: expect.stringContaining('handoff start'),
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
    expect(JSON.parse(JSON.stringify(report)).profile?.workspaceId).toBe(
      started.profile.workspaceId,
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
        'args = ["-y", "@0dust/handoff", "server", "mcp", "--profile", "default"]',
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
      const result = await runCli(['start', '--json']);
      const parsed = JSON.parse(result.stdout);
      const credentialFile = join(home, 'credentials', 'default.json');
      const credentials = JSON.parse(readFileSync(credentialFile, 'utf8'));

      expect(result.code).toBe(0);
      expect(parsed.profile).toBe('default');
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

  test('CLI start can install Codex MCP config explicitly', async () => {
    const home = tempHome();
    const previousHome = process.env.HANDOFF_HOME;
    const previousUserHome = process.env.HOME;
    process.env.HANDOFF_HOME = home;
    process.env.HOME = home;
    process.env.HANDOFF_TEST_SKIP_SERVER = '1';
    try {
      const result = await runCli(['start', '--install-mcp', 'codex', '--json']);
      const config = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
      const parsed = JSON.parse(result.stdout);

      expect(result.code).toBe(0);
      expect(parsed.mcp.status).toBe('installed');
      expect(config).toContain('@0dust/handoff');
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
});
