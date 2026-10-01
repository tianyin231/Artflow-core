/**
 * Publisher registry + job state machine.
 */
import { PublishOptions, PublishPackage, PublishResult, Publisher } from './types';

export type PublishJobStatus =
  | 'queued'
  | 'validating'
  | 'uploading'
  | 'submitted'
  | 'published'
  | 'exported'
  | 'dry_run'
  | 'failed'
  | 'auth_required';

export interface PublishJob {
  id: string;
  taskId: string;
  publisherId: string;
  status: PublishJobStatus;
  attempts: number;
  lastResult?: PublishResult;
  updatedAt: string;
}

export class PublisherRegistry {
  private map = new Map<string, Publisher>();

  register(p: Publisher): void {
    this.map.set(p.id, p);
  }

  get(id: string): Publisher | undefined {
    return this.map.get(id);
  }

  list(): Publisher[] {
    return [...this.map.values()];
  }

  enabled(ids: string[]): Publisher[] {
    return ids.map((id) => this.map.get(id)).filter(Boolean) as Publisher[];
  }
}

export class PublishJobService {
  private jobs = new Map<string, PublishJob>();
  private key = (taskId: string, publisherId: string) => `${taskId}::${publisherId}`;

  constructor(private readonly registry: PublisherRegistry) {}

  get(taskId: string, publisherId: string): PublishJob | undefined {
    return this.jobs.get(this.key(taskId, publisherId));
  }

  listByTask(taskId: string): PublishJob[] {
    return [...this.jobs.values()].filter((j) => j.taskId === taskId);
  }

  cancel(taskId: string, publisherId: string): void {
    const job = this.get(taskId, publisherId);
    if (job && job.status !== 'published' && job.status !== 'exported') {
      job.status = 'failed';
      job.lastResult = { status: 'failed', message: 'cancelled' };
      job.updatedAt = new Date().toISOString();
    }
  }

  async run(pkg: PublishPackage, publisherId: string, opts: PublishOptions): Promise<PublishResult> {
    const key = this.key(pkg.taskId, publisherId);
    const existing = this.jobs.get(key);
    // idempotent: success already recorded
    if (existing && ['published', 'exported', 'submitted', 'dry_run'].includes(existing.status)) {
      return existing.lastResult ?? { status: 'exported' };
    }
    const publisher = this.registry.get(publisherId);
    if (!publisher) {
      const failed: PublishResult = { status: 'failed', message: `unknown publisher ${publisherId}` };
      this.jobs.set(key, {
        id: key,
        taskId: pkg.taskId,
        publisherId,
        status: 'failed',
        attempts: existing ? existing.attempts + 1 : 1,
        lastResult: failed,
        updatedAt: new Date().toISOString(),
      });
      return failed;
    }

    const job: PublishJob = {
      id: key,
      taskId: pkg.taskId,
      publisherId,
      status: 'validating',
      attempts: existing ? existing.attempts + 1 : 1,
      updatedAt: new Date().toISOString(),
    };
    this.jobs.set(key, job);

    const validation = publisher.validate(pkg);
    if (!validation.ok) {
      const failed: PublishResult = {
        status: 'failed',
        message: validation.issues.map((i) => `${i.field}: ${i.message}`).join('; '),
      };
      job.status = 'failed';
      job.lastResult = failed;
      job.updatedAt = new Date().toISOString();
      return failed;
    }

    job.status = 'uploading';
    job.updatedAt = new Date().toISOString();
    try {
      const result = await publisher.publish(pkg, opts);
      job.lastResult = result;
      job.status =
        result.status === 'published'
          ? 'published'
          : result.status === 'submitted'
            ? 'submitted'
            : result.status === 'exported'
              ? 'exported'
              : result.status === 'dry_run'
                ? 'dry_run'
                : result.status === 'auth_required'
                  ? 'auth_required'
                  : 'failed';
      job.updatedAt = new Date().toISOString();
      return result;
    } catch (e) {
      const failed: PublishResult = {
        status: 'failed',
        message: e instanceof Error ? e.message : String(e),
      };
      job.status = 'failed';
      job.lastResult = failed;
      job.updatedAt = new Date().toISOString();
      return failed;
    }
  }
}

/** Default platforms enabled without explicit config (PRD). */
export const DEFAULT_ENABLED_PUBLISHERS = ['local-export', 'wallpaper-engine-package'];
