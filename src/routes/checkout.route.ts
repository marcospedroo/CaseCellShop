import type { FastifyInstance } from 'fastify';

import { CheckoutService } from '../services/checkout.service';
import { productRepository } from '../repositories/product.repository';
import { orderRepository } from '../repositories/order.repository';
import { stockLock } from '../locks/stockLock';

const service = new CheckoutService(productRepository, orderRepository, stockLock);

export async function checkoutRoute(app: FastifyInstance): Promise<void> {
  app.post(
    '/checkout',
    {
      schema: {
        tags: ['Checkout'],
        summary: 'Initiate a purchase',
        description: 'Creates a new order asynchronously. Returns 202 Accepted with orderId.',
        headers: {
          type: 'object',
          properties: {
            'idempotency-key': {
              type: 'string',
              description: 'Optional idempotency key to prevent duplicate orders',
            },
          },
        },
        body: {
          type: 'object',
          required: ['customerId', 'items'],
          properties: {
            customerId: { type: 'string', minLength: 1 },
            items: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                required: ['productId', 'quantity'],
                properties: {
                  productId: { type: 'string' },
                  quantity: { type: 'integer', minimum: 1 },
                },
              },
            },
          },
        },
        response: {
          202: {
            type: 'object',
            properties: {
              orderId: { type: 'string' },
              status: { type: 'string', enum: ['pending'] },
            },
          },
          404: {
            type: 'object',
            properties: { code: { type: 'string' }, message: { type: 'string' } },
          },
          409: {
            type: 'object',
            properties: { code: { type: 'string' }, message: { type: 'string' } },
          },
          500: {
            type: 'object',
            properties: { code: { type: 'string' }, message: { type: 'string' } },
          },
        },
      },
    },
    async (req, reply) => {
      const rawKey = req.headers['idempotency-key'];
      const idempotencyKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;

      const body = req.body as { customerId: string; items: Array<{ productId: string; quantity: number }> };

      const result = await service.checkout({
        customerId: body.customerId,
        items: body.items,
        idempotencyKey,
      });

      if (!result.success) {
        return reply.status(result.error.statusCode).send({
          code: result.error.code,
          message: result.error.message,
        });
      }

      return reply.status(202).send(result.data);
    },
  );
}
