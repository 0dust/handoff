import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import { createPacketTableSql } from './packet-table.js';
import { createPacketTransportTableSql } from './packet-transport-table.js';

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
  accepted_member_id TEXT,
  accept_idempotency_key_hash TEXT,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
);

${createPacketTableSql()}

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

CREATE UNIQUE INDEX IF NOT EXISTS notifications_packet_member_idx ON notifications(packet_id, member_id);

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

${createPacketTransportTableSql()}
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
  ensureColumn(db, 'invites', 'accepted_member_id', 'TEXT');
  ensureColumn(db, 'invites', 'accept_idempotency_key_hash', 'TEXT');
  return db;
}

function ensureColumn(db: RelayDatabase, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((entry) => entry.name === column)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  }
}
