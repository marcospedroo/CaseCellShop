import type { FastifyInstance } from 'fastify';

import { OrderService } from '../services/order.service';
import { orderRepository } from '../repositories/order.repository';

const service = new OrderService(orderRepository);

export async function ordersRoute(app: FastifyInstance): Promise<void> {
  app.get(
    '/orders/:orderId/status',
    {
      schema: {
        tags: ['Orders'],
        summary: 'Get order status',
        description: 'Returns the current status of an order.',
        params: {
          type: 'object',
          properties: {
            orderId: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              orderId: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'processing', 'completed', 'failed'] },
              createdAt: { type: 'string' },
              updatedAt: { type: 'string' },
              failureReason: { type: 'string' },
            },
          },
          404: {
            type: 'object',
            properties: { code: { type: 'string' }, message: { type: 'string' } },
          },
        },
      },
    },
    async (req, reply) => {
      const { orderId } = req.params as { orderId: string };
      const result = await service.getOrderStatus(orderId);

      if (!result.success) {
        return reply.status(result.error.statusCode).send({
          code: result.error.code,
          message: result.error.message,
        });
      }

      return reply.status(200).send(result.data);
    },
  );
}
