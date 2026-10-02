/**
 * Wallpaper Engine video wallpaper package publisher.
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

/** Official WE content tags (subset). */
export const WE_TAGS = [
  'Anime',
  'Game',
  'Landscape',
  'Sci-Fi',
  'Abstract',
  'Animals',
  'People',
  'Technology',
  'Cars',
  'Humor',
  'Horror',
  'Holiday',
  'Quotes',
  'Other',
] as const;

export const weProjectSchema = {
  type: 'object',
  required: ['type', 'file', 'title', 'preview', 'contentrating', 'visibility'],
  properties: {
    type: { const: 'video' },
    file: { type: 'string' },
    preview: { type: 'string' },
    title: { type: 'string' },
    description: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    contentrating: { type: 'string' },
    visibility: { type: 'string' },
    general: { type: 'object' },
  },
} as const;

export class WallpaperEnginePackagePublisher implements Publisher {
  readonly id = 'wallpaper-engine-package';
  readonly displayName = 'Wallpaper Engine 包';
  readonly capabilities: PublisherCapabilities = {
    auth: 'none',
    aspectRatios: ['16:9', '9:16', '1:1', '3:4'],
    titleMax: 128,
    descMax: 1000,
    tagsMax: 10,
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
    const dir = join(this.dataDir, 'exports', pkg.taskId, 'wallpaper-engine-package');
    if (opts.dryRun) {
      return { status: 'dry_run', exportDir: dir, message: 'WE package dry-run' };
    }
    if (!existsSync(pkg.videoPath) || !existsSync(pkg.coverPath)) return { status: 'failed', message: 'video or cover file not found' };
    mkdirSync(dir, { recursive: true });
    const videoName = 'video.mp4';
    const previewName = 'preview.jpg';
    if (existsSync(pkg.videoPath)) copyFileSync(pkg.videoPath, join(dir, videoName));
    if (existsSync(pkg.coverPath)) copyFileSync(pkg.coverPath, join(dir, previewName));

    const tags = pkg.tags
      .map((t) => WE_TAGS.find((w) => w.toLowerCase() === t.toLowerCase()))
      .filter(Boolean) as string[];
    if (tags.length === 0) tags.push('Other');

    const project = {
      type: 'video',
      file: videoName,
      preview: previewName,
      title: pkg.title,
      description: pkg.description,
      tags,
      contentrating: 'Everyone',
      visibility: 'public',
      general: { properties: {} },
    };
    writeFileSync(join(dir, 'project.json'), JSON.stringify(project, null, 2));

    // preview must be < 1MB
    if (existsSync(join(dir, previewName))) {
      const size = statSync(join(dir, previewName)).size;
      if (size > 1024 * 1024) {
        return { status: 'failed', message: `preview exceeds 1MB (${size})` };
      }
    }
    return { status: 'exported', exportDir: dir, url: `we://package/${pkg.taskId}` };
  }
}

/** Lightweight schema check (no external jsonschema dep). */
export function validateWeProject(project: Record<string, unknown>): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const key of weProjectSchema.required) {
    if (project[key] === undefined || project[key] === null || project[key] === '') {
      errors.push(`missing ${key}`);
    }
  }
  if (project.type !== 'video') errors.push('type must be video');
  return { ok: errors.length === 0, errors };
}
