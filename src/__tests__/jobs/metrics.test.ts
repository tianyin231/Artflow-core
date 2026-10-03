import express from 'express';
import request from 'supertest';
import metricsRouter, { metrics, observeHttp } from '../../webui/routes/metrics';
import { setupMiddleware } from '../../webui/server/server-middleware';
import { setupRoutes } from '../../webui/server/server-routes';
import { logger } from '../../logger';

describe('metrics', () => {
  it('tracks http counters', () => {
    const before = metrics.httpRequests;
    observeHttp(true);
    observeHttp(false);
    expect(metrics.httpRequests).toBe(before + 2);
    expect(metrics.httpErrors).toBeGreaterThanOrEqual(1);
  });

  it('has prometheus field names', () => {
    // shape check without spinning express
    expect(typeof metrics.jobsEnqueued).toBe('number');
    expect(typeof metrics.providerCalls).toBe('number');
    expect(Array.isArray(metrics.renderMs)).toBe(true);
  });

  it('exposes summary totals and escapes provider error labels', async () => {
    const app = express();
    app.use('/metrics', metricsRouter);
    const oldRenders = metrics.renderMs;
    const oldErrors = metrics.providerErrors;
    try {
      metrics.renderMs = [10, 20];
      metrics.providerErrors = { 'bad"code\\path\nnext': 2 };
      const response = await request(app).get('/metrics').expect(200);
      expect(response.text).toContain('artflow_render_duration_ms{quantile="0.5"} 10\n');
      expect(response.text).toContain('artflow_render_duration_ms_sum 30\n');
      expect(response.text).toContain('artflow_render_duration_ms_count 2\n');
      expect(response.text).toContain('artflow_provider_errors_total{code="bad\\"code\\\\path\\nnext"} 2\n');
    } finally {
      metrics.renderMs = oldRenders;
      metrics.providerErrors = oldErrors;
    }
  });

  it('counts completed server requests and errors and serves both metrics paths', async () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => {});
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const app = express();
      setupMiddleware(app, { enableCors: false });
      setupRoutes(app);
      const requests = metrics.httpRequests;
      const errors = metrics.httpErrors;
      await request(app).get('/api/health').expect(200);
      await request(app).get('/api/missing').expect(404);
      expect(metrics.httpRequests).toBe(requests + 2);
      expect(metrics.httpErrors).toBe(errors + 1);
      for (const path of ['/api/metrics', '/metrics']) {
        const response = await request(app).get(path).expect(200);
        expect(response.text).toContain('artflow_http_requests_total ');
        expect(response.headers['content-type']).toContain('text/plain');
      }
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });
});
