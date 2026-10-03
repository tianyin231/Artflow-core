import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

export function runMediaProcess(command: string, args: string[], timeout = 600_000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { timeout, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} failed: ${String(stderr || error.message).slice(-800)}`));
      else resolvePromise(stdout);
    });
  });
}

export function positiveNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`);
  return value;
}

export function videoDimension(value: number, name: string): number {
  positiveNumber(value, name);
  if (!Number.isInteger(value) || value % 2 !== 0) throw new Error(`${name} must be an even integer`);
  return value;
}

export function concatFile(path: string): string {
  if (/[\r\n]/.test(path)) throw new Error('Frame path must not contain a newline');
  return `file '${resolve(path).replace(/'/g, "'\\''")}'`;
}

export async function probeVideo(videoPath: string): Promise<{ durationSec: number; width: number; height: number }> {
  if (statSync(videoPath).size === 0) throw new Error('Renderer produced an empty video');
  const result = JSON.parse(await runMediaProcess('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=width,height:format=duration', '-of', 'json', videoPath,
  ], 30_000)) as { streams?: Array<{ width: number; height: number }>; format?: { duration: string } };
  const stream = result.streams?.[0];
  if (!stream) throw new Error('Renderer output has no video stream');
  return { durationSec: positiveNumber(Number(result.format?.duration), 'duration'), width: stream.width, height: stream.height };
}
