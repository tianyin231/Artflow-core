import { JobQueue, MemoryJobStore } from '../../jobs/JobQueue';

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('JobQueue', () => {
  it('enqueues and runs a job to success', async () => {
    const store = new MemoryJobStore();
    const q = new JobQueue(store);
    const seen: string[] = [];
    q.register('download', async (job) => {
      seen.push(job.id);
    });
    const job = q.enqueue({ kind: 'download', payload: { a: 1 } });
    await q.tick();
    await sleep(10);
    expect(seen).toContain(job.id);
    expect(store.get(job.id)?.status).toBe('succeeded');
  });

  it('respects idempotency key', () => {
    const store = new MemoryJobStore();
    const q = new JobQueue(store);
    const a = q.enqueue({ kind: 'render', payload: {}, idempotencyKey: 'k1' });
    const b = q.enqueue({ kind: 'render', payload: {}, idempotencyKey: 'k1' });
    expect(a.id).toBe(b.id);
  });

  it('retries then dead-letters', async () => {
    const store = new MemoryJobStore();
    const q = new JobQueue(store, { maxAttempts: 2, baseDelayMs: 1 });
    q.register('publish', async () => {
      throw new Error('boom');
    });
    const job = q.enqueue({ kind: 'publish', payload: {}, maxAttempts: 2 });
    await q.tick();
    await sleep(20);
    const j = store.get(job.id)!;
    store.fail(j.id, 'boom', 0, Date.now());
    await q.tick();
    await sleep(20);
    expect(store.get(job.id)?.status).toBe('dead');
  });

  it('enforces per-kind concurrency', async () => {
    const store = new MemoryJobStore();
    const q = new JobQueue(store, { concurrency: { download: 1, render: 1, publish: 1, workflow: 1 } });
    let maxParallel = 0;
    let active = 0;
    q.register('download', async () => {
      active++;
      maxParallel = Math.max(maxParallel, active);
      await sleep(30);
      active--;
    });
    for (let i = 0; i < 3; i++) q.enqueue({ kind: 'download', payload: { i } });
    // drive the queue until idle
    for (let i = 0; i < 10; i++) {
      await q.tick();
      await sleep(15);
    }
    expect(maxParallel).toBeLessThanOrEqual(1);
    expect(store.countByStatus().succeeded).toBe(3);
  });

  it('cancels a running job via AbortSignal', async () => {
    const store = new MemoryJobStore();
    const q = new JobQueue(store);
    let aborted = false;
    q.register('download', async (_job, signal) => {
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
        setTimeout(resolve, 100);
      });
    });
    const job = q.enqueue({ kind: 'download', payload: {} });
    await q.tick();
    await sleep(5);
    q.cancel(job.id);
    await sleep(20);
    expect(aborted).toBe(true);
    expect(store.get(job.id)?.status).toBe('cancelled');
  });

  it('requeues expired leases', () => {
    const store = new MemoryJobStore();
    let now = 1000;
    const q = new JobQueue(store, { now: () => now });
    const job = q.enqueue({ kind: 'render', payload: {} });
    store.claimDue(1, now);
    expect(store.get(job.id)?.status).toBe('running');
    now += 60_000;
    const n = store.requeueExpired(now);
    expect(n).toBe(1);
    expect(store.get(job.id)?.status).toBe('queued');
  });

  it('replay moves dead job back to queued', async () => {
    const store = new MemoryJobStore();
    const q = new JobQueue(store, { maxAttempts: 1 });
    q.register('publish', async () => {
      throw new Error('x');
    });
    const job = q.enqueue({ kind: 'publish', payload: {} });
    await q.tick();
    await sleep(20);
    expect(store.get(job.id)?.status).toBe('dead');
    q.replay(job.id);
    expect(store.get(job.id)?.status).toBe('queued');
  });

  it('exposes metrics', async () => {
    const store = new MemoryJobStore();
    const q = new JobQueue(store);
    q.enqueue({ kind: 'download', payload: {} });
    const m = q.metrics();
    expect(m.depth).toBeGreaterThanOrEqual(1);
    expect(m.byStatus.queued).toBeGreaterThanOrEqual(1);
  });
});
