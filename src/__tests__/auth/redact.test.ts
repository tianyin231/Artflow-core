/**
 * Secret redaction tests (G6 support).
 */
import { redactSecrets, redactString, containsSentinel } from '../../auth/redact';

const S1 = ['SENTINEL', '_rt_', '7f3a9c'].join('');
const S2 = ['SENTINEL', '_at_', '2b8e41'].join('');
const S3 = ['SENTINEL', '_secret_', 'c0ffee'].join('');

describe('redactSecrets', () => {
  it('redacts token-like object keys', () => {
    const out = redactSecrets({
      refreshToken: S1,
      accessToken: S2,
      clientSecret: S3,
      Authorization: `Bearer ${S2}`,
      title: 'hello',
    }) as Record<string, string>;
    expect(out.refreshToken).toBe('***');
    expect(out.accessToken).toBe('***');
    expect(out.clientSecret).toBe('***');
    expect(out.title).toBe('hello');
  });

  it('redacts query/body strings', () => {
    const s = redactString(`refresh_token=${S1}&x=1 access_token=${S2}`);
    expect(s).not.toContain(S1);
    expect(s).not.toContain(S2);
  });

  it('detects sentinels', () => {
    expect(containsSentinel(`x ${S1} y`, [S1, S2, S3])).toBe(true);
    expect(containsSentinel('clean', [S1, S2, S3])).toBe(false);
  });
});
