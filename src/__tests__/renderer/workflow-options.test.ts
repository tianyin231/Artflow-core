import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowManager, workflowManager } from '../../workflow/WorkflowManager';
import { WorkflowPlan, WorkflowTask } from '../../workflow/types';
import { validateRenderOptions } from '../../renderer/options';
import router from '../../webui/routes/workflow';

interface TestManager {
  tasks: Map<string, WorkflowTask>;
  restored: boolean;
  createPlan(command: string): WorkflowPlan;
  persistTask(task: WorkflowTask): void;
  renderAndPauseForReview(task: WorkflowTask): Promise<void>;
}

describe('workflow render options', () => {
  let manager: WorkflowManager;
  let internal: TestManager;
  let task: WorkflowTask;
  beforeEach(() => {
    manager = new WorkflowManager();
    internal = manager as unknown as TestManager;
    internal.restored = true;
    task = {
      id: 'render-test', command: 'test', status: 'review_required', createdAt: '', updatedAt: '', logs: [],
      videoPath: '/old/video.mp4', subtitlePath: '/old/video.srt', plan: internal.createPlan('test'),
      assets: [{ name: 'image.png', path: '/image.png', width: 320, height: 180, size: 1, status: 'accepted' }],
      stages: [{ id: 'render', label: 'render', status: 'completed', message: '', progress: 100 }],
    };
    internal.tasks.set(task.id, task);
    jest.spyOn(internal, 'persistTask').mockImplementation(() => {});
    jest.spyOn(internal, 'renderAndPauseForReview').mockResolvedValue();
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([null, [], 'crossfade', { transition: 'unknown' }, { coverTemplate: 'unknown' }, { subtitles: ['srt'] }, { subtitles: 'vtt' }])(
    'rejects invalid options without discarding an existing video: %j', (options) => {
      const before = JSON.stringify(task);
      expect(() => manager.rerenderVideo(task.id, undefined, options as never)).toThrow();
      expect(JSON.stringify(task)).toBe(before);
      expect(internal.renderAndPauseForReview).not.toHaveBeenCalled();
    });

  it('persists valid choices, clears stale subtitles, and blocks a parallel render', () => {
    const result = manager.rerenderVideo(task.id, 'render again', { transition: 'flash-white', coverTemplate: 'collage', subtitles: 'none' });
    expect(result.plan!.video).toMatchObject({ transition: 'flash-white', coverTemplate: 'collage', subtitles: 'none' });
    expect(result.subtitlePath).toBeUndefined();
    expect(result.status).toBe('running');
    expect(() => manager.rerenderVideo(task.id)).toThrow('not ready');
    expect(internal.renderAndPauseForReview).toHaveBeenCalledTimes(1);
  });

  it('allows a failed render to be retried before a video exists', () => {
    task.status = 'failed';
    task.videoPath = undefined;
    expect(manager.rerenderVideo(task.id).status).toBe('running');
  });

  it('preserves an approved task while its publication is in flight', () => {
    task.status = 'approved';
    const before = JSON.stringify(task);
    expect(() => manager.rerenderVideo(task.id)).toThrow('not ready');
    expect(JSON.stringify(task)).toBe(before);
    expect(internal.renderAndPauseForReview).not.toHaveBeenCalled();
  });

  it('accepts an omitted options object but rejects unknown fields', () => {
    expect(validateRenderOptions(undefined)).toEqual({});
    expect(() => validateRenderOptions({ extra: 1 })).toThrow('Unknown render option');
  });

  it('serves the generated subtitle file through the task endpoint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'artflow-subtitles-'));
    const path = join(dir, 'video.srt');
    writeFileSync(path, '1\n00:00:00,000 --> 00:00:01,000\nAuthor\n');
    task.subtitlePath = path;
    jest.spyOn(workflowManager, 'getTask').mockReturnValue(task);
    const app = express().use('/api/workflow', router);
    try {
      const response = await request(app).get(`/api/workflow/tasks/${task.id}/subtitles`).expect(200);
      expect(response.headers['content-disposition']).toContain('video.srt');
      task.subtitlePath = undefined;
      await request(app).get(`/api/workflow/tasks/${task.id}/subtitles`).expect(404);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
