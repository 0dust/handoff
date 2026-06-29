import { packetColumnNames, packetMutableColumnNames } from '../storage/packet-table.js';
import type { RelayDatabase } from '../storage/database.js';
import {
  draftLikePacketStatuses,
  packetSchema,
  terminalPacketStatuses,
  type PacketStatus,
  type RelayPacket,
} from '../protocol/schema.js';

export interface PacketRow {
  id: string;
  workspace_id: string;
  packet_type: RelayPacket['packet_type'];
  sender_member_id: string;
  recipient_member_ids: string;
  parent_packet_id: string | null;
  status: PacketStatus;
  title: string;
  summary: string;
  question: string | null;
  finding: string | null;
  answer: string | null;
  project: string;
  source_client: RelayPacket['source_client'];
  claims: string;
  evidence: string;
  files_or_symbols: string;
  commands_or_tests_run: string;
  what_was_tried: string;
  known_failures: string;
  current_hypothesis: string;
  confidence: RelayPacket['confidence'];
  suggested_next_steps: string;
  redaction_report: string;
  hydration_policy: string;
  audit_receipt: string;
  expires_at: string | null;
  recheck_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PacketRepositoryFilters {
  canonicalProject?: string;
  fileOrSymbol?: string;
  historyFilter?: 'all' | 'closed' | 'drafts' | 'open' | 'sent';
  limit?: number;
  offset?: number;
  query?: string;
  recipientMemberId?: string;
  senderMemberId?: string;
  status?: PacketStatus;
  ticketOrPr?: string;
}

export interface PacketRepositorySearchInput {
  actorIsAdmin: boolean;
  actorMemberId: string;
  adminBodyAccess: boolean;
  filters: PacketRepositoryFilters;
  workspaceId: string;
}

const insertColumns = packetColumnNames.join(', ');
const insertValues = packetColumnNames.map((column) => `@${column}`).join(', ');
const updateAssignments = packetMutableColumnNames
  .map((column) => `${column} = @${column}`)
  .join(',\n          ');

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function rowToPacket(row: PacketRow): RelayPacket {
  return packetSchema.parse({
    packet_id: row.id,
    packet_type: row.packet_type,
    workspace_id: row.workspace_id,
    sender_member_id: row.sender_member_id,
    recipient_member_ids: parseJson<string[]>(row.recipient_member_ids),
    parent_packet_id: row.parent_packet_id ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at ?? undefined,
    recheck_by: row.recheck_by ?? undefined,
    status: row.status,
    project: parseJson(row.project),
    source_client: row.source_client,
    title: row.title,
    summary: row.summary,
    question: row.question ?? undefined,
    finding: row.finding ?? undefined,
    answer: row.answer ?? undefined,
    claims: parseJson(row.claims),
    evidence: parseJson(row.evidence),
    files_or_symbols: parseJson(row.files_or_symbols),
    commands_or_tests_run: parseJson(row.commands_or_tests_run),
    what_was_tried: parseJson(row.what_was_tried),
    known_failures: parseJson(row.known_failures),
    current_hypothesis: row.current_hypothesis,
    confidence: row.confidence,
    suggested_next_steps: parseJson(row.suggested_next_steps),
    redaction_report: parseJson(row.redaction_report),
    hydration_policy: parseJson(row.hydration_policy),
    audit_receipt: parseJson(row.audit_receipt),
  });
}

function packetParams(packet: RelayPacket): Record<string, unknown> {
  return {
    id: packet.packet_id,
    workspace_id: packet.workspace_id,
    packet_type: packet.packet_type,
    sender_member_id: packet.sender_member_id,
    recipient_member_ids: JSON.stringify(packet.recipient_member_ids),
    parent_packet_id: packet.parent_packet_id ?? null,
    status: packet.status,
    title: packet.title,
    summary: packet.summary,
    question: packet.question ?? null,
    finding: packet.finding ?? null,
    answer: packet.answer ?? null,
    project: JSON.stringify(packet.project),
    source_client: packet.source_client,
    claims: JSON.stringify(packet.claims),
    evidence: JSON.stringify(packet.evidence),
    files_or_symbols: JSON.stringify(packet.files_or_symbols),
    commands_or_tests_run: JSON.stringify(packet.commands_or_tests_run),
    what_was_tried: JSON.stringify(packet.what_was_tried),
    known_failures: JSON.stringify(packet.known_failures),
    current_hypothesis: packet.current_hypothesis,
    confidence: packet.confidence,
    suggested_next_steps: JSON.stringify(packet.suggested_next_steps),
    redaction_report: JSON.stringify(packet.redaction_report),
    hydration_policy: JSON.stringify(packet.hydration_policy),
    audit_receipt: JSON.stringify(packet.audit_receipt),
    expires_at: packet.expires_at ?? null,
    recheck_by: packet.recheck_by ?? null,
    created_at: packet.created_at,
    updated_at: packet.updated_at,
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function statusListSql(statuses: readonly PacketStatus[]): string {
  return statuses.map((status) => `'${status}'`).join(', ');
}

const terminalStatusSql = statusListSql(terminalPacketStatuses);
const draftLikeStatusSql = statusListSql(draftLikePacketStatuses);

export class PacketRepository {
  constructor(private readonly db: RelayDatabase) {}

  get(packetId: string): RelayPacket | undefined {
    const row = this.db.prepare('SELECT * FROM packets WHERE id = ?').get(packetId) as
      | PacketRow
      | undefined;
    return row ? rowToPacket(row) : undefined;
  }

  insert(packet: RelayPacket): RelayPacket {
    this.db
      .prepare(`INSERT INTO packets (${insertColumns}) VALUES (${insertValues})`)
      .run(packetParams(packet));
    return packet;
  }

  update(packet: RelayPacket): RelayPacket {
    this.db
      .prepare(
        `UPDATE packets SET
          ${updateAssignments}
        WHERE id = @id`,
      )
      .run(packetParams(packet));
    return packet;
  }

  listWorkspacePackets(workspaceId: string): RelayPacket[] {
    return (
      this.db
        .prepare('SELECT * FROM packets WHERE workspace_id = ? ORDER BY created_at DESC, id DESC')
        .all(workspaceId) as PacketRow[]
    ).map(rowToPacket);
  }

  search(input: PacketRepositorySearchInput): RelayPacket[] {
    const where = ['workspace_id = @workspaceId', this.metadataAccessSql()];
    const params: Record<string, unknown> = {
      actorIsAdmin: input.actorIsAdmin ? 1 : 0,
      actorMemberId: input.actorMemberId,
      adminBodyAccess: input.adminBodyAccess ? 1 : 0,
      workspaceId: input.workspaceId,
    };
    this.applyHistoryFilter(where, params, input.filters);
    this.applyPacketFilters(where, params, input.filters);
    this.applyTextSearch(where, params, input.filters.query);

    const limit = input.filters.limit ?? 50;
    const offset = input.filters.offset ?? 0;
    params.limit = limit;
    params.offset = offset;

    return (
      this.db
        .prepare(
          `SELECT * FROM packets
          WHERE ${where.join('\n            AND ')}
          ORDER BY created_at DESC, id DESC
          LIMIT @limit OFFSET @offset`,
        )
        .all(params) as PacketRow[]
    ).map(rowToPacket);
  }

  private applyPacketFilters(
    where: string[],
    params: Record<string, unknown>,
    filters: PacketRepositoryFilters,
  ): void {
    if (filters.canonicalProject) {
      where.push("lower(json_extract(project, '$.repo_name')) = @canonicalProject");
      params.canonicalProject = filters.canonicalProject;
    }
    if (filters.senderMemberId) {
      where.push('sender_member_id = @senderMemberId');
      params.senderMemberId = filters.senderMemberId;
    }
    if (filters.recipientMemberId) {
      where.push(this.recipientContainsSql('@recipientMemberId'));
      params.recipientMemberId = filters.recipientMemberId;
    }
    if (filters.status) {
      where.push('status = @status');
      params.status = filters.status;
    }
    if (filters.fileOrSymbol?.trim()) {
      where.push(
        `${this.bodyAccessSql()} AND lower(files_or_symbols) LIKE @fileOrSymbol ESCAPE '\\'`,
      );
      params.fileOrSymbol = `%${escapeLike(filters.fileOrSymbol.trim().toLowerCase())}%`;
    }
    if (filters.ticketOrPr?.trim()) {
      where.push(`${this.bodyAccessSql()} AND ${this.ticketOrPrSql()}`);
      params.ticketOrPr = `%${escapeLike(filters.ticketOrPr.trim().toLowerCase())}%`;
    }
  }

  private applyHistoryFilter(
    where: string[],
    params: Record<string, unknown>,
    filters: PacketRepositoryFilters,
  ): void {
    switch (filters.historyFilter ?? 'all') {
      case 'all':
        return;
      case 'closed':
        where.push(`status IN (${terminalStatusSql})`);
        return;
      case 'drafts':
        where.push('sender_member_id = @draftActorMemberId');
        where.push(`status IN (${draftLikeStatusSql})`);
        params.draftActorMemberId = params.actorMemberId;
        return;
      case 'sent':
        where.push('sender_member_id = @sentActorMemberId');
        where.push("status <> 'pending_sender_approval'");
        params.sentActorMemberId = params.actorMemberId;
        return;
      case 'open':
        where.push(`status NOT IN (${terminalStatusSql})`);
        where.push(`status NOT IN (${draftLikeStatusSql})`);
        return;
    }
  }

  private applyTextSearch(
    where: string[],
    params: Record<string, unknown>,
    query: string | undefined,
  ): void {
    const trimmed = query?.trim().toLowerCase();
    if (!trimmed) return;
    params.query = `%${escapeLike(trimmed)}%`;
    where.push(
      `(
        lower(id) LIKE @query ESCAPE '\\'
        OR lower(packet_type) LIKE @query ESCAPE '\\'
        OR lower(workspace_id) LIKE @query ESCAPE '\\'
        OR lower(sender_member_id) LIKE @query ESCAPE '\\'
        OR lower(recipient_member_ids) LIKE @query ESCAPE '\\'
        OR lower(status) LIKE @query ESCAPE '\\'
        OR lower(project) LIKE @query ESCAPE '\\'
        OR lower(source_client) LIKE @query ESCAPE '\\'
        OR lower(created_at) LIKE @query ESCAPE '\\'
        OR lower(updated_at) LIKE @query ESCAPE '\\'
        OR lower(coalesce(expires_at, '')) LIKE @query ESCAPE '\\'
        OR lower(coalesce(recheck_by, '')) LIKE @query ESCAPE '\\'
        OR (${this.bodyAccessSql()} AND (
          lower(title) LIKE @query ESCAPE '\\'
          OR lower(summary) LIKE @query ESCAPE '\\'
          OR lower(coalesce(question, '')) LIKE @query ESCAPE '\\'
          OR lower(coalesce(finding, '')) LIKE @query ESCAPE '\\'
          OR lower(coalesce(answer, '')) LIKE @query ESCAPE '\\'
          OR lower(current_hypothesis) LIKE @query ESCAPE '\\'
          OR lower(files_or_symbols) LIKE @query ESCAPE '\\'
          OR lower(commands_or_tests_run) LIKE @query ESCAPE '\\'
          OR lower(what_was_tried) LIKE @query ESCAPE '\\'
          OR lower(known_failures) LIKE @query ESCAPE '\\'
          OR lower(suggested_next_steps) LIKE @query ESCAPE '\\'
          OR lower(claims) LIKE @query ESCAPE '\\'
          OR lower(evidence) LIKE @query ESCAPE '\\'
        ))
      )`,
    );
  }

  private metadataAccessSql(): string {
    return `(
      sender_member_id = @actorMemberId
      OR ${this.recipientContainsSql('@actorMemberId')}
      OR @actorIsAdmin = 1
    )`;
  }

  private bodyAccessSql(): string {
    return `(
      sender_member_id = @actorMemberId
      OR ${this.recipientContainsSql('@actorMemberId')}
      OR (@actorIsAdmin = 1 AND @adminBodyAccess = 1)
    )`;
  }

  private recipientContainsSql(parameterName: string): string {
    return `EXISTS (
      SELECT 1 FROM json_each(packets.recipient_member_ids)
      WHERE json_each.value = ${parameterName}
    )`;
  }

  private ticketOrPrSql(): string {
    return `EXISTS (
      SELECT 1 FROM json_each(packets.evidence)
      WHERE json_extract(json_each.value, '$.kind') IN ('ticket_link', 'pr_link')
      AND lower(
        coalesce(json_extract(json_each.value, '$.label'), '') || ' ' ||
        coalesce(json_extract(json_each.value, '$.source'), '') || ' ' ||
        coalesce(json_extract(json_each.value, '$.excerpt'), '')
      ) LIKE @ticketOrPr ESCAPE '\\'
    )`;
  }
}
