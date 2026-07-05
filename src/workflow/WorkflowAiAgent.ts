import { AiSettingsRecord } from '../storage/repositories/WorkflowRepository';
import {
  BilibiliPublishSource,
  CreateWorkflowTaskRequest,
  WorkflowPlan,
  WorkflowPublishOverrides,
  WorkflowVideoEffectName,
  WorkflowVideoEffectPlan,
  WorkflowVideoOverrides,
} from './types';
import { WorkflowBgmCandidate } from './WorkflowBgmLibrary';
import { StandaloneConfig, TargetConfig } from '../config';
import { withWorkflowDatabase } from './workflow-store';

type WorkflowPixivOverrides = CreateWorkflowTaskRequest['pixivOverrides'];

export interface AiWorkflowPlanPatch {
  title?: string;
  description?: string;
  pixivOverrides?: WorkflowPixivOverrides;
  videoOverrides?: WorkflowVideoOverrides;
  publishOverrides?: WorkflowPublishOverrides;
  prefilterMode?: CreateWorkflowTaskRequest['prefilterMode'];
  notes?: string[];
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

interface AiBgmSelection {
  path?: string;
  reason?: string;
}

interface AiBgmSearchPlan {
  query?: string;
  queries?: string[];
  reason?: string;
}

export interface AiConfigPatchResult {
  patch: Partial<StandaloneConfig>;
  notes?: string[];
}

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

function getCurrentAiSettings(): AiSettingsRecord | null {
  try {
    return withWorkflowDatabase((database) => database.getAiSettings());
  } catch {
    return null;
  }
}

function normalizeBaseUrl(baseUrl?: string): string {
  return (baseUrl?.trim() || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');
}

function clampNumber(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return undefined;
  return Math.min(max, Math.max(min, numberValue));
}

function cleanString(value: unknown, maxLength = 5000): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function cleanStringArray(value: unknown, maxItems: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map((item) => cleanString(item, 80)).filter(Boolean) as string[];
  return items.length ? Array.from(new Set(items)).slice(0, maxItems) : undefined;
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && allowed.includes(value as T) ? (value as T) : undefined;
}

function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = fenced || text;
  const jsonText = source.match(/\{[\s\S]*\}/)?.[0] || source;
  return JSON.parse(jsonText);
}

function sanitizePixivOverrides(input: unknown): WorkflowPixivOverrides | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const data = input as Record<string, unknown>;
  const cleaned: WorkflowPixivOverrides = {};

  const tag = cleanString(data.tag, 80);
  const filterTag = cleanString(data.filterTag, 80);
  const rankingMode = pickEnum(data.rankingMode, ['day', 'week', 'month', 'day_male', 'day_female', 'day_ai', 'week_original', 'week_rookie', 'day_r18', 'day_male_r18', 'day_female_r18'] as const);
  const rankingDate = cleanString(data.rankingDate, 20);
  const startDate = cleanString(data.startDate, 20);
  const endDate = cleanString(data.endDate, 20);
  const limit = clampNumber(data.limit, 1, 200);
  const minBookmarks = clampNumber(data.minBookmarks, 0, 1000000);
  const tagWhitelist = cleanStringArray(data.tagWhitelist, 30);
  const tagBlacklist = cleanStringArray(data.tagBlacklist, 30);
  const searchTarget = pickEnum(data.searchTarget, ['partial_match_for_tags', 'exact_match_for_tags', 'title_and_caption'] as const);
  const sort = pickEnum(data.sort, ['date_desc', 'date_asc', 'popular_desc'] as const);
  const mode = pickEnum(data.mode, ['search', 'ranking'] as const);

  if (tag) cleaned.tag = tag;
  if (filterTag) cleaned.filterTag = filterTag;
  if (limit !== undefined) cleaned.limit = limit;
  if (searchTarget) cleaned.searchTarget = searchTarget;
  if (sort) cleaned.sort = sort;
  if (mode) cleaned.mode = mode;
  if (rankingMode) cleaned.rankingMode = rankingMode;
  if (rankingDate) cleaned.rankingDate = rankingDate;
  if (minBookmarks !== undefined) cleaned.minBookmarks = minBookmarks;
  if (startDate) cleaned.startDate = startDate;
  if (endDate) cleaned.endDate = endDate;
  if (tagWhitelist) cleaned.tagWhitelist = tagWhitelist;
  if (tagBlacklist) cleaned.tagBlacklist = tagBlacklist;

  return Object.keys(cleaned).length ? cleaned : undefined;
}

function sanitizeVideoOverrides(input: unknown): WorkflowVideoOverrides | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const data = input as Record<string, unknown>;
  const cleaned: WorkflowVideoOverrides = {};

  const aspectRatio = pickEnum(data.aspectRatio, ['16:9', '9:16', '1:1'] as const);
  const motion = pickEnum(data.motion, ['auto', 'none', 'slow_zoom', 'beat_zoom', 'pan_zoom', 'slide_parallax', 'beat_cut', 'drift_zoom', 'cinematic_sway', 'pulse_pop'] as const);
  const style = pickEnum(data.style, ['beat', 'soft', 'square'] as const);
  const totalDuration = clampNumber(data.totalDuration, 0, 600);
  const maxImages = clampNumber(data.maxImages, 1, 80);
  const secondsPerImage = clampNumber(data.secondsPerImage, 0.5, 20);
  const fps = clampNumber(data.fps, 12, 60);
  const crossfade = clampNumber(data.crossfade, 0, 2);
  const zoom = clampNumber(data.zoom, 1, 1.5);
  const bgmPath = cleanString(data.bgmPath, 1000);

  if (aspectRatio) cleaned.aspectRatio = aspectRatio;
  if (motion) cleaned.motion = motion;
  if (style) cleaned.style = style;
  if (totalDuration !== undefined) cleaned.totalDuration = totalDuration;
  if (maxImages !== undefined) cleaned.maxImages = maxImages;
  if (secondsPerImage !== undefined) cleaned.secondsPerImage = secondsPerImage;
  if (fps !== undefined) cleaned.fps = fps;
  if (crossfade !== undefined) cleaned.crossfade = crossfade;
  if (zoom !== undefined) cleaned.zoom = zoom;
  if (bgmPath) cleaned.bgmPath = bgmPath;

  return Object.keys(cleaned).length ? cleaned : undefined;
}

function sanitizePublishOverrides(input: unknown): WorkflowPublishOverrides | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const data = input as Record<string, unknown>;
  const cleaned: WorkflowPublishOverrides = {};

  const title = cleanString(data.title, 80);
  const description = cleanString(data.description, 8000);
  const dynamic = cleanString(data.dynamic, 233);
  const category = cleanString(data.category, 80);
  const articleTitle = cleanString(data.articleTitle, 80);
  const articleBody = cleanString(data.articleBody, 12000);
  const tags = cleanStringArray(data.tags, 10);

  if (title) cleaned.title = title;
  if (description) cleaned.description = description;
  if (dynamic) cleaned.dynamic = dynamic;
  if (category) cleaned.category = category;
  if (tags) cleaned.tags = tags;
  if (typeof data.original === 'boolean') cleaned.original = data.original;
  if (typeof data.aigc === 'boolean') cleaned.aigc = data.aigc;
  if (typeof data.syncArticle === 'boolean') cleaned.syncArticle = data.syncArticle;
  if (articleTitle) cleaned.articleTitle = articleTitle;
  if (articleBody) cleaned.articleBody = articleBody;

  return Object.keys(cleaned).length ? cleaned : undefined;
}

function sanitizePlanPatch(input: unknown): AiWorkflowPlanPatch {
  if (!input || typeof input !== 'object') return {};
  const data = input as Record<string, unknown>;
  const patch: AiWorkflowPlanPatch = {};
  const title = cleanString(data.title, 80);
  const description = cleanString(data.description, 1000);
  const notes = cleanStringArray(data.notes, 8);
  const prefilterMode = pickEnum(data.prefilterMode, ['manual', 'ai_rules', 'keep_all'] as const);

  if (title) patch.title = title;
  if (description) patch.description = description;
  if (notes) patch.notes = notes;
  if (prefilterMode) patch.prefilterMode = prefilterMode;
  patch.pixivOverrides = sanitizePixivOverrides(data.pixivOverrides);
  patch.videoOverrides = sanitizeVideoOverrides(data.videoOverrides);
  patch.publishOverrides = sanitizePublishOverrides(data.publishOverrides);

  return patch;
}

function sanitizeBgmSearchPlan(input: unknown): AiBgmSearchPlan | null {
  if (!input || typeof input !== 'object') return null;
  const data = input as Record<string, unknown>;
  const query = cleanString(data.query, 120);
  const queries = cleanStringArray(data.queries, 8);
  if (!query && !queries?.length) return null;
  return {
    query: query || queries?.[0],
    queries,
    reason: cleanString(data.reason, 200),
  };
}

function sanitizeEffectPlan(input: unknown, maxShots: number): WorkflowVideoEffectPlan | null {
  if (!input || typeof input !== 'object') return null;
  const data = input as Record<string, unknown>;
  const rawShots = Array.isArray(data.shots) ? data.shots : [];
  const allowed: readonly WorkflowVideoEffectName[] = [
    'slow_zoom',
    'pan_left',
    'pan_right',
    'pan_up',
    'pan_down',
    'drift',
    'sway',
    'pulse',
  ] as const;
  const shots = rawShots
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const shot = item as Record<string, unknown>;
      const effect = pickEnum(shot.effect, allowed);
      if (!effect) return null;
      return {
        effect,
        zoom: clampNumber(shot.zoom, 1, 1.18),
        intensity: clampNumber(shot.intensity, 0, 1),
      };
    })
    .filter(Boolean)
    .slice(0, maxShots) as WorkflowVideoEffectPlan['shots'];
  if (!shots.length) return null;
  return {
    styleHint: cleanString(data.styleHint, 80),
    shots,
  };
}

function sanitizeTarget(input: unknown): TargetConfig | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const data = input as Record<string, unknown>;
  const type = pickEnum(data.type, ['illustration', 'novel'] as const) || 'illustration';
  const target: TargetConfig = { type };
  const tag = cleanString(data.tag, 80);
  const filterTag = cleanString(data.filterTag, 80);
  const rankingMode = pickEnum(data.rankingMode, ['day', 'week', 'month', 'day_male', 'day_female', 'day_ai', 'week_original', 'week_rookie', 'day_r18', 'day_male_r18', 'day_female_r18'] as const);
  const rankingDate = cleanString(data.rankingDate, 20);
  const startDate = cleanString(data.startDate, 20);
  const endDate = cleanString(data.endDate, 20);
  const limit = clampNumber(data.limit, 1, 500);
  const minBookmarks = clampNumber(data.minBookmarks, 0, 1000000);
  const searchTarget = pickEnum(data.searchTarget, ['partial_match_for_tags', 'exact_match_for_tags', 'title_and_caption'] as const);
  const sort = pickEnum(data.sort, ['date_desc', 'date_asc', 'popular_desc'] as const);
  const mode = pickEnum(data.mode, ['search', 'ranking'] as const);
  const tagWhitelist = cleanStringArray(data.tagWhitelist, 30);
  const tagBlacklist = cleanStringArray(data.tagBlacklist, 30);

  if (tag) target.tag = tag;
  if (filterTag) target.filterTag = filterTag;
  if (limit !== undefined) target.limit = limit;
  if (searchTarget) target.searchTarget = searchTarget;
  if (sort) target.sort = sort;
  if (mode) target.mode = mode;
  if (rankingMode) target.rankingMode = rankingMode;
  if (rankingDate) target.rankingDate = rankingDate;
  if (minBookmarks !== undefined) target.minBookmarks = minBookmarks;
  if (startDate) target.startDate = startDate;
  if (endDate) target.endDate = endDate;
  if (tagWhitelist) target.tagWhitelist = tagWhitelist;
  if (tagBlacklist) target.tagBlacklist = tagBlacklist;
  return target;
}

function sanitizeConfigPatch(input: unknown): AiConfigPatchResult {
  if (!input || typeof input !== 'object') return { patch: {} };
  const data = input as Record<string, unknown>;
  const patch: Partial<StandaloneConfig> = {};
  const notes = cleanStringArray(data.notes, 8);

  if (data.scheduler && typeof data.scheduler === 'object') {
    const scheduler = data.scheduler as Record<string, unknown>;
    patch.scheduler = {
      enabled: typeof scheduler.enabled === 'boolean' ? scheduler.enabled : false,
      cron: cleanString(scheduler.cron, 80) || '0 3 * * *',
      timezone: cleanString(scheduler.timezone, 80),
      maxExecutions: clampNumber(scheduler.maxExecutions, 1, 100000),
      minInterval: clampNumber(scheduler.minInterval, 0, 24 * 60 * 60 * 1000),
      timeout: clampNumber(scheduler.timeout, 1000, 24 * 60 * 60 * 1000),
      maxConsecutiveFailures: clampNumber(scheduler.maxConsecutiveFailures, 1, 1000),
      failureRetryDelay: clampNumber(scheduler.failureRetryDelay, 0, 24 * 60 * 60 * 1000),
    };
  }

  if (data.download && typeof data.download === 'object') {
    const download = data.download as Record<string, unknown>;
    patch.download = {
      concurrency: clampNumber(download.concurrency, 1, 20),
      requestDelay: clampNumber(download.requestDelay, 0, 60000),
      dynamicConcurrency: typeof download.dynamicConcurrency === 'boolean' ? download.dynamicConcurrency : undefined,
      minConcurrency: clampNumber(download.minConcurrency, 1, 20),
      maxRetries: clampNumber(download.maxRetries, 0, 20),
      retryDelay: clampNumber(download.retryDelay, 0, 60000),
      timeout: clampNumber(download.timeout, 1000, 600000),
    };
  }

  if (data.network && typeof data.network === 'object') {
    const network = data.network as Record<string, unknown>;
    patch.network = {
      timeoutMs: clampNumber(network.timeoutMs, 1000, 600000),
      retries: clampNumber(network.retries, 0, 20),
      retryDelay: clampNumber(network.retryDelay, 0, 60000),
    };
  }

  if (Array.isArray(data.targets)) {
    const targets = data.targets.map(sanitizeTarget).filter(Boolean) as TargetConfig[];
    if (targets.length) patch.targets = targets.slice(0, 20);
  }

  return { patch, notes };
}

export class WorkflowAiAgent {
  public isAiFirstMode(): boolean {
    const settings = getCurrentAiSettings();
    return Boolean(settings?.provider === 'openai' && settings.apiKey?.trim() && settings.model?.trim());
  }

  public async planWorkflow(command: string, request: CreateWorkflowTaskRequest): Promise<AiWorkflowPlanPatch | null> {
    const settings = getCurrentAiSettings();
    if (!settings || settings.provider !== 'openai') {
      return null;
    }
    if (!settings.apiKey?.trim() || !settings.model?.trim()) {
      return null;
    }

    const response = await fetch(`${normalizeBaseUrl(settings.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: [
              '你是 Artflow 的工作流 Agent，只返回 JSON 对象。',
              '你的任务是把用户自然语言转成 Pixiv 采集、视频生成和 B站发布素材配置。',
              '不要输出解释文本，不要请求不存在的工具，不要生成真实发布动作。',
              '定时任务或自动任务也只能生成视频和发布包，不能真实发布 B站视频。',
              '可用 JSON 字段: title, description, pixivOverrides, videoOverrides, publishOverrides, prefilterMode, notes。',
              'pixivOverrides 字段: tag, limit, searchTarget, sort, mode, rankingMode, rankingDate, filterTag, minBookmarks, startDate, endDate, tagWhitelist, tagBlacklist。',
              'videoOverrides 字段: aspectRatio, totalDuration, maxImages, secondsPerImage, fps, crossfade, zoom, motion, bgmPath, style。',
              'publishOverrides 字段: title, description, tags, dynamic, category, original, aigc, syncArticle, articleTitle, articleBody。',
              '枚举: aspectRatio=16:9|9:16|1:1, style=beat|soft|square, motion=auto|none|slow_zoom|beat_zoom|pan_zoom|slide_parallax|beat_cut|drift_zoom|cinematic_sway|pulse_pop。',
              'rankingMode=day|week|month|day_male|day_female|day_ai|week_original|week_rookie|day_r18|day_male_r18|day_female_r18。',
              '默认面向 B站；Pixiv 标签优先使用用户显式提到的作品、角色或主题。',
            ].join('\n'),
          },
          {
            role: 'user',
            content: JSON.stringify({
              command,
              currentRequest: {
                dryRunDownload: request.dryRunDownload,
                prefilterMode: request.prefilterMode,
                pixivOverrides: request.pixivOverrides,
                videoOverrides: request.videoOverrides,
                publishOverrides: request.publishOverrides,
              },
            }),
          },
        ],
      }),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`AI planner request failed: HTTP ${response.status} ${text.slice(0, 500)}`);
    }

    const body = JSON.parse(text) as ChatCompletionResponse;
    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('AI planner returned empty content');
    }
    return sanitizePlanPatch(extractJsonObject(content));
  }

  public async generatePublishAssets(input: {
    command: string;
    plan: WorkflowPlan;
    sources: BilibiliPublishSource[];
  }): Promise<WorkflowPublishOverrides | null> {
    const settings = getCurrentAiSettings();
    if (!settings || settings.provider !== 'openai') {
      return null;
    }
    if (!settings.apiKey?.trim() || !settings.model?.trim()) {
      return null;
    }

    const response = await fetch(`${normalizeBaseUrl(settings.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        temperature: 0.5,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: [
              '你是 Artflow 的 B站发布 Agent，只返回 JSON 对象。',
              '根据实际 Pixiv 来源和视频计划生成 B站投稿素材。',
              '必须包含版权说明、来源说明和作者归属；不要声称拥有原作版权。',
              '不要生成真实发布动作，只生成发布包所需文本。',
              'JSON 字段只能是: title, description, tags, dynamic, category, original, aigc, syncArticle, articleTitle, articleBody。',
              'title 不超过 80 字；dynamic 不超过 233 字；tags 最多 10 个；articleBody 使用 Markdown 正文，不要包含一级标题。',
            ].join('\n'),
          },
          {
            role: 'user',
            content: JSON.stringify({
              command: input.command,
              plan: {
                title: input.plan.title,
                description: input.plan.description,
                pixivTarget: input.plan.pixivTarget,
                video: input.plan.video,
                publish: input.plan.publish,
              },
              sources: input.sources.slice(0, 40),
            }),
          },
        ],
      }),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`AI publish assets request failed: HTTP ${response.status} ${text.slice(0, 500)}`);
    }

    const body = JSON.parse(text) as ChatCompletionResponse;
    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('AI publish assets returned empty content');
    }
    return sanitizePublishOverrides(extractJsonObject(content)) ?? null;
  }

  public async selectBgm(input: {
    command: string;
    plan: WorkflowPlan;
    candidates: WorkflowBgmCandidate[];
  }): Promise<AiBgmSelection | null> {
    const settings = getCurrentAiSettings();
    if (!settings || settings.provider !== 'openai') {
      return null;
    }
    if (!settings.apiKey?.trim() || !settings.model?.trim() || input.candidates.length === 0) {
      return null;
    }

    const candidatePaths = input.candidates.map((candidate) => candidate.path);
    const response = await fetch(`${normalizeBaseUrl(settings.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: [
              '你是 Artflow 的 BGM 选择 Agent，只返回 JSON 对象。',
              '从候选 BGM 中选择最匹配用户意图、主题、角色和视频风格的一首。',
              '主题/角色强相关优先级最高：官方 OST、角色曲、主题曲、战斗曲、PV 曲、高人气二创/remix/cover 优先。',
              '如果候选看起来是有声书、英语听力、朗读、podcast、lecture、story reading，不要选择。',
              '只能返回候选列表中真实存在的 path；如果没有合适候选，返回空字符串。',
              'JSON 字段: path, reason。',
            ].join('\n'),
          },
          {
            role: 'user',
            content: JSON.stringify({
              command: input.command,
              video: input.plan.video,
              title: input.plan.title,
              candidates: input.candidates.map((candidate) => ({
                path: candidate.path,
                name: candidate.name,
                directory: candidate.directory,
                extension: candidate.extension,
              })),
            }),
          },
        ],
      }),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`AI BGM selection request failed: HTTP ${response.status} ${text.slice(0, 500)}`);
    }

    const body = JSON.parse(text) as ChatCompletionResponse;
    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('AI BGM selection returned empty content');
    }

    const parsed = extractJsonObject(content);
    if (!parsed || typeof parsed !== 'object') return null;
    const data = parsed as Record<string, unknown>;
    const path = cleanString(data.path, 1000);
    if (!path || !candidatePaths.includes(path)) {
      return null;
    }
    return {
      path,
      reason: cleanString(data.reason, 200),
    };
  }

  public async planBgmSearch(input: {
    command: string;
    plan: WorkflowPlan;
  }): Promise<AiBgmSearchPlan | null> {
    const settings = getCurrentAiSettings();
    if (!settings || settings.provider !== 'openai') {
      return null;
    }
    if (!settings.apiKey?.trim() || !settings.model?.trim()) {
      return null;
    }

    const response = await fetch(`${normalizeBaseUrl(settings.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        temperature: 0.3,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: [
              '你是 Artflow 的 BGM 搜索 Agent，只返回 JSON 对象。',
              '根据用户命令和视频计划，生成主题强相关的音乐搜索优先级。',
              '如果用户提到游戏、番剧、角色或具体人物，优先搜索对应官方 OST、角色曲、主题曲、战斗曲、PV 曲或高人气二创/remix/cover。',
              '例如鸣潮优先 Wuthering Waves OST / character theme；崩坏星穹铁道知更鸟优先 Robin / Hope Is the Thing With Feathers / Honkai Star Rail soundtrack。',
              '不要生成泛用氛围词作为兜底，例如 cinematic、ambient、epic、electronic、background music 这类词不能单独出现。',
              '如果无法判断主题音乐，也要围绕作品名、角色名、曲名、OST、character theme 生成关键词。',
              '不要生成 audiobook、podcast、lecture、English listening、story reading 等朗读内容。',
              'JSON 字段: query, queries, reason。queries 是按优先级排列的英文搜索词数组，最多 8 个。',
            ].join('\n'),
          },
          {
            role: 'user',
            content: JSON.stringify({
              command: input.command,
              title: input.plan.title,
              video: input.plan.video,
              pixivTarget: input.plan.pixivTarget,
            }),
          },
        ],
      }),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`AI BGM search plan failed: HTTP ${response.status} ${text.slice(0, 500)}`);
    }
    const body = JSON.parse(text) as ChatCompletionResponse;
    const content = body.choices?.[0]?.message?.content;
    if (!content) return null;
    return sanitizeBgmSearchPlan(extractJsonObject(content));
  }

  public async generateVideoEffectPlan(input: {
    command: string;
    plan: WorkflowPlan;
    assets: Array<{ width: number; height: number; title?: string; tags?: string[] }>;
  }): Promise<WorkflowVideoEffectPlan | null> {
    const settings = getCurrentAiSettings();
    if (!settings || settings.provider !== 'openai') {
      return null;
    }
    if (!settings.apiKey?.trim() || !settings.model?.trim() || input.assets.length === 0) {
      return null;
    }

    const response = await fetch(`${normalizeBaseUrl(settings.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        temperature: 0.45,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: [
              '你是 Artflow 的视频镜头编排 Agent，只返回 JSON 对象。',
              '根据视频风格和图片比例生成镜头效果配方，让画面避免单一推近。',
              '只允许使用 effect: slow_zoom, pan_left, pan_right, pan_up, pan_down, drift, sway, pulse。',
              'zoom 范围 1 到 1.18，intensity 范围 0 到 1。',
              'JSON 字段: styleHint, shots。shots 数量应覆盖输入素材顺序。',
            ].join('\n'),
          },
          {
            role: 'user',
            content: JSON.stringify({
              command: input.command,
              title: input.plan.title,
              video: input.plan.video,
              assets: input.assets.slice(0, input.plan.video.maxImages),
            }),
          },
        ],
      }),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`AI effect plan failed: HTTP ${response.status} ${text.slice(0, 500)}`);
    }
    const body = JSON.parse(text) as ChatCompletionResponse;
    const content = body.choices?.[0]?.message?.content;
    if (!content) return null;
    return sanitizeEffectPlan(extractJsonObject(content), input.plan.video.maxImages);
  }

  public async generateConfigPatch(input: {
    command: string;
    currentConfig: Partial<StandaloneConfig>;
  }): Promise<AiConfigPatchResult | null> {
    const settings = getCurrentAiSettings();
    if (!settings || settings.provider !== 'openai') {
      return null;
    }
    if (!settings.apiKey?.trim() || !settings.model?.trim()) {
      return null;
    }

    const response = await fetch(`${normalizeBaseUrl(settings.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: [
              '你是 Artflow 的配置管理 Agent，只返回 JSON 对象。',
              '根据用户自然语言生成安全的配置 patch，不要输出完整配置。',
              '允许字段只有 scheduler, download, network, targets, notes。',
              '禁止输出 pixiv、refreshToken、apiKey、clientSecret、databasePath、storage、发布平台凭证。',
              'scheduler 可包含 enabled, cron, timezone, maxExecutions, minInterval, timeout, maxConsecutiveFailures, failureRetryDelay。',
              'download 可包含 concurrency, requestDelay, dynamicConcurrency, minConcurrency, maxRetries, retryDelay, timeout。',
              'network 可包含 timeoutMs, retries, retryDelay。',
              'targets 是 Pixiv 下载目标数组，每项可包含 type, tag, limit, searchTarget, sort, mode, rankingMode, rankingDate, filterTag, minBookmarks, startDate, endDate, tagWhitelist, tagBlacklist。',
            ].join('\n'),
          },
          {
            role: 'user',
            content: JSON.stringify({
              command: input.command,
              currentConfig: {
                scheduler: input.currentConfig.scheduler,
                download: input.currentConfig.download,
                network: input.currentConfig.network,
                targets: input.currentConfig.targets,
              },
            }),
          },
        ],
      }),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`AI config patch request failed: HTTP ${response.status} ${text.slice(0, 500)}`);
    }

    const body = JSON.parse(text) as ChatCompletionResponse;
    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('AI config patch returned empty content');
    }
    return sanitizeConfigPatch(extractJsonObject(content));
  }
}

export const workflowAiAgent = new WorkflowAiAgent();
