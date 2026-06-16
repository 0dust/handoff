import secretEvidence from '../fixtures/secret-redaction.json' with { type: 'json' };
import normalAsk from '../fixtures/normal-ask.json' with { type: 'json' };
import { describe, expect, test } from 'vitest';

import { scanPacketForRedactions } from '../src/redaction.js';
import { packetSchema } from '../src/protocol/schema.js';

describe('redaction engine', () => {
  test('blocks secret-looking evidence by default', () => {
    const packet = packetSchema.parse({
      ...normalAsk,
      evidence: [secretEvidence],
    });

    const report = scanPacketForRedactions(packet);

    expect(report.blocked).toBe(true);
    expect(report.findings.some((finding) => finding.kind === 'api_key')).toBe(true);
    expect(report.findings.some((finding) => finding.kind === 'credential_url')).toBe(true);
  });

  test('warns on local absolute paths without blocking the packet', () => {
    const packet = packetSchema.parse({
      ...normalAsk,
      evidence: [
        {
          ...normalAsk.evidence[0],
          excerpt: 'Failure reproduced from /Users/alice/project-api/.env.test',
        },
      ],
    });

    const report = scanPacketForRedactions(packet);

    expect(report.blocked).toBe(false);
    expect(report.warnings.some((warning) => warning.kind === 'local_path')).toBe(true);
  });

  test('warns on oversized raw logs and reports the configured excerpt limit', () => {
    const packet = packetSchema.parse({
      ...normalAsk,
      evidence: [
        {
          ...normalAsk.evidence[0],
          excerpt: `log\n${'line\n'.repeat(700)}`,
        },
      ],
    });

    const report = scanPacketForRedactions(packet, { maxExcerptCharacters: 2000 });

    expect(report.blocked).toBe(false);
    expect(report.warnings.some((warning) => warning.kind === 'oversized_excerpt')).toBe(true);
  });
});
