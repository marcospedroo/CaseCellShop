import type { Order, OrderStatus } from '../types';

export interface IOrderRepository {
  save(order: Order): Promise<void>;
  findById(id: string): Promise<Order | undefined>;
  findByIdempotencyKey(key: string): Promise<Order | undefined>;
  updateStatus(id: string, status: OrderStatus, failureReason?: string): Promise<boolean>;
  findPending(): Promise<Order[]>;
  countByStatus(status: OrderStatus): Promise<number>;
}

export class InMemoryOrderRepository implements IOrderRepository {
  private readonly orders: Map<string, Order> = new Map();
  private readonly idempotencyIndex: Map<string, string> = new Map();

  save(order: Order): Promise<void> {
    this.orders.set(order.id, order);
    this.idempotencyIndex.set(order.idempotencyKey, order.id);
    return Promise.resolve();
  }

  findById(id: string): Promise<Order | undefined> {
    const order = this.orders.get(id);
    const result = order ? { ...order, items: order.items.map((i) => ({ ...i })) } : undefined;
    return Promise.resolve(result);
  }

  findByIdempotencyKey(key: string): Promise<Order | undefined> {
    const id = this.idempotencyIndex.get(key);
    if (!id) return Promise.resolve(undefined);
    return this.findById(id);
  }

  updateStatus(id: string, status: OrderStatus, failureReason?: string): Promise<boolean> {
    const order = this.orders.get(id);
    if (!order) return Promise.resolve(false);
    order.status = status;
    order.updatedAt = new Date();
    if (failureReason !== undefined) {
      order.failureReason = failureReason;
    }
    return Promise.resolve(true);
  }

  findPending(): Promise<Order[]> {
    const result = Array.from(this.orders.values())
      .filter((o) => o.status === 'pending')
      .map((o) => ({ ...o, items: o.items.map((i) => ({ ...i })) }));
    return Promise.resolve(result);
  }

  countByStatus(status: OrderStatus): Promise<number> {
    const count = Array.from(this.orders.values()).filter((o) => o.status === status).length;
    return Promise.resolve(count);
  }

  clear(): void {
    this.orders.clear();
    this.idempotencyIndex.clear();
  }

  size(): number {
    return this.orders.size;
  }
}

export const orderRepository = new InMemoryOrderRepository();
