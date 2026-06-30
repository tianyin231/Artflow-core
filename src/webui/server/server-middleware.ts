import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { logger } from '../../logger';
import { WebUIServerOptions } from './types';

const QUIET_SUCCESS_GET_PATHS = new Set([
  '/api/auth/status',
  '/status',
  '/api/workflow/tasks',
  '/tasks',
  '/api/workflow/presets',
  '/presets',
  '/api/download/status',
  '/api/logs',
]);

function shouldLogRequest(req: Request, statusCode: number, durationMs: number): boolean {
  if (statusCode >= 400) {
    return true;
  }
  if (durationMs >= 1000) {
    return true;
  }
  if (req.method !== 'GET') {
    return true;
  }
  if (statusCode === 304) {
    return false;
  }
  const pathCandidates = [req.path, req.originalUrl.split('?')[0]].filter(Boolean);
  if (pathCandidates.some((path) => QUIET_SUCCESS_GET_PATHS.has(path))) {
    return false;
  }
  if (pathCandidates.some((path) => /^\/(?:api\/workflow\/)?tasks\/[^/]+$/.test(path))) {
    return false;
  }
  return true;
}

/**
 * Setup middleware for Express app
 */
export function setupMiddleware(app: Express, options: WebUIServerOptions): void {
  // JSON and URL-encoded body parsing
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // CORS configuration
  if (options.enableCors !== false) {
    app.use(
      cors({
        origin: options.corsOrigin || '*',
        credentials: true,
      })
    );
  }

  // Request logging
  app.use((req: Request, res: Response, next: NextFunction) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      const durationMs = Date.now() - startedAt;
      if (!shouldLogRequest(req, res.statusCode, durationMs)) {
        return;
      }
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      logger[level](`${req.method} ${req.path}`, {
        statusCode: res.statusCode,
        durationMs,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });
    });
    next();
  });
}

/**
 * Error handler middleware
 */
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  logger.error('API Error', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
}
