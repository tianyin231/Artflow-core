/**
 * Ugoira → video conversion (F2-M3).
 */
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface UgoiraFrame {
  file: string;
  delayMs: number;
}

export interface UgoiraInput {
  frames: UgoiraFrame[];
  output: string;
  fps?: number;
  width?: number;
  height?: number;
}

export function totalDurationMs(frames: UgoiraFrame[]): number {
  return frames.reduce((s, f) => s + f.delayMs, 0);
}

export function expectedFrameCount(frames: UgoiraFrame[]): number {
  return frames.length;
}

/** Build ffmpeg concat list using each frame's delay. */
export function buildConcatList(frames: UgoiraFrame[]): string {
  return frames.map((f) => `file '${f.file.replace(/'/g, "'\\''")}'\nduration ${(f.delayMs / 1000).toFixed(3)}`).join('\n') + '\n';
}

export async function ugoiraToMp4(input: UgoiraInput): Promise<{ path: string; durationSec: number }> {
  mkdirSync(join(input.output, '..'), { recursive: true });
  const listPath = input.output + '.txt';
  writeFileSync(listPath, buildConcatList(input.frames));
  const fps = input.fps ?? 30;
  const vf = input.width
    ? `scale=${input.width}:${input.height ?? input.width}:force_original_aspect_ratio=decrease`
    : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  const args = [
    '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
    '-vf', vf, '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-c:v', 'libx264', '-preset', 'ultrafast', input.output,
  ];
  await new Promise<void>((resolve, reject) => {
    const child = execFile('ffmpeg', args, { timeout: 60_000 }, (err, _o, stderr) => {
      if (err) reject(new Error(String(stderr).slice(-400)));
      else resolve();
    });
    void child;
  });
  return { path: input.output, durationSec: totalDurationMs(input.frames) / 1000 };
}

/** Loudness-normalize audio to target LUFS (default -14). */
export async function loudnorm(inputPath: string, outputPath: string, targetLufs = -14): Promise<void> {
  const args = [
    '-y', '-i', inputPath,
    '-af', `loudnorm=I=${targetLufs}:TP=-1.5:LRA=11`,
    outputPath,
  ];
  await new Promise<void>((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: 60_000 }, (err, _o, stderr) => {
      if (err) reject(new Error(String(stderr).slice(-400)));
      else resolve();
    });
  });
}
