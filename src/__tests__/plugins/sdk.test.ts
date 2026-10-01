import { definePlugin, validateManifest, isDomainAllowed } from '../../plugins-sdk';

describe('plugin SDK', () => {
  it('definePlugin returns impl', () => {
    const p = definePlugin({ publish: () => 'ok' });
    expect(p.publish()).toBe('ok');
  });
  it('validates manifest', () => {
    expect(validateManifest({ id: 'a', version: '1', apiVersion: '1', entry: 'x.js' }).ok).toBe(true);
    expect(validateManifest({}).ok).toBe(false);
  });
  it('enforces network allowlist', () => {
    expect(isDomainAllowed('https://dav.example.com/x', ['example.com'])).toBe(true);
    expect(isDomainAllowed('https://evil.com/x', ['example.com'])).toBe(false);
  });
});
