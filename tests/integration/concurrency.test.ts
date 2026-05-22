import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app';
import { orderRepository } from '../../src/repositories/order.repository';
import { productRepository } from '../../src/repositories/product.repository';
import type { InMemoryProductRepository } from '../../src/repositories/product.repository';

jest.mock('../../src/logger/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));
jest.mock('../../src/tracer/tracer', () => ({
  startSpan: jest.fn(() => ({ finish: jest.fn(), traceId: 'tid', spanId: 'sid' })),
}));

describe('Concurrency Tests', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    orderRepository.clear();
    const items = (productRepository as InMemoryProductRepository).getItems();
    const prod5 = items.find((p) => p.id === 'prod-005');
    if (prod5) prod5.stock = 1;
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    orderRepository.clear();
    const items = (productRepository as InMemoryProductRepository).getItems();
    const prod5 = items.find((p) => p.id === 'prod-005');
    if (prod5) prod5.stock = 1;
    jest.clearAllMocks();
  });

  describe('Controle de estoque concorrente', () => {
    it('deve permitir apenas um checkout quando dois pedidos simultâneos e estoque=1', async () => {
      const requests = [
        app.inject({
          method: 'POST',
          url: '/checkout',
          headers: { 'idempotency-key': 'concurrent-key-a' },
          payload: {
            customerId: 'customer-a',
            items: [{ productId: 'prod-005', quantity: 1 }],
          },
        }),
        app.inject({
          method: 'POST',
          url: '/checkout',
          headers: { 'idempotency-key': 'concurrent-key-b' },
          payload: {
            customerId: 'customer-b',
            items: [{ productId: 'prod-005', quantity: 1 }],
          },
        }),
      ];

      const responses = await Promise.all(requests);
      const statusCodes = responses.map((r) => r.statusCode);

      const successCount = statusCodes.filter((s) => s === 202).length;
      const failureCount = statusCodes.filter((s) => s === 409).length;

      expect(successCount).toBe(1);
      expect(failureCount).toBe(1);
    });
  });

  describe('Idempotência sob chamadas paralelas', () => {
    it('deve retornar o mesmo orderId para múltiplas chamadas paralelas com a mesma Idempotency-Key', async () => {
      const idempotencyKey = 'parallel-idem-key-concurrent-test';

      const requests = Array.from({ length: 5 }, () =>
        app.inject({
          method: 'POST',
          url: '/checkout',
          headers: { 'idempotency-key': idempotencyKey },
          payload: {
            customerId: 'customer-parallel',
            items: [{ productId: 'prod-001', quantity: 1 }],
          },
        }),
      );

      const responses = await Promise.all(requests);

      const orderIds = responses
        .filter((r) => r.statusCode === 202)
        .map((r) => (JSON.parse(r.body) as { orderId: string }).orderId);

      expect(orderIds.length).toBeGreaterThan(0);

      const uniqueIds = new Set(orderIds);
      expect(uniqueIds.size).toBe(1);
    });
  });

  describe('Consultas de status simultâneas', () => {
    it('deve retornar resultado consistente para múltiplas consultas paralelas do mesmo pedido', async () => {
      const checkoutResponse = await app.inject({
        method: 'POST',
        url: '/checkout',
        payload: {
          customerId: 'customer-status',
          items: [{ productId: 'prod-001', quantity: 1 }],
        },
      });

      const { orderId } = JSON.parse(checkoutResponse.body) as { orderId: string };

      const statusRequests = Array.from({ length: 10 }, () =>
        app.inject({ method: 'GET', url: `/orders/${orderId}/status` }),
      );

      const responses = await Promise.all(statusRequests);

      expect(responses.every((r) => r.statusCode === 200)).toBe(true);

      const statuses = responses.map((r) => (JSON.parse(r.body) as { status: string }).status);
      expect(new Set(statuses).size).toBe(1);
    });
  });

  describe('Health e Metrics endpoints', () => {
    it('deve responder /health com 200', async () => {
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
    });

    it('deve responder /metrics com 200', async () => {
      const response = await app.inject({ method: 'GET', url: '/metrics' });
      expect(response.statusCode).toBe(200);
    });
  });
});
