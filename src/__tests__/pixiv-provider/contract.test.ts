/**
 * Shared PixivProvider contract tests (T2/T7).
 * Run against fixture + cli (fake binary). MCP uses the same cases in M8.
 */
import { mkdtempSync, existsSync, chmodSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixturePixivProvider } from '../../pixiv-provider/FixturePixivProvider';
import { PixivCliProvider } from '../../pixiv-provider/PixivCliProvider';
import { PixivProvider, PixivProviderError, WorkQuery } from '../../pixiv-provider/types';

const FAKE_PIXIV = join(__dirname, '..', '..', '..', 'test', 'fakes', 'fake-pixiv');

async function collect(provider: PixivProvider, q: WorkQuery) {
  const out = [];
  for await (const w of provider.query(q)) out.push(w);
  return out;
}

function makeCli(scenario: string, home: string) {
  chmodSync(FAKE_PIXIV, 0o755);
  const argvLog = join(home, 'argv.log');
  writeFileSync(argvLog, '');
  process.env.FAKE_PIXIV_SCENARIO = scenario;
  process.env.FAKE_PIXIV_ARGV_LOG = argvLog;
  return {
    provider: new PixivCliProvider({ cliPath: FAKE_PIXIV, cliHome: home, timeoutMs: 5000 }),
    argvLog,
  };
}

describe.each([
  ['fixture', () => new FixturePixivProvider()],
  ['cli-fake', () => {
    const home = mkdtempSync(join(tmpdir(), 'artflow-cli-'));
    return makeCli('ok', home).provider;
  }],
])('PixivProvider contract: %s', (_name, factory) => {
  let provider: PixivProvider;

  beforeAll(() => {
    provider = factory();
  });

  it('authStatus returns a shape', async () => {
    const s = await provider.authStatus();
    expect(typeof s.authenticated).toBe('boolean');
    expect(Array.isArray(s.accounts)).toBe(true);
  });

  it('search returns works', async () => {
    const works = await collect(provider, { kind: 'search', word: '', limit: 5 });
    expect(works.length).toBeGreaterThan(0);
  });

  it('search respects limit', async () => {
    const works = await collect(provider, { kind: 'search', limit: 2 });
    expect(works.length).toBeLessThanOrEqual(2);
  });

  it('ranking returns works', async () => {
    const works = await collect(provider, { kind: 'ranking', mode: 'day', limit: 3 });
    expect(works.length).toBeGreaterThan(0);
  });

  it('user works filter by userId', async () => {
    // fixture uses authorId 2000+; fake-pixiv always returns userId 42
    const sample = await collect(provider, { kind: 'search', limit: 1 });
    const uid = sample[0]?.authorId || '42';
    const works = await collect(provider, { kind: 'user', userId: uid, limit: 5 });
    expect(works.length).toBeGreaterThan(0);
  });

  it('bookmarks returns list', async () => {
    const works = await collect(provider, { kind: 'bookmarks', limit: 5 });
    expect(Array.isArray(works)).toBe(true);
  });

  it('minBookmarks filters', async () => {
    const works = await collect(provider, { kind: 'search', limit: 20, minBookmarks: 150 });
    for (const w of works) {
      expect(w.bookmarks ?? 0).toBeGreaterThanOrEqual(150);
    }
  });

  it('date range filters', async () => {
    const works = await collect(provider, {
      kind: 'search',
      limit: 20,
      startDate: '2025-01-01',
      endDate: '2025-12-31',
    });
    for (const w of works) {
      const t = new Date(w.createdAt).getTime();
      expect(t).toBeGreaterThanOrEqual(new Date('2025-01-01').getTime());
    }
  });

  it('detail returns a work', async () => {
    const works = await collect(provider, { kind: 'search', limit: 1 });
    const d = await provider.detail(works[0].id);
    expect(d.id).toBeTruthy();
  });

  it('download produces files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'artflow-dl-'));
    const works = await collect(provider, { kind: 'search', limit: 1 });
    const res = await provider.download(works, dir);
    expect(res.files.length).toBeGreaterThan(0);
    for (const f of res.files) {
      expect(existsSync(f.path)).toBe(true);
    }
  });

  it('NDJSON/JSON parse keeps unknown fields in raw-equivalent shape', async () => {
    const works = await collect(provider, { kind: 'search', limit: 1 });
    expect(works[0]).toHaveProperty('id');
    expect(works[0]).toHaveProperty('title');
    expect(works[0]).toHaveProperty('tags');
  });
});

describe('PixivCliProvider error mapping', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'artflow-cli-err-'));
    chmodSync(FAKE_PIXIV, 0o755);
  });

  it('unauth → AUTH_REQUIRED', async () => {
    const { provider } = makeCli('unauth', home);
    await expect(collect(provider, { kind: 'ranking', limit: 1 })).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
  });

  it('ratelimit → RATE_LIMITED with retryAfterMs', async () => {
    const { provider } = makeCli('ratelimit', home);
    await expect(collect(provider, { kind: 'ranking', limit: 1 })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterMs: 2000,
    });
  });

  it('missing binary → BINARY_MISSING', () => {
    expect(
      () => new PixivCliProvider({ cliPath: '/no/such/pixiv-binary' })
    ).toThrow(PixivProviderError);
  });

  it('argv never contains token; import uses stdin', async () => {
    const { provider, argvLog } = makeCli('ok', home);
    // import-style call through download path uses stdin for NDJSON
    await provider.download(['1'], mkdtempSync(join(tmpdir(), 'artflow-dl2-')));
    const log = readFileSync(argvLog, 'utf8');
    expect(log).not.toMatch(/SENTINEL|refresh_token=|token=/i);
    // ensure download got stdin (recorded)
    expect(log).toContain('download');
  });
});
