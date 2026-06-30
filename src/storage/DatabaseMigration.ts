import DatabaseDriver from 'better-sqlite3';
import { DatabaseError } from '../utils/errors';
import { logger } from '../logger';

/**
 * Handles database migrations
 */
export class DatabaseMigration {
  constructor(private readonly db: DatabaseDriver.Database) {}

  /**
   * Run all database migrations
   */
  public migrate(): void {
    try {
      const migrations = [
        `CREATE TABLE IF NOT EXISTS tokens (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )`,
        `CREATE TABLE IF NOT EXISTS downloads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pixiv_id TEXT NOT NULL,
            type TEXT NOT NULL,
            tag TEXT NOT NULL,
            title TEXT NOT NULL,
            file_path TEXT NOT NULL,
            author TEXT,
            user_id TEXT,
            author_account TEXT,
            author_profile_image_urls TEXT,
            tags_json TEXT,
            caption TEXT,
            file_hash TEXT,
            downloaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(pixiv_id, type, file_path)
          )`,
        `CREATE TABLE IF NOT EXISTS execution_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tag TEXT NOT NULL,
            type TEXT NOT NULL,
            status TEXT NOT NULL,
            message TEXT,
            executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )`,
        `CREATE TABLE IF NOT EXISTS scheduler_executions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            execution_number INTEGER NOT NULL,
            status TEXT NOT NULL,
            start_time DATETIME NOT NULL,
            end_time DATETIME,
            duration_ms INTEGER,
            error_message TEXT,
            items_downloaded INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )`,
        `CREATE TABLE IF NOT EXISTS config_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            description TEXT,
            config_json TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )`,
        `CREATE TABLE IF NOT EXISTS task_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL,
            start_time DATETIME NOT NULL,
            end_time DATETIME,
            error TEXT,
            target_id TEXT,
            progress_current INTEGER,
            progress_total INTEGER,
            progress_message TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )`,
        `CREATE TABLE IF NOT EXISTS workflow_tasks (
            task_id TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            command TEXT NOT NULL,
            task_json TEXT NOT NULL,
            created_at DATETIME NOT NULL,
            updated_at DATETIME NOT NULL
          )`,
        `CREATE TABLE IF NOT EXISTS command_presets (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            command TEXT NOT NULL,
            category TEXT NOT NULL,
            payload_json TEXT,
            created_at DATETIME NOT NULL,
            updated_at DATETIME NOT NULL
          )`,
        `CREATE TABLE IF NOT EXISTS ai_settings (
            id TEXT PRIMARY KEY,
            settings_json TEXT NOT NULL,
            updated_at DATETIME NOT NULL
          )`,
      ];

      // Create indexes for better query performance
      const indexes = [
        `CREATE INDEX IF NOT EXISTS idx_downloads_pixiv_id_type ON downloads(pixiv_id, type)`,
        `CREATE INDEX IF NOT EXISTS idx_downloads_tag ON downloads(tag)`,
        `CREATE INDEX IF NOT EXISTS idx_downloads_downloaded_at ON downloads(downloaded_at)`,
        `CREATE INDEX IF NOT EXISTS idx_execution_log_tag_type ON execution_log(tag, type)`,
        `CREATE INDEX IF NOT EXISTS idx_scheduler_executions_number ON scheduler_executions(execution_number)`,
        `CREATE INDEX IF NOT EXISTS idx_scheduler_executions_status ON scheduler_executions(status)`,
        `CREATE INDEX IF NOT EXISTS idx_config_history_created_at ON config_history(created_at)`,
        `CREATE INDEX IF NOT EXISTS idx_task_history_task_id ON task_history(task_id)`,
        `CREATE INDEX IF NOT EXISTS idx_task_history_status ON task_history(status)`,
        `CREATE INDEX IF NOT EXISTS idx_task_history_start_time ON task_history(start_time)`,
        `CREATE INDEX IF NOT EXISTS idx_workflow_tasks_status ON workflow_tasks(status)`,
        `CREATE INDEX IF NOT EXISTS idx_workflow_tasks_created_at ON workflow_tasks(created_at)`,
        `CREATE INDEX IF NOT EXISTS idx_command_presets_category ON command_presets(category)`,
        `CREATE INDEX IF NOT EXISTS idx_command_presets_updated_at ON command_presets(updated_at)`,
      ];

      const transaction = this.db.transaction((stmts: string[]) => {
        for (const sql of stmts) {
          this.db.prepare(sql).run();
        }
      });

      transaction([...migrations, ...indexes]);

      this.addMissingColumn('downloads', 'author_account', 'TEXT');
      this.addMissingColumn('downloads', 'author_profile_image_urls', 'TEXT');
      this.addMissingColumn('downloads', 'tags_json', 'TEXT');
      this.addMissingColumn('downloads', 'caption', 'TEXT');
      this.addMissingColumn('downloads', 'file_hash', 'TEXT');
      this.addMissingColumn('command_presets', 'payload_json', 'TEXT');
      this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_downloads_file_hash ON downloads(file_hash)`).run();

      // Add is_active column to config_history if it doesn't exist
      try {
        // Check if column exists by querying pragma_table_info
        const tableInfo = this.db.prepare(`PRAGMA table_info(config_history)`).all() as Array<{ name: string }>;
        const hasIsActiveColumn = tableInfo.some(col => col.name === 'is_active');
        
        if (!hasIsActiveColumn) {
          this.db.prepare(`ALTER TABLE config_history ADD COLUMN is_active INTEGER DEFAULT 0`).run();
          this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_config_history_is_active ON config_history(is_active)`).run();
        }
      } catch (error) {
        // Column might already exist, ignore error
        // In SQLite, if column exists, ALTER TABLE will fail, which is fine
        logger.warn('Failed to add is_active column (may already exist)', { error });
      }

      // Add task_history table if it doesn't exist (for backward compatibility)
      try {
        const tableInfo = this.db.prepare(`PRAGMA table_info(task_history)`).all() as Array<{ name: string }>;
        if (tableInfo.length === 0) {
          // Table doesn't exist, but it should have been created by migrations above
          // This is just a safety check
          logger.debug('task_history table will be created by migrations');
        }
      } catch (error) {
        logger.warn('Failed to check task_history table (may already exist)', { error });
      }
    } catch (error) {
      throw new DatabaseError(
        'Failed to run database migrations',
        error instanceof Error ? error : undefined
      );
    }
  }

  private addMissingColumn(table: string, column: string, definition: string): void {
    try {
      const tableInfo = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!tableInfo.some(col => col.name === column)) {
        this.db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
      }
    } catch (error) {
      logger.warn(`Failed to add ${table}.${column} column (may already exist)`, { error });
    }
  }
}



























































