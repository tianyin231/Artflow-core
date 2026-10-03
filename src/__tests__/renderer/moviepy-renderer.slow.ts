/**
 * @slow — MoviePy renderer integration (run via npm run test:slow)
 */
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { MoviePyRenderer } from '../../renderer';
import { resolvePython } from '../../runtime/resolvePython';

function makePng(path: string, color: [number, number, number]): void {
  // Use Python/PIL for a real image (moviepy test has python available)
  const py = resolvePython();
  execFileSync(py, [
    '-c',
    `from PIL import Image; Image.new('RGB', (640, 360), (${color.join(',')})).save(${JSON.stringify(path)})`,
  ]);
}

describe('MoviePyRenderer @slow', () => {
  it('honors short clips and reports the encoded duration and dimensions', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'artflow-moviepy-'));
    const images: string[] = [];
    const colors: Array<[number, number, number]> = [
      [220, 80, 100],
      [80, 140, 220],
      [90, 190, 130],
    ];
    for (let i = 0; i < 3; i++) {
      const p = join(tmp, `img${i}.png`);
      makePng(p, colors[i]);
      images.push(p);
    }
    const renderer = new MoviePyRenderer();
    const out = await renderer.render(
      { images },
      { secondsPerImage: 0.5, totalDurationSec: 1.5, width: 320, height: 180, fps: 12, title: 'Artflow MoviePy Smoke' },
      tmp
    );
    expect(existsSync(out.videoPath)).toBe(true);
    const probe = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out.videoPath],
      { encoding: 'utf8' }
    );
    const dur = Number(probe.trim());
    expect(Math.abs(dur - 1.5)).toBeLessThanOrEqual(1 / 12);
    expect(out.durationSec).toBe(dur);
    expect(out.width).toBe(320);
    expect(out.height).toBe(180);
  }, 180000);

  it('returns a finite duration when secondsPerImage is omitted', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'artflow-moviepy-default-'));
    const image = join(tmp, 'image.png');
    makePng(image, [200, 80, 80]);
    const out = await new MoviePyRenderer().render({ images: [image] }, { width: 320, height: 180, fps: 12 }, tmp);
    expect(out.durationSec).toBeCloseTo(4, 1);
  }, 30000);
});
