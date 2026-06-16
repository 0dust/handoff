import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

export type RelayDatabase = Database.Database;

const schema = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  admin_body_access INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  handle TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  approval_secret_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE(workspace_id, handle),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
);

CREATE TABLE IF NOT EXISTS project_aliases (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  canonical_project TEXT NOT NULL,
  alias TEXT NOT NULL,
  created_by_member_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(workspace_id, alias),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY(created_by_member_id) REFERENCES members(id)
);

CREATE INDEX IF NOT EXISTS project_alias_workspace_idx ON project_aliases(workspace_id);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  handle TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_by_member_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
);

CREATE TABLE IF NOT EXISTS packets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  packet_type TEXT NOT NULL,
  sender_member_id TEXT NOT NULL,
  recipient_member_ids TEXT NOT NULL,
  parent_packet_id TEXT,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  question TEXT,
  finding TEXT,
  answer TEXT,
  project TEXT NOT NULL,
  source_client TEXT NOT NULL,
  claims TEXT NOT NULL,
  evidence TEXT NOT NULL,
  files_or_symbols TEXT NOT NULL,
  commands_or_tests_run TEXT NOT NULL,
  what_was_tried TEXT NOT NULL,
  known_failures TEXT NOT NULL,
  current_hypothesis TEXT NOT NULL,
  confidence TEXT NOT NULL,
  suggested_next_steps TEXT NOT NULL,
  redaction_report TEXT NOT NULL,
  hydration_policy TEXT NOT NULL,
  audit_receipt TEXT NOT NULL,
  expires_at TEXT,
  recheck_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
);

CREATE INDEX IF NOT EXISTS packets_workspace_idx ON packets(workspace_id);
CREATE INDEX IF NOT EXISTS packets_sender_idx ON packets(sender_member_id);
CREATE INDEX IF NOT EXISTS packets_status_idx ON packets(status);

CREATE TABLE IF NOT EXISTS audit_receipts (
  receipt_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  packet_id TEXT,
  actor_member_id TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metadata TEXT NOT NULL,
  receipt_hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_packet_idx ON audit_receipts(packet_id);

CREATE TABLE IF NOT EXISTS hydration_receipts (
  receipt_id TEXT PRIMARY KEY,
  packet_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  actor_member_id TEXT NOT NULL,
  client TEXT NOT NULL,
  session_id TEXT,
  context TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  packet_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT
);

CREATE TABLE IF NOT EXISTS approval_tokens (
  id TEXT PRIMARY KEY,
  packet_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  actor_member_id TEXT NOT NULL,
  action TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS approval_packet_idx ON approval_tokens(packet_id, actor_member_id, action);
`;

export function createRelayDatabase(path = ':memory:'): RelayDatabase {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  ensureColumn(db, 'members', 'approval_secret_hash', "TEXT NOT NULL DEFAULT ''");
  return db;
}

function ensureColumn(db: RelayDatabase, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((entry) => entry.name === column)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  }
}
