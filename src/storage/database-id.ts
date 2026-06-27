import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export function databaseIdForPath(dbPath: string): string {
  return createHash('sha256').update(resolve(dbPath)).digest('hex');
}
