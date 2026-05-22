import { buildApp } from './app';
import { logger } from './logger/logger';
import { OrderWorker } from './worker/orderWorker';
import { orderRepository } from './repositories/order.repository';
import { productRepository } from './repositories/product.repository';

const PORT = Number(process.env['PORT'] ?? 3000);
const HOST = process.env['HOST'] ?? '0.0.0.0';

async function main(): Promise<void> {
  const app = await buildApp();
  const worker = new OrderWorker(orderRepository, productRepository);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down...`);
    worker.stop();
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: PORT, host: HOST });

  worker.start();

  logger.info(`Server running at http://${HOST}:${PORT}`);
  logger.info(`API docs at http://localhost:${PORT}/api-docs`);
  logger.info(`Metrics at http://localhost:${PORT}/metrics`);
}

main().catch((err) => {
  logger.error('Failed to start server', err);
  process.exit(1);
});
