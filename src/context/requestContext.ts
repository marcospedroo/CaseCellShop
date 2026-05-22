import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

export interface RequestContextData {
  correlationId: string;
  requestId: string;
  orderId?: string;
  userId?: string;
}

const storage = new AsyncLocalStorage<RequestContextData>();

export const requestContext = {
  run<T>(data: RequestContextData, fn: () => T): T {
    return storage.run(data, fn);
  },

  get(): RequestContextData | undefined {
    return storage.getStore();
  },

  getOrDefault(): RequestContextData {
    return (
      storage.getStore() ?? {
        correlationId: 'unknown',
        requestId: 'unknown',
      }
    );
  },

  setOrderId(orderId: string): void {
    const store = storage.getStore();
    if (store) {
      store.orderId = orderId;
    }
  },
};

export function createContextFromRequest(
  headers: Record<string, string | string[] | undefined>,
  bodyOrderId?: string,
): RequestContextData {
  const rawCorrelation = headers['x-correlation-id'];
  const correlationId =
    (Array.isArray(rawCorrelation) ? rawCorrelation[0] : rawCorrelation) ?? randomUUID();
  const requestId = randomUUID();
  return {
    correlationId,
    requestId,
    orderId: bodyOrderId,
  };
}
