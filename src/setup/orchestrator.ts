import { existsSync } from 'node:fs';

import { RelayApiClient } from '../api/client.js';
import { RelayError } from '../errors.js';
import { createToken, normalizeHandle } from '../identity.js';
import { RelayService } from '../service/relay-service.js';
import { createRelayDatabase } from '../storage/database.js';
import { buildInviteLink, parseInviteLink } from './invite-link.js';
import {
  createDefaultServerLifecycle,
  detectLanBaseUrl,
  type EnsureServerResult,
  type ServerLifecycle,
} from './lifecycle.js';
import {
  installMcpConfig,
  summarizeMcpSetup,
  type McpClientId,
  type McpSetupSummary,
} from './mcp-config.js';
import {
  createProfileStore,
  inferDisplayName,
  inferHandle,
  redactProfile,
  resolveProfileName,
  type HandoffCredentials,
  type HandoffEnv,
  type HandoffProfile,
  type ProfileStore,
} from './profile.js';

export interface StartHandoffInput {
  displayName?: string;
  env?: HandoffEnv;
  handle?: string;
  home?: string;
  host?: string;
  installMcpClient?: McpClientId;
  lan?: boolean;
  lifecycle?: ServerLifecycle;
  noMcpInstall?: boolean;
  port?: number;
  profileName?: string;
  publicUrl?: string;
  workspaceName?: string;
}

export interface StartHandoffResult {
  created: boolean;
  mcp: McpSetupSummary;
  nextCommand: string;
  profile: HandoffProfile;
  redactedProfile: Record<string, unknown>;
  server: {
    status: string;
    url: string;
    publicInviteBaseUrl?: string;
    warning?: string;
  };
}

export interface InviteProfileResult {
  expiresAt: string;
  handle: string;
  inviteLink: string;
  joinCommand: string;
  warning?: string;
}

export interface JoinInviteResult {
  backend: RelayApiClient;
  mcp: McpSetupSummary;
  nextAgentInstruction: string;
  profile: HandoffProfile;
}

export interface LeaveWorkspaceProfileResult {
  alreadyRemoved: boolean;
  hadProfile: boolean;
  handle?: string;
  profileName: string;
  workspaceName?: string;
}

export interface RemoveWorkspaceMemberResult {
  alreadyRemoved: boolean;
  handle: string;
  memberId: string;
  workspaceName: string;
}

export function createBackendForProfile(input: {
  credentials: HandoffCredentials;
  profile: HandoffProfile;
}): RelayApiClient | RelayService {
  if (/^https?:\/\//i.test(input.profile.serverUrl)) {
    return new RelayApiClient({ serverUrl: input.profile.serverUrl });
  }
  if (
    input.profile.localDatabasePath &&
    input.profile.serverMode !== 'remote' &&
    existsSync(input.profile.localDatabasePath)
  ) {
    return new RelayService(createRelayDatabase(input.profile.localDatabasePath));
  }
  return new RelayApiClient({ serverUrl: input.profile.serverUrl });
}

export async function startHandoffSetup(
  input: StartHandoffInput = {},
): Promise<StartHandoffResult> {
  const env = input.env ?? process.env;
  const store = createProfileStore({ env, home: input.home });
  store.ensureHome();
  const profileName = resolveProfileName(input.profileName, env);
  const existing = store.loadProfile(profileName);
  const now = new Date().toISOString();
  let profile = existing;
  let created = false;

  if (!profile) {
    created = true;
    const dbPath = store.localDatabasePath(profileName);
    const service = new RelayService(createRelayDatabase(dbPath));
    try {
      const handle = normalizeHandle(input.handle ?? inferHandle(env));
      const displayName = input.displayName ?? inferDisplayName(env);
      const workspace = service.createWorkspace({
        name: input.workspaceName ?? `${displayName}'s Handoff Workspace`,
        adminHandle: handle,
        adminName: displayName,
      });
      profile = {
        schemaVersion: 1,
        profileName,
        workspaceId: workspace.workspace.id,
        workspaceName: workspace.workspace.name,
        memberId: workspace.admin.id,
        handle: workspace.admin.handle,
        displayName: workspace.admin.display_name,
        role: workspace.admin.role,
        serverUrl: 'local-db',
        localDatabasePath: dbPath,
        serverMode: input.lan ? 'lan' : 'local',
        createdAt: now,
        lastVerifiedAt: now,
      };
      store.saveProfile(profile);
      store.saveCredentials(profileName, {
        memberToken: workspace.admin.token,
        approvalSecret: workspace.admin.approval_secret,
        createdAt: now,
      });
    } finally {
      service.close();
    }
  }
  if (profile.serverMode === 'remote') {
    throw new Error(
      `Profile "${profile.profileName}" is joined to a remote Handoff server. Use a new --profile name to host a local workspace.`,
    );
  }

  const host = input.host ?? (input.lan ? '0.0.0.0' : '127.0.0.1');
  const port = input.port ?? portFromUrl(profile.serverUrl) ?? 3737;
  const lifecycle = input.lifecycle ?? createDefaultServerLifecycle();
  const server = await lifecycle.ensureServer({
    dbPath: profile.localDatabasePath ?? store.localDatabasePath(profileName),
    home: store.home,
    host,
    port,
    serverUrl: profile.serverUrl,
  });
  const selectedPort = server.port ?? portFromUrl(server.serverUrl) ?? port;
  const serverUrl = server.serverUrl;
  const lanReachable = !input.lan || serverIsLanReachable(server);
  const publicInviteBaseUrl =
    input.publicUrl ??
    (input.lan ? (lanReachable ? detectLanBaseUrl({ port: selectedPort }) : undefined) : undefined);

  profile = {
    ...profile,
    serverUrl,
    publicInviteBaseUrl,
    serverMode: input.lan ? 'lan' : 'local',
    lastVerifiedAt: new Date().toISOString(),
  };
  store.saveProfile(profile);

  if (input.installMcpClient) {
    installMcpConfig({
      client: input.installMcpClient,
      env,
      profileName: profile.profileName,
    });
  }

  return {
    created,
    profile,
    redactedProfile: redactProfile(profile),
    server: {
      status: server.status,
      url: serverUrl,
      publicInviteBaseUrl,
      warning:
        input.lan && !lanReachable
          ? 'Current Handoff server is not LAN-reachable. Run `npx -y handoff-relay start --lan --port <free-port>` or stop the loopback server and retry.'
          : input.lan && !publicInviteBaseUrl
            ? 'No private LAN address was detected. Pass --public-url to set an invite URL.'
            : server.warning,
    },
    mcp: summarizeMcpSetup({
      env,
      profileName: profile.profileName,
      skipped: input.noMcpInstall,
    }),
    nextCommand: `npx -y handoff-relay invite alice`,
  };
}

export async function createInviteForProfile(input: {
  env?: HandoffEnv;
  handle: string;
  home?: string;
  profileName?: string;
}): Promise<InviteProfileResult> {
  const store = createProfileStore({ env: input.env, home: input.home });
  const profileName = resolveProfileName(input.profileName, input.env);
  const profile = requireProfile(store, profileName);
  const credentials = store.loadCredentials(profile.profileName);
  const backend = createBackendForProfile({ profile, credentials });
  try {
    const invited = await backend.inviteMember({
      adminToken: credentials.memberToken,
      workspaceId: profile.workspaceId,
      handle: input.handle,
    });
    const baseUrl = profile.publicInviteBaseUrl ?? profile.serverUrl;
    const inviteLink = buildInviteLink({
      baseUrl: baseUrl === 'local-db' ? 'http://127.0.0.1:3737' : baseUrl,
      inviteToken: invited.invite.token,
    });
    return {
      handle: invited.invite.handle,
      expiresAt: invited.invite.expires_at,
      inviteLink,
      joinCommand: `npx -y handoff-relay join ${inviteLink}`,
      warning: inviteLink.includes('127.0.0.1')
        ? 'This invite link is loopback-only. Run `npx -y handoff-relay start --lan` for another machine.'
        : undefined,
    };
  } finally {
    if (backend instanceof RelayService) {
      backend.close();
    }
  }
}

export async function joinInvite(input: {
  displayName?: string;
  env?: HandoffEnv;
  home?: string;
  installMcpClient?: McpClientId;
  invite: string;
  noMcpInstall?: boolean;
  profileName?: string;
  serverUrl?: string;
}): Promise<JoinInviteResult> {
  const env = input.env ?? process.env;
  const parts = parseInviteLink(input.invite, input.serverUrl);
  const profileName = resolveProfileName(input.profileName, env);
  const displayName = input.displayName ?? inferDisplayName(env);
  const store = createProfileStore({ env, home: input.home });
  const pendingAttempt = store.loadPendingJoinAttempt(profileName);
  const pending = reusablePendingJoinAttempt({
    attempt: pendingAttempt,
    displayName,
    invite: input.invite,
    profileName,
    serverUrl: parts.serverUrl,
  });
  const client = new RelayApiClient({ serverUrl: parts.serverUrl });
  const existing = store.loadProfile(profileName);
  if (existing) {
    if (!store.credentialsExist(existing.profileName)) {
      if (pending) {
        store.savePendingJoinAttempt(pending);
      } else {
        throw new Error(
          `Handoff profile "${profileName}" exists, but its credentials are missing. Ask the workspace admin to run \`handoff remove-member ${existing.handle}\`, then join this invite with \`--profile <new-name>\`.`,
        );
      }
    } else {
      const invite = await client.getInvite({ inviteToken: parts.inviteToken });
      const inviteWorkspaceId =
        typeof invite.workspace === 'object' && invite.workspace && 'id' in invite.workspace
          ? String(invite.workspace.id)
          : undefined;
      const inviteHandle =
        typeof invite.invite === 'object' && invite.invite && 'handle' in invite.invite
          ? String(invite.invite.handle)
          : undefined;
      if (
        existing.serverUrl !== parts.serverUrl ||
        existing.workspaceId !== inviteWorkspaceId ||
        existing.handle !== inviteHandle
      ) {
        throw new Error(
          `Handoff profile "${profileName}" is already joined as @${existing.handle}. Use --profile <new-name> for another invite.`,
        );
      }
      if (input.installMcpClient) {
        installMcpConfig({
          client: input.installMcpClient,
          env,
          profileName,
        });
      }
      return {
        backend: new RelayApiClient({ serverUrl: existing.serverUrl }),
        profile: existing,
        mcp: summarizeMcpSetup({ env, profileName, skipped: input.noMcpInstall }),
        nextAgentInstruction:
          'Use Handoff to check notifications with `handoff watch`, then use relay_review_next -> relay_hydrate_approved for received packets.',
      };
    }
  }
  const nextPending = pending ?? {
    schemaVersion: 1 as const,
    displayName,
    idempotencyKey: createToken('relay_join'),
    invite: input.invite,
    profileName,
    serverUrl: parts.serverUrl,
    createdAt: new Date().toISOString(),
  };
  store.savePendingJoinAttempt(nextPending);
  const accepted = await client.acceptInvite({
    inviteToken: parts.inviteToken,
    displayName,
    idempotencyKey: nextPending.idempotencyKey,
  });
  const now = new Date().toISOString();
  const profile: HandoffProfile = {
    schemaVersion: 1,
    profileName,
    workspaceId: accepted.workspace.id,
    workspaceName: accepted.workspace.name,
    memberId: accepted.member.id,
    handle: accepted.member.handle,
    displayName: accepted.member.display_name,
    role: accepted.member.role,
    serverUrl: parts.serverUrl,
    serverMode: 'remote',
    createdAt: now,
    lastVerifiedAt: now,
  };
  store.saveProfile(profile);
  store.saveCredentials(profileName, {
    memberToken: accepted.member.token,
    approvalSecret: accepted.member.approval_secret,
    createdAt: now,
  });
  store.deletePendingJoinAttempt(profileName);
  await client.listInbox({
    authToken: accepted.member.token,
    workspaceId: accepted.workspace.id,
  });
  if (input.installMcpClient) {
    installMcpConfig({
      client: input.installMcpClient,
      env,
      profileName,
    });
  }
  return {
    backend: client,
    profile,
    mcp: summarizeMcpSetup({ env, profileName, skipped: input.noMcpInstall }),
    nextAgentInstruction:
      'Use Handoff to package context for a teammate with relay_share -> relay_send_approved, or receive with relay_review_next -> relay_hydrate_approved.',
  };
}

function reusablePendingJoinAttempt(input: {
  attempt: ReturnType<ProfileStore['loadPendingJoinAttempt']>;
  displayName: string;
  invite: string;
  profileName: string;
  serverUrl: string;
}) {
  if (
    input.attempt &&
    input.attempt.displayName === input.displayName &&
    input.attempt.invite === input.invite &&
    input.attempt.profileName === input.profileName &&
    input.attempt.serverUrl === input.serverUrl
  ) {
    return input.attempt;
  }
  return undefined;
}

export async function leaveWorkspaceProfile(
  input: {
    env?: HandoffEnv;
    home?: string;
    profileName?: string;
  } = {},
): Promise<LeaveWorkspaceProfileResult> {
  const env = input.env ?? process.env;
  const store = createProfileStore({ env, home: input.home });
  const profileName = resolveProfileName(input.profileName, env);
  const profile = store.loadProfile(profileName);
  if (!profile) {
    return { alreadyRemoved: true, hadProfile: false, profileName };
  }
  let result: { alreadyRemoved?: boolean } | undefined;
  const credentials = store.loadCredentials(profile.profileName);
  const backend = createBackendForProfile({ profile, credentials });
  try {
    result = await backend.leaveWorkspace({
      authToken: credentials.memberToken,
      workspaceId: profile.workspaceId,
    });
  } catch (error) {
    if (!isAlreadyRemovedError(error)) {
      throw error;
    }
    result = { alreadyRemoved: true };
  } finally {
    if (backend instanceof RelayService) {
      backend.close();
    }
  }
  store.deleteProfile(profile.profileName);
  return {
    alreadyRemoved: Boolean(result?.alreadyRemoved),
    hadProfile: true,
    handle: profile.handle,
    profileName: profile.profileName,
    workspaceName: profile.workspaceName,
  };
}

export async function removeWorkspaceMember(input: {
  env?: HandoffEnv;
  home?: string;
  member: string;
  profileName?: string;
}): Promise<RemoveWorkspaceMemberResult> {
  const env = input.env ?? process.env;
  const store = createProfileStore({ env, home: input.home });
  const profileName = resolveProfileName(input.profileName, env);
  const profile = requireProfile(store, profileName);
  const credentials = store.loadCredentials(profile.profileName);
  const backend = createBackendForProfile({ profile, credentials });
  try {
    const result = await backend.removeMember({
      adminToken: credentials.memberToken,
      workspaceId: profile.workspaceId,
      member: input.member,
    });
    return {
      alreadyRemoved: Boolean(result.alreadyRemoved),
      handle: result.member.handle,
      memberId: result.member.id,
      workspaceName: profile.workspaceName,
    };
  } finally {
    if (backend instanceof RelayService) {
      backend.close();
    }
  }
}

function requireProfile(store: ProfileStore, profileName: string): HandoffProfile {
  const profile = store.loadProfile(profileName);
  if (!profile) {
    throw new Error(
      `No Handoff profile named "${profileName}". Run \`npx -y handoff-relay start\`.`,
    );
  }
  return profile;
}

function isAlreadyRemovedError(error: unknown): boolean {
  return error instanceof RelayError && error.code === 'TOKEN_REVOKED';
}

function portFromUrl(value: string | undefined): number | undefined {
  if (!value || value === 'local-db') return undefined;
  try {
    const parsed = new URL(value);
    return parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
  } catch {
    return undefined;
  }
}

function serverIsLanReachable(server: EnsureServerResult): boolean {
  if (server.bindHost === '0.0.0.0') return true;
  if (server.bindHost && !isLoopbackHost(server.bindHost)) return true;
  try {
    return !isLoopbackHost(new URL(server.serverUrl).hostname);
  } catch {
    return false;
  }
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}
