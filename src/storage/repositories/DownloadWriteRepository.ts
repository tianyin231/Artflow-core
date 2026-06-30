import { BaseRepository } from './BaseRepository';
import { DownloadRecordInput } from '../Database';

/**
 * Repository for writing download records
 */
export class DownloadWriteRepository extends BaseRepository {
  /**
   * Insert a download record
   */
  public insertDownload(record: DownloadRecordInput): void {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO downloads (
         pixiv_id,
         type,
         tag,
         title,
         file_path,
         author,
         user_id,
         author_account,
         author_profile_image_urls,
         tags_json,
         caption,
         file_hash
       )
       VALUES (
         @pixiv_id,
         @type,
         @tag,
         @title,
         @file_path,
         @author,
         @user_id,
         @author_account,
         @author_profile_image_urls,
         @tags_json,
         @caption,
         @file_hash
       )`
    );

    stmt.run({
      pixiv_id: record.pixivId,
      type: record.type,
      tag: record.tag,
      title: record.title,
      file_path: record.filePath,
      author: record.author ?? null,
      user_id: record.userId ?? null,
      author_account: record.authorAccount ?? null,
      author_profile_image_urls: record.authorProfileImageUrls ? JSON.stringify(record.authorProfileImageUrls) : null,
      tags_json: record.tags ? JSON.stringify(record.tags) : null,
      caption: record.caption ?? null,
      file_hash: record.fileHash ?? null,
    });
  }

  /**
   * Record download (alias for insertDownload)
   */
  public recordDownload(record: DownloadRecordInput): void {
    this.insertDownload(record);
  }

  /**
   * Update file path in database
   */
  public updateFilePath(
    pixivId: string,
    type: 'illustration' | 'novel',
    oldPath: string,
    newPath: string
  ): number {
    const stmt = this.db.prepare(
      `UPDATE downloads 
       SET file_path = ? 
       WHERE pixiv_id = ? AND type = ? AND file_path = ?`
    );

    const result = stmt.run(newPath, pixivId, type, oldPath);
    return result.changes;
  }

  public deleteByFilePath(filePaths: string[]): number {
    const uniquePaths = Array.from(new Set(filePaths.filter(Boolean)));
    if (uniquePaths.length === 0) return 0;

    const placeholders = uniquePaths.map(() => '?').join(',');
    const stmt = this.db.prepare(`DELETE FROM downloads WHERE file_path IN (${placeholders})`);
    return stmt.run(...uniquePaths).changes;
  }

  public deleteByFilePathPrefix(prefixes: string[]): number {
    const uniquePrefixes = Array.from(new Set(prefixes.filter(Boolean)));
    if (uniquePrefixes.length === 0) return 0;

    const conditions = uniquePrefixes.map(() => `(file_path = ? OR file_path LIKE ?)`).join(' OR ');
    const params = uniquePrefixes.flatMap((prefix) => [prefix, `${prefix.replace(/\/+$/, '')}/%`]);
    const stmt = this.db.prepare(`DELETE FROM downloads WHERE ${conditions}`);
    return stmt.run(...params).changes;
  }
}





























































