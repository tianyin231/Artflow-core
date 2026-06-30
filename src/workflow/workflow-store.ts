import { Database } from '../storage/Database';
import { getConfigPath, loadConfig } from '../config';
import { CommandPresetRecord } from '../storage/repositories/WorkflowRepository';

const defaultPresets: CommandPresetRecord[] = [
  {
    id: 'weekly-wuthering-waves',
    name: '鸣潮周榜卡点',
    command: '本周鸣潮主题 收藏数5000+ 做成卡点视频 BGM电子风',
    category: '视频生成',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  },
  {
    id: 'blue-archive-square',
    name: 'ブルアカ方形混剪',
    command: 'ブルアカ 高收藏 插画 方形视频 舒缓转场 适合B站动态',
    category: '视频生成',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  },
  {
    id: 'miku-soft-gallery',
    name: '初音未来柔和图集',
    command: '初音ミク 插画 精选10张 舒缓风格 竖屏视频',
    category: '素材收集',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  },
];

export function withWorkflowDatabase<T>(callback: (database: Database) => T): T {
  const config = loadConfig(getConfigPath());
  const databasePath = config.storage?.databasePath;
  if (!databasePath) {
    throw new Error('storage.databasePath is required for workflow persistence');
  }

  const database = new Database(databasePath);
  try {
    database.migrate();
    seedDefaultPresets(database);
    return callback(database);
  } finally {
    database.close();
  }
}

function seedDefaultPresets(database: Database): void {
  if (database.listCommandPresets().length > 0) return;
  database.replaceCommandPresets(defaultPresets);
}

export { defaultPresets };
