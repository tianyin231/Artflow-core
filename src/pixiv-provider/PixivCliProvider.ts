/**
 * PixivCliProvider — subprocess adapter for pixiv-cli (https://github.com/FlanChanXwO/pixiv-cli).
 * Executable path comes from resolvePixivCliPath() (PIXIV_CLI_PATH, default `pixiv` on PATH).
 * Never uses a shell. Tokens must never appear in argv.
 */
import { execFile } from 'node:child_process';
import { promises as fs, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  DownloadResult,
  PixivAuthStatus,
  PixivProvider,
  PixivProviderError,
  PixivWork,
  WorkQuery,
} from './types';

export interface PixivCliOptions {
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
      cliPath: options.cliPath,
      cliHome: options.cliHome,
      timeoutMs: options.timeoutMs ?? 30000,
      maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
      env: options.env,
    };
    if (!this.opts.cliPath) {
      throw new PixivProviderError('BINARY_MISSING', 'pixiv-cli path is required');
    }
    if (this.opts.cliPath.includes('/') && !existsSync(this.opts.cliPath)) {
      throw new PixivProviderError('BINARY_MISSING', `pixiv-cli not found at ${this.opts.cliPath}`);
    }
  }

  private buildEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PIXIV_LOG_FORMAT: 'json',
      ...this.opts.env,
    };
    if (this.opts.cliHome) env.HOME = this.opts.cliHome;
    return env;
  }

  private exec(args: string[], input?: string): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.opts.cliPath,
        args,
        {
          env: this.buildEnv(),
          timeout: this.opts.timeoutMs,
          maxBuffer: this.opts.maxBuffer,
          shell: false,
        },
        (err, stdout, stderr) => {
          const code = (err as { code?: number } | null)?.code ?? 0;
          if (err && code !== 0) {
            resolve({ stdout: String(stdout), stderr: String(stderr), code: Number(code) || 1 });
            return;
          }
          if (err) {
            reject(err);
            return;
          }
          resolve({ stdout: String(stdout), stderr: String(stderr), code: 0 });
        }
      );
      if (input !== undefined && child.stdin) {
        child.stdin.write(input);
        child.stdin.end();
      }
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
      const parsed = JSON.parse(res.stdout || '[]');
      const list = Array.isArray(parsed) ? parsed : parsed.accounts ?? [];
      return {
        authenticated: list.length > 0,
        accounts: list.map((a: Record<string, unknown>, i: number) => ({
          userId: String(a.userId ?? a.id ?? a.uid ?? i),
          name: a.name ? String(a.name) : undefined,
          isDefault: Boolean(a.isDefault ?? a.default ?? i === 0),
        })),
      };
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
        args.push('ranking', '--mode', q.mode ?? 'day', '--json');
        if (q.date) args.push('--date', q.date);
        break;
      }
      case 'user': {
        args.push('user', q.userId ?? '', '--json');
        if (q.limit) args.push('--limit', String(q.limit));
        break;
      }
      case 'bookmarks': {
        args.push('bookmark', 'list', '--json');
        if (q.limit) args.push('--limit', String(q.limit));
        break;
      }
      default:
        args.push('search', q.word ?? '', '--ndjson', '--limit', String(q.limit ?? 10));
    }
    return args;
  }

  async *query(q: WorkQuery): AsyncIterable<PixivWork> {
    const res = await this.exec(this.mapQueryArgs(q));
    if (res.code !== 0) throw classifyStderr(res.stderr, res.code);
    const lines = res.stdout.split('\n').filter((l) => l.trim());
    for (const line of lines) {
      try {
        const raw = JSON.parse(line);
        yield this.normalizeWork(raw);
      } catch {
        // skip malformed NDJSON lines
      }
    }
  }

  private normalizeWork(raw: Record<string, unknown>): PixivWork {
    return {
      id: String(raw.id ?? raw.illust_id ?? ''),
      type: (raw.type as PixivWork['type']) ?? 'illust',
      title: String(raw.title ?? ''),
      authorId: String(raw.userId ?? raw.user_id ?? raw.authorId ?? ''),
      authorName: String(raw.userName ?? raw.user_name ?? raw.authorName ?? ''),
      tags: Array.isArray(raw.tags)
        ? (raw.tags as unknown[]).map((t) => (typeof t === 'string' ? t : String((t as { name?: string }).name ?? t)))
        : [],
      createdAt: String(raw.createDate ?? raw.create_date ?? raw.createdAt ?? new Date().toISOString()),
      bookmarks: Number(raw.bookmarkCount ?? raw.total_bookmarks ?? raw.bookmarks ?? 0),
      views: Number(raw.viewCount ?? raw.total_view ?? raw.views ?? 0),
      pageCount: Number(raw.pageCount ?? raw.page_count ?? 1),
      xRestrict: (Number(raw.xRestrict ?? raw.x_restrict ?? 0) as 0 | 1 | 2),
      aiType: raw.aiType !== undefined ? Number(raw.aiType) : undefined,
      url: String(raw.url ?? `https://www.pixiv.net/artworks/${raw.id ?? ''}`),
      width: raw.width !== undefined ? Number(raw.width) : undefined,
      height: raw.height !== undefined ? Number(raw.height) : undefined,
    };
  }

  async detail(id: string): Promise<PixivWork> {
    const res = await this.exec(['illust', id, '--json']);
    if (res.code !== 0) throw classifyStderr(res.stderr, res.code);
    return this.normalizeWork(JSON.parse(res.stdout));
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
            ? { id: w, url: `https://www.pixiv.net/artworks/${w}` }
            : { id: w.id, url: w.url }
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
    if (opts?.ugoira) args.push('--ugoira', opts.ugoira);

    const res = await this.exec(args, ndjson + '\n');
    const warnings: string[] = [];
    const failures: DownloadResult['failures'] = [];
    if (res.code !== 0) {
      const err = classifyStderr(res.stderr, res.code);
      if (err.code === 'AUTH_REQUIRED') throw err;
      warnings.push(err.message);
    }

    const after = this.listFiles(dir);
    const files = after
      .filter((p) => !before.has(p))
      .map((p) => {
        const base = p.split('/').pop() ?? p;
        const m = base.match(/^(.+)_p(\d+)/);
        return {
          path: p,
          workId: m ? m[1] : base,
          page: m ? Number(m[2]) : 0,
          mime: 'image/png',
          size: existsSync(p) ? statSync(p).size : 0,
        };
      });

    return { files, failures, warnings };
  }

  private listFiles(dir: string): string[] {
    try {
      return readdirSync(dir).map((f) => join(dir, f));
    } catch {
      return [];
    }
  }
}
