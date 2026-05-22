import type { FastifyInstance } from 'fastify';

import { ProductService } from '../services/product.service';
import { productRepository } from '../repositories/product.repository';
import { productCache } from '../cache/productCache';

const service = new ProductService(productRepository, productCache);

export async function productsRoute(app: FastifyInstance): Promise<void> {
  app.get(
    '/products',
    {
      schema: {
        tags: ['Products'],
        summary: 'List all products',
        description: 'Returns the full product catalog. Results are cached in memory with TTL.',
        response: {
          200: {
            type: 'object',
            properties: {
              data: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    price: { type: 'number' },
                    stock: { type: 'number' },
                    category: { type: 'string' },
                    description: { type: 'string' },
                  },
                },
              },
            },
          },
          500: {
            type: 'object',
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    async (_req, reply) => {
      const result = await service.listProducts();
      if (!result.success) {
        return reply.status(result.error.statusCode).send({
          code: result.error.code,
          message: result.error.message,
        });
      }
      return reply.status(200).send({ data: result.data });
    },
  );
}
