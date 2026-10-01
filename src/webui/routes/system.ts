import { Router, Request, Response } from 'express';
import { existsSync, mkdirSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { getConfigPath, loadConfig } from '../../config';
import { withWorkflowDatabase } from '../../workflow/workflow-store';
import { Database } from '../../storage/Database';
import { isPlaceholderToken } from '../../utils/token-manager';
import { resolvePython } from '../../runtime/resolvePython';

const router = Router();

type SystemCheckStatus = 'ok' | 'warning' | 'error';

interface SystemCheckItem {
  id: string;
  label: string;
  status: SystemCheckStatus;
  message: string;
  detail?: string;
  suggestion?: string;
}

interface SystemCheckResult {
  status: SystemCheckStatus;
  checkedAt: string;
  summary: {
    ok: number;
    warning: number;
    error: number;
  };
  items: SystemCheckItem[];
}

function item(
  id: string,
  label: string,
  status: SystemCheckStatus,
  message: string,
  suggestion?: string,
  detail?: string
): SystemCheckItem {
  return { id, label, status, message, suggestion, detail };
}

async function canWriteDirectory(path: string): Promise<boolean> {
  mkdirSync(path, { recursive: true });
  await access(path, constants.W_OK);
  return true;
}

function checkVideoRenderPythonDeps(): { ok: true } | { ok: false; detail: string } {
  try {
    execFileSync(resolvePython(), [
      '-c',
      'import numpy; import imageio_ffmpeg; import moviepy; import PIL; import proglog; print("OK")',
    ], {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

router.get('/check', async (req: Request, res: Response) => {
  const items: SystemCheckItem[] = [];
  let config: ReturnType<typeof loadConfig> | undefined;
  const configPath = getConfigPath();

  try {
    config = loadConfig(configPath);
    items.push(item('config', '配置文件', 'ok', '配置文件可读取并通过基础校验', undefined, configPath));
  } catch (error) {
    items.push(item(
      'config',
      '配置文件',
      'error',
      '配置文件读取或校验失败',
      '进入配置管理页面修复 JSON、路径和必填字段，或重新运行初始化配置。',
      error instanceof Error ? error.message : String(error)
    ));

    try {
      config = loadConfig(configPath, true);
    } catch {
      config = undefined;
    }
  }

  const refreshToken = config?.pixiv?.refreshToken;
  const hasPixivToken = Boolean(refreshToken && !isPlaceholderToken(refreshToken));
  items.push(item(
    'pixiv-auth',
    'Pixiv 登录',
    hasPixivToken ? 'ok' : 'error',
    hasPixivToken ? '已检测到 Pixiv refresh token' : '未检测到有效 Pixiv refresh token',
    hasPixivToken ? undefined : '点击登录或在配置中填入有效 refresh token。'
  ));

  const storage = config?.storage;
  const storageTargets = [
    ['download-dir', '下载目录', storage?.downloadDirectory],
    ['illustration-dir', '插画目录', storage?.illustrationDirectory],
    ['novel-dir', '小说目录', storage?.novelDirectory],
    ['database-dir', '数据库目录', storage?.databasePath ? dirname(storage.databasePath) : undefined],
  ] as const;
  for (const [id, label, path] of storageTargets) {
    if (!path) {
      items.push(item(id, label, 'warning', `${label}未配置`, '进入配置管理页面补齐存储路径。'));
      continue;
    }
    try {
      await canWriteDirectory(resolve(path));
      items.push(item(id, label, 'ok', `${label}可写`, undefined, resolve(path)));
    } catch (error) {
      items.push(item(
        id,
        label,
        'error',
        `${label}不可写`,
        '检查目录权限，或在配置管理中切换到当前用户可写路径。',
        error instanceof Error ? error.message : String(error)
      ));
    }
  }

  const rendererPath = resolve(process.cwd(), 'scripts', 'workflow-render-video.py');
  items.push(item(
    'video-renderer',
    '视频渲染脚本',
    existsSync(rendererPath) ? 'ok' : 'error',
    existsSync(rendererPath) ? 'MoviePy 渲染脚本存在' : '缺少 MoviePy 渲染脚本',
    existsSync(rendererPath) ? undefined : '确认项目安装完整，或恢复 scripts/workflow-render-video.py。',
    rendererPath
  ));

  const renderDeps = checkVideoRenderPythonDeps();
  items.push(item(
    'video-renderer-python-deps',
    '视频渲染 Python 依赖',
    renderDeps.ok ? 'ok' : 'error',
    renderDeps.ok ? 'MoviePy 视频渲染依赖已就绪' : '缺少 MoviePy 视频渲染依赖',
    renderDeps.ok ? undefined : '在 Artflow-core 目录运行 npm run setup:python，或手动执行 python -m pip install -r requirements-python.txt。',
    renderDeps.ok ? undefined : renderDeps.detail
  ));

  try {
    const aiSettings = config?.storage?.databasePath
      ? (() => {
          const database = new Database(config.storage!.databasePath!);
          try {
            database.migrate();
            return database.getAiSettings();
          } finally {
            database.close();
          }
        })()
      : withWorkflowDatabase((database) => database.getAiSettings());
    if (!aiSettings || aiSettings.provider === 'local-rules') {
      items.push(item('ai-caption', 'AI 发布文案', 'warning', '当前使用本地规则生成文案', '如需更高质量文案，在 AI 接入页配置 OpenAI/Anthropic/Ollama。'));
    } else {
      const needsApiKey = aiSettings.provider !== 'ollama';
      const ready = !needsApiKey || Boolean(aiSettings.apiKey);
      items.push(item(
        'ai-caption',
        'AI 发布文案',
        ready ? 'ok' : 'error',
        ready ? `已配置 ${aiSettings.provider} 文案生成` : `${aiSettings.provider} 缺少 API Key`,
        ready ? undefined : '进入 AI 接入页补齐 API Key 或切换到本地规则。'
      ));
    }
  } catch (error) {
    items.push(item(
      'ai-caption',
      'AI 发布文案',
      'warning',
      '暂时无法读取 AI 发布文案配置',
      '先修复配置文件或完成 Pixiv 登录后，再重新运行系统检查。',
      error instanceof Error ? error.message : String(error)
    ));
  }

  items.push(item(
    'bilibili-open-platform',
    'B站开放平台',
    'warning',
    '发布接口已预留，真实开放平台凭证尚未接入',
    '后续接入 clientId、clientSecret、accessToken 后即可替换占位发布器。'
  ));

  const summary = items.reduce(
    (acc, check) => {
      acc[check.status] += 1;
      return acc;
    },
    { ok: 0, warning: 0, error: 0 }
  );
  const status: SystemCheckStatus = summary.error > 0 ? 'error' : summary.warning > 0 ? 'warning' : 'ok';
  const result: SystemCheckResult = {
    status,
    checkedAt: new Date().toISOString(),
    summary,
    items,
  };

  res.json({ data: result });
});

export default router;
