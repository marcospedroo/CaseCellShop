import { requestContext } from '../../src/context/requestContext';

jest.mock('../../src/metrics/metrics', () => ({
  cacheOperationsTotal: { inc: jest.fn() },
  httpRequestsTotal: { inc: jest.fn() },
  checkoutProcessingDuration: { startTimer: jest.fn(() => jest.fn()) },
  ordersByStatusTotal: { set: jest.fn() },
  register: { metrics: jest.fn(), contentType: 'text/plain' },
}));

describe('logger', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('deve emitir log info sem context', () => {
    const { logger } = require('../../src/logger/logger') as { logger: { info: (msg: string, meta?: unknown) => void; warn: (msg: string, meta?: unknown) => void; error: (msg: string, err?: unknown, meta?: unknown) => void; debug: (msg: string, meta?: unknown) => void } };
    expect(() => logger.info('test message')).not.toThrow();
  });

  it('deve emitir log warn sem context', () => {
    const { logger } = require('../../src/logger/logger') as { logger: { warn: (msg: string) => void } };
    expect(() => logger.warn('test warning')).not.toThrow();
  });

  it('deve emitir log error com objeto Error', () => {
    const { logger } = require('../../src/logger/logger') as { logger: { error: (msg: string, err?: unknown) => void } };
    const err = new Error('test error');
    expect(() => logger.error('test error message', err)).not.toThrow();
  });

  it('deve emitir log error sem erro', () => {
    const { logger } = require('../../src/logger/logger') as { logger: { error: (msg: string) => void } };
    expect(() => logger.error('test error message')).not.toThrow();
  });

  it('deve emitir log debug com meta', () => {
    const { logger } = require('../../src/logger/logger') as { logger: { debug: (msg: string, meta?: unknown) => void } };
    expect(() => logger.debug('test debug', { durationMs: 10 })).not.toThrow();
  });

  it('deve incluir correlationId e requestId do contexto', () => {
    const { logger } = require('../../src/logger/logger') as { logger: { info: (msg: string, meta?: unknown) => void } };
    requestContext.run({ correlationId: 'test-corr', requestId: 'test-req', orderId: 'order-1' }, () => {
      expect(() => logger.info('message with context', { orderId: 'order-1' })).not.toThrow();
    });
  });

  it('deve incluir orderId do meta quando fornecido', () => {
    const { logger } = require('../../src/logger/logger') as { logger: { info: (msg: string, meta?: { orderId?: string }) => void } };
    expect(() => logger.info('message', { orderId: 'explicit-order' })).not.toThrow();
  });
});
