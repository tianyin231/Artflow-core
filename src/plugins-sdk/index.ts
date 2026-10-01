/**
 * Artflow plugin SDK (F2-M9) — definePlugin + manifest types.
 */
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
  const o = m as PluginManifest;
  if (!o?.id) errors.push('missing id');
  if (!o?.version) errors.push('missing version');
  if (!o?.apiVersion) errors.push('missing apiVersion');
  if (!o?.entry) errors.push('missing entry');
  return { ok: errors.length === 0, errors };
}

export function isDomainAllowed(url: string, allow: string[]): boolean {
  try {
    const host = new URL(url).hostname;
    return allow.some((d) => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}
