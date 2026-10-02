#!/usr/bin/env node
/**
 * Static validation of docker-compose.yml (used when docker is unavailable).
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo root of Artflow-core (this file lives in scripts/dev/), or argv[2].
const root = resolve(process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
const composePath = join(root, 'deploy/docker-compose.yml');

if (!existsSync(composePath)) {
  console.error('validate-compose: compose file missing');
  process.exit(1);
}

const text = readFileSync(composePath, 'utf8');
const errors = [];

function must(re, label) {
  if (!re.test(text)) errors.push(`missing ${label}`);
}

must(/services:/, 'services');
must(/core:/, 'core service');
must(/studio:/, 'studio service');
must(/mock:/, 'mock service');
must(/healthcheck:/, 'healthcheck');
must(/artflow-data:/, 'artflow-data volume');
must(/pixiv-cli-state:/, 'pixiv-cli-state volume');
must(/3300:3300/, 'core port 3300');
must(/5373:80/, 'studio port 5373');
must(/ARTFLOW_/, 'ARTFLOW env placeholders');

// .env.example must only contain placeholders (no real secrets)
const envExample = join(root, 'deploy/.env.example');
if (existsSync(envExample)) {
  const env = readFileSync(envExample, 'utf8');
  for (const line of env.split('\n')) {
    if (/^[A-Z0-9_]+=..+/.test(line) && !/=\s*$/.test(line) && !/=PLACEHOLDER/i.test(line) && !/=\$\{?/.test(line)) {
      // allow empty values only
      const val = line.split('=').slice(1).join('=').trim();
      if (
        val &&
        val.length > 0 &&
        !/example|placeholder|your|xxx/i.test(val) &&
        !/^(0|1|pixiv-cli|legacy|fixture|mcp)$/i.test(val)
      ) {
        errors.push(`.env.example has non-placeholder value for ${line.split('=')[0]}`);
      }
    }
  }
}

if (errors.length) {
  console.error('validate-compose: FAIL');
  for (const e of errors) console.error(' -', e);
  process.exit(1);
}
console.log('validate-compose: OK', composePath);
