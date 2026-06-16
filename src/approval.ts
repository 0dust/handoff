import { createInterface } from 'node:readline/promises';
import { stdin as defaultInput, stderr as defaultOutput } from 'node:process';

import { RelayError } from './errors.js';
import type { ApprovalAction } from './service/relay-service.js';

export interface LocalApprovalRequest {
  action: ApprovalAction;
  packetId: string;
}

export async function confirmLocalApproval(input: LocalApprovalRequest): Promise<void> {
  if (process.env.AGENT_RELAY_ASSUME_HUMAN_APPROVAL === '1' && process.env.NODE_ENV === 'test') {
    return;
  }

  if (!defaultInput.isTTY || !defaultOutput.isTTY) {
    throw new RelayError(
      'FORBIDDEN',
      'Approval token creation requires the local approval renderer on an interactive TTY.',
      403,
    );
  }

  const phrase = `approve ${input.action} ${input.packetId}`;
  defaultOutput.write(
    `Handoff local approval required.\nType exactly "${phrase}" to create a short-lived approval token: `,
  );
  const readline = createInterface({ input: defaultInput, output: defaultOutput });
  try {
    const answer = await readline.question('');
    if (answer.trim() !== phrase) {
      throw new RelayError('FORBIDDEN', 'Local approval confirmation did not match.', 403);
    }
  } finally {
    readline.close();
  }
}
