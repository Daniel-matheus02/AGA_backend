-- Remoção do MFA do produto.
--
-- O backend não exige mais segundo fator em nenhum fluxo: `/auth/login` e o
-- login do painel (`/v1/db-admin/auth/login`) autenticam apenas com senha.
-- Sem consumidor no código, as duas colunas viraram estado morto — e
-- `mfaSecretEncrypted` guardava segredo TOTP cifrado que ninguém mais lia.
--
-- ATENÇÃO — migration irreversível: o DROP COLUMN descarta os segredos TOTP
-- gravados. Não há rollback de dados; para voltar atrás seria preciso reativar
-- o MFA e re-registrar o segundo fator de cada conta.
--
-- Idempotente via IF EXISTS, para não quebrar em banco onde a coluna já tenha
-- sido removida manualmente.
ALTER TABLE "User"
  DROP COLUMN IF EXISTS "mfaEnabled",
  DROP COLUMN IF EXISTS "mfaSecretEncrypted";
