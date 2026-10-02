/**
 * Per-platform test matrix (T8): ≥5 cases each for youtube/douyin/xhs/telegram/discord/steam.
 */
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  YouTubePublisher,
  DouyinPublisher,
  XiaohongshuExportPublisher,
  TelegramPublisher,
  DiscordWebhookPublisher,
  SteamWorkshopPublisher,
} from '../../publishers/platforms';
import { LocalExportPublisher } from '../../publishers/local-export';
import { WallpaperEnginePackagePublisher } from '../../publishers/wallpaper-engine';
import { BilibiliOpenPlatformPublisher } from '../../publishers/bilibili';
import { PublishPackage } from '../../publishers/types';

function pkg(over: Partial<PublishPackage> = {}): PublishPackage {
  return {
    taskId: 'm',
    videoPath: '/tmp/v.mp4',
    coverPath: '/tmp/c.jpg',
    title: 'Title',
    description: 'Desc',
    tags: ['Anime'],
    aspectRatio: '16:9',
    durationSec: 30,
    sizeBytes: 1024,
    sources: [],
    extras: { tid: 21 },
    ...over,
  };
}

function assets() {
  const dir = mkdtempSync(join(tmpdir(), 'pub-'));
  writeFileSync(join(dir, 'v.mp4'), 'v');
  writeFileSync(join(dir, 'c.jpg'), 'c');
  return { dir, videoPath: join(dir, 'v.mp4'), coverPath: join(dir, 'c.jpg') };
}

describe('YouTubePublisher (5+)', () => {
  const pub = new YouTubePublisher({ accessToken: 't' });
  it('validate ok', () => expect(pub.validate(pkg()).ok).toBe(true));
  it('validate rejects oversize title', () => expect(pub.validate(pkg({ title: 'x'.repeat(200) })).ok).toBe(false));
  it('authStatus ok with token', async () => expect((await pub.authStatus()).state).toBe('ok'));
  it('authStatus not_configured without token', async () =>
    expect((await new YouTubePublisher({}).authStatus()).state).toBe('not_configured'));
  it('dryRun returns dry_run', async () =>
    expect((await pub.publish(pkg(), { dryRun: true })).status).toBe('dry_run'));
  it('publish to unreachable maps failed', async () => {
    process.env.ARTFLOW_YOUTUBE_BASE_URL = 'http://127.0.0.1:9';
    const r = await pub.publish(pkg(), { dryRun: false });
    expect(r.status).toBe('failed');
    delete process.env.ARTFLOW_YOUTUBE_BASE_URL;
  });
});

describe('DouyinPublisher (5+)', () => {
  const pub = new DouyinPublisher({ openId: 'o', accessToken: 't' });
  it('validate ok', () => expect(pub.validate(pkg()).ok).toBe(true));
  it('2190005 size mapping', () => {
    const v = pub.validate(pkg({ sizeBytes: 200 * 1024 * 1024 }));
    expect(v.ok).toBe(false);
    expect(v.issues[0].message).toContain('2190005');
  });
  it('2114006 duration mapping', () => {
    const v = pub.validate(pkg({ durationSec: 20 * 60 }));
    expect(v.ok).toBe(false);
    expect(v.issues[0].message).toContain('2114006');
  });
  it('auth not_configured', async () =>
    expect((await new DouyinPublisher({}).authStatus()).state).toBe('not_configured'));
  it('dryRun requires explicit confirm', async () => {
    const r = await pub.publish(pkg(), { dryRun: true });
    expect(r.status).toBe('dry_run');
    expect(r.message).toContain('confirm');
  });
});

describe('XiaohongshuPublisher (5+)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xhs-'));
  const pub = new XiaohongshuExportPublisher(dir);
  it('manualOnly flag', () => expect(pub.capabilities.manualOnly).toBe(true));
  it('validate rejects long title', () => expect(pub.validate(pkg({ title: 'x'.repeat(50) })).ok).toBe(false));
  it('validate 3:4 ok', () => expect(pub.validate(pkg({ aspectRatio: '3:4' })).ok).toBe(true));
  it('export writes meta.json', async () => {
    const a = assets();
    const r = await pub.publish(pkg({ videoPath: a.videoPath, coverPath: a.coverPath, aspectRatio: '3:4', title: '短' }), { dryRun: false });
    expect(r.status).toBe('exported');
    expect(existsSync(join(r.exportDir!, 'meta.json'))).toBe(true);
  });
  it('dryRun', async () => expect((await pub.publish(pkg({ aspectRatio: '3:4', title: '短' }), { dryRun: true })).status).toBe('dry_run'));
});

describe('TelegramPublisher (5+)', () => {
  const pub = new TelegramPublisher({ botToken: 't', chatId: 'c' });
  it('validate ok', () => expect(pub.validate(pkg()).ok).toBe(true));
  it('rejects >50MB', () => expect(pub.validate(pkg({ sizeBytes: 60 * 1024 * 1024 })).ok).toBe(false));
  it('authStatus ok', async () => expect((await pub.authStatus()).state).toBe('ok'));
  it('dryRun', async () => expect((await pub.publish(pkg({ aspectRatio: '3:4', title: '短' }), { dryRun: true })).status).toBe('dry_run'));
  it('title max 1024', () => expect(pub.validate(pkg({ title: 'x'.repeat(2000) })).ok).toBe(false));
});

describe('DiscordWebhookPublisher (5+)', () => {
  const pub = new DiscordWebhookPublisher('http://127.0.0.1:9/hook');
  it('validate ok', () => expect(pub.validate(pkg()).ok).toBe(true));
  it('rejects >25MB', () => expect(pub.validate(pkg({ sizeBytes: 30 * 1024 * 1024 })).ok).toBe(false));
  it('authStatus ok with url', async () => expect((await pub.authStatus()).state).toBe('ok'));
  it('dryRun', async () => expect((await pub.publish(pkg({ aspectRatio: '3:4', title: '短' }), { dryRun: true })).status).toBe('dry_run'));
  it('publish unreachable maps failed', async () => {
    const r = await pub.publish(pkg(), { dryRun: false });
    expect(r.status).toBe('failed');
  });
});

describe('SteamWorkshopPublisher (5+)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'steam-'));
  const pub = new SteamWorkshopPublisher({ steamcmdPath: '/no/steamcmd', user: 'u', contentFolder: dir });
  it('validate ok', () => expect(pub.validate(pkg()).ok).toBe(true));
  it('experimental flag', () => expect(pub.capabilities.experimental).toBe(true));
  it('dryRun writes VDF with appid 431960', async () => {
    const a = assets();
    const r = await pub.publish(pkg({ videoPath: a.videoPath, coverPath: a.coverPath }), { dryRun: true });
    expect(r.status).toBe('dry_run');
    const vdf = readFileSync(join(dir, 'item.vdf'), 'utf8');
    expect(vdf).toContain('431960');
    expect(vdf).not.toContain('password');
  });
  it('missing steamcmd → auth_required', async () => {
    const r = await pub.publish(pkg(), { dryRun: false });
    expect(r.status).toBe('auth_required');
  });
  it('publishedfileid field present', async () => {
    await pub.publish(pkg(), { dryRun: true });
    expect(readFileSync(join(dir, 'item.vdf'), 'utf8')).toContain('publishedfileid');
  });
});

describe('P0 platforms still covered (5+ each)', () => {
  it('local-export 5 checks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'le-'));
    const pub = new LocalExportPublisher(dir);
    const a = assets();
    expect(pub.validate(pkg()).ok).toBe(true);
    expect((await pub.authStatus()).state).toBe('ok');
    expect((await pub.publish(pkg(), { dryRun: true })).status).toBe('dry_run');
    const r = await pub.publish(pkg({ videoPath: a.videoPath, coverPath: a.coverPath }), { dryRun: false });
    expect(r.status).toBe('exported');
    expect(existsSync(join(r.exportDir!, 'README.md'))).toBe(true);
  });

  it('wallpaper-engine 5 checks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'we-'));
    const pub = new WallpaperEnginePackagePublisher(dir);
    const a = assets();
    expect(pub.validate(pkg()).ok).toBe(true);
    expect(pub.capabilities.auth).toBe('none');
    expect((await pub.publish(pkg(), { dryRun: true })).status).toBe('dry_run');
    const r = await pub.publish(pkg({ videoPath: a.videoPath, coverPath: a.coverPath, tags: ['Anime'] }), { dryRun: false });
    expect(r.status).toBe('exported');
    const project = JSON.parse(readFileSync(join(r.exportDir!, 'project.json'), 'utf8'));
    expect(project.type).toBe('video');
  });

  it('bilibili 5 checks', async () => {
    const pub = new BilibiliOpenPlatformPublisher({ clientId: 'c', clientSecret: 's' });
    expect(pub.validate(pkg()).ok).toBe(true);
    expect(pub.capabilities.auth).toBe('oauth2');
    expect((await pub.authStatus()).state).toBe('not_configured');
    expect((await pub.publish(pkg(), { dryRun: true })).status).toBe('dry_run');
    const begin = await pub.beginAuth();
    expect(begin.authorizeUrl).toContain('client_id=c');
  });
});
