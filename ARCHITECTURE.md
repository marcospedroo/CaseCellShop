# CaseCellShop — Arquitetura e Decisões Técnicas

Documentação detalhada de cada módulo, função e decisão de design do projeto.

---

## Visão Geral

O projeto segue uma arquitetura em camadas clássica com módulos transversais de observabilidade injetados em todas as camadas via contexto assíncrono.

```
server.ts         ← bootstrap e ciclo de vida do processo
app.ts            ← configuração HTTP, plugins e hooks
routes/           ← entrada das requisições e validação de schema
services/         ← regras de negócio
repositories/     ← acesso a dados (em memória)
cache/            ← cache com TTL
locks/            ← controle de concorrência de estoque
worker/           ← processamento assíncrono de pedidos
context/          ← propagação de IDs de rastreamento (AsyncLocalStorage)
logger/           ← logs estruturados com pino
tracer/           ← stub de tracing compatível com OpenTelemetry
metrics/          ← métricas Prometheus com prom-client
types/            ← contratos TypeScript do domínio
```

### Fluxo de uma requisição completa

```
Cliente
  │
  ▼
POST /checkout ──onRequest hook──► AsyncLocalStorage: { correlationId, requestId }
  │
  ▼
checkoutRoute   ──valida schema JSON──► CheckoutService.checkout()
  │
  ├─► inFlight check       (idempotência para chamadas paralelas)
  ├─► findByIdempotencyKey  (idempotência persistida)
  ├─► StockLock.acquire()   (mutex por produto, evita overselling)
  ├─► validateStock()       (verifica disponibilidade dentro do lock)
  ├─► decrementStock()      (dentro do lock)
  ├─► orderRepo.save()
  └─► retorna 202 { orderId, status: "pending" }
  │
  ▼
onResponse hook ──► httpRequestsTotal++ + log estruturado com durationMs
  │
  ▼  (2 segundos depois, via setInterval)
OrderWorker.processPendingOrders()
  ├─► pending → processing → completed / failed
  └─► em falha permanente: restaura estoque
```

---

## Módulos

### `src/types/index.ts` — Contratos do domínio

Define todas as interfaces e tipos compartilhados do sistema.

| Tipo | Decisão |
|---|---|
| `Product` | `stock` é mutável (precisa decrementar); demais campos são `readonly` para prevenir mutações acidentais |
| `OrderStatus` | Union type literal `'pending' \| 'processing' \| 'completed' \| 'failed'` em vez de `enum` — mais seguro em TypeScript e sem problemas de serialização JSON |
| `Result<T, E>` | Tipo discriminado `{ success: true; data: T } \| { success: false; error: E }` — erros esperados (estoque insuficiente, produto não encontrado) são tratados como valores, não exceções; `throw` é reservado para erros imprevistos de sistema |
| `AppError` | Carrega `code`, `message` e `statusCode` — o código HTTP já vem embutido no erro, facilitando a conversão na camada de rota sem lógica extra |
| `LogContext` | Interface que descreve o contrato obrigatório de cada linha de log — garante que `correlationId`, `requestId` e `orderId` nunca sejam esquecidos |

---

### `src/context/requestContext.ts` — Propagação de IDs

```typescript
const storage = new AsyncLocalStorage<RequestContextData>();
```

**Por que `AsyncLocalStorage`?**
Node.js é single-threaded mas executa requisições concorrentemente via event loop. Sem `AsyncLocalStorage`, seria necessário passar `correlationId` e `requestId` como parâmetro em cada função do call stack — poluindo as assinaturas de services e repositories. O `AsyncLocalStorage` cria um "namespace" isolado por contexto assíncrono: cada requisição tem sua própria instância de dados, acessível em qualquer ponto do código sem passagem explícita.

| Função | O que faz |
|---|---|
| `run(data, fn)` | Inicia um novo contexto assíncrono e executa `fn` dentro dele. Usado no hook `onRequest` do Fastify para cada requisição |
| `get()` | Acessa os dados do contexto da requisição atual. Retorna `undefined` se chamado fora de um contexto |
| `getOrDefault()` | Igual ao `get()`, mas retorna `{ correlationId: 'unknown', requestId: 'unknown' }` como fallback seguro — evita `undefined` nos logs |
| `setOrderId(orderId)` | Muta o contexto existente para incluir o `orderId` assim que ele é criado no checkout, sem precisar criar um novo contexto |
| `createContextFromRequest(headers)` | Lê o header `x-correlation-id` para rastreamento entre serviços (distributed tracing). Se não existir, gera um UUID. O `requestId` é sempre um UUID novo por requisição |

---

### `src/logger/logger.ts` — Logs estruturados

```typescript
const baseLogger = pino({
  redact: { paths: ['password', 'token', 'authorization', 'cpf', 'cardNumber', 'cvv'] }
});
```

**Por que pino?**
É o logger mais performático do ecossistema Node.js. Escreve JSON de forma eficiente com impacto mínimo na latência da aplicação. Winston e Bunyan são alternativas válidas, mas mais lentas.

| Função / Config | O que faz |
|---|---|
| `redact` | Qualquer campo com os nomes listados é substituído por `[REDACTED]` antes de logar — proteção automática contra vazamento de dados sensíveis |
| `withContext(meta)` | Função interna que mescla o contexto da requisição (`correlationId`, `requestId`, `orderId`) com o `meta` do chamador. Chamada em toda emissão de log, garantindo que nenhuma linha fique sem os campos de rastreamento |
| `logger.info / warn / debug` | Wrappers sobre o pino base que injetam automaticamente o contexto da requisição |
| `logger.error(msg, err, meta)` | Tratamento especial para objetos `Error`: extrai `message`, `stack` (omitida em produção) e `code`. Em produção, `stack` é suprimida para não expor internals do servidor em respostas ou logs externos |

---

### `src/tracer/tracer.ts` — Stub de tracing

```typescript
export function startSpan(operation: string, parentSpanId?: string): Span
```

**Por que é um stub e não OpenTelemetry real?**
Integrar OTel real (Jaeger, Tempo, Datadog APM) requer infraestrutura adicional que foge do escopo do desafio técnico. O stub demonstra o **contrato de observabilidade** que uma implementação real seguiria: `trace_id`, `span_id`, `parent_span_id`, `operation` e `duration_ms`. Para migrar para produção, basta substituir por `@opentelemetry/sdk-node` + OTLP HTTP exporter mantendo a mesma interface `Span`.

| Função | O que faz |
|---|---|
| `startSpan(operation)` | Cria um span com `trace_id` (UUID sem hífens, 32 chars) e `span_id` (16 chars), registrando o timestamp de início |
| `span.finish(attrs)` | Calcula `durationMs`, emite log `debug` com todos os campos do span. O span fica rastreável por `trace_id` nos logs |

---

### `src/metrics/metrics.ts` — Métricas Prometheus

```typescript
export const register = new Registry();
collectDefaultMetrics({ register });
```

**Por que Prometheus?**
É o padrão de facto para métricas em ambientes cloud-native. Datadog, Grafana e qualquer plataforma de observabilidade conseguem ingeri-lo. O endpoint `/metrics` é raspado periodicamente pelo coletor.

`collectDefaultMetrics` adiciona automaticamente métricas de processo: uso de memória heap, CPU, event loop lag e handles ativos.

| Métrica | Tipo | Labels | Finalidade |
|---|---|---|---|
| `http_requests_total` | Counter | `method`, `route`, `status_code` | Taxa de requisições e taxa de erros por rota |
| `cache_operations_total` | Counter | `operation` (hit/miss/set/invalidate) | Calcular `miss_rate = miss / (hit + miss)` |
| `checkout_processing_duration_seconds` | Histogram | — | Percentis P95/P99 de latência do checkout |
| `orders_by_status_total` | Gauge | `status` | Estado atual de pedidos — sobe e desce conforme o worker processa |

**Por que Histogram para o checkout?**
Counters e Gauges não capturam distribuição de latência. O Histogram permite perguntar "qual é o P95 de latência?" no Prometheus com `histogram_quantile(0.95, ...)` — informação crítica para SLOs.

---

### `src/cache/productCache.ts` — Cache em memória com TTL

```typescript
private readonly store: Map<string, CacheEntry<Product[]>> = new Map();
```

**Por que cache de produtos?**
Produtos mudam raramente. Sem cache, cada `GET /products` consultaria o repositório (ou banco de dados em produção) toda vez. O cache reduz latência e carga no storage. Em produção, substituiria por Redis com o mesmo contrato via `IProductCache`.

| Função | O que faz |
|---|---|
| `get(key)` | Verifica disponibilidade do cache, existência da entrada e validade do TTL (`Date.now() > expiresAt`). Incrementa métrica `hit` ou `miss`. Usa nível `warn` para miss — é um evento de degradação de performance |
| `set(key, value, ttlMs)` | Armazena com `expiresAt = agora + TTL`. TTL padrão de 60 segundos, configurável por chamada |
| `invalidate(key)` | Remoção explícita de uma entrada — útil quando um produto é atualizado externamente |
| `simulateUnavailable()` / `simulateAvailable()` | Métodos exclusivos para testes — simulam o cache fora de serviço para testar o fallback no `ProductService` |
| `getEntry(key)` | Acesso interno à entrada com `expiresAt`, usado em testes para verificar o TTL |

---

### `src/locks/stockLock.ts` — Mutex por produto

Este é o mecanismo central de controle de concorrência:

```typescript
async acquire(productId: string): Promise<ReleaseFn> {
  const current = this.locks.get(productId) ?? Promise.resolve();

  let release!: ReleaseFn;
  const next = new Promise<void>((resolve) => { release = resolve; });

  this.locks.set(productId, current.then(() => next));
  await current;

  return () => { release(); ... };
}
```

**Por que promise chaining e não um flag booleano?**
Node.js é single-threaded, mas `await` cria pontos de entrega de controle para o event loop. Entre o `findById` (verifica estoque) e o `decrementStock` (decrementa), outra requisição pode entrar e verificar o mesmo estoque — resultado: dois checkouts aprovados para estoque = 1 (overselling).

O padrão funciona assim:
- `locks` armazena uma Promise por produto — ela representa "quem está usando agora"
- `current` é a promise do dono atual do lock
- `next` é uma nova promise que só resolve quando `release()` for chamado
- `this.locks.set(productId, current.then(() => next))` encadeia: o próximo waiters aguarda `current` terminar E `next` resolver
- Quem quer o lock faz `await current` — fica suspenso até o dono liberar
- Não é busy-wait; é suspensão real no event loop

**Ordenação de locks:** os IDs de produto são ordenados alfabeticamente antes de adquirir locks para evitar **deadlock**. Sem ordenação: requisição A pede lock `[prod-001, prod-002]`, requisição B pede `[prod-002, prod-001]` — cada uma segura um lock e espera o outro.

| Função | O que faz |
|---|---|
| `acquire(productId)` | Adquire o mutex para o produto. Retorna uma função `release` que deve ser chamada no `finally` |
| `isLocked(productId)` | Verifica se há alguém segurando o lock — usado em testes para validar o comportamento do mutex |

---

### `src/repositories/` — Dados em memória

Implementam interfaces (`IProductRepository`, `IOrderRepository`) com `Promise.resolve()` explícito em vez de `async/await` — não há operação assíncrona real; o `async` seria falso e ativaria a regra `require-await` do ESLint.

**Por que interfaces?**
Permitem trocar a implementação por PostgreSQL/Prisma em produção sem alterar nenhuma service. É o princípio de inversão de dependência — as services dependem da abstração, não da implementação concreta.

**`InMemoryOrderRepository`**

| Função | O que faz |
|---|---|
| `save(order)` | Persiste o pedido em dois Maps: o principal (`id → order`) e o índice secundário (`idempotencyKey → id`) |
| `findById(id)` | Retorna uma cópia profunda do pedido (`{ ...order, items: items.map(...) }`) — evita que chamadores mutem o estado interno do repositório acidentalmente |
| `findByIdempotencyKey(key)` | Lookup O(1) no índice secundário — fundamental para a idempotência ser eficiente |
| `updateStatus(id, status, failureReason)` | Muta diretamente o objeto no Map e atualiza `updatedAt` — simula um `UPDATE` SQL |
| `findPending()` | Filtra todos os pedidos com status `pending` — chamado pelo worker a cada ciclo |
| `countByStatus(status)` | Contagem para atualizar os Gauges Prometheus após cada transição |

**`InMemoryProductRepository`**

| Função | O que faz |
|---|---|
| `findAll()` | Retorna cópias shallow dos produtos — o cache armazena essa cópia, não a referência original |
| `decrementStock(productId, qty)` | Chamado dentro do lock. Retorna `false` se estoque insuficiente — segunda linha de defesa (a primeira é o `validateStock`) |
| `incrementStock(productId, qty)` | Chamado pelo worker para restaurar estoque em falha permanente |

---

### `src/services/product.service.ts` — Serviço de produtos

```typescript
const cached = this.cache.get(CACHE_KEY);
if (cached) return { success: true, data: cached };
const products = await this.repo.findAll();
this.cache.set(CACHE_KEY, products);
```

**Padrão cache-aside:** tenta o cache primeiro, consulta o repositório apenas em miss, armazena no cache para a próxima chamada.

**Fallback de cache degradado:** se o repositório lançar exceção, tenta servir o cache mesmo expirado (stale cache). É melhor retornar dados potencialmente desatualizados do que retornar HTTP 500 — resiliência > consistência estrita, neste contexto.

| Função | O que faz |
|---|---|
| `listProducts()` | Implementa cache-aside + fallback + tracing + log de latência |
| `getProduct(id)` | Busca direta no repositório sem cache — produto individual tem acesso menos frequente |

---

### `src/services/checkout.service.ts` — Regra central de negócio

**`buildIdempotencyKey(request)`**
Se o cliente não enviar `Idempotency-Key`, gera uma chave determinística a partir do payload: `customerId` + `items` ordenados por `productId`, serializado em JSON e codificado em base64. Dois cliques acidentais com o mesmo conteúdo produzem a mesma chave — idempotência automática por conteúdo.

**`checkout(request)` — camada de in-flight:**
```typescript
const inFlightPromise = this.inFlight.get(idempotencyKey);
if (inFlightPromise) return inFlightPromise;
```
Se duas requisições com a mesma chave chegarem **simultaneamente** (antes de qualquer uma terminar e ser persistida), a segunda reutiliza a mesma Promise da primeira. Sem isso, a segunda passaria pelo `findByIdempotencyKey` antes da primeira ter persistido o pedido — e criaria um duplicado.

**`doCheckout` — fluxo principal:**

| Etapa | Detalhe |
|---|---|
| 1. Busca por idempotência | `findByIdempotencyKey` — se pedido já existe, retorna imediatamente |
| 2. Ordena produtos | `[...productIds].sort()` — ordem determinística para evitar deadlock nos locks |
| 3. Adquire locks | Um lock por produto, em ordem. Bloqueante para concorrentes do mesmo produto |
| 4. Valida estoque | `validateStock()` — dentro do lock, garantindo que ninguém alterou o estoque entre a aquisição do lock e a verificação |
| 5. Decrementa estoque | Dentro do lock — operação atômica para o contexto single-node |
| 6. Persiste pedido | `orderRepo.save()` com status `pending` |
| 7. Libera locks | No `finally` — sempre liberados, mesmo em exceção |

**`void promise.finally(...)`:** o `void` informa ao ESLint e ao TypeScript que a Promise do `finally` é intencionalmente não-aguardada — é apenas um cleanup que não precisa de tratamento de erro próprio.

| Função | O que faz |
|---|---|
| `buildIdempotencyKey` | Gera chave de idempotência a partir do header ou do hash do payload |
| `checkout` | Ponto de entrada público — gerencia in-flight map e delega para `doCheckout` |
| `doCheckout` | Implementa o fluxo completo com lock, validação, persistência e métricas |
| `validateStock` | Verifica disponibilidade de cada item e monta a lista de `orderItems` com `unitPrice` snapshottado no momento da compra |

---

### `src/services/order.service.ts` — Consulta e atualização de pedidos

| Função | O que faz |
|---|---|
| `getOrderStatus(orderId)` | Busca o pedido e serializa datas como ISO 8601 — formato universal, evita ambiguidade de timezone |
| `updateOrderStatus(orderId, status)` | Além de atualizar o status, recalcula os Gauges Prometheus do status anterior e do novo — mantém as métricas precisas após cada transição |
| `toResponse(order)` | Converte a entidade `Order` para o DTO de resposta HTTP — separa modelo interno de contrato externo |

---

### `src/worker/orderWorker.ts` — Processamento assíncrono

```typescript
this.timer = setInterval(() => {
  void this.processPendingOrders();
}, intervalMs);
```

Simula um worker de fila. Em produção seria BullMQ (Redis-backed) ou AWS SQS para durabilidade e distribuição.

**Por que `void` no setInterval?** `setInterval` não trata Promises — a chamada é fire-and-forget intencional. O `void` sinaliza isso explicitamente.

| Função | O que faz |
|---|---|
| `start(intervalMs)` | Inicia o polling a cada `intervalMs` (padrão 2s). Guard `if (this.running)` evita múltiplos timers |
| `stop()` | `clearInterval` + flag `running = false`. Chamado no graceful shutdown |
| `processPendingOrders()` | Busca todos os pedidos `pending` e processa cada um dentro de um `requestContext.run()` próprio — cada pedido tem seu próprio `correlationId` e `requestId` nos logs |
| `processOrder(orderId)` | Transiciona `pending → processing → completed/failed`. Falha simulada com 10% de probabilidade. Retry automático até 3 vezes antes de falha permanente |
| `restoreStock(orderId)` | Itera sobre os itens do pedido que falhou e chama `incrementStock` — devolve o estoque para venda |
| `simulateDelay()` | `setTimeout` de 500ms simulando latência de chamada HTTP ao ERP |

**Ciclo de vida de um pedido com falha:**
```
pending → processing → pending (retry 1)
pending → processing → pending (retry 2)
pending → processing → pending (retry 3)
pending → processing → failed → estoque restaurado
```

---

### `src/app.ts` — Configuração HTTP e plugins

| Componente | Por que foi usado |
|---|---|
| `@fastify/helmet` | Adiciona headers de segurança HTTP automaticamente: `Content-Security-Policy`, `HSTS`, `X-Frame-Options`, `X-Content-Type-Options` — linha de defesa básica contra XSS e clickjacking |
| `@fastify/cors` | Configura `Access-Control-Allow-Origin` via variável de ambiente. Nunca hardcoded — em produção, especificar origens exatas em vez de `*` |
| `@fastify/rate-limit` | 100 requisições por minuto por IP. Proteção simples contra abuso e DDoS de baixa intensidade. Em produção, usar WAF ou API Gateway |
| `@fastify/swagger` + `@fastify/swagger-ui` | Gera documentação OpenAPI a partir dos schemas JSON das rotas e a serve em `/api-docs` sem código extra |
| Hook `onRequest` | Executa antes de qualquer handler. Cria o contexto assíncrono com `correlationId`/`requestId` — tudo downstream os acessa via `requestContext.get()` |
| Hook `onResponse` | Executa após cada resposta. Incrementa o counter HTTP com método, rota e status code. Emite log de conclusão com `durationMs` (tempo medido pelo próprio Fastify via `reply.elapsedTime`) |
| `GET /health` | Liveness check para load balancers e orquestradores (Kubernetes, ECS) verificarem se o processo está vivo |
| `GET /metrics` | Endpoint de scraping Prometheus. Serve o texto no formato `text/plain; version=0.0.4` esperado pelo Prometheus |

---

### `src/server.ts` — Bootstrap do processo

```typescript
await app.listen({ port: PORT, host: HOST });
worker.start();
```

**Ordem importa:** o servidor HTTP sobe primeiro, o worker começa depois. Garante que a API já responde ao health check do orquestrador antes de começar a consumir pedidos.

**Graceful shutdown:**
```typescript
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
```

Captura sinais de encerramento do OS. Sequência: para o worker → fecha o Fastify (aguarda requisições em andamento) → encerra o processo. Evita requisições cortadas no meio e pedidos no estado inconsistente `processing` para sempre.

---

## Decisões transversais

### Por que TypeScript `strict: true`?

Ativa todas as verificações rigorosas de tipo: `noImplicitAny`, `strictNullChecks`, `strictFunctionTypes`, `strictPropertyInitialization`. Pega classes inteiras de bugs em tempo de compilação, não em produção.

### Por que `import type` para tipos?

```typescript
import type { Order } from '../types';
```

O `import type` é removido completamente em tempo de compilação — zero overhead no bundle. Também torna explícito que o import é apenas para tipagem estática, melhorando a legibilidade.

### Por que `eslint-config-prettier`?

Desabilita todas as regras do ESLint que conflitam com o Prettier. Sem isso, o ESLint e o Prettier disputariam o estilo de código e um desfaria o trabalho do outro.

### Por que `tsconfig.eslint.json` separado?

O `tsconfig.json` de produção exclui `tests/` do `rootDir` para não compilar código de teste no bundle final. O ESLint precisa analisar os testes também para aplicar `@typescript-eslint/recommended-requiring-type-checking`. O `tsconfig.eslint.json` estende o base e inclui `tests/**/*` — usado exclusivamente pelo ESLint, nunca pelo compilador de produção.

---

## Limitações conhecidas (por design do desafio)

| Limitação | Impacto | Solução em produção |
|---|---|---|
| Storage em memória | Dados perdidos ao reiniciar | PostgreSQL + Prisma |
| Lock single-instance | Não funciona com múltiplos pods | Redis Redlock |
| Worker no mesmo processo | Não escala independentemente | BullMQ / SQS + processo separado |
| Tracing stub | Sem visualização de traces | `@opentelemetry/sdk-node` + Jaeger/Tempo |
| Idempotência tem janela = processo | Chaves expiram ao reiniciar | Persistir chave no banco com TTL de 24h |
| Sem autenticação | Qualquer cliente faz checkout | JWT + middleware de validação |
