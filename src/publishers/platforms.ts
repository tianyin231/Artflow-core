/**
 * Remaining publishers: youtube, telegram, steam-workshop, douyin, xiaohongshu, discord-webhook.
 */
import { open, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  PublishOptions,
  PublishPackage,
  PublishResult,
  PublishValidation,
  Publisher,
  PublisherCapabilities,
  AuthState,
  validateCommon,
} from './types';

function base(id: string, fallback: string): string {
  return process.env[`ARTFLOW_${id.toUpperCase().replace(/-/g, '_')}_BASE_URL`] || fallback;
}

/** YouTube resumable upload (mock-friendly). */
export class YouTubePublisher implements Publisher {
  readonly id = 'youtube';
  readonly displayName = 'YouTube';
  readonly capabilities: PublisherCapabilities = {
    auth: 'oauth2',
    maxSizeBytes: 256 * 1024 * 1024 * 1024,
    maxDurationSec: 12 * 3600,
    aspectRatios: ['16:9', '9:16', '1:1'],
    titleMax: 100,
    descMax: 5000,
    tagsMax: 500,
  };

  constructor(private creds: { accessToken?: string; refreshToken?: string; expiresAt?: number }) {}

  validate(pkg: PublishPackage): PublishValidation {
    return validateCommon(pkg, this.capabilities);
  }

  async authStatus(): Promise<{ state: AuthState; expiresAt?: string }> {
    if (!this.creds.accessToken) return { state: 'not_configured' };
    if (this.creds.expiresAt && this.creds.expiresAt < Date.now()) {
      return { state: 'expired', expiresAt: new Date(this.creds.expiresAt).toISOString() };
    }
    return { state: 'ok', expiresAt: this.creds.expiresAt ? new Date(this.creds.expiresAt).toISOString() : undefined };
  }

  async publish(pkg: PublishPackage, opts: PublishOptions): Promise<PublishResult> {
    const v = this.validate(pkg);
    if (!v.ok) return { status: 'failed', message: v.issues.map((i) => i.message).join('; ') };
    if (opts.dryRun) return { status: 'dry_run', message: 'youtube dry-run' };
    if ((await this.authStatus()).state !== 'ok') return { status: 'auth_required', message: 'YouTube 需要有效的 access token' };
    const url = base('youtube', 'https://www.googleapis.com');
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(pkg.videoPath, 'r');
      const size = (await file.stat()).size;
      if (!size) return { status: 'failed', message: 'video file is empty' };
      const headers = { Authorization: 'Bearer ' + this.creds.accessToken };
      const init = await fetch(url + '/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
        method: 'POST', signal: opts.signal,
        headers: { ...headers, 'Content-Type': 'application/json', 'X-Upload-Content-Length': String(size), 'X-Upload-Content-Type': 'video/mp4' },
        body: JSON.stringify({ snippet: { title: pkg.title, description: pkg.description, tags: pkg.tags }, status: { privacyStatus: 'private' } }),
      });
      const location = init.headers.get('location');
      if (!init.ok || !location) return { status: 'failed', message: 'YouTube upload init failed: HTTP ' + init.status };
      let offset = 0;
      while (offset < size) {
        const chunk = Buffer.alloc(Math.min(8 * 1024 * 1024, size - offset));
        const { bytesRead } = await file.read(chunk, 0, chunk.length, offset);
        if (bytesRead === 0) return { status: 'failed', message: 'video file changed during upload' };
        const end = offset + bytesRead - 1;
        const result = await fetch(location, { method: 'PUT', signal: opts.signal, redirect: 'manual',
          headers: { ...headers, 'Content-Type': 'video/mp4', 'Content-Length': String(bytesRead), 'Content-Range': 'bytes ' + offset + '-' + end + '/' + size },
          body: new Uint8Array(chunk.subarray(0, bytesRead)),
        });
        if (result.status === 308) {
          const range = result.headers.get('range')?.match(/^bytes=0-(\d+)$/);
          const next = range ? Number(range[1]) + 1 : 0;
          if (next <= offset || next > end + 1) return { status: 'failed', message: 'invalid or stalled YouTube upload range' };
          offset = next;
          opts.onProgress?.(offset / size, 'Uploading video');
          continue;
        }
        if (!result.ok) return { status: 'failed', message: 'YouTube upload failed: HTTP ' + result.status };
        const body = await result.json() as { id?: string };
        if (!body.id || end + 1 !== size) return { status: 'failed', message: 'YouTube did not confirm a complete video upload' };
        return { status: 'published', remoteId: body.id, url: 'https://youtu.be/' + body.id };
      }
      return { status: 'failed', message: 'YouTube upload incomplete' };
    } catch (error) {
      return { status: 'failed', message: error instanceof Error ? error.message : String(error) };
    } finally { await file?.close(); }
  }
}

export class TelegramPublisher implements Publisher {
  readonly id = 'telegram';
  readonly displayName = 'Telegram';
  readonly capabilities: PublisherCapabilities = {
    auth: 'botToken',
    maxSizeBytes: 50 * 1024 * 1024,
    aspectRatios: ['16:9', '9:16', '1:1', '3:4'],
    titleMax: 1024,
    descMax: 1024,
    tagsMax: 20,
  };

  constructor(private readonly opts: { botToken: string; chatId: string }) {}

  validate(pkg: PublishPackage): PublishValidation {
    const v = validateCommon(pkg, this.capabilities);
    if (pkg.sizeBytes > 50 * 1024 * 1024) {
      v.issues.push({ field: 'sizeBytes', message: 'over 50MB — compress before send' });
      v.ok = false;
    }
    return v;
  }

  async authStatus() {
    return this.opts.botToken
      ? ({ state: 'ok' as const, account: this.opts.chatId })
      : ({ state: 'not_configured' as const });
  }

  async publish(pkg: PublishPackage, opts: PublishOptions): Promise<PublishResult> {
    const v = this.validate(pkg);
    if (!v.ok) return { status: 'failed', message: v.issues.map((i) => i.message).join('; ') };
    if (opts.dryRun) return { status: 'dry_run' };
    if (!existsSync(pkg.videoPath)) return { status: 'failed', message: 'video file not found' };
    const url = base('telegram', 'https://api.telegram.org');
    const form = new FormData();
    form.append('chat_id', this.opts.chatId);
    form.append('caption', `${pkg.title}\n${pkg.description}`);
    if (existsSync(pkg.videoPath)) {
      const buf = await import('node:fs/promises').then((fs) => fs.readFile(pkg.videoPath));
      form.append('video', new Blob([buf]), 'video.mp4');
    }
    const res = await fetch(`${url}/bot${this.opts.botToken}/sendVideo`, { method: 'POST', body: form });
    const body = (await res.json()) as { ok?: boolean; result?: { message_id?: number } };
    if (!res.ok || !body.ok || !body.result?.message_id) return { status: 'failed', message: 'telegram send failed' };
    return { status: 'published', remoteId: String(body.result?.message_id ?? '') };
  }
}

export class SteamWorkshopPublisher implements Publisher {
  readonly id = 'steam-workshop';
  readonly displayName = 'Steam Workshop (WE)';
  readonly capabilities: PublisherCapabilities = {
    auth: 'steamLogin',
    experimental: true,
    aspectRatios: ['16:9'],
    titleMax: 128,
    descMax: 8000,
    tagsMax: 10,
  };

  constructor(
    private readonly opts: { steamcmdPath: string; user: string; appid?: number; contentFolder: string }
  ) {}

  validate(pkg: PublishPackage): PublishValidation {
    return validateCommon(pkg, this.capabilities);
  }

  async authStatus(): Promise<{ state: AuthState }> {
    return { state: existsSync(this.opts.steamcmdPath) ? 'ok' : 'not_configured' };
  }

  async publish(pkg: PublishPackage, opts: PublishOptions): Promise<PublishResult> {
    const v = this.validate(pkg);
    if (!v.ok) return { status: 'failed', message: v.issues.map((i) => i.message).join('; ') };
    const vdfPath = join(this.opts.contentFolder, 'item.vdf');
    mkdirSync(this.opts.contentFolder, { recursive: true });
    writeFileSync(
      vdfPath,
      [
        '"workshopitem"',
        '{',
        `  "appid" "${this.opts.appid ?? 431960}"`,
        '  "publishedfileid" "0"',
        `  "contentfolder" "${this.opts.contentFolder}"`,
        `  "previewfile" "${pkg.coverPath}"`,
        '  "visibility" "0"',
        `  "title" "${pkg.title.replace(/"/g, "'")}"`,
        `  "description" "${pkg.description.replace(/"/g, "'")}"`,
        '  "changenote" "artflow publish"',
        '}',
      ].join('\n')
    );
    if (opts.dryRun) return { status: 'dry_run', message: vdfPath };
    if (!existsSync(this.opts.steamcmdPath)) {
      return { status: 'auth_required', message: 'steamcmd missing — run steamcmd +login manually' };
    }
    // argv must NOT contain password
    const args = ['+login', this.opts.user, '+workshop_build_item', vdfPath, '+quit'];
    const result = await new Promise<{ code: number; out: string }>((resolve) => {
      const child = spawn(this.opts.steamcmdPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('error', (error) => resolve({ code: 1, out: error.message }));
      child.on('close', (code) => resolve({ code: code ?? 1, out }));
    });
    const m = result.out.match(/publishedfileid["\s:]+(\d+)/i);
    const publishedfileid = m ? m[1] : undefined;
    if (publishedfileid) {
      writeFileSync(
        vdfPath,
        readVdfWithId(vdfPath, publishedfileid)
      );
    }
    return result.code === 0 && publishedfileid && publishedfileid !== '0'
      ? { status: 'submitted', remoteId: publishedfileid }
      : { status: 'failed', message: result.out.slice(-200) };
  }
}

function readVdfWithId(path: string, id: string): string {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  return readFileSync(path, 'utf8').replace('"publishedfileid" "0"', `"publishedfileid" "${id}"`);
}

export class DouyinPublisher implements Publisher {
  readonly id = 'douyin';
  readonly displayName = '抖音';
  readonly capabilities: PublisherCapabilities = {
    auth: 'oauth2',
    maxSizeBytes: 128 * 1024 * 1024,
    maxDurationSec: 15 * 60,
    aspectRatios: ['9:16', '16:9'],
    titleMax: 55,
    descMax: 1000,
    tagsMax: 10,
    experimental: true,
  };

  constructor(private creds: { openId?: string; accessToken?: string }) {}

  validate(pkg: PublishPackage): PublishValidation {
    const issues: { field: string; message: string }[] = [];
    if (pkg.sizeBytes > 128 * 1024 * 1024) {
      issues.push({ field: 'sizeBytes', message: '2190005 file too large (>128MB)' });
    }
    if (pkg.durationSec > 15 * 60) {
      issues.push({ field: 'durationSec', message: '2114006 duration exceeds 15 minutes' });
    }
    const common = validateCommon(
      { ...pkg, sizeBytes: Math.min(pkg.sizeBytes, 128 * 1024 * 1024), durationSec: Math.min(pkg.durationSec, 15 * 60) },
      this.capabilities
    );
    return { ok: issues.length === 0 && common.ok, issues: [...issues, ...common.issues] };
  }

  async authStatus() {
    return this.creds.accessToken
      ? ({ state: 'ok' as const, account: this.creds.openId })
      : ({ state: 'not_configured' as const });
  }

  async publish(pkg: PublishPackage, opts: PublishOptions): Promise<PublishResult> {
    const v = this.validate(pkg);
    if (!v.ok) return { status: 'failed', message: v.issues.map((i) => i.message).join('; ') };
    if (opts.dryRun) return { status: 'dry_run', message: 'douyin dry-run (requires explicit confirm)' };
    if (!this.creds.accessToken || !this.creds.openId) return { status: 'auth_required', message: '抖音需要 access token 和 open id' };
    try {
      const url = base('douyin', 'https://open.douyin.com');
      const query = '?open_id=' + encodeURIComponent(this.creds.openId);
      const headers = { 'access-token': this.creds.accessToken };
      const form = new FormData();
      form.append('video', new Blob([await readFile(pkg.videoPath)]), 'video.mp4');
      const up = await fetch(url + '/api/douyin/v1/video/upload_video/' + query, { method: 'POST', headers, body: form, signal: opts.signal });
      const uploaded = await up.json() as { data?: { error_code?: number; description?: string; video?: { video_id?: string } } };
      if (!up.ok || uploaded.data?.error_code !== 0 || !uploaded.data.video?.video_id) {
        return { status: 'failed', message: uploaded.data?.description || 'Douyin upload failed: ' + (uploaded.data?.error_code ?? up.status) };
      }
      const created = await fetch(url + '/api/douyin/v1/video/create_video/' + query, { method: 'POST', signal: opts.signal,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ video_id: uploaded.data.video.video_id, text: pkg.title + ' ' + pkg.tags.map((t) => '#' + t).join(' ') }),
      });
      const result = await created.json() as { data?: { error_code?: number; description?: string; item_id?: string } };
      if (!created.ok || result.data?.error_code !== 0 || !result.data.item_id) return { status: 'failed', message: result.data?.description || 'Douyin create failed: ' + (result.data?.error_code ?? created.status) };
      return { status: 'submitted', remoteId: result.data.item_id };
    } catch (error) { return { status: 'failed', message: error instanceof Error ? error.message : String(error) }; }
  }
}

export class XiaohongshuExportPublisher implements Publisher {
  readonly id = 'xiaohongshu';
  readonly displayName = '小红书（仅导出）';
  readonly capabilities: PublisherCapabilities = {
    auth: 'none',
    manualOnly: true,
    aspectRatios: ['3:4', '9:16'],
    titleMax: 20,
    descMax: 1000,
    tagsMax: 10,
  };

  constructor(private readonly dataDir: string) {}

  validate(pkg: PublishPackage): PublishValidation {
    return validateCommon(pkg, this.capabilities);
  }

  async authStatus() {
    return { state: 'ok' as const, account: 'manual' };
  }

  async publish(pkg: PublishPackage, opts: PublishOptions): Promise<PublishResult> {
    const v = this.validate(pkg);
    if (!v.ok) return { status: 'failed', message: v.issues.map((i) => i.message).join('; ') };
    const dir = join(this.dataDir, 'exports', pkg.taskId, 'xiaohongshu');
    if (opts.dryRun) return { status: 'dry_run', exportDir: dir };
    if (!existsSync(pkg.videoPath) || !existsSync(pkg.coverPath)) return { status: 'failed', message: 'video or cover file not found' };
    mkdirSync(dir, { recursive: true });
    if (existsSync(pkg.videoPath)) copyFileSync(pkg.videoPath, join(dir, 'video.mp4'));
    if (existsSync(pkg.coverPath)) copyFileSync(pkg.coverPath, join(dir, 'cover.jpg'));
    writeFileSync(
      join(dir, 'meta.json'),
      JSON.stringify(
        {
          title: pkg.title.slice(0, 20),
          description: pkg.description,
          topics: pkg.tags,
          aspectRatio: pkg.aspectRatio,
          note: '小红书无公开发布 API，请人工上传 3:4 或 9:16 变体',
        },
        null,
        2
      )
    );
    return { status: 'exported', exportDir: dir };
  }
}

export class DiscordWebhookPublisher implements Publisher {
  readonly id = 'discord-webhook';
  readonly displayName = 'Discord Webhook';
  readonly capabilities: PublisherCapabilities = {
    auth: 'none',
    maxSizeBytes: 25 * 1024 * 1024,
    aspectRatios: ['16:9', '9:16', '1:1', '3:4'],
    titleMax: 256,
    descMax: 2000,
    tagsMax: 10,
  };

  constructor(private readonly webhookUrl: string) {}

  validate(pkg: PublishPackage): PublishValidation {
    return validateCommon(pkg, this.capabilities);
  }

  async authStatus() {
    return this.webhookUrl
      ? ({ state: 'ok' as const })
      : ({ state: 'not_configured' as const });
  }

  async publish(pkg: PublishPackage, opts: PublishOptions): Promise<PublishResult> {
    const v = this.validate(pkg);
    if (!v.ok) return { status: 'failed', message: v.issues.map((i) => i.message).join('; ') };
    if (opts.dryRun) return { status: 'dry_run' };
    if (!existsSync(pkg.videoPath)) return { status: 'failed', message: 'video file not found' };
    const form = new FormData();
    form.append('payload_json', JSON.stringify({ content: `${pkg.title}\n${pkg.description}` }));
    if (existsSync(pkg.videoPath)) {
      const buf = await import('node:fs/promises').then((fs) => fs.readFile(pkg.videoPath));
      form.append('files[0]', new Blob([buf]), 'video.mp4');
    }
    try {
      const res = await fetch(this.webhookUrl, { method: 'POST', body: form });
      return res.ok || res.status === 204
        ? { status: 'published' }
        : { status: 'failed', message: `discord ${res.status}` };
    } catch (e) {
      return { status: 'failed', message: e instanceof Error ? e.message : String(e) };
    }
  }
}
