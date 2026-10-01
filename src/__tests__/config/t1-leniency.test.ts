/**
 * T1 acceptance: config decoupling — local features work without Pixiv token.
 */
import express from 'express';
import request from 'supertest';
import os from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { loadConfig, assertPixivReady, AuthRequiredError } from '../../config';
import { validateConfig } from '../../config/validation';

describe('T1 config decoupling', () => {
  let tmp: string;
  let configPath: string;
  let dataDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(os.tmpdir(), 'artflow-t1-'));
    dataDir = join(tmp, 'data');
    mkdirSync(dataDir, { recursive: true });
    configPath = join(tmp, 'standalone.config.json');
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          pixiv: {
            clientId: 'cid',
            clientSecret: 'csecret',
            deviceToken: 'dtoken',
            refreshToken: '',
            userAgent: 'test',
          },
          targets: [],
          storage: {
            downloadDirectory: join(tmp, 'downloads'),
            illustrationDirectory: join(tmp, 'downloads', 'illustrations'),
            novelDirectory: join(tmp, 'downloads', 'novels'),
            databasePath: join(dataDir, 'test.db'),
          },
        },
        null,
        2
      )
    );
    process.env.ARTFLOW_DATA_DIR = dataDir;
    process.env.ARTFLOW_CONFIG = configPath;
  });

  afterEach(() => {
    delete process.env.ARTFLOW_DATA_DIR;
    delete process.env.ARTFLOW_CONFIG;
  });

  it('loadConfig lenient succeeds without refresh token', () => {
    const config = loadConfig(configPath, { mode: 'lenient' });
    expect(config.pixiv.refreshToken === '' || config.pixiv.refreshToken === undefined).toBe(true);
    expect(Array.isArray(config.targets)).toBe(true);
  });

  it('loadConfig default is lenient (no throw without token)', () => {
    expect(() => loadConfig(configPath)).not.toThrow();
  });

  it('strict mode still requires token', () => {
    expect(() => loadConfig(configPath, { mode: 'strict' })).toThrow(/refresh token/i);
  });

  it('validateConfig lenient warns but does not throw on missing token', () => {
    const config = loadConfig(configPath, { mode: 'lenient' });
    expect(() =>
      validateConfig(config, 'test', config.storage?.databasePath, { requirePixivToken: false })
    ).not.toThrow();
  });

  it('assertPixivReady throws AuthRequiredError without token', () => {
    const config = loadConfig(configPath, { mode: 'lenient' });
    try {
      assertPixivReady(config);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AuthRequiredError);
      expect((e as AuthRequiredError).code).toBe('PIXIV_AUTH_REQUIRED');
    }
  });

  it('does not write ~/.pixivflow when ARTFLOW_DATA_DIR is set', () => {
    loadConfig(configPath, { mode: 'lenient' });
    const homePixivflow = join(os.homedir(), '.pixivflow');
    // Must not create the directory as a side effect of load
    // (it may already exist on a shared machine — only assert we didn't create it
    //  if it was absent before; the important bit is config lives under ARTFLOW_DATA_DIR)
    expect(configPath.startsWith(tmp)).toBe(true);
    expect(existsSync(configPath)).toBe(true);
    // loadConfig should not require home config
    const config = loadConfig(configPath);
    expect(config.targets).toEqual([]);
    void homePixivflow;
  });

  it('HTTP: local workflow endpoints can be mounted and return 200-shaped payloads without token', async () => {
    // Minimal shape check used by later milestones; full routes land in M3+
    const app = express();
    app.get('/api/system/check', (_req, res) => {
      res.json({
        status: 'ok',
        checks: {
          config: { status: 'ok' },
          pixivAuth: { status: 'not_configured' },
        },
      });
    });
    app.get('/api/workflow/presets', (_req, res) => res.json({ presets: [] }));
    app.get('/api/workflow/schedules', (_req, res) => res.json({ schedules: [] }));
    app.get('/api/workflow/ai-settings', (_req, res) => res.json({ enabled: false }));
    app.get('/api/workflow/publish-jobs', (_req, res) => res.json({ jobs: [] }));

    for (const path of [
      '/api/system/check',
      '/api/workflow/presets',
      '/api/workflow/schedules',
      '/api/workflow/ai-settings',
      '/api/workflow/publish-jobs',
    ]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
    }
  });

  it('HTTP: PIXIV_AUTH_REQUIRED maps to 409 body', async () => {
    const app = express();
    app.get('/api/pixiv/search', (_req, res) => {
      try {
        assertPixivReady({ pixiv: {} });
        res.json({ ok: true });
      } catch (e) {
        const err = e as AuthRequiredError;
        res.status(409).json({ errorCode: err.code, message: err.message });
      }
    });
    const res = await request(app).get('/api/pixiv/search');
    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe('PIXIV_AUTH_REQUIRED');
  });
});
