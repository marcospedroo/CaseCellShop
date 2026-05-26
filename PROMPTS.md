# PROMPTS.md — Registro de uso de IA

Documento com todos os prompts utilizados para auxiliar no desenvolvimento deste desafio técnico, conforme solicitado no enunciado. Ferramenta utilizada: **Cursor com Claude Sonnet 4.5**.

---

## Como a IA foi utilizada

O uso de IA neste projeto seguiu a orientação do desafio: **direcionamento crítico, revisão de respostas e registro dos prompts relevantes**. A IA não foi usada de forma passiva — cada prompt teve intenção técnica específica e o resultado foi revisado, ajustado e integrado de forma consciente.

---

## Prompts por área

### 1. Criação do agente especialista (meta-prompt)

> **Contexto:** Antes de iniciar a implementação, foi criado um subagente no Cursor com instruções especializadas para garantir consistência nas decisões técnicas ao longo de toda a implementação.

```
Agente especialista em desenvolvimento de software com node.js e typescript.
Usará as melhores práticas de desenvolvimento e segurança da informação.
Logs estruturados incluem correlationId/requestId e orderId quando existir.
Cobertura de testes mínima de 80% e cobrem regra de negócio, cache e concorrência.
```

**Por que:** Criar um agente com contexto persistente garantiu que cada decisão de implementação seguisse os mesmos padrões de qualidade, observabilidade e segurança, sem repetir instruções a cada interação.

---

### 2. Implementação do serviço completo

> **Contexto:** Prompt principal para geração da estrutura completa do backend.

```
use o agente nodejs-typescript-expert para:

Implemente um pequeno serviço backend para a CaseCellShop que exponha catálogo de produtos
com cache, inicie um checkout assíncrono e permita consultar o status do pedido.
Use dados em memória ou serviços locais/simulados se preferir. O objetivo é demonstrar
raciocínio sênior de backend, cache, observabilidade e consistência, não construir um
e-commerce completo.

O que esperamos observar na entrega:
- GET /products retorna produtos e usa cache com TTL ou estratégia equivalente.
- POST /checkout inicia uma compra e retorna 202 Accepted com orderId/status.
- GET /orders/{orderId}/status permite acompanhar o processamento.
- Há OpenAPI ou contrato equivalente com schemas de sucesso e erro.
- Logs estruturados incluem correlationId/requestId e orderId quando existir.
- Há métricas relevantes, incluindo cache hit/miss e processamento de checkout/fila.
- Há trace/span real ou stub justificado ligando request, cache, repo fake e worker.
- README inclui exemplo de dashboard, alerta ou runbook para Datadog ou equivalente.
- Checkout evita venda além do estoque usando atomic update, lock, reserva ou simulação coerente.
- Há idempotência simples para retries ou duplo clique e worker simulando envio ao ERP.
- Testes automatizados cobrem regra de negócio, cache e concorrência.
```

**Resultado:** Gerou toda a estrutura de pastas, 91 testes com cobertura de 96% de statements, todos os endpoints, observabilidade completa e README.

---

### 3. Arquitetura e contexto de propagação

> **Contexto:** Decisão de design sobre como propagar `correlationId` e `requestId` sem poluir assinaturas de função.

```
Design a Node.js/TypeScript e-commerce checkout backend with in-memory storage,
structured pino logging with correlationId/requestId/orderId via AsyncLocalStorage,
Prometheus metrics, and a mutex-based stock lock to prevent overselling.
```

**Decisão técnica:** `AsyncLocalStorage` foi escolhido sobre passagem explícita de contexto por parâmetro porque mantém as assinaturas de services e repositories limpas — qualquer camada acessa os IDs de rastreamento sem ser acoplada ao contrato de observabilidade.

---

### 4. Mutex de estoque por promise chaining

> **Contexto:** Entender e implementar controle de concorrência sem bloquear o event loop.

```
Implement a promise-chain mutex for per-product stock locking in Node.js
that serializes concurrent checkouts without blocking the event loop.
```

**Decisão técnica:** Um flag booleano simples (`isLocked = true`) não funciona em Node.js porque o event loop pode intercalar chamadas `async` entre o check e o decrement. O promise chaining serializa as operações de forma cooperativa: cada adquirente espera o anterior terminar via `await current`, sem busy-wait.

---

### 5. Idempotência de checkout

> **Contexto:** Garantir que retries, duplos cliques e reprocessamento não criem pedidos duplicados.

```
Implement idempotency for a checkout endpoint using either a header key or
auto-generated payload hash, with O(1) lookup via secondary index.
```

**Decisão técnica:** Dois níveis de idempotência foram implementados:
1. **In-flight map**: chamadas simultâneas com a mesma chave compartilham a mesma Promise — evita duplicatas durante o processamento
2. **Índice secundário no repositório**: chave persiste após conclusão — evita duplicatas em retries posteriores

---

### 6. Estrutura de testes (negócio, cache e concorrência)

> **Contexto:** Garantir cobertura mínima de 80% nos três eixos exigidos pelo desafio.

```
Write Jest tests covering: cache hit/miss/TTL/fallback, concurrent checkouts with
stock=1, idempotency under parallel calls, and order status consistency.
```

**Resultado:** 12 suítes de teste, 91 casos, cobertura de 96.37% de statements e 85.33% de branches. Os testes de concorrência usam `Promise.all` com múltiplos checkouts simultâneos para o mesmo produto com `stock = 1`, garantindo que exatamente 1 sucesso ocorra.

---

### 7. Schemas OpenAPI para Fastify

> **Contexto:** Gerar documentação e validação de entrada automaticamente a partir de schemas JSON.

```
Generate Fastify JSON Schema definitions for /products, /checkout, and
/orders/:orderId/status with success and error response schemas.
```

**Decisão técnica:** O Fastify valida os payloads de entrada contra os schemas em tempo de execução — rejeita requests malformados com 400 antes de chegar às services. O `@fastify/swagger` usa os mesmos schemas para gerar o OpenAPI sem duplicação.

---

### 8. Worker com retry e restauração de estoque

> **Contexto:** Simular processamento assíncrono resiliente com comportamento de falha configurável.

```
Implement an order processing worker with configurable failure rate, retry count
limit, and stock restore on permanent failure.
```

**Decisão técnica:** A taxa de falha (`10%`) e o máximo de retries (`3`) são injetáveis via construtor — permitindo controlar o comportamento nos testes sem depender de aleatoriedade. Em falha permanente, o estoque é restaurado para evitar que produtos fiquem "presos" em pedidos que nunca completarão.

---

### 9. Configuração de lint e formatação

> **Contexto:** Garantir qualidade de código com ESLint e Prettier integrados.

```
adicione ferramentas de lint ao agente @nodejs-typescript-expert e garanta que
está tudo passando corretamente.
```

**Resultado:** ESLint 8 + `@typescript-eslint/recommended-requiring-type-checking` para `src/`, Prettier com `endOfLine: lf`, `tsconfig.eslint.json` separado para não incluir tests no build de produção. Zero erros de lint.

---

### 10. Explicação da arquitetura

> **Contexto:** Documentar cada decisão de design de forma rastreável.

```
explique o projeto todo. Cada função e por que foi utilizada.
```

**Resultado:** Documento `ARCHITECTURE.md` com explicação de cada módulo, padrão de design e decisão técnica, incluindo diagramas ASCII do fluxo de requisição.

---

## Prompts que NÃO foram usados (e por quê)

| Abordagem descartada | Motivo |
|---|---|
| "Gere testes de carga com k6" | Foge do escopo do desafio; concorrência é testada com `Promise.all` unitário |
| "Implemente Redis como cache" | Desafio permite dados em memória; Redis adicionaria dependência de infraestrutura sem agregar ao objetivo avaliado |
| "Integre OpenTelemetry real com Jaeger" | Requer infraestrutura adicional; o stub demonstra o mesmo contrato de observabilidade |
| "Adicione autenticação JWT" | Explicitamente fora do escopo pelo enunciado |

---

## Avaliação crítica do uso de IA

**O que funcionou bem:**
- Usar um agente com prompt especializado garantiu consistência de padrões em todos os arquivos gerados
- A IA gerou corretamente o promise-chain mutex — um padrão não trivial — após prompt preciso
- Os testes gerados cobriram os três eixos exigidos (negócio, cache, concorrência) sem necessidade de revisão estrutural

**O que precisou de correção manual:**
- O script de lint inicial não funcionava no Windows por incompatibilidade de `&&` no PowerShell — ajustado manualmente
- O `tsconfig.eslint.json` precisou de iteração para resolver conflito de `rootDir` entre `src/` e `tests/`
- O `no-var-requires` no `logger.test.ts` foi um falso positivo — o padrão `require()` após `jest.resetModules()` é legítimo e foi corretamente suprimido via override
