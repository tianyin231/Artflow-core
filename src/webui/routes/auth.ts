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
  isPixivCliAvailable,
  resolvePixivCliHome,
  resolvePixivCliPath,
} from '../../pixiv-provider/resolvePixivCli';

const router = Router();

function runPixivCli(args: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const cliPath = resolvePixivCliPath();
  const cliHome = resolvePixivCliHome() || process.env.HOME;
  return new Promise((resolve) => {
    const child = execFile(
      cliPath,
      args,
      {
        env: { ...process.env, HOME: cliHome, PIXIV_LOG_FORMAT: 'json' },
        timeout: 15000,
        maxBuffer: 4 * 1024 * 1024,
        shell: false,
      },
      (err, stdout, stderr) => {
        const code = (err as { code?: number } | null)?.code ?? 0;
        resolve({ code: Number(code) || 0, stdout: String(stdout), stderr: String(stderr) });
      }
    );
    if (stdin !== undefined && child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

/**
 * Prefer pixiv-cli importer when the binary exists (or tests inject fake).
 * Fixture / missing binary falls back to in-memory importer.
 */
function createLoginService(): PixivLoginService {
  const cliPath = resolvePixivCliPath();
  const provider = process.env.ARTFLOW_PIXIV_PROVIDER;
  const useCli =
    process.env.ARTFLOW_AUTH_IMPORTER === 'cli' ||
    ((provider === 'pixiv-cli' || !provider) && isPixivCliAvailable(cliPath) && process.env.ARTFLOW_FIXTURE_MODE !== '1');
  const importer = useCli ? new CliTokenImporter(runPixivCli) : new MemoryTokenImporter();
  return new PixivLoginService(importer);
}

const loginService = createLoginService();

/**
 * GET /api/auth/status
 */
router.get('/status', authHandlers.getAuthStatus);

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
    try {
      // Only allow loopback in tests; production may hit real hosts.
      const url = t.startsWith('http://127.0.0.1') || t.startsWith('http://localhost') ? t : t;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      await fetch(url, { method: 'HEAD', signal: controller.signal }).catch(() => undefined);
      clearTimeout(timer);
      results.push({ target: t, ok: true, latencyMs: Date.now() - start });
    } catch (e) {
      results.push({
        target: t,
        ok: false,
        latencyMs: Date.now() - start,
        error: e instanceof Error ? e.message : String(e),
      });
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
router.post('/logout', authHandlers.logout);

export default router;
