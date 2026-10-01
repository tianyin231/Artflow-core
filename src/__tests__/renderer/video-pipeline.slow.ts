/**
 * @slow — ffmpeg ugoira + loudnorm smoke
 */
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ugoiraToMp4, loudnorm } from '../../renderer/ugoira';
import { resolvePython } from '../../runtime/resolvePython';

function makePng(path: string, rgb: [number, number, number]): void {
  const py = resolvePython();
  execFileSync(py, [
    '-c',
    `from PIL import Image; Image.new('RGB',(320,180),(${rgb.join(',')})).save(${JSON.stringify(path)})`,
  ]);
}

describe('video pipeline @slow', () => {
  it('converts ugoira frames to mp4 within 1 frame of delay sum', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ugoira-'));
    const frames = [];
    for (let i = 0; i < 4; i++) {
      const p = join(dir, `f${i}.png`);
      makePng(p, [20 * i + 40, 80, 120]);
      frames.push({ file: p, delayMs: 250 });
    }
    const out = join(dir, 'out.mp4');
    const result = await ugoiraToMp4({ frames, output: out, width: 320, height: 180 });
    expect(existsSync(result.path)).toBe(true);
    expect(Math.abs(result.durationSec - 1.0)).toBeLessThanOrEqual(0.1);
  }, 60000);

  it('loudnorm produces a file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loud-'));
    const frames = [{ file: join(dir, 'f.png'), delayMs: 500 }];
    makePng(frames[0].file, [10, 10, 10]);
    const vid = join(dir, 'v.mp4');
    await ugoiraToMp4({ frames, output: vid, width: 320, height: 180 });
    const out = join(dir, 'n.mp4');
    await loudnorm(vid, out, -14);
    expect(existsSync(out)).toBe(true);
  }, 60000);
});
