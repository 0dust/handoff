import type { Command } from 'commander';

import { runTwoUserDemo } from '../demo/two-user.js';
import {
  addCommonOptions,
  closeBackend,
  createBackend,
  write,
  type CliIo,
  type CommonOptions,
} from './shared.js';

export function registerDemoCommands(program: Command, input: { io: CliIo }): void {
  const { io } = input;
  const demo = program.command('demo').description('Local demos');
  addCommonOptions(demo.command('two-user')).action(async (options: CommonOptions) => {
    const service = createBackend(options);
    try {
      const result = await runTwoUserDemo(service);
      write(io, result, options.json);
    } finally {
      closeBackend(service);
    }
  });
}
