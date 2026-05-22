/**
 * Tracing stub — simulates OpenTelemetry-style spans without a real backend.
 * In production, replace this with @opentelemetry/sdk-node + OTLP exporter.
 * Purpose here: demonstrate the observability contract (trace_id, span_id,
 * parent_span_id, operation, duration_ms) that a real tracer would emit.
 */
import { randomUUID } from 'crypto';

import { logger } from '../logger/logger';

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operation: string;
  startedAt: number;
  finish(attrs?: Record<string, unknown>): void;
}

export function startSpan(operation: string, parentSpanId?: string): Span {
  const traceId = randomUUID().replace(/-/g, '');
  const spanId = randomUUID().replace(/-/g, '').slice(0, 16);
  const startedAt = Date.now();

  return {
    traceId,
    spanId,
    parentSpanId,
    operation,
    startedAt,
    finish(attrs?: Record<string, unknown>): void {
      const durationMs = Date.now() - startedAt;
      logger.debug(`[TRACE] span finished`, {
        trace_id: traceId,
        span_id: spanId,
        parent_span_id: parentSpanId,
        operation,
        duration_ms: durationMs,
        ...attrs,
      });
    },
  };
}
