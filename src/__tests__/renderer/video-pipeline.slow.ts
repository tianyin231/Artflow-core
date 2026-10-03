/**
 * @slow — ffmpeg ugoira + loudnorm smoke
 */
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
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
    for (let i = 0; i < 2; i++) {
      const p = join(dir, `f${i}.png`);
      makePng(p, [20 * i + 40, 80, 120]);
      frames.push({ file: p, delayMs: i === 0 ? 200 : 800 });
    }
    const out = join(dir, 'out.mp4');
    const result = await ugoiraToMp4({ frames, output: out, width: 320, height: 180 });
    expect(existsSync(result.path)).toBe(true);
    const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], { encoding: 'utf8' }).trim());
    expect(Math.abs(duration - 1.0)).toBeLessThanOrEqual(1 / 30);
    expect(result.durationSec).toBe(duration);
  }, 60000);

  it('normalizes a quiet audio stream to the requested loudness', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loud-'));
    const input = join(dir, 'quiet.wav');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-af', 'volume=0.05', input]);
    const out = join(dir, 'normalized.wav');
    await loudnorm(input, out, -14);
    expect(existsSync(out)).toBe(true);
    const measured = spawnSync('ffmpeg', ['-i', out, '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'], { encoding: 'utf8' });
    expect(measured.status).toBe(0);
    const loudness = Number(measured.stderr.match(/"input_i"\s*:\s*"([\d.-]+)"/)?.[1]);
    expect(Math.abs(loudness + 14)).toBeLessThan(1);
  }, 60000);
});
