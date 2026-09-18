/**
 * Ambiente dos testes e2e.
 *
 * Precisa ser um `setupFiles` (e não código no topo do spec): o TypeScript hoists
 * os `import` acima das atribuições, então `process.env.X = ...` escrito antes do
 * `import { AppModule }` roda DEPOIS dele — e o `validateEnvironment` do
 * ConfigModule falha por variável ausente. Aqui o arquivo é executado antes de
 * qualquer módulo de teste ser carregado.
 */
const base = {
  DB_ADMIN_SETUP_KEY: 'chave-de-setup-para-teste-com-mais-de-32-chars',
  DATABASE_URL: 'postgresql://aga:senha@localhost:5432/aga?schema=public',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(64),
  JWT_ISSUER: 'grupo-aga-api',
  JWT_AUDIENCE: 'grupo-aga-apps',
  FIELD_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
  TRACKING_WEBHOOK_SECRET: 'b'.repeat(32),
  PAYMENT_WEBHOOK_SECRET: 'c'.repeat(32),
  CORS_ORIGINS: 'http://localhost:5176',
  TENANT_SLUG: 'grupo-aga',
};

for (const [key, value] of Object.entries(base)) {
  if (!process.env[key]) process.env[key] = value;
}
