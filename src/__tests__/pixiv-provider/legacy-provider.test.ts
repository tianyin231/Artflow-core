import { LegacyPixivProvider } from '../../pixiv-provider/LegacyPixivProvider';
import { PixivWork } from '../../pixiv-provider/types';

const work: PixivWork = {
  id: '1',
  type: 'illust',
  title: 't',
  authorId: 'a',
  authorName: 'n',
  tags: [],
  createdAt: '2025-01-01T00:00:00Z',
  pageCount: 1,
  xRestrict: 0,
  url: 'https://x',
};

describe('LegacyPixivProvider', () => {
  it('wraps search/query/download callbacks', async () => {
    const provider = new LegacyPixivProvider({
      authStatus: async () => ({ authenticated: true, accounts: [] }),
      search: async () => [work],
      detail: async (id) => ({ ...work, id }),
      runDownload: async () => ({ files: ['/tmp/1_p0.png'] }),
    });
    const works = [];
    for await (const w of provider.query({ kind: 'search', limit: 5 })) works.push(w);
    expect(works).toHaveLength(1);
    const dl = await provider.download(['1'], '/tmp');
    expect(dl.files[0].path).toBe('/tmp/1_p0.png');
  });
});
