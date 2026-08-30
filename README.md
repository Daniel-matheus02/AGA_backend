# Grupo AGA — Backend Integrado

Backend de referência para três aplicações conectadas:

1. **App do cliente** — crédito, autorização de compras, seguro, rastreador e notificações.
2. **Painel do lojista** — catálogo, intenção de venda, autorização do cliente, transações e repasses.
3. **Painel administrativo** — crédito, clientes, lojistas, marketplace, financeiro, auditoria e rastreamento da frota.

> Regra central: os aplicativos **não se comunicam diretamente entre si**. Todos usam a mesma API e recebem mudanças em tempo real pelo gateway WebSocket. Isso evita regras duplicadas, reduz fraude e mantém a administração como fonte única da verdade.

## Stack

- Node.js 22 + TypeScript
- NestJS 11
- PostgreSQL + Prisma ORM
- Redis Streams + Pub/Sub
- Socket.IO
- Docker Compose

## Recursos já estruturados

- JWT curto e refresh token rotativo com detecção de reutilização.
- Senhas em Argon2id.
- MFA/TOTP opcional e obrigatório para administradores em produção.
- RBAC por perfil e verificação de escopo por tenant, usuário e lojista.
- Validação global com rejeição de campos desconhecidos.
- Idempotência obrigatória em operações financeiras.
- Livro razão de dupla entrada para compras.
- Transactional Outbox para eventos entre os três aplicativos.
- Atualização em tempo real por WebSocket.
- Webhook de rastreamento autenticado com HMAC, timestamp e proteção contra replay.
- Auditoria de operações de escrita sem gravar senha ou token.
- Rate limiting, CORS restrito, Helmet, limites de corpo e IDs de correlação.
- Health checks de banco e Redis.

## Subir localmente

```bash
cp .env.example .env
# Troque todos os CHANGE_ME e ajuste a senha dentro de DATABASE_URL.
docker compose up -d postgres redis
npm install
npm run prisma:generate
npm run prisma:migrate -- --name init
npm run prisma:seed
npm run start:dev
```

Serviços:

- API: `http://localhost:3000/v1`
- Swagger em desenvolvimento: `http://localhost:3000/docs`
- WebSocket: namespace `/events`

## Credenciais locais

As contas são criadas pelo `prisma/seed.ts` usando exclusivamente as variáveis `SEED_*` do `.env`. Não há senha fixa dentro do código. Troque-as no primeiro acesso.

## Fluxos principais

### Compra no marketplace

1. Cliente ou lojista cria uma intenção de compra.
2. Backend calcula valor e taxa usando o produto cadastrado — o preço enviado pelo navegador nunca é confiado.
3. Cliente recebe `order.authorization.requested`.
4. Cliente autoriza com `Idempotency-Key`.
5. PostgreSQL bloqueia/consome o limite em transação serializável.
6. Backend cria razão contábil balanceado e repasse do lojista.
7. Cliente, lojista, financeiro e administrador recebem `order.authorized`.

### Rastreamento

1. Provedor envia localização ao webhook assinado.
2. Backend valida HMAC, timestamp, ID único e limites geográficos.
3. Ponto é armazenado e o último estado do rastreador é atualizado.
4. O painel administrativo e o cliente recebem `tracker.location.updated` em tempo real.
5. Alertas são emitidos para as salas autorizadas.

## Cabeçalhos importantes

```text
Authorization: Bearer <access-token>
Idempotency-Key: <uuid-ou-chave-única-de-16-a-128-caracteres>
X-Request-Id: <opcional>
```

Webhook do rastreador:

```text
X-AGA-Timestamp: <unix-seconds>
X-AGA-Event-Id: <id-único-do-evento>
X-AGA-Signature: sha256=<hmac-hex>
```

A assinatura é calculada sobre:

```text
HMAC_SHA256(TRACKING_WEBHOOK_SECRET, timestamp + "." + rawBody)
```

## Antes de produção

- Integrar provedor real de pagamento, seguro e rastreador.
- Ativar MFA obrigatório para administrador.
- Usar gerenciador de segredos, WAF, TLS e banco privado.
- Executar migrations em pipeline separado.
- Configurar backup com teste de restauração.
- Realizar SAST, DAST, pentest e revisão LGPD.
- Definir política formal de retenção de localização.

Leia também: `ARCHITECTURE.md`, `SECURITY.md` e `docs/INTEGRATION.md`.
