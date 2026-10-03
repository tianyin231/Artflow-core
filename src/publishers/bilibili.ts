import { createHash, createHmac, randomUUID } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { PublishOptions, PublishPackage, PublishResult, PublishValidation, Publisher, PublisherCapabilities, AuthState, validateCommon } from './types';

// https://open.bilibili.com/doc/4/8673959e-f7bb-56e6-6e68-d225f971b81b
export function bilibiliSign(headers: Record<string, string>, clientSecret: string): string {
  const payload = Object.keys(headers).filter((k) => k.startsWith('x-bili-')).sort()
    .map((k) => `${k}:${headers[k]}`).join('\n');
  return createHmac('sha256', clientSecret).update(payload).digest('hex');
}

export interface BilibiliCredentials {
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

export class BilibiliOpenPlatformPublisher implements Publisher {
  readonly id = 'bilibili';
  readonly displayName = 'Bilibili';
  readonly capabilities: PublisherCapabilities = {
    auth: 'oauth2', maxSizeBytes: 4 * 1024 ** 3, maxDurationSec: 5 * 3600,
    aspectRatios: ['16:9', '9:16', '1:1'], titleMax: 79, descMax: 249, tagsMax: 12,
  };
  private pendingState?: string;

  constructor(private creds: BilibiliCredentials, private readonly secretGet?: (id: string) => string | undefined) {}

  private base(host = 'https://member.bilibili.com'): string {
    return process.env.ARTFLOW_BILIBILI_BASE_URL || host;
  }

  validate(pkg: PublishPackage): PublishValidation {
    const result = validateCommon(pkg, this.capabilities);
    if (!Number.isInteger(pkg.extras?.tid) || Number(pkg.extras?.tid) <= 0) {
      result.issues.push({ field: 'extras.tid', message: '请选择 B 站投稿分区 ID' });
    }
    if (!pkg.tags.length || pkg.tags.join(',').length >= 200) {
      result.issues.push({ field: 'tags', message: 'B 站标签不能为空且总长度须小于 200' });
    }
    result.ok = result.issues.length === 0;
    return result;
  }

  async authStatus(): Promise<{ state: AuthState; expiresAt?: string; account?: string }> {
    if (!(this.creds.accessToken || this.secretGet?.('bilibili.accessToken')) || !this.creds.clientId || !this.creds.clientSecret) {
      return { state: 'not_configured' };
    }
    const expiresAt = this.creds.expiresAt ? new Date(this.creds.expiresAt).toISOString() : undefined;
    return { state: this.creds.expiresAt && this.creds.expiresAt < Date.now() ? 'expired' : 'ok', expiresAt, account: this.creds.clientId };
  }

  async beginAuth(): Promise<{ authorizeUrl: string; state: string }> {
    const state = randomUUID();
    this.pendingState = state;
    const query = new URLSearchParams({ client_id: this.creds.clientId, state,
      gourl: process.env.ARTFLOW_BILIBILI_REDIRECT || 'http://127.0.0.1:3300/api/auth/bilibili/callback' });
    return { authorizeUrl: 'https://account.bilibili.com/pc/account-pc/auth/oauth?' + query, state };
  }

  async completeAuth(input: { state: string; callback: string }): Promise<void> {
    const url = new URL(input.callback);
    if (!this.pendingState || input.state !== this.pendingState || url.searchParams.get('state') !== this.pendingState) throw new Error('invalid OAuth state');
    const code = url.searchParams.get('code');
    if (!code) throw new Error('missing code');
    await this.exchangeToken('token', { grant_type: 'authorization_code', code });
    this.pendingState = undefined;
  }

  async refreshAuth(): Promise<void> {
    const refresh = this.creds.refreshToken || this.secretGet?.('bilibili.refreshToken');
    if (!refresh) throw new Error('no refresh token');
    await this.exchangeToken('refresh_token', { grant_type: 'refresh_token', refresh_token: refresh });
  }

  private async exchangeToken(path: string, values: Record<string, string>): Promise<void> {
    const query = new URLSearchParams({ ...values, client_id: this.creds.clientId, client_secret: this.creds.clientSecret });
    const res = await fetch(this.base('https://api.bilibili.com') + '/x/account-oauth2/v1/' + path + '?' + query,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const body = await res.json() as { code?: number; data?: { access_token?: string; refresh_token?: string; expires_in?: number } };
    if (!res.ok || body.code !== 0 || !body.data?.access_token || !body.data.expires_in) throw new Error('Bilibili token exchange failed');
    this.creds.accessToken = body.data.access_token;
    this.creds.refreshToken = body.data.refresh_token;
    // B 站 expires_in 是 UTC 秒时间戳，不是有效期秒数。
    this.creds.expiresAt = body.data.expires_in * 1000;
  }

  private headers(body: string): Record<string, string> {
    const headers: Record<string, string> = {
      'x-bili-accesskeyid': this.creds.clientId,
      'x-bili-content-md5': createHash('md5').update(body).digest('hex'),
      'x-bili-signature-method': 'HMAC-SHA256', 'x-bili-signature-nonce': randomUUID(),
      'x-bili-signature-version': '2.0', 'x-bili-timestamp': String(Math.floor(Date.now() / 1000)),
    };
    return { ...headers, Authorization: bilibiliSign(headers, this.creds.clientSecret),
      'access-token': this.creds.accessToken || this.secretGet?.('bilibili.accessToken') || '', Accept: 'application/json' };
  }

  private async request<T>(url: string, body: string | FormData, opts: PublishOptions): Promise<T> {
    const headers = this.headers(typeof body === 'string' ? body : '');
    if (typeof body === 'string') headers['Content-Type'] = 'application/json';
    const res = await fetch(url, { method: 'POST', headers, body: body || undefined, signal: opts.signal });
    return this.response<T>(res);
  }

  private async response<T>(res: Response): Promise<T> {
    const result = await res.json() as { code?: number; message?: string; data?: T };
    if (!res.ok || result.code !== 0) throw new Error(result.message || `Bilibili HTTP ${res.status}, code ${result.code}`);
    return result.data as T;
  }

  async publish(pkg: PublishPackage, opts: PublishOptions): Promise<PublishResult> {
    const validation = this.validate(pkg);
    if (!validation.ok) return { status: 'failed', message: validation.issues.map((i) => i.message).join('; ') };
    if (opts.dryRun) return { status: 'dry_run', message: 'bilibili dry-run' };
    if ((await this.authStatus()).state !== 'ok') return { status: 'auth_required', message: '需重新授权' };
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(pkg.videoPath, 'r');
      const size = (await file.stat()).size;
      if (!size || size > this.capabilities.maxSizeBytes!) throw new Error('invalid video size');
      const cover = await readFile(pkg.coverPath);
      const init = await this.request<{ upload_token: string }>(this.base() + '/arcopen/fn/archive/video/init', JSON.stringify({ name: basename(pkg.videoPath), utype: 0 }), opts);
      if (!init?.upload_token) throw new Error('missing upload token');
      const query = new URLSearchParams({ upload_token: init.upload_token });
      const partSize = 10 * 1024 * 1024;
      for (let offset = 0, part = 1; offset < size; part++) {
        const chunk = Buffer.alloc(Math.min(partSize, size - offset));
        const { bytesRead } = await file.read(chunk, 0, chunk.length, offset);
        if (bytesRead !== chunk.length) throw new Error('video changed during upload');
        const res = await fetch(this.base('https://openupos.bilivideo.com') + '/video/v2/part/upload?' + query + '&part_number=' + part,
          { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(chunk), signal: opts.signal });
        await this.response(res);
        offset += bytesRead;
        opts.onProgress?.(offset / size, 'Uploading video');
      }
      await this.request(this.base() + '/arcopen/fn/archive/video/complete?' + query, '', opts);
      const form = new FormData();
      form.append('file', new Blob([cover]), basename(pkg.coverPath));
      const uploadedCover = await this.request<{ url: string }>(this.base() + '/arcopen/fn/archive/cover/upload', form, opts);
      if (!uploadedCover?.url) throw new Error('missing cover URL');
      const result = await this.request<{ resource_id: string }>(this.base() + '/arcopen/fn/archive/add-by-utoken?' + query,
        JSON.stringify({ title: pkg.title, desc: pkg.description, tag: pkg.tags.join(','), tid: pkg.extras!.tid,
          cover: uploadedCover.url, copyright: pkg.extras?.copyright ?? 1, source: pkg.sources[0]?.url }), opts);
      if (!result?.resource_id) throw new Error('Bilibili did not confirm submission');
      return { status: 'submitted', remoteId: result.resource_id, url: 'https://www.bilibili.com/video/' + result.resource_id };
    } catch (error) {
      return { status: 'failed', message: error instanceof Error ? error.message : String(error) };
    } finally { await file?.close(); }
  }
}
