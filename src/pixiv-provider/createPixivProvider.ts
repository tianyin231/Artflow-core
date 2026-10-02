/**
 * Provider factory — selects Pixiv backend from config/env.
 */
import { FixturePixivProvider } from './FixturePixivProvider';
import { PixivCliProvider } from './PixivCliProvider';
import { resolvePixivCliHome, resolvePixivCliPath } from './resolvePixivCli';
import { PixivProvider, PixivProviderError } from './types';

export type ProviderKind = 'pixiv-cli' | 'mcp' | 'legacy' | 'fixture';

export interface CreateProviderOptions {
  provider?: ProviderKind;
  cliPath?: string;
  cliHome?: string | null;
  projectRoot?: string;
}

export function resolveProviderKind(opts: CreateProviderOptions = {}): ProviderKind {
  const env = process.env.ARTFLOW_PIXIV_PROVIDER as ProviderKind | undefined;
  if (env && ['pixiv-cli', 'mcp', 'legacy', 'fixture'].includes(env)) return env;
  if (process.env.ARTFLOW_FIXTURE_MODE === '1') return 'fixture';
  return opts.provider ?? 'pixiv-cli';
}

export function createPixivProvider(opts: CreateProviderOptions = {}): PixivProvider {
  const kind = resolveProviderKind(opts);
  switch (kind) {
    case 'fixture':
      return new FixturePixivProvider();
    case 'pixiv-cli': {
      const cliPath = resolvePixivCliPath(opts.cliPath);
      return new PixivCliProvider({
        cliPath,
        cliHome: opts.cliHome ?? resolvePixivCliHome(),
      });
    }
    case 'mcp': {
      const { PixivMcpProvider } = require('./PixivMcpProvider') as typeof import('./PixivMcpProvider');
      return new PixivMcpProvider({
        command: resolvePixivCliPath(opts.cliPath),
        args: ['mcp'],
        env: (opts.cliHome ?? resolvePixivCliHome()) ? { HOME: (opts.cliHome ?? resolvePixivCliHome())!, USERPROFILE: (opts.cliHome ?? resolvePixivCliHome())! } : undefined,
      });
    }
    case 'legacy': {
      const { LegacyPixivProvider } = require('./LegacyPixivProvider') as typeof import('./LegacyPixivProvider');
      // Legacy path is still driven by DownloadManager inside WorkflowManager;
      // this provider exists so callers can depend on the interface.
      throw new PixivProviderError(
        'PROTOCOL',
        'LegacyPixivProvider requires injected deps; use WorkflowManager legacy branch'
      );
    }
    default:
      throw new PixivProviderError('PROTOCOL', `Unknown provider ${kind}`);
  }
}
