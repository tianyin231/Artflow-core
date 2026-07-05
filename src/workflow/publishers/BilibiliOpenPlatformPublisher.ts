import { createHash, createHmac, randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import {
  BilibiliOpenPlatformPublishResult,
  BilibiliPublishPreview,
} from '../types';

const MEMBER_BASE_URL = 'https://member.bilibili.com';
const OPENUPOS_BASE_URL = 'https://openupos.bilivideo.com';
const MAX_SMALL_VIDEO_BYTES = 100 * 1024 * 1024;

export interface BilibiliOpenPlatformCredentials {
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
}

export interface BilibiliOpenPlatformPublisher {
  publishVideo(preview: BilibiliPublishPreview): Promise<BilibiliOpenPlatformPublishResult>;
  publishArticle?(preview: BilibiliPublishPreview): Promise<BilibiliOpenPlatformPublishResult>;
}

interface BilibiliApiResponse<T> {
  code: number;
  message?: string;
  request_id?: string;
  ttl?: number;
  data?: T;
}

interface UploadInitData {
  upload_token: string;
}

interface CoverUploadData {
  url: string;
}

interface ArchiveSubmitData {
  resource_id?: string;
}

export class BilibiliOpenPlatformPublisherImpl implements BilibiliOpenPlatformPublisher {
  constructor(private readonly credentials: BilibiliOpenPlatformCredentials = {}) {}

  async publishVideo(preview: BilibiliPublishPreview): Promise<BilibiliOpenPlatformPublishResult> {
    const missing = this.getMissingCredentialNames();
    if (missing.length > 0) {
      return this.notConfigured(preview, missing);
    }
    if (!preview.videoPath || !existsSync(preview.videoPath)) {
      return this.failed('视频文件不存在，无法发布。');
    }
    if (!preview.coverPath || !existsSync(preview.coverPath)) {
      return this.failed('封面文件不存在，无法发布。');
    }

    const videoSize = statSync(preview.videoPath).size;
    if (videoSize > MAX_SMALL_VIDEO_BYTES) {
      return this.failed('当前已适配 B站开放平台 100MB 内小视频上传；该视频超过 100MB，需要后续启用分片上传。');
    }

    try {
      const init = await this.signedJsonRequest<UploadInitData>('/arcopen/fn/archive/video/init', {
        name: basename(preview.videoPath),
        utype: '1',
      });
      const uploadToken = this.requireData(init, (data) => data.upload_token, 'upload_token');
      await this.uploadSmallVideo(uploadToken, preview.videoPath);

      const cover = await this.uploadCover(preview.coverPath);
      const submit = await this.signedJsonRequest<ArchiveSubmitData>(
        '/arcopen/fn/archive/add-by-utoken',
        {
          title: this.clamp(preview.title, 80),
          cover,
          tid: this.resolveTid(preview.category),
          tag: preview.tags.join(',').slice(0, 200),
          desc: this.clamp(preview.description, 250),
          copyright: preview.copyright,
          no_reprint: preview.noReprint ? 1 : 0,
          source: preview.copyright === 2 ? preview.source || 'Pixiv artwork collection' : undefined,
        },
        { uploadToken }
      );

      const resourceId = submit.data?.resource_id;
      return {
        status: 'submitted',
        platform: 'bilibili',
        message: resourceId ? `B站稿件已提交审核: ${resourceId}` : 'B站稿件已提交审核。',
        requestId: submit.request_id,
        bvid: resourceId?.startsWith('BV') ? resourceId : undefined,
        aid: resourceId && !resourceId.startsWith('BV') ? resourceId : undefined,
        raw: submit,
      };
    } catch (error) {
      return this.failed(error instanceof Error ? error.message : String(error));
    }
  }

  async publishArticle(preview: BilibiliPublishPreview): Promise<BilibiliOpenPlatformPublishResult> {
    if (!preview.syncArticle || !preview.article) {
      return {
        status: 'queued',
        platform: 'bilibili',
        message: '当前发布配置未开启同步专栏。',
      };
    }
    return {
      status: 'queued',
      platform: 'bilibili',
      message: '视频发布已接入真实 B站开放平台；专栏发布接口保留在同一发布任务内，后续单独适配。',
    };
  }

  async testConnection(): Promise<{ ok: boolean; message: string; raw?: unknown }> {
    const missing = this.getMissingCredentialNames();
    if (missing.length > 0) {
      return { ok: false, message: `缺少字段: ${missing.join(', ')}` };
    }
    try {
      const response = await this.signedJsonRequest('/arcopen/fn/archive/type/list', {});
      return { ok: true, message: 'B站开放平台签名与凭证校验通过。', raw: response };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  private async uploadCover(coverPath: string): Promise<string> {
    const formData = new FormData();
    const buffer = await readFile(coverPath);
    formData.append('file', new Blob([buffer], { type: this.contentTypeForPath(coverPath) }), basename(coverPath));
    const response = await this.signedRequest<CoverUploadData>('/arcopen/fn/archive/cover/upload', {
      method: 'POST',
      body: formData,
      contentMd5: this.md5(buffer),
    });
    return this.requireData(response, (data) => data.url, 'url');
  }

  private async uploadSmallVideo(uploadToken: string, videoPath: string): Promise<void> {
    const url = `${OPENUPOS_BASE_URL}/video/v2/upload?upload_token=${encodeURIComponent(uploadToken)}`;
    const buffer = await readFile(videoPath);
    const response = await fetch(url, {
      method: 'POST',
      body: new Blob([buffer], { type: this.contentTypeForPath(videoPath) }),
    });
    const body = await this.parseJson<BilibiliApiResponse<unknown>>(response);
    if (body.code !== 0) {
      throw new Error(`B站视频上传失败: ${body.message || body.code}`);
    }
  }

  private async signedJsonRequest<T>(
    path: string,
    body: Record<string, unknown>,
    options: { uploadToken?: string } = {}
  ): Promise<BilibiliApiResponse<T>> {
    const normalizedBody = Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
    const rawBody = JSON.stringify(normalizedBody);
    return this.signedRequest<T>(path, {
      method: 'POST',
      body: rawBody,
      contentType: 'application/json',
      contentMd5: this.md5(rawBody),
      uploadToken: options.uploadToken,
    });
  }

  private async signedRequest<T>(
    path: string,
    options: {
      method: 'GET' | 'POST';
      body?: string | FormData | Blob;
      contentType?: string;
      contentMd5?: string;
      uploadToken?: string;
    }
  ): Promise<BilibiliApiResponse<T>> {
    const headers = this.createSignedHeaders(options.contentMd5 || this.md5(''), options.contentType);
    if (options.uploadToken) {
      headers.set('Upload-Token', options.uploadToken);
    }
    const response = await fetch(`${MEMBER_BASE_URL}${path}`, {
      method: options.method,
      headers,
      body: options.body,
    });
    const body = await this.parseJson<BilibiliApiResponse<T>>(response);
    if (body.code !== 0) {
      throw new Error(`B站开放平台请求失败(${path}): ${body.message || body.code}`);
    }
    return body;
  }

  private createSignedHeaders(contentMd5: string, contentType?: string): Headers {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = `${Date.now()}${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const signParts: Record<string, string> = {
      'x-bili-accesskeyid': this.credentials.clientId!,
      'x-bili-content-md5': contentMd5,
      'x-bili-signature-method': 'HMAC-SHA256',
      'x-bili-signature-nonce': nonce,
      'x-bili-signature-version': '2.0',
      'x-bili-timestamp': timestamp,
    };
    const signText = Object.keys(signParts)
      .sort()
      .map((key) => `${key}:${signParts[key]}`)
      .join('\n');
    const authorization = createHmac('sha256', this.credentials.clientSecret!)
      .update(signText)
      .digest('hex');

    const headers = new Headers({
      accept: 'application/json',
      'access-token': this.credentials.accessToken!,
      authorization,
    });
    for (const [key, value] of Object.entries(signParts)) {
      headers.set(key, value);
    }
    if (contentType) {
      headers.set('content-type', contentType);
    }
    return headers;
  }

  private async parseJson<T>(response: Response): Promise<T> {
    const text = await response.text();
    const body = text ? JSON.parse(text) as T : ({ code: response.ok ? 0 : response.status } as T);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text || response.statusText}`);
    }
    return body;
  }

  private requireData<T>(
    response: BilibiliApiResponse<T>,
    pick: (data: T) => string | undefined,
    name: string
  ): string {
    const value = response.data ? pick(response.data) : undefined;
    if (!value) {
      throw new Error(`B站开放平台响应缺少 ${name}`);
    }
    return value;
  }

  private resolveTid(category: string): number {
    const numeric = Number(category);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    if (category.includes('动画') || category.toLowerCase().includes('anime')) return 24;
    if (category.includes('游戏')) return 17;
    if (category.includes('音乐')) return 3;
    if (category.includes('科技')) return 36;
    return 21;
  }

  private contentTypeForPath(path: string): string {
    const extension = extname(path).toLowerCase();
    if (extension === '.png') return 'image/png';
    if (extension === '.webp') return 'image/webp';
    if (extension === '.mp4') return 'video/mp4';
    return 'image/jpeg';
  }

  private clamp(text: string, limit: number): string {
    return text.length <= limit ? text : text.slice(0, limit);
  }

  private md5(input: string | Buffer): string {
    return createHash('md5').update(input).digest('hex');
  }

  private getMissingCredentialNames(): string[] {
    const required: Array<keyof BilibiliOpenPlatformCredentials> = ['clientId', 'clientSecret', 'accessToken'];
    return required.filter((key) => !this.credentials[key]);
  }

  private notConfigured(preview: BilibiliPublishPreview, missing: string[]): BilibiliOpenPlatformPublishResult {
    return {
      status: 'not_configured',
      platform: 'bilibili',
      message: [
        'B站开放平台发布凭证未配置完整。',
        `任务 ${preview.taskId} 的视频发布 payload 可先通过预览接口检查。`,
        `缺少字段: ${missing.join(', ')}`,
      ].join(' '),
    };
  }

  private failed(message: string): BilibiliOpenPlatformPublishResult {
    return {
      status: 'failed',
      platform: 'bilibili',
      message,
    };
  }
}

export class NotConfiguredBilibiliOpenPlatformPublisher extends BilibiliOpenPlatformPublisherImpl {}
