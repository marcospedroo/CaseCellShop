import { OrderService } from '../../src/services/order.service';
import { InMemoryOrderRepository } from '../../src/repositories/order.repository';
import type { Order } from '../../src/types';

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

const makeOrder = (id: string): Order => ({
  id,
  customerId: 'customer-1',
  items: [{ productId: 'prod-001', quantity: 1, unitPrice: 29.99 }],
  status: 'pending',
  idempotencyKey: `key-${id}`,
  createdAt: new Date('2024-01-01T10:00:00Z'),
  updatedAt: new Date('2024-01-01T10:00:00Z'),
  retryCount: 0,
});

describe('OrderService', () => {
  let repo: InMemoryOrderRepository;
  let service: OrderService;

  beforeEach(() => {
    repo = new InMemoryOrderRepository();
    service = new OrderService(repo);
  });

  describe('getOrderStatus', () => {
    it('deve retornar status de pedido existente', async () => {
      const order = makeOrder('order-123');
      await repo.save(order);

      const result = await service.getOrderStatus('order-123');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.orderId).toBe('order-123');
        expect(result.data.status).toBe('pending');
        expect(result.data.createdAt).toBe('2024-01-01T10:00:00.000Z');
      }
    });

    it('deve retornar erro 404 para pedido inexistente', async () => {
      const result = await service.getOrderStatus('non-existent');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.statusCode).toBe(404);
        expect(result.error.code).toBe('ORDER_NOT_FOUND');
      }
    });

    it('deve retornar failureReason quando pedido falhou', async () => {
      const order = makeOrder('order-failed');
      order.status = 'failed';
      order.failureReason = 'ERP timeout';
      await repo.save(order);

      const result = await service.getOrderStatus('order-failed');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe('failed');
        expect(result.data.failureReason).toBe('ERP timeout');
      }
    });
  });

  describe('updateOrderStatus', () => {
    it('deve atualizar status do pedido', async () => {
      const order = makeOrder('order-update');
      await repo.save(order);

      await service.updateOrderStatus('order-update', 'completed');

      const updated = await repo.findById('order-update');
      expect(updated?.status).toBe('completed');
    });

    it('deve atualizar failureReason ao marcar como failed', async () => {
      const order = makeOrder('order-fail');
      await repo.save(order);

      await service.updateOrderStatus('order-fail', 'failed', 'ERP error');

      const updated = await repo.findById('order-fail');
      expect(updated?.status).toBe('failed');
      expect(updated?.failureReason).toBe('ERP error');
    });

    it('deve funcionar sem lançar erro para orderId inexistente', async () => {
      await expect(service.updateOrderStatus('ghost-order', 'completed')).resolves.not.toThrow();
    });
  });

  describe('múltiplas consultas simultâneas', () => {
    it('deve retornar resultado consistente para consultas paralelas do mesmo pedido', async () => {
      const order = makeOrder('order-parallel');
      order.status = 'processing';
      await repo.save(order);

      const results = await Promise.all([
        service.getOrderStatus('order-parallel'),
        service.getOrderStatus('order-parallel'),
        service.getOrderStatus('order-parallel'),
        service.getOrderStatus('order-parallel'),
        service.getOrderStatus('order-parallel'),
      ]);

      expect(results.every((r) => r.success)).toBe(true);
      const statuses = results
        .filter((r) => r.success)
        .map((r) => (r.success ? r.data.status : null));

      expect(new Set(statuses).size).toBe(1);
      expect(statuses[0]).toBe('processing');
    });
  });
});
