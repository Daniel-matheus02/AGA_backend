import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

@Injectable()
export class CryptoService {
  private readonly key: Buffer;
  constructor(config: ConfigService) { this.key = Buffer.from(config.getOrThrow<string>('FIELD_ENCRYPTION_KEY_BASE64'), 'base64'); }

  hash(value: string): string { return createHash('sha256').update(value.trim().toLowerCase()).digest('hex'); }
  bodyHash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex'); }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ciphertext]).toString('base64url');
  }

  decrypt(encoded: string): string {
    const data = Buffer.from(encoded, 'base64url');
    const iv = data.subarray(0, 12), tag = data.subarray(12, 28), ciphertext = data.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  safeEqualHex(a: string, b: string): boolean {
    if (!/^[a-f0-9]{64}$/i.test(a) || !/^[a-f0-9]{64}$/i.test(b)) return false;
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  }
}
