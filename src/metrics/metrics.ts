import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

export const register = new Registry();

collectDefaultMetrics({ register });

export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

export const cacheOperationsTotal = new Counter({
  name: 'cache_operations_total',
  help: 'Total cache operations',
  labelNames: ['operation'],
  registers: [register],
});

export const checkoutProcessingDuration = new Histogram({
  name: 'checkout_processing_duration_seconds',
  help: 'Checkout processing duration in seconds',
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register],
});

export const ordersByStatusTotal = new Gauge({
  name: 'orders_by_status_total',
  help: 'Total orders by status',
  labelNames: ['status'],
  registers: [register],
});
