import {
  INTERNAL_A2A_PROTOCOL,
  trustReceiptSchema,
  type A2aTaskState,
  type TrustReceipt,
} from '../a2a/schema.js';
import { createId } from '../identity.js';
import type { RelayDatabase } from './database.js';

export type PacketTransportDirection = 'inbound' | 'outbound';
export type PacketTransportProtocol = typeof INTERNAL_A2A_PROTOCOL;

export interface PacketTransportRecord {
  id: string;
  packet_id: string;
  workspace_id: string;
  protocol: PacketTransportProtocol;
  task_id: string;
  artifact_id: string;
  trust_receipt_artifact_id: string;
  packet_hash: string;
  task_state: A2aTaskState;
  direction: PacketTransportDirection;
  remote_endpoint?: string;
  trust_receipt: TrustReceipt;
  last_error?: string;
  created_at: string;
  updated_at: string;
}

export interface UpsertPacketTransportInput {
  existing?: PacketTransportRecord;
  allowPacketHashRefresh?: boolean;
  packet_id: string;
  workspace_id: string;
  protocol?: PacketTransportProtocol;
  task_id: string;
  artifact_id: string;
  trust_receipt_artifact_id: string;
  packet_hash: string;
  task_state: A2aTaskState;
  direction: PacketTransportDirection;
  remote_endpoint?: string;
  trust_receipt: TrustReceipt;
  last_error?: string;
  now?: string;
}

interface PacketTransportRow {
  id: string;
  packet_id: string;
  workspace_id: string;
  protocol: PacketTransportProtocol;
  task_id: string;
  artifact_id: string;
  trust_receipt_artifact_id: string;
  packet_hash: string;
  task_state: A2aTaskState;
  direction: PacketTransportDirection;
  remote_endpoint: string | null;
  trust_receipt: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export function createPacketTransportTableSql(): string {
  return `
-- Adapter metadata is intentionally separate from packet bodies. V1 records
-- internal outbound A2A rows; protocol/direction/endpoint/error columns are
-- reserved for stable future adapter bookkeeping without changing packet shape.
CREATE TABLE IF NOT EXISTS packet_transports (
  id TEXT PRIMARY KEY,
  packet_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  protocol TEXT NOT NULL,
  task_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  trust_receipt_artifact_id TEXT NOT NULL,
  packet_hash TEXT NOT NULL,
  task_state TEXT NOT NULL,
  direction TEXT NOT NULL,
  remote_endpoint TEXT,
  trust_receipt TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(packet_id, protocol),
  FOREIGN KEY(packet_id) REFERENCES packets(id),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
);

CREATE INDEX IF NOT EXISTS packet_transports_workspace_idx ON packet_transports(workspace_id, updated_at);
CREATE INDEX IF NOT EXISTS packet_transports_task_idx ON packet_transports(protocol, task_id);
`;
}

export class PacketTransportRepository {
  constructor(private readonly db: RelayDatabase) {}

  get(packetId: string, protocol: PacketTransportProtocol = INTERNAL_A2A_PROTOCOL) {
    const row = this.db
      .prepare('SELECT * FROM packet_transports WHERE packet_id = ? AND protocol = ?')
      .get(packetId, protocol) as PacketTransportRow | undefined;
    return row ? rowToPacketTransport(row) : undefined;
  }

  listForPacket(packetId: string): PacketTransportRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM packet_transports WHERE packet_id = ? ORDER BY updated_at DESC')
        .all(packetId) as PacketTransportRow[]
    ).map(rowToPacketTransport);
  }

  upsert(input: UpsertPacketTransportInput): PacketTransportRecord {
    const now = input.now ?? new Date().toISOString();
    const protocol = input.protocol ?? INTERNAL_A2A_PROTOCOL;
    const existing = input.existing ?? this.get(input.packet_id, protocol);
    const id = existing?.id ?? createId('ptr');
    const createdAt = existing?.created_at ?? now;
    const remoteEndpoint = validateRemoteEndpoint(input.remote_endpoint);
    const lastError = input.last_error ?? existing?.last_error;
    if (existing && input.packet_hash !== existing.packet_hash && !input.allowPacketHashRefresh) {
      throw new Error('Packet transport packet hash is immutable.');
    }
    if (input.trust_receipt.packet_hash !== input.packet_hash) {
      throw new Error('Packet transport packet hash must match the trust receipt packet hash.');
    }

    const saved = this.db
      .prepare(
        `INSERT INTO packet_transports
          (id, packet_id, workspace_id, protocol, task_id, artifact_id, trust_receipt_artifact_id,
           packet_hash, task_state, direction, remote_endpoint, trust_receipt, last_error, created_at, updated_at)
        VALUES
          (@id, @packet_id, @workspace_id, @protocol, @task_id, @artifact_id, @trust_receipt_artifact_id,
           @packet_hash, @task_state, @direction, @remote_endpoint, @trust_receipt, @last_error, @created_at, @updated_at)
        ON CONFLICT(packet_id, protocol) DO UPDATE SET
          workspace_id = excluded.workspace_id,
          task_id = excluded.task_id,
          artifact_id = excluded.artifact_id,
          trust_receipt_artifact_id = excluded.trust_receipt_artifact_id,
          packet_hash = excluded.packet_hash,
          task_state = excluded.task_state,
          direction = excluded.direction,
          remote_endpoint = excluded.remote_endpoint,
          trust_receipt = excluded.trust_receipt,
          last_error = excluded.last_error,
          updated_at = excluded.updated_at
        WHERE packet_transports.packet_hash = excluded.packet_hash
          OR @allow_packet_hash_refresh = 1
        RETURNING *`,
      )
      .get({
        allow_packet_hash_refresh: input.allowPacketHashRefresh ? 1 : 0,
        id,
        packet_id: input.packet_id,
        workspace_id: input.workspace_id,
        protocol,
        task_id: input.task_id,
        artifact_id: input.artifact_id,
        trust_receipt_artifact_id: input.trust_receipt_artifact_id,
        packet_hash: input.packet_hash,
        task_state: input.task_state,
        direction: input.direction,
        remote_endpoint: remoteEndpoint ?? null,
        trust_receipt: JSON.stringify(input.trust_receipt),
        last_error: lastError ?? null,
        created_at: createdAt,
        updated_at: now,
      }) as PacketTransportRow | undefined;

    if (!saved) {
      throw new Error('Packet transport upsert did not persist a row; packet hash is immutable.');
    }
    return rowToPacketTransport(saved);
  }
}

export function rowToPacketTransport(row: PacketTransportRow): PacketTransportRecord {
  return {
    id: row.id,
    packet_id: row.packet_id,
    workspace_id: row.workspace_id,
    protocol: row.protocol,
    task_id: row.task_id,
    artifact_id: row.artifact_id,
    trust_receipt_artifact_id: row.trust_receipt_artifact_id,
    packet_hash: row.packet_hash,
    task_state: row.task_state,
    direction: row.direction,
    remote_endpoint: row.remote_endpoint ?? undefined,
    trust_receipt: trustReceiptSchema.parse(JSON.parse(row.trust_receipt)),
    last_error: row.last_error ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function validateRemoteEndpoint(endpoint: string | undefined): string | undefined {
  if (!endpoint) {
    return undefined;
  }
  const parsed = new URL(endpoint);
  if (parsed.username || parsed.password) {
    throw new Error('Remote transport endpoints must not include credentials.');
  }
  for (const key of parsed.searchParams.keys()) {
    if (/token|secret|key|auth/i.test(key)) {
      throw new Error('Remote transport endpoints must not include credential query parameters.');
    }
  }
  return parsed.toString();
}
