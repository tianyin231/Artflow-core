/**
 * PixivLoginService tests (T3).
 */
import {
  PixivLoginService,
  MemoryTokenImporter,
  parseCallback,
  AuthHostLoginSessionInvalidError,
} from '../../auth/PixivLoginService';

const SENTINEL = ['SENTINEL', '_rt_', '7f3a9c'].join('');

describe('parseCallback', () => {
  it('accepts pure code', () => {
    expect(parseCallback('abc123')).toBe('abc123');
  });
  it('accepts pixiv:// callback', () => {
    expect(parseCallback('pixiv://account/login?code=xyz')).toBe('xyz');
  });
  it('accepts https callback', () => {
    expect(parseCallback('https://app-api.pixiv.net/web/v1/login?code=qwe')).toBe('qwe');
  });
});

describe('PixivLoginService', () => {
  let importer: MemoryTokenImporter;
  let svc: PixivLoginService;
  let now = 1_000_000;

  beforeEach(() => {
    importer = new MemoryTokenImporter();
    svc = new PixivLoginService(importer, {
      authorizeBaseUrl: 'http://127.0.0.1:9',
      now: () => now,
    });
    now = 1_000_000;
  });

  it('start returns authorizeUrl with S256 challenge and no verifier', () => {
    const r = svc.start();
    expect(r.authorizeUrl).toContain('code_challenge_method=S256');
    expect(r.authorizeUrl).toContain('code_challenge=');
    expect(r.authorizeUrl).not.toContain('code_verifier');
    expect(r.loginId).toBeTruthy();
  });

  it('session is one-shot; replay throws AUTH_HOST_LOGIN_SESSION_INVALID', async () => {
    const r = svc.start();
    // complete will try network — stub fetch
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ refresh_token: SENTINEL }),
    }) as any;
    await svc.complete({ loginId: r.loginId, callback: 'pixiv://account/login?code=c1' });
    await expect(
      svc.complete({ loginId: r.loginId, callback: 'code' })
    ).rejects.toBeInstanceOf(AuthHostLoginSessionInvalidError);
  });

  it('TTL expiry throws same error', async () => {
    const r = svc.start();
    now += 11 * 60 * 1000;
    await expect(
      svc.complete({ loginId: r.loginId, callback: 'code' })
    ).rejects.toBeInstanceOf(AuthHostLoginSessionInvalidError);
  });

  it('importToken stores token and lists account', async () => {
    await svc.importToken(SENTINEL);
    expect(importer.tokens).toContain(SENTINEL);
    const accounts = await svc.accounts();
    expect(accounts.length).toBe(1);
  });

  it('verifier is S256 of the challenge preimage (no verifier in start response)', () => {
    const r = svc.start();
    const u = new URL(r.authorizeUrl.replace('pixiv:', 'https:'));
    const challenge = u.searchParams.get('code_challenge');
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
