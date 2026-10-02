/**
 * Local mock servers for fixture mode (LLM + Pixiv OAuth + generic publishers).
 * Usage: node test/mock-servers/index.mjs --port 3302
 * Also imported by jest tests with random ports.
 */
const http = require('node:http');
const { URL } = require('node:url');

const state = {
  requests: [],
  tokens: new Map(),
};

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function record(req, extra = {}) {
  state.requests.push({
    method: req.method,
    url: req.url,
    at: new Date().toISOString(),
    ...extra,
  });
}

async function handle(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  record(req);

  // Introspection
  if (url.pathname === '/__requests') {
    return json(res, 200, { requests: state.requests });
  }
  if (url.pathname === '/__reset') {
    state.requests.length = 0;
    state.tokens.clear();
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/__health') {
    return json(res, 200, { ok: true });
  }

  // OpenAI-compatible mock LLM
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    await readBody(req);
    return json(res, 200, {
      id: 'mock-1',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: JSON.stringify({
              pixivTarget: {
                tag: 'fixture',
                limit: 3,
                minBookmarks: 100,
                sort: 'popular_desc',
              },
              video: {
                title: 'Fixture Title',
                description: 'Fixture description',
                tags: ['fixture', 'artflow'],
                aspectRatio: '16:9',
                secondsPerImage: 1,
              },
              publish: {
                title: 'Fixture Publish',
                description: 'Hello fixture',
                tags: ['fixture'],
              },
            }),
          },
          finish_reason: 'stop',
        },
      ],
    });
  }

  // Pixiv OAuth mock
  if (url.pathname === '/web/v1/login') {
    const redirect = url.searchParams.get('redirect_uri') || 'pixiv://account/login';
    const code = 'mock_auth_code';
    const target = redirect.includes('?') ? `${redirect}&code=${code}` : `${redirect}?code=${code}`;
    res.writeHead(302, { Location: target });
    return res.end();
  }
  if (url.pathname === '/auth/token' && req.method === 'POST') {
    await readBody(req);
    return json(res, 200, {
      access_token: 'mock_access_token',
      refresh_token: 'mock_refresh_token',
      expires_in: 3600,
      token_type: 'bearer',
      user: { id: 'fixture-user', name: 'Fixture User' },
    });
  }

  // Bilibili mock
  if (url.pathname.startsWith('/x/open-platform/')) {
    await readBody(req);
    return json(res, 200, { code: 0, data: { id: 'mock-bili-1' } });
  }

  // YouTube mock (resumable upload)
  if (url.pathname === '/upload/youtube/v3/videos') {
    res.writeHead(200, { Location: 'http://127.0.0.1/__youtube_session/1', 'X-Goog-Upload-Status': 'active' });
    return res.end();
  }
  if (url.pathname.startsWith('/__youtube_session/')) {
    await readBody(req);
    return json(res, 200, { id: 'yt-mock-1', status: { uploadStatus: 'uploaded', privacyStatus: 'private' } });
  }

  // Telegram mock
  if (url.pathname.includes('/sendVideo')) {
    await readBody(req);
    return json(res, 200, { ok: true, result: { message_id: 1, video: { file_id: 'tg-mock' } } });
  }

  // Discord webhook mock
  if (url.pathname === '/discord/webhook') {
    await readBody(req);
    return json(res, 204, {});
  }

  // Douyin mock
  if (url.pathname.includes('/video/upload_video')) {
    await readBody(req);
    return json(res, 200, { data: { video: { video_id: 'dy-mock-1' } }, error_code: 0 });
  }
  if (url.pathname.includes('/video/create_video')) {
    await readBody(req);
    return json(res, 200, { data: { item_id: 'dy-item-1' }, error_code: 0 });
  }

  json(res, 404, { error: 'not_found', path: url.pathname });
}

function createMockServer() {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => json(res, 500, { error: String(e) }));
  });
  return server;
}

function startMockServer(port = 0) {
  const server = createMockServer();
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : port, state });
    });
  });
}

// CLI
module.exports = { createMockServer, startMockServer };
// Only start when this file is the process entry (not when required from index.mjs).
const isMain = require.main === module;
if (isMain) {
  const portArg = process.argv.indexOf('--port');
  const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 3302;
  startMockServer(port).then(({ port: p }) => {
    console.log(`[mock-servers] listening on http://127.0.0.1:${p}`);
    console.log(`[mock-servers] __requests at http://127.0.0.1:${p}/__requests`);
  });
}
