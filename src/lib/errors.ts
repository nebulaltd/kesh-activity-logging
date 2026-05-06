import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export type ErrorCode = 'unauthorized' | 'validation_error' | 'not_found' | 'internal';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Missing or invalid API key') {
    super('unauthorized', 401, message);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Invalid input') {
    super('validation_error', 400, message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super('not_found', 404, message);
  }
}

export function errorHandler(err: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  if (err instanceof AppError) {
    return reply.status(err.statusCode).send({
      error: { code: err.code, message: err.message },
    });
  }

  if (err instanceof ZodError) {
    const message = err.issues
      .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
      .join('; ');
    return reply.status(400).send({
      error: { code: 'validation_error', message },
    });
  }

  const status = err.statusCode ?? 500;
  if (status >= 400 && status < 500) {
    return reply.status(status).send({
      error: { code: 'validation_error', message: err.message || 'Bad request' },
    });
  }

  request.log.error({ err }, 'unhandled error');
  return reply.status(500).send({
    error: { code: 'internal', message: 'Internal server error' },
  });
}
