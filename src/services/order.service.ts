import type { Order, OrderStatus, OrderStatusResponse, Result, AppError } from '../types';
import type { IOrderRepository } from '../repositories/order.repository';
import { logger } from '../logger/logger';
import { ordersByStatusTotal } from '../metrics/metrics';

export interface IOrderService {
  getOrderStatus(orderId: string): Promise<Result<OrderStatusResponse, AppError>>;
  updateOrderStatus(orderId: string, status: OrderStatus, failureReason?: string): Promise<void>;
}

export class OrderService implements IOrderService {
  constructor(private readonly repo: IOrderRepository) {}

  async getOrderStatus(orderId: string): Promise<Result<OrderStatusResponse, AppError>> {
    const order = await this.repo.findById(orderId);
    if (!order) {
      logger.warn('Order not found', { orderId });
      return {
        success: false,
        error: { code: 'ORDER_NOT_FOUND', message: `Order ${orderId} not found`, statusCode: 404 },
      };
    }

    logger.info('Order status retrieved', { orderId, status: order.status });

    return {
      success: true,
      data: {
        orderId: order.id,
        status: order.status,
        createdAt: order.createdAt.toISOString(),
        updatedAt: order.updatedAt.toISOString(),
        failureReason: order.failureReason,
      },
    };
  }

  async updateOrderStatus(orderId: string, status: OrderStatus, failureReason?: string): Promise<void> {
    const order = await this.repo.findById(orderId);
    const previousStatus = order?.status;

    await this.repo.updateStatus(orderId, status, failureReason);

    if (previousStatus) {
      const prevCount = await this.repo.countByStatus(previousStatus);
      ordersByStatusTotal.set({ status: previousStatus }, prevCount);
    }

    const newCount = await this.repo.countByStatus(status);
    ordersByStatusTotal.set({ status }, newCount);

    logger.info('Order status updated', {
      orderId,
      previousStatus,
      newStatus: status,
      failureReason,
    });
  }

  toResponse(order: Order): OrderStatusResponse {
    return {
      orderId: order.id,
      status: order.status,
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
      failureReason: order.failureReason,
    };
  }
}
