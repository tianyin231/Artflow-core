/**
 * Network guard for tests: only allow 127.0.0.1 / localhost.
 * Equivalent of nock.disableNetConnect() with localhost allowlist (G8).
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function isLocalHost(hostname?: string): boolean {
  if (!hostname) return true;
  const h = hostname.replace(/^\[|\]$/g, '');
  return ALLOWED_HOSTS.has(h) || h.startsWith('127.');
}

function guard(
  original: typeof http.request | typeof https.request,
  label: string
): typeof http.request {
  const wrapped = ((...args: unknown[]) => {
    let hostname: string | undefined;
    const first = args[0];
    if (typeof first === 'string' || first instanceof URL) {
      try {
        hostname = new URL(String(first)).hostname;
      } catch {
        hostname = undefined;
      }
    } else if (first && typeof first === 'object') {
      const opts = first as { hostname?: string; host?: string; href?: string };
      hostname = opts.hostname || opts.host;
      if (!hostname && opts.href) {
        try {
          hostname = new URL(opts.href).hostname;
        } catch {
          /* ignore */
        }
      }
    }
    if (hostname && !isLocalHost(hostname)) {
      const err = new Error(
        `[test-net-guard] Blocked outbound ${label} request to non-local host: ${hostname}`
      );
      // Fail tests loudly
      throw err;
    }
    return (original as (...a: unknown[]) => unknown)(...args);
  }) as typeof http.request;
  return wrapped;
}

let installed = false;

export function installNetworkGuard(): void {
  if (installed) return;
  installed = true;
  (http as { request: unknown }).request = guard(http.request, 'http');
  (https as { request: unknown }).request = guard(https.request, 'https');
  const origConnect = net.connect;
  (net as { connect: unknown }).connect = ((...args: unknown[]) => {
    const first = args[0];
    if (first && typeof first === 'object') {
      const opts = first as { host?: string; hostname?: string };
      const host = opts.host || opts.hostname;
      if (host && !isLocalHost(host)) {
        throw new Error(`[test-net-guard] Blocked outbound TCP to non-local host: ${host}`);
      }
    } else if (typeof first === 'number' || typeof first === 'string') {
      // connect(port, host) form
      const host = typeof args[1] === 'string' ? args[1] : undefined;
      if (host && !isLocalHost(host)) {
        throw new Error(`[test-net-guard] Blocked outbound TCP to non-local host: ${host}`);
      }
    }
    return (origConnect as (...a: unknown[]) => unknown)(...args);
  }) as typeof net.connect;
}

// Auto-install when imported from jest setup
installNetworkGuard();
