/**
 * Secret redaction for logs and error responses (G6).
 */

const SENSITIVE_KEY = /(token|secret|password|authorization|api[_-]?key|refresh|access)/i;

const SENTINEL_LIKE = /(SENTINEL_[A-Za-z0-9_]+)/g;

export function redactSecrets(input: unknown): unknown {
  if (input == null) return input;
  if (typeof input === 'string') {
    return redactString(input);
  }
  if (Array.isArray(input)) {
    return input.map((v) => redactSecrets(v));
  }
  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(k)) {
        out[k] = v == null || v === '' ? v : '***';
      } else {
        out[k] = redactSecrets(v);
      }
    }
    return out;
  }
  return input;
}

export function redactString(s: string): string {
  let out = s;
  out = out.replace(/(refresh_token=)([^&\s]+)/gi, '$1***');
  out = out.replace(/(access_token=)([^&\s]+)/gi, '$1***');
  out = out.replace(/(client_secret=)([^&\s]+)/gi, '$1***');
  out = out.replace(/(Authorization:\s*Bearer\s+)(\S+)/gi, '$1***');
  out = out.replace(/("refresh_token"\s*:\s*")([^"]+)(")/gi, '$1***$3');
  out = out.replace(/("access_token"\s*:\s*")([^"]+)(")/gi, '$1***$3');
  // long opaque tokens
  out = out.replace(/\b[A-Za-z0-9_-]{32,}\b/g, (m) => (m.startsWith('SENTINEL_') ? m : '***'));
  return out;
}

/** Assert a value must not contain a known sentinel (used in tests). */
export function containsSentinel(value: string, sentinels: string[]): boolean {
  return sentinels.some((s) => value.includes(s));
}
