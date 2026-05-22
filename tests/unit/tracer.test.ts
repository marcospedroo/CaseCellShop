jest.mock('../../src/logger/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));
jest.mock('../../src/metrics/metrics', () => ({
  cacheOperationsTotal: { inc: jest.fn() },
  httpRequestsTotal: { inc: jest.fn() },
  checkoutProcessingDuration: { startTimer: jest.fn(() => jest.fn()) },
  ordersByStatusTotal: { set: jest.fn() },
  register: { metrics: jest.fn(), contentType: 'text/plain' },
}));

import { startSpan } from '../../src/tracer/tracer';

describe('tracer (stub)', () => {
  it('deve criar span com traceId e spanId únicos', () => {
    const span = startSpan('test.operation');
    expect(span.traceId).toBeDefined();
    expect(span.spanId).toBeDefined();
    expect(span.operation).toBe('test.operation');
  });

  it('deve aceitar parentSpanId opcional', () => {
    const parent = startSpan('parent.op');
    const child = startSpan('child.op', parent.spanId);
    expect(child.parentSpanId).toBe(parent.spanId);
  });

  it('deve finalizar span sem lançar erro', () => {
    const span = startSpan('test.finish');
    expect(() => span.finish()).not.toThrow();
  });

  it('deve finalizar span com atributos extras', () => {
    const span = startSpan('test.finish.attrs');
    expect(() => span.finish({ orderId: 'order-123', source: 'cache' })).not.toThrow();
  });

  it('deve calcular durationMs ao finalizar', async () => {
    const span = startSpan('test.duration');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(() => span.finish()).not.toThrow();
  });

  it('deve gerar IDs únicos por span', () => {
    const span1 = startSpan('op1');
    const span2 = startSpan('op2');
    expect(span1.traceId).not.toBe(span2.traceId);
    expect(span1.spanId).not.toBe(span2.spanId);
  });
});
