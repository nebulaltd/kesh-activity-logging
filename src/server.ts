import Fastify, { type FastifyInstance } from 'fastify';
import type { Database } from 'bun:sqlite';
import { makeApiKeyHook } from './auth/apiKey';
import type { Config } from './config';
import { errorHandler } from './lib/errors';
import { registerLogRoutes } from './logs/routes';

export interface BuildOptions {
  db: Database;
  config: Config;
}

export function buildApp({ db, config }: BuildOptions): FastifyInstance {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    bodyLimit: config.BODY_LIMIT_BYTES,
  });

  app.setErrorHandler(errorHandler);
  app.addHook('onRequest', makeApiKeyHook(config.API_KEY));

  app.get('/health', () => ({ status: 'ok' }));
  registerLogRoutes(app, db);

  return app;
}
