import { readFileSync } from 'node:fs';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  TENANT_SLUG: z.string().min(2).default('grupo-aga'),
  DATABASE_URL: z.string().min(20),
  REDIS_URL: z.string().min(10),
  JWT_ACCESS_SECRET: z.string().min(64),
  JWT_ISSUER: z.string().min(3),
  JWT_AUDIENCE: z.string().min(3),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(300).max(3600).default(600),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  FIELD_ENCRYPTION_KEY_BASE64: z.string().min(43),
  TRACKING_WEBHOOK_SECRET: z.string().min(32),
  PAYMENT_WEBHOOK_SECRET: z.string().min(32),
  PAYMENT_PROVIDER_MODE: z.enum(['sandbox','external']).default('sandbox'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  ADMIN_MFA_REQUIRED: z.coerce.boolean().default(false),
});

export type Environment = z.infer<typeof schema>;

export function validateEnvironment(config: Record<string, unknown>): Environment {
  const resolved: Record<string, unknown> = { ...config };
  for (const key of ['DATABASE_URL','REDIS_URL','JWT_ACCESS_SECRET','FIELD_ENCRYPTION_KEY_BASE64','TRACKING_WEBHOOK_SECRET','PAYMENT_WEBHOOK_SECRET']) {
    const file = resolved[`${key}_FILE`];
    if ((!resolved[key] || String(resolved[key]).length === 0) && typeof file === 'string' && file) {
      resolved[key] = readFileSync(file, 'utf8').trim();
    }
  }
  const parsed = schema.safeParse(resolved);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const key = Buffer.from(parsed.data.FIELD_ENCRYPTION_KEY_BASE64, 'base64');
  if (key.length !== 32) throw new Error('FIELD_ENCRYPTION_KEY_BASE64 must decode to exactly 32 bytes');
  return parsed.data;
}
