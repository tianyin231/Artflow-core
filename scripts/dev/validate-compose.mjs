#!/usr/bin/env node
/** Validate compose syntax and required API image inputs without a Docker daemon. */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const root = resolve(process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
const composePath = join(root, 'deploy/docker-compose.yml');
const errors = [];
let compose;
try {
  compose = yaml.load(readFileSync(composePath, 'utf8'));
} catch (error) {
  console.error(`validate-compose: FAIL — ${error.message}`);
  process.exit(1);
}
const services = compose?.services;
for (const id of ['core', 'studio', 'mock']) {
  if (!services?.[id] || typeof services[id] !== 'object') errors.push(`missing ${id} service`);
}
if (!services?.core?.healthcheck?.test) errors.push('core healthcheck missing');
for (const id of ['artflow-data', 'pixiv-cli-state']) {
  if (!Object.hasOwn(compose?.volumes || {}, id)) errors.push(`missing ${id} volume`);
}
if (!services?.studio?.profiles?.includes('studio')) {
  errors.push('unfinished studio service must require the studio profile');
}
if (!services?.mock?.profiles?.includes('fixture')) errors.push('mock must require the fixture profile');
const coreBuild = services?.core?.build;
if (!coreBuild || typeof coreBuild !== 'object' || typeof coreBuild.context !== 'string') {
  errors.push('core build context missing');
} else {
  const context = resolve(dirname(composePath), coreBuild.context);
  const dockerfile = resolve(context, coreBuild.dockerfile || 'Dockerfile');
  if (!existsSync(dockerfile)) errors.push('core Dockerfile missing');
  for (const input of [
    'package.json', 'package-lock.json', 'tsconfig.json', 'src', 'config',
    'fixtures/pixiv/works.json', 'requirements-python.txt',
    'scripts/create-webui-package-json.js', 'scripts/workflow-render-video.py',
  ]) {
    if (!existsSync(join(context, input))) errors.push(`core image input missing: ${input}`);
  }
}
const envExample = join(root, 'deploy/.env.example');
if (existsSync(envExample)) {
  for (const line of readFileSync(envExample, 'utf8').split('\n')) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    const value = match[2].trim();
    if (value && !/example|placeholder|your|xxx/i.test(value)
        && !/^\$\{?/.test(value) && !/^(0|1|pixiv-cli|legacy|fixture|mcp)$/.test(value)) {
      errors.push(`.env.example has non-placeholder value for ${match[1]}`);
    }
  }
}
if (errors.length) {
  console.error('validate-compose: FAIL');
  for (const error of errors) console.error(' -', error);
  process.exit(1);
}
console.log('validate-compose: OK (API inputs valid; studio profile requires an external Dockerfile)');
