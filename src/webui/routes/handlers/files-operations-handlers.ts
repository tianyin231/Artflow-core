import { Request, Response } from 'express';
import { statSync, existsSync, unlinkSync, readFileSync, rmSync } from 'fs';
import { join, extname, basename, resolve, relative } from 'path';
import { loadConfig, getConfigPath } from '../../../config';
import { logger } from '../../../logger';
import { Database } from '../../../storage/Database';
import { FileService } from '../../../download/FileService';
import { FileNormalizationService } from '../../../download/FileNormalizationService';
import { ErrorCode } from '../../utils/error-codes';

const WORKFLOW_ROOT = resolve(process.cwd(), 'workflow_runs');

function resolveClassicBaseDir(config: ReturnType<typeof loadConfig>, type: string): string | undefined {
  if (type === 'novel') {
    return config.storage?.novelDirectory || (config.storage?.downloadDirectory ? join(config.storage.downloadDirectory, 'novels') : undefined);
  }
  return config.storage?.illustrationDirectory || (config.storage?.downloadDirectory ? join(config.storage.downloadDirectory, 'illustrations') : undefined);
}

function isWithin(baseDir: string, candidate: string): boolean {
  const resolvedBase = resolve(baseDir);
  const resolvedCandidate = resolve(candidate);
  return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}/`);
}

function pathVariants(baseDir: string, fullPath: string): string[] {
  return Array.from(new Set([
    resolve(fullPath),
    relative(resolve(baseDir), resolve(fullPath)),
  ].filter(Boolean)));
}

/**
 * GET /api/files/preview
 * Get file preview (for images and files)
 * Query params: path (file path), type (illustration|novel)
 */
export async function previewFile(req: Request, res: Response): Promise<void> {
  try {
    const { path: filePath, type = 'illustration', source = 'classic' } = req.query;
    
    if (!filePath) {
      res.status(400).json({ errorCode: ErrorCode.FILE_PATH_REQUIRED });
      return;
    }

    const configPath = getConfigPath();
    const config = loadConfig(configPath);

    const baseDir = source === 'workflow' || type === 'workflow'
      ? WORKFLOW_ROOT
      : resolveClassicBaseDir(config, String(type));

    if (!baseDir) {
      res.status(500).json({ errorCode: ErrorCode.FILE_READ_FAILED });
      return;
    }

    // Handle both absolute paths (from database) and relative paths
    let fullPath: string;
    const filePathStr = String(filePath);
    if (filePathStr.startsWith('/')) {
      // Absolute path - use directly, but ensure it's within base directory
      fullPath = filePathStr;
    } else {
      // Relative path - join with base directory
      fullPath = join(baseDir, filePathStr);
    }

    // Security: Ensure path is within base directory
    const resolvedBaseDir = resolve(baseDir);
    const resolvedFullPath = resolve(fullPath);
    
    logger.info('Preview request', { 
      filePath: String(filePath),
      baseDir,
      resolvedBaseDir,
      fullPath,
      resolvedFullPath
    });
    
    if (!isWithin(resolvedBaseDir, resolvedFullPath)) {
      logger.error('Invalid path - security check failed', { 
        baseDir: resolvedBaseDir, 
        fullPath: resolvedFullPath 
      });
      res.status(400).json({ errorCode: ErrorCode.FILE_PATH_INVALID });
      return;
    }

    if (!existsSync(resolvedFullPath)) {
      logger.error('File not found', { path: resolvedFullPath, baseDir: resolvedBaseDir });
      res.status(404).json({ errorCode: ErrorCode.FILE_NOT_FOUND });
      return;
    }

    const stats = statSync(resolvedFullPath);
    if (stats.isDirectory()) {
      res.status(400).json({ errorCode: ErrorCode.FILE_IS_DIRECTORY });
      return;
    }

    // Set appropriate headers
    const ext = extname(resolvedFullPath).toLowerCase();
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
    const textExtensions = ['.txt', '.md', '.text', '.json'];
    const videoMimeTypes: { [key: string]: string } = {
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.webm': 'video/webm',
      '.mkv': 'video/x-matroska',
    };
    const isImage = imageExtensions.includes(ext);
    const isText = textExtensions.includes(ext);
    const isVideo = ext in videoMimeTypes;

    if (isImage) {
      // Map extensions to correct MIME types
      const mimeTypes: { [key: string]: string } = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp',
      };
      res.setHeader('Content-Type', mimeTypes[ext] || 'image/jpeg');
    } else if (isText) {
      const fileName = basename(resolvedFullPath);
      // Encode filename for Content-Disposition header to avoid invalid characters
      const encodedFileName = encodeURIComponent(fileName);
      res.setHeader('Content-Type', ext === '.json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodedFileName}`);
    } else if (isVideo) {
      res.setHeader('Content-Type', videoMimeTypes[ext]);
      res.setHeader('Accept-Ranges', 'bytes');
    } else {
      const fileName = basename(resolvedFullPath);
      const encodedFileName = encodeURIComponent(fileName);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodedFileName}`);
    }

    // Send file content
    try {
      if (isText) {
        // For text files, read and send directly
        const fileContent = readFileSync(resolvedFullPath, 'utf-8');
        res.send(fileContent);
      } else if (isImage || isVideo) {
        // For browser-rendered media, let Express stream the file.
        res.sendFile(resolvedFullPath, (err) => {
          if (err) {
            logger.error('Failed to send media file', { error: err, path: resolvedFullPath });
            if (!res.headersSent) {
              res.status(500).json({ errorCode: ErrorCode.FILE_READ_FAILED });
            }
          }
        });
      } else {
        // For other files, try to read as text first, fallback to sendFile
        try {
          const fileContent = readFileSync(resolvedFullPath, 'utf-8');
          res.send(fileContent);
        } catch (readError) {
          res.sendFile(resolvedFullPath, (err) => {
            if (err) {
              logger.error('Failed to send file', { error: err, path: resolvedFullPath });
              if (!res.headersSent) {
                res.status(500).json({ errorCode: ErrorCode.FILE_READ_FAILED });
              }
            }
          });
        }
      }
    } catch (error) {
      logger.error('Failed to send file content', { 
        error, 
        path: resolvedFullPath,
        isText,
        isImage
      });
      if (!res.headersSent) {
        res.status(500).json({ errorCode: ErrorCode.FILE_PREVIEW_FAILED });
      }
    }
  } catch (error) {
    logger.error('Failed to get file preview', { error });
    if (!res.headersSent) {
      res.status(500).json({ errorCode: ErrorCode.FILE_PREVIEW_FAILED });
    }
  }
}

/**
 * DELETE /api/files/:id
 * Delete a file
 */
export async function deleteFile(req: Request, res: Response): Promise<void> {
  let database: Database | null = null;
  try {
    const { id } = req.params;
    const { path: filePath, type = 'illustration', source = 'classic' } = req.query;
    const configPath = getConfigPath();
    const config = loadConfig(configPath);

    const baseDir = source === 'workflow' || type === 'workflow'
      ? WORKFLOW_ROOT
      : resolveClassicBaseDir(config, String(type));

    if (!baseDir) {
      res.status(500).json({ errorCode: ErrorCode.FILE_READ_FAILED });
      return;
    }

    const resolvedBaseDir = resolve(baseDir);
    const fullPath = filePath ? resolve(resolvedBaseDir, String(filePath)) : resolve(resolvedBaseDir, id);

    // Security: Ensure path is within base directory
    if (!isWithin(resolvedBaseDir, fullPath)) {
      res.status(400).json({ errorCode: ErrorCode.FILE_PATH_INVALID });
      return;
    }

    if (!existsSync(fullPath)) {
      res.status(404).json({ errorCode: ErrorCode.FILE_NOT_FOUND });
      return;
    }

    const stats = statSync(fullPath);
    if (!stats.isDirectory() && extname(fullPath).toLowerCase() === '.db') {
      res.status(400).json({
        errorCode: ErrorCode.FILE_DELETE_FAILED,
        error: 'Database files cannot be deleted from file browser',
      });
      return;
    }

    let deletedDownloadRecords = 0;
    let deletedWorkflowTask = false;
    const variants = pathVariants(resolvedBaseDir, fullPath);
    let workflowTaskId: string | null = null;
    if (stats.isDirectory() && (source === 'workflow' || type === 'workflow')) {
      const relativePath = relative(resolvedBaseDir, fullPath);
      const taskId = relativePath.split(/[\\/]/)[0];
      workflowTaskId = taskId && taskId !== '..' && taskId !== '.' ? taskId : null;
    }

    if (config.storage?.databasePath) {
      database = new Database(config.storage.databasePath);
      database.migrate();
    }

    if (stats.isDirectory()) {
      rmSync(fullPath, { recursive: true, force: false });
    } else {
      unlinkSync(fullPath);
    }

    if (database) {
      if (stats.isDirectory()) {
        deletedDownloadRecords = database.deleteDownloadsByFilePathPrefix(variants);
        if (workflowTaskId) {
          deletedWorkflowTask = database.deleteWorkflowTask(workflowTaskId);
        }
      } else {
        deletedDownloadRecords = database.deleteDownloadsByFilePath(variants);
      }
    }

    if (database) {
      database.close();
      database = null;
    }

    res.json({
      success: true,
      errorCode: ErrorCode.FILE_DELETE_SUCCESS,
      data: {
        deletedType: stats.isDirectory() ? 'directory' : 'file',
        deletedDownloadRecords,
        deletedWorkflowTask,
      },
    });
  } catch (error) {
    if (database) {
      try {
        database.close();
      } catch {
        // Ignore close errors
      }
    }
    logger.error('Failed to delete file', { error });
    res.status(500).json({ errorCode: ErrorCode.FILE_DELETE_FAILED });
  }
}

/**
 * POST /api/files/normalize
 * Normalize and reorganize downloaded files
 * Body: { dryRun?: boolean, normalizeNames?: boolean, reorganize?: boolean, updateDatabase?: boolean, type?: 'illustration' | 'novel' | 'all' }
 */
export async function normalizeFiles(req: Request, res: Response): Promise<void> {
  let database: Database | null = null;
  try {
    const {
      dryRun = false,
      normalizeNames = true,
      reorganize = true,
      updateDatabase = true,
      type = 'all',
    } = req.body;

    const configPath = getConfigPath();
    const config = loadConfig(configPath);

    // Initialize database and file service
    database = new Database(config.storage!.databasePath!);
    database.migrate();

    const fileService = new FileService(config.storage!, config.runtime?.timezone);
    const normalizationService = new FileNormalizationService(
      config.storage!,
      fileService,
      database
    );

    // Run normalization
    const result = await normalizationService.normalizeFiles({
      dryRun,
      normalizeNames,
      reorganize,
      updateDatabase,
      type: type as 'illustration' | 'novel' | 'all',
    });

    database.close();
    database = null;

    res.json({
      data: {
        success: true,
        result,
      },
    });
  } catch (error) {
    if (database) {
      try {
        database.close();
      } catch (closeError) {
        // Ignore close errors
      }
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Failed to normalize files', { error: { message: errorMessage } });
    res.status(500).json({ errorCode: ErrorCode.FILE_NORMALIZE_FAILED, message: errorMessage });
  }
}

























































