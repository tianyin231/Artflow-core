/**
 * Publisher + registry + P0 platforms tests (T8).
 */
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bilibiliSign,
  BilibiliOpenPlatformPublisher,
} from '../../publishers/bilibili';
import {
  LocalExportPublisher,
} from '../../publishers/local-export';
import {
  WallpaperEnginePackagePublisher,
  validateWeProject,
} from '../../publishers/wallpaper-engine';
import {
  DEFAULT_ENABLED_PUBLISHERS,
  PublishJobService,
  PublisherRegistry,
} from '../../publishers/registry';
import { PublishPackage } from '../../publishers/types';

function makePkg(over: Partial<PublishPackage> = {}): PublishPackage {
  return {
    taskId: 't1',
    videoPath: '/tmp/vid.mp4',
    coverPath: '/tmp/cover.jpg',
    title: 'Hello',
    description: 'World',
    tags: ['Anime'],
    aspectRatio: '16:9',
    durationSec: 10,
    sizeBytes: 1000,
    sources: [{ pixivId: '1', author: 'a', url: 'https://x' }],
    ...over,
  };
}

describe('bilibiliSign', () => {
  it('matches fixed HMAC vector', () => {
    // Deterministic: params sorted, secret fixed
    const sig = bilibiliSign({ b: '2', a: '1' }, 'secret', 1700000000);
    expect(sig).toBe(
      require('node:crypto')
        .createHmac('sha256', 'secret')
        .update('a=1&b=2&timestamp=1700000000')
        .digest('hex')
    );
  });
});

describe('LocalExportPublisher', () => {
  it('validate + publish + dryRun', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'artflow-exp-'));
    const pub = new LocalExportPublisher(dir);
    const tmp = mkdtempSync(join(tmpdir(), 'artflow-pkg-'));
    const video = join(tmp, 'v.mp4');
    const cover = join(tmp, 'c.jpg');
    writeFileSync(video, 'v');
    writeFileSync(cover, 'c');
    const pkg = makePkg({ videoPath: video, coverPath: cover });

    expect(pub.validate(pkg).ok).toBe(true);
    const dry = await pub.publish(pkg, { dryRun: true });
    expect(dry.status).toBe('dry_run');

    const res = await pub.publish(pkg, { dryRun: false });
    expect(res.status).toBe('exported');
    expect(existsSync(join(res.exportDir!, 'meta.json'))).toBe(true);
    expect(existsSync(join(res.exportDir!, 'README.md'))).toBe(true);
  });

  it('validate rejects oversized title', () => {
    const pub = new LocalExportPublisher('/tmp');
    const v = pub.validate(makePkg({ title: 'x'.repeat(200) }));
    expect(v.ok).toBe(false);
  });
});

describe('WallpaperEnginePackagePublisher', () => {
  it('produces valid project.json and checks preview size', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'artflow-we-'));
    const pub = new WallpaperEnginePackagePublisher(dir);
    const tmp = mkdtempSync(join(tmpdir(), 'artflow-we-src-'));
    const video = join(tmp, 'v.mp4');
    const cover = join(tmp, 'c.jpg');
    writeFileSync(video, 'v');
    writeFileSync(cover, 'c');
    const pkg = makePkg({ videoPath: video, coverPath: cover, tags: ['Anime', 'nope'] });
    const res = await pub.publish(pkg, { dryRun: false });
    expect(res.status).toBe('exported');
    const project = JSON.parse(readFileSync(join(res.exportDir!, 'project.json'), 'utf8'));
    expect(validateWeProject(project).ok).toBe(true);
    expect(project.type).toBe('video');
    expect(project.file).toBe('video.mp4');
    expect(project.tags).toContain('Anime');
  });
});

describe('PublisherRegistry + PublishJobService', () => {
  it('idempotent by taskId+publisherId', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'artflow-job-'));
    const reg = new PublisherRegistry();
    const pub = new LocalExportPublisher(dir);
    reg.register(pub);
    const svc = new PublishJobService(reg);
    const tmp = mkdtempSync(join(tmpdir(), 'artflow-job-src-'));
    writeFileSync(join(tmp, 'v.mp4'), 'v');
    writeFileSync(join(tmp, 'c.jpg'), 'c');
    const pkg = makePkg({
      videoPath: join(tmp, 'v.mp4'),
      coverPath: join(tmp, 'c.jpg'),
    });
    const r1 = await svc.run(pkg, 'local-export', { dryRun: true });
    const r2 = await svc.run(pkg, 'local-export', { dryRun: true });
    expect(r1.status).toBe('dry_run');
    expect(r2.status).toBe('dry_run');
    expect(svc.get('t1', 'local-export')!.attempts).toBe(1);
  });

  it('retry after failure works', async () => {
    const reg = new PublisherRegistry();
    let fail = true;
    reg.register({
      id: 'flaky',
      displayName: 'flaky',
      capabilities: { auth: 'none' },
      validate: () => ({ ok: true, issues: [] }),
      authStatus: async () => ({ state: 'ok' as const }),
      publish: async () => {
        if (fail) throw new Error('boom');
        return { status: 'exported' as const };
      },
    });
    const svc = new PublishJobService(reg);
    const pkg = makePkg();
    const r1 = await svc.run(pkg, 'flaky', { dryRun: false });
    expect(r1.status).toBe('failed');
    fail = false;
    const r2 = await svc.run(pkg, 'flaky', { dryRun: false });
    expect(r2.status).toBe('exported');
    expect(svc.get('t1', 'flaky')!.attempts).toBe(2);
  });

  it('default enabled set matches PRD', () => {
    expect(DEFAULT_ENABLED_PUBLISHERS).toContain('local-export');
    expect(DEFAULT_ENABLED_PUBLISHERS).toContain('wallpaper-engine-package');
  });
});

describe('BilibiliOpenPlatformPublisher', () => {
  it('auth not_configured without token', async () => {
    const pub = new BilibiliOpenPlatformPublisher({ clientId: 'c', clientSecret: 's' });
    expect((await pub.authStatus()).state).toBe('not_configured');
  });

  it('publish returns auth_required when expired and refresh fails', async () => {
    process.env.ARTFLOW_BILIBILI_BASE_URL = 'http://127.0.0.1:9';
    const pub = new BilibiliOpenPlatformPublisher({
      clientId: 'c',
      clientSecret: 's',
      accessToken: 't',
      refreshToken: 'r',
      expiresAt: Date.now() - 1000,
    });
    const res = await pub.publish(makePkg(), { dryRun: false });
    expect(res.status).toBe('auth_required');
    delete process.env.ARTFLOW_BILIBILI_BASE_URL;
  });

  it('dryRun returns dry_run', async () => {
    const pub = new BilibiliOpenPlatformPublisher({
      clientId: 'c',
      clientSecret: 's',
      accessToken: 't',
    });
    const res = await pub.publish(makePkg(), { dryRun: true });
    expect(res.status).toBe('dry_run');
  });
});
