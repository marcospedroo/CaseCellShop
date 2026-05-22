import { StockLock } from '../../src/locks/stockLock';

describe('StockLock', () => {
  let lock: StockLock;

  beforeEach(() => {
    lock = new StockLock();
  });

  it('deve adquirir e liberar lock sem erros', async () => {
    const release = await lock.acquire('product-1');
    expect(typeof release).toBe('function');
    release();
  });

  it('deve serializar acesso ao mesmo recurso', async () => {
    const order: string[] = [];

    const release1 = await lock.acquire('product-1');
    order.push('acquired-1');

    const p2 = lock.acquire('product-1').then(async (release2) => {
      order.push('acquired-2');
      release2();
    });

    release1();
    order.push('released-1');

    await p2;

    expect(order).toEqual(['acquired-1', 'released-1', 'acquired-2']);
  });

  it('deve permitir locks simultâneos em produtos diferentes', async () => {
    const [r1, r2] = await Promise.all([
      lock.acquire('product-a'),
      lock.acquire('product-b'),
    ]);
    r1();
    r2();
  });

  it('deve garantir que apenas um checkout de estoque=1 tem sucesso em acesso concorrente', async () => {
    let stock = 1;
    let successCount = 0;

    const checkout = async (): Promise<void> => {
      const release = await lock.acquire('shared-product');
      try {
        if (stock > 0) {
          stock -= 1;
          successCount += 1;
        }
      } finally {
        release();
      }
    };

    await Promise.all([checkout(), checkout(), checkout()]);

    expect(successCount).toBe(1);
    expect(stock).toBe(0);
  });

  it('deve liberar lock após release e permitir novo acquire', async () => {
    const release1 = await lock.acquire('product-x');
    release1();

    const release2 = await lock.acquire('product-x');
    release2();
  });
});
