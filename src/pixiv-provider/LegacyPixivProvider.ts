/**
 * LegacyPixivProvider — wraps the existing DownloadManager / PixivClient stack
 * behind the PixivProvider interface (T2).
 */
import {
  DownloadResult,
  PixivAuthStatus,
  PixivProvider,
  PixivProviderError,
  PixivWork,
  WorkQuery,
} from './types';

export interface LegacyProviderDeps {
  /** Existing DownloadManager-style run (kept as a callback so we do not new it here). */
  runDownload: (opts: {
    target: Record<string, unknown>;
    destDir: string;
  }) => Promise<{ files: string[]; errors?: string[] }>;
  /** Search via existing PixivClient. */
  search: (q: WorkQuery) => Promise<PixivWork[]>;
  /** Detail via existing PixivClient. */
  detail: (id: string) => Promise<PixivWork>;
  /** Auth status via existing token store. */
  authStatus: () => Promise<PixivAuthStatus>;
}

export class LegacyPixivProvider implements PixivProvider {
  readonly id = 'legacy' as const;

  constructor(private readonly deps: LegacyProviderDeps) {}

  authStatus(): Promise<PixivAuthStatus> {
    return this.deps.authStatus();
  }

  async *query(q: WorkQuery): AsyncIterable<PixivWork> {
    const list = await this.deps.search(q);
    for (const w of list.slice(0, q.limit || 10)) {
      yield w;
    }
  }

  detail(id: string): Promise<PixivWork> {
    return this.deps.detail(id);
  }

  async download(
    works: PixivWork[] | string[],
    dir: string,
    _opts?: { quality?: string; pages?: string; ugoira?: 'gif' | 'apng' }
  ): Promise<DownloadResult> {
    const ids = works.map((w) => (typeof w === 'string' ? w : w.id));
    try {
      const result = await this.deps.runDownload({
        target: { illustIds: ids, limit: ids.length },
        destDir: dir,
      });
      return {
        files: (result.files || []).map((path, i) => ({
          path,
          workId: ids[i] ?? String(i),
          page: 0,
        })),
        failures: (result.errors || []).map((message, i) => ({
          workId: ids[i] ?? String(i),
          code: 'UNKNOWN',
          message,
        })),
        warnings: [],
      };
    } catch (e) {
      throw new PixivProviderError(
        'UNKNOWN',
        e instanceof Error ? e.message : String(e)
      );
    }
  }
}
