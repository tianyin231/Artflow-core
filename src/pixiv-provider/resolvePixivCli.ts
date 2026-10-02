/**
 * Resolve the pixiv-cli executable (https://github.com/FlanChanXwO/pixiv-cli).
 *
 * Precedence: explicit (config `pixiv.cliPath`) > PIXIV_CLI_PATH > ARTFLOW_PIXIV_CLI (legacy alias)
 * > `pixiv` looked up on PATH.
 */
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

export const DEFAULT_PIXIV_CLI = 'pixiv';

export function resolvePixivCliPath(
  explicit?: string | null,
  env: NodeJS.ProcessEnv = process.env
): string {
  return explicit || env.PIXIV_CLI_PATH || env.ARTFLOW_PIXIV_CLI || DEFAULT_PIXIV_CLI;
}

/** pixiv-cli state HOME override: PIXIV_CLI_HOME > ARTFLOW_PIXIV_CLI_HOME; null = inherit HOME. */
export function resolvePixivCliHome(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.PIXIV_CLI_HOME || env.ARTFLOW_PIXIV_CLI_HOME || null;
}

/** True if `cli` is an existing path, or a bare command found on PATH. */
export function isPixivCliAvailable(cli: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!cli) return false;
  if (isAbsolute(cli) || cli.includes('/') || cli.includes('\\')) return existsSync(cli);
  const exts = process.platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      if (existsSync(join(dir, cli + ext))) return true;
    }
  }
  return false;
}
