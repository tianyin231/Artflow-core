import { Router, Request, Response } from 'express';
import { existsSync } from 'node:fs';
import { workflowManager } from '../../workflow/WorkflowManager';
import { CreateWorkflowTaskRequest } from '../../workflow/types';
import { defaultPresets, withWorkflowDatabase } from '../../workflow/workflow-store';
import { AiSettingsRecord, CommandPresetRecord } from '../../storage/repositories/WorkflowRepository';

const router = Router();

type AiProvider = AiSettingsRecord['provider'];

interface AiModelInfo {
  id: string;
  name: string;
  source?: string;
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
      planningMode: req.body.planningMode || 'rules-first',
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
