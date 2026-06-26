import { existsSync, chmodSync } from 'node:fs';

import { RelayApiClient } from '../api/client.js';
import {
  A2A_AGENT_CARD_PATH,
  A2A_DISABLED_REASON,
  A2A_JSON_MEDIA_TYPE,
  A2A_NOT_IMPLEMENTED_REASON,
  A2A_RECEIVE_PATH,
  A2A_RECEIVE_UNAVAILABLE_CODE,
  a2aAgentCardSchema,
} from '../a2a/schema.js';
import { runtimeVersion } from '../runtime/version.js';
import { RelayService } from '../service/relay-service.js';
import { createRelayDatabase } from '../storage/database.js';
import { PacketTransportRepository } from '../storage/packet-transport-table.js';
import { probeHandoffServer } from './lifecycle.js';
import { summarizeMcpSetup } from './mcp-config.js';
import {
  createProfileStore,
  resolveProfileName,
  type HandoffEnv,
  type HandoffProfile,
} from './profile.js';

export type DoctorStatus = 'FAIL' | 'OK' | 'WARN';

export interface DoctorCheck {
  id: string;
  message: string;
  status: DoctorStatus;
  fix?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  home: string;
  profile?: {
    handle: string;
    profileName: string;
    serverUrl: string;
    workspaceId: string;
    workspaceName: string;
  };
  status: DoctorStatus;
}

export async function runDoctorChecks(
  input: {
    env?: HandoffEnv;
    fix?: boolean;
    home?: string;
    profileName?: string;
  } = {},
): Promise<DoctorReport> {
  const store = createProfileStore({ env: input.env, home: input.home });
  const profileName = resolveProfileName(input.profileName, input.env);
  const checks: DoctorCheck[] = [];

  checks.push(
    existsSync(store.home)
      ? ok('home', `Handoff home exists at ${store.home}.`)
      : fail(
          'home',
          `Handoff home is missing at ${store.home}.`,
          'Run `npx -y handoff-relay start`.',
        ),
  );

  let profile: HandoffProfile | undefined;
  try {
    profile = store.loadProfile(profileName);
  } catch (error) {
    checks.push(
      fail(
        'profile_parse',
        error instanceof Error ? error.message : 'Profile metadata is not parseable.',
        'Move the broken profile aside and run `npx -y handoff-relay start`.',
      ),
    );
  }

  if (!profile) {
    checks.push(
      fail(
        'active_profile',
        `No active Handoff profile named "${profileName}".`,
        'Run `npx -y handoff-relay start`.',
      ),
    );
    return buildReport(store.home, checks);
  }

  checks.push(ok('active_profile', `Active profile "${profile.profileName}" is present.`));
  checks.push(
    profile.schemaVersion === 1
      ? ok('profile_schema', 'Profile schema is compatible.')
      : fail(
          'profile_schema',
          'Profile schema is not compatible with this Handoff version.',
          'Upgrade Handoff or recreate the profile.',
        ),
  );

  let credentials;
  try {
    credentials = store.loadCredentials(profile.profileName);
    checks.push(ok('credentials_store', 'Credential store exists.'));
    checks.push(
      credentials.memberToken
        ? ok('member_token', 'Member token is present.')
        : fail('member_token', 'Member token is missing.', 'Run `npx -y handoff-relay start`.'),
    );
    checks.push(
      credentials.approvalSecret
        ? ok('approval_secret', 'Approval secret is present.')
        : fail(
            'approval_secret',
            'Approval secret is missing.',
            'Run `npx -y handoff-relay start`.',
          ),
    );
  } catch (error) {
    checks.push(
      fail(
        'credentials_store',
        error instanceof Error ? error.message : 'Credential store is missing.',
        'Run `npx -y handoff-relay start`.',
      ),
    );
  }

  if (store.credentialsExist(profile.profileName)) {
    const restrictive = store.credentialsAreRestrictive(profile.profileName);
    if (!restrictive && input.fix) {
      try {
        chmodSync(store.credentialPath(profile.profileName), 0o600);
      } catch {
        // Preserve the warning below when chmod is unsupported.
      }
    }
    checks.push(
      store.credentialsAreRestrictive(profile.profileName)
        ? ok('credentials_permissions', 'Credential file permissions are restrictive.')
        : warn(
            'credentials_permissions',
            'Credential file permissions are broader than recommended.',
            `Run \`chmod 600 ${store.credentialPath(profile.profileName)}\`.`,
          ),
    );
  }

  if (profile.localDatabasePath) {
    checks.push(
      existsSync(profile.localDatabasePath)
        ? ok('local_database', `Local database exists at ${profile.localDatabasePath}.`)
        : fail(
            'local_database',
            `Local database is missing at ${profile.localDatabasePath}.`,
            'Run `npx -y handoff-relay start` to recreate local setup.',
          ),
    );
  }

  if (profile.serverUrl === 'local-db') {
    checks.push(ok('server_reachable', 'Profile uses local database mode.'));
    checks.push(ok('server_identity', 'Local database profile does not need HTTP health.'));
    checks.push(...localA2aChecks(profile));
  } else if (await probeHandoffServer(profile.serverUrl, { timeoutMs: 1_000 })) {
    checks.push(ok('server_reachable', `Server is reachable at ${profile.serverUrl}.`));
    checks.push(ok('server_identity', 'Server identifies as Handoff.'));
    checks.push(...(await httpA2aChecks(profile.serverUrl)));
  } else {
    checks.push(
      fail(
        'server_reachable',
        `Server is not reachable at ${profile.serverUrl}.`,
        'Run `npx -y handoff-relay start` or check the server URL.',
      ),
    );
  }

  if (credentials) {
    const backend =
      profile.localDatabasePath && existsSync(profile.localDatabasePath)
        ? new RelayService(createRelayDatabase(profile.localDatabasePath))
        : new RelayApiClient({ serverUrl: profile.serverUrl });
    try {
      await backend.listInbox({
        authToken: credentials.memberToken,
        workspaceId: profile.workspaceId,
      });
      checks.push(ok('workspace_access', 'Current member token can list inbox.'));
      checks.push(ok('workspace_exists', `Workspace ${profile.workspaceName} is accessible.`));
    } catch (error) {
      checks.push(
        fail(
          'workspace_access',
          error instanceof Error ? error.message : 'Current member cannot access the workspace.',
          'Run `npx -y handoff-relay join <invite-link>` or recreate the profile.',
        ),
      );
    } finally {
      if (backend instanceof RelayService) {
        backend.close();
      }
    }
  }

  const mcp = summarizeMcpSetup({ env: input.env, profileName: profile.profileName });
  if (mcp.status === 'installed') {
    const installed = mcp.configs
      .filter((config) => config.installed)
      .map((config) => config.client)
      .join(', ');
    checks.push(ok('mcp_config', `Handoff MCP profile config is installed for ${installed}.`));
  } else {
    checks.push(
      warn(
        'mcp_config',
        'No supported MCP client config includes Handoff profile mode.',
        `Add ${mcp.command} to Codex, Claude Code, Cursor, or another MCP client.`,
      ),
    );
  }

  return buildReport(store.home, checks, profile);
}

function localA2aChecks(profile: HandoffProfile): DoctorCheck[] {
  const checks: DoctorCheck[] = [
    ok('a2a_agent_card', 'Local database mode does not expose an HTTP Agent Card.'),
    ok('a2a_receive_stub', 'Local database mode does not expose a public A2A receive endpoint.'),
  ];
  if (!profile.localDatabasePath || !existsSync(profile.localDatabasePath)) {
    checks.push(
      fail(
        'a2a_adapter_ledger',
        'Adapter ledger could not be checked because the local database is missing.',
        'Run `npx -y handoff-relay start` to recreate local setup.',
      ),
    );
    return checks;
  }
  let db: ReturnType<typeof createRelayDatabase> | undefined;
  try {
    db = createRelayDatabase(profile.localDatabasePath);
    new PacketTransportRepository(db).listForPacket('__doctor_probe__');
    checks.push(ok('a2a_adapter_ledger', 'A2A adapter ledger table is available.'));
  } catch (error) {
    checks.push(
      fail(
        'a2a_adapter_ledger',
        error instanceof Error ? error.message : 'A2A adapter ledger check failed.',
        'Run `npx -y handoff-relay doctor --fix` or recreate local setup.',
      ),
    );
  } finally {
    db?.close();
  }
  return checks;
}

async function httpA2aChecks(serverUrl: string): Promise<DoctorCheck[]> {
  const baseUrl = serverUrl.replace(/\/+$/, '');
  const [card, receiveStub] = await Promise.allSettled([
    httpA2aAgentCardCheck(baseUrl),
    httpA2aReceiveStubCheck(baseUrl),
  ]);
  return [
    card.status === 'fulfilled'
      ? card.value
      : fail(
          'a2a_agent_card',
          card.reason instanceof Error ? card.reason.message : 'A2A Agent Card check failed.',
          'Restart the Handoff server and rerun doctor.',
        ),
    receiveStub.status === 'fulfilled'
      ? receiveStub.value
      : fail(
          'a2a_receive_stub',
          receiveStub.reason instanceof Error
            ? receiveStub.reason.message
            : 'A2A receive stub check failed.',
          'Restart the Handoff server and rerun doctor.',
        ),
  ];
}

async function httpA2aAgentCardCheck(baseUrl: string): Promise<DoctorCheck> {
  const cardResponse = await fetch(`${baseUrl}${A2A_AGENT_CARD_PATH}`, {
    signal: AbortSignal.timeout(1_000),
  });
  const card = a2aAgentCardSchema.parse(await cardResponse.json());
  const cacheControl = cardResponse.headers.get('cache-control') ?? '';
  const etag = cardResponse.headers.get('etag') ?? '';
  const validCard =
    cardResponse.ok &&
    card.version === runtimeVersion &&
    cacheControl.includes('max-age') &&
    Boolean(etag);
  return validCard
    ? ok('a2a_agent_card', 'A2A Agent Card is reachable and cacheable.')
    : fail(
        'a2a_agent_card',
        'A2A Agent Card is missing required version, interface, cache, or ETag metadata.',
        'Restart the Handoff server with the current package version.',
      );
}

async function httpA2aReceiveStubCheck(baseUrl: string): Promise<DoctorCheck> {
  const stubResponse = await fetch(`${baseUrl}${A2A_RECEIVE_PATH}`, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 'doctor', method: 'SendMessage', params: {} }),
    headers: { 'content-type': A2A_JSON_MEDIA_TYPE },
    signal: AbortSignal.timeout(1_000),
  });
  const body = (await stubResponse.json()) as {
    error?: { code?: number; data?: Array<{ reason?: string }> };
    id?: string;
    jsonrpc?: string;
  };
  const reason = body.error?.data?.[0]?.reason;
  const unavailable =
    stubResponse.ok &&
    body.jsonrpc === '2.0' &&
    body.id === 'doctor' &&
    body.error?.code === A2A_RECEIVE_UNAVAILABLE_CODE;
  if (unavailable && reason === A2A_DISABLED_REASON) {
    return ok('a2a_receive_stub', 'Public A2A receiving is disabled.');
  }
  if (unavailable && reason === A2A_NOT_IMPLEMENTED_REASON) {
    return warn(
      'a2a_receive_stub',
      'Public A2A receiving flag is enabled, but receiving is not implemented.',
    );
  }
  return fail(
    'a2a_receive_stub',
    'A2A receive stub did not return the expected disabled response.',
    'Restart the Handoff server with the current package version.',
  );
}

export function formatDoctorHuman(report: DoctorReport): string {
  const groups: DoctorStatus[] = ['OK', 'WARN', 'FAIL'];
  const lines = ['Handoff doctor'];
  for (const group of groups) {
    lines.push('', group);
    const checks = report.checks.filter((check) => check.status === group);
    if (checks.length === 0) {
      lines.push('  none');
      continue;
    }
    for (const check of checks) {
      lines.push(`  - ${check.message}`);
      if (check.fix) {
        lines.push(`    Fix: ${check.fix}`);
      }
    }
  }
  return lines.join('\n');
}

function buildReport(home: string, checks: DoctorCheck[], profile?: HandoffProfile): DoctorReport {
  const status = checks.some((check) => check.status === 'FAIL')
    ? 'FAIL'
    : checks.some((check) => check.status === 'WARN')
      ? 'WARN'
      : 'OK';
  return {
    home,
    status,
    profile: profile
      ? {
          profileName: profile.profileName,
          workspaceId: profile.workspaceId,
          workspaceName: profile.workspaceName,
          handle: profile.handle,
          serverUrl: profile.serverUrl,
        }
      : undefined,
    checks,
  };
}

function ok(id: string, message: string): DoctorCheck {
  return { id, message, status: 'OK' };
}

function warn(id: string, message: string, fix?: string): DoctorCheck {
  return { id, message, status: 'WARN', fix };
}

function fail(id: string, message: string, fix: string): DoctorCheck {
  return { id, message, status: 'FAIL', fix };
}
