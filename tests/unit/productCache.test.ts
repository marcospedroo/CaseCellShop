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

const makeProduct = (id: string): Product => ({
  id,
  name: `Product ${id}`,
  price: 10,
  stock: 5,
  category: 'test',
  description: 'desc',
});

describe('InMemoryProductCache', () => {
  let cache: InMemoryProductCache;

  beforeEach(() => {
    cache = new InMemoryProductCache();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('get', () => {
    it('deve retornar null em cache miss', () => {
      const result = cache.get(CACHE_KEY);
      expect(result).toBeNull();
    });

    it('deve retornar dados em cache hit', () => {
      const products = [makeProduct('1')];
      cache.set(CACHE_KEY, products);
      const result = cache.get(CACHE_KEY);
      expect(result).toEqual(products);
    });

    it('deve retornar null após expiração do TTL', () => {
      const products = [makeProduct('1')];
      cache.set(CACHE_KEY, products, 5000);

      jest.advanceTimersByTime(6000);

      const result = cache.get(CACHE_KEY);
      expect(result).toBeNull();
    });

    it('deve retornar dados antes da expiração do TTL', () => {
      const products = [makeProduct('1')];
      cache.set(CACHE_KEY, products, 5000);

      jest.advanceTimersByTime(3000);

      const result = cache.get(CACHE_KEY);
      expect(result).toEqual(products);
    });

    it('deve retornar null quando cache indisponível', () => {
      const products = [makeProduct('1')];
      cache.set(CACHE_KEY, products);
      cache.simulateUnavailable();

      const result = cache.get(CACHE_KEY);
      expect(result).toBeNull();
    });

    it('deve ignorar set quando cache indisponível', () => {
      cache.simulateUnavailable();
      cache.set(CACHE_KEY, [makeProduct('1')]);
      cache.simulateAvailable();

      const result = cache.get(CACHE_KEY);
      expect(result).toBeNull();
    });
  });

  describe('invalidate', () => {
    it('deve remover entrada do cache', () => {
      cache.set(CACHE_KEY, [makeProduct('1')]);
      cache.invalidate(CACHE_KEY);
      expect(cache.get(CACHE_KEY)).toBeNull();
    });

    it('não deve lançar erro ao invalidar chave inexistente', () => {
      expect(() => cache.invalidate('non-existent')).not.toThrow();
    });
  });

  describe('isAvailable', () => {
    it('deve retornar true por padrão', () => {
      expect(cache.isAvailable()).toBe(true);
    });

    it('deve retornar false quando indisponível', () => {
      cache.simulateUnavailable();
      expect(cache.isAvailable()).toBe(false);
    });
  });

  describe('TTL', () => {
    it('deve expirar exatamente no limite do TTL', () => {
      const products = [makeProduct('1')];
      cache.set(CACHE_KEY, products, 1000);

      jest.advanceTimersByTime(999);
      expect(cache.get(CACHE_KEY)).toEqual(products);

      jest.advanceTimersByTime(2);
      expect(cache.get(CACHE_KEY)).toBeNull();
    });
  });
});
