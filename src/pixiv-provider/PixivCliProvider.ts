/**
 * PixivCliProvider — subprocess adapter for pixiv-cli (https://github.com/FlanChanXwO/pixiv-cli).
 * Executable path comes from resolvePixivCliPath() (PIXIV_CLI_PATH, default `pixiv` on PATH).
 * Never uses a shell. Tokens must never appear in argv.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import {
  DownloadResult,
  PixivAuthStatus,
  PixivProvider,
  PixivProviderError,
  PixivWork,
  WorkQuery,
} from './types';

import { normalizeWork, parseAccounts } from './protocol';

export interface PixivCliOptions {
  args?: string[];
  cliPath: string;
  cliHome?: string | null;
  timeoutMs?: number;
  maxBuffer?: number;
  env?: Record<string, string>;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

function classifyStderr(stderr: string, code: number): PixivProviderError {
  const s = stderr.toLowerCase();
  if (s.includes('unauthorized') || s.includes('auth') && s.includes('no pixiv account')) {
    return new PixivProviderError('AUTH_REQUIRED', stderr.trim() || 'unauthorized');
  }
  if (s.includes('429') || s.includes('rate') || s.includes('retry-after')) {
    const m = stderr.match(/retry-after[:\s]+(\d+)/i);
    return new PixivProviderError('RATE_LIMITED', stderr.trim() || 'rate limited', m ? Number(m[1]) * 1000 : undefined);
  }
  if (s.includes('timeout') || s.includes('timed out')) {
    return new PixivProviderError('TIMEOUT', stderr.trim() || 'timeout');
  }
  if (s.includes('not found') || code === 404) {
    return new PixivProviderError('NOT_FOUND', stderr.trim() || 'not found');
  }
  if (s.includes('network') || s.includes('econnrefused') || s.includes('dns')) {
    return new PixivProviderError('NETWORK', stderr.trim() || 'network error');
  }
  return new PixivProviderError('UNKNOWN', stderr.trim() || `pixiv-cli exited ${code}`);
}

export class PixivCliProvider implements PixivProvider {
  readonly id = 'pixiv-cli' as const;
  private readonly opts: Required<Omit<PixivCliOptions, 'cliHome' | 'env'>> & {
    cliHome?: string | null;
    env?: Record<string, string>;
  };

  constructor(options: PixivCliOptions) {
    this.opts = {
      args: options.args ?? [],
      cliPath: options.cliPath,
      cliHome: options.cliHome,
      timeoutMs: options.timeoutMs ?? 30000,
      maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
      env: options.env,
    };
    if (!this.opts.cliPath) {
      throw new PixivProviderError('BINARY_MISSING', 'pixiv-cli path is required');
    }
    if ((this.opts.cliPath.includes('/') || this.opts.cliPath.includes('\\')) && !existsSync(this.opts.cliPath)) {
      throw new PixivProviderError('BINARY_MISSING', `pixiv-cli not found at ${this.opts.cliPath}`);
    }
  }

  private buildEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PIXIV_LOG_FORMAT: 'json',
      ...this.opts.env,
    };
    if (this.opts.cliHome) { env.HOME = this.opts.cliHome; env.USERPROFILE = this.opts.cliHome; }
    return env;
  }

  private exec(args: string[], input?: string): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.opts.cliPath,
        [...this.opts.args, ...args],
        {
          env: this.buildEnv(),
          timeout: this.opts.timeoutMs,
          maxBuffer: this.opts.maxBuffer,
          shell: false,
        },
        (err, stdout, stderr) => {
          if (err && typeof err.code === 'string') {
            reject(new PixivProviderError(err.code === 'ENOENT' ? 'BINARY_MISSING' : 'NETWORK', err.message));
            return;
          }
          if (err?.killed) { reject(new PixivProviderError('TIMEOUT', 'pixiv-cli timed out')); return; }
          resolve({ stdout: String(stdout), stderr: String(stderr), code: err ? Number(err.code) || 1 : 0 });
        }
      );
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(input ?? '');
    });
  }

  async authStatus(): Promise<PixivAuthStatus> {
    const res = await this.exec(['auth', 'list', '--json']);
    if (res.code !== 0) {
      if (classifyStderr(res.stderr, res.code).code === 'AUTH_REQUIRED') {
        return { authenticated: false, accounts: [] };
      }
      throw classifyStderr(res.stderr, res.code);
    }
    try {
      return parseAccounts(JSON.parse(res.stdout || '{}'));
    } catch {
      return { authenticated: false, accounts: [] };
    }
  }

  private mapQueryArgs(q: WorkQuery): string[] {
    const args: string[] = [];
    switch (q.kind) {
      case 'search': {
        args.push('search', q.word ?? '', '--type', 'artwork', '--ndjson');
        if (q.limit) args.push('--limit', String(q.limit));
        if (q.minBookmarks !== undefined) args.push('--bookmark-min', String(q.minBookmarks));
        if (q.startDate) args.push('--start-date', q.startDate);
        if (q.endDate) args.push('--end-date', q.endDate);
        if (q.aiMode) args.push('--ai-mode', q.aiMode);
        if (q.searchBy) args.push('--search-by', q.searchBy);
        break;
      }
      case 'ranking': {
        args.push('ranking', '--mode', q.mode ?? 'day', '--ndjson');
        if (q.date) args.push('--date', q.date);
        if (q.limit) args.push('--limit', String(q.limit));
        break;
      }
      case 'user': {
        args.push('user', 'artworks', ...(q.userId ? [q.userId] : []), '--ndjson');
        if (q.limit) args.push('--limit', String(q.limit));
        break;
      }
      case 'bookmarks': {
        args.push('bookmark', 'list', ...(q.userId ? [q.userId] : []), '--ndjson');
        if (q.limit) args.push('--limit', String(q.limit));
        break;
      }
      default:
        args.push('recommended', '--type', 'artwork', '--ndjson', '--limit', String(q.limit));
    }
    return args;
  }

  async *query(q: WorkQuery): AsyncIterable<PixivWork> {
    const res = await this.exec(this.mapQueryArgs(q));
    if (res.code !== 0) throw classifyStderr(res.stderr, res.code);
    const lines = res.stdout.split('\n').filter((l) => l.trim());
    for (const line of lines.slice(0, q.limit)) {
      let raw: Record<string, unknown>;
      try { raw = JSON.parse(line); }
      catch { throw new PixivProviderError('PROTOCOL', 'Invalid pixiv-cli NDJSON'); }
      yield normalizeWork(raw);
    }
  }

  async detail(id: string): Promise<PixivWork> {
    const res = await this.exec(['detail', id, '--json']);
    if (res.code !== 0) throw classifyStderr(res.stderr, res.code);
    return normalizeWork(JSON.parse(res.stdout));
  }

  async download(
    works: PixivWork[] | string[],
    dir: string,
    opts?: { quality?: string; pages?: string; ugoira?: 'gif' | 'apng' }
  ): Promise<DownloadResult> {
    mkdirSync(dir, { recursive: true });
    const before = new Set(this.listFiles(dir));
    const ndjson = works
      .map((w) =>
        JSON.stringify(
          typeof w === 'string'
            ? { id: w, type: 'illust', url: `https://www.pixiv.net/artworks/${w}` }
            : { id: w.id, type: w.type, url: w.url }
        )
      )
      .join('\n');

    const args = [
      'download',
      '--download-path',
      dir,
      '--filename-template',
      '{id}_p{num}',
      '--on-error',
      'skip',
    ];
    if (opts?.quality) args.push('--quality', opts.quality);
    if (opts?.pages) args.push('--pages', opts.pages);
    if (opts?.ugoira) args.push('--ugoira-mode', opts.ugoira);

    const res = await this.exec(args, ndjson + '\n');
    const warnings: string[] = [];
    const failures: DownloadResult['failures'] = [];
    if (res.code !== 0) {
      const err = classifyStderr(res.stderr, res.code);
      if (err.code === 'AUTH_REQUIRED') throw err;
      warnings.push(err.message);
      failures.push(...works.map((w) => ({ workId: typeof w === 'string' ? w : w.id, code: err.code, message: err.message })));
    }

    const after = this.listFiles(dir);
    const files = after
      .filter((p) => !before.has(p))
      .map((p) => {
        const base = basename(p);
        const m = base.match(/^(.+)_p(\d+)/);
        return {
          path: p,
          workId: m ? m[1] : base,
          page: m ? Number(m[2]) : 0,
          mime: ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' } as Record<string, string>)[extname(p)],
          size: existsSync(p) ? statSync(p).size : 0,
        };
      });

    return { files, failures, warnings };
  }

  private listFiles(dir: string): string[] {
    try {
      return readdirSync(dir, { withFileTypes: true }).flatMap((f) => f.isDirectory() ? this.listFiles(join(dir, f.name)) : [join(dir, f.name)]);
    } catch {
      return [];
    }
  }
}
