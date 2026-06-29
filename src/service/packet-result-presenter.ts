import type { RelayPacket } from '../protocol/schema.js';

export const REDACTED_PACKET_TEXT = '[redacted]';

export interface PacketSearchResult {
  packet_id: string;
  packet_type: RelayPacket['packet_type'];
  workspace_id: string;
  sender_member_id: string;
  recipient_member_ids: string[];
  status: RelayPacket['status'];
  title: string;
  summary: string;
  project: RelayPacket['project'];
  source_client: RelayPacket['source_client'];
  created_at: string;
  updated_at: string;
  expires_at?: string;
  recheck_by?: string;
  body_access: boolean;
}

export function presentPacketSearchResult(input: {
  bodyAccess: boolean;
  packet: RelayPacket;
}): PacketSearchResult {
  const { bodyAccess, packet } = input;
  return {
    packet_id: packet.packet_id,
    packet_type: packet.packet_type,
    workspace_id: packet.workspace_id,
    sender_member_id: packet.sender_member_id,
    recipient_member_ids: packet.recipient_member_ids,
    status: packet.status,
    title: bodyAccess ? packet.title : REDACTED_PACKET_TEXT,
    summary: bodyAccess ? packet.summary : REDACTED_PACKET_TEXT,
    project: packet.project,
    source_client: packet.source_client,
    created_at: packet.created_at,
    updated_at: packet.updated_at,
    expires_at: packet.expires_at,
    recheck_by: packet.recheck_by,
    body_access: bodyAccess,
  };
}
