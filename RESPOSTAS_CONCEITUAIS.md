# Respostas Conceituais — CaseCellShop

---

## Pergunta 1 — Diagnóstico, trade-offs e arquitetura alvo

### Problema 01 | Performance da vitrine

**Causa raiz**

O problema não é a lentidão do ERP em si — é o **acoplamento síncrono e sem cache** entre a loja virtual e o ERP. Cada pageview de vitrine dispara uma chamada REST ao monolito, que por sua vez executa queries no MySQL. Com milhões de acessos diários, o ERP vira gargalo não porque é lento isoladamente, mas porque recebe carga multiplicada por N usuários simultâneos fazendo a mesma pergunta: "quais são os produtos e preços?".

Raiz real: **ausência de uma camada de leitura desacoplada**. A loja trata o ERP como banco de dados transacional quando deveria tratá-lo como fonte de verdade que alimenta uma projeção própria.

**Impacto**
- Cliente: vitrine lenta → abandono de sessão → perda de receita direta
- Negócio: SLA degradado, risco de o ERP ficar indisponível por sobrecarga de leitura afetando operações críticas (faturamento, financeiro)
- Operação: sem cache, qualquer pico de acesso (campanha, black friday) derruba o sistema

**Caminhos de solução**

| Caminho | Custo | Complexidade | Latência | Consistência | Esforço operacional |
|---|---|---|---|---|---|
| **A — Cache em memória na aplicação (Redis/Memcached)** | Baixo | Baixa | Muito baixa (~1ms) | Eventual (TTL) | Baixo |
| **B — Banco de leitura próprio da loja (read replica ou DB próprio)** | Médio | Média | Baixa (~5ms) | Eventual (sync via CDC/webhook) | Médio |
| **C — BFF com cache + event-driven sync** | Alto | Alta | Muito baixa | Configurável | Alto |

**Recomendação:** Caminho A no curto prazo (0-30 dias), evoluindo para B em 60-90 dias.

---

### Problema 02 | Consistência de estoque

**Causa raiz**

O overselling ocorre por uma **race condition clássica**: dois checkouts leem o mesmo estoque (ex: 1 unidade), ambos validam "há estoque", ambos decrementam — resultado: -1 no estoque. O problema não é falta de validação, é que a validação e a reserva não são **atômicas**.

Raiz real: **ausência de operação compare-and-swap no estoque**. A checagem de disponibilidade e a reserva são dois passos separados sem garantia de exclusividade entre eles.

**Impacto**
- Cliente: compra confirmada e depois cancelada → experiência péssima, chargeback, reputação
- Negócio: obrigação de honrar venda de produto inexistente, custo logístico e de atendimento
- Operação: reconciliação manual de pedidos fantasmas, carga no suporte

**Caminhos de solução**

| Caminho | Custo | Complexidade | Throughput | Consistência | Observações |
|---|---|---|---|---|---|
| **A — Atomic update condicional no banco** (`UPDATE ... WHERE stock > 0`) | Baixo | Baixa | Alto | Forte | Ideal para instância única |
| **B — Pessimistic lock** (`SELECT FOR UPDATE`) | Baixo | Média | Baixo (serializa) | Forte | Gargalo sob alta concorrência |
| **C — Reserva de estoque (soft lock)** | Médio | Alta | Alto | Eventual | Requer TTL e reconciliação de reservas expiradas |
| **D — Distributed lock (Redis Redlock)** | Médio | Média | Alto | Forte | Necessário em múltiplas instâncias |

**Recomendação:** Caminho A no curto prazo; Caminho D quando houver múltiplos pods.

---

### Problema 03 | Resiliência do checkout

**Causa raiz**

O checkout é **síncrono e acoplado ao tempo de resposta do ERP**. Se o ERP demora 10s para faturar, o cliente espera 10s. Se o ERP cai, o checkout falha. Não há mecanismo de retry, compensação ou rastreabilidade por pedido.

Raiz real: **ausência de desacoplamento temporal entre aceitar a compra e processar o faturamento**. São eventos de naturezas diferentes: aceitar a compra é imediato; faturar no ERP é assíncrono por natureza.

**Impacto**
- Cliente: timeout na tela de pagamento → não sabe se comprou ou não → duplos cliques → duplicatas
- Negócio: pedidos perdidos, impossibilidade de escalar checkout independentemente do ERP
- Operação: sem rastreabilidade, não é possível diagnosticar pedidos travados

**Caminhos de solução**

| Caminho | Custo | Complexidade | Resiliência | Rastreabilidade |
|---|---|---|---|---|
| **A — Timeout + retry com backoff exponencial** | Baixo | Baixa | Parcial | Baixa |
| **B — Fila de mensagens (BullMQ/SQS) + worker assíncrono** | Médio | Média | Alta | Alta |
| **C — Saga pattern com compensação** | Alto | Alta | Muito alta | Alta |

**Recomendação:** Caminho B — aceitar o checkout imediatamente (202), enfileirar para processamento, expor status via polling ou webhook.

---

### Visão de arquitetura — 30 a 90 dias

```
┌─────────────────────────────────────────────────────────────────┐
│  Loja Virtual (BFF / API Gateway)                               │
│                                                                 │
│  GET /products ──► Redis Cache (TTL 60s) ──► miss ──► ERP      │
│                                                                 │
│  POST /checkout ──► Valida estoque (atomic update no DB Loja)   │
│                  ──► Salva pedido (pending) no DB Loja          │
│                  ──► Publica em fila ──► 202 Accepted           │
│                                                                 │
│  GET /orders/{id}/status ──► DB Loja                            │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │   Fila (BullMQ/SQS) │
                    │   DLQ para falhas   │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  Worker ERP         │
                    │  - Retry (3x)       │
                    │  - Backoff exp.     │
                    │  - DLQ + alerta     │
                    │  - Reconciliação    │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  ERP Central        │
                    │  (MySQL, somente    │
                    │   leitura + APIs)   │
                    └─────────────────────┘

Observabilidade transversal:
  - correlationId propagado em todas as camadas
  - Logs estruturados (pino/winston) → Datadog Log Management
  - Métricas Prometheus → Datadog Metrics
  - Traces distribuídos → Datadog APM / Jaeger
```

**30 dias:** Cache Redis na vitrine + atomic update no estoque + checkout assíncrono com fila local (BullMQ)

**60 dias:** Banco de leitura próprio da loja (sincronizado via webhook do ERP ou CDC), DLQ + alerta operacional, dashboard de observabilidade

**90 dias:** Reconciliação automatizada de pedidos pendentes, SLO definido e monitorado, runbook documentado

---

## Pergunta 2 — Cache, invalidação e performance da vitrine

### Onde colocar cache e papel de cada camada

```
Usuário
  │
  ▼
CDN / Edge Cache (Cloudflare, CloudFront)
  Papel: cacheia respostas HTTP públicas (produtos sem preço personalizado)
  TTL: 5 min | Invalidação: por tag (surrogate keys) quando produto atualiza
  │
  ▼
API Gateway / BFF — Cache de resposta HTTP
  Papel: evita que requisições idênticas cheguem à aplicação
  TTL: 30s–60s | Invalidação: por rota + parâmetros
  │
  ▼
Application Cache — Redis (ou in-memory para single-node)
  Papel: cache de objetos de domínio (lista de produtos, preços, estoque)
  TTL: 60s (produtos/preços), 5s (estoque — dado mais volátil)
  Invalidação: event-driven (webhook do ERP) ou TTL
  │
  ▼
Database Cache — Query Cache no MySQL / Read Replica
  Papel: última linha de defesa; amortece queries pesadas que passam pelo cache
  TTL: gerenciado pelo DB
```

### TTL por tipo de dado

| Dado | TTL recomendado | Justificativa |
|---|---|---|
| Lista de produtos (nome, categoria, descrição) | 5 min | Muda raramente |
| Preços | 60s | Pode mudar em promoções; inconsistência de preço é risco legal |
| Estoque (disponibilidade booleana) | 5–10s | Alta volatilidade; exibir "disponível" para item esgotado é custo alto |
| Estoque (quantidade exata) | Não cachear | Dado transacional; mostrar apenas "disponível/indisponível" |

### Estratégias de cache

**Cache-aside (lazy loading)**
```
1. Aplicação busca no cache
2. HIT → retorna
3. MISS → busca no ERP, armazena no cache, retorna
```
Vantagem: simples, só carrega o que foi pedido. Risco: MISS sob carga gera thundering herd.

**Refresh-ahead (proactive refresh)**
```
1. Antes do TTL expirar (ex: aos 80% do TTL), um job atualiza o cache em background
2. Requisições sempre acham o cache quente
```
Vantagem: zero latência de MISS para dados quentes. Custo: complexidade operacional, risco de refresh de dados nunca mais acessados.

**Recomendação:** Cache-aside para o caso base + refresh-ahead apenas para os top-N produtos mais acessados (identificados por métrica de frequência de acesso).

### Fallback

Se o Redis estiver indisponível, a aplicação deve:
1. Tentar o cache in-memory local (Fallback nível 1 — dados podem ser mais velhos)
2. Ir ao ERP diretamente com circuit breaker aberto após N falhas consecutivas
3. Servir resposta degradada (ex: lista parcial, banner de "preços podem variar") ao invés de 500

### Prevenção de cache stampede

O **thundering herd** ocorre quando o TTL expira e N requisições simultâneas vão ao ERP ao mesmo tempo.

**Solução 1 — Mutex de revalidação (probabilistic early expiration):**
Apenas uma requisição adquire o lock de revalidação; as demais retornam o valor expirado enquanto aguardam.

```typescript
async function getProducts(): Promise<Product[]> {
  const cached = await redis.get(CACHE_KEY);
  if (cached) return JSON.parse(cached);

  const lock = await redisLock.acquire('products:refresh');
  if (!lock) {
    // outra instância está revalidando — serve stale ou aguarda
    return getStaleOrWait();
  }
  try {
    const products = await erp.getProducts();
    await redis.set(CACHE_KEY, JSON.stringify(products), 'EX', 60);
    return products;
  } finally {
    await lock.release();
  }
}
```

**Solução 2 — Jitter no TTL:**
Adicionar variação aleatória ao TTL evita que todos os itens expirem ao mesmo tempo: `TTL = 60 + random(0, 15)`.

### Métricas para validar ganho sem dados obsoletos

**Métricas de performance:**
- `cache_hit_ratio = hits / (hits + misses)` — alvo > 90%
- `cache_response_p99` — latência com cache deve ser < 5ms vs > 100ms sem cache
- `erp_requests_total` — deve cair proporcionalmente ao hit ratio

**Métricas de consistência (dados não obsoletos):**
- `price_discrepancy_rate` — comparar preço no cache vs ERP em amostra aleatória (<0.1%)
- `stock_phantom_rate` — % de checkouts aprovados para itens sem estoque real
- `cache_invalidation_lag_ms` — tempo entre ERP atualizar e cache ser invalidado (alvo < TTL)
- `stale_serve_count` — quantas vezes o fallback de stale cache foi ativado

---

## Pergunta 3 — Observabilidade, Datadog ou equivalente

### Logs estruturados

**Campos obrigatórios em todo log:**

```json
{
  "timestamp": "2026-05-22T20:00:00.000Z",
  "level": "info",
  "service": "casecellshop-backend",
  "correlationId": "uuid-propagado-entre-servicos",
  "requestId": "uuid-unico-por-requisicao",
  "orderId": "uuid-do-pedido-quando-existir",
  "message": "...",
  "durationMs": 45
}
```

**Campos adicionais por contexto:**

| Contexto | Campos extras |
|---|---|
| HTTP request | `method`, `route`, `statusCode`, `userAgent` |
| Cache | `cache_key`, `operation` (hit/miss/set/invalidate) |
| Checkout | `customerId`, `itemCount`, `totalValue`, `idempotencyKey` |
| Worker/ERP | `retryCount`, `queueDelayMs`, `erpResponseMs` |
| Erro | `error.message`, `error.code`, `error.stack` (somente fora de produção) |

**O que NUNCA logar:** senhas, tokens JWT, CVV, número de cartão, CPF completo.

### Métricas por tipo

**Counters** (acumulam, nunca decrementam):
```
http_requests_total{method, route, status_code}
cache_operations_total{operation: hit|miss|set|invalidate}
checkout_attempts_total{result: success|insufficient_stock|error}
erp_calls_total{endpoint, status: success|timeout|error}
queue_messages_published_total
queue_messages_consumed_total{result: success|retry|dlq}
```

**Gauges** (valor atual, sobe e desce):
```
orders_by_status_total{status: pending|processing|completed|failed}
queue_depth_current          — tamanho atual da fila
cache_entries_current        — itens no cache
erp_circuit_breaker_state    — 0=closed, 1=half-open, 2=open
```

**Histogramas** (distribuição de latência, base para percentis):
```
http_request_duration_seconds{route}          — P50/P95/P99 por rota
checkout_processing_duration_seconds          — ponta-a-ponta do checkout
erp_call_duration_seconds{endpoint}           — latência das chamadas ao ERP
cache_operation_duration_seconds{operation}   — latência do Redis
queue_processing_duration_seconds             — tempo do worker por pedido
```

### Traces distribuídos essenciais

**`GET /products`:**
```
Span: http.server GET /products (root)
  ├── Span: cache.get products:all
  │     └── [HIT] → fim
  │     └── [MISS] → Span: erp.getProducts
  │                      └── Span: db.query SELECT products...
  └── Span: cache.set products:all
```

**`POST /checkout` (assíncrono):**
```
Span: http.server POST /checkout (root — propaga trace_id no cabeçalho)
  ├── Span: checkout.idempotency_check
  ├── Span: stock.lock.acquire{productId}
  ├── Span: stock.validate
  ├── Span: db.save order
  └── Span: queue.publish order.created

  [Worker — mesmo trace_id via mensagem]
  Span: worker.process_order
    ├── Span: erp.submit_order
    └── Span: db.update_status
```

O `trace_id` deve ser propagado na mensagem da fila como metadado — assim o trace da requisição HTTP e o trace do worker ficam ligados no mesmo trace distribuído.

### SLI / SLO

| SLI | SLO | Janela |
|---|---|---|
| Disponibilidade da vitrine (`2xx / total`) | ≥ 99.9% | 30 dias |
| Latência P95 de `GET /products` | < 200ms | 7 dias |
| Latência P95 de `POST /checkout` (aceitar, não processar) | < 500ms | 7 dias |
| Taxa de overselling (`stock_phantom_rate`) | < 0.01% | 7 dias |
| Taxa de pedidos completados vs iniciados | ≥ 99% | 24h |

### Dashboard Datadog (exemplo de queries)

```
# Request rate por rota
sum:http_requests_total{*} by {route}.as_rate()

# Error rate
sum:http_requests_total{status_code:5*} / sum:http_requests_total{*}

# Cache miss rate
cache_operations_total{operation:miss}.as_rate() /
(cache_operations_total{operation:hit}.as_rate() + cache_operations_total{operation:miss}.as_rate())

# Checkout P95
histogram_quantile(0.95, checkout_processing_duration_seconds_bucket)

# Profundidade da fila
queue_depth_current

# Pedidos por status
orders_by_status_total by {status}
```

### Alertas

| Alerta | Condição | Severidade | Ação |
|---|---|---|---|
| Alta taxa de erros | `error_rate > 5%` por 5 min | Critical | Acionar on-call |
| Cache miss rate alto | `miss_rate > 30%` por 10 min | Warning | Verificar Redis |
| Checkout lento | P95 > 2s por 5 min | Warning | Verificar lock contention |
| Pedidos travados em processing | `orders{status:processing} > 100` por 15 min | Critical | Verificar worker/ERP |
| Fila crescendo | `queue_depth > 500` por 5 min | Warning | Escalar workers |
| ERP circuit breaker aberto | `erp_circuit_breaker_state = 2` | Critical | Acionar equipe ERP |
| Overselling detectado | `stock_phantom_rate > 0` | Critical | Acionar imediatamente |

### Runbook — Checkout falhando

```
1. Verificar dashboard: qual a taxa de erro e em qual rota?
2. Consultar logs: nível error com campo "service: casecellshop-backend"
3. Se INSUFFICIENT_STOCK: estoque real esgotado — comportamento esperado
4. Se CHECKOUT_ERROR (500): verificar lock contention
   - checkout_processing_duration_seconds P99 > 5s → possível deadlock
   - Reiniciar instância se travado
5. Se erros de conexão com DB: verificar pool de conexões, escalar DB
6. Verificar fila: queue_depth crescendo sem consumo → worker down?
7. Verificar DLQ: mensagens na DLQ indicam falha recorrente no ERP
```

---

## Pergunta 4 — Concorrência, estoque e idempotência

### Por que a checagem simples de estoque é insuficiente

```typescript
// ERRADO — race condition entre verificar e decrementar
const product = await repo.findById(id);      // lê estoque = 1
if (product.stock < quantity) return error;   // passa: 1 >= 1
await repo.decrementStock(id, quantity);      // decrementa para 0
// Outra requisição faz o mesmo entre as duas linhas acima → overselling
```

Em Node.js, o `await` entrega o controle ao event loop — outra Promise pode ser executada entre o `findById` e o `decrementStock`. O problema não é thread-safety (Node.js é single-threaded), é **interleaving de operações assíncronas**.

### Comparativo das estratégias

**Atomic update condicional**
```sql
UPDATE products SET stock = stock - 1
WHERE id = ? AND stock >= 1
-- Retorna rows_affected: 0 se estoque insuficiente
```
- Vantagem: operação atômica garantida pelo banco, alta performance, sem locks externos
- Desvantagem: requer banco relacional; difícil de implementar com múltiplos itens no mesmo checkout
- Ideal para: single-instance, banco relacional

**Pessimistic lock** (`SELECT FOR UPDATE`)
```sql
BEGIN;
SELECT stock FROM products WHERE id = ? FOR UPDATE; -- bloqueia a linha
UPDATE products SET stock = stock - 1 WHERE id = ?;
COMMIT;
```
- Vantagem: garantia forte de consistência
- Desvantagem: serializa todos os checkouts do mesmo produto, degradação severa sob concorrência
- Ideal para: operações críticas com baixo volume

**Reserva de estoque (soft lock)**
```
1. Criar reserva com TTL (ex: 10 min) decrementando estoque reservado
2. Prosseguir com pagamento enquanto reserva está ativa
3. Confirmar: converter reserva em venda
4. Cancelar/expirar: liberar reserva de volta ao estoque disponível
```
- Vantagem: melhor UX (garantia ao cliente durante o fluxo de compra), alto throughput
- Desvantagem: complexidade alta, requer job de expiração de reservas, reconciliação
- Ideal para: e-commerce com tempo de checkout longo (usuário preenche formulário)

**Distributed lock (Redis Redlock)**
```
SETNX lock:product:prod-001 {owner: uuid, ttl: 5s}
-- somente quem adquiriu o lock executa o checkout
DEL lock:product:prod-001
```
- Vantagem: funciona em múltiplas instâncias, granularidade por produto
- Desvantagem: dependência do Redis, risco de lock não liberado (requer TTL e heartbeat)
- Ideal para: múltiplos pods/instâncias

**Recomendação por cenário:**
- Single instance: promise-chain mutex (conforme implementado) + atomic update no DB
- Multi-instance: Redis Redlock + atomic update no DB como segunda linha de defesa

### Idempotência para tolerar retry e duplo clique

**Dois níveis obrigatórios:**

1. **Nível de rede (header `Idempotency-Key`):**
O cliente envia um UUID único por intenção de compra. O servidor armazena a resposta associada à chave. Retries retornam a mesma resposta sem reprocessar.

2. **Nível de payload (hash automático):**
Para clientes que não enviam o header, gerar chave determinística a partir de `hash(customerId + items_ordenados)`. Protege contra duplos cliques sem necessitar de coordenação no cliente.

```typescript
function buildIdempotencyKey(req: CheckoutRequest): string {
  if (req.idempotencyKey) return req.idempotencyKey;
  const canonical = JSON.stringify({
    customerId: req.customerId,
    items: [...req.items].sort((a, b) => a.productId.localeCompare(b.productId)),
  });
  return `auto:${Buffer.from(canonical).toString('base64')}`;
}
```

**Fluxo com idempotência:**
```
1ª chamada (ou retry):
  → busca no índice de idempotência
  → não encontrado → processa normalmente → persiste (chave → orderId)
  → retorna 202 { orderId, status: 'pending' }

2ª chamada (retry / duplo clique):
  → busca no índice de idempotência
  → encontrado → retorna o mesmo 202 { orderId, status: '...' }
  → SEM reprocessamento, SEM novo pedido
```

**Como testar que evita overselling:**

```typescript
it('deve criar exatamente 1 pedido para N checkouts simultâneos com estoque = 1', async () => {
  // produto com estoque = 1
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      service.checkout({ customerId: 'c1', items: [{ productId: 'prod-005', quantity: 1 }] })
    )
  );

  const successes = results.filter((r) => r.success);
  const failures = results.filter((r) => !r.success);

  expect(successes).toHaveLength(1);
  expect(failures).toHaveLength(9);
  expect(failures.every((f) => !f.success && f.error.code === 'INSUFFICIENT_STOCK')).toBe(true);

  // estoque deve ser exatamente 0 — não negativo
  const product = await productRepo.findById('prod-005');
  expect(product?.stock).toBe(0);
});
```

---

## Pergunta 5 — Mensageria, resiliência, contrato e IA

### Publicar mensagem antes ou depois de gravar o pedido?

**Resposta: DEPOIS de gravar, mas usando outbox pattern para garantia.**

**Problema com "antes de gravar":**
```
1. Publica mensagem na fila ✓
2. Falha antes de salvar no banco ✗
→ Mensagem fantasma: fila processa um pedido que não existe no banco
```

**Problema com "depois de gravar" (naïve):**
```
1. Salva pedido no banco ✓
2. Falha antes de publicar ✗
→ Pedido fantasma: existe no banco com status 'pending' mas nunca será processado
```

**Solução correta — Transactional Outbox Pattern:**
```
Transação única no banco:
  INSERT INTO orders (id, status='pending', ...)
  INSERT INTO outbox (event='order.created', payload={orderId, ...})
COMMIT

Job separado (polling ou CDC):
  SELECT * FROM outbox WHERE published = false
  → publica na fila
  → marca como published = true
```

Garante que pedido e mensagem são criados atomicamente, sem dependência de transação distribuída.

**Para a implementação do desafio** (sem banco real): a abordagem adotada foi gravar o pedido em memória e enfileirar no worker via polling — equivalente funcional do outbox sem a durabilidade do banco.

### Como evitar pedido fantasma e mensagem fantasma

| Problema | Causa | Solução |
|---|---|---|
| **Pedido fantasma** | Pedido criado no banco mas nunca processado | Outbox pattern + job de reconciliação para pedidos `pending` há mais de X minutos |
| **Mensagem fantasma** | Mensagem na fila sem pedido correspondente | Publicar somente após commit no banco; worker valida existência do pedido antes de processar |
| **Duplicata por retry do worker** | Worker processa duas vezes por falha de ack | Idempotência no processamento: verificar se pedido já está `completed/failed` antes de processar |

### Retry e DLQ

**Estratégia de retry com backoff exponencial:**
```
Tentativa 1: imediato
Tentativa 2: 30s
Tentativa 3: 2min
Tentativa 4: 10min
Tentativa 5: 30min → DLQ
```

**DLQ (Dead Letter Queue):**
- Mensagens que falharam após N tentativas vão para a DLQ
- Alerta imediato para o time operacional
- Possibilidade de reprocessamento manual após correção do problema
- Análise de padrão: se múltiplas mensagens na DLQ com mesmo erro → bug sistêmico

**Reconciliação:**
Job periódico (ex: a cada hora) que busca pedidos `pending` há mais de 30 minutos e os reenfileira — compensa mensagens perdidas antes da DLQ.

### Contrato de API (OpenAPI)

Disponível em `/api-docs` quando o servidor está rodando. Schema resumido:

```yaml
POST /checkout:
  requestBody:
    required: [customerId, items]
    customerId: string
    items: Array<{ productId: string, quantity: integer (min: 1) }>
    idempotencyKey: string (opcional)
  responses:
    202:
      orderId: string (UUID)
      status: "pending"
    400: { code: "VALIDATION_ERROR", message: string }
    404: { code: "PRODUCT_NOT_FOUND", message: string }
    409: { code: "INSUFFICIENT_STOCK", message: string }
    429: { code: "RATE_LIMIT_EXCEEDED" }

GET /orders/{orderId}/status:
  responses:
    200:
      orderId: string
      status: pending | processing | completed | failed
      createdAt: string (ISO 8601)
      updatedAt: string (ISO 8601)
      failureReason: string (opcional)
    404: { code: "ORDER_NOT_FOUND" }
```

### Testes obrigatórios para o checkout assíncrono

```
Regra de negócio:
  ✓ Checkout com estoque suficiente → 202 + orderId
  ✓ Checkout com estoque insuficiente → 409
  ✓ Checkout com produto inexistente → 404
  ✓ Checkout com body inválido → 400

Idempotência:
  ✓ Mesma Idempotency-Key → mesmo orderId, sem novo pedido
  ✓ Mesmo payload sem header → mesma chave auto-gerada → mesmo orderId
  ✓ N chamadas paralelas com mesma chave → exatamente 1 pedido criado

Concorrência:
  ✓ 10 checkouts simultâneos para produto com estoque=1 → exatamente 1 sucesso
  ✓ Estoque após concorrência nunca negativo
  ✓ Múltiplas consultas de status simultâneas → resultado consistente

Worker:
  ✓ Pedido pending → worker processa → completed
  ✓ Falha do worker → retry automático
  ✓ Falha permanente → status failed + estoque restaurado
  ✓ Worker não processa pedido já completed/failed (idempotência)
```

### Prompts de IA relevantes para esta parte

```
"Explain the Transactional Outbox Pattern for guaranteeing at-least-once delivery
between a database write and a message queue publish, without distributed transactions"

"Compare pessimistic locking vs optimistic locking vs distributed lock (Redlock)
for preventing overselling in a Node.js e-commerce checkout with multiple instances"

"Design a DLQ strategy for an order processing worker with exponential backoff,
max retry count, and reconciliation job for lost messages"
```
