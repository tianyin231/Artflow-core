/**
 * FixturePixivProvider unit tests (M3).
 */
import { mkdtempSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixturePixivProvider } from '../../pixiv-provider/FixturePixivProvider';
import { PixivProviderError } from '../../pixiv-provider/types';

describe('FixturePixivProvider', () => {
  let provider: FixturePixivProvider;
  let tmp: string;

  beforeEach(() => {
    provider = new FixturePixivProvider();
    tmp = mkdtempSync(join(tmpdir(), 'artflow-fixture-'));
  });

  it('authStatus reports fixture account', async () => {
    const s = await provider.authStatus();
    expect(s.authenticated).toBe(true);
    expect(s.accounts[0].userId).toBe('fixture-user');
  });

  it('has at least 30 fixture works', async () => {
    let n = 0;
    for await (const _ of provider.query({ kind: 'search', limit: 100 })) n++;
    expect(n).toBeGreaterThanOrEqual(30);
  });

  it('filters by minBookmarks', async () => {
    const all: number[] = [];
    for await (const w of provider.query({ kind: 'search', limit: 100 })) {
      all.push(w.bookmarks ?? 0);
    }
    const min = Math.max(...all) - 10;
    let count = 0;
    for await (const w of provider.query({ kind: 'search', limit: 100, minBookmarks: min })) {
      expect(w.bookmarks).toBeGreaterThanOrEqual(min);
      count++;
    }
    expect(count).toBeGreaterThan(0);
  });

  it('filters by date range', async () => {
    let count = 0;
    for await (const w of provider.query({
      kind: 'search',
      limit: 100,
      startDate: '2025-06-01',
      endDate: '2025-06-30',
    })) {
      const d = new Date(w.createdAt);
      expect(d.getTime()).toBeGreaterThanOrEqual(new Date('2025-06-01').getTime());
      expect(d.getTime()).toBeLessThanOrEqual(new Date('2025-07-01').getTime());
      count++;
    }
    expect(count).toBeGreaterThan(0);
  });

  it('excludes AI works when aiMode=exclude', async () => {
    for await (const w of provider.query({ kind: 'search', limit: 100, aiMode: 'exclude' })) {
      expect(w.aiType).not.toBe(2);
    }
  });

  it('detail returns work and throws NOT_FOUND for missing', async () => {
    const w = await provider.detail('100001');
    expect(w.id).toBe('100001');
    await expect(provider.detail('nope')).rejects.toBeInstanceOf(PixivProviderError);
  });

  it('download writes PNG files and reports sizes', async () => {
    const res = await provider.download(['100001', '100002'], tmp);
    expect(res.files.length).toBeGreaterThanOrEqual(2);
    for (const f of res.files) {
      expect(existsSync(f.path)).toBe(true);
      expect(statSync(f.path).size).toBeGreaterThan(0);
    }
  });

  it('respects limit', async () => {
    let n = 0;
    for await (const _ of provider.query({ kind: 'search', limit: 5 })) n++;
    expect(n).toBe(5);
  });
});
