import { Router, Request, Response } from 'express';
import { existsSync } from 'node:fs';
import { workflowManager } from '../../workflow/WorkflowManager';
import { workflowScheduler } from '../../workflow/WorkflowScheduler';
import { workflowAiAgent } from '../../workflow/WorkflowAiAgent';
import { listWorkflowBgmCandidates } from '../../workflow/WorkflowBgmLibrary';
import { publishJobService } from '../../workflow/PublishJobService';
import { CreateWorkflowTaskRequest } from '../../workflow/types';
import { NotConfiguredBilibiliOpenPlatformPublisher } from '../../workflow/publishers/BilibiliOpenPlatformPublisher';
import { defaultPresets, withWorkflowDatabase } from '../../workflow/workflow-store';
import { AiSettingsRecord, CommandPresetRecord } from '../../storage/repositories/WorkflowRepository';
import { loadConfig, StandaloneConfig, getConfigPath } from '../../config';

const router = Router();

type AiProvider = AiSettingsRecord['provider'];

interface AiModelInfo {
  id: string;
  name: string;
  source?: string;
}

interface PublishCaptionRequest {
  command?: string;
  tag?: string;
  sources?: Array<{ title?: string; authorName?: string; pixivId?: string; url?: string }>;
  syncArticle?: boolean;
}

interface PublishCaptionResult {
  title: string;
  description: string;
  tags: string[];
  dynamic: string;
  articleTitle?: string;
  articleBody?: string;
}

interface AiConfigPatchRequest {
  command?: string;
}

interface BilibiliPublishSettingsRequest {
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
}

function mergeConfigPatch(config: StandaloneConfig, patch: Partial<StandaloneConfig>): StandaloneConfig {
  return {
    ...config,
    scheduler: patch.scheduler ? { ...(config.scheduler ?? {}), ...patch.scheduler } : config.scheduler,
    download: patch.download ? { ...(config.download ?? {}), ...patch.download } : config.download,
    network: patch.network ? { ...(config.network ?? {}), ...patch.network } : config.network,
    targets: patch.targets ?? config.targets,
  };
}

function maskSecret(value?: string): string {
  return value ? '***' : '';
}

function mergePublishSecret(next?: string, current?: string): string | undefined {
  if (next === undefined) return current;
  const trimmed = next.trim();
  if (!trimmed || trimmed === '***') return current;
  return trimmed;
}

function maskBilibiliPublishSettings(settings: BilibiliPublishSettingsRequest & { updatedAt?: string } = {}) {
  return {
    clientId: maskSecret(settings.clientId),
    clientSecret: maskSecret(settings.clientSecret),
    accessToken: maskSecret(settings.accessToken),
    refreshToken: maskSecret(settings.refreshToken),
    configured: Boolean(settings.clientId && settings.clientSecret && settings.accessToken),
    updatedAt: settings.updatedAt,
  };
}

function defaultBaseUrl(provider: AiProvider): string {
  if (provider === 'openai') return 'https://api.openai.com/v1';
  if (provider === 'anthropic') return 'https://api.anthropic.com';
  if (provider === 'ollama') return 'http://localhost:11434';
  return '';
}

function normalizeBaseUrl(settings: Pick<AiSettingsRecord, 'provider' | 'baseUrl'>): string {
  return (settings.baseUrl || defaultBaseUrl(settings.provider)).replace(/\/+$/, '');
}

function aiHeaders(settings: AiSettingsRecord): Record<string, string> {
  if (settings.provider === 'anthropic') {
    return {
      'content-type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
    };
  }
  if (settings.provider === 'openai') {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${settings.apiKey}`,
    };
  }
  return { 'content-type': 'application/json' };
}

async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = 15000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }
    }
    if (!response.ok) {
      const message =
        body && typeof body === 'object' && 'error' in body
          ? JSON.stringify((body as { error: unknown }).error)
          : response.statusText;
      throw new Error(`HTTP ${response.status}: ${message}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function parseModels(provider: AiProvider, body: unknown): AiModelInfo[] {
  if (!body || typeof body !== 'object') return [];
  if (provider === 'ollama') {
    const models = (body as { models?: Array<{ name?: string; model?: string }> }).models ?? [];
    return models
      .map((model) => model.name || model.model || '')
      .filter(Boolean)
      .map((id) => ({ id, name: id, source: 'ollama' }));
  }

  const data = (body as { data?: Array<{ id?: string; name?: string; display_name?: string }> }).data ?? [];
  return data
    .map((model) => ({
      id: model.id || model.name || model.display_name || '',
      name: model.display_name || model.name || model.id || '',
      source: provider,
    }))
    .filter((model) => model.id);
}

function maskBalancePayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }
  return payload;
}

function buildLocalPublishCaption(request: PublishCaptionRequest): PublishCaptionResult {
  const tag = request.tag?.trim() || request.command?.trim().slice(0, 24) || 'Pixiv';
  const sources = request.sources ?? [];
  const sourceLines = sources.slice(0, 30).map((source, index) => {
    const title = source.title || '未命名作品';
    const author = source.authorName || '未知作者';
    const url = source.url || (source.pixivId ? `https://www.pixiv.net/artworks/${source.pixivId}` : '');
    return `${index + 1}. ${title} / ${author}${url ? ` / ${url}` : ''}`;
  });
  const title = `${tag} 插画整理`;
  const description = [
    `${tag} 主题 Pixiv 插画整理与展示。`,
    '',
    '声明：作品版权归原作者所有，视频右下角保留作者与 Pixiv ID。',
    '如原作者希望调整展示或移除内容，请联系处理。',
    '',
    '来源作品：',
    ...sourceLines,
  ].join('\n');
  const articleBody = [
    `${tag} 主题视频同步专栏，用于记录本期展示作品来源。`,
    '',
    '## 来源作品',
    ...sourceLines,
  ].join('\n');
  return {
    title,
    description,
    tags: Array.from(new Set([tag, 'Pixiv', '插画', 'fanart'])).slice(0, 10),
    dynamic: `${title} 已生成，来源与作者信息见简介。`,
    articleTitle: `${title} 来源整理`,
    articleBody,
  };
}

function parseCaptionResult(body: unknown, fallback: PublishCaptionResult): PublishCaptionResult {
  let text = '';
  if (body && typeof body === 'object' && 'message' in body) {
    text = String((body as { message?: { content?: string } }).message?.content || '');
  } else if (body && typeof body === 'object' && 'choices' in body) {
    text = String((body as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content || '');
  } else if (body && typeof body === 'object' && 'content' in body) {
    const content = (body as { content: unknown }).content;
    text = Array.isArray(content)
      ? content.map((item) => (item && typeof item === 'object' && 'text' in item ? String((item as { text: unknown }).text) : '')).join('\n')
      : String(content);
  }
  const jsonText = text.match(/\{[\s\S]*\}/)?.[0] || text;
  try {
    const parsed = JSON.parse(jsonText) as Partial<PublishCaptionResult>;
    return {
      title: parsed.title?.trim() || fallback.title,
      description: parsed.description?.trim() || fallback.description,
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String).filter(Boolean).slice(0, 10) : fallback.tags,
      dynamic: parsed.dynamic?.trim() || fallback.dynamic,
      articleTitle: parsed.articleTitle?.trim() || fallback.articleTitle,
      articleBody: parsed.articleBody?.trim() || fallback.articleBody,
    };
  } catch {
    return fallback;
  }
}

function getCurrentAiSettings(): AiSettingsRecord {
  return withWorkflowDatabase((database) => database.getAiSettings()) || {
    provider: 'local-rules',
    model: 'local-rule-planner',
    baseUrl: '',
    apiKey: '',
    planningMode: 'rules-first',
  };
}

router.get('/tasks', (req: Request, res: Response) => {
  res.json({ data: workflowManager.listTasks() });
});

router.get('/bgm/candidates', (_req: Request, res: Response) => {
  try {
    res.json({ data: listWorkflowBgmCandidates() });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.get('/presets', (req: Request, res: Response) => {
  try {
    const presets = withWorkflowDatabase((database) => database.listCommandPresets());
    res.json({ data: presets });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/presets', (req: Request<unknown, unknown, Partial<CommandPresetRecord>>, res: Response) => {
  try {
    const now = new Date().toISOString();
    const name = req.body.name?.trim();
    const command = req.body.command?.trim();
    const category = req.body.category?.trim() || '视频生成';
    if (!name || !command) {
      res.status(400).json({ error: 'Preset name and command are required' });
      return;
    }

    const preset: CommandPresetRecord = {
      id: req.body.id || `preset_${Date.now()}`,
      name,
      command,
      category,
      payload: req.body.payload,
      createdAt: req.body.createdAt || now,
      updatedAt: now,
    };
    const saved = withWorkflowDatabase((database) => database.upsertCommandPreset(preset));
    res.json({ data: saved });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.delete('/presets/:id', (req: Request, res: Response) => {
  try {
    const deleted = withWorkflowDatabase((database) => database.deleteCommandPreset(req.params.id));
    res.json({ data: { deleted } });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/presets/reset', (req: Request, res: Response) => {
  try {
    withWorkflowDatabase((database) => database.replaceCommandPresets(defaultPresets));
    res.json({ data: defaultPresets });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.get('/ai-settings', (req: Request, res: Response) => {
  try {
    const settings = withWorkflowDatabase((database) => database.getAiSettings());
    res.json({
      data: settings || {
        provider: 'local-rules',
        model: 'local-rule-planner',
        baseUrl: '',
        apiKey: '',
        planningMode: 'rules-first',
      },
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.put('/ai-settings', (req: Request<unknown, unknown, AiSettingsRecord>, res: Response) => {
  try {
    const settings: AiSettingsRecord = {
      provider: req.body.provider || 'local-rules',
      model: req.body.model || 'local-rule-planner',
      baseUrl: req.body.baseUrl || '',
      apiKey: req.body.apiKey || '',
      planningMode: (req.body.provider || 'local-rules') === 'local-rules' ? 'rules-first' : 'ai-first',
    };
    const saved = withWorkflowDatabase((database) => database.saveAiSettings(settings));
    res.json({ data: saved });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/ai-settings/models', async (req: Request<unknown, unknown, Partial<AiSettingsRecord>>, res: Response) => {
  try {
    const settings = { ...getCurrentAiSettings(), ...req.body };
    if (settings.provider === 'local-rules') {
      res.json({ data: [{ id: 'local-rule-planner', name: 'local-rule-planner', source: 'local' }] });
      return;
    }

    if (settings.provider !== 'ollama' && !settings.apiKey) {
      res.status(400).json({
        error: 'API Key is required to fetch remote models',
        message: 'API Key is required to fetch remote models',
      });
      return;
    }

    const baseUrl = normalizeBaseUrl(settings);
    const url =
      settings.provider === 'ollama'
        ? `${baseUrl}/api/tags`
        : `${baseUrl}/models`;
    const body = await fetchJson(url, { method: 'GET', headers: aiHeaders(settings) });
    res.json({ data: parseModels(settings.provider, body) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(502).json({ error: message, message });
  }
});

router.post('/ai-settings/test', async (req: Request<unknown, unknown, Partial<AiSettingsRecord>>, res: Response) => {
  try {
    const settings = { ...getCurrentAiSettings(), ...req.body };
    const startedAt = Date.now();

    if (settings.provider === 'local-rules') {
      res.json({
        data: {
          ok: true,
          latencyMs: Date.now() - startedAt,
          message: '本地规则规划器可用',
        },
      });
      return;
    }

    if (settings.provider !== 'ollama' && !settings.apiKey) {
      res.status(400).json({
        error: 'API Key is required to test this provider',
        message: 'API Key is required to test this provider',
      });
      return;
    }

    const baseUrl = normalizeBaseUrl(settings);
    if (settings.provider === 'ollama') {
      await fetchJson(`${baseUrl}/api/tags`, { method: 'GET', headers: aiHeaders(settings) }, 10000);
    } else if (settings.provider === 'anthropic') {
      await fetchJson(
        `${baseUrl}/v1/messages`,
        {
          method: 'POST',
          headers: aiHeaders(settings),
          body: JSON.stringify({
            model: settings.model,
            max_tokens: 8,
            messages: [{ role: 'user', content: 'ping' }],
          }),
        },
        20000
      );
    } else {
      await fetchJson(
        `${baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: aiHeaders(settings),
          body: JSON.stringify({
            model: settings.model,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 8,
            temperature: 0,
          }),
        },
        20000
      );
    }

    res.json({
      data: {
        ok: true,
        latencyMs: Date.now() - startedAt,
        message: '连接测试通过',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(502).json({
      error: message,
      message,
      data: {
        ok: false,
      },
    });
  }
});

router.post('/ai-settings/balance', async (req: Request<unknown, unknown, Partial<AiSettingsRecord>>, res: Response) => {
  try {
    const settings = { ...getCurrentAiSettings(), ...req.body };
    if (settings.provider === 'local-rules' || settings.provider === 'ollama') {
      res.json({
        data: {
          supported: false,
          message: settings.provider === 'local-rules' ? '本地规则规划器无余额概念' : 'Ollama 本地模型无余额概念',
        },
      });
      return;
    }

    if (!settings.apiKey) {
      res.status(400).json({
        error: 'API Key is required to query balance',
        message: 'API Key is required to query balance',
      });
      return;
    }

    const baseUrl = normalizeBaseUrl(settings);
    const candidates =
      settings.provider === 'anthropic'
        ? [`${baseUrl}/v1/usage`, `${baseUrl}/v1/credits`]
        : [
            `${baseUrl}/user/balance`,
            `${baseUrl}/dashboard/billing/credit_grants`,
            `${baseUrl}/usage`,
            `${baseUrl}/balance`,
          ];

    const errors: string[] = [];
    for (const url of candidates) {
      try {
        const body = await fetchJson(url, { method: 'GET', headers: aiHeaders(settings) }, 15000);
        res.json({
          data: {
            supported: true,
            endpoint: url,
            raw: maskBalancePayload(body),
          },
        });
        return;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    res.json({
      data: {
        supported: false,
        message: '当前 Provider 未暴露兼容的余额接口，或该 Key 无权限访问余额。',
        errors,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(502).json({ error: message, message });
  }
});

router.post('/publish-caption', async (req: Request<unknown, unknown, PublishCaptionRequest>, res: Response) => {
  try {
    const settings = getCurrentAiSettings();
    const fallback = buildLocalPublishCaption(req.body);
    if (settings.provider === 'local-rules') {
      res.json({ data: { ...fallback, provider: 'local-rules' } });
      return;
    }
    if (settings.provider !== 'ollama' && !settings.apiKey) {
      res.status(400).json({ error: 'API Key is required to generate publish caption' });
      return;
    }

    const prompt = [
      '请为 B站视频投稿生成发布文案，必须只返回 JSON。',
      'JSON 字段: title, description, tags, dynamic, articleTitle, articleBody。',
      '要求: title 不超过 80 字；tags 最多 10 个；description 包含版权说明和 Pixiv 来源；articleBody 用 Markdown，适合同步发布专栏。',
      `用户指令: ${req.body.command || ''}`,
      `主题: ${req.body.tag || ''}`,
      `同步专栏: ${req.body.syncArticle ? '是' : '否'}`,
      `来源作品: ${JSON.stringify((req.body.sources || []).slice(0, 20))}`,
    ].join('\n');
    const baseUrl = normalizeBaseUrl(settings);
    let body: unknown;
    if (settings.provider === 'ollama') {
      body = await fetchJson(
        `${baseUrl}/api/chat`,
        {
          method: 'POST',
          headers: aiHeaders(settings),
          body: JSON.stringify({
            model: settings.model,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
          }),
        },
        30000
      );
    } else if (settings.provider === 'anthropic') {
      body = await fetchJson(
        `${baseUrl}/v1/messages`,
        {
          method: 'POST',
          headers: aiHeaders(settings),
          body: JSON.stringify({
            model: settings.model,
            max_tokens: 1600,
            messages: [{ role: 'user', content: prompt }],
          }),
        },
        30000
      );
    } else {
      body = await fetchJson(
        `${baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: aiHeaders(settings),
          body: JSON.stringify({
            model: settings.model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 1600,
            temperature: 0.7,
          }),
        },
        30000
      );
    }

    res.json({ data: { ...parseCaptionResult(body, fallback), provider: settings.provider } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(502).json({ error: message, message });
  }
});

router.post('/ai-config-patch', async (req: Request<unknown, unknown, AiConfigPatchRequest>, res: Response) => {
  try {
    const command = req.body.command?.trim();
    if (!command) {
      res.status(400).json({ error: 'command is required' });
      return;
    }

    const currentConfig = loadConfig(getConfigPath());
    const result = await workflowAiAgent.generateConfigPatch({
      command,
      currentConfig,
    });
    if (!result) {
      res.status(400).json({ error: 'OpenAI Compatible AI settings are required to generate config patch' });
      return;
    }

    res.json({
      data: {
        command,
        patch: result.patch,
        previewConfig: mergeConfigPatch(currentConfig, result.patch),
        notes: result.notes ?? [],
      },
    });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.get('/schedules', (req: Request, res: Response) => {
  try {
    workflowScheduler.restore();
    res.json({ data: workflowScheduler.listSchedules() });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/schedules', (req: Request, res: Response) => {
  try {
    workflowScheduler.restore();
    const schedule = workflowScheduler.upsertSchedule({
      name: req.body?.name,
      enabled: req.body?.enabled,
      cron: req.body?.cron,
      timezone: req.body?.timezone,
      command: req.body?.command,
      payload: req.body?.payload,
    });
    res.json({ data: schedule });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.put('/schedules/:id', (req: Request, res: Response) => {
  try {
    workflowScheduler.restore();
    const schedule = workflowScheduler.upsertSchedule({
      id: req.params.id,
      name: req.body?.name,
      enabled: req.body?.enabled,
      cron: req.body?.cron,
      timezone: req.body?.timezone,
      command: req.body?.command,
      payload: req.body?.payload,
    });
    res.json({ data: schedule });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/schedules/:id/enabled', (req: Request, res: Response) => {
  try {
    workflowScheduler.restore();
    const schedule = workflowScheduler.setEnabled(req.params.id, Boolean(req.body?.enabled));
    res.json({ data: schedule });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/schedules/:id/run', async (req: Request, res: Response) => {
  try {
    workflowScheduler.restore();
    const task = await workflowScheduler.triggerNow(req.params.id);
    res.json({ data: task });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.delete('/schedules/:id', (req: Request, res: Response) => {
  try {
    workflowScheduler.restore();
    const deleted = workflowScheduler.deleteSchedule(req.params.id);
    res.json({ data: { deleted } });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.get('/publish-jobs', (req: Request, res: Response) => {
  try {
    res.json({ data: publishJobService.listJobs() });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.get('/publish-jobs/:id', (req: Request, res: Response) => {
  try {
    const job = publishJobService.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'Publish job not found' });
      return;
    }
    res.json({ data: job });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/publish-jobs/:id/cancel', (req: Request, res: Response) => {
  try {
    res.json({ data: publishJobService.cancelJob(req.params.id) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/publish-jobs/:id/submit', async (req: Request, res: Response) => {
  try {
    res.json({ data: await publishJobService.submitJob(req.params.id) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.get('/publish-settings/bilibili', (req: Request, res: Response) => {
  try {
    const settings = withWorkflowDatabase((database) => database.getBilibiliPublishSettings());
    res.json({ data: maskBilibiliPublishSettings(settings ?? {}) });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.put('/publish-settings/bilibili', (req: Request<unknown, unknown, BilibiliPublishSettingsRequest>, res: Response) => {
  try {
    const current = withWorkflowDatabase((database) => database.getBilibiliPublishSettings()) ?? {};
    const saved = withWorkflowDatabase((database) =>
      database.saveBilibiliPublishSettings({
        clientId: mergePublishSecret(req.body.clientId, current.clientId),
        clientSecret: mergePublishSecret(req.body.clientSecret, current.clientSecret),
        accessToken: mergePublishSecret(req.body.accessToken, current.accessToken),
        refreshToken: mergePublishSecret(req.body.refreshToken, current.refreshToken),
      })
    );
    res.json({ data: maskBilibiliPublishSettings(saved) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/publish-settings/bilibili/test', (req: Request, res: Response) => {
  try {
    const settings = withWorkflowDatabase((database) => database.getBilibiliPublishSettings());
    const publisher = new NotConfiguredBilibiliOpenPlatformPublisher(settings ?? {});
    publisher.testConnection()
      .then((data) => res.json({ data }))
      .catch((error) => res.status(502).json({ error: error instanceof Error ? error.message : String(error) }));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.get('/tasks/:taskId', (req: Request, res: Response) => {
  const task = workflowManager.getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Workflow task not found' });
    return;
  }
  res.json({ data: task });
});

router.get('/tasks/:taskId/video', (req: Request, res: Response) => {
  const task = workflowManager.getTask(req.params.taskId);
  if (!task?.videoPath || !existsSync(task.videoPath)) {
    res.status(404).json({ error: 'Workflow video not found' });
    return;
  }
  res.sendFile(task.videoPath);
});

router.get('/tasks/:taskId/cover', (req: Request, res: Response) => {
  try {
    const coverPath = workflowManager.getCoverPath(req.params.taskId);
    res.sendFile(coverPath);
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.get('/tasks/:taskId/publish/preview', (req: Request, res: Response) => {
  try {
    const preview = workflowManager.previewBilibiliPublish(req.params.taskId);
    res.json({ data: preview });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/tasks/:taskId/publish/bilibili-open-platform', async (req: Request, res: Response) => {
  try {
    const preview = workflowManager.previewBilibiliPublish(req.params.taskId);
    const publisher = new NotConfiguredBilibiliOpenPlatformPublisher(req.body?.credentials);
    const videoResult = await publisher.publishVideo(preview);
    const articleResult = preview.syncArticle && publisher.publishArticle
      ? await publisher.publishArticle(preview)
      : undefined;
    res.json({
      data: {
        video: videoResult,
        article: articleResult,
        preview,
      },
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.get('/tasks/:taskId/assets/:assetName/preview', (req: Request, res: Response) => {
  try {
    const assetPath = workflowManager.getAssetPath(req.params.taskId, req.params.assetName);
    res.sendFile(assetPath);
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.get('/tasks/:taskId/assets/by-index/:assetIndex/preview', (req: Request, res: Response) => {
  try {
    const assetPath = workflowManager.getAssetPathByIndex(req.params.taskId, Number(req.params.assetIndex));
    res.sendFile(assetPath);
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/tasks', (req: Request<unknown, unknown, CreateWorkflowTaskRequest>, res: Response) => {
  try {
    const task = workflowManager.createTask(req.body);
    res.json({ data: task });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/tasks/:taskId/approve', (req: Request, res: Response) => {
  try {
    const task = workflowManager.approveTask(req.params.taskId, req.body?.note);
    res.json({ data: task });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/tasks/:taskId/reject', (req: Request, res: Response) => {
  try {
    const task = workflowManager.rejectTask(req.params.taskId, req.body?.note);
    res.json({ data: task });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/tasks/:taskId/continue-assets', (req: Request, res: Response) => {
  try {
    const mode = req.body?.mode || 'manual';
    if (mode !== 'manual' && mode !== 'ai_rules' && mode !== 'keep_all') {
      res.status(400).json({ error: 'Mode must be manual, ai_rules, or keep_all' });
      return;
    }
    const task = workflowManager.continueAfterAssetReview(req.params.taskId, mode);
    res.json({ data: task });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/tasks/:taskId/continue-cover', (req: Request, res: Response) => {
  try {
    const task = workflowManager.continueAfterCoverReview(req.params.taskId);
    res.json({ data: task });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/tasks/:taskId/resume', (req: Request, res: Response) => {
  try {
    const task = workflowManager.resumeFailedTask(req.params.taskId);
    res.json({ data: task });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/tasks/:taskId/rerender-video', (req: Request, res: Response) => {
  try {
    const task = workflowManager.rerenderVideo(req.params.taskId, req.body?.note, req.body?.options);
    res.json({ data: task });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/tasks/:taskId/regenerate-cover', async (req: Request, res: Response) => {
  try {
    const task = await workflowManager.regenerateCover(req.params.taskId, {
      assetNames: Array.isArray(req.body?.assetNames) ? req.body.assetNames : undefined,
      layout: typeof req.body?.layout === 'string' ? req.body.layout : undefined,
      title: typeof req.body?.title === 'string' ? req.body.title : undefined,
    });
    res.json({ data: task });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.patch('/tasks/:taskId/assets/:assetName', (req: Request, res: Response) => {
  try {
    const status = req.body?.status;
    if (status !== 'accepted' && status !== 'rejected') {
      res.status(400).json({ error: 'Asset status must be accepted or rejected' });
      return;
    }
    const task = workflowManager.updateAssetStatus(
      req.params.taskId,
      req.params.assetName,
      status,
      req.body?.reason
    );
    res.json({ data: task });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

export default router;
