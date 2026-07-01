import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
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

    task.status = 'rejected';
    task.review = {
      status: 'rejected',
      note,
      reviewedAt: new Date().toISOString(),
    };
    this.failStage(task, 'review', new Error(note || '审核驳回'));
    this.addLog(task, 'warn', `人工审核驳回${note ? `: ${note}` : ''}`);
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
    const plan = this.createPlan(task.command, request.videoOverrides);
    this.applyPixivOverrides(plan, request.pixivOverrides);
    this.applyPublishOverrides(plan, request.publishOverrides);
    const pixivConfig = this.createPixivConfig(task.id, plan);
    task.plan = plan;
    task.pixivConfig = this.maskPixivConfig(pixivConfig);
    this.completeStage(task, 'plan', '已生成本地工作流计划');
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
    task.assets = await this.filterImages(images);
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
    if (request.prefilterMode && request.prefilterMode !== 'manual') {
      this.continueAfterAssetReview(task.id, request.prefilterMode);
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
    task.videoPath = await this.renderVideo(task, this.rankVideoAssets(task, acceptedImages));
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
    const crossfade = this.clampNumber(overrides.crossfade ?? (style === 'soft' ? 0.35 : 0.18), 0, 2);
    const secondsPerImage = this.clampNumber(
      overrides.secondsPerImage ?? (totalDuration > 0 ? (totalDuration + (maxImages - 1) * crossfade) / maxImages : style === 'soft' ? 4 : 3),
      0.5,
      20
    );
    const zoom = this.clampNumber(overrides.zoom ?? (style === 'soft' ? 1.02 : 1.08), 1, 1.5);
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

  private maskPixivConfig(config: StandaloneConfig): Partial<StandaloneConfig> {
    return {
      ...config,
      pixiv: {
        ...config.pixiv,
        refreshToken: config.pixiv.refreshToken ? '***' : '',
      },
    };
  }

  private async filterImages(paths: string[]): Promise<WorkflowImageAsset[]> {
    const assets: WorkflowImageAsset[] = [];
    const fileService = this.createWorkflowFileService();
    for (const path of paths) {
      try {
        const stats = statSync(path);
        const metadata = await this.identifyImage(path);
        const pixivMetadata = await fileService.readMetadata(path);
        const fileHash = await this.calculateFileHash(path);
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
    return assets;
  }

  private createWorkflowFileService(): FileService {
    const config = loadConfig(this.workflowConfigPath);
    return new FileService(config.storage ?? {});
  }

  private async calculateFileHash(path: string): Promise<string> {
    const content = await readFile(path);
    return createHash('sha256').update(content).digest('hex');
  }

  private async identifyImage(path: string): Promise<{ width: number; height: number }> {
    const { stdout } = await execFileAsync('python', [
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
    await execFileAsync('python', [
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
        'overlay = Image.new("RGBA", (width, height), (0, 0, 0, 0))',
        'shade = Image.new("RGBA", (width, round(height * 0.34)), (0, 0, 0, 132))',
        'overlay.alpha_composite(shade, (0, height - shade.height))',
        'canvas = Image.alpha_composite(canvas.convert("RGBA"), overlay)',
        'draw = ImageDraw.Draw(canvas)',
        'font_size = max(36, width // 18)',
        'try:',
        '    font = ImageFont.truetype("/System/Library/Fonts/PingFang.ttc", font_size)',
        'except Exception:',
        '    font = ImageFont.load_default()',
        'margin = max(32, width // 24)',
        'text = title[:32]',
        'draw.text((margin, height - margin - font_size * 1.35), text, fill=(255, 255, 255, 245), font=font)',
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
      const child = spawn('python', [scriptPath, renderConfigPath], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout.on('data', (data: Buffer) => {
        const text = data.toString();
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
    this.touch(task);
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

    const acceptedAssets = task.assets.filter((asset) => asset.status === 'accepted');
    const sources = acceptedAssets
      .filter((asset) => asset.pixivId || asset.author?.name)
      .map((asset) => ({
        pixivId: asset.pixivId,
        title: asset.title,
        authorName: asset.author?.name,
        authorId: asset.author?.id,
        url: asset.pixivId ? `https://www.pixiv.net/artworks/${asset.pixivId}` : undefined,
      }));
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

    return Array.from(candidates)
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      .slice(0, limit);
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
