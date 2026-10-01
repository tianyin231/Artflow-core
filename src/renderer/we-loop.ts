/**
 * Wallpaper Engine seamless loop helper (F2-M3).
 */
import { execFile } from 'node:child_process';

export function parseSsim(ffprobeOut: string): number {
  const m = ffprobeOut.match(/SSIM Y:([0-9.]+)/) || ffprobeOut.match(/All:([0-9.]+)/);
  return m ? Number(m[1]) : 0;
}

export async function ssim(firstFrame: string, lastFrame: string): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      ['-i', firstFrame, '-i', lastFrame, '-lavfi', 'ssim', '-f', 'null', '-'],
      { timeout: 30000 },
      (_err, _out, stderr) => {
        if (!stderr && _err) reject(_err);
        else resolve(parseSsim(String(stderr)));
      }
    );
  });
}

export function isSeamlessLoop(score: number, threshold = 0.95): boolean {
  return score >= threshold;
}
