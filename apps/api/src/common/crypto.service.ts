import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // recommended IV length for GCM

// Secrets stored here (job-platform passwords, GitHub PAT with repo access)
// are meaningfully more sensitive than the plain API keys in `Settings` —
// they grant login to a real external account, not just quota on a service
// key. Fails fast at startup rather than silently persisting plaintext or
// throwing only when a candidature is first attempted.
@Injectable()
export class CryptoService implements OnModuleInit {
  private readonly logger = new Logger(CryptoService.name);
  private key!: Buffer;

  onModuleInit() {
    const raw = process.env.CREDENTIALS_ENCRYPTION_KEY;
    if (!raw) {
      throw new Error(
        'CREDENTIALS_ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32` and add it to .env.local.',
      );
    }

    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) {
      throw new Error(
        `CREDENTIALS_ENCRYPTION_KEY must decode to 32 bytes (got ${key.length}). Generate one with \`openssl rand -base64 32\`.`,
      );
    }

    this.key = key;
  }

  // Output format: base64(iv) + '.' + base64(authTag) + '.' + base64(ciphertext)
  encrypt(plainText: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return `${iv.toString('base64')}.${authTag.toString('base64')}.${ciphertext.toString('base64')}`;
  }

  decrypt(payload: string): string {
    const [ivB64, authTagB64, ciphertextB64] = payload.split('.');
    if (!ivB64 || !authTagB64 || !ciphertextB64) {
      throw new Error('Malformed encrypted payload');
    }

    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));

    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextB64, 'base64')),
      decipher.final(),
    ]);

    return plaintext.toString('utf8');
  }
}
