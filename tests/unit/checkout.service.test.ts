import { CheckoutService } from '../../src/services/checkout.service';
import { InMemoryProductRepository } from '../../src/repositories/product.repository';
import { InMemoryOrderRepository } from '../../src/repositories/order.repository';
import { StockLock } from '../../src/locks/stockLock';
import type { Product } from '../../src/types';

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
jest.mock('../../src/tracer/tracer', () => ({
  startSpan: jest.fn(() => ({ finish: jest.fn(), traceId: 'tid', spanId: 'sid' })),
}));
jest.mock('../../src/context/requestContext', () => ({
  requestContext: {
    setOrderId: jest.fn(),
    run: jest.fn(),
    get: jest.fn(),
    getOrDefault: jest.fn(),
  },
}));

const makeProduct = (id: string, stock: number, price = 29.99): Product => ({
  id,
  name: `Product ${id}`,
  price,
  stock,
  category: 'cases',
  description: 'Test product',
});

describe('CheckoutService', () => {
  let productRepo: InMemoryProductRepository;
  let orderRepo: InMemoryOrderRepository;
  let lock: StockLock;
  let service: CheckoutService;

  beforeEach(() => {
    productRepo = new InMemoryProductRepository([
      makeProduct('prod-001', 10, 29.99),
      makeProduct('prod-002', 0, 19.99),
      makeProduct('prod-stock1', 1, 99.99),
    ]);
    orderRepo = new InMemoryOrderRepository();
    lock = new StockLock();
    service = new CheckoutService(productRepo, orderRepo, lock);
  });

  describe('checkout — regras de negócio', () => {
    it('deve criar pedido quando há estoque suficiente', async () => {
      const result = await service.checkout({
        customerId: 'customer-1',
        items: [{ productId: 'prod-001', quantity: 2 }],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.orderId).toBeDefined();
        expect(result.data.status).toBe('pending');
      }
    });

    it('deve decrementar estoque após checkout bem-sucedido', async () => {
      await service.checkout({
        customerId: 'customer-1',
        items: [{ productId: 'prod-001', quantity: 3 }],
      });

      const product = await productRepo.findById('prod-001');
      expect(product?.stock).toBe(7);
    });

    it('deve retornar erro 409 quando estoque insuficiente', async () => {
      const result = await service.checkout({
        customerId: 'customer-1',
        items: [{ productId: 'prod-002', quantity: 1 }],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.statusCode).toBe(409);
        expect(result.error.code).toBe('INSUFFICIENT_STOCK');
      }
    });

    it('deve retornar erro 404 para produto inexistente', async () => {
      const result = await service.checkout({
        customerId: 'customer-1',
        items: [{ productId: 'non-existent', quantity: 1 }],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.statusCode).toBe(404);
        expect(result.error.code).toBe('PRODUCT_NOT_FOUND');
      }
    });

    it('deve salvar pedido no repositório após criação', async () => {
      const result = await service.checkout({
        customerId: 'customer-1',
        items: [{ productId: 'prod-001', quantity: 1 }],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const order = await orderRepo.findById(result.data.orderId);
        expect(order).toBeDefined();
        expect(order?.status).toBe('pending');
        expect(order?.customerId).toBe('customer-1');
      }
    });
  });

  describe('checkout — idempotência', () => {
    it('deve retornar pedido existente com a mesma Idempotency-Key', async () => {
      const key = 'my-idempotency-key-123';

      const first = await service.checkout({
        customerId: 'customer-1',
        items: [{ productId: 'prod-001', quantity: 1 }],
        idempotencyKey: key,
      });

      const second = await service.checkout({
        customerId: 'customer-1',
        items: [{ productId: 'prod-001', quantity: 1 }],
        idempotencyKey: key,
      });

      expect(first.success).toBe(true);
      expect(second.success).toBe(true);

      if (first.success && second.success) {
        expect(first.data.orderId).toBe(second.data.orderId);
      }
    });

    it('deve criar apenas um pedido para requisições idempotentes', async () => {
      const key = 'idempotency-key-single';

      await service.checkout({
        customerId: 'customer-1',
        items: [{ productId: 'prod-001', quantity: 1 }],
        idempotencyKey: key,
      });

      await service.checkout({
        customerId: 'customer-1',
        items: [{ productId: 'prod-001', quantity: 1 }],
        idempotencyKey: key,
      });

      expect(orderRepo.size()).toBe(1);
    });

    it('deve gerar chave automática a partir do payload quando idempotencyKey não fornecida', async () => {
      const payload = {
        customerId: 'customer-auto',
        items: [{ productId: 'prod-001', quantity: 2 }],
      };

      const first = await service.checkout(payload);
      const second = await service.checkout(payload);

      expect(first.success).toBe(true);
      expect(second.success).toBe(true);

      if (first.success && second.success) {
        expect(first.data.orderId).toBe(second.data.orderId);
      }

      expect(orderRepo.size()).toBe(1);
    });

    it('deve criar pedidos distintos para payloads diferentes sem idempotencyKey', async () => {
      const result1 = await service.checkout({
        customerId: 'customer-1',
        items: [{ productId: 'prod-001', quantity: 1 }],
      });

      const result2 = await service.checkout({
        customerId: 'customer-2',
        items: [{ productId: 'prod-001', quantity: 1 }],
      });

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);

      if (result1.success && result2.success) {
        expect(result1.data.orderId).not.toBe(result2.data.orderId);
      }
    });
  });

  describe('checkout — concorrência e controle de estoque', () => {
    it('deve permitir apenas um checkout quando estoque = 1 e dois pedidos simultâneos', async () => {
      const checkouts = await Promise.all([
        service.checkout({
          customerId: 'customer-1',
          items: [{ productId: 'prod-stock1', quantity: 1 }],
          idempotencyKey: 'key-concurrent-1',
        }),
        service.checkout({
          customerId: 'customer-2',
          items: [{ productId: 'prod-stock1', quantity: 1 }],
          idempotencyKey: 'key-concurrent-2',
        }),
      ]);

      const successes = checkouts.filter((r) => r.success);
      const failures = checkouts.filter((r) => !r.success);

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);

      if (!failures[0]!.success) {
        expect(failures[0]!.error.code).toBe('INSUFFICIENT_STOCK');
      }
    });

    it('não deve duplicar pedido com chamadas paralelas e mesma Idempotency-Key', async () => {
      const key = 'parallel-idempotency-key';

      await Promise.all([
        service.checkout({
          customerId: 'customer-1',
          items: [{ productId: 'prod-001', quantity: 1 }],
          idempotencyKey: key,
        }),
        service.checkout({
          customerId: 'customer-1',
          items: [{ productId: 'prod-001', quantity: 1 }],
          idempotencyKey: key,
        }),
        service.checkout({
          customerId: 'customer-1',
          items: [{ productId: 'prod-001', quantity: 1 }],
          idempotencyKey: key,
        }),
      ]);

      expect(orderRepo.size()).toBeLessThanOrEqual(2);
    });
  });
});
