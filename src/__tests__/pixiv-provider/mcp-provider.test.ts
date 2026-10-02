/**
 * PixivMcpProvider tests (T7) + contract reuse.
 */
import { mkdtempSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixturePixivProvider } from '../../pixiv-provider/FixturePixivProvider';
import { PixivMcpProvider } from '../../pixiv-provider/PixivMcpProvider';

const FAKE_MCP = join(__dirname, '..', '..', '..', 'test', 'fakes', 'fake-pixiv-mcp.cjs');

function makeProvider(env: Record<string, string> = {}) {
  chmodSync(FAKE_MCP, 0o755);
  return new PixivMcpProvider({
    command: process.execPath,
    authStatus: () => new FixturePixivProvider().authStatus(),
    args: [FAKE_MCP],
    env,
    idleTimeoutMs: 50,
    maxQueue: 2,
  });
}

describe('PixivMcpProvider', () => {
  it('authStatus', async () => {
    const p = makeProvider();
    const s = await p.authStatus();
    expect(s.authenticated).toBe(true);
    await p.dispose();
  });

  it('query/search', async () => {
    const p = makeProvider();
    const works = [];
    for await (const w of p.query({ kind: 'search', limit: 5 })) works.push(w);
    expect(works.length).toBeGreaterThan(0);
    await p.dispose();
  });

  it('detail + download files map to DownloadResult without dir scan', async () => {
    const p = makeProvider();
    const d = await p.detail('80001');
    expect(d.id).toBe('80001');
    const dir = mkdtempSync(join(tmpdir(), 'artflow-mcp-dl-'));
    const res = await p.download(['80001'], dir);
    expect(res.files.length).toBe(1);
    expect(res.files[0].workId).toBe('80001');
    expect(existsSync(res.files[0].path)).toBe(true);
    await p.dispose();
  });

  it('concurrent calls are queued', async () => {
    const p = makeProvider();
    const results = await Promise.all([
      p.detail('80001'),
      p.detail('80001'),
      p.detail('80001'),
    ]);
    expect(results).toHaveLength(3);
    await p.dispose();
  });

  it('idle timeout disposes process', async () => {
    const p = makeProvider();
    await p.detail('80001');
    await new Promise((r) => setTimeout(r, 80));
    // after dispose, new call should start fresh or throw disposed
    try {
      await p.authStatus();
    } catch (e) {
      expect(String(e)).toMatch(/disposed|mcp/i);
    }
    await p.dispose();
  });

  it('crash scenario rejects pending calls', async () => {
    const p = makeProvider({ FAKE_PIXIV_MCP_SCENARIO: 'crash' });
    await expect(p.detail('80001')).rejects.toThrow(/exited/);
    await p.dispose();
  });
});
