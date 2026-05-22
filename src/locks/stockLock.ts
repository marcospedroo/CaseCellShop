/**
 * In-memory stock lock using a promise-based mutex per product.
 * Prevents race conditions when two simultaneous checkouts target the same product.
 * In production, replace with a distributed lock (Redis Redlock, etc.).
 */

type ReleaseFn = () => void;

export class StockLock {
  private readonly locks: Map<string, Promise<void>> = new Map();

  async acquire(productId: string): Promise<ReleaseFn> {
    const current = this.locks.get(productId) ?? Promise.resolve();

    let release!: ReleaseFn;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.locks.set(productId, current.then(() => next));

    await current;

    return () => {
      release();
      if (this.locks.get(productId) === next) {
        this.locks.delete(productId);
      }
    };
  }

  isLocked(productId: string): boolean {
    return this.locks.has(productId);
  }
}

export const stockLock = new StockLock();
