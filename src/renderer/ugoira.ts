/**
 * Ugoira → video conversion (F2-M3).
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { concatFile, positiveNumber, probeVideo, runMediaProcess, videoDimension } from './ffmpeg';

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
  if (frames.length === 0) throw new Error('No ugoira frames provided');
  return frames.map((f) => `${concatFile(f.file)}\nduration ${(positiveNumber(f.delayMs, 'delayMs') / 1000).toFixed(6)}`).join('\n') + `\n${concatFile(frames[frames.length - 1].file)}\n`;
}

export async function ugoiraToMp4(input: UgoiraInput): Promise<{ path: string; durationSec: number }> {
  const output = resolve(input.output);
  mkdirSync(dirname(output), { recursive: true });
  const listPath = `${output}-${randomUUID()}.txt`;
  writeFileSync(listPath, buildConcatList(input.frames));
  const fps = positiveNumber(input.fps ?? 30, 'fps');
  const width = input.width === undefined ? undefined : videoDimension(input.width, 'width');
  const height = input.height === undefined ? width : videoDimension(input.height, 'height');
  if (width === undefined && height !== undefined) throw new Error('width is required with height');
  const vf = width
    ? `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`
    : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  const args = [
    '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listPath,
    '-filter_threads', '1', '-vf', `${vf},fps=${fps},tpad=stop_mode=clone:stop_duration=${totalDurationMs(input.frames) / 1000}`, '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-t', String(totalDurationMs(input.frames) / 1000),
    '-c:v', 'libx264', '-preset', 'ultrafast', output,
  ];
  try {
    await runMediaProcess('ffmpeg', args, 60_000);
    return { path: output, durationSec: (await probeVideo(output)).durationSec };
  } finally {
    rmSync(listPath, { force: true });
  }
}

/** Loudness-normalize audio to target LUFS (default -14). */
export async function loudnorm(inputPath: string, outputPath: string, targetLufs = -14): Promise<void> {
  if (!Number.isFinite(targetLufs) || targetLufs < -70 || targetLufs > -5) throw new Error('targetLufs must be between -70 and -5');
  const args = [
    '-y', '-v', 'error', '-i', inputPath,
    '-af', `loudnorm=I=${targetLufs}:TP=-1.5:LRA=11`,
    outputPath,
  ];
  await runMediaProcess('ffmpeg', args, 60_000);
}
