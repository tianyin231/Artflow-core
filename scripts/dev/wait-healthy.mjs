#!/usr/bin/env node
/** Poll the requested core/studio URLs until they serve Artflow responses. */
const options = {
  '--core': 'http://127.0.0.1:3300',
  '--studio': 'http://127.0.0.1:5373',
  '--mock': '',
  '--timeout': '60',
};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  if (!(args[i] in options) || args[i + 1] === undefined) {
    console.error('wait-healthy: expected --core/--studio/--mock URL or --timeout SECONDS');
    process.exit(2);
  }
  options[args[i]] = args[i + 1];
}
const timeoutSec = Number(options['--timeout']);
if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
  console.error('wait-healthy: timeout must be a positive number');
  process.exit(2);
}
for (const name of ['--core', '--studio', '--mock']) {
  try {
    if (options[name] && !['http:', 'https:'].includes(new URL(options[name]).protocol)) throw new Error();
  } catch {
    console.error(`wait-healthy: invalid URL for ${name}`);
    process.exit(2);
  }
}

const deadline = Date.now() + timeoutSec * 1000;
async function ok(base, route, validate) {
  if (!base) return true;
  const remaining = deadline - Date.now();
  if (remaining <= 0) return false;
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}${route}`, {
      signal: AbortSignal.timeout(Math.max(1, Math.min(3000, remaining))),
    });
    return res.ok && await validate(res);
  } catch {
    return false;
  }
}

let last = '';
while (Date.now() < deadline) {
  const [coreOk, studioOk, mockOk] = await Promise.all([
    ok(options['--core'], '/api/health', async (res) => {
      const body = await res.json();
      // System checks execute optional Python probes; use the lightweight
      // readiness route and require its JSON contract rather than any HTTP 200.
      return body?.status === 'ok' && Number.isFinite(Date.parse(body.timestamp));
    }),
    ok(options['--studio'], '/', async (res) => {
      const html = await res.text();
      return /\bid=["']root["']/.test(html) && /<script\b/.test(html);
    }),
    ok(options['--mock'], '/__health', async (res) => (await res.json()).ok === true),
  ]);
  last = `core=${coreOk ? 'UP' : 'DOWN'} studio=${studioOk ? 'UP' : 'DOWN'} mock=${mockOk ? 'UP' : 'DOWN'}`;
  if (coreOk && studioOk && mockOk) {
    console.log(`wait-healthy: OK ${last}`);
    process.exit(0);
  }
  const remaining = deadline - Date.now();
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(1000, remaining)));
}
console.error(`wait-healthy: TIMEOUT after ${timeoutSec}s (${last})`);
process.exit(1);
