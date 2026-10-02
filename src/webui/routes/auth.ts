import { Router, Request, Response } from 'express';
import * as authHandlers from './handlers/auth-handlers';
import {
  PixivLoginService,
  MemoryTokenImporter,
  CliTokenImporter,
  AuthHostLoginSessionInvalidError,
} from '../../auth/PixivLoginService';
import { redactSecrets } from '../../auth/redact';
import { execFile } from 'node:child_process';
import {
  resolvePixivCliHome,
  resolvePixivCliPath,
} from '../../pixiv-provider/resolvePixivCli';

import { getConfigPath, loadConfig } from '../../config';
import { LegacyTokenImporter } from '../../auth/LegacyTokenImporter';
import { ProxyAgent } from 'undici';

const router = Router();

export function runPixivCli(args: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const config = loadConfig(getConfigPath(), true);
  const cliPath = resolvePixivCliPath(config.pixiv?.cliPath);
  const cliHome = config.pixiv?.cliHome || resolvePixivCliHome() || process.env.HOME;
  return new Promise((resolve) => {
    const child = execFile(
      cliPath,
      args,
      {
        env: { ...process.env, HOME: cliHome, USERPROFILE: cliHome, PIXIV_LOG_FORMAT: 'json' },
        timeout: 15000,
        maxBuffer: 4 * 1024 * 1024,
        shell: false,
      },
      (err, stdout, stderr) => {
        const code = (err as { code?: number } | null)?.code ?? 0;
        resolve({ code: err ? Number(code) || 1 : 0, stdout: String(stdout), stderr: String(stderr || err?.message || '') });
      }
    );
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(stdin ?? '');
  });
}

const fixtureImporter = new MemoryTokenImporter();
const cliImporter = new CliTokenImporter(runPixivCli);
const legacyImporter = new LegacyTokenImporter();
function currentImporter() {
  if (process.env.ARTFLOW_FIXTURE_MODE === '1' || process.env.ARTFLOW_PIXIV_PROVIDER === 'fixture') return fixtureImporter;
  const config = loadConfig(getConfigPath(), true);
  const provider = process.env.ARTFLOW_PIXIV_PROVIDER || config.pixiv?.provider || config.pixivProvider;
  if (provider === 'fixture' || config.runtime?.fixtureMode) return fixtureImporter;
  return provider === 'legacy' ? legacyImporter : cliImporter;
}
const loginService = new PixivLoginService({
  importToken: (token) => currentImporter().importToken(token),
  listAccounts: () => currentImporter().listAccounts(),
  useAccount: (uid) => currentImporter().useAccount(uid),
  check: () => currentImporter().check(),
  logout: () => currentImporter().logout(),
});

router.get('/status', async (_req: Request, res: Response) => {
  try {
    const { authenticated } = await loginService.check();
    const active = (await loginService.accounts()).find((a) => a.isDefault);
    res.json({ data: { authenticated, isAuthenticated: authenticated, hasToken: authenticated, tokenValid: authenticated ? null : false,
      user: active ? { id: active.userId, name: active.name } : null } });
  } catch (error) {
    res.json({ data: { authenticated: false, hasToken: false, user: null, error: redactSecrets(String(error)) } });
  }
});

/**
 * POST /api/auth/login — account/password automation is deprecated (410).
 */
router.post('/login', (_req: Request, res: Response) => {
  res.status(410).json({
    errorCode: 'LOGIN_METHOD_DEPRECATED',
    message:
      '账号密码自动化登录已弃用。请使用 POST /api/auth/login/start 或 /api/auth/import-token。',
  });
});

/**
 * POST /api/auth/login/start
 */
router.post('/login/start', (_req: Request, res: Response) => {
  try {
    const result = loginService.start();
    res.json({ data: result });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * POST /api/auth/login/complete
 */
router.post('/login/complete', async (req: Request, res: Response) => {
  try {
    const { loginId, callback } = req.body ?? {};
    if (!loginId || !callback) {
      return res.status(400).json({ error: 'loginId and callback required' });
    }
    const result = await loginService.complete({ loginId, callback });
    return res.json({ data: result });
  } catch (e) {
    if (e instanceof AuthHostLoginSessionInvalidError) {
      return res.status(400).json({ errorCode: e.code, message: e.message });
    }
    return res.status(500).json({ error: redactSecrets(String(e)) });
  }
});

/**
 * POST /api/auth/import-token
 */
router.post('/import-token', async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body ?? {};
    const result = await loginService.importToken(String(refreshToken ?? ''));
    res.json({ data: result });
  } catch (e) {
    res.status(400).json({ error: redactSecrets(String(e)) });
  }
});

/**
 * GET /api/auth/accounts
 */
router.get('/accounts', async (_req: Request, res: Response) => {
  try {
    const accounts = await loginService.accounts();
    res.json({ data: accounts });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * POST /api/auth/accounts/:uid/use
 */
router.post('/accounts/:uid/use', async (req: Request, res: Response) => {
  try {
    await loginService.use(req.params.uid);
    res.json({ data: { ok: true } });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * POST /api/auth/proxy/test
 */
router.post('/proxy/test', async (req: Request, res: Response) => {
  const targets = (req.body?.targets as string[]) ?? [
    'https://oauth.secure.pixiv.net',
    'https://app-api.pixiv.net',
  ];
  const results = [] as { target: string; ok: boolean; latencyMs?: number; error?: string }[];
  for (const t of targets) {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    let dispatcher: ProxyAgent | undefined;
    try {
      const config = loadConfig(getConfigPath(), true);
      const proxy = config.network?.proxy;
      if (proxy?.enabled && proxy.host && proxy.port) {
        const protocol = proxy.protocol ?? 'http';
        if (protocol !== 'http' && protocol !== 'https') throw new Error('代理测试仅支持 HTTP/HTTPS 代理');
        dispatcher = new ProxyAgent({ uri: protocol + '://' + proxy.host + ':' + proxy.port,
          token: proxy.username ? 'Basic ' + Buffer.from(proxy.username + ':' + (proxy.password ?? '')).toString('base64') : undefined });
      }
      const response = await fetch(t, { method: 'HEAD', signal: controller.signal, ...(dispatcher ? { dispatcher } : {}) });
      results.push({ target: t, ok: response.ok, latencyMs: Date.now() - start, ...(response.ok ? {} : { error: 'HTTP ' + response.status }) });
    } catch (e) {
      results.push({ target: t, ok: false, latencyMs: Date.now() - start, error: e instanceof Error ? e.message : String(e) });
    } finally {
      clearTimeout(timer);
      await dispatcher?.close();
    }
  }
  res.json({ data: { results } });
});

/**
 * POST /api/auth/refresh
 */
router.post('/refresh', authHandlers.refreshToken);

/**
 * POST /api/auth/login-with-token
 */
router.post('/login-with-token', authHandlers.loginWithToken);

/**
 * POST /api/auth/logout
 */
router.post('/logout', async (_req: Request, res: Response) => {
  try { await loginService.logout(); res.json({ success: true }); }
  catch (error) { res.status(500).json({ error: redactSecrets(String(error)) }); }
});

export default router;
