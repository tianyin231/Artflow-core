import { PixivAuthStatus, PixivProviderError, PixivWork } from './types';

export function parseAccounts(raw: { accounts?: Record<string, unknown>[]; default_user_id?: number }): PixivAuthStatus {
  const list = raw.accounts ?? [];
  return {
    authenticated: list.some((a) => a.has_token !== false && (a.default === true || String(a.user_id) === String(raw.default_user_id))),
    accounts: list.map((a) => ({
      userId: String(a.user_id),
      name: a.username ? String(a.username) : undefined,
      isDefault: a.default === true || String(a.user_id) === String(raw.default_user_id),
    })),
  };
}

export function normalizeWork(raw: Record<string, unknown>): PixivWork {
  if (!raw.id) throw new PixivProviderError('PROTOCOL', 'pixiv-cli returned a work without an id');
  const user = (raw.user ?? {}) as Record<string, unknown>;
  return {
    id: String(raw.id),
    type: (raw.type ?? raw.kind ?? 'illust') as PixivWork['type'],
    title: String(raw.title ?? ''),
    authorId: String(user.id ?? raw.authorId ?? ''),
    authorName: String(user.name ?? raw.authorName ?? ''),
    tags: Array.isArray(raw.tags) ? raw.tags.map((t) => typeof t === 'string' ? t : String(t.name)) : [],
    createdAt: String(raw.published_at ?? raw.create_date ?? raw.createdAt ?? ''),
    bookmarks: Number(raw.total_bookmarks ?? raw.bookmarks ?? 0),
    views: Number(raw.total_views ?? raw.total_view ?? raw.views ?? 0),
    pageCount: Number(raw.page_count ?? raw.pageCount ?? 1),
    xRestrict: Number(raw.x_restrict ?? raw.xRestrict ?? 0) as 0 | 1 | 2,
    aiType: raw.ai_type === undefined ? undefined : Number(raw.ai_type),
    url: String(raw.url ?? `https://www.pixiv.net/artworks/${raw.id}`),
    width: raw.width === undefined ? undefined : Number(raw.width),
    height: raw.height === undefined ? undefined : Number(raw.height),
  };
}
