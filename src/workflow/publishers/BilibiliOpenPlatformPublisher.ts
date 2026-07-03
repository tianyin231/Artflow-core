import {
  BilibiliOpenPlatformPublishResult,
  BilibiliPublishPreview,
} from '../types';

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

export class NotConfiguredBilibiliOpenPlatformPublisher implements BilibiliOpenPlatformPublisher {
  constructor(private readonly credentials: BilibiliOpenPlatformCredentials = {}) {}

  async publishVideo(preview: BilibiliPublishPreview): Promise<BilibiliOpenPlatformPublishResult> {
    const missing = this.getMissingCredentialNames();
    return {
      status: 'not_configured',
      platform: 'bilibili',
      message: [
        'B站开放平台发布接口已预留，但尚未配置真实发布凭证。',
        `任务 ${preview.taskId} 的视频发布 payload 可先通过预览接口检查。`,
        missing.length > 0 ? `缺少字段: ${missing.join(', ')}` : undefined,
      ].filter(Boolean).join(' '),
    };
  }

  async publishArticle(preview: BilibiliPublishPreview): Promise<BilibiliOpenPlatformPublishResult> {
    if (!preview.syncArticle || !preview.article) {
      return {
        status: 'not_configured',
        platform: 'bilibili',
        message: '当前发布配置未开启同步专栏，无需调用专栏发布接口。',
      };
    }
    return this.publishVideo(preview);
  }

  private getMissingCredentialNames(): string[] {
    const required: Array<keyof BilibiliOpenPlatformCredentials> = ['clientId', 'clientSecret', 'accessToken'];
    return required.filter((key) => !this.credentials[key]);
  }
}
