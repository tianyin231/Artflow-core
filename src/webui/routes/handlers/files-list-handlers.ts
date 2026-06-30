import { Request, Response } from 'express';
import { readdirSync, statSync, existsSync } from 'fs';
import { join, extname, resolve, relative, basename } from 'path';
import { loadConfig, getConfigPath } from '../../../config';
import { logger } from '../../../logger';
import { Database } from '../../../storage/Database';
import { ErrorCode } from '../../utils/error-codes';

const WORKFLOW_ROOT = resolve(process.cwd(), 'workflow_runs');
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv']);

function resolveClassicBaseDir(config: ReturnType<typeof loadConfig>, type: string): string | undefined {
  if (type === 'novel') {
    return config.storage?.novelDirectory || (config.storage?.downloadDirectory ? join(config.storage.downloadDirectory, 'novels') : undefined);
  }
  return config.storage?.illustrationDirectory || (config.storage?.downloadDirectory ? join(config.storage.downloadDirectory, 'illustrations') : undefined);
}

function workflowCategoryMatches(name: string, category: string): boolean {
  const ext = extname(name).toLowerCase();
  if (category === 'assets') return IMAGE_EXTENSIONS.has(ext) && !/-cover(?:-\d+)?\.jpe?g$/i.test(name);
  if (category === 'covers') return /-cover(?:-\d+)?\.jpe?g$/i.test(name);
  if (category === 'videos') return VIDEO_EXTENSIONS.has(ext);
  if (category === 'configs') return name.endsWith('.json') || name.endsWith('.db');
  return true;
}

function isWithin(baseDir: string, candidate: string): boolean {
  const resolvedBase = resolve(baseDir);
  const resolvedCandidate = resolve(candidate);
  return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}/`);
}

function classifyWorkflowFile(name: string): string {
  const ext = extname(name).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return /-cover(?:-\d+)?\.jpe?g$/i.test(name) ? 'cover' : 'asset';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  return 'config';
}

function collectWorkflowFiles(baseDir: string, category: string): any[] {
  const files: any[] = [];
  const stack = [baseDir];

  while (stack.length > 0) {
    const currentDir = stack.pop()!;
    if (!existsSync(currentDir)) continue;

    for (const item of readdirSync(currentDir)) {
      const itemPath = join(currentDir, item);
      const stats = statSync(itemPath);
      if (stats.isDirectory()) {
        stack.push(itemPath);
        continue;
      }
      if (!workflowCategoryMatches(item, category)) {
        continue;
      }

      const relativePath = relative(baseDir, itemPath);
      files.push({
        name: item,
        path: relativePath,
        type: 'file',
        size: stats.size,
        modified: stats.mtime.toISOString(),
        downloadedAt: stats.mtime.toISOString(),
        extension: extname(item),
        category: classifyWorkflowFile(item),
        source: 'workflow',
        displayPath: resolve(itemPath),
      });
    }
  }

  return files;
}

function getDirectoryStats(dirPath: string): { fileCount: number; imageCount: number; totalSize: number } {
  let fileCount = 0;
  let imageCount = 0;
  let totalSize = 0;
  const stack = [dirPath];

  while (stack.length > 0) {
    const currentDir = stack.pop()!;
    for (const item of readdirSync(currentDir)) {
      const itemPath = join(currentDir, item);
      const stats = statSync(itemPath);
      if (stats.isDirectory()) {
        stack.push(itemPath);
        continue;
      }

      fileCount += 1;
      totalSize += stats.size;
      if (IMAGE_EXTENSIONS.has(extname(item).toLowerCase())) {
        imageCount += 1;
      }
    }
  }

  return { fileCount, imageCount, totalSize };
}

/**
 * GET /api/files/recent
 * Get recently downloaded files from database
 * Query parameters:
 *   - limit: number of records to return (default: 50)
 *   - type: 'illustration' | 'novel' (optional)
 *   - filter: 'today' | 'yesterday' | 'last7days' | 'last30days' (optional)
 */
export async function getRecentFiles(req: Request, res: Response): Promise<void> {
  let database: Database | null = null;
  try {
    const { limit = '50', type, filter } = req.query;
    const configPath = getConfigPath();
    const config = loadConfig(configPath);

    if (!config.storage?.databasePath) {
      res.status(400).json({ 
        errorCode: ErrorCode.CONFIG_INVALID,
        error: 'Database path not configured' 
      });
      return;
    }

    database = new Database(config.storage.databasePath);
    database.migrate();

    let downloads: Array<{
      pixivId: string;
      type: 'illustration' | 'novel';
      tag: string;
      title: string;
      filePath: string;
      author: string | null;
      userId: string | null;
      downloadedAt: string;
    }>;

    // Handle date filters
    if (filter) {
      const now = new Date();
      let startDate: string;
      let endDate: string | undefined;

      switch (filter) {
        case 'today':
          startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
          endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).toISOString();
          break;
        case 'yesterday':
          const yesterday = new Date(now);
          yesterday.setDate(yesterday.getDate() - 1);
          startDate = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate()).toISOString();
          endDate = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 23, 59, 59, 999).toISOString();
          break;
        case 'last7days':
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
          break;
        case 'last30days':
          startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
          break;
        default:
          res.status(400).json({ 
            errorCode: ErrorCode.FILE_PATH_INVALID,
            error: `Invalid filter: ${filter}. Valid values: today, yesterday, last7days, last30days` 
          });
          return;
      }

      downloads = database.getDownloadsByDateRange(
        startDate,
        endDate,
        type as 'illustration' | 'novel' | undefined
      );

      // Apply limit after date filtering
      if (downloads.length > Number(limit)) {
        downloads = downloads.slice(0, Number(limit));
      }
    } else {
      downloads = database.getRecentDownloads(
        Number(limit),
        type as 'illustration' | 'novel' | undefined
      );
    }

    // Check if files still exist and get file info
    const result = downloads.map(download => {
      const filePath = download.filePath;
      const exists = existsSync(filePath);
      
      let fileInfo: any = {
        pixivId: download.pixivId,
        type: download.type,
        tag: download.tag,
        title: download.title,
        filePath: download.filePath,
        author: download.author,
        userId: download.userId,
        downloadedAt: download.downloadedAt,
        exists,
      };

      if (exists) {
        try {
          const stats = statSync(filePath);
          fileInfo.size = stats.size;
          fileInfo.modified = stats.mtime.toISOString();
          fileInfo.name = basename(filePath);
          fileInfo.extension = extname(filePath);
          
          // Calculate relative path from base directory
          const baseDir = resolveClassicBaseDir(config, download.type) || config.storage!.downloadDirectory!;
          
          try {
            fileInfo.relativePath = relative(baseDir, filePath);
          } catch {
            fileInfo.relativePath = filePath;
          }
        } catch (error) {
          logger.warn(`Failed to get file stats for ${filePath}`, { error });
        }
      }

      return fileInfo;
    });

    res.json({ 
      files: result,
      total: result.length,
      filter: filter || null,
      type: type || null,
    });
  } catch (error) {
    logger.error('Failed to get recent downloads', { error });
    res.status(500).json({ 
      errorCode: ErrorCode.FILE_READ_FAILED,
      error: error instanceof Error ? error.message : 'Failed to get recent downloads' 
    });
  } finally {
    if (database) {
      // Database connection is managed internally, no need to close
    }
  }
}

/**
 * GET /api/files/list
 * List files in download directory
 */
export async function listFiles(req: Request, res: Response): Promise<void> {
  let database: Database | null = null;
  try {
    const { path: dirPath = '', type = 'illustration', source = 'classic', category = 'all', sort = 'name', order = 'asc' } = req.query;
    const configPath = getConfigPath();
    const config = loadConfig(configPath);

    // Ensure storage configuration exists
    if (!config.storage) {
      logger.error('Storage configuration is missing', { configPath });
      res.status(500).json({ 
        errorCode: ErrorCode.FILE_READ_FAILED,
        error: 'Storage configuration is missing' 
      });
      return;
    }

    const isWorkflowSource = source === 'workflow' || type === 'workflow';
    let baseDir = isWorkflowSource
      ? WORKFLOW_ROOT
      : resolveClassicBaseDir(config, String(type));

    if (!baseDir) {
      logger.error('Base directory is not configured', { type, source, storage: config.storage });
      res.status(500).json({ 
        errorCode: ErrorCode.FILE_READ_FAILED,
        error: `Base directory for ${String(type)} is not configured` 
      });
      return;
    }

    baseDir = resolve(baseDir);
    const fullPath = dirPath ? resolve(baseDir, String(dirPath)) : baseDir;

    logger.info('Listing files', { 
      type,
      source,
      category,
      baseDir, 
      dirPath, 
      fullPath, 
      exists: existsSync(fullPath),
      itemsCount: existsSync(fullPath) ? readdirSync(fullPath).length : 0
    });

    // Security: Ensure path is within base directory
    if (!isWithin(baseDir, fullPath)) {
      logger.warn('Path traversal attempt detected', { baseDir, fullPath });
      res.status(400).json({ errorCode: ErrorCode.FILE_PATH_INVALID });
      return;
    }

    if (!existsSync(fullPath)) {
      logger.warn('Directory does not exist', { fullPath, baseDir, type });
      res.json({ files: [], directories: [] });
      return;
    }

    if (isWorkflowSource && String(category) !== 'all') {
      const files = collectWorkflowFiles(baseDir, String(category));
      const sortOrder = String(order).toLowerCase() === 'desc' ? -1 : 1;
      const sortBy = String(sort);
      files.sort((a, b) => {
        if (sortBy === 'time' || sortBy === 'downloadedAt') {
          return (new Date(a.modified).getTime() - new Date(b.modified).getTime()) * sortOrder;
        }
        if (sortBy === 'size') {
          return ((a.size ?? 0) - (b.size ?? 0)) * sortOrder;
        }
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) * sortOrder;
      });
      res.json({
        data: {
          files,
          directories: [],
          currentPath: '/',
          source: 'workflow',
          category: String(category),
          basePath: baseDir,
        },
      });
      return;
    }

    const items = readdirSync(fullPath);
    const files: any[] = [];
    const directories: any[] = [];

    for (const item of items) {
      const itemPath = join(fullPath, item);
      const stats = statSync(itemPath);

      if (stats.isDirectory()) {
        const directoryStats = isWorkflowSource && String(category) === 'all'
          ? getDirectoryStats(itemPath)
          : undefined;
        directories.push({
          name: item,
          path: dirPath ? `${dirPath}/${item}` : item,
          type: 'directory',
          modified: stats.mtime.toISOString(),
          category: isWorkflowSource ? 'task' : String(type),
          source: isWorkflowSource ? 'workflow' : 'classic',
          recursiveFileCount: directoryStats?.fileCount,
          recursiveImageCount: directoryStats?.imageCount,
          recursiveSize: directoryStats?.totalSize,
        });
      } else {
        if (isWorkflowSource && !workflowCategoryMatches(item, String(category))) {
          continue;
        }
        const relativePath = dirPath ? `${dirPath}/${item}` : item;
        const absolutePath = resolve(itemPath);
        files.push({
          name: item,
          path: relativePath,
          type: 'file',
          size: stats.size,
          modified: stats.mtime.toISOString(),
          extension: extname(item),
          category: isWorkflowSource
            ? IMAGE_EXTENSIONS.has(extname(item).toLowerCase())
              ? (/-cover-\d+\.jpe?g$/i.test(item) ? 'cover' : 'asset')
              : VIDEO_EXTENSIONS.has(extname(item).toLowerCase())
                ? 'video'
                : 'config'
            : String(type),
          source: isWorkflowSource ? 'workflow' : 'classic',
          displayPath: absolutePath,
          absolutePath, // Store for database lookup
        });
      }
    }

    // Query database for download times
    let downloadTimesMap = new Map<string, string>();
    if (!isWorkflowSource && files.length > 0 && config.storage!.databasePath) {
      try {
        database = new Database(config.storage!.databasePath!);
        database.migrate();
        
        // Collect all possible path variations for database query
        // Database may store absolute paths, so we need to query with absolute paths
        const absolutePathsForQuery = files.map(f => f.absolutePath);
        downloadTimesMap = database.getDownloadTimesForPaths(
          absolutePathsForQuery,
          type as 'illustration' | 'novel'
        );
        
        // Also try relative paths (relative to baseDir) in case database stores relative paths
        // Convert absolute paths to relative paths from baseDir
        const relativePathsFromBase = files.map(f => {
          // Try to get relative path from baseDir
          try {
            return relative(baseDir, f.absolutePath);
          } catch {
            return f.path; // Fallback to the relative path we already have
          }
        });
        
        // Query with relative paths too
        const relativeDownloadTimes = database.getDownloadTimesForPaths(
          relativePathsFromBase,
          type as 'illustration' | 'novel'
        );
        
        // Merge results (absolute path matches take precedence)
        for (const [path, time] of relativeDownloadTimes.entries()) {
          if (!downloadTimesMap.has(path)) {
            downloadTimesMap.set(path, time);
          }
        }
      } catch (dbError) {
        logger.warn('Failed to query download times from database', { error: dbError });
        // Continue without download times if database query fails
      }
    }

    // Add download time to files
    for (const file of files) {
      // Try to find download time by absolute path first (most likely match)
      let downloadTime = downloadTimesMap.get(file.absolutePath);
      
      // If not found, try relative path from baseDir
      if (!downloadTime) {
        try {
          const relativeFromBase = relative(baseDir, file.absolutePath);
          downloadTime = downloadTimesMap.get(relativeFromBase);
        } catch {
          // Ignore if relative() fails
        }
      }
      
      // If still not found, try the relative path we're using in the API
      if (!downloadTime) {
        downloadTime = downloadTimesMap.get(file.path);
      }
      
      file.downloadedAt = downloadTime || null;
      // Remove absolutePath from response
      delete file.absolutePath;
    }

    // Sort directories and files based on sort parameter
    const sortBy = String(sort);
    const sortOrder = String(order).toLowerCase() === 'desc' ? -1 : 1;

    if (sortBy === 'time') {
      // Sort by modified time
      directories.sort((a, b) => {
        const timeA = new Date(a.modified).getTime();
        const timeB = new Date(b.modified).getTime();
        return (timeA - timeB) * sortOrder;
      });
      files.sort((a, b) => {
        // Prefer downloadedAt if available, fallback to modified
        const timeA = a.downloadedAt 
          ? new Date(a.downloadedAt).getTime() 
          : new Date(a.modified).getTime();
        const timeB = b.downloadedAt 
          ? new Date(b.downloadedAt).getTime() 
          : new Date(b.modified).getTime();
        return (timeA - timeB) * sortOrder;
      });
    } else if (sortBy === 'downloadTime' || sortBy === 'downloadedAt') {
      // Sort by download time (downloadedAt)
      directories.sort((a, b) => {
        const timeA = new Date(a.modified).getTime();
        const timeB = new Date(b.modified).getTime();
        return (timeA - timeB) * sortOrder;
      });
      files.sort((a, b) => {
        // Sort by downloadedAt, files without download time go to the end
        if (!a.downloadedAt && !b.downloadedAt) {
          return 0;
        }
        if (!a.downloadedAt) return 1 * sortOrder;
        if (!b.downloadedAt) return -1 * sortOrder;
        const timeA = new Date(a.downloadedAt).getTime();
        const timeB = new Date(b.downloadedAt).getTime();
        return (timeA - timeB) * sortOrder;
      });
    } else {
      // Sort by name (case-insensitive, default)
      directories.sort((a, b) => {
        const comparison = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        return comparison * sortOrder;
      });
      files.sort((a, b) => {
        const comparison = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        return comparison * sortOrder;
      });
    }

    // Close database connection
    if (database) {
      try {
        database.close();
      } catch (closeError) {
        // Ignore close errors
      }
      database = null;
    }

    res.json({
      data: {
        files,
        directories,
        currentPath: dirPath || '/',
        source: isWorkflowSource ? 'workflow' : 'classic',
        category: String(category),
        basePath: baseDir,
      },
    });
  } catch (error) {
    // Close database connection on error
    if (database) {
      try {
        database.close();
      } catch (closeError) {
        // Ignore close errors
      }
    }
    logger.error('Failed to list files', { error });
    res.status(500).json({ errorCode: ErrorCode.FILE_LIST_FAILED });
  }
}
