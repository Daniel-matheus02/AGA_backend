# Segurança — Grupo AGA

Este repositório entrega uma base defensiva, mas não substitui revisão independente, pentest nem homologação dos provedores financeiros.

## Controles implementados

### Identidade e sessão

- Argon2id com custo de memória para senhas.
- Access token de curta duração.
- Refresh token opaco no formato `sessionId.secret`.
- Apenas o hash do segredo é armazenado.
- Rotação a cada refresh.
- Detecção de reutilização: ao reutilizar token revogado, todas as sessões do usuário são encerradas.
- Bloqueio temporário após cinco falhas de login.
- MFA/TOTP disponível; em produção, `ADMIN_MFA_REQUIRED=true`.
- Cada requisição autenticada valida se a sessão e o usuário continuam ativos.

### Autorização

- RBAC: `CLIENT`, `MERCHANT`, `ADMIN`, `SUPPORT`, `FINANCE`, `TRACKING_OPERATOR`.
- Escopo obrigatório por `tenantId`.
- Cliente só acessa dados próprios.
- Lojista só opera seu `merchantId`.
- Operações críticas exigem papel específico.
- As salas WebSocket são definidas pelo servidor, nunca pelo cliente.

### Integridade financeira

- Valores em `BigInt`/centavos; nada de ponto flutuante.
- Preço e taxa obtidos no servidor.
- Idempotência em criação e aprovação de crédito, pedidos e autorizações.
- Transação serializável para consumir limite.
- Razão contábil de dupla entrada.
- Outbox no mesmo commit da operação.

### API e rede

- CORS por allowlist.
- Helmet.
- Rate limit global; em produção, adicionar limites específicos para login e webhook no WAF.
- Limite de payload.
- Validação com whitelist e rejeição de campos extras.
- Respostas de erro padronizadas sem stack trace.
- Request ID para rastreabilidade.
- Containers sem root, filesystem somente leitura, capacidades removidas e `no-new-privileges`.

### Webhooks de rastreamento

- HMAC-SHA-256 sobre corpo bruto.
- Comparação em tempo constante.
- Janela máxima de cinco minutos.
- ID único por evento para bloquear replay.
- Latitude, longitude, velocidade, bateria e data validadas.

### Dados e auditoria

- CPF e CNPJ são representados por hash para busca exata sem armazenamento aberto nesta base.
- Segredos de MFA são cifrados com AES-256-GCM.
- Auditoria registra autor, rota, IP, user-agent, request ID e hash do corpo sanitizado.
- Senhas, tokens e códigos TOTP são removidos antes da auditoria.

## Requisitos de produção

- TLS 1.2+ até o balanceador e TLS interno quando possível.
- PostgreSQL e Redis sem exposição pública.
- Segredos em Vault, AWS Secrets Manager, GCP Secret Manager, Azure Key Vault ou equivalente.
- Chaves diferentes para desenvolvimento, homologação e produção.
- Rotação de chaves e plano de revogação.
- Backup criptografado, PITR e teste periódico de restauração.
- SIEM e alertas para login anômalo, reutilização de refresh, falhas HMAC e mudança de papel.
- WAF e proteção contra abuso por IP, conta e device fingerprint.
- SAST, dependency scanning, secret scanning, DAST e pentest.
- Revisão LGPD: base legal, minimização, retenção e atendimento ao titular.

## Localização é dado sensível operacional

Acesso a histórico de localização deve ser limitado a necessidade legítima, registrado em auditoria e sujeito a retenção curta. Evite exibir rastreamento completo para perfis de suporte que não precisem disso.

## Não implementado propositalmente

Comando remoto de bloqueio/imobilização de veículo não está incluído. Esse recurso exige análise de segurança física, regras do fornecedor, trilha de dupla aprovação e restrições por velocidade/ignição. Não deve ser tratado como um simples botão administrativo.

## Reporte

Falhas encontradas devem ser tratadas de forma privada pelo processo interno de segurança. Não coloque credenciais, dados pessoais ou detalhes exploráveis em issues públicas.
