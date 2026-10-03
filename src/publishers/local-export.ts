/**
 * local-export publisher — writes a manual publish package to disk.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  PublishOptions,
  PublishPackage,
  PublishResult,
  PublishValidation,
  Publisher,
  PublisherCapabilities,
  validateCommon,
} from './types';

export class LocalExportPublisher implements Publisher {
  readonly id = 'local-export';
  readonly displayName = '本地发布包';
  readonly capabilities: PublisherCapabilities = {
    auth: 'none',
    aspectRatios: ['16:9', '9:16', '1:1', '3:4'],
    titleMax: 100,
    descMax: 2000,
    tagsMax: 20,
  };

  constructor(private readonly dataDir: string) {}

  validate(pkg: PublishPackage): PublishValidation {
    return validateCommon(pkg, this.capabilities);
  }

  async authStatus() {
    return { state: 'ok' as const, account: 'local' };
  }

  async publish(pkg: PublishPackage, opts: PublishOptions): Promise<PublishResult> {
    const validation = this.validate(pkg);
    if (!validation.ok) {
      return { status: 'failed', message: validation.issues.map((i) => i.message).join('; ') };
    }
    if (opts.dryRun) {
      return { status: 'dry_run', message: 'local-export dry-run' };
    }
    const dir = join(this.dataDir, 'exports', pkg.taskId, 'local-export');
    if (!existsSync(pkg.videoPath) || !existsSync(pkg.coverPath)) return { status: 'failed', message: 'video or cover file not found' };
    mkdirSync(dir, { recursive: true });
    if (existsSync(pkg.videoPath)) {
      copyFileSync(pkg.videoPath, join(dir, 'video.mp4'));
    }
    if (existsSync(pkg.coverPath)) {
      copyFileSync(pkg.coverPath, join(dir, 'cover.jpg'));
    }
    const meta = {
      taskId: pkg.taskId,
      title: pkg.title,
      description: pkg.description,
      tags: pkg.tags,
      aspectRatio: pkg.aspectRatio,
      durationSec: pkg.durationSec,
      sizeBytes: pkg.sizeBytes,
      sources: pkg.sources,
    };
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    writeFileSync(
      join(dir, 'README.md'),
      [
        `# ${pkg.title}`,
        '',
        pkg.description,
        '',
        `Tags: ${pkg.tags.join(', ')}`,
        '',
        '## Manual publish steps',
        '1. Upload video.mp4 and cover.jpg to the target platform.',
        '2. Copy title/description/tags from meta.json.',
        '3. Verify aspect ratio and duration limits before posting.',
      ].join('\n')
    );
    return { status: 'exported', exportDir: dir };
  }
}
