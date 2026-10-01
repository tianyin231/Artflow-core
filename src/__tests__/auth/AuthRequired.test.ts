/**
 * Unit tests for assertPixivReady / AuthRequiredError.
 */
import {
  assertPixivReady,
  AuthRequiredError,
  authRequiredHttpBody,
  isPlaceholderToken,
} from '../../auth/AuthRequired';

describe('isPlaceholderToken', () => {
  it('treats empty/missing/placeholder as placeholder', () => {
    expect(isPlaceholderToken(undefined)).toBe(true);
    expect(isPlaceholderToken('')).toBe(true);
    expect(isPlaceholderToken('   ')).toBe(true);
    expect(isPlaceholderToken('YOUR_REFRESH_TOKEN')).toBe(true);
    expect(isPlaceholderToken('YOUR_abc')).toBe(true);
    expect(isPlaceholderToken('(legacy only)')).toBe(true);
  });

  it('treats real-looking tokens as valid', () => {
    expect(isPlaceholderToken('abc123def456')).toBe(false);
    expect(isPlaceholderToken('rt_7f3a9c')).toBe(false);
  });
});

describe('assertPixivReady', () => {
  it('throws AuthRequiredError when no token and no provider auth', () => {
    expect(() => assertPixivReady({ pixiv: { refreshToken: '' } })).toThrow(AuthRequiredError);
    try {
      assertPixivReady({ pixiv: {} });
    } catch (e) {
      const err = e as AuthRequiredError;
      expect(err.code).toBe('PIXIV_AUTH_REQUIRED');
      expect(err.statusCode).toBe(409);
    }
  });

  it('does not throw when config has a real token', () => {
    expect(() => assertPixivReady({ pixiv: { refreshToken: 'real-token' } })).not.toThrow();
  });

  it('does not throw when provider reports authenticated', () => {
    expect(() =>
      assertPixivReady({ pixiv: {} }, { authenticated: true })
    ).not.toThrow();
    expect(() => assertPixivReady({ pixiv: {} }, { hasToken: true })).not.toThrow();
  });

  it('maps to HTTP body shape', () => {
    const err = new AuthRequiredError('need login');
    expect(authRequiredHttpBody(err)).toEqual({
      errorCode: 'PIXIV_AUTH_REQUIRED',
      message: 'need login',
      statusCode: 409,
    });
  });
});
