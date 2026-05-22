import { requestContext, createContextFromRequest } from '../../src/context/requestContext';

describe('requestContext', () => {
  describe('run / get', () => {
    it('deve armazenar e recuperar contexto dentro de run()', () => {
      const ctx = { correlationId: 'corr-1', requestId: 'req-1' };
      requestContext.run(ctx, () => {
        expect(requestContext.get()).toEqual(ctx);
      });
    });

    it('deve retornar undefined fora do contexto', () => {
      expect(requestContext.get()).toBeUndefined();
    });

    it('deve retornar default quando fora do contexto', () => {
      const result = requestContext.getOrDefault();
      expect(result.correlationId).toBe('unknown');
      expect(result.requestId).toBe('unknown');
    });
  });

  describe('setOrderId', () => {
    it('deve atualizar orderId dentro do contexto ativo', () => {
      requestContext.run({ correlationId: 'c', requestId: 'r' }, () => {
        requestContext.setOrderId('order-xyz');
        expect(requestContext.get()?.orderId).toBe('order-xyz');
      });
    });

    it('não deve lançar erro quando chamado fora do contexto', () => {
      expect(() => requestContext.setOrderId('order-xyz')).not.toThrow();
    });
  });

  describe('createContextFromRequest', () => {
    it('deve usar x-correlation-id do header quando fornecido', () => {
      const ctx = createContextFromRequest({ 'x-correlation-id': 'my-corr-id' });
      expect(ctx.correlationId).toBe('my-corr-id');
    });

    it('deve gerar correlationId quando header ausente', () => {
      const ctx = createContextFromRequest({});
      expect(ctx.correlationId).toMatch(/[0-9a-f-]{36}/);
    });

    it('deve sempre gerar requestId único', () => {
      const ctx1 = createContextFromRequest({});
      const ctx2 = createContextFromRequest({});
      expect(ctx1.requestId).not.toBe(ctx2.requestId);
    });

    it('deve aceitar x-correlation-id como array e usar o primeiro', () => {
      const ctx = createContextFromRequest({ 'x-correlation-id': ['first', 'second'] });
      expect(ctx.correlationId).toBe('first');
    });

    it('deve incluir orderId quando fornecido', () => {
      const ctx = createContextFromRequest({}, 'order-123');
      expect(ctx.orderId).toBe('order-123');
    });
  });
});
