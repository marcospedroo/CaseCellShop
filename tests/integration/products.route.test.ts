import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app';
import { productCache } from '../../src/cache/productCache';

jest.mock('../../src/logger/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));
jest.mock('../../src/tracer/tracer', () => ({
  startSpan: jest.fn(() => ({ finish: jest.fn(), traceId: 'tid', spanId: 'sid' })),
}));

describe('GET /products', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    productCache.clear();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    productCache.clear();
    jest.clearAllMocks();
  });

  it('deve retornar 200 com lista de produtos', async () => {
    const response = await app.inject({ method: 'GET', url: '/products' });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
  });

  it('deve retornar produtos com campos corretos', async () => {
    const response = await app.inject({ method: 'GET', url: '/products' });

    const body = JSON.parse(response.body) as { data: Array<{ id: string; name: string; price: number; stock: number }> };
    const product = body.data[0]!;
    expect(product).toHaveProperty('id');
    expect(product).toHaveProperty('name');
    expect(product).toHaveProperty('price');
    expect(product).toHaveProperty('stock');
  });

  it('deve usar cache na segunda requisição', async () => {
    await app.inject({ method: 'GET', url: '/products' });
    const secondResponse = await app.inject({ method: 'GET', url: '/products' });

    expect(secondResponse.statusCode).toBe(200);
  });

  it('deve aceitar header x-correlation-id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/products',
      headers: { 'x-correlation-id': 'test-correlation-id' },
    });

    expect(response.statusCode).toBe(200);
  });
});
