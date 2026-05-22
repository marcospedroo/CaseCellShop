import type { Product, Result, AppError } from '../types';
import type { IProductRepository } from '../repositories/product.repository';
import type { IProductCache} from '../cache/productCache';
import { CACHE_KEY } from '../cache/productCache';
import { logger } from '../logger/logger';
import { startSpan } from '../tracer/tracer';

export interface IProductService {
  listProducts(): Promise<Result<Product[], AppError>>;
  getProduct(id: string): Promise<Result<Product, AppError>>;
}

export class ProductService implements IProductService {
  constructor(
    private readonly repo: IProductRepository,
    private readonly cache: IProductCache,
  ) {}

  async listProducts(): Promise<Result<Product[], AppError>> {
    const span = startSpan('product.listProducts');
    const start = Date.now();

    try {
      const cached = this.cache.get(CACHE_KEY);
      if (cached) {
        logger.info('Products served from cache', { durationMs: Date.now() - start });
        span.finish({ source: 'cache' });
        return { success: true, data: cached };
      }

      const products = await this.repo.findAll();
      this.cache.set(CACHE_KEY, products);

      logger.info('Products fetched from repository', { durationMs: Date.now() - start });
      span.finish({ source: 'repository', count: products.length });

      return { success: true, data: products };
    } catch (err) {
      logger.error('Failed to list products', err);

      const fallback = this.cache.get(CACHE_KEY);
      if (fallback) {
        logger.warn('Serving stale cache as fallback after repository error');
        return { success: true, data: fallback };
      }

      span.finish({ error: true });
      return {
        success: false,
        error: { code: 'PRODUCT_LIST_ERROR', message: 'Failed to retrieve products', statusCode: 500 },
      };
    }
  }

  async getProduct(id: string): Promise<Result<Product, AppError>> {
    const product = await this.repo.findById(id);
    if (!product) {
      return {
        success: false,
        error: { code: 'PRODUCT_NOT_FOUND', message: `Product ${id} not found`, statusCode: 404 },
      };
    }
    return { success: true, data: product };
  }
}
