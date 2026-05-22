import { OrderWorker } from '../../src/worker/orderWorker';
import { InMemoryOrderRepository } from '../../src/repositories/order.repository';
import { InMemoryProductRepository } from '../../src/repositories/product.repository';
import type { Order, Product } from '../../src/types';

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
jest.mock('../../src/context/requestContext', () => ({
  requestContext: {
    run: jest.fn((_ctx: unknown, fn: () => Promise<void>) => fn()),
    get: jest.fn(),
    getOrDefault: jest.fn(),
    setOrderId: jest.fn(),
  },
}));

const makeOrder = (id: string): Order => ({
  id,
  customerId: 'customer-1',
  items: [{ productId: 'prod-001', quantity: 1, unitPrice: 29.99 }],
  status: 'pending',
  idempotencyKey: `key-${id}`,
  createdAt: new Date(),
  updatedAt: new Date(),
  retryCount: 0,
});

const makeProduct = (id: string): Product => ({
  id,
  name: 'Product',
  price: 29.99,
  stock: 10,
  category: 'cases',
  description: 'desc',
});

describe('OrderWorker', () => {
  let orderRepo: InMemoryOrderRepository;
  let productRepo: InMemoryProductRepository;

  beforeEach(() => {
    orderRepo = new InMemoryOrderRepository();
    productRepo = new InMemoryProductRepository([makeProduct('prod-001')]);
  });

  describe('processOrder — fluxo feliz', () => {
    it('deve marcar pedido como completed quando sem falha', async () => {
      const worker = new OrderWorker(orderRepo, productRepo, 0, 0);
      const order = makeOrder('order-success');
      await orderRepo.save(order);

      await worker.processOrder('order-success');

      const updated = await orderRepo.findById('order-success');
      expect(updated?.status).toBe('completed');
    });

    it('deve transicionar de pending para processing e depois completed', async () => {
      const worker = new OrderWorker(orderRepo, productRepo, 0, 0);
      const order = makeOrder('order-transition');
      await orderRepo.save(order);

      await worker.processOrder('order-transition');

      const updated = await orderRepo.findById('order-transition');
      expect(updated?.status).toBe('completed');
    });
  });

  describe('processOrder — falhas e retry', () => {
    it('deve re-enfileirar pedido como pending quando falha e retryCount < MAX_RETRIES', async () => {
      const worker = new OrderWorker(orderRepo, productRepo, 1, 0);
      const order = makeOrder('order-retry');
      await orderRepo.save(order);

      await worker.processOrder('order-retry');

      const updated = await orderRepo.findById('order-retry');
      expect(updated?.status).toBe('pending');
      expect(updated?.retryCount).toBe(1);
    });

    it('deve marcar como failed quando retryCount >= MAX_RETRIES', async () => {
      const worker = new OrderWorker(orderRepo, productRepo, 1, 0);
      const order = makeOrder('order-maxretry');
      order.retryCount = 3;
      await orderRepo.save(order);

      await worker.processOrder('order-maxretry');

      const updated = await orderRepo.findById('order-maxretry');
      expect(updated?.status).toBe('failed');
      expect(updated?.failureReason).toBeDefined();
    });
  });

  describe('processOrder — casos de borda', () => {
    it('não deve processar pedido inexistente', async () => {
      const worker = new OrderWorker(orderRepo, productRepo, 0, 0);
      await expect(worker.processOrder('non-existent')).resolves.not.toThrow();
    });

    it('não deve processar pedido já concluído', async () => {
      const worker = new OrderWorker(orderRepo, productRepo, 0, 0);
      const order = makeOrder('order-done');
      order.status = 'completed';
      await orderRepo.save(order);

      await worker.processOrder('order-done');

      const updated = await orderRepo.findById('order-done');
      expect(updated?.status).toBe('completed');
    });
  });

  describe('processPendingOrders', () => {
    it('deve processar todos os pedidos pendentes', async () => {
      const worker = new OrderWorker(orderRepo, productRepo, 0, 0);
      await orderRepo.save(makeOrder('order-batch-1'));
      await orderRepo.save(makeOrder('order-batch-2'));

      await worker.processPendingOrders();

      const o1 = await orderRepo.findById('order-batch-1');
      const o2 = await orderRepo.findById('order-batch-2');

      expect(o1?.status).toBe('completed');
      expect(o2?.status).toBe('completed');
    });

    it('não deve lançar erro se não há pedidos pendentes', async () => {
      const worker = new OrderWorker(orderRepo, productRepo, 0, 0);
      await expect(worker.processPendingOrders()).resolves.not.toThrow();
    });
  });

  describe('start/stop', () => {
    it('deve iniciar e parar sem erros', () => {
      const worker = new OrderWorker(orderRepo, productRepo, 0, 0);
      worker.start(10000);
      worker.stop();
    });

    it('não deve iniciar duas vezes', () => {
      const worker = new OrderWorker(orderRepo, productRepo, 0, 0);
      worker.start(10000);
      worker.start(10000);
      worker.stop();
    });
  });
});
