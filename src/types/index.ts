export interface Product {
  readonly id: string;
  readonly name: string;
  readonly price: number;
  stock: number;
  readonly category: string;
  readonly description: string;
}

export type OrderStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface OrderItem {
  readonly productId: string;
  readonly quantity: number;
  readonly unitPrice: number;
}

export interface Order {
  readonly id: string;
  readonly customerId: string;
  readonly items: OrderItem[];
  status: OrderStatus;
  readonly idempotencyKey: string;
  readonly createdAt: Date;
  updatedAt: Date;
  failureReason?: string;
  retryCount: number;
}

export interface CheckoutRequest {
  customerId: string;
  items: Array<{ productId: string; quantity: number }>;
  idempotencyKey?: string;
}

export interface CheckoutResponse {
  orderId: string;
  status: OrderStatus;
}

export interface OrderStatusResponse {
  orderId: string;
  status: OrderStatus;
  createdAt: string;
  updatedAt: string;
  failureReason?: string;
}

export interface LogContext {
  correlationId: string;
  requestId: string;
  orderId?: string;
  userId?: string;
  service: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  timestamp: string;
  durationMs?: number;
  error?: {
    message: string;
    stack?: string;
    code?: string;
  };
}

export type Result<T, E = Error> =
  | { success: true; data: T }
  | { success: false; error: E };

export interface AppError {
  code: string;
  message: string;
  statusCode: number;
}
