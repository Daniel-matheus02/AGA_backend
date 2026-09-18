/**
 * Gera o hash argon2id da senha do admin inicial, no MESMO formato do backend
 * (argon2id, memoryCost 65536, timeCost 3, parallelism 1 — igual ao seed e ao
 * AdminService). Imprime o literal pronto para colar na migration.
 *
 * Uso: npx tsx scripts/hash-password.ts 'Admin3munah!@#'
 */
import * as argon2 from 'argon2';

const PASSWORD_HASH_OPTIONS = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;

async function main() {
  const password = process.argv[2];
  if (!password) {
    console.error("Uso: npx tsx scripts/hash-password.ts '<senha>'");
    process.exit(1);
  }
  const hash = await argon2.hash(password, PASSWORD_HASH_OPTIONS);
  const verified = await argon2.verify(hash, password);
  if (!verified) {
    console.error('Hash gerado não verifica — abortando.');
    process.exit(1);
  }
  console.log(hash);
  console.error(`# verificado: ${verified} | prefixo: ${hash.slice(0, 10)}`);
}

void main();
