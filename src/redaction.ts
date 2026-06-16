import type { RedactionFinding, RedactionReport, RelayPacket } from './protocol/schema.js';

export interface RedactionOptions {
  maxExcerptCharacters?: number;
  userPatterns?: RegExp[];
}

const apiKeyPattern =
  /\b(?:sk-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:api[_-]?key|access[_-]?token|secret|password)\s*=\s*[^\s"'`]+)\b/i;
const privateKeyPattern = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/;
const credentialUrlPattern = /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s]+@/i;
const envSecretPattern =
  /(^|\n)\s*(?:[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*)\s*=\s*[^\s]+/i;
const localPathPattern =
  /(?:^|\s)(\/Users\/[^\s"'`]+|\/home\/[^\s"'`]+|[A-Za-z]:\\Users\\[^\s"'`]+)/;

function preview(value: string): string {
  return value.replace(/\s+/g, ' ').slice(0, 80);
}

function scanText(
  text: string,
  field: string,
  evidenceId: string | undefined,
  options: Required<Pick<RedactionOptions, 'maxExcerptCharacters'>> & RedactionOptions,
): { findings: RedactionFinding[]; warnings: RedactionFinding[] } {
  const findings: RedactionFinding[] = [];
  const warnings: RedactionFinding[] = [];
  const addBlock = (kind: RedactionFinding['kind'], message: string) => {
    findings.push({
      kind,
      field,
      evidence_id: evidenceId,
      severity: 'block',
      message,
      preview: preview(text),
    });
  };
  const addWarning = (kind: RedactionFinding['kind'], message: string) => {
    warnings.push({
      kind,
      field,
      evidence_id: evidenceId,
      severity: 'warning',
      message,
      preview: preview(text),
    });
  };

  if (apiKeyPattern.test(text)) {
    addBlock('api_key', 'Secret-looking API key or token detected.');
  }
  if (privateKeyPattern.test(text)) {
    addBlock('private_key', 'Private key material detected.');
  }
  if (credentialUrlPattern.test(text)) {
    addBlock('credential_url', 'Credential-bearing URL detected.');
  }
  if (envSecretPattern.test(text)) {
    addBlock('env_secret', '.env-like secret content detected.');
  }
  if (localPathPattern.test(text)) {
    addWarning('local_path', 'Local absolute path detected; review before sending.');
  }
  if (text.length > options.maxExcerptCharacters) {
    addWarning(
      'oversized_excerpt',
      `Evidence excerpt exceeds ${options.maxExcerptCharacters} characters and should be compressed.`,
    );
  }
  for (const pattern of options.userPatterns ?? []) {
    if (pattern.test(text)) {
      addBlock('user_pattern', 'User-defined restricted pattern detected.');
    }
  }

  return { findings, warnings };
}

export function scanPacketForRedactions(
  packet: RelayPacket,
  options: RedactionOptions = {},
): RedactionReport {
  const mergedOptions = {
    maxExcerptCharacters: options.maxExcerptCharacters ?? 2000,
    userPatterns: options.userPatterns,
  };
  const findings: RedactionFinding[] = [];
  const warnings: RedactionFinding[] = [];
  const textFields = collectRedactionTextFields(packet);

  for (const [field, value] of textFields) {
    if (!value) continue;
    const result = scanText(value, field, undefined, mergedOptions);
    findings.push(...result.findings);
    warnings.push(...result.warnings);
  }

  for (const [index, evidence] of packet.evidence.entries()) {
    if (evidence.sensitivity === 'secret_detected' || evidence.sensitivity === 'restricted') {
      findings.push({
        kind: 'user_pattern',
        field: `evidence.${index}.sensitivity`,
        evidence_id: evidence.evidence_id,
        severity: 'block',
        message: `Evidence sensitivity ${evidence.sensitivity} cannot be sent without override.`,
      });
    }
  }

  return {
    blocked: findings.some((finding) => finding.severity === 'block'),
    findings,
    warnings,
  };
}

function collectRedactionTextFields(packet: RelayPacket): Array<[string, string]> {
  const fields: Array<[string, string]> = [
    ['title', packet.title],
    ['summary', packet.summary],
    ['current_hypothesis', packet.current_hypothesis],
    ...optionalField('question', packet.question),
    ...optionalField('finding', packet.finding),
    ...optionalField('answer', packet.answer),
  ];

  for (const [index, claim] of packet.claims.entries()) {
    fields.push([`claims.${index}.text`, claim.text]);
  }
  pushArrayFields(fields, 'files_or_symbols', packet.files_or_symbols);
  pushArrayFields(fields, 'commands_or_tests_run', packet.commands_or_tests_run);
  pushArrayFields(fields, 'what_was_tried', packet.what_was_tried);
  pushArrayFields(fields, 'known_failures', packet.known_failures);
  pushArrayFields(fields, 'suggested_next_steps', packet.suggested_next_steps);

  for (const [index, evidence] of packet.evidence.entries()) {
    fields.push([`evidence.${index}.label`, evidence.label]);
    fields.push([`evidence.${index}.source`, evidence.source]);
    fields.push([`evidence.${index}.excerpt`, evidence.excerpt]);
  }

  return fields;
}

function optionalField(field: string, value: string | undefined): Array<[string, string]> {
  return value ? [[field, value]] : [];
}

function pushArrayFields(fields: Array<[string, string]>, prefix: string, values: string[]): void {
  for (const [index, value] of values.entries()) {
    fields.push([`${prefix}.${index}`, value]);
  }
}
