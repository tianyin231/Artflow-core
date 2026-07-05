import cron, { ScheduledTask } from 'node-cron';
import { logger } from '../logger';
import { WorkflowScheduleRecord } from '../storage/repositories/WorkflowRepository';
import { CreateWorkflowTaskRequest, WorkflowTask } from './types';
import { workflowManager } from './WorkflowManager';
import { withWorkflowDatabase } from './workflow-store';

type SchedulePayload = Partial<Pick<
  CreateWorkflowTaskRequest,
  'dryRunDownload' | 'videoOverrides' | 'pixivOverrides' | 'publishOverrides'
>>;

const TERMINAL_STATUSES = new Set(['published', 'failed', 'rejected']);

export class WorkflowScheduler {
  private tasks = new Map<string, ScheduledTask>();
  private running = new Set<string>();
  private restored = false;

  public restore(): void {
    if (this.restored) return;
    this.restored = true;
    const schedules = this.listSchedules();
    for (const schedule of schedules) {
      if (schedule.enabled) {
        this.startSchedule(schedule);
      }
    }
  }

  public listSchedules(): WorkflowScheduleRecord[] {
    return withWorkflowDatabase((database) => database.listWorkflowSchedules());
  }

  public upsertSchedule(input: {
    id?: string;
    name: string;
    enabled?: boolean;
    cron: string;
    timezone?: string;
    command: string;
    payload?: SchedulePayload;
  }): WorkflowScheduleRecord {
    if (!cron.validate(input.cron)) {
      throw new Error(`Invalid cron expression: ${input.cron}`);
    }
    const now = new Date().toISOString();
    const existing = input.id
      ? withWorkflowDatabase((database) => database.getWorkflowSchedule(input.id!))
      : null;
    const schedule: WorkflowScheduleRecord = {
      id: input.id || `wfs_${Date.now()}`,
      name: input.name.trim(),
      enabled: input.enabled ?? existing?.enabled ?? true,
      cron: input.cron.trim(),
      timezone: input.timezone?.trim() || undefined,
      command: input.command.trim(),
      payload: input.payload,
      lastTaskId: existing?.lastTaskId,
      lastRunAt: existing?.lastRunAt,
      lastStatus: existing?.lastStatus,
      lastError: existing?.lastError,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    if (!schedule.name || !schedule.command) {
      throw new Error('Schedule name and command are required');
    }
    const saved = withWorkflowDatabase((database) => database.upsertWorkflowSchedule(schedule));
    this.stopSchedule(saved.id);
    if (saved.enabled) {
      this.startSchedule(saved);
    }
    return saved;
  }

  public setEnabled(id: string, enabled: boolean): WorkflowScheduleRecord {
    const schedule = withWorkflowDatabase((database) => database.getWorkflowSchedule(id));
    if (!schedule) {
      throw new Error(`Workflow schedule ${id} not found`);
    }
    const saved = this.upsertSchedule({
      id: schedule.id,
      name: schedule.name,
      enabled,
      cron: schedule.cron,
      timezone: schedule.timezone,
      command: schedule.command,
      payload: schedule.payload as SchedulePayload | undefined,
    });
    return saved;
  }

  public deleteSchedule(id: string): boolean {
    this.stopSchedule(id);
    return withWorkflowDatabase((database) => database.deleteWorkflowSchedule(id));
  }

  public async triggerNow(id: string): Promise<WorkflowTask> {
    const schedule = withWorkflowDatabase((database) => database.getWorkflowSchedule(id));
    if (!schedule) {
      throw new Error(`Workflow schedule ${id} not found`);
    }
    return this.runSchedule(schedule);
  }

  private startSchedule(schedule: WorkflowScheduleRecord): void {
    if (this.tasks.has(schedule.id)) return;
    const task = cron.schedule(
      schedule.cron,
      () => {
        this.runSchedule(schedule).catch((error) => {
          logger.error('Workflow schedule run failed', {
            scheduleId: schedule.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      },
      { timezone: schedule.timezone }
    );
    this.tasks.set(schedule.id, task);
    logger.info('Workflow schedule started', {
      scheduleId: schedule.id,
      cron: schedule.cron,
      timezone: schedule.timezone,
    });
  }

  private stopSchedule(id: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.stop();
    this.tasks.delete(id);
  }

  private async runSchedule(schedule: WorkflowScheduleRecord): Promise<WorkflowTask> {
    if (this.running.has(schedule.id)) {
      throw new Error(`Workflow schedule ${schedule.id} is already running`);
    }
    this.running.add(schedule.id);
    const startedAt = new Date().toISOString();
    try {
      const payload = (schedule.payload || {}) as SchedulePayload;
      const task = workflowManager.createTask({
        command: schedule.command,
        dryRunDownload: payload.dryRunDownload,
        pixivOverrides: payload.pixivOverrides,
        videoOverrides: payload.videoOverrides,
        publishOverrides: {
          ...payload.publishOverrides,
          // 定时任务只允许生成发布包，不执行真实发布。
          syncArticle: payload.publishOverrides?.syncArticle ?? true,
        },
        prefilterMode: 'keep_all',
      });
      withWorkflowDatabase((database) =>
        database.updateWorkflowScheduleRun(schedule.id, {
          lastTaskId: task.id,
          lastRunAt: startedAt,
          lastStatus: 'running',
        })
      );
      const completed = await this.autoCompleteTask(task.id);
      withWorkflowDatabase((database) =>
        database.updateWorkflowScheduleRun(schedule.id, {
          lastTaskId: completed.id,
          lastRunAt: startedAt,
          lastStatus: completed.status === 'published' ? 'success' : 'failed',
          lastError: completed.status === 'published' ? undefined : completed.logs.at(-1)?.message,
        })
      );
      return completed;
    } catch (error) {
      withWorkflowDatabase((database) =>
        database.updateWorkflowScheduleRun(schedule.id, {
          lastRunAt: startedAt,
          lastStatus: 'failed',
          lastError: error instanceof Error ? error.message : String(error),
        })
      );
      throw error;
    } finally {
      this.running.delete(schedule.id);
    }
  }

  private async autoCompleteTask(taskId: string): Promise<WorkflowTask> {
    const deadline = Date.now() + 90 * 60 * 1000;
    while (Date.now() < deadline) {
      const task = workflowManager.getTask(taskId);
      if (!task) {
        throw new Error(`Workflow task ${taskId} not found`);
      }
      if (TERMINAL_STATUSES.has(task.status)) {
        return task;
      }
      if (task.status === 'asset_review_required') {
        workflowManager.continueAfterAssetReview(task.id, 'keep_all');
      } else if (task.status === 'cover_review_required') {
        workflowManager.continueAfterCoverReview(task.id);
      } else if (task.status === 'review_required') {
        workflowManager.approveTask(task.id, '定时任务自动审核通过，仅生成 B站发布包');
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(`Workflow task ${taskId} timed out`);
  }
}

export const workflowScheduler = new WorkflowScheduler();
