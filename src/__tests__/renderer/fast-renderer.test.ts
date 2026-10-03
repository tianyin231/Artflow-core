/**
 * FastRenderer + mock-servers tests (M3).
 */
import { mkdtempSync, existsSync, writeFileSync, rmSync } from 'node:fs';
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
  it('keeps the final image duration and requested frame rate', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'artflow-render-'));
    const images: string[] = [];
    for (let i = 0; i < 3; i++) {
      const p = join(tmp, `img${i}.png`);
      makeTinyPng(p);
      images.push(p);
    }
    const renderer = new FastRenderer();
    const out = await renderer.render({ images }, { secondsPerImage: 0.5, fps: 12 }, tmp);
    expect(existsSync(out.videoPath)).toBe(true);
    expect(out.durationSec).toBeLessThanOrEqual(5);

    // ffprobe
    const probe = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out.videoPath],
      { encoding: 'utf8' }
    );
    const dur = Number(probe.trim());
    expect(Math.abs(dur - 1.5)).toBeLessThanOrEqual(1 / 12);
    expect(out.durationSec).toBe(dur);
    expect(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', out.videoPath], { encoding: 'utf8' }).trim()).toBe('12/1');
    rmSync(tmp, { recursive: true, force: true });
  }, 30000);

  it('rejects invalid timing before starting ffmpeg', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'artflow-render-'));
    const image = join(tmp, 'image.png');
    makeTinyPng(image);
    await expect(new FastRenderer().render({ images: [image] }, { secondsPerImage: NaN }, tmp)).rejects.toThrow('secondsPerImage');
    rmSync(tmp, { recursive: true, force: true });
  });
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
