import { randomBytes } from 'node:crypto';

export function generateId(prefix: string = 'gen'): string {
  const random = randomBytes(12).toString('base64url');
  return `${prefix}-${random}`;
}
