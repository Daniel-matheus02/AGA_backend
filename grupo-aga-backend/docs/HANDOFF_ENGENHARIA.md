# Handoff para Engenharia de Software

## O que foi entregue

- API modular em NestJS/TypeScript.
- Modelo PostgreSQL em Prisma.
- Redis Streams + WebSocket para comunicação em tempo real.
- Três perfis: cliente, lojista e administrativo.
- Domínios: autenticação, crédito, marketplace, pagamentos diários, seguro, rastreamento, notificações, repasses e auditoria.
- Docker local e modelo de implantação com secrets.
- SDK TypeScript de integração.

## Decisões que não devem ser quebradas

1. Os três aplicativos não acessam o banco e não chamam uns aos outros diretamente.
2. Toda regra financeira vive no backend.
3. Preço, taxa, limite e status são calculados no servidor.
4. Valores são inteiros em centavos.
5. Operações financeiras usam `Idempotency-Key`.
6. O cliente precisa autorizar compras iniciadas pelo lojista.
7. Rastreamento e pagamentos só entram por webhooks assinados.
8. Eventos podem ser entregues mais de uma vez; consumidores deduplicam por `event.id`.
9. Admin em produção usa MFA.
10. Histórico de localização tem retenção limitada e acesso auditado.

## Integrações externas pendentes

- Gateway de pagamento/PIX.
- Seguradora ou administradora da proteção.
- Plataforma de rastreamento GPS.
- Serviço de SMS/e-mail/push.
- KYC/validação documental e antifraude.

Cada integração deve entrar por uma interface/adaptador. Não espalhar SDK de fornecedor dentro dos módulos de negócio.

## Critérios de aceite — MVP

### Autenticação

- Login, refresh rotativo, logout e MFA funcionam.
- Refresh reutilizado revoga todas as sessões do usuário.
- Perfis não conseguem acessar rotas de outro perfil.

### Crédito

- Cliente solicita crédito.
- Admin aprova/rejeita.
- Aprovação cria conta, cronograma diário e solicitação de seguro.
- Limite nunca fica abaixo de saldo comprometido.

### Marketplace

- Lojista cadastra produto.
- Lojista ou cliente cria pedido.
- Cliente autoriza.
- Autorização concorrente não gasta limite duas vezes.
- Lançamentos do razão somam zero.
- Repasse é criado somente após autorização.

### Pagamento

- Intenção é idempotente.
- Webhook inválido/repetido não altera pagamento duas vezes.
- Confirmação aparece em cliente, financeiro e admin em tempo real.

### Rastreamento

- HMAC, timestamp e event ID são validados.
- Cliente vê somente a própria moto.
- Admin/operador vê a frota do tenant.
- Atualização aparece por WebSocket.

### Segurança e observabilidade

- CORS restrito.
- Rate limit ativo.
- Logs têm `X-Request-Id`.
- Auditoria não armazena senhas/tokens.
- Segredos não aparecem na imagem Docker.
- Health checks falham quando PostgreSQL ou Redis falham.

## Testes obrigatórios antes de produção

- Unitários de cálculo e autorização.
- Integração com PostgreSQL real.
- E2E de cada perfil.
- Concorrência em autorização de pedidos.
- Replay de webhook.
- Reutilização de refresh token.
- Pentest externo.
- Teste de restauração de backup.
- Teste de carga em telemetria e WebSocket.

## Ordem recomendada de trabalho

1. Gerar migration inicial e aplicar `docs/sql/hardening.sql` dentro da migration revisada.
2. Configurar CI/CD e lockfile.
3. Implementar gateway de pagamento.
4. Implementar provedor GPS.
5. Implementar seguradora.
6. Conectar o HTML aos endpoints pelo SDK.
7. Criar testes E2E e carga.
8. Homologar segurança e LGPD.
