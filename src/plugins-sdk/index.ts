/**
 * Artflow plugin SDK (F2-M9) — definePlugin + manifest types.
 */
import { isIP } from 'node:net';

export interface PluginManifest {
  id: string;
  version: string;
  apiVersion: string;
  permissions: { network?: string[]; fs?: string[] };
  entry: string;
}

export function definePlugin<T extends Record<string, unknown>>(impl: T): T {
  return impl;
}

export function validateManifest(m: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!record(m)) return { ok: false, errors: ['not an object'] };
  for (const field of ['id', 'version', 'apiVersion', 'entry'] as const) {
    if (typeof m[field] !== 'string' || !m[field].trim()) errors.push(`missing or invalid ${field}`);
  }
  if (!record(m.permissions)) errors.push('permissions must be an object');
  else {
    const { network, fs } = m.permissions;
    if (network !== undefined && (!Array.isArray(network) || network.some((domain) => normalizeDomain(domain) === null))) {
      errors.push('permissions.network must be an array of domain names');
    }
    if (fs !== undefined && (!Array.isArray(fs) || fs.some((path) => typeof path !== 'string' || !path.trim()))) {
      errors.push('permissions.fs must be an array of paths');
    }
  }
  return { ok: errors.length === 0, errors };
}

function normalizeDomain(domain: unknown): string | null {
  if (typeof domain !== 'string' || !domain.trim() || /[\s/?#@\\%]/.test(domain)) return null;
  const value = domain.toLowerCase().replace(/\.$/, '');
  if (value.includes(':') && !(value.startsWith('[') && value.endsWith(']'))) return null;
  try {
    const host = new URL(`https://${value}`).hostname;
    const ip = host.replace(/^\[|\]$/g, '');
    if (isIP(ip)) return host;
    if (host.length > 253 || !host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
    return host;
  } catch {
    return null;
  }
}

export function isDomainAllowed(url: string, allow: string[]): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    return allow.some((domain) => {
      const permitted = normalizeDomain(domain);
      return permitted !== null && (host === permitted || (!isIP(permitted.replace(/^\[|\]$/g, '')) && host.endsWith('.' + permitted)));
    });
  } catch {
    return false;
  }
}
