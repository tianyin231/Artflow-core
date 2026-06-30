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
}
