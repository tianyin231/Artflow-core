import { normalizeWork, parseAccounts } from '../../pixiv-provider/protocol';

it('reads the public pixiv-cli account envelope and default identity', () => {
  expect(parseAccounts({ default_user_id: 42, accounts: [
    { user_id: 41, username: 'first', default: false, has_token: true },
    { user_id: 42, username: 'active', default: true, has_token: true },
  ] })).toEqual({ authenticated: true, accounts: [
    { userId: '41', name: 'first', isDefault: false },
    { userId: '42', name: 'active', isDefault: true },
  ] });
  expect(parseAccounts({ default_user_id: 42, accounts: [{ user_id: 42, has_token: false }] }).authenticated).toBe(false);
});

it('reads nested user and snake-case ArtworkDTO fields', () => {
  expect(normalizeWork({ id: 123, kind: 'manga', user: { id: 42, name: 'artist' },
    published_at: '2026-10-02T00:00:00Z', total_bookmarks: 12, total_views: 100,
    page_count: 3, ai_type: 2, tags: [{ name: 'test' }] })).toMatchObject({
    id: '123', type: 'manga', authorId: '42', authorName: 'artist',
    createdAt: '2026-10-02T00:00:00Z', bookmarks: 12, views: 100, pageCount: 3, aiType: 2, tags: ['test'],
  });
});
