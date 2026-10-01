import { metrics, observeHttp } from '../../webui/routes/metrics';

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
});
