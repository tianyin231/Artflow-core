/**
 * @slow — MoviePy renderer integration (run via npm run test:slow)
 */
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
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
  it('renders 3 images at 720p for ~6s', async () => {
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
      { secondsPerImage: 2, width: 1280, height: 720, fps: 24, title: 'Artflow MoviePy Smoke' },
      tmp
    );
    expect(existsSync(out.videoPath)).toBe(true);
    const probe = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out.videoPath],
      { encoding: 'utf8' }
    );
    const dur = Number(probe.trim());
    expect(dur).toBeGreaterThan(1);
    expect(dur).toBeLessThan(30);
  }, 180000);
});
