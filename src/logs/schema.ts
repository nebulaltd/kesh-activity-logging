import { z } from 'zod';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'fatal'] as const;

const Identifier = z.string().min(1).max(255);

export const InsertLogSchema = z
  .object({
    timestamp: z.number().int().nonnegative().optional(),
    source: z.string().min(1).max(255),
    level: z.enum(LOG_LEVELS),
    message: z.string().min(1),
    context: z.record(z.string(), z.unknown()).optional(),
    trace_id: Identifier.optional(),
    user_id: Identifier.optional(),
    entity_type: Identifier.optional(),
    entity_id: Identifier.optional(),
    action: Identifier.optional(),
    client_id: Identifier.optional(),
  })
  .strict();

export type InsertLogInput = z.infer<typeof InsertLogSchema>;

export const QueryLogsSchema = z.object({
  source: z.string().min(1).max(255).optional(),
  level: z.enum(LOG_LEVELS).optional(),
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
  trace_id: Identifier.optional(),
  user_id: Identifier.optional(),
  entity_type: Identifier.optional(),
  entity_id: Identifier.optional(),
  action: Identifier.optional(),
  client_id: Identifier.optional(),
  q: z.string().min(1).max(255).optional(),
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(1000).default(100),
});

export type QueryLogsInput = z.infer<typeof QueryLogsSchema>;
