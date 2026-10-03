import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(import.meta.url);
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function startServer(directory, env) {
  const bootstrap = join(directory, 'server.cjs');
  await fs.writeFile(bootstrap, `
const SQLite = require(process.argv[3]);
require(process.argv[2]);
process.on('message', async (message) => {
  if (message !== 'collect') return;
  // Drop closed databases and statements before asynchronous native finalization.
  for (let i = 0; i < 40; i++) {
    const db = new SQLite(':memory:');
    for (let j = 0; j < 20; j++) db.prepare('SELECT ? AS value').get(j);
    db.close();
  }
  await global.gc({ type: 'major', execution: 'async' });
  await new Promise(setImmediate);
  process.send('collected');
});
`);
  const child = spawn(process.execPath, ['--expose-gc', bootstrap,
    join(root, 'dist/webui/index.js'), require.resolve('better-sqlite3')], {
    cwd: directory,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (data) => { output = `${output}${data}`.slice(-20000); });
  }
  const completion = new Promise((done, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => done({ code, signal }));
  });
  // Keep spawn failures available to the caller without an unhandled rejection.
  completion.catch(() => {});
  const diagnostics = () => `${child.exitCode ?? child.signalCode ?? 'running'}\n${output}`;
  return {
    child,
    diagnostics,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      try { return await completion; } finally { clearTimeout(timer); }
    },
    async collect() {
      assert.equal(child.exitCode, null, diagnostics());
      await new Promise((done, reject) => {
        const onExit = () => finish(new Error(`Server exited during garbage collection: ${diagnostics()}`));
        const onMessage = (message) => { if (message === 'collected') finish(); };
        const timer = setTimeout(() => finish(new Error(`Garbage collection timed out: ${diagnostics()}`)), 10000);
        const finish = (error) => {
          clearTimeout(timer);
          child.off('exit', onExit);
          child.off('message', onMessage);
          if (error) reject(error); else done();
        };
        child.once('exit', onExit);
        child.on('message', onMessage);
        child.send('collect', (error) => { if (error) finish(error); });
      });
    },
  };
}

async function json(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

async function waitForHealth(server, url) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    assert.equal(server.child.exitCode, null, server.diagnostics());
    assert.equal(server.child.signalCode, null, server.diagnostics());
    try {
      const body = await json(`${url}/api/health`);
      if (body.status === 'ok') return;
    } catch {}
    await delay(25);
  }
  assert.fail(`Server did not become healthy: ${server.diagnostics()}`);
}

test('actual API survives workflow persistence and async native GC, then restores tasks after restart', {
  timeout: 60000,
}, async (t) => {
  await fs.access(join(root, 'dist/webui/index.js')).catch(() => {
    assert.fail('Build Core before this regression: npm run test:native');
  });
  const directory = await fs.mkdtemp(join(tmpdir(), 'artflow-native-runtime-'));
  const servers = [];
  t.after(async () => {
    for (const server of servers) await server.stop();
    await fs.rm(directory, { recursive: true, force: true });
  });
  // Only image inspection is substituted: this test requires no Python/media
  // dependencies. The HTTP server, workflow logic and SQLite are all real.
  const inspectImage = join(directory, 'inspect-image.cjs');
  await fs.writeFile(inspectImage, `#!${process.execPath}
if (process.argv[2] === '--version') process.exit(0);
const png = require('node:fs').readFileSync(process.argv[4]);
console.log(png.readUInt32BE(16) + ',' + png.readUInt32BE(20));
`, { mode: 0o755 });
  const config = join(directory, 'config.json');
  await fs.writeFile(config, JSON.stringify({
    pixiv: { clientId: 'fixture', clientSecret: 'fixture', deviceToken: 'fixture',
      refreshToken: '', userAgent: 'ArtflowFixture/1.0', provider: 'fixture' },
    targets: [],
    runtime: { fixtureMode: true, python: inspectImage, timezone: 'Asia/Tokyo' },
    storage: { databasePath: join(directory, 'artflow.db'),
      downloadDirectory: join(directory, 'downloads'),
      illustrationDirectory: join(directory, 'illustrations'),
      novelDirectory: join(directory, 'novels') },
  }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(ARTFLOW_|PIXIV_|PORT$|HOST$|STATIC_PATH$|NODE_OPTIONS$)/.test(key)) delete env[key];
  }
  const port = await freePort();
  Object.assign(env, { PORT: String(port), HOST: '127.0.0.1',
    ARTFLOW_CONFIG: config, ARTFLOW_DATA_DIR: directory,
    ARTFLOW_FIXTURE_MODE: '1', ARTFLOW_PIXIV_PROVIDER: 'fixture',
    ARTFLOW_SKIP_EXTERNAL_BGM: '1' });
  const url = `http://127.0.0.1:${port}`;
  const server = await startServer(directory, env);
  servers.push(server);
  await waitForHealth(server, url);
  const tasks = [];
  for (let i = 0; i < 12; i++) {
    const command = `Native GC workflow ${i}`;
    const { data: task } = await json(`${url}/api/workflow/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command, dryRunDownload: true, prefilterMode: 'manual' }),
    });
    tasks.push({ id: task.id, command });
    await server.collect();
    let current;
    const deadline = Date.now() + 10000;
    do {
      current = (await json(`${url}/api/workflow/tasks/${task.id}`)).data;
      if (current.status !== 'running') break;
      await delay(25);
    } while (Date.now() < deadline);
    assert.equal(current.status, 'asset_review_required', JSON.stringify(current));
    assert.ok(current.assets.some((asset) => asset.status === 'accepted'));
    await server.collect();
    assert.equal((await json(`${url}/api/health`)).status, 'ok');
  }
  assert.equal(new Set(tasks.map((task) => task.id)).size, tasks.length);
  assert.deepEqual(await server.stop(), { code: 0, signal: null }, server.diagnostics());
  const restarted = await startServer(directory, env);
  servers.push(restarted);
  await waitForHealth(restarted, url);
  await restarted.collect();
  for (const task of tasks) {
    const { data: restored } = await json(`${url}/api/workflow/tasks/${task.id}`);
    assert.equal(restored.command, task.command);
    assert.equal(restored.status, 'asset_review_required');
    assert.ok(restored.assets.some((asset) => asset.status === 'accepted'));
  }
  assert.equal((await json(`${url}/api/health`)).status, 'ok');
});
