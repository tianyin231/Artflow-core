/**
 * Publisher management routes (F1).
 */
import { Router, Request, Response } from 'express';
import { LocalExportPublisher } from '../../publishers/local-export';
import { WallpaperEnginePackagePublisher } from '../../publishers/wallpaper-engine';
import { BilibiliOpenPlatformPublisher } from '../../publishers/bilibili';
import {
  DouyinPublisher,
  XiaohongshuExportPublisher,
  DiscordWebhookPublisher,
  TelegramPublisher,
  YouTubePublisher,
  SteamWorkshopPublisher,
} from '../../publishers/platforms';
import {
  DEFAULT_ENABLED_PUBLISHERS,
  PublishJobService,
  PublisherRegistry,
} from '../../publishers/registry';
import { PublishPackage } from '../../publishers/types';
import { getConfigPath, loadConfig } from '../../config';

const router = Router();

function buildRegistry(): { registry: PublisherRegistry; jobs: PublishJobService } {
  const config = loadConfig(getConfigPath());
  const dataDir = process.env.ARTFLOW_DATA_DIR || process.cwd();
  const registry = new PublisherRegistry();
  registry.register(new LocalExportPublisher(dataDir));
  registry.register(new WallpaperEnginePackagePublisher(dataDir));
  registry.register(
    new BilibiliOpenPlatformPublisher({
      clientId: process.env.ARTFLOW_BILIBILI_CLIENT_ID || 'unset',
      clientSecret: process.env.ARTFLOW_BILIBILI_CLIENT_SECRET || 'unset',
    })
  );
  registry.register(new YouTubePublisher({}));
  registry.register(
    new TelegramPublisher({
      botToken: process.env.ARTFLOW_TELEGRAM_BOT_TOKEN || '',
      chatId: process.env.ARTFLOW_TELEGRAM_CHAT_ID || '',
    })
  );
  registry.register(
    new SteamWorkshopPublisher({
      steamcmdPath: process.env.ARTFLOW_STEAMCMD || 'steamcmd',
      user: process.env.ARTFLOW_STEAM_USER || '',
      contentFolder: `${dataDir}/exports/steam`,
    })
  );
  registry.register(new DouyinPublisher({}));
  registry.register(new XiaohongshuExportPublisher(dataDir));
  registry.register(
    new DiscordWebhookPublisher(process.env.ARTFLOW_DISCORD_WEBHOOK || '')
  );
  return { registry, jobs: new PublishJobService(registry) };
}

router.get('/', async (_req: Request, res: Response) => {
  try {
    const { registry } = buildRegistry();
    const list = await Promise.all(
      registry.list().map(async (p) => {
        const status = await p.authStatus();
        return {
          id: p.id,
          displayName: p.displayName,
          enabled: DEFAULT_ENABLED_PUBLISHERS.includes(p.id),
          experimental: p.capabilities.experimental,
          manualOnly: p.capabilities.manualOnly,
          auth: p.capabilities.auth,
          state: status.state,
          account: status.account,
        };
      })
    );
    res.json({ data: list });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

router.post('/:id/dry-run', async (req: Request, res: Response) => {
  try {
    const { registry, jobs } = buildRegistry();
    const id = req.params.id;
    const publisher = registry.get(id);
    if (!publisher) {
      return res.status(404).json({ error: `unknown publisher ${id}` });
    }
    const body = req.body as Partial<PublishPackage>;
    if (body.extras !== undefined && (body.extras === null || typeof body.extras !== 'object' || Array.isArray(body.extras))) {
      return res.status(400).json({ error: 'extras must be an object' });
    }
    const pkg: PublishPackage = {
      taskId: body.taskId || 'ui-dryrun',
      videoPath: body.videoPath || '',
      coverPath: body.coverPath || '',
      title: body.title || 'dry-run',
      description: body.description || 'dry-run',
      tags: body.tags || [],
      aspectRatio: (body.aspectRatio as PublishPackage['aspectRatio']) || '16:9',
      durationSec: body.durationSec ?? 1,
      sizeBytes: body.sizeBytes ?? 1,
      sources: body.sources || [],
      extras: body.extras,
    };
    const result = await jobs.run(pkg, id, { dryRun: true });
    return res.json({ data: result });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

export default router;
