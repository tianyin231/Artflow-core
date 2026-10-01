/**
 * Persistent SQLite job queue (F2-M2). No Redis.
 */
import { EventEmitter } from 'node:events';

export type JobKind = 'download' | 'render' | 'publish' | 'workflow';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'dead' | 'cancelled';

export interface JobRow {
  id: string;
  kind: JobKind;
  payload: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  nextRunAt: number;
  leaseUntil: number | null;
  lastError: string | null;
  idempotencyKey: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface EnqueueOptions {
  kind: JobKind;
  payload: unknown;
  idempotencyKey?: string;
  maxAttempts?: number;
  nextRunAt?: number;
}

export interface JobStore {
  insert(job: JobRow): void;
  get(id: string): JobRow | null;
  findByIdempotencyKey(key: string): JobRow | null;
  claimDue(limit: number, now: number, kind?: JobKind): JobRow[];
  heartbeat(id: string, leaseUntil: number): void;
  complete(id: string, now: number): void;
  fail(id: string, error: string, nextRunAt: number, now: number): void;
  dead(id: string, error: string, now: number): void;
  cancel(id: string, now: number): void;
  requeueExpired(now: number): number;
  countByStatus(): Record<JobStatus, number>;
  listByStatus(status: JobStatus, limit: number): JobRow[];
  depth(): number;
}

/** In-memory store (tests + fallback). */
export class MemoryJobStore implements JobStore {
  private map = new Map<string, JobRow>();

  insert(job: JobRow): void {
    this.map.set(job.id, { ...job });
  }
  get(id: string): JobRow | null {
    return this.map.get(id) ? { ...this.map.get(id)! } : null;
  }
  findByIdempotencyKey(key: string): JobRow | null {
    for (const j of this.map.values()) {
      if (j.idempotencyKey === key) return { ...j };
    }
    return null;
  }
  claimDue(limit: number, now: number, kind?: JobKind): JobRow[] {
    const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
    const out: JobRow[] = [];
    if (max === 0) return out;
    for (const j of this.map.values()) {
      if (out.length >= max) break;
      if (kind && j.kind !== kind) continue;
      if (j.status === 'queued' && j.nextRunAt <= now && (j.leaseUntil === null || j.leaseUntil <= now)) {
        j.status = 'running';
        j.leaseUntil = now + 30_000;
        out.push({ ...j });
      }
    }
    return out;
  }
  heartbeat(id: string, leaseUntil: number): void {
    const j = this.map.get(id);
    if (j) j.leaseUntil = leaseUntil;
  }
  complete(id: string, now: number): void {
    const j = this.map.get(id);
    if (j) {
      j.status = 'succeeded';
      j.leaseUntil = null;
      j.updatedAt = now;
    }
  }
  fail(id: string, error: string, nextRunAt: number, now: number): void {
    const j = this.map.get(id);
    if (j) {
      j.status = 'queued';
      j.attempts += 1;
      j.lastError = error;
      j.nextRunAt = nextRunAt;
      j.leaseUntil = null;
      j.updatedAt = now;
    }
  }
  dead(id: string, error: string, now: number): void {
    const j = this.map.get(id);
    if (j) {
      j.status = 'dead';
      j.lastError = error;
      j.leaseUntil = null;
      j.updatedAt = now;
    }
  }
  cancel(id: string, now: number): void {
    const j = this.map.get(id);
    if (j && (j.status === 'queued' || j.status === 'running')) {
      j.status = 'cancelled';
      j.leaseUntil = null;
      j.updatedAt = now;
    }
  }
  requeueExpired(now: number): number {
    let n = 0;
    for (const j of this.map.values()) {
      if (j.status === 'running' && j.leaseUntil !== null && j.leaseUntil <= now) {
        j.status = 'queued';
        j.leaseUntil = null;
        n++;
      }
    }
    return n;
  }
  countByStatus(): Record<JobStatus, number> {
    const c: Record<string, number> = { queued: 0, running: 0, succeeded: 0, failed: 0, dead: 0, cancelled: 0 };
    for (const j of this.map.values()) c[j.status] = (c[j.status] || 0) + 1;
    return c as Record<JobStatus, number>;
  }
  listByStatus(status: JobStatus, limit: number): JobRow[] {
    return [...this.map.values()].filter((j) => j.status === status).slice(0, limit).map((j) => ({ ...j }));
  }
  depth(): number {
    return [...this.map.values()].filter((j) => j.status === 'queued' || j.status === 'running').length;
  }
}

export type JobHandler = (job: JobRow, signal: AbortSignal) => Promise<void>;

export interface QueueOptions {
  concurrency?: Record<JobKind, number>;
  maxAttempts?: number;
  baseDelayMs?: number;
  leaseMs?: number;
  now?: () => number;
}

const DEFAULT_CONCURRENCY: Record<JobKind, number> = {
  download: 2,
  render: 1,
  publish: 1,
  workflow: 1,
};

export class JobQueue extends EventEmitter {
  private running = 0;
  private byKind: Record<string, number> = {};
  private handlers = new Map<JobKind, JobHandler>();
  private aborts = new Map<string, AbortController>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: JobStore,
    private readonly opts: QueueOptions = {}
  ) {
    super();
  }

  register(kind: JobKind, handler: JobHandler): void {
    this.handlers.set(kind, handler);
  }

  enqueue(opts: EnqueueOptions): JobRow {
    const now = (this.opts.now ?? Date.now)();
    if (opts.idempotencyKey) {
      const existing = this.store.findByIdempotencyKey(opts.idempotencyKey);
      if (existing) return existing;
    }
    const job: JobRow = {
      id: `job_${now}_${Math.random().toString(36).slice(2, 8)}`,
      kind: opts.kind,
      payload: JSON.stringify(opts.payload ?? {}),
      status: 'queued',
      attempts: 0,
      maxAttempts: opts.maxAttempts ?? this.opts.maxAttempts ?? 3,
      nextRunAt: opts.nextRunAt ?? now,
      leaseUntil: null,
      lastError: null,
      idempotencyKey: opts.idempotencyKey ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.insert(job);
    this.emit('enqueued', job);
    return job;
  }

  private backoff(attempt: number): number {
    const base = this.opts.baseDelayMs ?? 500;
    const jitter = Math.floor(Math.random() * 100);
    return Math.min(base * Math.pow(2, attempt - 1), 30_000) + jitter;
  }

  private async runOne(job: JobRow): Promise<void> {
    const handler = this.handlers.get(job.kind);
    const now = (this.opts.now ?? Date.now)();
    if (!handler) {
      this.store.dead(job.id, `no handler for ${job.kind}`, now);
      this.emit('dead', job);
      return;
    }
    const ac = new AbortController();
    this.aborts.set(job.id, ac);
    try {
      await handler(job, ac.signal);
      this.store.complete(job.id, (this.opts.now ?? Date.now)());
      this.emit('succeeded', job);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const current = this.store.get(job.id);
      if (!current || current.status === 'cancelled') {
        // cancelled while running — keep cancelled
        this.emit('cancelled', job.id);
        return;
      }
      const attempts = current.attempts + 1;
      if (attempts >= current.maxAttempts) {
        this.store.dead(job.id, msg, (this.opts.now ?? Date.now)());
        this.emit('dead', job);
      } else {
        this.store.fail(job.id, msg, (this.opts.now ?? Date.now)() + this.backoff(attempts), (this.opts.now ?? Date.now)());
        this.emit('failed', job);
      }
    } finally {
      this.aborts.delete(job.id);
    }
  }

  async tick(): Promise<number> {
    this.store.requeueExpired((this.opts.now ?? Date.now)());
    const concurrency = { ...DEFAULT_CONCURRENCY, ...(this.opts.concurrency ?? {}) };
    let started = 0;
    for (const kind of Object.keys(concurrency) as JobKind[]) {
      const limit = concurrency[kind];
      const used = this.byKind[kind] ?? 0;
      const can = Math.max(0, Math.floor(limit) - used);
      if (can === 0) continue;
      const jobs = this.store.claimDue(can, (this.opts.now ?? Date.now)(), kind);
      for (const job of jobs) {
        this.byKind[kind] = (this.byKind[kind] ?? 0) + 1;
        this.running++;
        started++;
        void this.runOne(job).finally(() => {
          this.byKind[kind] = Math.max(0, (this.byKind[kind] ?? 1) - 1);
          this.running--;
        });
      }
    }
    return started;
  }

  start(intervalMs = 200): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const ac of this.aborts.values()) ac.abort();
    this.aborts.clear();
  }

  cancel(id: string): void {
    const ac = this.aborts.get(id);
    if (ac) ac.abort();
    this.store.cancel(id, (this.opts.now ?? Date.now)());
    this.emit('cancelled', id);
  }

  replay(id: string): JobRow | null {
    const job = this.store.get(id);
    if (!job) return null;
    if (job.status === 'dead' || job.status === 'failed' || job.status === 'cancelled') {
      this.store.fail(id, job.lastError ?? 'replay', (this.opts.now ?? Date.now)(), (this.opts.now ?? Date.now)());
    }
    return this.store.get(id);
  }

  metrics() {
    return {
      depth: this.store.depth(),
      byStatus: this.store.countByStatus(),
      running: this.running,
    };
  }
}
