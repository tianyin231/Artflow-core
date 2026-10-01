import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DownloadManager } from '../download/DownloadManager';
import { FileService, PixivMetadata } from '../download/FileService';
import { PixivAuth } from '../pixiv/AuthClient';
import { PixivClient } from '../pixiv/PixivClient';
import { Database } from '../storage/Database';
import { StandaloneConfig, TargetConfig, loadConfig, getConfigPath } from '../config';
import { logger } from '../logger';
import { withTimeout } from '../utils/timing';
import { resolvePython } from '../runtime/resolvePython';
import {
  BilibiliPublishPackage,
  BilibiliPublishPreview,
  BilibiliPublishSource,
  CreateWorkflowTaskRequest,
  WorkflowImageAsset,
  WorkflowPlan,
  WorkflowPrefilterMode,
  WorkflowProgressEvent,
  WorkflowStage,
  WorkflowStageId,
  WorkflowTask,
  WorkflowVideoMotion,
  WorkflowVideoOverrides,
  WorkflowVideoStyle,
} from './types';
import { AiWorkflowPlanPatch, workflowAiAgent } from './WorkflowAiAgent';
import { downloadWorkflowBgmFromInternet, isSupportedWorkflowBgmPath, listWorkflowBgmCandidates } from './WorkflowBgmLibrary';
import { publishJobService } from './PublishJobService';
import { withWorkflowDatabase } from './workflow-store';

const execFileAsync = promisify(execFile);

const STAGE_LABELS: Record<WorkflowStageId, string> = {
  plan: 'AI 规划',
  download: 'PixivFlow 抓取',
  filter: '图片预过滤',
  image: '封面生成',
  render: 'MoviePy 合成',
  review: '人工审核',
  publish: 'B站发布',
};

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

export class WorkflowManager {
  private tasks = new Map<string, WorkflowTask>();
  private readonly workflowConfigPath = resolve(process.cwd(), 'config', 'standalone.config.json');
  private restored = false;

  public createTask(request: CreateWorkflowTaskRequest): WorkflowTask {
    this.restoreTasks();
    const command = request.command?.trim() || this.describeManualTask(request);

    const now = new Date().toISOString();
    const task: WorkflowTask = {
      id: `wf_${Date.now()}`,
      command,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      stages: this.createStages(),
      assets: [],
      logs: [],
      currentStage: 'plan',
      requiresUserConfirmation: false,
      availableActions: [],
      progressEvents: [],
    };

    this.tasks.set(task.id, task);
    this.persistTask(task);
    this.runTask(task, request).catch((error) => {
      this.failStage(task, this.getActiveStageId(task) ?? 'plan', error);
      task.status = 'failed';
      this.addLog(task, 'error', error instanceof Error ? error.message : String(error));
      this.touch(task);
    });

    return task;
  }

  public getTask(taskId: string): WorkflowTask | undefined {
    this.restoreTasks();
    return this.tasks.get(taskId);
  }

  public listTasks(): WorkflowTask[] {
    this.restoreTasks();
    return Array.from(this.tasks.values()).sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)
    );
  }

  public approveTask(taskId: string, note?: string): WorkflowTask {
    const task = this.requireTask(taskId);
    if (task.status !== 'review_required') {
      throw new Error(`Task ${taskId} is not waiting for review`);
    }

    task.status = 'approved';
    task.review = {
      status: 'approved',
      note,
      reviewedAt: new Date().toISOString(),
    };
    this.completeStage(task, 'review', '审核通过');
    this.addLog(task, 'info', '人工审核通过');
    this.touch(task);

    this.publishDryRun(task).catch((error) => {
      this.failStage(task, 'publish', error);
      task.status = 'failed';
      this.addLog(task, 'error', error instanceof Error ? error.message : String(error));
      this.touch(task);
    });

    return task;
  }

  public rejectTask(taskId: string, note?: string): WorkflowTask {
    const task = this.requireTask(taskId);
    if (!['asset_review_required', 'cover_review_required', 'review_required'].includes(task.status)) {
      throw new Error(`Task ${taskId} is not waiting for review`);
    }

    task.review = {
      status: 'rejected',
      note,
      reviewedAt: new Date().toISOString(),
    };
    this.addLog(task, 'warn', `人工审核驳回${note ? `: ${note}` : ''}`);

    if (task.status === 'asset_review_required') {
      task.status = 'rejected';
      this.failStage(task, 'filter', new Error(note || '素材审核驳回'));
      this.touch(task);
      return task;
    }

    if (task.status === 'cover_review_required') {
      this.setStage(task, 'image', {
        status: 'blocked',
        message: '封面已驳回，请调整素材或重生成封面',
        progress: 100,
        error: undefined,
      });
      task.currentStage = 'image';
      task.requiresUserConfirmation = true;
      task.availableActions = ['approve_cover', 'reject'];
      this.touch(task);
      return task;
    }

    if (task.status === 'review_required') {
      return this.rerenderVideo(taskId, note || '视频审核驳回，重新生成视频');
    }

    this.touch(task);
    return task;
  }

  public continueAfterAssetReview(taskId: string, mode: WorkflowPrefilterMode = 'manual'): WorkflowTask {
    const task = this.requireTask(taskId);
    if (task.status !== 'asset_review_required') {
      throw new Error(`Task ${taskId} is not waiting for asset review`);
    }

    if (mode === 'keep_all') {
      task.assets.forEach((asset) => {
        asset.status = 'accepted';
        asset.reason = undefined;
      });
      this.addLog(task, 'info', '预过滤模式: 全部保留');
    } else if (mode === 'ai_rules') {
      task.assets.forEach((asset) => {
        const rejected = asset.width < 640 || asset.height < 640 || asset.size < 20 * 1024;
        asset.status = rejected ? 'rejected' : 'accepted';
        asset.reason = rejected ? (asset.width < 640 || asset.height < 640 ? '分辨率过低' : '文件过小') : undefined;
      });
      this.addLog(task, 'info', '预过滤模式: AI/规则筛选');
    } else {
      this.addLog(task, 'info', '预过滤模式: 使用人工选择结果');
    }

    const acceptedImages = task.assets.filter((asset) => asset.status === 'accepted');
    if (acceptedImages.length === 0) {
      throw new Error('No images were accepted for cover generation');
    }

    this.completeStage(task, 'filter', `审核完成: 保留 ${acceptedImages.length} 张，剔除 ${task.assets.length - acceptedImages.length} 张`);
    task.status = 'running';
    task.requiresUserConfirmation = false;
    task.availableActions = [];
    this.touch(task);
    this.generateCoverAndPause(task, acceptedImages).catch((error) => {
      this.failStage(task, 'image', error);
      task.status = 'failed';
      this.addLog(task, 'error', error instanceof Error ? error.message : String(error));
      this.touch(task);
    });
    return task;
  }

  public continueAfterCoverReview(taskId: string): WorkflowTask {
    const task = this.requireTask(taskId);
    if (task.status !== 'cover_review_required') {
      throw new Error(`Task ${taskId} is not waiting for cover review`);
    }

    const acceptedImages = task.assets.filter((asset) => asset.status === 'accepted');
    if (acceptedImages.length === 0) {
      throw new Error('No images were accepted for rendering');
    }

    this.completeStage(task, 'image', task.coverPath ? `封面确认完成: ${basename(task.coverPath)}` : '封面确认完成');
    task.status = 'running';
    task.requiresUserConfirmation = false;
    task.availableActions = [];
    this.touch(task);
    this.renderAndPauseForReview(task, acceptedImages).catch((error) => {
      this.failStage(task, 'render', error);
      task.status = 'failed';
      this.addLog(task, 'error', error instanceof Error ? error.message : String(error));
      this.touch(task);
    });
    return task;
  }

  public resumeFailedTask(taskId: string): WorkflowTask {
    const task = this.requireTask(taskId);
    if (task.status !== 'failed') {
      throw new Error(`Task ${taskId} is not failed`);
    }

    const failedStage = task.stages.find((stage) => stage.status === 'failed')?.id ?? task.currentStage;
    const acceptedImages = task.assets.filter((asset) => asset.status === 'accepted');
    if (failedStage === 'image' && acceptedImages.length === 0) {
      throw new Error('No accepted images available for cover generation');
    }
    if (failedStage === 'render' && acceptedImages.length === 0) {
      throw new Error('No accepted images available for rendering');
    }
    if (failedStage === 'publish' && !task.videoPath) {
      throw new Error('No rendered video available for publish package generation');
    }
    if (failedStage !== 'image' && failedStage !== 'render' && failedStage !== 'publish') {
      throw new Error(`Stage ${failedStage || 'unknown'} cannot be resumed. Please create a new workflow task.`);
    }

    task.status = 'running';
    task.requiresUserConfirmation = false;
    task.availableActions = [];
    this.addLog(task, 'info', `从失败阶段继续: ${failedStage || 'unknown'}`);
    this.touch(task);

    if (failedStage === 'image') {
      this.generateCoverAndPause(task, acceptedImages).catch((error) => {
        this.failStage(task, 'image', error);
        task.status = 'failed';
        this.addLog(task, 'error', error instanceof Error ? error.message : String(error));
        this.touch(task);
      });
      return task;
    }

    if (failedStage === 'render') {
      this.renderAndPauseForReview(task, acceptedImages).catch((error) => {
        this.failStage(task, 'render', error);
        task.status = 'failed';
        this.addLog(task, 'error', error instanceof Error ? error.message : String(error));
        this.touch(task);
      });
      return task;
    }

    if (failedStage === 'publish') {
      this.publishDryRun(task).catch((error) => {
        this.failStage(task, 'publish', error);
        task.status = 'failed';
        this.addLog(task, 'error', error instanceof Error ? error.message : String(error));
        this.touch(task);
      });
      return task;
    }

    throw new Error(`Stage ${failedStage || 'unknown'} cannot be resumed. Please create a new workflow task.`);
  }

  public rerenderVideo(
    taskId: string,
    note?: string,
    options?: {
      transition?: string;
      coverTemplate?: string;
      subtitles?: 'none' | 'srt' | 'ass';
    }
  ): WorkflowTask {
    const task = this.requireTask(taskId);
    if (!task.plan) {
      throw new Error('Workflow plan is missing');
    }
    const acceptedImages = task.assets.filter((asset) => asset.status === 'accepted');
    if (acceptedImages.length === 0) {
      throw new Error('No accepted images available for rendering');
    }

    task.status = 'running';
    task.videoPath = undefined;
    task.publish = undefined;
    task.review = { status: 'pending' };
    task.requiresUserConfirmation = false;
    task.availableActions = [];
    this.setStage(task, 'publish', {
      status: 'pending',
      message: '等待中',
      progress: 0,
      error: undefined,
      completedAt: undefined,
    });
    this.setStage(task, 'review', {
      status: 'pending',
      message: '等待视频生成',
      progress: 0,
      error: undefined,
      completedAt: undefined,
    });
    if (options && task.plan) {
      const v = task.plan.video as Record<string, unknown>;
      if (options.transition) v.transition = options.transition;
      if (options.coverTemplate) v.coverTemplate = options.coverTemplate;
      if (options.subtitles) v.subtitles = options.subtitles;
    }
    this.addLog(task, 'info', note || '重新生成视频');
    if (options) {
      this.addLog(
        task,
        'info',
        `渲染选项: 转场=${options.transition ?? '默认'} 封面=${options.coverTemplate ?? '默认'} 字幕=${options.subtitles ?? 'none'}`
      );
    }
    this.touch(task);

    this.renderAndPauseForReview(task, acceptedImages).catch((error) => {
      this.failStage(task, 'render', error);
      task.status = 'failed';
      this.addLog(task, 'error', error instanceof Error ? error.message : String(error));
      this.touch(task);
    });
    return task;
  }

  public async regenerateCover(
    taskId: string,
    options: { assetNames?: string[]; layout?: string; title?: string } = {}
  ): Promise<WorkflowTask> {
    const task = this.requireTask(taskId);
    if (task.status !== 'cover_review_required') {
      throw new Error(`Task ${taskId} is not waiting for cover review`);
    }

    const selectedNames = new Set((options.assetNames ?? []).filter(Boolean));
    const candidates = task.assets.filter((asset) =>
      asset.status === 'accepted' && (selectedNames.size === 0 || selectedNames.has(asset.name))
    );
    if (candidates.length === 0) {
      throw new Error('No accepted images selected for cover regeneration');
    }

    this.startStage(task, 'image', '正在按手动选择重生成封面');
    task.coverPath = await this.generateCover(
      task,
      candidates.map((asset) => asset.path).slice(0, 6),
      options.layout,
      options.title
    );
    task.latestArtifact = { type: 'cover', path: task.coverPath, name: basename(task.coverPath) };
    this.addProgressEvent(task, 'image', 'cover', `封面已重生成: ${basename(task.coverPath)}`, {
      artifactPath: task.coverPath,
    });
    this.setStage(task, 'image', {
      status: 'blocked',
      message: `封面已重生成，等待确认: ${basename(task.coverPath)}`,
      progress: 100,
      completedAt: new Date().toISOString(),
      error: undefined,
    });
    task.status = 'cover_review_required';
    task.currentStage = 'image';
    task.requiresUserConfirmation = true;
    task.availableActions = ['approve_cover', 'reject'];
    this.addLog(task, 'info', `手动重生成封面: ${options.layout || 'grid'} · ${candidates.length} 张素材`);
    this.touch(task);
    return task;
  }

  public updateAssetStatus(taskId: string, assetName: string, status: 'accepted' | 'rejected', reason?: string): WorkflowTask {
    const task = this.requireTask(taskId);
    const asset = task.assets.find((item) => item.name === assetName);
    if (!asset) {
      throw new Error(`Asset ${assetName} not found in task ${taskId}`);
    }

    asset.status = status;
    asset.reason = status === 'rejected' ? reason || '人工剔除' : undefined;
    this.addLog(task, status === 'accepted' ? 'info' : 'warn', `人工${status === 'accepted' ? '通过' : '剔除'}素材: ${asset.name}`);
    this.touch(task);
    return task;
  }

  public getAssetPath(taskId: string, assetName: string): string {
    const task = this.requireTask(taskId);
    const asset = task.assets.find((item) => item.name === assetName);
    if (!asset) {
      throw new Error(`Asset ${assetName} not found in task ${taskId}`);
    }
    if (!existsSync(asset.path)) {
      throw new Error(`Asset file not found: ${asset.path}`);
    }
    return asset.path;
  }

  public getAssetPathByIndex(taskId: string, assetIndex: number): string {
    const task = this.requireTask(taskId);
    const asset = task.assets[assetIndex];
    if (!asset) {
      throw new Error(`Asset index ${assetIndex} not found in task ${taskId}`);
    }
    if (!existsSync(asset.path)) {
      throw new Error(`Asset file not found: ${asset.path}`);
    }
    return asset.path;
  }

  public getCoverPath(taskId: string): string {
    const task = this.requireTask(taskId);
    if (!task.coverPath || !existsSync(task.coverPath)) {
      throw new Error(`Cover file not found for task ${taskId}`);
    }
    return task.coverPath;
  }

  public previewBilibiliPublish(taskId: string): BilibiliPublishPreview {
    return this.createBilibiliPublishPreview(this.requireTask(taskId));
  }

  private async runTask(task: WorkflowTask, request: CreateWorkflowTaskRequest): Promise<void> {
    this.startStage(task, 'plan', '正在解析自然语言指令');

    const aiPatch = await this.createAiPlanPatch(task, request);
    const plan = this.createPlan(task.command, {
      ...request.videoOverrides,
      ...aiPatch?.videoOverrides,
    });
    this.applyPixivOverrides(plan, request.pixivOverrides);
    this.applyPixivOverrides(plan, aiPatch?.pixivOverrides);
    this.applyPublishOverrides(plan, request.publishOverrides);
    this.applyPublishOverrides(plan, aiPatch?.publishOverrides);
    this.applyAiPlanMetadata(plan, aiPatch);
    this.validateConfiguredBgmPath(task, plan);
    await this.applyAiBgmSelection(task, plan);

    const pixivConfig = this.createPixivConfig(task.id, plan);
    task.plan = plan;
    task.pixivConfig = this.maskPixivConfig(pixivConfig);
    this.completeStage(task, 'plan', aiPatch ? '已生成 AI 工作流计划' : '已生成本地工作流计划');
    this.addLog(task, 'info', `计划生成完成: ${plan.title}`);

    this.startStage(task, 'download', request.dryRunDownload ? '跳过远程抓取，使用本地素材' : '正在调用 PixivFlow 下载');
    const images = request.dryRunDownload
      ? this.collectFallbackImages(pixivConfig, 20)
      : await this.downloadOrFallback(task, pixivConfig);
    this.completeStage(
      task,
      'download',
      request.dryRunDownload
        ? `本地素材准备完成: ${images.length} 张`
        : `Pixiv 素材准备完成: ${images.length} 张`
    );

    this.startStage(task, 'filter', '正在筛选图片分辨率和文件完整性');
    task.assets = await this.filterImages(images, pixivConfig);
    const acceptedImages = task.assets.filter((asset) => asset.status === 'accepted');
    if (acceptedImages.length === 0) {
      throw new Error('No images passed pre-filter');
    }
    this.setStage(task, 'filter', {
      status: 'blocked',
      message: `等待素材预审核: 默认通过 ${acceptedImages.length} 张，剔除 ${task.assets.length - acceptedImages.length} 张`,
      progress: 0,
    });
    task.status = 'asset_review_required';
    task.review = { status: 'pending' };
    task.currentStage = 'filter';
    task.requiresUserConfirmation = true;
    task.availableActions = ['continue_assets_manual', 'continue_assets_keep_all', 'continue_assets_ai_rules', 'reject'];
    this.addLog(task, 'info', '工作流暂停在素材预审核阶段');
    this.touch(task);
    const prefilterMode = request.prefilterMode || aiPatch?.prefilterMode;
    if (prefilterMode && prefilterMode !== 'manual') {
      this.continueAfterAssetReview(task.id, prefilterMode);
    }
  }

  private async createAiPlanPatch(
    task: WorkflowTask,
    request: CreateWorkflowTaskRequest
  ): Promise<AiWorkflowPlanPatch | null> {
    const aiRequired = workflowAiAgent.isAiFirstMode();
    this.addAiLog(task, '工作流规划', '开始', '正在调用 AI 解析自然语言指令');
    try {
      const patch = await workflowAiAgent.planWorkflow(task.command, request);
      if (!patch) {
        if (aiRequired) {
          throw new Error('AI-first 模式已启用，但 AI 未返回规划结果。请检查 AI 设置、API Key、模型或网络连接。');
        }
        this.addAiLog(task, '工作流规划', '跳过', '当前不是 AI-first 模式，使用本地规则规划');
        return null;
      }
      this.addAiLog(task, '工作流规划', '完成', JSON.stringify({
        title: patch.title,
        pixivOverrides: patch.pixivOverrides,
        videoOverrides: patch.videoOverrides,
        publishOverrides: patch.publishOverrides,
        prefilterMode: patch.prefilterMode,
      }));
      if (patch.notes?.length) {
        this.addAiLog(task, '工作流规划说明', '完成', patch.notes.join('；'));
      }
      return patch;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.addAiLog(task, '工作流规划', '失败', message, 'error');
      if (aiRequired) {
        throw new Error(`AI 工作流已停止: ${message}`);
      }
      this.addLog(task, 'warn', `AI Agent 规划失败，回退本地规则: ${message}`);
      return null;
    }
  }

  private async generateCoverAndPause(task: WorkflowTask, acceptedImages: WorkflowImageAsset[]): Promise<void> {
    this.startStage(task, 'image', '正在生成封面');
    task.coverPath = await this.generateCover(task, acceptedImages.map((asset) => asset.path).slice(0, 4), 'grid');
    task.latestArtifact = { type: 'cover', path: task.coverPath, name: basename(task.coverPath) };
    this.addProgressEvent(task, 'image', 'cover', `封面已生成: ${basename(task.coverPath)}`, {
      artifactPath: task.coverPath,
    });
    this.setStage(task, 'image', {
      status: 'blocked',
      message: `封面已生成，等待确认: ${basename(task.coverPath)}`,
      progress: 100,
      completedAt: new Date().toISOString(),
      error: undefined,
    });
    task.status = 'cover_review_required';
    task.currentStage = 'image';
    task.requiresUserConfirmation = true;
    task.availableActions = ['approve_cover', 'reject'];
    this.addLog(task, 'info', '工作流暂停在封面确认阶段');
    this.touch(task);
  }

  private async renderAndPauseForReview(task: WorkflowTask, acceptedImages: WorkflowImageAsset[]): Promise<void> {
    this.startStage(task, 'render', '正在调用 MoviePy 渲染视频');
    const rankedAssets = this.rankVideoAssets(task, acceptedImages);
    await this.applyAiEffectPlan(task, rankedAssets);
    task.videoPath = await this.renderVideo(task, rankedAssets);
    task.latestArtifact = { type: 'video', path: task.videoPath, name: basename(task.videoPath) };
    this.addProgressEvent(task, 'render', 'video', `视频生成完成: ${basename(task.videoPath)}`, {
      artifactPath: task.videoPath,
    });
    this.completeStage(task, 'render', `视频生成完成: ${basename(task.videoPath)}`);

    this.startStage(task, 'review', '等待人工审核');
    this.setStage(task, 'review', {
      status: 'blocked',
      message: '视频已生成，等待人工审核',
      progress: 0,
    });
    task.status = 'review_required';
    task.review = { status: 'pending' };
    task.currentStage = 'review';
    task.requiresUserConfirmation = true;
    task.availableActions = ['approve_video', 'reject'];
    this.addLog(task, 'info', '工作流暂停在视频人工审核阶段');
    this.touch(task);
  }

  private async downloadOrFallback(task: WorkflowTask, config: StandaloneConfig): Promise<string[]> {
    const before = new Set(this.collectLocalImages(config.storage!.illustrationDirectory!, 200));

    // Provider path (fixture / pixiv-cli). Legacy DownloadManager kept for provider=legacy.
    const providerKind =
      (process.env.ARTFLOW_PIXIV_PROVIDER as string) ||
      config.pixiv?.provider ||
      (process.env.ARTFLOW_FIXTURE_MODE === '1' ? 'fixture' : 'legacy');

    if (providerKind === 'fixture' || providerKind === 'pixiv-cli') {
      const { createPixivProvider } = await import('../pixiv-provider/createPixivProvider');
      const provider = createPixivProvider({
        provider: providerKind as 'fixture' | 'pixiv-cli',
        cliPath: config.pixiv?.cliPath,
        cliHome: config.pixiv?.cliHome,
      });
      const target = config.targets?.[0];
      const works: string[] = [];
      for await (const w of provider.query({
        kind: target?.mode === 'ranking' ? 'ranking' : 'search',
        word: target?.tag || target?.filterTag,
        limit: target?.limit ?? 10,
        minBookmarks: target?.minBookmarks,
        startDate: target?.startDate,
        endDate: target?.endDate,
      })) {
        works.push(w.id);
      }
      const dest = config.storage!.illustrationDirectory!;
      await provider.download(works, dest);
      await provider.dispose?.();
      const after = this.collectLocalImages(dest, 200);
      const newImages = after.filter((p) => !before.has(p));
      if (newImages.length === 0) {
        // Provider may write into dest root with flat names; accept any images in dest
        if (after.length > 0) return after.slice(0, target?.limit ?? 20);
        throw new Error('Pixiv provider downloaded 0 images');
      }
      return newImages;
    }

    let database: Database | undefined;
    try {
      database = new Database(config.storage!.databasePath!);
      database.migrate();
      const auth = new PixivAuth(config.pixiv, config.network!, database, this.workflowConfigPath);
      const pixivClient = new PixivClient(auth, config);
      const fileService = new FileService(config.storage!);
      const downloadManager = new DownloadManager(config, pixivClient, database, fileService);
      downloadManager.setProgressCallback((current, total, message) => {
        this.syncDownloadedAssets(task, config, before, total);
        const progress = total > 0 ? Math.round((current / total) * 100) : 0;
        this.setStage(task, 'download', {
          status: 'running',
          message: message || `下载进度 ${current}/${total}`,
          progress,
        });
      });
      await downloadManager.initialise();
      await downloadManager.runAllTargets();
      this.syncDownloadedAssets(task, config, before, config.targets?.[0]?.limit);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.addLog(task, 'error', `PixivFlow 下载失败: ${message}`);
      logger.warn('Workflow download failed', { error });
      throw new Error(`PixivFlow 下载失败，未使用旧素材兜底: ${message}`);
    } finally {
      database?.close();
    }

    const after = this.collectLocalImages(config.storage!.illustrationDirectory!, 200);
    const newImages = after.filter((path) => !before.has(path));
    if (newImages.length === 0) {
      const target = config.targets?.[0];
      const hints = [
        target?.minBookmarks !== undefined ? `收藏阈值 ${target.minBookmarks}` : undefined,
        target?.startDate || target?.endDate ? `时间范围 ${target.startDate ?? '不限'} ~ ${target.endDate ?? '不限'}` : undefined,
        target?.tagWhitelist?.length ? `白名单 ${target.tagWhitelist.join(', ')}` : undefined,
        target?.tagBlacklist?.length ? `黑名单 ${target.tagBlacklist.join(', ')}` : undefined,
      ].filter(Boolean).join('；');
      throw new Error(`Pixiv 本次没有下载到新图片，已停止工作流，未复用旧素材${hints ? `。当前筛选: ${hints}` : ''}`);
    }
    return newImages;
  }

  private syncDownloadedAssets(task: WorkflowTask, config: StandaloneConfig, before: Set<string>, total?: number): void {
    const currentImages = this.collectLocalImages(config.storage!.illustrationDirectory!, 200)
      .filter((path) => !before.has(path));
    const known = new Set(task.assets.map((asset) => asset.path));
    for (const imagePath of currentImages) {
      if (known.has(imagePath)) continue;
      try {
        const asset = this.createPendingAsset(imagePath);
        task.assets.push(asset);
        const assetIndex = task.assets.length - 1;
        task.latestArtifact = {
          type: 'asset',
          path: asset.path,
          name: asset.name,
          assetIndex,
        };
        this.addProgressEvent(task, 'download', 'asset', `下载完成 ${task.assets.length}/${total || currentImages.length}: ${asset.name}`, {
          current: task.assets.length,
          total,
          assetName: asset.name,
          artifactPath: asset.path,
        });
      } catch (error) {
        this.addLog(task, 'warn', `无法记录下载素材: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private createPendingAsset(path: string): WorkflowImageAsset {
    const stats = statSync(path);
    return {
      path,
      name: basename(path),
      width: 0,
      height: 0,
      size: stats.size,
      status: 'accepted',
    };
  }

  private createPlan(command: string, overrides: WorkflowVideoOverrides = {}): WorkflowPlan {
    const today = new Date();
    const start = new Date(today);
    start.setDate(today.getDate() - 7);

    const tag = this.pickTag(command);
    const minBookmarks = this.pickNumber(command, /收藏(?:数)?\s*(\d+)/, command.includes('5000+') ? 5000 : 100);
    const style = overrides.style || this.pickStyle(command);
    const aspectRatio = overrides.aspectRatio || this.pickAspectRatio(command, style);
    const size = this.pickVideoSize(aspectRatio);
    const motion = overrides.motion || this.pickMotion(command, style);
    const maxImages = this.clampNumber(
      overrides.maxImages ?? this.pickNumber(command, /(?:图数|图片数|张数|精选)\s*(\d+)/, 12),
      1,
      80
    );
    const totalDuration = this.clampNumber(
      overrides.totalDuration ?? this.pickNumber(command, /(?:时长|总时长)\s*(\d+)\s*(?:秒|s)?/i, 0),
      0,
      600
    );
    const fps = this.clampNumber(overrides.fps ?? 60, 12, 60);
    const crossfade = this.clampNumber(overrides.crossfade ?? (style === 'soft' ? 0.55 : 0.45), 0, 2);
    const secondsPerImage = this.clampNumber(
      overrides.secondsPerImage ?? (totalDuration > 0 ? (totalDuration + (maxImages - 1) * crossfade) / maxImages : style === 'soft' ? 5 : 4.5),
      0.5,
      20
    );
    const zoom = this.clampNumber(overrides.zoom ?? (style === 'soft' ? 1.015 : 1.04), 1, 1.5);
    const bgmPath = overrides.bgmPath?.trim() || this.pickBgmPath(command);

    return {
      title: `${tag} 自动混剪`,
      description: `${tag} 高收藏插画自动收集与本地视频合成。`,
      pixivTarget: {
        type: 'illustration',
        tag,
        limit: 10,
        searchTarget: 'partial_match_for_tags',
        sort: 'popular_desc',
        minBookmarks,
        startDate: this.formatDate(start),
        endDate: this.formatDate(today),
      },
      video: {
        style,
        motion,
        width: size.width,
        height: size.height,
        fps,
        secondsPerImage,
        crossfade,
        zoom,
        maxImages,
        shuffleSeed: Date.now() % 100000,
        totalDuration: totalDuration || undefined,
        bgmPath: bgmPath || undefined,
        disclaimer: overrides.disclaimer ?? this.createDefaultDisclaimer(),
      },
      publish: {
        platform: 'bilibili',
        dryRun: true,
        category: '动画/MAD·AMV',
        tags: [tag, 'Pixiv', 'fanart'],
        original: false,
        aigc: true,
      },
    };
  }

  private createPixivConfig(taskId: string, plan: WorkflowPlan): StandaloneConfig {
    const baseConfig = loadConfig(this.workflowConfigPath);
    const workflowRoot = resolve(process.cwd(), 'workflow_runs', taskId);
    const taskDownloadDir = join(workflowRoot, 'downloads');
    const target: TargetConfig = {
      ...plan.pixivTarget,
    };

    return {
      ...baseConfig,
      storage: {
        ...baseConfig.storage,
        downloadDirectory: taskDownloadDir,
        illustrationDirectory: join(taskDownloadDir, 'illustrations'),
        novelDirectory: join(taskDownloadDir, 'novels'),
        databasePath: join(workflowRoot, 'workflow-pixiv.db'),
      },
      network: {
        ...baseConfig.network,
        timeoutMs: Math.max(baseConfig.network?.timeoutMs ?? 30000, 120000),
        retries: Math.max(baseConfig.network?.retries ?? 3, 4),
        retryDelay: Math.max(baseConfig.network?.retryDelay ?? 1000, 2000),
      },
      download: {
        ...baseConfig.download,
        concurrency: 1,
        requestDelay: Math.max(baseConfig.download?.requestDelay ?? 500, 1200),
        timeout: Math.max(baseConfig.download?.timeout ?? 60000, 120000),
      },
      targets: [target],
    };
  }

  private applyPixivOverrides(plan: WorkflowPlan, overrides?: CreateWorkflowTaskRequest['pixivOverrides']): void {
    if (!overrides) {
      return;
    }

    const cleaned: Partial<TargetConfig> = {};
    if (overrides.tag?.trim()) cleaned.tag = overrides.tag.trim();
    if (overrides.limit !== undefined) cleaned.limit = this.clampNumber(overrides.limit, 1, 200);
    if (overrides.searchTarget) cleaned.searchTarget = overrides.searchTarget;
    if (overrides.sort) cleaned.sort = overrides.sort;
    if (overrides.mode) cleaned.mode = overrides.mode;
    if (overrides.rankingMode) cleaned.rankingMode = overrides.rankingMode;
    if (overrides.rankingDate?.trim()) cleaned.rankingDate = overrides.rankingDate.trim();
    if (overrides.filterTag?.trim()) cleaned.filterTag = overrides.filterTag.trim();
    if (overrides.minBookmarks !== undefined) cleaned.minBookmarks = this.clampNumber(overrides.minBookmarks, 0, 1000000);
    if (overrides.startDate?.trim()) cleaned.startDate = overrides.startDate.trim();
    if (overrides.endDate?.trim()) cleaned.endDate = overrides.endDate.trim();
    if (overrides.tagWhitelist) cleaned.tagWhitelist = overrides.tagWhitelist.map((tag) => tag.trim()).filter(Boolean);
    if (overrides.tagBlacklist) cleaned.tagBlacklist = overrides.tagBlacklist.map((tag) => tag.trim()).filter(Boolean);

    plan.pixivTarget = {
      ...plan.pixivTarget,
      ...cleaned,
    };

    const tag = plan.pixivTarget.filterTag || plan.pixivTarget.tag || plan.title.replace(/\s*自动混剪$/, '');
    plan.title = `${tag} 自动混剪`;
    plan.description = `${tag} 高收藏插画自动收集与本地视频合成。`;
    plan.publish.tags = Array.from(new Set([tag, ...plan.publish.tags.filter(Boolean)])).slice(0, 10);
  }

  private applyPublishOverrides(plan: WorkflowPlan, overrides?: CreateWorkflowTaskRequest['publishOverrides']): void {
    if (!overrides) return;
    if (overrides.title?.trim()) plan.publish.title = this.clampText(overrides.title.trim(), 80);
    if (overrides.description?.trim()) plan.publish.description = overrides.description.trim();
    if (overrides.dynamic?.trim()) plan.publish.dynamic = this.clampText(overrides.dynamic.trim(), 233);
    if (overrides.category?.trim()) plan.publish.category = overrides.category.trim();
    if (overrides.tags) plan.publish.tags = Array.from(new Set(overrides.tags.map((tag) => tag.trim()).filter(Boolean))).slice(0, 10);
    if (overrides.original !== undefined) plan.publish.original = Boolean(overrides.original);
    if (overrides.aigc !== undefined) plan.publish.aigc = Boolean(overrides.aigc);
    if (overrides.syncArticle !== undefined) plan.publish.syncArticle = Boolean(overrides.syncArticle);
    if (overrides.articleTitle?.trim()) plan.publish.articleTitle = this.clampText(overrides.articleTitle.trim(), 80);
    if (overrides.articleBody?.trim()) plan.publish.articleBody = overrides.articleBody.trim();
  }

  private applyAiPlanMetadata(plan: WorkflowPlan, patch: AiWorkflowPlanPatch | null): void {
    if (!patch) return;
    if (patch.title?.trim()) plan.title = this.clampText(patch.title.trim(), 80);
    if (patch.description?.trim()) plan.description = patch.description.trim();
  }

  private validateConfiguredBgmPath(task: WorkflowTask, plan: WorkflowPlan): void {
    const bgmPath = plan.video.bgmPath?.trim();
    if (!bgmPath) return;
    if (!existsSync(bgmPath)) {
      throw new Error(`指定的 BGM 文件不存在: ${bgmPath}`);
    }
    if (!isSupportedWorkflowBgmPath(bgmPath)) {
      throw new Error(`指定的 BGM 格式不支持: ${bgmPath}`);
    }
    this.addAiLog(task, 'BGM 指定', '完成', `使用指定本地 BGM: ${bgmPath}`);
  }

  private async applyAiBgmSelection(task: WorkflowTask, plan: WorkflowPlan): Promise<void> {
    if (plan.video.bgmPath?.trim()) return;
    const aiRequired = workflowAiAgent.isAiFirstMode();
    this.addAiLog(task, 'BGM 选择', '开始', '正在分析视频风格并选择背景音乐');
    const candidates = listWorkflowBgmCandidates();
    if (candidates.length > 0) {
      try {
        const selection = await workflowAiAgent.selectBgm({
          command: task.command,
          plan,
          candidates,
        });
        if (selection?.path) {
          plan.video.bgmPath = selection.path;
          this.addAiLog(task, 'BGM 选择', '完成', JSON.stringify({
            path: selection.path,
            name: basename(selection.path),
            reason: selection.reason,
          }));
          return;
        }
        this.addAiLog(task, 'BGM 选择', '无结果', 'AI 未从本地候选中选择 BGM，继续生成搜索词');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.addAiLog(task, 'BGM 选择', '失败', message, 'error');
        if (aiRequired) throw new Error(`AI BGM 选择失败，流程已停止: ${message}`);
        this.addLog(task, 'warn', `AI BGM 选择失败，尝试联网下载: ${message}`);
      }
    }

    // External BGM download can hang on restricted networks; keep it out of the
    // critical path for fixture/dry-run and bound it with a short timeout.
    const skipExternal =
      process.env.ARTFLOW_FIXTURE_MODE === '1' ||
      process.env.ARTFLOW_SKIP_EXTERNAL_BGM === '1';
    if (skipExternal) {
      this.addAiLog(task, 'BGM 下载', '跳过', 'fixture/离线模式，跳过外部 BGM 下载');
      return;
    }

    try {
      const searchPlan = await this.createBgmSearchQueries(task, plan);
      const downloaded = await withTimeout(
        downloadWorkflowBgmFromInternet({
          query: searchPlan.queries[0],
          queries: searchPlan.queries,
          outputDir: resolve(process.cwd(), 'workflow_runs', task.id, 'bgm'),
          network: loadConfig(this.workflowConfigPath).network,
        }),
        8000,
        'BGM download timed out'
      );
      if (!downloaded) {
        this.addAiLog(task, 'BGM 下载', '无结果', `外部音频库未找到可下载 BGM，搜索计划: ${searchPlan.queries.join(' | ')}`, 'warn');
        return;
      }
      plan.video.bgmPath = downloaded.path;
      this.addAiLog(task, 'BGM 下载', '完成', JSON.stringify(downloaded));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.addAiLog(task, 'BGM 下载', '失败', `外部音频库下载失败: ${message}`, 'warn');
      this.addLog(task, 'warn', `自动下载 BGM 失败，继续生成无外部 BGM 视频: ${message}`);
    }
  }

  private async createBgmSearchQueries(task: WorkflowTask, plan: WorkflowPlan): Promise<{ queries: string[] }> {
    const aiRequired = workflowAiAgent.isAiFirstMode();
    this.addAiLog(task, 'BGM 搜索词', '开始', '正在让 AI 生成主题音乐搜索优先级');
    try {
      const aiPlan = await workflowAiAgent.planBgmSearch({ command: task.command, plan });
      const queries = Array.from(new Set([...(aiPlan?.queries ?? []), aiPlan?.query].filter(Boolean) as string[])).slice(0, 8);
      if (queries.length) {
        this.addAiLog(task, 'BGM 搜索词', '完成', JSON.stringify(aiPlan));
        return { queries };
      }
      if (aiRequired) {
        throw new Error('AI 未返回 BGM 搜索词');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.addAiLog(task, 'BGM 搜索词', '失败', message, aiRequired ? 'error' : 'warn');
      if (aiRequired) throw new Error(`AI BGM 搜索词生成失败: ${message}`);
      this.addLog(task, 'warn', `AI BGM 搜索词生成失败，使用本地规则: ${message}`);
    }

    const tag = plan.pixivTarget.filterTag || plan.pixivTarget.tag || plan.title;
    return {
      queries: [
        `${tag} OST`,
        `${tag} character theme`,
        `${tag} soundtrack`,
        `${tag} official music`,
        `${tag} remix`,
        `${tag} cover`,
      ],
    };
  }

  private async applyAiEffectPlan(task: WorkflowTask, assets: WorkflowImageAsset[]): Promise<void> {
    if (!task.plan || task.plan.video.effectPlan?.shots.length) return;
    const aiRequired = workflowAiAgent.isAiFirstMode();
    this.addAiLog(task, '镜头配方', '开始', `正在为 ${assets.length} 张素材生成视频动效配方`);
    try {
      const effectPlan = await workflowAiAgent.generateVideoEffectPlan({
        command: task.command,
        plan: task.plan,
        assets: assets.map((asset) => ({
          width: asset.width,
          height: asset.height,
          title: asset.title,
          tags: asset.tags?.map((tag) => tag.translated_name || tag.name).filter(Boolean),
        })),
      });
      if (!effectPlan) {
        if (aiRequired) {
          throw new Error('AI 未返回视频镜头配方');
        }
        task.plan.video.effectPlan = this.createFallbackEffectPlan(assets);
        this.addAiLog(task, '镜头配方', '无结果', 'AI 未返回配方，使用本地动效轮换', 'warn');
        return;
      }
      task.plan.video.effectPlan = effectPlan;
      this.addAiLog(task, '镜头配方', '完成', JSON.stringify({
        styleHint: effectPlan.styleHint,
        shotCount: effectPlan.shots.length,
        shots: effectPlan.shots,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.addAiLog(task, '镜头配方', '失败', message, aiRequired ? 'error' : 'warn');
      if (aiRequired) throw new Error(`AI 镜头配方生成失败，流程已停止: ${message}`);
      task.plan.video.effectPlan = this.createFallbackEffectPlan(assets);
      this.addLog(task, 'warn', `AI 镜头配方生成失败，使用本地动效轮换: ${message}`);
    }
  }

  private createFallbackEffectPlan(assets: WorkflowImageAsset[]) {
    const effects = ['slow_zoom', 'pan_left', 'pan_right', 'drift', 'sway', 'pulse', 'pan_up', 'pan_down'] as const;
    return {
      styleHint: 'local fallback',
      shots: assets.slice(0, 80).map((_, index) => ({
        effect: effects[index % effects.length],
        zoom: index % 3 === 0 ? 1.08 : 1.045,
        intensity: 0.65,
      })),
    };
  }

  private maskPixivConfig(config: StandaloneConfig): Partial<StandaloneConfig> {
    return {
      ...config,
      pixiv: {
        ...config.pixiv,
        refreshToken: config.pixiv.refreshToken ? '***' : '',
      },
    };
  }

  private async filterImages(paths: string[], workflowConfig: StandaloneConfig): Promise<WorkflowImageAsset[]> {
    const assets: WorkflowImageAsset[] = [];
    const target = workflowConfig.targets?.[0];
    const popularityRankScope = [
      target?.tag || target?.filterTag,
      target?.startDate || target?.endDate ? `${target.startDate ?? '不限'} 至 ${target.endDate ?? '不限'}` : undefined,
    ].filter(Boolean).join(' · ');
    for (const path of paths) {
      try {
        const stats = statSync(path);
        const metadata = await this.identifyImage(path);
        const fileHash = await this.calculateFileHash(path);
        const pixivMetadata = await this.readPixivMetadata(path, workflowConfig);
        const tooSmall = metadata.width < 640 || metadata.height < 640;
        const tooTiny = stats.size < 20 * 1024;
        assets.push({
          path,
          name: basename(path),
          width: metadata.width,
          height: metadata.height,
          size: stats.size,
          pixivId: pixivMetadata?.pixiv_id ? String(pixivMetadata.pixiv_id) : undefined,
          title: pixivMetadata?.title,
          caption: pixivMetadata?.caption,
          author: pixivMetadata?.author
            ? {
                id: pixivMetadata.author.id,
                name: pixivMetadata.author.name,
                account: pixivMetadata.author.account,
                profileImageUrls: pixivMetadata.author.profile_image_urls,
              }
            : undefined,
          tags: pixivMetadata?.tags,
          publishedAt: pixivMetadata?.create_date || undefined,
          bookmarkCount: pixivMetadata?.total_bookmarks ?? pixivMetadata?.bookmark_count,
          viewCount: pixivMetadata?.total_view ?? pixivMetadata?.view_count,
          popularityRankScope: popularityRankScope || undefined,
          fileHash,
          status: tooSmall || tooTiny ? 'rejected' : 'accepted',
          reason: tooSmall ? '分辨率过低' : tooTiny ? '文件过小' : undefined,
        });
      } catch (error) {
        assets.push({
          path,
          name: basename(path),
          width: 0,
          height: 0,
          size: existsSync(path) ? statSync(path).size : 0,
          status: 'rejected',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.applyPopularityRanks(assets);
    return assets;
  }

  private applyPopularityRanks(assets: WorkflowImageAsset[]): void {
    const ranked = assets
      .filter((asset) => asset.bookmarkCount !== undefined)
      .sort((a, b) => (b.bookmarkCount ?? 0) - (a.bookmarkCount ?? 0));
    for (let index = 0; index < ranked.length; index += 1) {
      ranked[index].popularityRank = index + 1;
    }
  }

  private createWorkflowFileService(): FileService {
    const config = loadConfig(this.workflowConfigPath);
    return new FileService(config.storage ?? {});
  }

  private async readPixivMetadata(path: string, workflowConfig: StandaloneConfig): Promise<PixivMetadata | null> {
    const workflowMetadata = await new FileService(workflowConfig.storage ?? {}).readMetadata(path);
    if (workflowMetadata) return workflowMetadata;

    const globalConfig = loadConfig(this.workflowConfigPath);
    const globalMetadata = await new FileService(globalConfig.storage ?? {}).readMetadata(path);
    if (globalMetadata) return globalMetadata;

    const pixivId = this.extractPixivIdFromPath(path);
    const record = this.findDownloadRecord(path, pixivId);
    if (!record) return null;
    return {
      pixiv_id: record.pixivId,
      title: record.title,
      author: {
        id: record.userId ?? '',
        name: record.author ?? '未知作者',
        account: record.authorAccount ?? undefined,
        profile_image_urls: record.authorProfileImageUrls ?? undefined,
      },
      tags: [],
      original_url: `https://www.pixiv.net/artworks/${record.pixivId}`,
      create_date: '',
      download_tag: record.tag,
      type: record.type === 'novel' ? 'novel' : 'illustration',
    };
  }

  private findDownloadRecord(path: string, pixivId?: string) {
    let database: Database | undefined;
    try {
      const config = loadConfig(this.workflowConfigPath);
      if (!config.storage?.databasePath) return null;
      database = new Database(config.storage.databasePath);
      database.migrate();
      return database.getDownloadByFilePath(path) ?? (pixivId ? database.getDownloadByPixivId(pixivId) : null);
    } catch {
      return null;
    } finally {
      database?.close();
    }
  }

  private extractPixivIdFromPath(path: string): string | undefined {
    return basename(path).match(/^(\d+)/)?.[1];
  }

  private async calculateFileHash(path: string): Promise<string> {
    const content = await readFile(path);
    return createHash('sha256').update(content).digest('hex');
  }

  private async identifyImage(path: string): Promise<{ width: number; height: number }> {
    const { stdout } = await execFileAsync(resolvePython(), [
      '-c',
      'from PIL import Image; import sys; img=Image.open(sys.argv[1]); print(f"{img.width},{img.height}")',
      path,
    ]);
    const [width, height] = stdout.trim().split(',').map((value) => Number(value));
    if (!width || !height) {
      throw new Error('无法读取图片尺寸');
    }
    return { width, height };
  }

  private async generateCover(task: WorkflowTask, imagePaths: string[], layout = 'grid', titleOverride?: string): Promise<string> {
    if (!task.plan) {
      throw new Error('Workflow plan is missing');
    }
    if (imagePaths.length === 0) {
      throw new Error('No images available for cover generation');
    }

    const outputDir = resolve(process.cwd(), 'workflow_runs', task.id);
    mkdirSync(outputDir, { recursive: true });
    const coverPath = join(outputDir, `${task.id}-cover-${Date.now()}.jpg`);
    const title = (titleOverride?.trim() || task.plan.title).replace(/"/g, '\\"');
    const safeLayout = ['grid', 'single', 'hero_left', 'hero_top', 'strip'].includes(layout) ? layout : 'grid';
    await execFileAsync(resolvePython(), [
      '-c',
      [
        'from PIL import Image, ImageDraw, ImageFont, ImageFilter',
        'import sys',
        'dst, title, width, height, layout = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]',
        'sources = sys.argv[6:12]',
        'def cover_crop(src, box_w, box_h):',
        '    img = Image.open(src).convert("RGB")',
        '    scale = max(box_w / img.width, box_h / img.height)',
        '    resized = img.resize((round(img.width * scale), round(img.height * scale)), Image.Resampling.LANCZOS)',
        '    left = max((resized.width - box_w) // 2, 0)',
        '    top = max((resized.height - box_h) // 2, 0)',
        '    return resized.crop((left, top, left + box_w, top + box_h))',
        'def paste_box(src, box):',
        '    x, y, w, h = box',
        '    canvas.paste(cover_crop(src, w, h), (x, y))',
        'sources = [src for src in sources if src]',
        'canvas = Image.new("RGB", (width, height), (18, 18, 18))',
        'count = len(sources)',
        'if layout == "single" or count == 1:',
        '    canvas.paste(cover_crop(sources[0], width, height), (0, 0))',
        'elif layout == "hero_left":',
        '    main_w = round(width * 0.62)',
        '    paste_box(sources[0], (0, 0, main_w, height))',
        '    side = sources[1:] or sources[:1]',
        '    cell_h = max(1, height // len(side[:3]))',
        '    for i, src in enumerate(side[:3]):',
        '        y = i * cell_h',
        '        paste_box(src, (main_w, y, width - main_w, height - y if i == len(side[:3]) - 1 else cell_h))',
        'elif layout == "hero_top":',
        '    main_h = round(height * 0.62)',
        '    paste_box(sources[0], (0, 0, width, main_h))',
        '    bottom = sources[1:] or sources[:1]',
        '    cell_w = max(1, width // len(bottom[:4]))',
        '    for i, src in enumerate(bottom[:4]):',
        '        x = i * cell_w',
        '        paste_box(src, (x, main_h, width - x if i == len(bottom[:4]) - 1 else cell_w, height - main_h))',
        'elif layout == "strip":',
        '    cell_w = max(1, width // min(count, 6))',
        '    for i, src in enumerate(sources[:6]):',
        '        x = i * cell_w',
        '        paste_box(src, (x, 0, width - x if i == min(count, 6) - 1 else cell_w, height))',
        'elif count == 2:',
        '    if width >= height:',
        '        boxes = [(0, 0, width // 2, height), (width // 2, 0, width - width // 2, height)]',
        '    else:',
        '        boxes = [(0, 0, width, height // 2), (0, height // 2, width, height - height // 2)]',
        '    for src, box in zip(sources, boxes):',
        '        paste_box(src, box)',
        'else:',
        '    cell_w, cell_h = width // 2, height // 2',
        '    boxes = [(0, 0, cell_w, cell_h), (cell_w, 0, width - cell_w, cell_h), (0, cell_h, cell_w, height - cell_h), (cell_w, cell_h, width - cell_w, height - cell_h)]',
        '    for src, box in zip(sources[:4], boxes):',
        '        paste_box(src, box)',
        'canvas.convert("RGB").save(dst, quality=92)',
      ].join('\n'),
      coverPath,
      title,
      String(task.plan.video.width),
      String(task.plan.video.height),
      safeLayout,
      ...imagePaths,
    ]);
    return coverPath;
  }

  private rankVideoAssets(task: WorkflowTask, assets: WorkflowImageAsset[]): WorkflowImageAsset[] {
    if (!task.plan) return assets;
    const targetRatio = task.plan.video.width / task.plan.video.height;
    const scored = assets
      .map((asset, index) => {
        const ratio = asset.width > 0 && asset.height > 0 ? asset.width / asset.height : targetRatio;
        const ratioPenalty = Math.abs(Math.log(ratio / targetRatio));
        const pixels = Math.max(asset.width * asset.height, 0);
        return { asset, index, score: pixels / 1_000_000 - ratioPenalty * 2 };
      })
      .sort((a, b) => b.score - a.score || a.index - b.index);

    const ordered: WorkflowImageAsset[] = [];
    const pending = scored.map((item) => item.asset);
    while (pending.length > 0) {
      const previousPixivId = ordered[ordered.length - 1]?.pixivId;
      const nextIndex = pending.findIndex((asset) => asset.pixivId && asset.pixivId !== previousPixivId);
      ordered.push(pending.splice(nextIndex >= 0 ? nextIndex : 0, 1)[0]);
    }
    return ordered;
  }

  private async renderVideo(task: WorkflowTask, assets: WorkflowImageAsset[]): Promise<string> {
    if (!task.plan) {
      throw new Error('Workflow plan is missing');
    }

    const imagePaths = assets.map((asset) => asset.path);
    const outputDir = resolve(process.cwd(), 'workflow_runs', task.id);
    mkdirSync(outputDir, { recursive: true });

    const outputPath = join(outputDir, `${task.id}.mp4`);
    const renderConfigPath = join(outputDir, 'render-config.json');
    writeFileSync(
      renderConfigPath,
      JSON.stringify(
        {
          imagePaths,
          outputPath,
          size: {
            width: task.plan.video.width,
            height: task.plan.video.height,
          },
          fps: task.plan.video.fps,
          secondsPerImage: task.plan.video.secondsPerImage,
          crossfade: task.plan.video.crossfade,
          zoom: task.plan.video.zoom,
          shuffleSeed: task.plan.video.shuffleSeed,
          maxImages: task.plan.video.maxImages,
          motion: task.plan.video.motion,
          bgmPath: task.plan.video.bgmPath,
          disclaimer: task.plan.video.disclaimer,
          effectPlan: task.plan.video.effectPlan,
          imageCredits: assets.map((asset) => ({
            path: asset.path,
            pixivId: asset.pixivId,
            title: asset.title,
            authorName: asset.author?.name,
            authorId: asset.author?.id,
            authorAccount: asset.author?.account,
          })),
        },
        null,
        2
      ),
      'utf-8'
    );

    const scriptPath = resolve(process.cwd(), 'scripts', 'workflow-render-video.py');
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(resolvePython(), [scriptPath, renderConfigPath], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout.on('data', (data: Buffer) => {
        const text = data.toString();
        const progressMatch = text.match(/Render progress:\s*(\d+)%/i);
        if (progressMatch) {
          const progress = Math.min(95, Math.max(5, Number(progressMatch[1]) || 5));
          this.setStage(task, 'render', {
            progress,
            message: `视频合成中: ${progressMatch[1]}%`,
          });
        }
        this.addLog(task, 'info', text.trim());
      });
      child.stderr.on('data', (data: Buffer) => {
        const text = data.toString();
        this.addLog(task, 'warn', text.trim());
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolvePromise();
        } else {
          reject(new Error(`MoviePy renderer exited with code ${code}`));
        }
      });
    });

    return outputPath;
  }

  private async publishDryRun(task: WorkflowTask): Promise<void> {
    this.startStage(task, 'publish', '生成 B站发布包');
    await this.applyAiPublishAssets(task);
    const publishPackage = this.createBilibiliPublishPackage(task);
    task.publish = {
      status: 'dry_run_completed',
      platform: 'bilibili',
      message: `dry-run: 已生成 B站发布包，未调用 Bilibili API。${basename(publishPackage.packagePath)}`,
      packagePath: publishPackage.packagePath,
      descriptionPath: publishPackage.descriptionPath,
      articlePath: publishPackage.articlePath,
      articleMarkdownPath: publishPackage.articleMarkdownPath,
      title: publishPackage.title,
      description: publishPackage.description,
      dynamic: publishPackage.dynamic,
      tags: publishPackage.tags,
      category: publishPackage.category,
      sourceCount: publishPackage.sources.length,
      syncArticle: Boolean(publishPackage.articlePath),
      publishedAt: new Date().toISOString(),
    };
    task.latestArtifact = { type: 'publish', message: task.publish.message };
    task.requiresUserConfirmation = false;
    task.availableActions = [];
    task.status = 'published';
    this.completeStage(task, 'publish', 'B站发布包生成完成');
    this.addLog(task, 'info', `B站发布包已生成: ${publishPackage.packagePath}`);
    const publishJob = publishJobService.createFromPackage(task.id, publishPackage);
    this.addLog(task, 'info', `发布任务已创建: ${publishJob.id}`);
    this.touch(task);
  }

  private async applyAiPublishAssets(task: WorkflowTask): Promise<void> {
    if (!task.plan) return;
    const aiRequired = workflowAiAgent.isAiFirstMode();
    this.addAiLog(task, '发布素材', '开始', '正在根据实际素材生成 B站标题、简介、动态和专栏内容');
    try {
      const publishOverrides = await workflowAiAgent.generatePublishAssets({
        command: task.command,
        plan: task.plan,
        sources: this.buildBilibiliPublishSources(task),
      });
      if (!publishOverrides) {
        if (aiRequired) throw new Error('AI 未返回发布素材');
        this.addAiLog(task, '发布素材', '无结果', 'AI 未返回发布素材，使用本地发布模板', 'warn');
        return;
      }
      this.applyPublishOverrides(task.plan, publishOverrides);
      this.addAiLog(task, '发布素材', '完成', JSON.stringify({
        title: publishOverrides.title,
        tags: publishOverrides.tags,
        category: publishOverrides.category,
        dynamic: publishOverrides.dynamic,
        syncArticle: publishOverrides.syncArticle,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.addAiLog(task, '发布素材', '失败', message, aiRequired ? 'error' : 'warn');
      if (aiRequired) throw new Error(`AI 发布素材生成失败，流程已停止: ${message}`);
      this.addLog(task, 'warn', `AI 发布素材生成失败，使用本地发布模板: ${message}`);
    }
  }

  private createBilibiliPublishPackage(task: WorkflowTask): BilibiliPublishPackage {
    const preview = this.createBilibiliPublishPreview(task);
    const outputDir = resolve(process.cwd(), 'workflow_runs', task.id, 'publish');
    mkdirSync(outputDir, { recursive: true });
    const packagePath = join(outputDir, 'bilibili-publish.json');
    const descriptionPath = join(outputDir, 'bilibili-description.txt');
    const articlePath = preview.syncArticle ? join(outputDir, 'bilibili-article.json') : undefined;
    const articleMarkdownPath = preview.syncArticle ? join(outputDir, 'bilibili-article.md') : undefined;

    const payload: BilibiliPublishPackage = {
      ...preview,
      packagePath,
      descriptionPath,
      articlePath,
      articleMarkdownPath,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(packagePath, JSON.stringify(payload, null, 2), 'utf-8');
    writeFileSync(descriptionPath, preview.description, 'utf-8');
    if (articlePath && articleMarkdownPath && preview.article) {
      writeFileSync(articlePath, JSON.stringify({ ...preview.article, sources: preview.sources }, null, 2), 'utf-8');
      writeFileSync(articleMarkdownPath, `# ${preview.article.title}\n\n${preview.article.body}\n`, 'utf-8');
    }
    return payload;
  }

  private createBilibiliPublishPreview(task: WorkflowTask): BilibiliPublishPreview {
    if (!task.plan) {
      throw new Error('Missing workflow plan for Bilibili publish preview');
    }

    const sources = this.buildBilibiliPublishSources(task);
    const title = this.clampText(task.plan.publish.title || task.plan.title || `${task.plan.pixivTarget.tag ?? 'Pixiv'} 插画整理`, 80);
    const tags = Array.from(new Set(task.plan.publish.tags.filter(Boolean))).slice(0, 10);
    const description = task.plan.publish.description?.trim() || this.buildBilibiliDescription(task, sources);
    const dynamic = this.clampText(task.plan.publish.dynamic || `${title} 已生成，来源信息见简介。`, 233);
    const articleTitle = this.clampText(task.plan.publish.articleTitle || `${title}：来源与说明`, 80);
    const articleBody = task.plan.publish.articleBody?.trim() || this.buildBilibiliArticle(task, sources);
    return {
      platform: 'bilibili',
      mode: 'dry_run',
      taskId: task.id,
      videoPath: task.videoPath,
      coverPath: task.coverPath,
      title,
      description,
      category: task.plan.publish.category,
      tags,
      copyright: task.plan.publish.original ? 1 : 2,
      noReprint: false,
      source: 'Pixiv artwork collection',
      dynamic,
      aigc: task.plan.publish.aigc,
      syncArticle: Boolean(task.plan.publish.syncArticle),
      article: task.plan.publish.syncArticle
        ? {
            title: articleTitle,
            body: articleBody,
          }
        : undefined,
      sources,
    };
  }

  private buildBilibiliPublishSources(task: WorkflowTask): BilibiliPublishSource[] {
    return task.assets
      .filter((asset) => asset.status === 'accepted')
      .filter((asset) => asset.pixivId || asset.author?.name)
      .map((asset) => ({
        pixivId: asset.pixivId,
        title: asset.title,
        authorName: asset.author?.name,
        authorId: asset.author?.id,
        url: asset.pixivId ? `https://www.pixiv.net/artworks/${asset.pixivId}` : undefined,
      }));
  }

  private buildBilibiliDescription(
    task: WorkflowTask,
    sources: BilibiliPublishSource[]
  ): string {
    const lines = [
      task.plan?.description || 'Pixiv 插画整理与展示。',
      '',
      '声明：本视频为 Pixiv 插画整理与展示，作品版权归原作者所有；画面右下角已标注作者与 Pixiv ID。',
      '如原作者希望调整展示或移除内容，请联系处理。',
      '',
      '来源作品：',
      ...sources.slice(0, 40).map((source, index) => {
        const author = source.authorName ? `作者: ${source.authorName}${source.authorId ? ` (${source.authorId})` : ''}` : '作者: 未知';
        const title = source.title ? `《${source.title}》` : '未命名作品';
        const url = source.url ?? '无链接';
        return `${index + 1}. ${title} / ${author} / ${url}`;
      }),
    ];
    return lines.join('\n');
  }

  private buildBilibiliArticle(
    task: WorkflowTask,
    sources: BilibiliPublishSource[]
  ): string {
    const sourceLines = sources.slice(0, 80).map((source, index) => {
      const title = source.title || '未命名作品';
      const author = source.authorName || '未知作者';
      return `${index + 1}. ${title} - ${author}${source.url ? `\n   ${source.url}` : ''}`;
    });
    return [
      task.plan?.description || '本专栏整理本期视频使用的 Pixiv 来源作品。',
      '',
      '## 说明',
      '本文用于同步记录视频中展示的作品来源。作品版权归原作者所有，视频与专栏仅用于整理展示与溯源。',
      '',
      '## 来源作品',
      ...sourceLines,
    ].join('\n');
  }

  private clampText(text: string, limit: number): string {
    return text.length <= limit ? text : text.slice(0, limit);
  }

  private collectLocalImages(directory: string, limit: number): string[] {
    if (!existsSync(directory)) {
      return [];
    }
    return readdirSync(directory)
      .map((name) => join(directory, name))
      .filter((path) => {
        try {
          return statSync(path).isFile() && IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
        } catch {
          return false;
        }
      })
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      .slice(0, limit);
  }

  private collectFallbackImages(workflowConfig: StandaloneConfig, limit: number): string[] {
    const candidates = new Set<string>();
    for (const directory of [
      workflowConfig.storage?.illustrationDirectory,
      loadConfig(this.workflowConfigPath).storage?.illustrationDirectory,
      resolve(process.cwd(), 'downloads', 'illustrations'),
    ]) {
      if (!directory) continue;
      for (const imagePath of this.collectLocalImages(directory, limit)) {
        candidates.add(imagePath);
      }
    }

    const found = Array.from(candidates)
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      .slice(0, limit);

    if (found.length === 0) {
      // dry-run / fixture: generate placeholder images so the pipeline can proceed
      return this.generatePlaceholderImages(workflowConfig, Math.min(3, limit));
    }
    return found;
  }

  /** Minimal RGB PNG with a gradient/noise so the file exceeds pre-filter size. */
  private writePlaceholderPng(filePath: string, width: number, height: number, rgb: [number, number, number]): void {
    const zlib = require('node:zlib') as typeof import('node:zlib');
    const raw = Buffer.alloc((width * 3 + 1) * height);
    let o = 0;
    let seed = 0x12345678;
    for (let y = 0; y < height; y++) {
      raw[o++] = 0; // filter none
      for (let x = 0; x < width; x++) {
        // gradient + cheap LCG noise keeps PNG large enough for the 20KB pre-filter
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const n = seed & 0x1f;
        raw[o++] = (rgb[0] + ((x * 3) % 64) + n) & 0xff;
        raw[o++] = (rgb[1] + ((y * 2) % 64) + n) & 0xff;
        raw[o++] = (rgb[2] + ((x + y) % 48) + n) & 0xff;
      }
    }
    const idat = zlib.deflateSync(raw, { level: 1 });

    const crcTable: number[] = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
    const crc32 = (buf: Buffer): number => {
      let c = 0xffffffff;
      for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type: string, data: Buffer): Buffer => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      const typeBuf = Buffer.from(type, 'ascii');
      const crcBuf = Buffer.alloc(4);
      crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
      return Buffer.concat([len, typeBuf, data, crcBuf]);
    };

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // color type RGB
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', idat),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, png);
  }

  private generatePlaceholderImages(workflowConfig: StandaloneConfig, count: number): string[] {
    const dir =
      workflowConfig.storage?.illustrationDirectory ||
      resolve(process.cwd(), 'downloads', 'illustrations', '_placeholders');
    mkdirSync(dir, { recursive: true });
    const colors: Array<[number, number, number]> = [
      [220, 80, 100],
      [80, 140, 220],
      [90, 190, 130],
      [230, 180, 70],
    ];
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      const path = join(dir, `placeholder_${i + 1}.png`);
      this.writePlaceholderPng(path, 800, 800, colors[i % colors.length]);
      out.push(path);
    }
    logger.debug(`Generated ${out.length} placeholder images for dry-run`);
    return out;
  }

  private createStages(): WorkflowStage[] {
    return (Object.keys(STAGE_LABELS) as WorkflowStageId[]).map((id) => ({
      id,
      label: STAGE_LABELS[id],
      status: 'pending',
      message: '等待中',
      progress: 0,
    }));
  }

  private startStage(task: WorkflowTask, stageId: WorkflowStageId, message: string): void {
    task.currentStage = stageId;
    this.setStage(task, stageId, {
      status: 'running',
      message,
      progress: 5,
      startedAt: new Date().toISOString(),
      error: undefined,
    });
    this.addProgressEvent(task, stageId, 'stage', message);
    this.addLog(task, 'info', `${STAGE_LABELS[stageId]}: ${message}`);
  }

  private completeStage(task: WorkflowTask, stageId: WorkflowStageId, message: string): void {
    this.setStage(task, stageId, {
      status: 'completed',
      message,
      progress: 100,
      completedAt: new Date().toISOString(),
      error: undefined,
    });
    this.addProgressEvent(task, stageId, 'stage', message);
    this.touch(task);
  }

  private failStage(task: WorkflowTask, stageId: WorkflowStageId, error: unknown): void {
    this.setStage(task, stageId, {
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
      progress: 100,
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
    this.addProgressEvent(task, stageId, 'stage', error instanceof Error ? error.message : String(error));
    this.touch(task);
  }

  private setStage(task: WorkflowTask, stageId: WorkflowStageId, patch: Partial<WorkflowStage>): void {
    const stage = task.stages.find((item) => item.id === stageId);
    if (!stage) return;
    Object.assign(stage, patch);
    this.touch(task);
  }

  private getActiveStageId(task: WorkflowTask): WorkflowStageId | undefined {
    return task.stages.find((stage) => stage.status === 'running')?.id;
  }

  private addLog(task: WorkflowTask, level: 'info' | 'warn' | 'error', message: string): void {
    if (!message) return;
    task.logs.push({
      timestamp: new Date().toISOString(),
      level,
      message,
    });
    task.logs = task.logs.slice(-200);
    logger[level](message, { taskId: task.id });
    this.touch(task);
  }

  private addAiLog(
    task: WorkflowTask,
    step: string,
    status: string,
    detail: string,
    level: 'info' | 'warn' | 'error' = 'info'
  ): void {
    this.addLog(task, level, `AI｜${step}｜${status}｜${detail}`);
  }

  private addProgressEvent(
    task: WorkflowTask,
    stage: WorkflowStageId,
    type: 'stage' | 'asset' | 'cover' | 'video' | 'publish',
    message: string,
    extra: Partial<WorkflowProgressEvent> = {}
  ): void {
    if (!message) return;
    const timestamp = new Date().toISOString();
    task.progressEvents = [
      ...(task.progressEvents ?? []),
      {
        id: `${timestamp}-${task.progressEvents?.length ?? 0}`,
        timestamp,
        stage,
        type,
        message,
        ...extra,
      },
    ].slice(-200);
  }

  private requireTask(taskId: string): WorkflowTask {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    return task;
  }

  private touch(task: WorkflowTask): void {
    this.refreshTaskRuntimeState(task);
    task.updatedAt = new Date().toISOString();
    this.persistTask(task);
  }

  private refreshTaskRuntimeState(task: WorkflowTask): void {
    task.currentStage = task.currentStage ?? this.getActiveStageId(task) ?? task.stages.find((stage) => stage.status === 'blocked')?.id;
    task.requiresUserConfirmation = ['asset_review_required', 'cover_review_required', 'review_required'].includes(task.status);
    if (task.status === 'asset_review_required') {
      task.currentStage = 'filter';
      task.availableActions = ['continue_assets_manual', 'continue_assets_keep_all', 'continue_assets_ai_rules', 'reject'];
    } else if (task.status === 'cover_review_required') {
      task.currentStage = 'image';
      task.availableActions = ['approve_cover', 'reject'];
      if (task.coverPath) task.latestArtifact = { type: 'cover', path: task.coverPath, name: basename(task.coverPath) };
    } else if (task.status === 'review_required') {
      task.currentStage = 'review';
      task.availableActions = ['approve_video', 'reject'];
      if (task.videoPath) task.latestArtifact = { type: 'video', path: task.videoPath, name: basename(task.videoPath) };
    } else if (task.status === 'published') {
      task.currentStage = 'publish';
      task.availableActions = [];
      task.requiresUserConfirmation = false;
    } else if (task.status === 'running') {
      task.currentStage = this.getActiveStageId(task) ?? task.currentStage;
      task.availableActions = [];
      task.requiresUserConfirmation = false;
    } else if (task.status === 'failed') {
      task.availableActions = ['resume_failed'];
      task.requiresUserConfirmation = false;
    }
  }

  private describeManualTask(request: CreateWorkflowTaskRequest): string {
    const tag = request.pixivOverrides?.tag?.trim() || 'Pixiv';
    const limit = request.pixivOverrides?.limit ?? 10;
    const minBookmarks = request.pixivOverrides?.minBookmarks ?? 0;
    return `按当前参数采集 ${tag} ${limit} 张${minBookmarks > 0 ? ` 收藏数${minBookmarks}+` : ''}`;
  }

  private restoreTasks(): void {
    if (this.restored) return;
    this.restored = true;
    try {
      const tasks = withWorkflowDatabase((database) => database.listWorkflowTasks());
      for (const task of tasks) {
        this.tasks.set(task.id, task);
      }
    } catch (error) {
      logger.warn('Failed to restore workflow tasks', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private persistTask(task: WorkflowTask): void {
    try {
      withWorkflowDatabase((database) => database.upsertWorkflowTask(task));
    } catch (error) {
      logger.warn('Failed to persist workflow task', {
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private pickTag(command: string): string {
    if (command.includes('鸣潮') || command.includes('鳴潮')) return '鳴潮';
    if (command.includes('原神')) return '原神';
    if (command.includes('ブルアカ') || command.includes('碧蓝档案')) return 'ブルアカ';
    if (command.includes('初音')) return '初音ミク';
    if (command.includes('イラスト')) return 'イラスト';
    return 'イラスト';
  }

  private pickStyle(command: string): WorkflowVideoStyle {
    if (command.includes('舒缓') || command.includes('柔和') || command.toLowerCase().includes('soft')) return 'soft';
    if (command.includes('方形') || command.includes('1:1')) return 'square';
    return 'beat';
  }

  private createDefaultDisclaimer() {
    return {
      enabled: true,
      duration: 3,
      title: '免责声明',
      lines: [
        '本视频为 Pixiv 插画整理与展示，作品版权归原作者所有。',
        '画面右下角标注作者与 Pixiv ID，便于溯源与联系。',
        '如原作者希望调整展示或移除内容，请联系处理。',
      ],
    };
  }

  private pickAspectRatio(command: string, style: WorkflowVideoStyle): '16:9' | '9:16' | '1:1' {
    if (command.includes('竖屏') || command.includes('9:16')) return '9:16';
    if (command.includes('方形') || command.includes('1:1') || style === 'square') return '1:1';
    return '16:9';
  }

  private pickVideoSize(aspectRatio: '16:9' | '9:16' | '1:1'): { width: number; height: number } {
    if (aspectRatio === '9:16') return { width: 1080, height: 1920 };
    if (aspectRatio === '1:1') return { width: 1080, height: 1080 };
    return { width: 1280, height: 720 };
  }

  private pickMotion(command: string, style: WorkflowVideoStyle): WorkflowVideoMotion {
    if (command.includes('无动效') || command.includes('静态')) return 'none';
    if (command.includes('卡点') || command.includes('快节奏')) return 'beat_zoom';
    if (style === 'soft') return 'drift_zoom';
    return 'auto';
  }

  private pickBgmPath(command: string): string | undefined {
    const match = command.match(/BGM(?:路径)?[:：]\s*([^\s]+)/i) || command.match(/音乐(?:路径)?[:：]\s*([^\s]+)/);
    return match?.[1];
  }

  private pickNumber(command: string, pattern: RegExp, fallback: number): number {
    const match = command.match(pattern);
    return match ? Number(match[1]) : fallback;
  }

  private clampNumber(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
  }

  private formatDate(date: Date): string {
    return date.toISOString().slice(0, 10);
  }
}

export const workflowManager = new WorkflowManager();
