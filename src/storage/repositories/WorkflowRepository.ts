import { BaseRepository } from './BaseRepository';
import { WorkflowTask } from '../../workflow/types';

export interface CommandPresetRecord {
  id: string;
  name: string;
  command: string;
  category: string;
  payload?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface AiSettingsRecord {
  provider: 'local-rules' | 'openai' | 'anthropic' | 'ollama';
  model: string;
  baseUrl: string;
  apiKey: string;
  planningMode: 'rules-first' | 'ai-first';
}

export interface WorkflowScheduleRecord {
  id: string;
  name: string;
  enabled: boolean;
  cron: string;
  timezone?: string;
  command: string;
  payload?: unknown;
  lastTaskId?: string;
  lastRunAt?: string;
  lastStatus?: 'success' | 'failed' | 'running';
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export type PublishJobStatus = 'draft' | 'ready' | 'submitted' | 'failed' | 'cancelled';

export interface PublishJobRecord {
  id: string;
  taskId: string;
  status: PublishJobStatus;
  platform: 'bilibili';
  title: string;
  payload: unknown;
  result?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BilibiliPublishSettingsRecord {
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  updatedAt?: string;
}

export class WorkflowRepository extends BaseRepository {
  public upsertTask(task: WorkflowTask): void {
    const stmt = this.db.prepare(
      `INSERT INTO workflow_tasks (task_id, status, command, task_json, created_at, updated_at)
       VALUES (@taskId, @status, @command, @taskJson, @createdAt, @updatedAt)
       ON CONFLICT(task_id) DO UPDATE SET
         status = @status,
         command = @command,
         task_json = @taskJson,
         updated_at = @updatedAt`
    );
    stmt.run({
      taskId: task.id,
      status: task.status,
      command: task.command,
      taskJson: JSON.stringify(task),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    });
  }

  public listTasks(limit = 200): WorkflowTask[] {
    const stmt = this.db.prepare(
      `SELECT task_json FROM workflow_tasks
       ORDER BY datetime(created_at) DESC
       LIMIT ?`
    );
    return (stmt.all(limit) as Array<{ task_json: string }>)
      .map((row) => JSON.parse(row.task_json) as WorkflowTask);
  }

  public getTask(taskId: string): WorkflowTask | null {
    const stmt = this.db.prepare(`SELECT task_json FROM workflow_tasks WHERE task_id = ?`);
    const row = stmt.get(taskId) as { task_json: string } | undefined;
    return row ? (JSON.parse(row.task_json) as WorkflowTask) : null;
  }

  public deleteTask(taskId: string): boolean {
    const result = this.db.prepare(`DELETE FROM workflow_tasks WHERE task_id = ?`).run(taskId);
    return result.changes > 0;
  }

  public listPresets(): CommandPresetRecord[] {
    const stmt = this.db.prepare(
      `SELECT id, name, command, category, payload_json, created_at, updated_at
       FROM command_presets
       ORDER BY datetime(updated_at) DESC`
    );
    return (stmt.all() as Array<{
      id: string;
      name: string;
      command: string;
      category: string;
      payload_json?: string | null;
      created_at: string;
      updated_at: string;
    }>).map((row) => ({
      id: row.id,
      name: row.name,
      command: row.command,
      category: row.category,
      payload: row.payload_json ? JSON.parse(row.payload_json) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  public upsertPreset(preset: CommandPresetRecord): CommandPresetRecord {
    const stmt = this.db.prepare(
      `INSERT INTO command_presets (id, name, command, category, payload_json, created_at, updated_at)
       VALUES (@id, @name, @command, @category, @payloadJson, @createdAt, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET
         name = @name,
         command = @command,
         category = @category,
         payload_json = @payloadJson,
         updated_at = @updatedAt`
    );
    stmt.run({
      ...preset,
      payloadJson: preset.payload ? JSON.stringify(preset.payload) : null,
    });
    return preset;
  }

  public deletePreset(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM command_presets WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  public replacePresets(presets: CommandPresetRecord[]): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM command_presets`).run();
      for (const preset of presets) {
        this.upsertPreset(preset);
      }
    });
    transaction();
  }

  public getAiSettings(): AiSettingsRecord | null {
    const row = this.db
      .prepare(`SELECT settings_json FROM ai_settings WHERE id = 'default'`)
      .get() as { settings_json: string } | undefined;
    return row ? (JSON.parse(row.settings_json) as AiSettingsRecord) : null;
  }

  public saveAiSettings(settings: AiSettingsRecord): AiSettingsRecord {
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO ai_settings (id, settings_json, updated_at)
         VALUES ('default', ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           settings_json = excluded.settings_json,
           updated_at = excluded.updated_at`
      )
      .run(JSON.stringify(settings), updatedAt);
    return settings;
  }

  public listSchedules(): WorkflowScheduleRecord[] {
    const stmt = this.db.prepare(
      `SELECT id, name, enabled, cron, timezone, command, payload_json, last_task_id,
              last_run_at, last_status, last_error, created_at, updated_at
       FROM workflow_schedules
       ORDER BY datetime(updated_at) DESC`
    );
    return (stmt.all() as Array<{
      id: string;
      name: string;
      enabled: number;
      cron: string;
      timezone?: string | null;
      command: string;
      payload_json?: string | null;
      last_task_id?: string | null;
      last_run_at?: string | null;
      last_status?: 'success' | 'failed' | 'running' | null;
      last_error?: string | null;
      created_at: string;
      updated_at: string;
    }>).map((row) => ({
      id: row.id,
      name: row.name,
      enabled: row.enabled === 1,
      cron: row.cron,
      timezone: row.timezone || undefined,
      command: row.command,
      payload: row.payload_json ? JSON.parse(row.payload_json) : undefined,
      lastTaskId: row.last_task_id || undefined,
      lastRunAt: row.last_run_at || undefined,
      lastStatus: row.last_status || undefined,
      lastError: row.last_error || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  public getSchedule(id: string): WorkflowScheduleRecord | null {
    return this.listSchedules().find((schedule) => schedule.id === id) ?? null;
  }

  public upsertSchedule(schedule: WorkflowScheduleRecord): WorkflowScheduleRecord {
    const stmt = this.db.prepare(
      `INSERT INTO workflow_schedules (
         id, name, enabled, cron, timezone, command, payload_json, last_task_id,
         last_run_at, last_status, last_error, created_at, updated_at
       )
       VALUES (
         @id, @name, @enabled, @cron, @timezone, @command, @payloadJson, @lastTaskId,
         @lastRunAt, @lastStatus, @lastError, @createdAt, @updatedAt
       )
       ON CONFLICT(id) DO UPDATE SET
         name = @name,
         enabled = @enabled,
         cron = @cron,
         timezone = @timezone,
         command = @command,
         payload_json = @payloadJson,
         last_task_id = @lastTaskId,
         last_run_at = @lastRunAt,
         last_status = @lastStatus,
         last_error = @lastError,
         updated_at = @updatedAt`
    );
    stmt.run({
      ...schedule,
      enabled: schedule.enabled ? 1 : 0,
      timezone: schedule.timezone || null,
      payloadJson: schedule.payload ? JSON.stringify(schedule.payload) : null,
      lastTaskId: schedule.lastTaskId || null,
      lastRunAt: schedule.lastRunAt || null,
      lastStatus: schedule.lastStatus || null,
      lastError: schedule.lastError || null,
    });
    return schedule;
  }

  public deleteSchedule(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM workflow_schedules WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  public updateScheduleRun(
    id: string,
    data: {
      lastTaskId?: string;
      lastRunAt?: string;
      lastStatus?: 'success' | 'failed' | 'running';
      lastError?: string;
    }
  ): void {
    this.db
      .prepare(
        `UPDATE workflow_schedules
         SET last_task_id = @lastTaskId,
             last_run_at = @lastRunAt,
             last_status = @lastStatus,
             last_error = @lastError,
             updated_at = @updatedAt
         WHERE id = @id`
      )
      .run({
        id,
        lastTaskId: data.lastTaskId || null,
        lastRunAt: data.lastRunAt || null,
        lastStatus: data.lastStatus || null,
        lastError: data.lastError || null,
        updatedAt: new Date().toISOString(),
      });
  }

  public listPublishJobs(limit = 200): PublishJobRecord[] {
    const stmt = this.db.prepare(
      `SELECT id, task_id, status, platform, title, payload_json, result_json, error, created_at, updated_at
       FROM publish_jobs
       ORDER BY datetime(created_at) DESC
       LIMIT ?`
    );
    return (stmt.all(limit) as Array<{
      id: string;
      task_id: string;
      status: PublishJobStatus;
      platform: 'bilibili';
      title: string;
      payload_json: string;
      result_json?: string | null;
      error?: string | null;
      created_at: string;
      updated_at: string;
    }>).map((row) => ({
      id: row.id,
      taskId: row.task_id,
      status: row.status,
      platform: row.platform,
      title: row.title,
      payload: JSON.parse(row.payload_json),
      result: row.result_json ? JSON.parse(row.result_json) : undefined,
      error: row.error || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  public getPublishJob(id: string): PublishJobRecord | null {
    const stmt = this.db.prepare(
      `SELECT id, task_id, status, platform, title, payload_json, result_json, error, created_at, updated_at
       FROM publish_jobs
       WHERE id = ?`
    );
    const row = stmt.get(id) as {
      id: string;
      task_id: string;
      status: PublishJobStatus;
      platform: 'bilibili';
      title: string;
      payload_json: string;
      result_json?: string | null;
      error?: string | null;
      created_at: string;
      updated_at: string;
    } | undefined;
    if (!row) return null;
    return {
      id: row.id,
      taskId: row.task_id,
      status: row.status,
      platform: row.platform,
      title: row.title,
      payload: JSON.parse(row.payload_json),
      result: row.result_json ? JSON.parse(row.result_json) : undefined,
      error: row.error || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  public upsertPublishJob(job: PublishJobRecord): PublishJobRecord {
    const stmt = this.db.prepare(
      `INSERT INTO publish_jobs (
         id, task_id, status, platform, title, payload_json, result_json, error, created_at, updated_at
       )
       VALUES (
         @id, @taskId, @status, @platform, @title, @payloadJson, @resultJson, @error, @createdAt, @updatedAt
       )
       ON CONFLICT(id) DO UPDATE SET
         status = @status,
         title = @title,
         payload_json = @payloadJson,
         result_json = @resultJson,
         error = @error,
         updated_at = @updatedAt`
    );
    stmt.run({
      ...job,
      payloadJson: JSON.stringify(job.payload),
      resultJson: job.result ? JSON.stringify(job.result) : null,
      error: job.error || null,
    });
    return job;
  }

  public updatePublishJob(
    id: string,
    update: {
      status: PublishJobStatus;
      result?: unknown;
      error?: string;
    }
  ): PublishJobRecord | null {
    const current = this.getPublishJob(id);
    if (!current) return null;
    return this.upsertPublishJob({
      ...current,
      status: update.status,
      result: update.result,
      error: update.error,
      updatedAt: new Date().toISOString(),
    });
  }

  public getBilibiliPublishSettings(): BilibiliPublishSettingsRecord | null {
    const row = this.db
      .prepare(`SELECT settings_json, updated_at FROM publish_settings WHERE platform = 'bilibili'`)
      .get() as { settings_json: string; updated_at: string } | undefined;
    if (!row) return null;
    return {
      ...(JSON.parse(row.settings_json) as BilibiliPublishSettingsRecord),
      updatedAt: row.updated_at,
    };
  }

  public saveBilibiliPublishSettings(settings: BilibiliPublishSettingsRecord): BilibiliPublishSettingsRecord {
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO publish_settings (platform, settings_json, updated_at)
         VALUES ('bilibili', ?, ?)
         ON CONFLICT(platform) DO UPDATE SET
           settings_json = excluded.settings_json,
           updated_at = excluded.updated_at`
      )
      .run(JSON.stringify(settings), updatedAt);
    return { ...settings, updatedAt };
  }
}
