import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { YouTubePublisher, DouyinPublisher } from '../../publishers/platforms';
import { BilibiliOpenPlatformPublisher } from '../../publishers/bilibili';
import { PublishPackage } from '../../publishers/types';

const dir = mkdtempSync(join(tmpdir(), 'publisher-protocol-'));
const bytes = Buffer.from('actual video bytes');
const pkg: PublishPackage = { taskId: 'protocol', videoPath: join(dir, 'video.mp4'), coverPath: join(dir, 'cover.jpg'), title: 'test', description: '', tags: ['test'], aspectRatio: '16:9', durationSec: 1, sizeBytes: bytes.length, sources: [], extras: { tid: 21 } };
beforeAll(() => { writeFileSync(pkg.videoPath, bytes); writeFileSync(pkg.coverPath, 'cover'); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => jest.restoreAllMocks());
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

it('YouTube sends the real video, resumes from acknowledged bytes, and requires an ID', async () => {
  const mock = jest.spyOn(global, 'fetch')
    .mockResolvedValueOnce(new Response(null, { headers: { location: 'https://upload.example/session' } }))
    .mockResolvedValueOnce(new Response(null, { status: 308, headers: { range: 'bytes=0-5' } }))
    .mockResolvedValueOnce(json({ id: 'confirmed' }, 201));
  const result = await new YouTubePublisher({ accessToken: 'token' }).publish(pkg, { dryRun: false });
  expect(result.remoteId).toBe('confirmed');
  expect(mock.mock.calls[0][0]).toContain('part=snippet,status');
  expect(Buffer.from(mock.mock.calls[1][1]!.body as Uint8Array)).toEqual(bytes);
  expect(Buffer.from(mock.mock.calls[2][1]!.body as Uint8Array)).toEqual(bytes.subarray(6));
  expect(mock.mock.calls[2][1]!.headers).toMatchObject({ 'Content-Range': `bytes 6-${bytes.length - 1}/${bytes.length}` });
});

it.each([400, 200])('YouTube never reports success for HTTP %i without a video ID', async (status) => {
  jest.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(null, { headers: { location: 'https://upload.example/session' } })).mockResolvedValueOnce(json({ error: 'bad request' }, status));
  expect((await new YouTubePublisher({ accessToken: 'token' }).publish(pkg, { dryRun: false })).status).toBe('failed');
});

it('Douyin attaches credentials and file, and stops when upload fails', async () => {
  const mock = jest.spyOn(global, 'fetch').mockResolvedValue(json({ data: { error_code: 2190005 } }));
  expect((await new DouyinPublisher({ accessToken: 'token', openId: 'user' }).publish(pkg, { dryRun: false })).status).toBe('failed');
  expect(mock).toHaveBeenCalledTimes(1);
  expect(mock.mock.calls[0][0]).toContain('open_id=user');
  expect(mock.mock.calls[0][1]!.headers).toMatchObject({ 'access-token': 'token' });
  const file = (mock.mock.calls[0][1]!.body as FormData).get('video') as Blob;
  expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes);
});

it('Bilibili uploads bytes, completes parts and cover, then submits the confirmed upload token', async () => {
  const mock = jest.spyOn(global, 'fetch')
    .mockResolvedValueOnce(json({ code: 0, data: { upload_token: 'upload-token' } }))
    .mockResolvedValueOnce(json({ code: 0 }))
    .mockResolvedValueOnce(json({ code: 0 }))
    .mockResolvedValueOnce(json({ code: 0, data: { url: 'https://cover.example/c.jpg' } }))
    .mockResolvedValueOnce(json({ code: 0, data: { resource_id: 'BV123' } }));
  const result = await new BilibiliOpenPlatformPublisher({ clientId: 'client', clientSecret: 'secret', accessToken: 'token' }).publish(pkg, { dryRun: false });
  expect(result).toMatchObject({ status: 'submitted', remoteId: 'BV123' });
  expect(Buffer.from(mock.mock.calls[1][1]!.body as Uint8Array)).toEqual(bytes);
  expect(mock.mock.calls[1][0]).toContain('/video/v2/part/upload?upload_token=upload-token&part_number=1');
  expect(mock.mock.calls[2][0]).toContain('/video/complete?upload_token=upload-token');
  expect(mock.mock.calls[4][0]).toContain('/archive/add-by-utoken?upload_token=upload-token');
  expect(mock.mock.calls[4][1]!.headers).toMatchObject({ 'access-token': 'token', 'x-bili-signature-version': '2.0' });
  expect(JSON.parse(mock.mock.calls[4][1]!.body as string)).toMatchObject({ tid: 21, cover: 'https://cover.example/c.jpg' });
});

it('Bilibili stops before merge and submission when a video part fails', async () => {
  const mock = jest.spyOn(global, 'fetch').mockResolvedValueOnce(json({ code: 0, data: { upload_token: 'u' } })).mockResolvedValueOnce(json({ code: 4000, message: 'bad part' }));
  expect((await new BilibiliOpenPlatformPublisher({ clientId: 'c', clientSecret: 's', accessToken: 't' }).publish(pkg, { dryRun: false })).status).toBe('failed');
  expect(mock).toHaveBeenCalledTimes(2);
});

it('Bilibili validates OAuth state and interprets expiry as a UTC timestamp', async () => {
  const publisher = new BilibiliOpenPlatformPublisher({ clientId: 'c', clientSecret: 's' });
  const { state } = await publisher.beginAuth();
  const mock = jest.spyOn(global, 'fetch').mockResolvedValue(json({ code: 0, data: { access_token: 't', refresh_token: 'r', expires_in: 2000000000 } }));
  await expect(publisher.completeAuth({ state, callback: 'https://localhost/callback?code=x&state=bad' })).rejects.toThrow('state');
  expect(mock).not.toHaveBeenCalled();
  await publisher.completeAuth({ state, callback: 'https://localhost/callback?code=x&state=' + state });
  expect((await publisher.authStatus()).expiresAt).toBe(new Date(2000000000000).toISOString());
  expect(mock.mock.calls[0][0]).toContain('/x/account-oauth2/v1/token?');
});
