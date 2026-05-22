import { randomUUID } from 'crypto';

import type { CheckoutRequest, CheckoutResponse, Order, Result, AppError } from '../types';
import type { IProductRepository } from '../repositories/product.repository';
import type { IOrderRepository } from '../repositories/order.repository';
import type { StockLock } from '../locks/stockLock';
import { logger } from '../logger/logger';
import { requestContext } from '../context/requestContext';
import { startSpan } from '../tracer/tracer';
import { checkoutProcessingDuration, ordersByStatusTotal } from '../metrics/metrics';

export interface ICheckoutService {
  checkout(request: CheckoutRequest): Promise<Result<CheckoutResponse, AppError>>;
}

function buildIdempotencyKey(request: CheckoutRequest): string {
  if (request.idempotencyKey) return request.idempotencyKey;
  const canonical = JSON.stringify({
    customerId: request.customerId,
    items: [...request.items].sort((a, b) => a.productId.localeCompare(b.productId)),
  });
  return `auto:${Buffer.from(canonical).toString('base64')}`;
}

export class CheckoutService implements ICheckoutService {
  private readonly inFlight: Map<string, Promise<Result<CheckoutResponse, AppError>>> = new Map();

  constructor(
    private readonly productRepo: IProductRepository,
    private readonly orderRepo: IOrderRepository,
    private readonly lock: StockLock,
  ) {}

  async checkout(request: CheckoutRequest): Promise<Result<CheckoutResponse, AppError>> {
    const idempotencyKey = buildIdempotencyKey(request);

    const inFlightPromise = this.inFlight.get(idempotencyKey);
    if (inFlightPromise) {
      return inFlightPromise;
    }

    const promise = this.doCheckout(request, idempotencyKey);
    this.inFlight.set(idempotencyKey, promise);
    void promise.finally(() => this.inFlight.delete(idempotencyKey));
    return promise;
  }

  private async doCheckout(
    request: CheckoutRequest,
    idempotencyKey: string,
  ): Promise<Result<CheckoutResponse, AppError>> {
    const span = startSpan('checkout.process');
    const timer = checkoutProcessingDuration.startTimer();
    const start = Date.now();

    const existing = await this.orderRepo.findByIdempotencyKey(idempotencyKey);
    if (existing) {
      logger.info('Idempotent checkout — returning existing order', {
        orderId: existing.id,
        durationMs: Date.now() - start,
      });
      timer();
      span.finish({ idempotent: true });
      return { success: true, data: { orderId: existing.id, status: existing.status } };
    }

    const productIds = request.items.map((i) => i.productId);
    const sortedIds = [...productIds].sort();

    const releaseFns: Array<() => void> = [];

    try {
      for (const productId of sortedIds) {
        const release = await this.lock.acquire(productId);
        releaseFns.push(release);
      }

      const validation = await this.validateStock(request);
      if (!validation.success) {
        logger.warn('Checkout failed: insufficient stock', {
          durationMs: Date.now() - start,
        });
        timer();
        span.finish({ error: 'insufficient_stock' });
        return { success: false, error: validation.error };
      }

      const orderItems = validation.data;

      for (const item of request.items) {
        await this.productRepo.decrementStock(item.productId, item.quantity);
      }

      const now = new Date();
      const order: Order = {
        id: randomUUID(),
        customerId: request.customerId,
        items: orderItems,
        status: 'pending',
        idempotencyKey,
        createdAt: now,
        updatedAt: now,
        retryCount: 0,
      };

      await this.orderRepo.save(order);

      requestContext.setOrderId(order.id);

      const pendingCount = await this.orderRepo.countByStatus('pending');
      ordersByStatusTotal.set({ status: 'pending' }, pendingCount);

      logger.info('Order created', { orderId: order.id, durationMs: Date.now() - start });

      timer();
      span.finish({ orderId: order.id });

      return { success: true, data: { orderId: order.id, status: 'pending' } };
    } catch (err) {
      logger.error('Checkout processing error', err, { durationMs: Date.now() - start });
      timer();
      span.finish({ error: true });
      return {
        success: false,
        error: { code: 'CHECKOUT_ERROR', message: 'Checkout processing failed', statusCode: 500 },
      };
    } finally {
      for (const release of releaseFns) {
        release();
      }
    }
  }

  private async validateStock(request: CheckoutRequest): Promise<Result<Order['items'], AppError>> {
    const orderItems: Order['items'] = [];

    for (const item of request.items) {
      const product = await this.productRepo.findById(item.productId);
      if (!product) {
        return {
          success: false,
          error: {
            code: 'PRODUCT_NOT_FOUND',
            message: `Product ${item.productId} not found`,
            statusCode: 404,
          },
        };
      }

      if (product.stock < item.quantity) {
        return {
          success: false,
          error: {
            code: 'INSUFFICIENT_STOCK',
            message: `Insufficient stock for product ${item.productId}. Available: ${product.stock}, Requested: ${item.quantity}`,
            statusCode: 409,
          },
        };
      }

      orderItems.push({
        productId: item.productId,
        quantity: item.quantity,
        unitPrice: product.price,
      });
    }

    return { success: true, data: orderItems };
  }
}
