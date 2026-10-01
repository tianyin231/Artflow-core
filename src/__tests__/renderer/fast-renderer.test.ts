/**
 * FastRenderer + mock-servers tests (M3).
 */
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { FastRenderer } from '../../renderer';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { startMockServer } = require('../../../test/mock-servers/index.cjs') as {
  startMockServer: (port?: number) => Promise<{ server: import('node:http').Server; port: number }>;
};

function makeTinyPng(path: string): void {
  // 1x1 PNG
  const buf = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  writeFileSync(path, buf);
}

describe('FastRenderer', () => {
  it('produces an mp4 under 5 seconds', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'artflow-render-'));
    const images: string[] = [];
    for (let i = 0; i < 3; i++) {
      const p = join(tmp, `img${i}.png`);
      makeTinyPng(p);
      images.push(p);
    }
    const renderer = new FastRenderer();
    const out = await renderer.render({ images }, { secondsPerImage: 0.5 }, tmp);
    expect(existsSync(out.videoPath)).toBe(true);
    expect(out.durationSec).toBeLessThanOrEqual(5);

    // ffprobe
    const probe = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out.videoPath],
      { encoding: 'utf8' }
    );
    const dur = Number(probe.trim());
    expect(dur).toBeGreaterThan(0);
    expect(dur).toBeLessThanOrEqual(5.5);
  }, 30000);
});

describe('mock-servers', () => {
  let handle: { server: import('node:http').Server; port: number };

  beforeAll(async () => {
    handle = (await startMockServer(0)) as any;
  });

  afterAll(async () => {
    await new Promise((r) => handle.server.close(r));
  });

  it('health endpoint works', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/__health`);
    expect(res.status).toBe(200);
  });

  it('LLM returns deterministic plan JSON', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    const body = (await res.json()) as any;
    expect(body.choices[0].message.content).toContain('pixivTarget');
  });

  it('records requests for assertions', async () => {
    await fetch(`http://127.0.0.1:${handle.port}/v1/chat/completions`, { method: 'POST', body: '{}' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/__requests`);
    const body = (await res.json()) as any;
    expect(body.requests.length).toBeGreaterThan(0);
  });
});
