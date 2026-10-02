import express from 'express';
import request from 'supertest';
import router from '../../webui/routes/auth';
import { TerminalLogin } from '../../terminal-login';
import { updateConfigWithToken } from '../../utils/login-helper';
import { CliTokenImporter } from '../../auth/PixivLoginService';

jest.mock('../../config', () => ({
  getConfigPath: () => '/isolated/config.json',
  loadConfig: () => ({ pixiv: { cliPath: 'Z:/artflow-missing/pixiv.exe' }, network: {} }),
}));
jest.mock('../../terminal-login', () => ({ TerminalLogin: { refresh: jest.fn() } }));
jest.mock('../../utils/login-helper', () => ({ updateConfigWithToken: jest.fn(), clearConfigToken: jest.fn() }));

const app = express().use(express.json()).use('/api/auth', router);
const originalEnv = { ...process.env };
const originalFetch = global.fetch;
beforeEach(async () => {
  process.env.ARTFLOW_FIXTURE_MODE = '1';
  delete process.env.ARTFLOW_PIXIV_PROVIDER;
  await request(app).post('/api/auth/logout');
  jest.clearAllMocks();
});
afterEach(() => { process.env = { ...originalEnv }; global.fetch = originalFetch; });

it('uses the same account state for import, status and logout', async () => {
  await request(app).post('/api/auth/import-token').send({ refreshToken: 'fixture-token' }).expect(200);
  expect((await request(app).get('/api/auth/status')).body.data.authenticated).toBe(true);
  await request(app).post('/api/auth/logout').expect(200);
  expect((await request(app).get('/api/auth/status')).body.data.authenticated).toBe(false);
});

it('does not report success or retain a token when the CLI is missing', async () => {
  delete process.env.ARTFLOW_FIXTURE_MODE;
  await request(app).post('/api/auth/import-token').send({ refreshToken: 'not-a-real-token' }).expect(400);
  expect((await request(app).get('/api/auth/status')).body.data.authenticated).toBe(false);
});

it('validates and persists a legacy token through the existing token store', async () => {
  delete process.env.ARTFLOW_FIXTURE_MODE;
  process.env.ARTFLOW_PIXIV_PROVIDER = 'legacy';
  jest.mocked(TerminalLogin.refresh).mockResolvedValue({ refresh_token: 'rotated-token' } as never);
  await request(app).post('/api/auth/import-token').send({ refreshToken: 'input-token' }).expect(200);
  expect(updateConfigWithToken).toHaveBeenCalledWith('/isolated/config.json', 'rotated-token');
});

it.each(['connection rejected', 'HTTP 503'])('reports failed proxy probes: %s', async (failure) => {
  global.fetch = failure === 'HTTP 503'
    ? jest.fn().mockResolvedValue({ ok: false, status: 503 })
    : jest.fn().mockRejectedValue(new Error(failure));
  const result = await request(app).post('/api/auth/proxy/test').send({ targets: ['http://127.0.0.1:1'] });
  expect(result.body.data.results[0]).toMatchObject({ ok: false, error: failure });
});

it('does not claim an account switch succeeded after a CLI error', async () => {
  const importer = new CliTokenImporter(async () => ({ code: 1, stdout: '', stderr: 'unknown account' }));
  await expect(importer.useAccount('42')).rejects.toThrow('unknown account');
});

it('removes the active CLI account on logout', async () => {
  const run = jest.fn().mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ default_user_id: 42, accounts: [{ user_id: 42, default: true, has_token: true }] }), stderr: '' })
    .mockResolvedValueOnce({ code: 0, stdout: '{}', stderr: '' });
  await new CliTokenImporter(run).logout();
  expect(run).toHaveBeenLastCalledWith(['auth', 'remove', '42', '--yes', '--json']);
});
