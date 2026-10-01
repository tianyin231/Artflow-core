/**
 * SecretStore tests (T6).
 */
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretStore } from '../../secrets/SecretStore';

const SENTINEL = ['SENTINEL', '_secret_', 'c0ffee'].join('');

describe('SecretStore', () => {
  it('encrypt/decrypt roundtrip', () => {
    const store = new SecretStore(Buffer.alloc(32, 7));
    store.set('k', SENTINEL);
    expect(store.get('k')).toBe(SENTINEL);
  });

  it('tampered ciphertext fails to decrypt', () => {
    const store = new SecretStore(Buffer.alloc(32, 7));
    store.set('k', SENTINEL);
    const rows = store.exportRows();
    const raw = Buffer.from(rows[0].ciphertext, 'base64');
    raw[0] = raw[0] ^ 0xff;
    rows[0].ciphertext = raw.toString('base64');
    const store2 = new SecretStore(Buffer.alloc(32, 7));
    store2.importRows(rows);
    expect(() => store2.get('k')).toThrow();
  });

  it('key file is 0600', () => {
    const dir = mkdtempSync(join(tmpdir(), 'artflow-sec-'));
    const keyFile = join(dir, 'secret.key');
    new SecretStore(undefined, keyFile);
    const mode = statSync(keyFile).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('peek never returns plaintext', () => {
    const store = new SecretStore(Buffer.alloc(32, 1));
    store.set('token', 'abcdef123456');
    const peek = store.peek('token');
    expect(peek.configured).toBe(true);
    expect(peek.last4).toBe('****3456');
    expect(JSON.stringify(peek)).not.toContain('abcdef');
  });

  it('ciphertext rows contain no plaintext', () => {
    const store = new SecretStore(Buffer.alloc(32, 2));
    store.set('t', SENTINEL);
    const rows = store.exportRows();
    expect(rows[0].ciphertext).not.toContain(SENTINEL);
  });
});
