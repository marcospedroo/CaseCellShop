import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app';
import { orderRepository } from '../../src/repositories/order.repository';

jest.mock('../../src/logger/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));
jest.mock('../../src/tracer/tracer', () => ({
  startSpan: jest.fn(() => ({ finish: jest.fn(), traceId: 'tid', spanId: 'sid' })),
}));

describe('POST /checkout', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    orderRepository.clear();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    orderRepository.clear();
    jest.clearAllMocks();
  });

  it('deve retornar 202 com orderId para checkout válido', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/checkout',
      payload: {
        customerId: 'customer-1',
        items: [{ productId: 'prod-001', quantity: 1 }],
      },
    });

    expect(response.statusCode).toBe(202);
    const body = JSON.parse(response.body) as { orderId: string; status: string };
    expect(body.orderId).toBeDefined();
    expect(body.status).toBe('pending');
  });

  it('deve retornar 409 quando estoque insuficiente', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/checkout',
      payload: {
        customerId: 'customer-1',
        items: [{ productId: 'prod-002', quantity: 100 }],
      },
    });

    expect(response.statusCode).toBe(409);
    const body = JSON.parse(response.body) as { code: string };
    expect(body.code).toBe('INSUFFICIENT_STOCK');
  });

  it('deve retornar 404 para produto inexistente', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/checkout',
      payload: {
        customerId: 'customer-1',
        items: [{ productId: 'non-existent-product', quantity: 1 }],
      },
    });

    expect(response.statusCode).toBe(404);
  });

  it('deve retornar 400 para body inválido (sem customerId)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/checkout',
      payload: { items: [{ productId: 'prod-001', quantity: 1 }] },
    });

    expect(response.statusCode).toBe(400);
  });

  it('deve respeitar Idempotency-Key no header', async () => {
    const payload = {
      customerId: 'customer-1',
      items: [{ productId: 'prod-001', quantity: 1 }],
    };

    const first = await app.inject({
      method: 'POST',
      url: '/checkout',
      headers: { 'idempotency-key': 'test-key-header-123' },
      payload,
    });

    const second = await app.inject({
      method: 'POST',
      url: '/checkout',
      headers: { 'idempotency-key': 'test-key-header-123' },
      payload,
    });

    const body1 = JSON.parse(first.body) as { orderId: string };
    const body2 = JSON.parse(second.body) as { orderId: string };

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(body1.orderId).toBe(body2.orderId);
  });
});

describe('GET /orders/:orderId/status', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    orderRepository.clear();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    orderRepository.clear();
    jest.clearAllMocks();
  });

  it('deve retornar status do pedido existente', async () => {
    const checkout = await app.inject({
      method: 'POST',
      url: '/checkout',
      payload: { customerId: 'customer-1', items: [{ productId: 'prod-001', quantity: 1 }] },
    });

    const { orderId } = JSON.parse(checkout.body) as { orderId: string };

    const status = await app.inject({ method: 'GET', url: `/orders/${orderId}/status` });

    expect(status.statusCode).toBe(200);
    const body = JSON.parse(status.body) as { orderId: string; status: string };
    expect(body.orderId).toBe(orderId);
    expect(body.status).toBe('pending');
  });

  it('deve retornar 404 para pedido inexistente', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/orders/non-existent-order/status',
    });

    expect(response.statusCode).toBe(404);
  });
});
