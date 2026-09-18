-- Usuário administrador inicial: adminemunah@gmail.com
--
-- Este projeto não guarda nada em `prisma/seed.ts` (o seed roda apenas com
-- `prisma db seed`, que não faz parte do deploy). Por isso o acesso inicial é
-- criado por MIGRATION: `prisma migrate deploy` roda no start do container
-- (ver Dockerfile) e garante que quem clonar o repositório já consiga entrar,
-- sem precisar de SEED_ADMIN_* no ambiente.
--
-- Role = 'ADMIN': é o que permite entrar no painel de administração do banco
-- (`frontend_user_manager` → /v1/db-admin), que aceita apenas ADMIN e SUPPORT.
--
-- Idempotente de propósito: pode rodar várias vezes sem duplicar nada.
--   * o tenant é localizado pelo slug (única coluna única dele);
--   * o usuário é localizado por (tenantId, email) — chave única
--     User_tenantId_email_key;
--   * se o usuário já existir, a senha NÃO é sobrescrita (um deploy não deve
--     desfazer uma troca de senha feita no painel).
--
-- A senha abaixo é um hash **argon2id** de "Admin3munah!@#", gerado com os
-- mesmos parâmetros do backend (m=65536, t=3, p=1 — igual ao seed e ao
-- AdminService). Tem que ser argon2id: o login chama `argon2.verify`, e
-- `argon2.verify` devolve `false` (sem erro) para um hash bcrypt — ou seja, um
-- hash bcrypt aqui criaria um usuário que nunca consegue entrar.
-- Para gerar outro: `npx tsx scripts/hash-password.ts '<senha>'`.
-- Troque a senha pelo painel após o primeiro acesso.

-- 1. Tenant padrão (o mesmo slug usado pelo seed e pelo TENANT_SLUG do backend).
INSERT INTO "Tenant" ("id", "name", "slug", "active", "createdAt", "updatedAt")
VALUES (
  '11111111-1111-4111-8111-111111111111',
  'Grupo AGA',
  'grupo-aga',
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("slug") DO NOTHING;

-- 2. Usuário ADMIN. O id é determinístico para que o vínculo com o tenant seja
--    resolvido pelo slug, sem depender de subselect.
INSERT INTO "User" (
  "id", "tenantId", "merchantId", "role", "status", "name", "email",
  "cpfHash", "passwordHash", "failedLoginCount", "lockedUntil",
  "mfaEnabled", "mfaSecretEncrypted", "createdAt", "updatedAt"
)
SELECT
  '22222222-2222-4222-8222-222222222222',
  t."id",
  NULL,
  'ADMIN'::"Role",
  'ACTIVE'::"UserStatus",
  'Administrador AGA',
  'adminemunah@gmail.com',
  NULL,
  '$argon2id$v=19$m=65536,t=3,p=1$NcqeEw4hONOcGRenSVirtA$VgslTKcXg+XGe1UdkZb1UWG8H7thwfd60pCWLeqiIFo',
  0,
  NULL,
  false,
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Tenant" t
WHERE t."slug" = 'grupo-aga'
ON CONFLICT ("tenantId", "email") DO NOTHING;
