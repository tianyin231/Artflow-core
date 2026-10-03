import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const scripts = join(root, 'scripts/dev');
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function temp(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'artflow-tooling-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function command(bin, args, options = {}) {
  const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 10000, ...options });
  assert.ifError(result.error);
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => server.close(done)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function runNode(args, env = process.env) {
  const child = spawn(process.execPath, args, { env });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  const code = await new Promise((done, reject) => {
    child.on('error', reject);
    child.on('exit', done);
  });
  return { code, output };
}

test('readiness rejects an HTTP 200 impostor and honors the deadline', async (t) => {
  const url = await listen(t, (_req, res) => res.end('<html>unrelated service</html>'));
  const start = Date.now();
  const result = await runNode([join(scripts, 'wait-healthy.mjs'), '--core', url, '--studio', '', '--timeout', '0.2']);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /TIMEOUT/);
  assert.ok(Date.now() - start < 1500, 'timeout should not run a full extra polling interval');
});

test('readiness checks the API health contract without optional dependency probes', async (t) => {
  const url = await listen(t, (req, res) => {
    if (req.url === '/api/health') res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    else if (req.url === '/api/system/check') res.end(JSON.stringify({ data: { status: 'warning', items: [] } }));
    else res.end('<div id="root"></div><script type="module"></script>');
  });
  const result = await runNode([join(scripts, 'wait-healthy.mjs'), '--core', url, '--studio', url, '--timeout', '1']);
  assert.equal(result.code, 0, result.output);
  assert.equal(command(process.execPath, [join(scripts, 'wait-healthy.mjs'), '--timeout', 'NaN']).code, 2);
});

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function fakeStack(t, fixture = false) {
  const directory = await temp(t);
  const core = join(directory, 'core');
  const studio = join(directory, 'studio');
  const bin = join(directory, 'bin');
  for (const path of [join(core, 'scripts/dev'), join(core, 'test/mock-servers'), join(core, 'dist/webui'), studio, bin]) {
    await fs.mkdir(path, { recursive: true });
  }
  for (const file of ['dev-stack.sh', 'wait-healthy.mjs']) {
    await fs.copyFile(join(scripts, file), join(core, 'scripts/dev', file));
  }
  const serve = `
const http = require('node:http');
const fs = require('node:fs');
const kind = process.env.TEST_SERVICE;
const arg = process.argv.indexOf('--port');
const port = kind === 'core' ? Number(process.env.PORT) : Number(process.argv[arg + 1]);
if (kind === 'core') {
  fs.writeFileSync(process.env.TEST_CORE_ENV, JSON.stringify({ config: process.env.ARTFLOW_CONFIG, data: process.env.ARTFLOW_DATA_DIR }));
  setInterval(() => { if (fs.existsSync(process.env.TEST_EXIT_FILE)) process.exit(7); }, 50);
}
http.createServer((req, res) => {
  if (req.url === '/api/health') res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
  else if (req.url === '/__health') res.end(JSON.stringify({ ok: true }));
  else res.end('<div id="root"></div><script type="module"></script>');
}).listen(port, '127.0.0.1');
`;
  await fs.writeFile(join(core, 'dist/webui/index.js'), serve);
  await fs.writeFile(join(core, 'test/mock-servers/index.mjs'), `import { createRequire } from 'node:module'; createRequire(import.meta.url)('../../dist/webui/index.js');`);
  await fs.writeFile(join(studio, 'server.cjs'), serve);
  await fs.writeFile(join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await fs.writeFile(join(bin, 'npx'), '#!/bin/sh\nTEST_SERVICE=studio exec "$TEST_NODE" "$TEST_STUDIO_ENTRY" "$@"\n', { mode: 0o755 });
  // Core and mock share the tiny server implementation; PORT identifies core.
  const coreFile = join(core, 'dist/webui/index.js');
  await fs.writeFile(coreFile, serve.replace("const kind = process.env.TEST_SERVICE;", "const kind = process.argv[1].endsWith('index.js') && process.env.PORT ? 'core' : 'mock';"));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('ARTFLOW_')) delete env[key];
  Object.assign(env, {
    PATH: `${bin}:${process.env.PATH}`,
    ARTFLOW_STUDIO_DIR: studio,
    TEST_NODE: process.execPath,
    TEST_STUDIO_ENTRY: join(studio, 'server.cjs'),
    TEST_CORE_ENV: join(directory, 'core-env.json'),
    TEST_EXIT_FILE: join(directory, 'exit-core'),
  });
  if (fixture) env.ARTFLOW_DATA_DIR = join(directory, 'data "quotes" \\ path');
  const ports = [await freePort(), await freePort(), await freePort()];
  const child = spawn('bash', [join(core, 'scripts/dev/dev-stack.sh'), ...(fixture ? ['--fixture'] : []),
    '--mock-port', String(ports[0]), '--core-port', String(ports[1]), '--studio-port', String(ports[2])], { env });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  const completion = new Promise((done, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => done({ code, signal }));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await completion;
  });
  const deadline = Date.now() + 10000;
  while (!output.includes('[dev-stack] ready:') && child.exitCode === null && Date.now() < deadline) await delay(50);
  assert.match(output, /\[dev-stack\] ready:/, output);
  return { child, completion, ports, env, output: () => output };
}

async function assertClosed(ports) {
  for (const port of ports) {
    await assert.rejects(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }));
  }
}

test('normal stack starts without ARTFLOW_DATA_DIR and SIGTERM closes every service', async (t) => {
  const stack = await fakeStack(t);
  const environment = JSON.parse(await fs.readFile(stack.env.TEST_CORE_ENV, 'utf8'));
  assert.equal(environment.config, undefined);
  stack.child.kill('SIGTERM');
  assert.equal((await stack.completion).code, 143, stack.output());
  await assertClosed(stack.ports);
});

test('fixture JSON escapes data paths and a child failure tears down the stack', async (t) => {
  const stack = await fakeStack(t, true);
  const config = JSON.parse(await fs.readFile(join(stack.env.ARTFLOW_DATA_DIR, 'config/standalone.config.json'), 'utf8'));
  assert.equal(config.storage.databasePath, join(stack.env.ARTFLOW_DATA_DIR, 'artflow.db'));
  await fs.writeFile(stack.env.TEST_EXIT_FILE, 'exit');
  const result = await Promise.race([stack.completion, delay(5000).then(() => ({ code: 'timeout' }))]);
  assert.equal(result.code, 7, stack.output());
  await assertClosed(stack.ports);
});

test('secret scan catches report/history leaks and fails closed on an invalid ref', async (t) => {
  const directory = await temp(t);
  const core = join(directory, 'core');
  const studio = join(directory, 'studio');
  await fs.mkdir(join(core, 'scripts/dev'), { recursive: true });
  await fs.mkdir(studio);
  await fs.copyFile(join(scripts, 'scan-secrets.mjs'), join(core, 'scripts/dev/scan-secrets.mjs'));
  for (const repo of [core, studio]) {
    assert.equal(command('git', ['init', '-q', repo]).code, 0);
    assert.equal(command('git', ['-C', repo, 'config', 'user.name', 'Tooling Test']).code, 0);
    assert.equal(command('git', ['-C', repo, 'config', 'user.email', 'tooling@example.invalid']).code, 0);
    await fs.writeFile(join(repo, 'clean.txt'), 'clean');
    assert.equal(command('git', ['-C', repo, 'add', '.']).code, 0);
    assert.equal(command('git', ['-C', repo, 'commit', '-qm', 'clean']).code, 0);
  }
  const env = { ...process.env, ARTFLOW_STUDIO_DIR: studio, ARTFLOW_SCAN_REF: 'HEAD' };
  const script = join(core, 'scripts/dev/scan-secrets.mjs');
  assert.equal(command(process.execPath, [script], { env }).code, 0);
  const secret = ['SENTINEL', 'rt', '7f3a9c'].join('_');
  await fs.mkdir(join(studio, 'test-results'));
  await fs.writeFile(join(studio, 'test-results/leak.json'), JSON.stringify({ token: secret }));
  const report = command(process.execPath, [script], { env });
  assert.equal(report.code, 1, report.output);
  assert.match(report.output, /leak.json/);
  assert.ok(!report.output.includes(secret), 'scan logs must not reproduce the value');
  await fs.rm(join(studio, 'test-results'), { recursive: true });
  await fs.writeFile(join(studio, 'clean.txt'), secret);
  command('git', ['-C', studio, 'commit', '-qam', 'leaked']);
  await fs.writeFile(join(studio, 'clean.txt'), 'clean');
  command('git', ['-C', studio, 'commit', '-qam', 'removed']);
  const history = command(process.execPath, [script], { env });
  assert.equal(history.code, 1, history.output);
  assert.match(history.output, /git-history/);
  const invalid = command(process.execPath, [script], { env: { ...env, ARTFLOW_SCAN_REF: 'missing-ref' } });
  assert.equal(invalid.code, 1, invalid.output);
  assert.match(invalid.output, /scan-error/);
});

test('compose validation parses YAML and checks required build inputs', async (t) => {
  assert.equal(command(process.execPath, [join(scripts, 'validate-compose.mjs')]).code, 0);
  const directory = await temp(t);
  await fs.mkdir(join(directory, 'deploy'));
  await fs.writeFile(join(directory, 'deploy/docker-compose.yml'), 'services:\n  core: {}\n  core: {}\n');
  assert.equal(command(process.execPath, [join(scripts, 'validate-compose.mjs'), directory]).code, 1);
});

test('verify-all preserves checkout paths, records step failures and continues required checks', async (t) => {
  const directory = await temp(t);
  const core = join(directory, "core's checkout");
  const studio = join(directory, "studio's checkout");
  const bin = join(directory, 'bin');
  for (const path of [join(core, 'scripts/dev'), studio, bin]) await fs.mkdir(path, { recursive: true });
  await fs.copyFile(join(scripts, 'verify-all.sh'), join(core, 'scripts/dev/verify-all.sh'));
  const stub = '#!/bin/sh\nprintf "%s|%s|%s\\n" "$PWD" "$ARTFLOW_CORE_DIR" "$*" >> "$TEST_COMMAND_LOG"\nif [ "$PWD" = "$ARTFLOW_STUDIO_DIR" ] && [ "$*" = "run lint" ]; then exit 9; fi\nexit 0\n';
  for (const name of ['npm', 'node']) await fs.writeFile(join(bin, name), stub, { mode: 0o755 });
  await fs.writeFile(join(bin, 'docker'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const log = join(directory, 'commands.log');
  const result = command('bash', [join(core, 'scripts/dev/verify-all.sh')], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ARTFLOW_STUDIO_DIR: studio, TEST_COMMAND_LOG: log },
  });
  assert.equal(result.code, 1, result.output);
  const summary = await fs.readFile(join(core, '.artflow-dev/verify/verify-summary.txt'), 'utf8');
  assert.match(summary, /FAIL  studio:lint.*rc=9/);
  assert.match(summary, /PASS  secrets:scan/);
  assert.match(summary, /OVERALL: FAIL/);
  const calls = (await fs.readFile(log, 'utf8')).trim().split('\n');
  assert.ok(calls.every((line) => line.split('|')[1] === core), 'E2E and every check must receive this core checkout');
  assert.equal(calls.filter((line) => line.startsWith(`${core}|`) && line.endsWith('|test -- --ci')).length, 2);
  assert.ok((await fs.stat(join(core, '.artflow-dev/verify/studio-lint.log'))).isFile());
});
