/**
 * Auth readiness gate — only enforced when a real Pixiv call is about to happen.
 */

export class AuthRequiredError extends Error {
  readonly code = 'PIXIV_AUTH_REQUIRED';
  readonly statusCode = 409;
  constructor(message = 'Pixiv authentication required') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

export interface PixivAuthLike {
  authenticated?: boolean;
  hasToken?: boolean;
}

export interface PixivReadyConfigLike {
  pixiv?: {
    refreshToken?: string;
    provider?: string;
  };
}

export function isPlaceholderToken(token?: string): boolean {
  if (!token) return true;
  const t = token.trim();
  if (!t) return true;
  if (t === 'YOUR_REFRESH_TOKEN' || t.startsWith('YOUR_')) return true;
  if (t === '(legacy only)') return true;
  return false;
}

/**
 * Assert that Pixiv access is ready. Throws AuthRequiredError when not.
 * `provider` may be a future PixivProvider with authStatus(); until then we
 * accept a simple boolean/token config check.
 */
export function assertPixivReady(
  config: PixivReadyConfigLike,
  provider?: PixivAuthLike
): void {
  if (provider?.authenticated === true) return;
  if (provider?.hasToken === true) return;

  const token = config?.pixiv?.refreshToken;
  if (!isPlaceholderToken(token)) return;

  throw new AuthRequiredError(
    'Pixiv authentication required. Connect an account in Accounts & Connections.'
  );
}

/** Map AuthRequiredError to HTTP response shape. */
export function authRequiredHttpBody(err: AuthRequiredError) {
  return {
    errorCode: err.code,
    message: err.message,
    statusCode: err.statusCode,
  };
}
