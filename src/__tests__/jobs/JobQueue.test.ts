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
    let now = 1000;
    const q = new JobQueue(store, { maxAttempts: 2, baseDelayMs: 1, now: () => now });
    q.register('publish', async () => {
      throw new Error('boom');
    });
    const job = q.enqueue({ kind: 'publish', payload: {}, maxAttempts: 2 });
    await q.tick();
    await sleep(20);
    expect(store.get(job.id)?.attempts).toBe(1);
    now += 1000;
    await q.tick();
    await sleep(20);
    expect(store.get(job.id)?.status).toBe('dead');
    expect(store.get(job.id)?.attempts).toBe(2);
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

  it('keeps a cancelled job cancelled when its handler resolves', async () => {
    const store = new MemoryJobStore();
    const q = new JobQueue(store);
    let finish!: () => void;
    q.register('render', () => new Promise<void>((resolve) => { finish = resolve; }));
    const succeeded = jest.fn();
    q.on('succeeded', succeeded);
    const job = q.enqueue({ kind: 'render', payload: {} });
    await q.tick();
    q.cancel(job.id);
    finish();
    await Promise.resolve();
    expect(store.get(job.id)?.status).toBe('cancelled');
    expect(succeeded).not.toHaveBeenCalled();
  });

  it('renews configured leases so another worker cannot duplicate a long job', async () => {
    jest.useFakeTimers();
    try {
      const store = new MemoryJobStore();
      const q = new JobQueue(store, { leaseMs: 90 });
      const second = new JobQueue(store, { leaseMs: 90 });
      let finish!: () => void;
      q.register('download', () => new Promise<void>((resolve) => { finish = resolve; }));
      const duplicate = jest.fn(async () => {});
      second.register('download', duplicate);
      const job = q.enqueue({ kind: 'download', payload: {} });
      await q.tick();
      expect(store.get(job.id)?.leaseUntil).toBe(Date.now() + 90);
      jest.advanceTimersByTime(350);
      expect(await second.tick()).toBe(0);
      expect(duplicate).not.toHaveBeenCalled();
      expect(store.get(job.id)?.attempts).toBe(1);
      finish();
      await Promise.resolve();
      expect(store.get(job.id)?.status).toBe('succeeded');
      q.stop();
      second.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not let an expired worker complete a job owned by its replacement', async () => {
    let now = 1000;
    const store = new MemoryJobStore();
    const first = new JobQueue(store, { leaseMs: 90, now: () => now });
    const second = new JobQueue(store, { leaseMs: 90, now: () => now });
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    first.register('render', () => new Promise<void>((resolve) => { finishFirst = resolve; }));
    second.register('render', () => new Promise<void>((resolve) => { finishSecond = resolve; }));
    const job = first.enqueue({ kind: 'render', payload: {} });
    await first.tick();
    first.stop();
    now += 100;
    expect(await second.tick()).toBe(1);
    const replacementToken = store.get(job.id)?.leaseToken;
    finishFirst();
    await Promise.resolve();
    expect(store.get(job.id)?.status).toBe('running');
    expect(store.get(job.id)?.leaseToken).toBe(replacementToken);
    finishSecond();
    await Promise.resolve();
    expect(store.get(job.id)?.status).toBe('succeeded');
    expect(store.get(job.id)?.attempts).toBe(2);
    second.stop();
  });

  it('dead-letters repeatedly expired leases within the retry budget', () => {
    const store = new MemoryJobStore();
    const q = new JobQueue(store, { maxAttempts: 2, now: () => 1000 });
    const job = q.enqueue({ kind: 'workflow', payload: {} });
    store.claimDue(1, 1000, 'workflow', 10);
    store.requeueExpired(1010);
    store.claimDue(1, 1010, 'workflow', 10);
    store.requeueExpired(1020);
    expect(store.get(job.id)?.status).toBe('dead');
    expect(store.get(job.id)?.attempts).toBe(2);
  });

  it('replay restores a fresh retry budget', async () => {
    let now = 1000;
    let failures = 0;
    const store = new MemoryJobStore();
    const q = new JobQueue(store, { maxAttempts: 2, now: () => now });
    q.register('publish', async () => {
      if (failures++ < 3) throw new Error('transient');
    });
    const job = q.enqueue({ kind: 'publish', payload: {} });
    for (let i = 0; i < 2; i++) {
      await q.tick();
      await Promise.resolve();
      now += 1000;
    }
    expect(store.get(job.id)?.status).toBe('dead');
    expect(q.replay(job.id)?.attempts).toBe(0);
    for (let i = 0; i < 2; i++) {
      await q.tick();
      await Promise.resolve();
      now += 1000;
    }
    expect(store.get(job.id)?.status).toBe('succeeded');
    expect(store.get(job.id)?.attempts).toBe(2);
  });

  it('rejects invalid retry and timing values before storing a job', () => {
    const store = new MemoryJobStore();
    const q = new JobQueue(store);
    expect(() => q.enqueue({ kind: 'render', payload: {}, maxAttempts: NaN })).toThrow();
    expect(() => q.enqueue({ kind: 'render', payload: {}, maxAttempts: 0 })).toThrow();
    expect(() => q.enqueue({ kind: 'render', payload: {}, nextRunAt: Infinity })).toThrow();
    expect(() => new JobQueue(store, { leaseMs: 0 })).toThrow();
    expect(() => new JobQueue(store, { concurrency: { render: Infinity } })).toThrow();
    expect(store.depth()).toBe(0);
  });
});
