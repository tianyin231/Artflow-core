/**
 * Renderer interface + fast ffmpeg slideshow renderer.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolvePython } from '../runtime/resolvePython';

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

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
    child.on('error', (e) => resolvePromise({ code: 1, stdout, stderr: String(e) }));
  });
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
    const videoPath = join(outputDir, `render-${Date.now()}.mp4`);
    const width = plan.width ?? 854;
    const height = plan.height ?? 480;
    const per = Math.max(0.3, plan.secondsPerImage ?? 0.5);
    const maxImages = Math.max(1, Math.min(images.length, Math.floor(5 / per)));
    const selected = images.slice(0, maxImages);
    const duration = Math.min(5, selected.length * per);

    // Build concat demuxer list
    const listPath = join(outputDir, `list-${Date.now()}.txt`);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      listPath,
      selected.map((p) => `file '${p.replace(/'/g, "'\\''")}'\nduration ${per}`).join('\n') + '\n'
    );

    const args = [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
      '-pix_fmt', 'yuv420p',
      '-t', String(duration),
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      videoPath,
    ];
    const res = await run('ffmpeg', args);
    if (res.code !== 0 || !existsSync(videoPath)) {
      throw new Error(`FastRenderer ffmpeg failed: ${res.stderr.slice(-400)}`);
    }
    const size = statSync(videoPath).size;
    return { videoPath, durationSec: duration, width, height };
  }
}

/** MoviePy renderer — invokes scripts/workflow-render-video.py via resolvePython(). */
export class MoviePyRenderer implements Renderer {
  readonly id = 'moviepy' as const;

  async render(assets: RenderAssets, plan: RenderPlan, outputDir: string): Promise<RenderResult> {
    mkdirSync(outputDir, { recursive: true });
    const videoPath = join(outputDir, `moviepy-${Date.now()}.mp4`);
    const configPath = join(outputDir, `render-config-${Date.now()}.json`);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      configPath,
      JSON.stringify({
        imagePaths: assets.images,
        outputPath: videoPath,
        size: { width: plan.width ?? 1280, height: plan.height ?? 720 },
        fps: plan.fps ?? 24,
        // script enforces minimum 4s per image
        secondsPerImage: Math.max(4, plan.secondsPerImage ?? 4),
        crossfade: 0.35,
        zoom: 1.04,
        shuffleSeed: 1,
        maxImages: assets.images.length,
        title: plan.title ?? 'Artflow',
        bgmPath: assets.bgmPath ?? null,
      })
    );
    const script = resolve(__dirname, '..', '..', 'scripts', 'workflow-render-video.py');
    const py = resolvePython();
    const res = await run(py, [script, configPath]);
    if (res.code !== 0 || !existsSync(videoPath)) {
      throw new Error(`MoviePyRenderer failed: ${res.stderr.slice(-500)}`);
    }
    return {
      videoPath,
      durationSec: plan.totalDurationSec ?? plan.secondsPerImage! * assets.images.length,
      width: plan.width ?? 1280,
      height: plan.height ?? 720,
    };
  }
}

export function createRenderer(id: 'moviepy' | 'fast' = 'fast'): Renderer {
  return id === 'moviepy' ? new MoviePyRenderer() : new FastRenderer();
}
