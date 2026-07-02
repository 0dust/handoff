import { resolve as resolvePath } from 'node:path';

import {
  stopBackgroundNotificationWatcher,
  type BackgroundNotificationWatcherMetadata,
  type BackgroundNotificationWatcherStopStatus,
} from '../notification-watch-lifecycle.js';
import {
  readServerMetadata,
  stopRecordedServer,
  type StopRecordedServerResult,
} from './lifecycle.js';
import { uninstallMcpConfigs, type McpUninstallSummary } from './mcp-config.js';
import {
  createProfileStore,
  type HandoffEnv,
  type HandoffProfile,
  type ProfileStore,
} from './profile.js';

export type ProfileServerCleanupResult =
  | StopRecordedServerResult
  | {
      dbPath?: string;
      recordedDbPath?: string;
      serverUrl?: string;
      status: 'not_matching';
    };

export interface ProfileRuntimeCleanupResult {
  mcp?: McpUninstallSummary;
  notifications: {
    metadata?: BackgroundNotificationWatcherMetadata;
    status: BackgroundNotificationWatcherStopStatus;
  };
  profileName: string;
  server?: ProfileServerCleanupResult;
}

export async function prepareProfileRestart(input: {
  env?: HandoffEnv;
  home?: string;
  profileName: string;
}): Promise<{ profile: HandoffProfile | undefined; stopped: ProfileServerCleanupResult }> {
  const store = createProfileStore({ env: input.env, home: input.home });
  const profile = store.loadProfile(input.profileName);
  const stopped = await stopRecordedServerForDatabase(
    store.home,
    requireLocalProfileDatabasePath(store, input.profileName, profile),
  );
  return { profile, stopped };
}

export async function cleanupProfileRuntime(input: {
  env?: HandoffEnv;
  home?: string;
  keepMcp?: boolean;
  profileName: string;
  stopServerForDatabasePath?: string;
}): Promise<ProfileRuntimeCleanupResult> {
  const store = createProfileStore({ env: input.env, home: input.home });
  const notifications = await stopBackgroundNotificationWatcher({
    home: store.home,
    profileName: input.profileName,
  });
  const server = input.stopServerForDatabasePath
    ? await stopRecordedServerForDatabase(store.home, input.stopServerForDatabasePath)
    : undefined;
  return {
    mcp: input.keepMcp
      ? undefined
      : uninstallMcpConfigs({ env: input.env, profileName: input.profileName }),
    notifications,
    profileName: input.profileName,
    server,
  };
}

export async function cleanupProfileRuntimeForDelete(input: {
  deleteData?: boolean;
  env?: HandoffEnv;
  home?: string;
  keepMcp?: boolean;
  profileName: string;
}): Promise<ProfileRuntimeCleanupResult> {
  const store = createProfileStore({ env: input.env, home: input.home });
  const profile = store.loadProfile(input.profileName);
  const cleanup = await cleanupProfileRuntime({
    env: input.env,
    home: input.home,
    keepMcp: input.keepMcp,
    profileName: input.profileName,
    stopServerForDatabasePath: localProfileDatabasePathForCleanup(
      store,
      input.profileName,
      profile,
      Boolean(input.deleteData),
    ),
  });
  assertProfileDeletionCanProceed(input.profileName, cleanup, Boolean(input.deleteData));
  return cleanup;
}

export async function stopRecordedServerForDatabase(
  home: string,
  dbPath: string,
): Promise<ProfileServerCleanupResult> {
  const metadata = readServerMetadata(home);
  if (!metadata) {
    return { status: 'not_found' };
  }
  if (resolvePath(metadata.dbPath) !== resolvePath(dbPath)) {
    return {
      dbPath,
      recordedDbPath: metadata.dbPath,
      serverUrl: metadata.serverUrl,
      status: 'not_matching',
    };
  }
  return stopRecordedServer(home);
}

function requireLocalProfileDatabasePath(
  store: ProfileStore,
  profileName: string,
  profile: HandoffProfile | undefined,
): string {
  if (profile?.serverMode === 'remote') {
    throw new Error(
      `Profile "${profile.profileName}" is joined to a remote Handoff server. Use a new --profile name to host a local workspace.`,
    );
  }
  return profile?.localDatabasePath ?? store.localDatabasePath(profileName);
}

function localProfileDatabasePathForCleanup(
  store: ProfileStore,
  profileName: string,
  profile: HandoffProfile | undefined,
  deleteData: boolean,
): string | undefined {
  if (profile?.serverMode === 'remote') {
    return undefined;
  }
  if (profile?.localDatabasePath) return profile.localDatabasePath;
  if (profile) return store.localDatabasePath(profileName);
  if (deleteData) return store.localDatabasePath(profileName);
  return undefined;
}

function assertProfileDeletionCanProceed(
  profileName: string,
  cleanup: ProfileRuntimeCleanupResult,
  deleteData: boolean,
): void {
  if (cleanup.server?.status !== 'still_running') return;
  const pid = cleanup.server.pid ?? 'unknown';
  const target = deleteData ? 'profile data was' : 'profile was';
  throw new Error(
    `Recorded Handoff server for profile "${profileName}" is still running after SIGTERM (pid ${pid}); ${target} not deleted. Stop it with \`npx -y handoff-relay stop\` and retry.`,
  );
}
