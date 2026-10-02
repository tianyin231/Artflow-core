/**
 * AES-256-GCM secret store. Key file 0600.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface SecretRecord {
  id: string;
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  updatedAt: string;
}

export class SecretStore {
  private readonly key: Buffer;
  private readonly map = new Map<string, SecretRecord>();

  constructor(key?: Buffer, keyFilePath?: string) {
    if (key) {
      this.key = key;
      return;
    }
    const envKey = process.env.ARTFLOW_SECRET_KEY;
    if (envKey) {
      this.key = Buffer.from(envKey, 'base64');
      return;
    }
    const file =
      keyFilePath ||
      process.env.ARTFLOW_SECRET_KEY_FILE ||
      join(process.env.ARTFLOW_DATA_DIR || '.', 'secret.key');
    if (existsSync(file)) {
      this.key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
      return;
    }
    mkdirSync(dirname(file), { recursive: true });
    const generated = randomBytes(32);
    writeFileSync(file, generated.toString('base64'), { mode: 0o600 });
    chmodSync(file, 0o600);
    this.key = generated;
  }

  set(id: string, plaintext: string): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    this.map.set(id, {
      id,
      ciphertext,
      iv,
      tag,
      updatedAt: new Date().toISOString(),
    });
  }

  get(id: string): string | undefined {
    const rec = this.map.get(id);
    if (!rec) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', this.key, rec.iv);
    decipher.setAuthTag(rec.tag);
    return Buffer.concat([decipher.update(rec.ciphertext), decipher.final()]).toString('utf8');
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  delete(id: string): void {
    this.map.delete(id);
  }

  /** Safe view for APIs — never returns plaintext. */
  peek(id: string): { configured: boolean; last4?: string } {
    const v = this.get(id);
    if (!v) return { configured: false };
    return { configured: true, last4: `****${v.slice(-4)}` };
  }

  /** Serialize ciphertext rows (for sqlite persistence). */
  exportRows(): { id: string; ciphertext: string; iv: string; tag: string; updatedAt: string }[] {
    return [...this.map.values()].map((r) => ({
      id: r.id,
      ciphertext: r.ciphertext.toString('base64'),
      iv: r.iv.toString('base64'),
      tag: r.tag.toString('base64'),
      updatedAt: r.updatedAt,
    }));
  }

  importRows(rows: { id: string; ciphertext: string; iv: string; tag: string; updatedAt: string }[]): void {
    for (const r of rows) {
      this.map.set(r.id, {
        id: r.id,
        ciphertext: Buffer.from(r.ciphertext, 'base64'),
        iv: Buffer.from(r.iv, 'base64'),
        tag: Buffer.from(r.tag, 'base64'),
        updatedAt: r.updatedAt,
      });
    }
  }
}
