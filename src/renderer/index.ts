/**
 * Renderer interface + fast ffmpeg slideshow renderer.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolvePython } from '../runtime/resolvePython';
import { resolveWorkflowScript } from '../runtime/resolveWorkflowScript';
import { concatFile, positiveNumber, probeVideo, runMediaProcess, videoDimension } from './ffmpeg';
import { TransitionId } from './transitions';

export interface RenderAssets {
  images: string[];
  coverPath?: string;
  bgmPath?: string;
}

export interface RenderPlan {
  title?: string;
  secondsPerImage?: number;
  width?: number;
  height?: number;
  fps?: number;
  totalDurationSec?: number;
  transition?: TransitionId;
}

export interface RenderResult {
  videoPath: string;
  durationSec: number;
  width: number;
  height: number;
}

export interface Renderer {
  readonly id: 'moviepy' | 'fast';
  render(assets: RenderAssets, plan: RenderPlan, outputDir: string): Promise<RenderResult>;
}

/** Fast ffmpeg slideshow renderer — used for fixture/E2E (≤5s, 480p). */
export class FastRenderer implements Renderer {
  readonly id = 'fast' as const;

  async render(assets: RenderAssets, plan: RenderPlan, outputDir: string): Promise<RenderResult> {
    const images = assets.images.filter((p) => existsSync(p));
    if (images.length === 0) {
      throw new Error('FastRenderer: no images to render');
    }
    mkdirSync(outputDir, { recursive: true });
    const videoPath = resolve(outputDir, `render-${randomUUID()}.mp4`);
    const width = videoDimension(plan.width ?? 854, 'width');
    const height = videoDimension(plan.height ?? 480, 'height');
    const fps = positiveNumber(plan.fps ?? 25, 'fps');
    const per = Math.max(0.3, positiveNumber(plan.secondsPerImage ?? 0.5, 'secondsPerImage'));
    const maxImages = Math.max(1, Math.min(images.length, Math.floor(5 / per)));
    const selected = images.slice(0, maxImages);
    const duration = Math.min(5, selected.length * per, positiveNumber(plan.totalDurationSec ?? 5, 'totalDurationSec'));

    // Build concat demuxer list
    const listPath = `${videoPath}.txt`;
    writeFileSync(
      listPath,
      selected.map((p) => `${concatFile(p)}\nduration ${per}`).join('\n') + `\n${concatFile(selected[selected.length - 1])}\n`
    );

    const args = [
      '-y',
      '-v', 'error',
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      ...(assets.bgmPath ? ['-stream_loop', '-1', '-i', assets.bgmPath, '-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac'] : []),
      '-filter_threads', '1',
      '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${fps},tpad=stop_mode=clone:stop_duration=${duration}`,
      '-pix_fmt', 'yuv420p',
      '-t', String(duration),
      '-r', String(fps),
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      videoPath,
    ];
    try {
      await runMediaProcess('ffmpeg', args, 60_000);
      return { videoPath, ...await probeVideo(videoPath) };
    } finally {
      rmSync(listPath, { force: true });
    }
  }
}

/** MoviePy renderer — invokes scripts/workflow-render-video.py via resolvePython(). */
export class MoviePyRenderer implements Renderer {
  readonly id = 'moviepy' as const;

  async render(assets: RenderAssets, plan: RenderPlan, outputDir: string): Promise<RenderResult> {
    mkdirSync(outputDir, { recursive: true });
    const videoPath = resolve(outputDir, `moviepy-${randomUUID()}.mp4`);
    const configPath = `${videoPath}.json`;
    const secondsPerImage = positiveNumber(plan.secondsPerImage ?? 4, 'secondsPerImage');
    writeFileSync(
      configPath,
      JSON.stringify({
        imagePaths: assets.images.map((path) => resolve(path)),
        outputPath: videoPath,
        size: { width: videoDimension(plan.width ?? 1280, 'width'), height: videoDimension(plan.height ?? 720, 'height') },
        fps: positiveNumber(plan.fps ?? 24, 'fps'),
        secondsPerImage,
        totalDuration: plan.totalDurationSec === undefined ? undefined : positiveNumber(plan.totalDurationSec, 'totalDurationSec'),
        crossfade: Math.min(0.35, secondsPerImage / 2),
        transition: plan.transition,
        zoom: 1.04,
        shuffleSeed: 1,
        maxImages: assets.images.length,
        title: plan.title ?? 'Artflow',
        bgmPath: assets.bgmPath ? resolve(assets.bgmPath) : null,
      })
    );
    const script = resolveWorkflowScript('workflow-render-video.py');
    const py = resolvePython();
    try {
      await runMediaProcess(py, [script, configPath]);
      return { videoPath, ...await probeVideo(videoPath) };
    } finally {
      rmSync(configPath, { force: true });
    }
  }
}

export function createRenderer(id: 'moviepy' | 'fast' = 'fast'): Renderer {
  return id === 'moviepy' ? new MoviePyRenderer() : new FastRenderer();
}
