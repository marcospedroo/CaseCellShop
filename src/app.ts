import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

import { productsRoute } from './routes/products.route';
import { checkoutRoute } from './routes/checkout.route';
import { ordersRoute } from './routes/orders.route';
import { createContextFromRequest, requestContext } from './context/requestContext';
import { logger } from './logger/logger';
import { register } from './metrics/metrics';
import { httpRequestsTotal } from './metrics/metrics';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    trustProxy: true,
  });

  await app.register(helmet, { global: true });
  await app.register(cors, { origin: process.env['CORS_ORIGIN'] ?? '*' });
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'CaseCellShop API',
        description: 'Backend service for CaseCellShop — mobile accessories e-commerce',
        version: '1.0.0',
      },
      tags: [
        { name: 'Products', description: 'Product catalog' },
        { name: 'Checkout', description: 'Purchase flow' },
        { name: 'Orders', description: 'Order management' },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/api-docs',
    uiConfig: { docExpansion: 'list', deepLinking: false },
  });

  app.addHook('onRequest', (req: FastifyRequest, _reply: FastifyReply, done) => {
    const ctx = createContextFromRequest(
      req.headers as Record<string, string | string[] | undefined>,
    );
    requestContext.run(ctx, () => done());
  });

  app.addHook('onResponse', (req: FastifyRequest, reply: FastifyReply, done) => {
    const route = req.routeOptions?.url ?? req.url;
    httpRequestsTotal.inc({
      method: req.method,
      route,
      status_code: String(reply.statusCode),
    });
    logger.info('Request completed', {
      method: req.method,
      url: req.url,
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
    });
    done();
  });

  app.get('/health', { schema: { hide: true } }, async (_req, reply) => {
    return reply.send({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/metrics', { schema: { hide: true } }, async (_req, reply) => {
    const metrics = await register.metrics();
    return reply.header('Content-Type', register.contentType).send(metrics);
  });

  await app.register(productsRoute);
  await app.register(checkoutRoute);
  await app.register(ordersRoute);

  return app;
}
