#!/usr/bin/env node

import { startWebUI } from './server/server';
import path from 'path';
import fs from 'fs';

import { PORTS } from './ports';

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : PORTS.PROD_API;
const host = process.env.HOST || process.env.ARTFLOW_HOST || '127.0.0.1';

/**
 * 自动检测静态文件路径
 * 按优先级顺序检查：
 * 1. 环境变量 STATIC_PATH
 * 2. 相对于项目根目录的 webui-frontend/dist
 * 3. 相对于当前工作目录的 webui-frontend/dist
 */
function findStaticPath(): string | undefined {
  // 1. 检查环境变量
  if (process.env.STATIC_PATH) {
    const envPath = path.resolve(process.env.STATIC_PATH);
    if (fs.existsSync(envPath)) {
      const indexPath = path.join(envPath, 'index.html');
      if (fs.existsSync(indexPath)) {
        return envPath;
      }
    }
  }

  // 2. 检查项目根目录下的 webui-frontend/dist
  const projectRoot = path.resolve(__dirname, '../..');
  const projectStaticPath = path.join(projectRoot, 'webui-frontend', 'dist');
  if (fs.existsSync(projectStaticPath)) {
    const indexPath = path.join(projectStaticPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      return projectStaticPath;
    }
  }

  // 3. 检查当前工作目录下的 webui-frontend/dist
  const cwdStaticPath = path.join(process.cwd(), 'webui-frontend', 'dist');
  if (fs.existsSync(cwdStaticPath)) {
    const indexPath = path.join(cwdStaticPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      return cwdStaticPath;
    }
  }

  return undefined;
}

const staticPath = process.env.STATIC_PATH 
  ? path.resolve(process.env.STATIC_PATH)
  : findStaticPath();

// 调试日志
console.log('[WebUI] Starting server...');
console.log('[WebUI] PORT:', port);
console.log('[WebUI] HOST:', host);
console.log('[WebUI] STATIC_PATH:', staticPath || '(not found)');

if (staticPath) {
  const resolvedPath = path.resolve(staticPath);
  console.log('[WebUI] STATIC_PATH (resolved):', resolvedPath);
  console.log('[WebUI] STATIC_PATH exists:', fs.existsSync(resolvedPath));
  if (fs.existsSync(resolvedPath)) {
    try {
      const files = fs.readdirSync(resolvedPath);
      console.log('[WebUI] STATIC_PATH contents:', files.join(', '));
      const indexPath = path.join(resolvedPath, 'index.html');
      const indexExists = fs.existsSync(indexPath);
      console.log('[WebUI] index.html exists:', indexExists);
      if (!indexExists) {
        console.warn('[WebUI] ⚠️  Warning: index.html not found in static path!');
      }
    } catch (err) {
      console.error('[WebUI] Error reading STATIC_PATH:', err);
    }
  } else {
    console.warn('[WebUI] ⚠️  Warning: STATIC_PATH does not exist!');
  }
} else {
  console.log('[WebUI] ⚠️  STATIC_PATH not found - frontend will not be served');
  console.log('[WebUI] 💡 To serve the frontend, either:');
  console.log('[WebUI]    1. Set STATIC_PATH environment variable');
  console.log('[WebUI]    2. Build the frontend: npm run webui:build');
  console.log('[WebUI]    3. Ensure webui-frontend/dist exists with index.html');
}

startWebUI({
  port,
  host,
  enableCors: true,
  staticPath,
}).then((actualPort) => {
  console.log(`[WebUI] Server started successfully on port ${actualPort}`);
}).catch((error) => {
  console.error('Failed to start WebUI server:', error);
  process.exit(1);
});

