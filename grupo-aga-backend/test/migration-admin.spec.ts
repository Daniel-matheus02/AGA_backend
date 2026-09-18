/**
 * A senha do usuário criado por migration tem que funcionar no login real.
 *
 * O hash em `prisma/migrations/20260913000000_seed_admin_adminemunah/migration.sql`
 * tem que ser argon2id: o login do backend chama `argon2.verify`, e um hash
 * bcrypt faz `argon2.verify` devolver `false` SEM erro — criando um usuário que
 * nunca consegue entrar. A checagem 1 é a que protege contra isso.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as argon2 from 'argon2';

const MIGRATION = join(__dirname, '..', 'prisma', 'migrations', '20260913000000_seed_admin_adminemunah', 'migration.sql');
const PASSWORD = 'Admin3munah!@#';
const EMAIL = 'adminemunah@gmail.com';

const sql = readFileSync(MIGRATION, 'utf8');

/** Extrai o hash de senha literal do arquivo de migration. */
function hashFromMigration(): string {
  const match = sql.match(/'(\$argon2id\$[^']+)'/);
  if (!match) throw new Error('não encontrei um hash argon2id na migration');
  return match[1];
}

describe('migration do admin inicial', () => {
  const hash = hashFromMigration();

  it('a migration cria o e-mail pedido e usa a role ADMIN', () => {
    expect(sql).toContain(EMAIL);
    expect(sql).toContain("'ADMIN'::\"Role\"");
    // ADMIN é o que dá acesso ao painel /v1/db-admin (aceita ADMIN e SUPPORT).
    expect(sql).not.toContain("'CLIENT'::\"Role\"");
  });

  it('a migration é idempotente (ON CONFLICT nas duas inserções)', () => {
    expect(sql).toContain('ON CONFLICT ("slug") DO NOTHING');
    expect(sql).toContain('ON CONFLICT ("tenantId", "email") DO NOTHING');
  });

  it('a migration não sobrescreve a senha de um usuário existente', () => {
    // Sem DO UPDATE: um deploy não deve desfazer uma troca de senha do painel.
    expect(sql).not.toMatch(/ON CONFLICT[\s\S]{0,80}DO UPDATE/);
  });

  it('o hash da migration é argon2id (não bcrypt)', () => {
    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  it('o hash da migration corresponde à senha documentada', async () => {
    // argon2.verify com hash bcrypt: é exatamente o que o login chama.
    await expect(argon2.verify(hash, PASSWORD)).resolves.toBe(true);
  });

  it('rejeita uma senha errada contra o hash da migration', async () => {
    await expect(argon2.verify(hash, 'senha-errada-qualquer')).resolves.toBe(false);
  });

  it('um hash argon2id recém-gerado também verifica (parâmetros do backend)', async () => {
    const argonHash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
    expect(argonHash.startsWith('$argon2id$')).toBe(true);
    await expect(argon2.verify(argonHash, PASSWORD)).resolves.toBe(true);
  });
});
