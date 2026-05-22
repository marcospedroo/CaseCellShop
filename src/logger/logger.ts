import pino from 'pino';

import { requestContext } from '../context/requestContext';

const SERVICE_NAME = 'casecellshop-backend';

const baseLogger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  base: { service: SERVICE_NAME },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: ['password', 'token', 'authorization', 'cpf', 'cardNumber', 'cvv'],
    censor: '[REDACTED]',
  },
});

export interface LogMeta {
  durationMs?: number;
  orderId?: string;
  [key: string]: unknown;
}

function withContext(meta?: LogMeta): Record<string, unknown> {
  const ctx = requestContext.get();
  return {
    correlationId: ctx?.correlationId ?? 'unknown',
    requestId: ctx?.requestId ?? 'unknown',
    orderId: meta?.orderId ?? ctx?.orderId,
    service: SERVICE_NAME,
    ...meta,
  };
}

export const logger = {
  info(message: string, meta?: LogMeta): void {
    baseLogger.info(withContext(meta), message);
  },
  warn(message: string, meta?: LogMeta): void {
    baseLogger.warn(withContext(meta), message);
  },
  error(message: string, err?: unknown, meta?: LogMeta): void {
    const errorObj = err instanceof Error
      ? {
          message: err.message,
          stack: process.env['NODE_ENV'] !== 'production' ? err.stack : undefined,
          code: (err as NodeJS.ErrnoException).code,
        }
      : undefined;

    baseLogger.error({ ...withContext(meta), error: errorObj }, message);
  },
  debug(message: string, meta?: LogMeta): void {
    baseLogger.debug(withContext(meta), message);
  },
};
