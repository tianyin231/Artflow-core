/**
 * PixivProvider contract types (T2/T7).
 */
export interface PixivWork {
  id: string;
  type: 'illust' | 'manga' | 'ugoira';
  title: string;
  authorId: string;
  authorName: string;
  tags: string[];
  createdAt: string;
  bookmarks?: number;
  views?: number;
  pageCount: number;
  xRestrict: 0 | 1 | 2;
  aiType?: number;
  url: string;
  imageUrls?: string[];
  width?: number;
  height?: number;
}

export interface WorkQuery {
  kind: 'search' | 'ranking' | 'user' | 'bookmarks' | 'recommended';
  word?: string;
  mode?: string;
  date?: string;
  userId?: string;
  minBookmarks?: number;
  maxBookmarks?: number;
  startDate?: string;
  endDate?: string;
  aiMode?: 'all' | 'exclude' | 'only';
  contentType?: string;
  limit: number;
  searchBy?: string;
}

export interface DownloadResult {
  files: { path: string; workId: string; page: number; mime?: string; size?: number }[];
  failures: { workId: string; code: string; message: string }[];
  warnings: string[];
}

export interface PixivAuthStatus {
  authenticated: boolean;
  accounts: { userId: string; name?: string; isDefault: boolean }[];
}

export interface PixivProvider {
  readonly id: 'pixiv-cli' | 'mcp' | 'legacy' | 'fixture';
  authStatus(): Promise<PixivAuthStatus>;
  query(q: WorkQuery, signal?: AbortSignal): AsyncIterable<PixivWork>;
  detail(id: string): Promise<PixivWork>;
  download(
    works: PixivWork[] | string[],
    dir: string,
    opts?: { quality?: string; pages?: string; ugoira?: 'gif' | 'apng' }
  ): Promise<DownloadResult>;
  dispose?(): Promise<void>;
}

export type PixivProviderErrorCode =
  | 'AUTH_REQUIRED'
  | 'RATE_LIMITED'
  | 'NETWORK'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'BINARY_MISSING'
  | 'PROTOCOL'
  | 'UNKNOWN';

export class PixivProviderError extends Error {
  code: PixivProviderErrorCode;
  retryAfterMs?: number;
  constructor(code: PixivProviderErrorCode, message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'PixivProviderError';
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}
