import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolvePython } from '../../runtime/resolvePython';
import { WorkflowManager } from '../../workflow/WorkflowManager';
import { WorkflowImageAsset, WorkflowPlan, WorkflowTask } from '../../workflow/types';
import { parseSrt } from '../../renderer/subtitles';
import * as config from '../../config';
import { logger } from '../../logger';

interface TestManager {
  createPlan(command: string): WorkflowPlan;
  createStages(): WorkflowTask['stages'];
  persistTask(task: WorkflowTask): void;
  applyAiEffectPlan(task: WorkflowTask, assets: WorkflowImageAsset[]): Promise<void>;
  renderAndPauseForReview(task: WorkflowTask, assets: WorkflowImageAsset[]): Promise<void>;
}

it('renders chosen covers/transitions and subtitle files from the workflow plan @slow', async () => {
  jest.spyOn(config, 'loadConfig').mockReturnValue({ runtime: { python: resolvePython() } } as config.StandaloneConfig);
  jest.spyOn(logger, 'info').mockImplementation(() => {});
  const dir = mkdtempSync(join(tmpdir(), 'artflow-options-'));
  const internal = new WorkflowManager() as unknown as TestManager;
  const task: WorkflowTask = {
    id: `render-options-${Date.now()}`, command: 'test', status: 'running', createdAt: '', updatedAt: '', logs: [],
    plan: internal.createPlan('test'), assets: [], stages: internal.createStages(),
  };
  const outputDir = resolve('workflow_runs', task.id);
  jest.spyOn(internal, 'persistTask').mockImplementation(() => {});
  jest.spyOn(internal, 'applyAiEffectPlan').mockResolvedValue();
  try {
    for (let i = 0; i < 2; i++) {
      const path = join(dir, `${100 + i}_Art.png`);
      execFileSync(resolvePython(), ['-c', 'from PIL import Image; import sys; Image.new("RGB", (320,180), tuple(map(int, sys.argv[2:]))).save(sys.argv[1])', path, i ? '0' : '255', '0', i ? '255' : '0']);
      task.assets.push({ path, name: `${100 + i}_Art.png`, width: 320, height: 180, size: 100, status: 'accepted', pixivId: String(100 + i), author: { id: '1', name: `Author ${i}` } });
    }
    Object.assign(task.plan!.video, { width: 320, height: 180, fps: 12, maxImages: 2, secondsPerImage: 0.5,
      totalDuration: 1.5, disclaimer: { enabled: false }, transition: 'flash-white', coverTemplate: 'collage', subtitles: 'srt' });
    await internal.renderAndPauseForReview(task, task.assets);
    expect(task.status).toBe('review_required');
    expect(existsSync(task.videoPath!)).toBe(true);
    expect(existsSync(task.coverPath!)).toBe(true);
    const cues = parseSrt(readFileSync(task.subtitlePath!, 'utf8'));
    expect(cues).toHaveLength(2);
    expect(cues.map((cue) => cue.text).join(' ')).toContain('Author');
    expect(cues[1].endSec).toBeCloseTo(1.5, 2);
    const firstVideoPath = task.videoPath!;
    const firstVideoBytes = readFileSync(firstVideoPath);
    const pixel = (path: string, x: number, y: number) => {
      const frame = execFileSync('ffmpeg', ['-v', 'error', '-ss', '0.75', '-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
      return [...frame.subarray((y * 320 + x) * 3, (y * 320 + x) * 3 + 3)];
    };
    expect(Math.min(...pixel(firstVideoPath, 160, 45))).toBeGreaterThan(230);
    const dimensions = execFileSync(resolvePython(), ['-c', 'from PIL import Image; import sys; print(Image.open(sys.argv[1]).size)', task.coverPath!], { encoding: 'utf8' });
    expect(dimensions.trim()).toBe('(1280, 720)');

    // A second render changes the actual sidecar format and cover layout.
    Object.assign(task.plan!.video, { transition: 'push-left', coverTemplate: 'single', subtitles: 'ass' });
    await internal.renderAndPauseForReview(task, task.assets);
    expect(task.videoPath).not.toBe(firstVideoPath);
    expect(readFileSync(firstVideoPath)).toEqual(firstVideoBytes);
    const left = pixel(task.videoPath!, 80, 45);
    const right = pixel(task.videoPath!, 240, 45);
    expect(Math.abs(left[0] - right[0])).toBeGreaterThan(100);
    expect(task.subtitlePath).toMatch(/\.ass$/);
    expect(readFileSync(task.subtitlePath!, 'utf8')).toContain('Dialogue:');

    for (const transition of ['crossfade', 'kenburns-zoom-in', 'blur-in'] as const) {
      task.plan!.video.transition = transition;
      await internal.renderAndPauseForReview(task, task.assets);
      expect(task.status).toBe('review_required');
      expect(existsSync(task.videoPath!)).toBe(true);
      if (transition === 'crossfade') {
        const center = pixel(task.videoPath!, 160, 45);
        expect(center[0]).toBeGreaterThan(60);
        expect(center[2]).toBeGreaterThan(60);
        expect(center[0]).toBeLessThan(200);
      }
    }
  } finally {
    jest.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
    rmSync(outputDir, { recursive: true, force: true });
  }
}, 60000);
