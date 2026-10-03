import { definePlugin, validateManifest, isDomainAllowed } from '../../plugins-sdk';

describe('plugin SDK', () => {
  it('definePlugin returns impl', () => {
    const p = definePlugin({ publish: () => 'ok' });
    expect(p.publish()).toBe('ok');
  });
  it('validates manifest', () => {
    expect(validateManifest({ id: 'a', version: '1', apiVersion: '1', entry: 'x.js', permissions: {} }).ok).toBe(true);
    expect(validateManifest({}).ok).toBe(false);
  });
  it('enforces network allowlist', () => {
    expect(isDomainAllowed('https://dav.example.com/x', ['example.com'])).toBe(true);
    expect(isDomainAllowed('https://evil.com/x', ['example.com'])).toBe(false);
  });

  it.each([
    [], null,
    { id: 123, version: true, apiVersion: {}, entry: [] },
    { id: 'a', version: '1', apiVersion: '1', entry: 'x.js', permissions: { network: '*' } },
    { id: 'a', version: '1', apiVersion: '1', entry: 'x.js', permissions: { network: ['https://example.com'] } },
    { id: 'a', version: '1', apiVersion: '1', entry: 'x.js', permissions: { fs: [42] } },
  ])('rejects malformed manifests and permission lists %#', (manifest) => {
    expect(validateManifest(manifest).ok).toBe(false);
  });

  it('normalizes DNS names and rejects unrelated suffixes and non-network URLs', () => {
    expect(isDomainAllowed('https://DAV.example.com./x', ['EXAMPLE.COM'])).toBe(true);
    expect(isDomainAllowed('https://example.com.evil.com/x', ['example.com'])).toBe(false);
    expect(isDomainAllowed('https://evil-example.com/x', ['example.com'])).toBe(false);
    expect(isDomainAllowed('file://example.com/x', ['example.com'])).toBe(false);
    expect(isDomainAllowed('https://evil.com./x', [''])).toBe(false);
    expect(isDomainAllowed('https://127.0.0.1/x', ['127.0.0.1'])).toBe(true);
  });
});
