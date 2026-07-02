import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';

export type HandoffServerMode = 'lan' | 'local' | 'remote';
export type HandoffMemberRole = 'admin' | 'member';

export interface HandoffProfile {
  schemaVersion: 1;
  profileName: string;
  workspaceId: string;
  workspaceName: string;
  memberId: string;
  handle: string;
  displayName: string;
  role: HandoffMemberRole;
  serverUrl: string;
  publicInviteBaseUrl?: string;
  localDatabasePath?: string;
  serverMode: HandoffServerMode;
  createdAt: string;
  lastVerifiedAt?: string;
}

export interface HandoffCredentials {
  memberToken: string;
  approvalSecret: string;
  createdAt: string;
  lastRotationAt?: string;
}

export interface PendingJoinAttempt {
  schemaVersion: 1;
  displayName: string;
  idempotencyKey: string;
  invite: string;
  profileName: string;
  serverUrl: string;
  createdAt: string;
}

export interface HandoffEnv {
  [key: string]: string | undefined;
}

export interface ActiveProfileInput {
  env?: HandoffEnv;
  profileName?: string;
}

export class ProfileStore {
  readonly home: string;

  constructor(home: string) {
    this.home = home;
  }

  ensureHome(): void {
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    mkdirSync(join(this.home, 'profiles'), { recursive: true, mode: 0o700 });
    mkdirSync(join(this.home, 'credentials'), { recursive: true, mode: 0o700 });
    mkdirSync(join(this.home, 'data'), { recursive: true, mode: 0o700 });
    mkdirSync(join(this.home, 'logs'), { recursive: true, mode: 0o700 });
    mkdirSync(join(this.home, 'run'), { recursive: true, mode: 0o700 });
  }

  profilePath(profileName: string): string {
    return join(this.home, 'profiles', `${sanitizeProfileName(profileName)}.json`);
  }

  credentialPath(profileName: string): string {
    return join(this.home, 'credentials', `${sanitizeProfileName(profileName)}.json`);
  }

  joinAttemptPath(profileName: string): string {
    return join(this.home, 'run', `join-${sanitizeProfileName(profileName)}.json`);
  }

  localDatabasePath(profileName: string): string {
    return join(this.profileDataPath(profileName), 'relay.db');
  }

  profileDataPath(profileName: string): string {
    return join(this.home, 'data', sanitizeProfileName(profileName));
  }

  loadProfile(profileName: string): HandoffProfile | undefined {
    const path = this.profilePath(profileName);
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as HandoffProfile;
    if (parsed.schemaVersion !== 1) {
      throw new Error(`Unsupported Handoff profile schema version for ${profileName}.`);
    }
    return parsed;
  }

  loadActiveProfile(input: ActiveProfileInput = {}): HandoffProfile | undefined {
    return this.loadProfile(resolveProfileName(input.profileName, input.env));
  }

  saveProfile(profile: HandoffProfile): void {
    this.ensureHome();
    writeFileSync(this.profilePath(profile.profileName), `${JSON.stringify(profile, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  loadCredentials(profileName: string): HandoffCredentials {
    const path = this.credentialPath(profileName);
    if (!existsSync(path)) {
      throw new Error(`Missing Handoff credentials for profile "${profileName}".`);
    }
    return JSON.parse(readFileSync(path, 'utf8')) as HandoffCredentials;
  }

  saveCredentials(profileName: string, credentials: HandoffCredentials): void {
    this.ensureHome();
    const path = this.credentialPath(profileName);
    writeFileSync(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      // Some platforms do not support POSIX modes. Doctor reports the effective state.
    }
  }

  credentialsExist(profileName: string): boolean {
    return existsSync(this.credentialPath(profileName));
  }

  deleteProfile(profileName: string): void {
    rmSync(this.profilePath(profileName), { force: true });
    rmSync(this.credentialPath(profileName), { force: true });
  }

  deleteProfileData(
    profileName: string,
    input: { localDatabasePath?: string } = {},
  ): {
    dataPath: string;
    deleted: boolean;
    deletionMode: 'custom_database_files' | 'profile_data_directory';
    localDatabasePath: string;
  } {
    const standardDatabasePath = this.localDatabasePath(profileName);
    const localDatabasePath = input.localDatabasePath ?? this.localDatabasePath(profileName);
    const standardDataPath = this.profileDataPath(profileName);
    const isStandardPath = localDatabasePath === standardDatabasePath;
    if (!isStandardPath) {
      const deleted = deleteDatabaseFiles(localDatabasePath);
      return {
        dataPath: dirname(localDatabasePath),
        deleted,
        deletionMode: 'custom_database_files',
        localDatabasePath,
      };
    }
    const dataPath = standardDataPath;
    const deleted = existsSync(dataPath);
    rmSync(dataPath, {
      force: true,
      recursive: true,
    });
    return {
      dataPath,
      deleted,
      deletionMode: 'profile_data_directory',
      localDatabasePath,
    };
  }

  credentialPermissions(profileName: string): number | undefined {
    const path = this.credentialPath(profileName);
    if (!existsSync(path)) return undefined;
    return statSync(path).mode & 0o777;
  }

  credentialsAreRestrictive(profileName: string): boolean {
    const mode = this.credentialPermissions(profileName);
    if (mode === undefined) return false;
    return (mode & 0o077) === 0;
  }

  loadPendingJoinAttempt(profileName: string): PendingJoinAttempt | undefined {
    const path = this.joinAttemptPath(profileName);
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as PendingJoinAttempt;
    if (parsed.schemaVersion !== 1) {
      throw new Error(`Unsupported Handoff join attempt schema version for ${profileName}.`);
    }
    return parsed;
  }

  savePendingJoinAttempt(attempt: PendingJoinAttempt): void {
    this.ensureHome();
    writeFileSync(
      this.joinAttemptPath(attempt.profileName),
      `${JSON.stringify(attempt, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  deletePendingJoinAttempt(profileName: string): void {
    rmSync(this.joinAttemptPath(profileName), { force: true });
  }
}

export function createProfileStore(input: { env?: HandoffEnv; home?: string } = {}): ProfileStore {
  return new ProfileStore(input.home ?? getHandoffHome(input.env));
}

export function getHandoffHome(env: HandoffEnv = process.env): string {
  return env.HANDOFF_HOME ?? env.AGENT_RELAY_HOME ?? join(homedir(), '.handoff');
}

export function resolveProfileName(profileName?: string, env: HandoffEnv = process.env): string {
  return sanitizeProfileName(
    profileName ?? env.HANDOFF_PROFILE ?? env.AGENT_RELAY_PROFILE ?? 'default',
  );
}

export function inferHandle(env: HandoffEnv = process.env): string {
  const raw = env.HANDOFF_HANDLE ?? env.USER ?? env.USERNAME ?? safeUserName() ?? 'user';
  const handle = raw
    .trim()
    .replace(/^@/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+/g, '-')
    .slice(0, 32);
  return handle.length >= 2 ? handle : 'user';
}

export function inferDisplayName(env: HandoffEnv = process.env): string {
  return env.HANDOFF_DISPLAY_NAME ?? env.NAME ?? safeUserName() ?? inferHandle(env);
}

export function sanitizeProfileName(profileName: string): string {
  const normalized = profileName.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(normalized)) {
    throw new Error('Profile names must use letters, numbers, dots, dashes, or underscores.');
  }
  return normalized;
}

export function redactProfile(profile: HandoffProfile): Record<string, unknown> {
  return {
    profileName: profile.profileName,
    workspaceId: profile.workspaceId,
    workspaceName: profile.workspaceName,
    memberId: profile.memberId,
    handle: profile.handle,
    displayName: profile.displayName,
    role: profile.role,
    serverUrl: profile.serverUrl,
    publicInviteBaseUrl: profile.publicInviteBaseUrl,
    localDatabasePath: profile.localDatabasePath,
    serverMode: profile.serverMode,
    createdAt: profile.createdAt,
    lastVerifiedAt: profile.lastVerifiedAt,
  };
}

function deleteDatabaseFiles(localDatabasePath: string): boolean {
  let deleted = false;
  for (const path of [
    localDatabasePath,
    `${localDatabasePath}-wal`,
    `${localDatabasePath}-shm`,
    `${localDatabasePath}-journal`,
  ]) {
    if (!existsSync(path)) continue;
    unlinkSync(path);
    deleted = true;
  }
  return deleted;
}

function safeUserName(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
}
