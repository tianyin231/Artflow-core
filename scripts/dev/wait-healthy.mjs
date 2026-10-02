#!/usr/bin/env node
/**
 * Poll core/studio until healthy. Checks IPv4 and IPv6.
 * Usage: node scripts/dev/wait-healthy.mjs [--core http://127.0.0.1:3300] [--studio http://127.0.0.1:5373] [--timeout 60]
 */
const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
}
const core = arg('--core', 'http://127.0.0.1:3300');
const studio = arg('--studio', 'http://127.0.0.1:5373');
const timeoutSec = Number(arg('--timeout', '60'));

async function ok(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

function variants(base) {
  const u = new URL(base);
  const out = [base];
  if (u.hostname === '127.0.0.1') out.push(base.replace('127.0.0.1', '[::1]').replace('http://[::1]', 'http://localhost'));
  if (u.hostname === 'localhost') out.push(base.replace('localhost', '127.0.0.1'));
  return out;
}

const start = Date.now();
let last = '';
while (Date.now() - start < timeoutSec * 1000) {
  let coreOk = false;
  let coreAddr = '';
  for (const u of variants(core.replace(/\/$/, ''))) {
    if (await ok(`${u}/api/system/check`)) {
      coreOk = true;
      coreAddr = u;
      break;
    }
  }
  let studioOk = false;
  let studioAddr = '';
  if (studio) {
    for (const u of variants(studio.replace(/\/$/, ''))) {
      if (await ok(`${u}/`)) {
        studioOk = true;
        studioAddr = u;
        break;
      }
    }
  } else {
    studioOk = true;
  }
  last = `core=${coreAddr || 'DOWN'} studio=${studioAddr || 'DOWN'}`;
  if (coreOk && studioOk) {
    console.log(`wait-healthy: OK ${last}`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 1000));
}
console.error(`wait-healthy: TIMEOUT after ${timeoutSec}s (${last})`);
process.exit(1);
