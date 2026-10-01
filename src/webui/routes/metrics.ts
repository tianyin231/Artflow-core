/**
 * Prometheus-style metrics (F2-M2).
 */
import { Router, Request, Response } from 'express';

const router = Router();

export interface MetricsCounters {
  httpRequests: number;
  httpErrors: number;
  jobsEnqueued: number;
  jobsSucceeded: number;
  jobsFailed: number;
  renderMs: number[];
  providerCalls: number;
  providerErrors: Record<string, number>;
}

export const metrics: MetricsCounters = {
  httpRequests: 0,
  httpErrors: 0,
  jobsEnqueued: 0,
  jobsSucceeded: 0,
  jobsFailed: 0,
  renderMs: [],
  providerCalls: 0,
  providerErrors: {},
};

export function observeHttp(ok: boolean): void {
  metrics.httpRequests += 1;
  if (!ok) metrics.httpErrors += 1;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

router.get('/', (_req: Request, res: Response) => {
  const renders = [...metrics.renderMs].sort((a, b) => a - b);
  const lines = [
    '# HELP artflow_http_requests_total Total HTTP requests',
    '# TYPE artflow_http_requests_total counter',
    `artflow_http_requests_total ${metrics.httpRequests}`,
    '# HELP artflow_http_errors_total Total HTTP errors',
    '# TYPE artflow_http_errors_total counter',
    `artflow_http_errors_total ${metrics.httpErrors}`,
    '# HELP artflow_jobs_enqueued_total Jobs enqueued',
    '# TYPE artflow_jobs_enqueued_total counter',
    `artflow_jobs_enqueued_total ${metrics.jobsEnqueued}`,
    '# HELP artflow_jobs_succeeded_total Jobs succeeded',
    '# TYPE artflow_jobs_succeeded_total counter',
    `artflow_jobs_succeeded_total ${metrics.jobsSucceeded}`,
    '# HELP artflow_jobs_failed_total Jobs failed',
    '# TYPE artflow_jobs_failed_total counter',
    `artflow_jobs_failed_total ${metrics.jobsFailed}`,
    '# HELP artflow_render_duration_ms Render duration',
    '# TYPE artflow_render_duration_ms summary',
    `artflow_render_duration_ms{quantile="0.5"} ${percentile(renders, 50)}`,
    `artflow_render_duration_ms{quantile="0.95"} ${percentile(renders, 95)}`,
    '# HELP artflow_provider_calls_total Provider calls',
    '# TYPE artflow_provider_calls_total counter',
    `artflow_provider_calls_total ${metrics.providerCalls}`,
  ];
  for (const [code, n] of Object.entries(metrics.providerErrors)) {
    lines.push(`artflow_provider_errors_total{code="${code}"} ${n}`);
  }
  res.setHeader('Content-Type', 'text/plain; version=0.0.4');
  res.send(lines.join('\n') + '\n');
});

export default router;
