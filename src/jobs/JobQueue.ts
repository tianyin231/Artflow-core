/**
 * In-process job queue with a pluggable store and an in-memory implementation.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

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
  leaseToken: string | null;
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
  claimDue(limit: number, now: number, kind?: JobKind, leaseMs?: number): JobRow[];
  heartbeat(id: string, leaseUntil: number, leaseToken?: string): void;
  complete(id: string, now: number, leaseToken?: string): void;
  fail(id: string, error: string, nextRunAt: number, now: number, leaseToken?: string): void;
  dead(id: string, error: string, now: number, leaseToken?: string): void;
  cancel(id: string, now: number): void;
  replay(id: string, now: number): void;
  requeueExpired(now: number): number;
  countByStatus(): Record<JobStatus, number>;
  listByStatus(status: JobStatus, limit: number): JobRow[];
  depth(): number;
}

/** In-memory store (tests + fallback). */
export class MemoryJobStore implements JobStore {
  private map = new Map<string, JobRow>();

  insert(job: JobRow): void {
    if (this.map.has(job.id)) throw new Error(`duplicate job id: ${job.id}`);
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
  claimDue(limit: number, now: number, kind?: JobKind, leaseMs = 30_000): JobRow[] {
    const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
    const out: JobRow[] = [];
    if (max === 0) return out;
    for (const j of this.map.values()) {
      if (out.length >= max) break;
      if (kind && j.kind !== kind) continue;
      if (j.status === 'queued' && j.nextRunAt <= now && (j.leaseUntil === null || j.leaseUntil <= now)) {
        j.status = 'running';
        j.attempts += 1;
        j.leaseUntil = now + leaseMs;
        j.leaseToken = randomUUID();
        j.updatedAt = now;
        out.push({ ...j });
      }
    }
    return out;
  }
  heartbeat(id: string, leaseUntil: number, leaseToken?: string): void {
    const j = this.map.get(id);
    if (j?.status === 'running' && (leaseToken === undefined || j.leaseToken === leaseToken)) {
      j.leaseUntil = leaseUntil;
    }
  }
  private owns(j: JobRow | undefined, leaseToken?: string): j is JobRow {
    return Boolean(j && j.status === 'running' && (leaseToken === undefined || j.leaseToken === leaseToken));
  }
  complete(id: string, now: number, leaseToken?: string): void {
    const j = this.map.get(id);
    if (this.owns(j, leaseToken)) {
      j.status = 'succeeded';
      j.leaseUntil = null;
      j.leaseToken = null;
      j.updatedAt = now;
    }
  }
  fail(id: string, error: string, nextRunAt: number, now: number, leaseToken?: string): void {
    const j = this.map.get(id);
    if (j && (leaseToken === undefined || this.owns(j, leaseToken))) {
      j.status = 'queued';
      j.lastError = error;
      j.nextRunAt = nextRunAt;
      j.leaseUntil = null;
      j.leaseToken = null;
      j.updatedAt = now;
    }
  }
  dead(id: string, error: string, now: number, leaseToken?: string): void {
    const j = this.map.get(id);
    if (j && (leaseToken === undefined || this.owns(j, leaseToken))) {
      j.status = 'dead';
      j.lastError = error;
      j.leaseUntil = null;
      j.leaseToken = null;
      j.updatedAt = now;
    }
  }
  cancel(id: string, now: number): void {
    const j = this.map.get(id);
    if (j && (j.status === 'queued' || j.status === 'running')) {
      j.status = 'cancelled';
      j.leaseUntil = null;
      j.leaseToken = null;
      j.updatedAt = now;
    }
  }
  replay(id: string, now: number): void {
    const j = this.map.get(id);
    if (j && ['dead', 'failed', 'cancelled'].includes(j.status)) {
      j.status = 'queued';
      j.attempts = 0;
      j.nextRunAt = now;
      j.leaseUntil = null;
      j.leaseToken = null;
      j.lastError = null;
      j.updatedAt = now;
    }
  }
  requeueExpired(now: number): number {
    let n = 0;
    for (const j of this.map.values()) {
      if (j.status === 'running' && j.leaseUntil !== null && j.leaseUntil <= now) {
        j.status = j.attempts >= j.maxAttempts ? 'dead' : 'queued';
        j.lastError = 'lease expired';
        j.leaseUntil = null;
        j.leaseToken = null;
        j.updatedAt = now;
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
    const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
    return [...this.map.values()].filter((j) => j.status === status).slice(0, max).map((j) => ({ ...j }));
  }
  depth(): number {
    return [...this.map.values()].filter((j) => j.status === 'queued' || j.status === 'running').length;
  }
}

export type JobHandler = (job: JobRow, signal: AbortSignal) => Promise<void>;

export interface QueueOptions {
  concurrency?: Partial<Record<JobKind, number>>;
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
  private active = new Map<string, { controller: AbortController; token: string; heartbeat: NodeJS.Timeout }>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: JobStore,
    private readonly opts: QueueOptions = {}
  ) {
    super();
    for (const [name, value] of Object.entries(opts.concurrency ?? {})) {
      if (!Number.isInteger(value) || value < 0) throw new Error(`invalid concurrency for ${name}`);
    }
    if (!Number.isInteger(opts.maxAttempts ?? 3) || (opts.maxAttempts ?? 3) < 1) {
      throw new Error('maxAttempts must be a positive integer');
    }
    if (!Number.isFinite(opts.leaseMs ?? 30_000) || (opts.leaseMs ?? 30_000) <= 0) {
      throw new Error('leaseMs must be positive');
    }
    if (!Number.isFinite(opts.baseDelayMs ?? 500) || (opts.baseDelayMs ?? 500) < 0) {
      throw new Error('baseDelayMs must be nonnegative');
    }
  }

  register(kind: JobKind, handler: JobHandler): void {
    this.handlers.set(kind, handler);
  }

  enqueue(opts: EnqueueOptions): JobRow {
    const now = (this.opts.now ?? Date.now)();
    const maxAttempts = opts.maxAttempts ?? this.opts.maxAttempts ?? 3;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('maxAttempts must be a positive integer');
    if (!Number.isFinite(opts.nextRunAt ?? now)) throw new Error('nextRunAt must be finite');
    if (opts.idempotencyKey !== undefined) {
      if (typeof opts.idempotencyKey !== 'string' || !opts.idempotencyKey.trim()) {
        throw new Error('idempotencyKey must be a nonempty string');
      }
      const existing = this.store.findByIdempotencyKey(opts.idempotencyKey);
      if (existing) return existing;
    }
    if (!(opts.kind in DEFAULT_CONCURRENCY)) throw new Error('invalid job kind');
    const payload = JSON.stringify(opts.payload ?? {});
    if (payload === undefined) throw new Error('payload must be JSON serializable');
    const job: JobRow = {
      id: `job_${randomUUID()}`,
      kind: opts.kind,
      payload,
      status: 'queued',
      attempts: 0,
      maxAttempts,
      nextRunAt: opts.nextRunAt ?? now,
      leaseUntil: null,
      leaseToken: null,
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
      this.store.dead(job.id, `no handler for ${job.kind}`, now, job.leaseToken!);
      this.emit('dead', this.store.get(job.id));
      return;
    }
    const ac = new AbortController();
    const token = job.leaseToken!;
    const leaseMs = this.opts.leaseMs ?? 30_000;
    const heartbeat = setInterval(() => {
      const current = this.store.get(job.id);
      if (current?.status !== 'running' || current.leaseToken !== token) {
        clearInterval(heartbeat);
        ac.abort();
        return;
      }
      this.store.heartbeat(job.id, (this.opts.now ?? Date.now)() + leaseMs, token);
    }, Math.max(1, Math.floor(leaseMs / 3)));
    heartbeat.unref?.();
    this.active.set(job.id, { controller: ac, token, heartbeat });
    try {
      await handler(job, ac.signal);
      const current = this.store.get(job.id);
      if (current?.status === 'running' && current.leaseToken === token) {
        this.store.complete(job.id, (this.opts.now ?? Date.now)(), token);
        this.emit('succeeded', this.store.get(job.id));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const current = this.store.get(job.id);
      if (current?.status !== 'running' || current.leaseToken !== token) {
        // Cancellation or another owner took over while the handler ran.
        return;
      }
      const attempts = current.attempts;
      if (attempts >= current.maxAttempts) {
        this.store.dead(job.id, msg, (this.opts.now ?? Date.now)(), token);
        this.emit('dead', this.store.get(job.id));
      } else {
        this.store.fail(job.id, msg, (this.opts.now ?? Date.now)() + this.backoff(attempts), (this.opts.now ?? Date.now)(), token);
        this.emit('failed', this.store.get(job.id));
      }
    } finally {
      clearInterval(heartbeat);
      if (this.active.get(job.id)?.token === token) this.active.delete(job.id);
    }
  }

  async tick(): Promise<number> {
    const now = (this.opts.now ?? Date.now)();
    for (const [id, active] of this.active) {
      if (!active.controller.signal.aborted) this.store.heartbeat(id, now + (this.opts.leaseMs ?? 30_000), active.token);
    }
    this.store.requeueExpired(now);
    const concurrency = { ...DEFAULT_CONCURRENCY, ...(this.opts.concurrency ?? {}) };
    let started = 0;
    for (const kind of Object.keys(concurrency) as JobKind[]) {
      const limit = concurrency[kind];
      const used = this.byKind[kind] ?? 0;
      const can = Math.max(0, Math.floor(limit) - used);
      if (can === 0) continue;
      const jobs = this.store.claimDue(can, (this.opts.now ?? Date.now)(), kind, this.opts.leaseMs ?? 30_000);
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
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('intervalMs must be positive');
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const active of this.active.values()) {
      clearInterval(active.heartbeat);
      active.controller.abort();
    }
  }

  cancel(id: string): void {
    this.store.cancel(id, (this.opts.now ?? Date.now)());
    const active = this.active.get(id);
    if (active) {
      clearInterval(active.heartbeat);
      active.controller.abort();
    }
    if (this.store.get(id)?.status === 'cancelled') this.emit('cancelled', id);
  }

  replay(id: string): JobRow | null {
    const job = this.store.get(id);
    if (!job) return null;
    this.store.replay(id, (this.opts.now ?? Date.now)());
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
