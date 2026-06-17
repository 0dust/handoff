import { existsSync, chmodSync } from 'node:fs';

import { RelayApiClient } from '../api/client.js';
import { RelayService } from '../service/relay-service.js';
import { createRelayDatabase } from '../storage/database.js';
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
          'Run `npx -y @0dust/handoff start`.',
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
        'Move the broken profile aside and run `npx -y @0dust/handoff start`.',
      ),
    );
  }

  if (!profile) {
    checks.push(
      fail(
        'active_profile',
        `No active Handoff profile named "${profileName}".`,
        'Run `npx -y @0dust/handoff start`.',
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
        : fail('member_token', 'Member token is missing.', 'Run `npx -y @0dust/handoff start`.'),
    );
    checks.push(
      credentials.approvalSecret
        ? ok('approval_secret', 'Approval secret is present.')
        : fail(
            'approval_secret',
            'Approval secret is missing.',
            'Run `npx -y @0dust/handoff start`.',
          ),
    );
  } catch (error) {
    checks.push(
      fail(
        'credentials_store',
        error instanceof Error ? error.message : 'Credential store is missing.',
        'Run `npx -y @0dust/handoff start`.',
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
            'Run `npx -y @0dust/handoff start` to recreate local setup.',
          ),
    );
  }

  if (profile.serverUrl === 'local-db') {
    checks.push(ok('server_reachable', 'Profile uses local database mode.'));
    checks.push(ok('server_identity', 'Local database profile does not need HTTP health.'));
  } else if (await probeHandoffServer(profile.serverUrl)) {
    checks.push(ok('server_reachable', `Server is reachable at ${profile.serverUrl}.`));
    checks.push(ok('server_identity', 'Server identifies as Handoff.'));
  } else {
    checks.push(
      fail(
        'server_reachable',
        `Server is not reachable at ${profile.serverUrl}.`,
        'Run `npx -y @0dust/handoff start` or check the server URL.',
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
          'Run `npx -y @0dust/handoff join <invite-link>` or recreate the profile.',
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
