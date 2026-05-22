import { randomUUID } from 'crypto';

import type { IOrderRepository } from '../repositories/order.repository';
import type { IProductRepository } from '../repositories/product.repository';
import { logger } from '../logger/logger';
import { ordersByStatusTotal } from '../metrics/metrics';
import { requestContext } from '../context/requestContext';

const FAILURE_RATE = 0.1;
const MAX_RETRIES = 3;
const PROCESSING_DELAY_MS = 500;

export class OrderWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly orderRepo: IOrderRepository,
    private readonly productRepo: IProductRepository,
    private readonly failureRate: number = FAILURE_RATE,
    private readonly processingDelayMs: number = PROCESSING_DELAY_MS,
  ) {}

  start(intervalMs = 2000): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      void this.processPendingOrders();
    }, intervalMs);
    logger.info('Order worker started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    logger.info('Order worker stopped');
  }

  async processPendingOrders(): Promise<void> {
    const pendingOrders = await this.orderRepo.findPending();
    if (pendingOrders.length === 0) return;

    logger.info(`Processing ${pendingOrders.length} pending order(s)`);

    for (const order of pendingOrders) {
      await requestContext.run(
        { correlationId: randomUUID(), requestId: randomUUID(), orderId: order.id },
        async () => {
          await this.processOrder(order.id);
        },
      );
    }
  }

  async processOrder(orderId: string): Promise<void> {
    const order = await this.orderRepo.findById(orderId);
    if (!order || order.status !== 'pending') return;

    logger.info('Processing order', { orderId });

    await this.orderRepo.updateStatus(orderId, 'processing');
    const processingCount = await this.orderRepo.countByStatus('processing');
    ordersByStatusTotal.set({ status: 'processing' }, processingCount);

    await this.simulateDelay();

    const shouldFail = Math.random() < this.failureRate;

    if (shouldFail && order.retryCount < MAX_RETRIES) {
      const updatedOrder = await this.orderRepo.findById(orderId);
      if (updatedOrder) {
        updatedOrder.retryCount += 1;
        updatedOrder.status = 'pending';
        updatedOrder.updatedAt = new Date();
        await this.orderRepo.save(updatedOrder);
        const pendingCount = await this.orderRepo.countByStatus('pending');
        ordersByStatusTotal.set({ status: 'pending' }, pendingCount);
        logger.warn('Order processing failed, will retry', {
          orderId,
          retryCount: updatedOrder.retryCount,
        });
      }
      return;
    }

    if (shouldFail) {
      await this.orderRepo.updateStatus(
        orderId,
        'failed',
        'ERP processing failed after max retries',
      );
      await this.restoreStock(orderId);
      const failedCount = await this.orderRepo.countByStatus('failed');
      ordersByStatusTotal.set({ status: 'failed' }, failedCount);
      logger.error('Order permanently failed', undefined, { orderId });
      return;
    }

    await this.orderRepo.updateStatus(orderId, 'completed');
    const completedCount = await this.orderRepo.countByStatus('completed');
    ordersByStatusTotal.set({ status: 'completed' }, completedCount);
    logger.info('Order completed', { orderId });
  }

  private async restoreStock(orderId: string): Promise<void> {
    const order = await this.orderRepo.findById(orderId);
    if (!order) return;
    for (const item of order.items) {
      await (
        this.productRepo as { incrementStock?: (id: string, qty: number) => Promise<void> }
      ).incrementStock?.(item.productId, item.quantity);
    }
  }

  private simulateDelay(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.processingDelayMs));
  }
}
