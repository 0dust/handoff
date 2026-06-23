import { z } from 'zod';

import { confidenceLevels, packetStatuses, sourceClients } from './schema.js';

export { sourceClients };

export const sourceClientInputSchema = z.enum(sourceClients).default('generic');
export const confidenceInputSchema = z.enum(confidenceLevels).optional();
export const historyFilters = ['all', 'drafts', 'sent', 'open', 'closed'] as const;
export const historyFilterInputSchema = z.enum(historyFilters).optional();

export type HistoryFilter = (typeof historyFilters)[number];

export const projectInputSchema = z
  .object({
    repo_name: z.string().min(1).optional(),
    git_remote_fingerprint: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    commit_hash: z.string().min(1).optional(),
  })
  .strict()
  .optional();

export const claimInputSchema = z
  .array(
    z
      .object({
        claim_id: z.string().optional(),
        text: z.string().optional(),
        confidence: z.enum(confidenceLevels).optional(),
        status: z.enum(['observed', 'inferred', 'suspected', 'disproven', 'superseded']).optional(),
        evidence_ids: z.array(z.string()).optional(),
        needs_recheck: z.boolean().optional(),
      })
      .strict(),
  )
  .optional();

export const evidenceInputSchema = z
  .array(
    z
      .object({
        evidence_id: z.string().optional(),
        kind: z
          .enum([
            'file_excerpt',
            'command_output',
            'test_failure',
            'error_message',
            'log_excerpt',
            'diff_summary',
            'ticket_link',
            'pr_link',
            'human_note',
          ])
          .default('human_note'),
        label: z.string().optional(),
        source: z.string().optional(),
        excerpt: z.string().optional(),
        hash: z.string().optional(),
        captured_at: z.string().optional(),
        sensitivity: z.enum(['normal', 'private', 'secret_detected', 'restricted']).optional(),
      })
      .strict(),
  )
  .optional();

export const packetDraftInputShape = {
  sourceClient: sourceClientInputSchema,
  project: projectInputSchema,
  claims: claimInputSchema,
  evidence: evidenceInputSchema,
  filesOrSymbols: z.array(z.string()).optional(),
  commandsOrTestsRun: z.array(z.string()).optional(),
  whatWasTried: z.array(z.string()).optional(),
  knownFailures: z.array(z.string()).optional(),
  currentHypothesis: z.string().optional(),
  confidence: confidenceInputSchema,
  suggestedNextSteps: z.array(z.string()).optional(),
} as const;

export const packetQueryInputShape = {
  project: z.string().optional(),
  sender: z.string().optional(),
  recipient: z.string().optional(),
  status: z.enum(packetStatuses).optional(),
  fileOrSymbol: z.string().optional(),
  ticketOrPr: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
} as const;
