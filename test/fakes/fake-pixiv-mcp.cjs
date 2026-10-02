#!/usr/bin/env node
/**
 * Fake pixiv MCP server (stdio JSON-RPC).
 * Scenarios via FAKE_PIXIV_MCP_SCENARIO=ok|crash
 */
const readline = require('readline');

const scenario = process.env.FAKE_PIXIV_MCP_SCENARIO || 'ok';
const works = [
  {
    id: '80001',
    type: 'illust',
    title: 'MCP Work',
    authorId: '42',
    authorName: 'MCP Author',
    tags: ['mcp'],
    createdAt: '2025-06-15T00:00:00+09:00',
    bookmarks: 300,
    views: 3000,
    pageCount: 1,
    xRestrict: 0,
    url: 'https://www.pixiv.net/artworks/80001',
  },
];

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function toolResult(data) {
  return { content: [{ type: 'text', text: 'Result summary' }], structuredContent: data };
}

let initialized = false;
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (scenario === 'crash') {
    process.exit(1);
  }
  if (msg.method === 'initialize') return reply(msg.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-pixiv', version: '1' } });
  if (msg.method === 'notifications/initialized') { initialized = true; return; }
  if (!initialized) throw new Error('initialize is required');
  const name = msg.params?.name;
  const args = msg.params?.arguments || {};
  if (name === 'auth_status') {
    return reply(msg.id, toolResult({ authenticated: true, accounts: [{ userId: '1', name: 'MCP', isDefault: true }] }));
  }
  if (name === 'search_illust' || name === 'illust_ranking' || name === 'user_artworks' || name === 'user_bookmarks') {
    return reply(msg.id, toolResult({ records: works }));
  }
  if (name === 'illust_detail') {
    return reply(msg.id, toolResult({ records: [{ ...works[0], id: String(args.illust_id) }] }));
  }
  if (name === 'download') {
    const fs = require('fs');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'artflow-mcp-source-'));
    fs.mkdirSync(dir, { recursive: true });
    const files = [];
    for (const id of args.srcs || []) {
      const p = path.join(dir, `${id}_p0.png`);
      fs.writeFileSync(p, Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8ffff3f0005fe02feA5c1a4c80000000049454e44ae426082', 'hex'));
      files.push({ path: p, illust_id: Number(id), page: 0, mime_type: 'image/png', size_bytes: 1 });
    }
    return reply(msg.id, toolResult({ files, failures: [], warnings: [] }));
  }
  reply(msg.id, toolResult({}));
});
