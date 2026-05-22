import type { Product } from '../types';
import { logger } from '../logger/logger';
import { cacheOperationsTotal } from '../metrics/metrics';

const CACHE_KEY = 'products:all';
const DEFAULT_TTL_MS = 60_000;

export interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

export interface IProductCache {
  get(key: string): Product[] | null;
  set(key: string, value: Product[], ttlMs?: number): void;
  invalidate(key: string): void;
  isAvailable(): boolean;
}

export class InMemoryProductCache implements IProductCache {
  private readonly store: Map<string, CacheEntry<Product[]>> = new Map();
  private available = true;

  get(key: string): Product[] | null {
    if (!this.available) {
      logger.warn('Cache unavailable, skipping get');
      return null;
    }

    const entry = this.store.get(key);
    if (!entry) {
      cacheOperationsTotal.inc({ operation: 'miss' });
      logger.warn('Cache miss', { cache_key: key });
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      cacheOperationsTotal.inc({ operation: 'miss' });
      logger.warn('Cache miss (expired)', { cache_key: key });
      return null;
    }

    cacheOperationsTotal.inc({ operation: 'hit' });
    logger.info('Cache hit', { cache_key: key });
    return entry.data;
  }

  set(key: string, value: Product[], ttlMs: number = DEFAULT_TTL_MS): void {
    if (!this.available) {
      logger.warn('Cache unavailable, skipping set');
      return;
    }

    this.store.set(key, { data: value, expiresAt: Date.now() + ttlMs });
    cacheOperationsTotal.inc({ operation: 'set' });
    logger.debug('Cache set', { cache_key: key, ttlMs });
  }

  invalidate(key: string): void {
    this.store.delete(key);
    cacheOperationsTotal.inc({ operation: 'invalidate' });
    logger.info('Cache invalidated', { cache_key: key });
  }

  isAvailable(): boolean {
    return this.available;
  }

  simulateUnavailable(): void {
    this.available = false;
  }

  simulateAvailable(): void {
    this.available = true;
  }

  clear(): void {
    this.store.clear();
  }

  getEntry(key: string): CacheEntry<Product[]> | undefined {
    return this.store.get(key);
  }
}

export const productCache = new InMemoryProductCache();
export { CACHE_KEY, DEFAULT_TTL_MS };
