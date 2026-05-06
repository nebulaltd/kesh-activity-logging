import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { UnauthorizedError } from '../lib/errors';

const PUBLIC_PATHS = new Set<string>(['/health']);

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export function makeApiKeyHook(expectedKey: string) {
  return async function apiKeyHook(request: FastifyRequest): Promise<void> {
    const path = request.url.split('?')[0] ?? '';
    if (PUBLIC_PATHS.has(path)) return;

    const provided = request.headers['x-api-key'];
    if (typeof provided !== 'string' || !safeEqual(provided, expectedKey)) {
      throw new UnauthorizedError();
    }
  };
}
