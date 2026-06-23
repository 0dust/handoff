export const packetTableColumns = [
  { name: 'id', definition: 'TEXT PRIMARY KEY' },
  { name: 'workspace_id', definition: 'TEXT NOT NULL' },
  { name: 'packet_type', definition: 'TEXT NOT NULL' },
  { name: 'sender_member_id', definition: 'TEXT NOT NULL' },
  { name: 'recipient_member_ids', definition: 'TEXT NOT NULL' },
  { name: 'parent_packet_id', definition: 'TEXT' },
  { name: 'status', definition: 'TEXT NOT NULL' },
  { name: 'title', definition: 'TEXT NOT NULL' },
  { name: 'summary', definition: 'TEXT NOT NULL' },
  { name: 'question', definition: 'TEXT' },
  { name: 'finding', definition: 'TEXT' },
  { name: 'answer', definition: 'TEXT' },
  { name: 'project', definition: 'TEXT NOT NULL' },
  { name: 'source_client', definition: 'TEXT NOT NULL' },
  { name: 'claims', definition: 'TEXT NOT NULL' },
  { name: 'evidence', definition: 'TEXT NOT NULL' },
  { name: 'files_or_symbols', definition: 'TEXT NOT NULL' },
  { name: 'commands_or_tests_run', definition: 'TEXT NOT NULL' },
  { name: 'what_was_tried', definition: 'TEXT NOT NULL' },
  { name: 'known_failures', definition: 'TEXT NOT NULL' },
  { name: 'current_hypothesis', definition: 'TEXT NOT NULL' },
  { name: 'confidence', definition: 'TEXT NOT NULL' },
  { name: 'suggested_next_steps', definition: 'TEXT NOT NULL' },
  { name: 'redaction_report', definition: 'TEXT NOT NULL' },
  { name: 'hydration_policy', definition: 'TEXT NOT NULL' },
  { name: 'audit_receipt', definition: 'TEXT NOT NULL' },
  { name: 'expires_at', definition: 'TEXT' },
  { name: 'recheck_by', definition: 'TEXT' },
  { name: 'created_at', definition: 'TEXT NOT NULL' },
  { name: 'updated_at', definition: 'TEXT NOT NULL' },
] as const;

export const packetColumnNames = packetTableColumns.map((column) => column.name);

export const packetMutableColumnNames = packetColumnNames.filter(
  (column) =>
    !['id', 'workspace_id', 'packet_type', 'sender_member_id', 'created_at'].includes(column),
);

export function createPacketTableSql(): string {
  const columns = packetTableColumns
    .map((column) => `  ${column.name} ${column.definition}`)
    .join(',\n');
  return `CREATE TABLE IF NOT EXISTS packets (
${columns},
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
);`;
}
