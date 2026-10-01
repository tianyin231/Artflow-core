/**
 * P1/P2 publisher tests (T8).
 */
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  YouTubePublisher,
  TelegramPublisher,
  SteamWorkshopPublisher,
  DouyinPublisher,
  XiaohongshuExportPublisher,
  DiscordWebhookPublisher,
} from '../../publishers/platforms';
import { PublishPackage } from '../../publishers/types';

function makePkg(over: Partial<PublishPackage> = {}): PublishPackage {
  return {
    taskId: 't2',
    videoPath: '/tmp/v.mp4',
    coverPath: '/tmp/c.jpg',
    title: 'T',
    description: 'D',
    tags: ['Anime'],
    aspectRatio: '16:9',
    durationSec: 10,
    sizeBytes: 1000,
    sources: [],
    ...over,
  };
}

function writeAssets(dir: string) {
  const v = join(dir, 'v.mp4');
  const c = join(dir, 'c.jpg');
  writeFileSync(v, 'v');
  writeFileSync(c, 'c');
  return { v, c };
}

describe('YouTubePublisher', () => {
  it('validate + dryRun', async () => {
    const pub = new YouTubePublisher({ accessToken: 't' });
    expect(pub.validate(makePkg()).ok).toBe(true);
    expect((await pub.publish(makePkg(), { dryRun: true })).status).toBe('dry_run');
    expect((await pub.authStatus()).state).toBe('ok');
  });

  it('publish maps failure without mock', async () => {
    process.env.ARTFLOW_YOUTUBE_BASE_URL = 'http://127.0.0.1:9';
    const pub = new YouTubePublisher({ accessToken: 't' });
    const res = await pub.publish(makePkg(), { dryRun: false });
    expect(res.status).toBe('failed');
    delete process.env.ARTFLOW_YOUTUBE_BASE_URL;
  });
});

describe('TelegramPublisher', () => {
  it('rejects >50MB', () => {
    const pub = new TelegramPublisher({ botToken: 't', chatId: '1' });
    const v = pub.validate(makePkg({ sizeBytes: 60 * 1024 * 1024 }));
    expect(v.ok).toBe(false);
  });
  it('dryRun', async () => {
    const pub = new TelegramPublisher({ botToken: 't', chatId: '1' });
    expect((await pub.publish(makePkg(), { dryRun: true })).status).toBe('dry_run');
  });
});

describe('SteamWorkshopPublisher', () => {
  it('writes VDF and dryRun', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'artflow-steam-'));
    const assets = writeAssets(dir);
    const pub = new SteamWorkshopPublisher({
      steamcmdPath: '/no/steamcmd',
      user: 'u',
      contentFolder: dir,
    });
    const res = await pub.publish(
      makePkg({ videoPath: assets.v, coverPath: assets.c }),
      { dryRun: true }
    );
    expect(res.status).toBe('dry_run');
    const vdf = readFileSync(join(dir, 'item.vdf'), 'utf8');
    expect(vdf).toContain('431960');
    expect(vdf).toContain('publishedfileid');
    expect(vdf).not.toContain('password');
  });
});

describe('DouyinPublisher', () => {
  it('maps 2190005 and 2114006', async () => {
    const pub = new DouyinPublisher({ openId: 'o', accessToken: 't' });
    const big = pub.validate(makePkg({ sizeBytes: 200 * 1024 * 1024 }));
    expect(big.ok).toBe(false);
    expect(big.issues[0].message).toContain('2190005');
    const long = pub.validate(makePkg({ durationSec: 20 * 60 }));
    expect(long.ok).toBe(false);
    expect(long.issues[0].message).toContain('2114006');
    expect((await pub.publish(makePkg(), { dryRun: true })).status).toBe('dry_run');
  });
});

describe('XiaohongshuExportPublisher', () => {
  it('manualOnly export', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'artflow-xhs-'));
    const assets = writeAssets(dir);
    const pub = new XiaohongshuExportPublisher(dir);
    expect(pub.capabilities.manualOnly).toBe(true);
    const res = await pub.publish(
      makePkg({ videoPath: assets.v, coverPath: assets.c, aspectRatio: '3:4', title: '短标题' }),
      { dryRun: false }
    );
    expect(res.status).toBe('exported');
    expect(existsSync(join(res.exportDir!, 'meta.json'))).toBe(true);
  });
});

describe('DiscordWebhookPublisher', () => {
  it('validate + dryRun', async () => {
    const pub = new DiscordWebhookPublisher('http://127.0.0.1:9/hook');
    expect(pub.validate(makePkg()).ok).toBe(true);
    expect((await pub.publish(makePkg(), { dryRun: true })).status).toBe('dry_run');
    const big = pub.validate(makePkg({ sizeBytes: 30 * 1024 * 1024 }));
    expect(big.ok).toBe(false);
  });
});
