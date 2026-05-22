# CaseCellShop Backend

Backend service for the CaseCellShop mobile accessories e-commerce platform.

---

## Quickstart

```bash
npm install
npm run dev        # development with hot-reload
npm test           # run tests
npm run test:coverage  # run tests + coverage report
npm run build      # compile TypeScript
```

Default: `http://localhost:3000`  
API docs: `http://localhost:3000/api-docs`  
Metrics: `http://localhost:3000/metrics`

---

## Architecture Decisions and Trade-offs

### In-memory data store
**Decision:** All repositories use `Map` / `Array` structures in memory.  
**Why:** This is a technical challenge focused on observability, concurrency control, and TypeScript quality — not on database modeling. In-memory storage lets us demonstrate atomic operations, idempotency, and stock locks without infrastructure dependencies.  
**Production trade-off:** Replace with PostgreSQL (+ Prisma) or Redis. The `IProductRepository` / `IOrderRepository` interfaces are already defined so that swapping implementations requires no changes to services.

### Mutex-based stock lock (`StockLock`)
**Decision:** Promise chaining mutex per product ID.  
**Why:** Node.js is single-threaded, so true race conditions only arise from interleaved async I/O. A per-product promise chain serializes all concurrent checkouts for the same product without blocking the event loop.  
**Production trade-off:** In a multi-instance deployment, use a distributed lock (e.g., Redis Redlock). The `StockLock` interface is injectable and can be replaced.

### Idempotency via key index
**Decision:** Every order is indexed by an `idempotencyKey` (header or auto-generated from payload hash).  
**Why:** Prevents duplicate orders on network retries. The key is stored in a secondary index (`Map<string, orderId>`) enabling O(1) lookup.  
**Production trade-off:** Store the idempotency key in the DB with a unique index and TTL (e.g., 24h). Here the window is process lifetime.

### Tracing stub
**Decision:** `tracer.ts` logs `trace_id`, `span_id`, `parent_span_id`, `operation`, and `duration_ms` via pino instead of exporting to Jaeger/OTLP.  
**Why:** Demonstrates the observability contract without requiring Jaeger/Tempo infrastructure. In production, replace with `@opentelemetry/sdk-node` + OTLP HTTP exporter. The `startSpan` API is compatible with the OTel span model.

### Worker simulation
**Decision:** `OrderWorker` uses `setInterval` to poll pending orders and simulates ERP processing with `setTimeout` + a configurable failure rate (10%).  
**Why:** Demonstrates async processing, status transitions, retry logic, and stock restore on failure without a real message broker.  
**Production trade-off:** Use BullMQ (Redis-backed) or SQS for durable, distributed job processing.

### AsyncLocalStorage for context propagation
**Decision:** `correlationId` and `requestId` are stored in `AsyncLocalStorage` and accessed anywhere in the call stack without parameter threading.  
**Why:** Keeps service/repository signatures clean while ensuring every log line carries full tracing context.

---

## Limitations (by design for this challenge)

| Limitation | Why acceptable here |
|---|---|
| No persistent storage | Focus is on concurrency and observability patterns |
| Single-instance locks | Multi-instance requires distributed lock (Redis Redlock) |
| Simulated ERP | Real integration would use HTTP/gRPC client |
| No auth/JWT | Security layer is described but not implemented; focus is on checkout flow |
| Worker runs in same process | Production: separate worker process or Lambda |
| Idempotency window = process lifetime | Production: TTL-based persistence |

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `HOST` | `0.0.0.0` | Bind address |
| `LOG_LEVEL` | `info` | Pino log level |
| `CORS_ORIGIN` | `*` | Allowed CORS origin |
| `NODE_ENV` | — | Set to `production` to suppress stack traces in logs |

---

## Observability

### Structured Logs (pino)

Every log line is JSON with:
```json
{
  "level": "info",
  "time": "2024-01-01T10:00:00.000Z",
  "service": "casecellshop-backend",
  "correlationId": "uuid",
  "requestId": "uuid",
  "orderId": "uuid (when applicable)",
  "message": "...",
  "durationMs": 12
}
```

### Metrics (Prometheus — `/metrics`)

| Metric | Type | Labels | Description |
|---|---|---|---|
| `http_requests_total` | Counter | `method`, `route`, `status_code` | All HTTP requests |
| `cache_operations_total` | Counter | `operation` (hit/miss/set/invalidate) | Cache operations |
| `checkout_processing_duration_seconds` | Histogram | — | End-to-end checkout latency |
| `orders_by_status_total` | Gauge | `status` | Current orders per status |

### Tracing stub (`/src/tracer/tracer.ts`)

Logs span events as structured JSON for observability contract demonstration. Replace with `@opentelemetry/sdk-node` in production.

---

## Datadog Dashboard / Alerts (Example)

### Dashboard Widgets

```
# Request Rate by Route
sum:http_requests_total{*} by {route}.as_rate()

# Error Rate
sum:http_requests_total{status_code:5*} / sum:http_requests_total{*}

# Cache Miss Rate
cache_operations_total{operation:miss} / (cache_operations_total{operation:hit} + cache_operations_total{operation:miss})

# Checkout P95 Latency
histogram_quantile(0.95, checkout_processing_duration_seconds_bucket)

# Orders by Status
orders_by_status_total by {status}
```

### Recommended Alerts

| Alert | Condition | Severity |
|---|---|---|
| High Error Rate | `error_rate > 5%` for 5 min | Critical |
| Cache Miss Rate High | `miss_rate > 30%` for 10 min | Warning |
| Checkout Latency P95 | `p95 > 2s` for 5 min | Warning |
| Orders Stuck in Processing | `orders_by_status{status:processing} > 100` for 15 min | Critical |
| Failed Orders Spike | `orders_by_status{status:failed}` increases > 10/min | Warning |

---

## Runbook

### Checkout is failing frequently

1. Check logs: `level:error service:casecellshop-backend` — look for `CHECKOUT_ERROR` code
2. Check stock levels: query `GET /products` and inspect `stock` field
3. If `INSUFFICIENT_STOCK` errors: stock is genuinely depleted — this is expected behavior
4. If `CHECKOUT_ERROR` (500): check for lock contention or repository errors in logs
5. Monitor `checkout_processing_duration_seconds` — spikes indicate lock contention

### Cache miss rate is high

1. Check `cache_operations_total{operation:miss}` — is it rising continuously?
2. Verify TTL: default is 60s. If cache is being invalidated too aggressively, increase TTL
3. If `InMemoryProductCache.isAvailable()` returns false: the cache module has a bug — restart service
4. Check memory: if Node.js heap is under pressure, GC may be clearing cache entries
5. Fallback is in place: `ProductService.listProducts()` will serve from repository on miss

### Orders stuck in `processing` status

1. Check `orders_by_status_total{status:processing}` gauge — is it growing?
2. Worker may have crashed: check logs for `Order worker stopped` without `Order worker started`
3. Restart the service — worker restarts automatically on `server.ts` bootstrap
4. Check `processPendingOrders` logs — if worker is running but not processing, look for errors

### High latency on `/checkout`

1. Check `checkout_processing_duration_seconds` P95 histogram
2. High lock wait time: many concurrent checkouts for the same product — expected under load
3. If sustained: consider batching or queueing checkout requests with BullMQ

---

## AI Prompts Used

The following prompts were used to assist with code generation and design:

1. **Architecture prompt**: "Design a Node.js/TypeScript e-commerce checkout backend with in-memory storage, structured pino logging with correlationId/requestId/orderId via AsyncLocalStorage, Prometheus metrics, and a mutex-based stock lock to prevent overselling"

2. **Concurrency prompt**: "Implement a promise-chain mutex for per-product stock locking in Node.js that serializes concurrent checkouts without blocking the event loop"

3. **Idempotency prompt**: "Implement idempotency for a checkout endpoint using either a header key or auto-generated payload hash, with O(1) lookup via secondary index"

4. **Test structure prompt**: "Write Jest tests covering: cache hit/miss/TTL/fallback, concurrent checkouts with stock=1, idempotency under parallel calls, and order status consistency"

5. **OpenAPI prompt**: "Generate Fastify JSON Schema definitions for /products, /checkout, and /orders/:orderId/status with success and error response schemas"

6. **Worker retry prompt**: "Implement an order processing worker with configurable failure rate, retry count limit, and stock restore on permanent failure"

---

## Project Structure

```
./
├── src/
│   ├── server.ts              # Fastify bootstrap + worker start
│   ├── app.ts                 # Plugin registration + middleware
│   ├── context/requestContext.ts  # AsyncLocalStorage context
│   ├── logger/logger.ts           # pino with auto-context injection
│   ├── tracer/tracer.ts           # Tracing stub (OTel-compatible interface)
│   ├── metrics/metrics.ts         # prom-client counters/histograms/gauges
│   ├── routes/                    # Fastify route handlers
│   ├── services/                  # Business logic layer
│   ├── repositories/              # In-memory data access
│   ├── cache/productCache.ts      # TTL cache with hit/miss logging
│   ├── worker/orderWorker.ts      # Async order processing simulation
│   ├── locks/stockLock.ts         # Per-product mutex
│   └── types/index.ts             # Shared TypeScript interfaces
├── tests/
│   ├── unit/                      # Isolated service/cache/lock tests
│   └── integration/               # Full HTTP flow tests via Fastify inject
├── docs/                          # OpenAPI spec
├── package.json
├── tsconfig.json
├── jest.config.ts
└── README.md
```
