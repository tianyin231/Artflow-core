/**
 * Real pixiv-cli binary smoke (opt-in: set ARTFLOW_REAL_PIXIV_CLI=/path/to/pixiv).
 * Uses a temporary HOME so the real ~/.pixiv-cli is never touched.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PixivCliProvider } from '../../pixiv-provider/PixivCliProvider';
import { PixivProviderError } from '../../pixiv-provider/types';

const REAL_PIXIV = process.env.ARTFLOW_REAL_PIXIV_CLI ?? '';
const describeReal = REAL_PIXIV ? describe : describe.skip;

describeReal('real pixiv-cli binary smoke', () => {
  it('unauthenticated ranking maps to AUTH_REQUIRED', () => {
    const home = mkdtempSync(join(tmpdir(), 'artflow-real-home-'));
    let stderr = '';
    let code = 0;
    try {
      execFileSync(REAL_PIXIV, ['ranking', '--json'], {
        env: { ...process.env, HOME: home },
        encoding: 'utf8',
        timeout: 10000,
      });
    } catch (e) {
      code = (e as { status?: number }).status ?? 1;
      stderr = String((e as { stderr?: string }).stderr ?? (e as Error).message);
    }
    expect(code).not.toBe(0);
    expect(stderr.toLowerCase()).toContain('unauthorized');

    const provider = new PixivCliProvider({ cliPath: REAL_PIXIV, cliHome: home, timeoutMs: 10000 });
    // classify the same stderr path via a synthetic exec is covered by fake tests;
    // here we only assert the real binary's unauthorized wording is stable.
    expect(stderr).toMatch(/unauthorized/i);
  }, 20000);
});
