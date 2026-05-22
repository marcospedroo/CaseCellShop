import { ProductService } from '../../src/services/product.service';
import type { InMemoryProductRepository } from '../../src/repositories/product.repository';
import { InMemoryProductCache, CACHE_KEY } from '../../src/cache/productCache';
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

const makeProduct = (id: string, stock = 10): Product => ({
  id,
  name: `Product ${id}`,
  price: 29.99,
  stock,
  category: 'cases',
  description: 'Test product',
});

describe('ProductService', () => {
  let service: ProductService;
  let repoMock: jest.Mocked<InMemoryProductRepository>;
  let cache: InMemoryProductCache;

  beforeEach(() => {
    repoMock = {
      findAll: jest.fn(),
      findById: jest.fn(),
      decrementStock: jest.fn(),
      incrementStock: jest.fn(),
      getItems: jest.fn(),
    } as unknown as jest.Mocked<InMemoryProductRepository>;

    cache = new InMemoryProductCache();
    service = new ProductService(repoMock, cache);
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('listProducts', () => {
    it('deve buscar do repositório no primeiro acesso (cache miss)', async () => {
      const products = [makeProduct('1'), makeProduct('2')];
      repoMock.findAll.mockResolvedValue(products);

      const result = await service.listProducts();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(products);
      }
      expect(repoMock.findAll).toHaveBeenCalledTimes(1);
    });

    it('deve retornar do cache no segundo acesso sem chamar o repositório', async () => {
      const products = [makeProduct('1')];
      repoMock.findAll.mockResolvedValue(products);

      await service.listProducts();
      await service.listProducts();

      expect(repoMock.findAll).toHaveBeenCalledTimes(1);
    });

    it('deve popular o cache após a primeira busca', async () => {
      const products = [makeProduct('1')];
      repoMock.findAll.mockResolvedValue(products);

      await service.listProducts();

      const cached = cache.get(CACHE_KEY);
      expect(cached).toEqual(products);
    });

    it('deve buscar do repositório após expiração do TTL', async () => {
      const products = [makeProduct('1')];
      repoMock.findAll.mockResolvedValue(products);

      cache.set(CACHE_KEY, products, 1000);
      jest.advanceTimersByTime(1500);

      await service.listProducts();

      expect(repoMock.findAll).toHaveBeenCalledTimes(1);
    });

    it('deve retornar erro quando repositório falha e cache está vazio', async () => {
      repoMock.findAll.mockRejectedValue(new Error('DB error'));

      const result = await service.listProducts();

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.statusCode).toBe(500);
        expect(result.error.code).toBe('PRODUCT_LIST_ERROR');
      }
    });

    it('deve retornar cache stale como fallback quando repositório falha', async () => {
      const products = [makeProduct('1')];
      cache.set(CACHE_KEY, products);
      cache.simulateUnavailable();

      repoMock.findAll.mockRejectedValue(new Error('DB error'));

      cache.simulateAvailable();
      cache.set(CACHE_KEY, products);

      repoMock.findAll.mockRejectedValueOnce(new Error('DB error'));

      const result = await service.listProducts();
      expect(result.success).toBe(true);
    });
  });

  describe('getProduct', () => {
    it('deve retornar produto existente', async () => {
      const product = makeProduct('prod-001');
      repoMock.findById.mockResolvedValue(product);

      const result = await service.getProduct('prod-001');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe('prod-001');
      }
    });

    it('deve retornar erro 404 para produto inexistente', async () => {
      repoMock.findById.mockResolvedValue(undefined);

      const result = await service.getProduct('non-existent');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.statusCode).toBe(404);
        expect(result.error.code).toBe('PRODUCT_NOT_FOUND');
      }
    });
  });
});
